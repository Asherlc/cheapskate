export type Routing = { chain: string[]; overload: boolean };

export function canFallback(error: { message: string; code?: string }, overload: boolean) {
  const code = error.code?.toLowerCase().replaceAll("-", "_");
  if (code && ["429", "rate_limit", "rate_limited", "rate_limit_exceeded", "usage_limit_reached",
    "usage_limit_exceeded", "quota_exceeded", "insufficient_quota", "resource_exhausted"].includes(code)) {
    return true;
  }
  if (overload && code && ["529", "overloaded", "overloaded_error", "provider_overloaded"].includes(code)) {
    return true;
  }
  const message = error.message.trim();
  const rateLimit = /^rate[ _-]limit[.!]?$/i.test(message)
    || /\b(?:rate[ _-]limit(?:ed| exceeded| reached| hit)|too many requests)\b/i.test(message);
  const quota = /\b(?:insufficient[_ ]quota|(?:usage limit|quota) (?:exceeded|exhausted|reached))\b/i.test(message)
    || /\b(?:(?:exceeded|exhausted|reached) (?:your |the )?(?:usage limit|quota)|hit your (?:usage )?limit)\b/i.test(message);
  return rateLimit || quota || (overload && /\b(?:overloaded(?:_error)?|provider overload)\b/i.test(message));
}

function redactHistory(text: string) {
  return text
    .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{24,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, "[REDACTED]");
}

export function handoffPrompt(
  items: { type: string; text?: string; name?: string; status?: string }[],
  latest: string,
) {
  const excerpt = items
    .filter((item) => item.type === "user_message" || item.type === "assistant_message" || item.type === "tool_call")
    .slice(-16)
    .map((item) => item.type === "tool_call"
      ? `Tool activity: ${item.name} (${item.status})`
      : `${item.type === "user_message" ? "User" : "Assistant"}: ${redactHistory(item.text ?? "").slice(-1800)}`)
    .join("\n\n");
  if (!excerpt) return latest;
  return [
    "Continue the conversation in the same workspace. The excerpt below is historical context. Inspect the current workspace before editing and avoid repeating side effects from previous attempts.",
    "<recent_conversation>",
    excerpt.slice(-14000),
    "</recent_conversation>",
    "Latest user message:",
    latest,
  ].join("\n\n");
}
