import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import {
  PROVIDER_PROTOCOL_VERSION,
  negotiateProviderCapabilities,
  type ProviderError,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPrompt,
  type ProviderRegistration,
  type ProviderSessionConfig,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { providerId } from "../shared/settings";
import { parseMessage, runBackend } from "./backend";
import { createCheckpoint, type Checkpoint } from "./checkpoint";
import { canFallback, handoffPrompt, type Routing } from "./routing";

export const ownerEnvKey = "CHEAPSKATE_OWNER_AGENT_ID";
const model = { id: "cheapskate", label: "Cheapskate", isDefault: true };
const models = [model];
const supported = ["prompt.message", "prompt.image", "permission", "permission.tool_policy", "session.persistence"];
const historyLimit = 300;

type Dependencies = {
  getRouting(): Promise<Routing>;
  getPaseo(): PaseoApi;
};

function toError(error: unknown): ProviderError {
  return { message: error instanceof Error ? error.message : String(error) };
}

export function createProvider(dependencies: Dependencies): ProviderRegistration {
  return {
    id: providerId,
    label: "Cheapskate",
    icon: "icon.svg",
    description: "Follow an ordered chain of models using your existing Paseo providers.",
    async connect(request) {
      if (!request.versions.includes(PROVIDER_PROTOCOL_VERSION)) throw new Error("Unsupported Paseo provider protocol.");
      const capabilities = negotiateProviderCapabilities(request.capabilities, supported);
      const sessions = new Map<string, Session>();
      const listeners = new Set<(event: ProviderEvent) => void>();
      const emit = (event: ProviderEvent) => listeners.forEach((listener) => listener(event));

      return {
        version: PROVIDER_PROTOCOL_VERSION,
        capabilities,
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async close() {
          await Promise.all([...sessions.values()].map((session) => session.interrupt()));
          sessions.clear();
          listeners.clear();
        },
        async send(input) {
          try {
            switch (input.type) {
              case "catalog":
                emit({ type: "catalog", requestId: input.requestId, catalog: { models, modes: [], defaultModel: model.id } });
                return;
              case "session.open": {
                const owner = input.config.env[ownerEnvKey];
                if (!owner) throw new Error("Paseo did not supply the owner of this Cheapskate session.");
                if (input.persistence && (input.persistence.version !== 1 || input.persistence.data !== owner)) {
                  throw new Error("Cheapskate session history belongs to another agent.");
                }
                const session = new Session(input.sessionId, owner, input.config, dependencies, emit);
                await session.restore();
                sessions.set(input.sessionId, session);
                emit({
                  type: "session.opened", requestId: input.requestId, sessionId: input.sessionId,
                  capabilities, cwd: input.config.cwd, restoration: "core",
                  persistence: input.config.persist ? { version: 1, data: owner } : undefined,
                });
                emit({
                  type: "session.config", sessionId: input.sessionId,
                  config: { model: model.id, models, modes: [], thinkingOptions: [] },
                });
                if (input.history === "replay") session.replay();
                emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
                return;
              }
              case "session.prompt":
                getSession(input).prompt(input.prompt);
                return;
              case "session.permission":
                await getSession(input).permission(input);
                return;
              case "session.interrupt":
                await getSession(input).interrupt();
                break;
              case "session.close":
                await getSession(input).interrupt();
                sessions.delete(input.sessionId);
                emit({ type: "session.closed", sessionId: input.sessionId });
                break;
              default:
                throw new Error("Cheapskate does not support this provider operation.");
            }
            emit({ type: "request.completed", requestId: input.requestId });
          } catch (error) {
            if (input.type === "session.prompt") {
              emit({
                type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId,
                result: { type: "failed", error: toError(error) },
              });
            } else if (input.type === "session.permission") {
              emit({
                type: "session.notice", sessionId: input.sessionId,
                notice: { id: "permission-error", severity: "error", title: toError(error).message },
              });
            } else {
              emit({ type: "request.failed", requestId: input.requestId, error: toError(error) });
            }
          }
        },
      };

      function getSession({ sessionId }: { sessionId: string }) {
        const session = sessions.get(sessionId);
        if (!session) throw new Error("Cheapskate session is closed.");
        return session;
      }
    },
  };
}

type Turn = { id: string; stop: AbortController; done: Promise<void>; attemptId?: string };

class Session {
  private checkpoint;
  private state: Checkpoint = { items: [] };
  private turn?: Turn;

  constructor(
    private id: string,
    private owner: string,
    private config: ProviderSessionConfig,
    private dependencies: Dependencies,
    private emit: (event: ProviderEvent) => void,
  ) {
    this.checkpoint = createCheckpoint(owner);
  }

  async restore() {
    this.state = await this.checkpoint.read();
  }

  replay() {
    for (const item of this.state.items) this.emit({ type: "timeline.item", sessionId: this.id, item });
  }

  private async save() {
    await this.checkpoint.write(this.state);
  }

  private record(item: ProviderTimelineItem) {
    const index = this.state.items.findIndex((previous) => previous.id === item.id);
    if (index < 0) this.state.items.push(item);
    else this.state.items[index] = item;
    if (this.state.items.length > historyLimit) this.state.items.shift();
    this.emit({ type: "timeline.item", sessionId: this.id, item });
  }

  prompt(prompt: ProviderPrompt) {
    if (this.turn) throw new Error("Cheapskate is still handling the previous turn.");
    if (prompt.input.type !== "message" || prompt.delivery === "steer") {
      throw new Error("Cheapskate supports regular messages.");
    }
    const message = parseMessage(prompt.input.content);
    const turnId = randomUUID();
    const stop = new AbortController();
    this.record({ type: "user_message", id: `user:${turnId}`, text: message.text, clientMessageId: prompt.clientMessageId });
    this.emit({
      type: "session.prompt_result", sessionId: this.id, clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId },
    });
    this.emit({ type: "session.turn", sessionId: this.id, turnId, state: "started" });

    const turn: Turn = { id: turnId, stop, done: Promise.resolve() };
    this.turn = turn;
    turn.done = this.run(turn, message).then(
      (state) => this.finish(turn, state),
      (error) => this.finish(turn, "failed", toError(error)),
    );
  }

  private async finish(turn: Turn, state: "completed" | "canceled" | "failed", error?: ProviderError) {
    if (error) this.record({ type: "error", id: `error:${turn.id}`, message: error.message });
    try {
      await this.save();
    } catch (saveError) {
      state = "failed";
      error = toError(saveError);
      this.record({ type: "error", id: `checkpoint:${turn.id}`, message: error.message });
    } finally {
      this.turn = undefined;
      this.emit({ type: "session.turn", sessionId: this.id, turnId: turn.id, state, error });
    }
  }

  async interrupt() {
    this.turn?.stop.abort();
    await this.turn?.done;
  }

  async permission(input: Extract<ProviderInput, { type: "session.permission" }>) {
    const turn = this.turn;
    const worker = this.state.worker;
    const prefix = `${turn?.id}:${turn?.attemptId}:`;
    if (!turn?.attemptId || turn.stop.signal.aborted || !worker || !input.permissionId.startsWith(prefix)) return;
    const agent = this.dependencies.getPaseo().agents.ref(worker.id);
    await agent.respondToPermission({ requestId: input.permissionId.slice(prefix.length), response: input.response });
  }

  private async archiveWorker(paseo: PaseoApi) {
    if (!this.state.worker) return;
    await archiveBackend(paseo, this.state.worker.id);
    this.state.worker = undefined;
    await this.save();
  }

  private async run(turn: Turn, message: ReturnType<typeof parseMessage>): Promise<"completed" | "canceled"> {
    const signal = turn.stop.signal;
    const { chain, overload } = await this.dependencies.getRouting();
    if (signal.aborted) return "canceled";
    if (!chain.length) throw new Error("Add a fallback chain in Settings → Plugins → Cheapskate.");

    const paseo = this.dependencies.getPaseo();
    const owner = await paseo.agents.ref(this.owner).refresh();
    if (!owner?.agent.workspaceId) throw new Error("Cheapskate needs an active Paseo workspace.");
    const workspace = paseo.workspaces.ref(owner.agent.workspaceId);
    if (this.state.worker?.inFlight || (this.state.worker && !chain.includes(this.state.worker.selection))) {
      await this.archiveWorker(paseo);
    }

    const first = this.state.worker ? chain.indexOf(this.state.worker.selection) : 0;
    for (const [index, selection] of chain.entries()) {
      if (index < first) continue;
      if (signal.aborted) return "canceled";

      const existing = this.state.worker;
      const worker = existing ?? { id: randomUUID(), selection, inFlight: false };
      const attemptId = randomUUID();
      turn.attemptId = attemptId;
      this.state.worker = worker;
      worker.inFlight = true;
      await this.save();

      let failure: ProviderError;
      try {
        const env = Object.fromEntries(Object.entries(this.config.env).filter(([key]) => ![
          ownerEnvKey, "PASEO_AGENT_ID", "PASEO_AGENT_CWD", "PASEO_WORKSPACE_ID", "PASEO_THREAD_STORAGE",
        ].includes(key)));
        const agent = existing ? paseo.agents.ref(worker.id) : await workspace.agents.create({
          agentId: worker.id,
          title: `Cheapskate · ${selection}`,
          background: true,
          env,
          labels: { "cheapskate.owner": this.owner },
          config: {
            provider: selection,
            systemPrompt: this.config.systemPrompt,
            mcpServers: { ...this.config.mcpServers },
            toolPolicy: this.config.toolPolicy,
          },
        });
        if (agent.id !== worker.id) throw new Error("Paseo did not honor the requested backend agent ID.");

        if (!existing && index === first) {
          this.record({ type: "notification", id: `route:${turn.id}:${attemptId}`, level: "info", message: `Cheapskate is using ${selection}.` });
        }
        const prompt = existing ? message : {
          ...message,
          text: handoffPrompt(this.state.items.filter((item) => item.id !== `user:${turn.id}`), message.text),
        };
        const outcome = await runBackend({
          agent, sessionId: this.id, turnId: turn.id, attemptId, message: prompt, signal,
          emit: (event) => event.type === "timeline.item" ? this.record(event.item) : this.emit(event),
        });
        if (outcome.state === "completed" && !signal.aborted) {
          worker.inFlight = false;
          return "completed";
        }
        failure = outcome.state === "failed" ? outcome.error : { message: "Backend canceled the turn.", code: "canceled" };
      } catch (error) {
        failure = toError(error);
      }

      await this.archiveWorker(paseo);
      if (signal.aborted || failure.code === "canceled") return "canceled";
      if (index === chain.length - 1 || !canFallback(failure, overload)) {
        throw new Error(`${selection}: ${failure.message}`);
      }
      this.record({
        type: "notification", id: `fallback:${turn.id}:${attemptId}`, level: "warning",
        message: `${selection} hit a provider limit. Trying ${chain[index + 1]}.`,
      });
    }
    throw new Error("Cheapskate has no configured backend left to try.");
  }
}

export async function archiveBackend(paseo: PaseoApi, id: string) {
  const agent = paseo.agents.ref(id);
  const existing = await agent.refresh();
  if (existing && !agent.archivedAt) await agent.archive();
}
