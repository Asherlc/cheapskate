import assert from "node:assert/strict";
import test from "node:test";
import { closestThinking, closestMode, fallbackOptions, routePermissions } from "../server/controls.ts";

const levels = (...ids: string[]) => ids.map((id) => ({ id, label: id }));
const openCode = (id: string) => ({ id, family: "opencode", modes: levels("build", "plan") });
const claude = { id: "claude", family: "claude", modes: levels("default", "plan", "auto", "bypassPermissions") };

test("thinking maps to the closest native level and keeps exact choices", () => {
  assert.equal(closestThinking("high", levels("low", "high", "max")), "high");
  assert.equal(closestThinking("max", levels("low", "high")), "high");
  assert.equal(closestThinking("medium", levels("low", "high")), "low");
  assert.equal(closestThinking("none", levels("low", "max")), "low");
  assert.equal(closestThinking("high", []), undefined);
  assert.equal(closestThinking("auto", levels("low", "high")), undefined);
});

test("permission modes stay exact within a provider and tighten across providers", () => {
  assert.equal(closestMode("build", openCode("opencode"), openCode("opencode")), "build");
  assert.equal(closestMode("plan", openCode("opencode"), claude), "plan");
  assert.equal(closestMode("default", claude, openCode("opencode")), "plan");
  assert.equal(closestMode("bypassPermissions", claude, openCode("opencode")), "build");
  assert.equal(closestMode("plan", claude, { id: "unknown", family: "unknown", modes: levels("plan") }), null);
  const codex = { id: "codex", family: "codex", modes: levels("auto", "full-access") };
  assert.equal(closestMode("plan", claude, codex), null);
  assert.equal(closestMode("auto", codex, openCode("opencode")), "plan");
  assert.equal(closestMode("auto", codex, { ...claude, modes: levels("default", "acceptEdits", "auto") }), null);
});

test("permission options are preserved only when there is a safe mapping", () => {
  const source = openCode("opencode");
  const destination = openCode("opencode-other");
  assert.deepEqual(fallbackOptions(source, destination, { auto_accept: false }), { auto_accept: false });
  assert.deepEqual(fallbackOptions(source, claude, { auto_accept: false }), {});
  assert.equal(fallbackOptions(source, claude, { permission: { bash: "deny" } }), null);
  assert.deepEqual(fallbackOptions(claude, destination, { fast: true }), { auto_accept: false, permission: "ask" });
  assert.deepEqual(fallbackOptions(claude, destination, {}, "plan"), { auto_accept: false, permission: "deny" });
});

test("routing rejects a fallback with compatible modes but incompatible permission options", () => {
  const source = openCode("opencode");
  assert.equal(routePermissions("plan", source, claude, { permission: { bash: "deny" } }), null);
  assert.deepEqual(routePermissions("plan", claude, source, {}), {
    mode: "plan", options: { auto_accept: false, permission: "deny" },
  });
});
