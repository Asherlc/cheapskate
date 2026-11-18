import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  PROVIDER_PROTOCOL_VERSION,
  negotiateProviderCapabilities,
  type ProviderCatalog,
  type ProviderConfigChanges,
  type ProviderError,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPrompt,
  type ProviderRegistration,
  type ProviderSessionConfig,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { providerId } from "../shared/settings";
import { parseMessage, runBackend, type PaseoApi } from "./backend";
import { createCheckpoint, type Checkpoint } from "./checkpoint";
import { closestMode, closestThinking, fallbackOptions, readControls, type BackendControls, type Options } from "./controls";
import { canFallback, handoffPrompt, type Routing } from "./routing";

export const ownerEnvKey = "CHEAPSKATE_OWNER_AGENT_ID";
const model = { id: "cheapskate", label: "Cheapskate", isDefault: true };
const defaultCatalog: ProviderCatalog = { models: [model], modes: [], defaultModel: model.id };

function catalog(backend?: BackendControls): ProviderCatalog {
  if (!backend) return defaultCatalog;
  return {
    models: [{ ...model, thinkingOptions: [...backend.thinking], defaultThinkingOptionId: backend.defaultThinking }],
    modes: backend.modes,
    thinkingOptions: backend.thinking,
    defaultModel: model.id,
    defaultMode: backend.defaultMode,
    defaultThinkingOption: backend.defaultThinking,
  };
}

type Selection = { mode?: string; thinking?: string; options: Options };

const supported = ["prompt.message", "prompt.image", "permission", "permission.tool_policy", "session.configure", "session.persistence"];
const historyLimit = 300;

type Dependencies = {
  getRouting(): Promise<Routing>;
  getPaseo(): PaseoApi | undefined;
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
    async getCatalogCacheKey(options) {
      const routing = await dependencies.getRouting().catch(() => undefined);
      return JSON.stringify({
        primary: routing?.chain[0], ready: Boolean(dependencies.getPaseo()),
        cwd: options.scope === "workspace" ? options.cwd : undefined,
      });
    },
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
              case "catalog": {
                const paseo = dependencies.getPaseo();
                const routing = await dependencies.getRouting().catch(() => undefined);
                const chain = routing?.chain ?? [];
                const primary = paseo && chain[0]
                  ? await readControls(paseo, chain[0], input.cwd).catch(() => undefined)
                  : undefined;
                emit({ type: "catalog", requestId: input.requestId, catalog: catalog(primary) });
                return;
              }
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
                session.publishConfig();
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
              case "session.configure":
                await getSession(input).configure(input.changes);
                break;
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
  private backend?: BackendControls;
  private selected: Selection;
  private configuring = false;

  constructor(
    private id: string,
    private owner: string,
    private config: ProviderSessionConfig,
    private dependencies: Dependencies,
    private emit: (event: ProviderEvent) => void,
  ) {
    this.checkpoint = createCheckpoint(owner);
    this.selected = {
      mode: config.mode,
      thinking: config.thinkingOption,
      options: { ...config.providerOptions } as Options,
    };
  }

  async restore() {
    this.state = await this.checkpoint.read();
    const paseo = this.dependencies.getPaseo();
    const routing = await this.dependencies.getRouting().catch(() => undefined);
    const selection = this.state.lastSelection ?? this.state.worker?.selection ?? routing?.chain[0];
    if (paseo && selection) {
      this.backend = await readControls(paseo, selection, this.config.cwd, this.selected.options).catch(() => undefined);
      if (this.backend) {
        const { modes, thinking } = this.backend;
        if (this.selected.mode === "default" && !modes.some(({ id }) => id === "default")) this.selected.mode = undefined;
        if (this.selected.thinking === "auto" && !thinking.some(({ id }) => id === "auto")) this.selected.thinking = undefined;
      }
    }
  }

  publishConfig() {
    const visible = catalog(this.backend);
    this.emit({
      type: "session.config", sessionId: this.id,
      config: {
        model: model.id, models: visible.models, modes: visible.modes, thinkingOptions: visible.thinkingOptions ?? [],
        mode: this.selected.mode ?? this.backend?.defaultMode,
        thinkingOption: this.selected.thinking ?? this.backend?.defaultThinking,
        controls: this.backend?.controls ?? [],
        providerOptions: { ...this.backend?.options, ...this.selected.options },
      },
    });
  }

  async configure(changes: ProviderConfigChanges) {
    if (this.turn || this.configuring) throw new Error("Wait for the active Cheapskate operation to finish.");
    if (changes.model && changes.model !== model.id) throw new Error("Cheapskate only exposes its own model.");
    const paseo = this.requirePaseo();
    const backend = this.backend;
    if (!backend) throw new Error("Configure an available backend first.");
    this.configuring = true;
    try {
      const mode = changes.mode === undefined ? this.selected.mode : changes.mode ?? backend.defaultMode;
      const thinking = changes.thinkingOption === undefined
        ? this.selected.thinking
        : changes.thinkingOption ?? backend.defaultThinking;
      if (changes.mode && !backend.modes.some(({ id }) => id === mode)) {
        throw new Error(`The current backend does not offer permission mode ${mode}.`);
      }
      if (changes.thinkingOption && !backend.thinking.some(({ id }) => id === thinking)) {
        throw new Error(`The current backend does not offer thinking level ${thinking}.`);
      }
      const options = { ...this.selected.options };
      for (const [key, value] of Object.entries(changes.providerOptions ?? changes.settings ?? {})) {
        if (value === null) delete options[key];
        else options[key] = value;
      }
      const next = await readControls(paseo, backend.selection, this.config.cwd, options);
      this.selected = { mode, thinking, options };
      this.backend = next;
      this.publishConfig();
    } finally {
      this.configuring = false;
    }
  }

  private requirePaseo() {
    const paseo = this.dependencies.getPaseo();
    if (!paseo) throw new Error("Cheapskate could not connect to its Paseo host.");
    return paseo;
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
    if (this.turn || this.configuring) throw new Error("Cheapskate is still handling the previous operation.");
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
    const agent = this.requirePaseo().agents.ref(worker.id);
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

    const paseo = this.requirePaseo();
    const owner = await paseo.agents.ref(this.owner).refresh();
    if (!owner?.agent.workspaceId) throw new Error("Cheapskate needs an active Paseo workspace.");
    const workspace = paseo.workspaces.ref(owner.agent.workspaceId);
    const oldWorker = this.state.worker;
    const initialSelection = oldWorker && chain.includes(oldWorker.selection) ? oldWorker.selection : chain[0];
    const first = chain.indexOf(initialSelection);
    const sourceSelection = this.state.lastSelection ?? oldWorker?.selection ?? initialSelection;
    const source = this.backend ?? await readControls(paseo, sourceSelection, this.config.cwd, this.selected.options);
    const intent = {
      mode: this.selected.mode ?? source.defaultMode,
      thinking: this.selected.thinking ?? source.defaultThinking,
      options: { ...source.options, ...this.selected.options },
    };
    if (oldWorker?.inFlight || (oldWorker && oldWorker.selection !== initialSelection)) {
      await this.archiveWorker(paseo);
    }

    let failure: ProviderError | undefined;
    for (const [index, selection] of chain.entries()) {
      if (index < first) continue;
      if (signal.aborted) return "canceled";

      let backend: BackendControls;
      try {
        backend = selection === source.selection ? source : await readControls(paseo, selection, this.config.cwd);
      } catch (error) {
        this.record({
          type: "notification", id: `backend-skip:${turn.id}:${index}`, level: "warning",
          message: `Skipped ${selection} because Paseo could not read its controls: ${toError(error).message}`,
        });
        continue;
      }
      const mode = selection === source.selection ? intent.mode : closestMode(intent.mode, source, backend);
      const options = selection === source.selection
        ? intent.options : fallbackOptions(source, backend, intent.options, mode ?? undefined);
      if (mode === null || options === null) {
        this.record({
          type: "notification", id: `permission-skip:${turn.id}:${index}`, level: "warning",
          message: `Skipped ${selection} because it cannot preserve this permission mode or policy.`,
        });
        continue;
      }
      const thinking = closestThinking(intent.thinking, backend.thinking) ?? backend.defaultThinking;
      const requested: Selection = {
        ...(mode ? { mode } : {}),
        ...(thinking ? { thinking } : {}),
        options,
      };
      if (this.state.worker && !isDeepStrictEqual(this.state.worker.config, requested)) {
        await this.archiveWorker(paseo);
      }
      if (signal.aborted) return "canceled";
      const existing = this.state.worker;
      const worker = existing ?? { id: randomUUID(), selection, inFlight: false, config: requested };
      const attemptId = randomUUID();
      turn.attemptId = attemptId;
      this.state.worker = worker;
      worker.inFlight = true;
      await this.save();

      try {
        // The daemon and its plugins supply the new backend's own identity and thread storage.
        const {
          [ownerEnvKey]: _owner,
          PASEO_AGENT_ID: _agent,
          PASEO_AGENT_CWD: _cwd,
          PASEO_WORKSPACE_ID: _workspace,
          PASEO_THREAD_STORAGE: _thread,
          BB_THREAD_STORAGE: _genuiThread,
          ...env
        } = this.config.env;
        const { paseo: _orchestration, ...mcpServers } = this.config.mcpServers;
        const agent = existing ? paseo.agents.ref(worker.id) : await workspace.agents.create({
          agentId: worker.id,
          title: `Cheapskate · ${selection}`,
          background: true,
          env,
          labels: { "cheapskate.owner": this.owner },
          config: {
            provider: selection,
            modeId: mode,
            thinkingOptionId: thinking,
            options,
            systemPrompt: this.config.systemPrompt,
            mcpServers,
            toolPolicy: this.config.toolPolicy,
          },
        });
        if (agent.id !== worker.id) throw new Error("Paseo did not honor the requested backend agent ID.");

        const actualMode = agent.runtimeInfo?.modeId ?? undefined;
        if (mode && actualMode && mode !== actualMode) {
          throw new Error(`The backend opened in mode ${actualMode} instead of ${mode}.`);
        }
        if (!mode && actualMode) {
          requested.mode = actualMode;
          if (selection === source.selection) intent.mode = actualMode;
        }
        this.backend = { ...backend, controls: agent.controls ?? backend.controls };
        this.state.lastSelection = selection;
        this.selected = requested;
        this.publishConfig();
        if (!existing) {
          const settings = [mode && `mode ${mode}`, thinking && `thinking ${thinking}`].filter(Boolean).join(", ");
          this.record({
            type: "notification", id: `route:${turn.id}:${attemptId}`, level: "info",
            message: `Cheapskate is using ${selection}${settings ? ` (${settings})` : ""}.`,
          });
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
          const updated = await agent.refresh().catch(() => null);
          if (updated) {
            const liveMode = agent.runtimeInfo?.modeId;
            const liveThinking = agent.runtimeInfo?.thinkingOptionId;
            if (liveMode) requested.mode = liveMode;
            if (liveThinking) requested.thinking = liveThinking;
            requested.options = { ...requested.options, ...agent.options as Options };
            this.backend = { ...backend, controls: agent.controls ?? backend.controls };
            this.selected = requested;
            this.publishConfig();
          }
          if (!signal.aborted) {
            worker.inFlight = false;
            return "completed";
          }
        }
        failure = outcome.state === "failed" ? outcome.error : { message: "Backend canceled the turn.", code: "canceled" };
      } catch (error) {
        failure = toError(error);
      }

      await this.archiveWorker(paseo);
      if (signal.aborted || failure.code === "canceled") return "canceled";
      if (!canFallback(failure, overload)) {
        throw new Error(`${selection}: ${failure.message}`);
      }
      if (index + 1 < chain.length) {
        this.record({
          type: "notification", id: `fallback:${turn.id}:${attemptId}`, level: "warning",
          message: `${selection} hit a provider limit. Looking for the next compatible backend.`,
        });
      }
    }
    throw new Error(failure
      ? `No compatible backend remains after the provider limit: ${failure.message}`
      : "No configured backend can preserve this permission mode or policy.");
  }
}

export async function archiveBackend(paseo: PaseoApi, id: string) {
  const agent = paseo.agents.ref(id);
  const existing = await agent.refresh();
  if (existing && !agent.archivedAt) await agent.archive();
}
