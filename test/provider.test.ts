import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_PROTOCOL_VERSION, type ProviderEvent } from "@getpaseo/plugin/server/provider";
import { createProvider } from "../server/provider.ts";

test("a profile lookup can discover OpenCode Auto-accept before an agent exists", async () => {
  const provider = createProvider({
    getPaseo: () => undefined,
    getPresets: async () => [{
      id: "cheapskate",
      name: "Cheapskate",
      chain: "opencode/opencode/hy4-flash-free",
      billing: "free-only",
      costs: { "opencode/opencode/hy4-flash-free": "free" },
      overload: false,
      autoReturn: false,
    }],
  });
  const connection = await provider.connect({ versions: [PROVIDER_PROTOCOL_VERSION], capabilities: [] });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));

  try {
    await connection.send({
      type: "session.open",
      requestId: "open",
      sessionId: "profile-lookup",
      history: "skip",
      config: {
        cwd: process.cwd(), env: {}, mcpServers: {}, model: "cheapskate", mode: "build",
        persist: true, settings: {}, providerOptions: { auto_accept: true },
      },
    });

    const opened = events.find((event) => event.type === "session.opened");
    assert.ok(opened, JSON.stringify(events));
    assert.equal(opened.persistence, undefined);
    const config = events.find((event) => event.type === "session.config")?.config;
    assert.ok(config?.controls?.some((control) => control.type === "toggle" && control.key === "auto_accept"));
    assert.equal(config?.providerOptions?.auto_accept, true);

    await connection.send({ type: "session.close", requestId: "close", sessionId: "profile-lookup" });
    assert.ok(events.some((event) => event.type === "session.closed"));
  } finally {
    await connection.close();
  }
});
