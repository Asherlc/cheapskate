import type { PluginServerContext } from "@getpaseo/plugin/server";
import { archiveBackend, createProvider, ownerEnvKey } from "./server/provider";
import { parseChain, preferences, providerId } from "./shared/settings";
import type { PaseoApi } from "@getpaseo/client";
import { createCheckpoint } from "./server/checkpoint";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  let paseo: PaseoApi | undefined;
  const unhook = server.addHook("agent.open.before", async ({ request }, context) => {
    if (request.provider !== providerId) return;
    paseo = context.paseo;
    return { ...request, env: { ...request.env, [ownerEnvKey]: request.agentId } };
  });

  server.registerProvider(createProvider({
    async getRouting() {
      const state = await settings.read();
      if (state.status === "invalid") throw new Error(state.error);
      return { chain: parseChain(state.values.chain), overload: state.values.overload };
    },
    getPaseo() {
      if (!paseo) throw new Error("Cheapskate could not connect to its Paseo host.");
      return paseo;
    },
  }));

  const unhookArchive = server.addHook("agent.archive.after", async ({ agent }, context) => {
    if (agent.provider !== providerId) return;
    const checkpoint = createCheckpoint(agent.id);
    const state = await checkpoint.read();
    if (!state.worker) return;
    await archiveBackend(context.paseo, state.worker.id);
    await checkpoint.write({ items: state.items });
  });
  return () => {
    unhook();
    unhookArchive();
  };
}
