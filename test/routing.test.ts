import assert from "node:assert/strict";
import test from "node:test";
import { canFallback, handoffPrompt } from "../server/routing.ts";

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
