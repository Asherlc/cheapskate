import assert from "node:assert/strict";
import test from "node:test";
import { canFallback, handoffPrompt, providerResetAt, startingBackend } from "../server/routing.ts";
import { billingDecision, findPreset, preferences, primarySelection } from "../shared/settings.ts";

test("quota and rate limits advance the chain", () => {
  assert.equal(canFallback({ message: "Provider error", code: "usage_limit_reached" }, false), true);
  assert.equal(canFallback({ message: "HTTP 429 Too Many Requests" }, false), true);
  assert.equal(canFallback({ message: "You’ve hit your limit · resets 3pm" }, false), true);
});

test("overload requires opt-in and ordinary errors stop the turn", () => {
  assert.equal(canFallback({ message: "Provider overloaded", code: "overloaded_error" }, false), false);
  assert.equal(canFallback({ message: "Provider overloaded", code: "overloaded_error" }, true), true);
  assert.equal(canFallback({ message: "Invalid model configuration", code: "invalid_request" }, true), false);
  assert.equal(canFallback({ message: "Canceled by user", code: "canceled" }, true), false);
});

test("legacy chains keep their routing settings, and named models use stable IDs", () => {
  const settings = preferences.schema.parse({ chain: "codex/example", overload: true });
  assert.equal(findPreset(settings)?.billing, "allow");
  assert.equal(findPreset(settings)?.chain, "codex/example");
  assert.equal(findPreset(settings, "chain-removed"), undefined);
  const named = preferences.schema.parse({ ...settings, presets: [{ id: "chain-free", name: "Free Only", chain: "opencode/example", billing: "free-only" }] });
  assert.equal(findPreset(named, "chain-free")?.chain, "opencode/example");
});

test("guarded chains treat unclassified billing as potentially paid", () => {
  assert.equal(billingDecision("allow", undefined), "run");
  assert.equal(billingDecision("ask", "free"), "run");
  assert.equal(billingDecision("ask", undefined), "ask");
  assert.equal(billingDecision("ask", "paid"), "ask");
  assert.equal(billingDecision("free-only", undefined), "skip");
  assert.equal(billingDecision("free-only", "paid"), "skip");
  assert.equal(billingDecision("free-only", "free"), "run");
  const settings = preferences.schema.parse({
    chain: "codex/paid\ncodex/unknown\nopencode/free",
    billing: "free-only",
    costs: { "codex/paid": "paid", "opencode/free": "free" },
  });
  assert.equal(primarySelection(settings), "opencode/free");
});

test("recovery uses explicit provider timing and otherwise keeps the active backend", () => {
  const now = Date.parse("2026-11-18T05:00:00Z");
  assert.equal(providerResetAt({ message: "Rate limit exceeded", diagnostic: "Retry-After: 45" }, now), now + 45000);
  assert.equal(providerResetAt({ message: "Quota exceeded. Reset at 2026-11-18T05:02:00Z" }, now), now + 120000);
  assert.equal(providerResetAt({ message: "You hit your limit. Resets 3pm" }, now), undefined);
  assert.equal(providerResetAt({ message: "Quota exceeded. Retry-After: 0" }, now), undefined);
  const chain = ["a", "b", "c"];
  const limits = { a: { resetAt: now + 1000, label: "A" }, b: { resetAt: now - 1000, label: "B" } };
  assert.equal(startingBackend(chain, "c", limits, false, false, now), "c");
  assert.equal(startingBackend(chain, "c", limits, true, false, now), "b");
  assert.equal(startingBackend(chain, "c", limits, true, false, now + 1001), "a");
  assert.equal(startingBackend(chain, "c", limits, false, true, now), "a");
});

test("handoff includes the latest request and bounded context, excluding reasoning and tool payloads", () => {
  const previous = [
    { type: "reasoning", text: "internal thinking" },
    { type: "user_message", text: "initial request" },
    { type: "assistant_message", text: "x".repeat(20_000) },
    { type: "tool_call", name: "Edit", status: "completed", text: "tool contents" },
  ];
  const prompt = handoffPrompt(previous, "latest user request");
  assert.match(prompt, /initial request/);
  assert.match(prompt, /Tool activity: Edit \(completed\)/);
  assert.match(prompt, /latest user request$/);
  assert.doesNotMatch(prompt, /internal thinking|tool contents/);
  assert.ok(prompt.length < 3000);
  assert.equal(handoffPrompt([], "plain prompt"), "plain prompt");
});

test("handoff redacts recognized credentials from historical text", () => {
  const token = "ghp_" + "s".repeat(36);
  const key = "sk-proj-" + "x".repeat(48);
  const prompt = handoffPrompt([
    { type: "user_message", text: "Old GitHub token " + token },
    { type: "assistant_message", text: "Old OpenAI key " + key },
  ], "Continue with the previous task.");
  assert.doesNotMatch(prompt, new RegExp(token + "|" + key));
  assert.match(prompt, /Old GitHub token \[REDACTED\]/);
  assert.match(prompt, /Old OpenAI key \[REDACTED\]/);
  assert.match(prompt, /Continue with the previous task\.$/);
});
