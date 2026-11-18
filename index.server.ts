import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { archiveBackend, createProvider, ownerEnvKey } from "./server/provider";
import { parseChain, preferences, providerId } from "./shared/settings";
import { prepareDraft } from "./shared/controls";
import { readControls } from "./server/controls";
import { createCheckpoint } from "./server/checkpoint";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  let paseo: PluginHandlerContext["paseo"] | undefined;
  const unhookCreate = server.addHook("agent.create.before", async ({ request }, context) => {
    if (request.config.provider === providerId) paseo = context.paseo;
  });
  const unhook = server.addHook("agent.open.before", async ({ request }, context) => {
    if (request.provider !== providerId) return;
    paseo = context.paseo;
    return { ...request, env: { ...request.env, [ownerEnvKey]: request.agentId } };
  });

  async function getRouting() {
    const state = await settings.read();
    if (state.status === "invalid") throw new Error(state.error);
    return { chain: parseChain(state.values.chain), overload: state.values.overload };
  }

  server.registerProvider(createProvider({ getRouting, getPaseo: () => paseo }));
  server.handle(prepareDraft, async (_input, context) => {
    paseo = context.paseo;
    const { chain } = await getRouting();
    if (!chain[0]) return { controls: [], options: {} };
    const native = await readControls(paseo, chain[0]);
    await paseo.providers.refresh({ providers: [providerId] });
    return {
      controls: native.controls.map((control) => control.type === "select"
        ? { ...control, choices: [...control.choices] } : control),
      options: native.options,
    };
  });

  const unhookArchive = server.addHook("agent.archive.after", async ({ agent }, context) => {
    if (agent.provider !== providerId) return;
    const checkpoint = createCheckpoint(agent.id);
    const state = await checkpoint.read();
    if (!state.worker) return;
    await archiveBackend(context.paseo, state.worker.id);
    await checkpoint.write({ ...state, worker: undefined });
  });
  return () => {
    unhookCreate();
    unhook();
    unhookArchive();
  };
}
