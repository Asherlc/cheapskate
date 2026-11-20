import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import type { AgentToolContext, PluginHookContext, PluginHookPayload, PluginHookResult, PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { appendFeedbackToDraft } from "../client/draft";
import { listStories, normalizeStorybookUrl, readFeedback, selectStory } from "./storybook";

const primary = { id: "button--primary", title: "UI/Button", name: "Primary", type: "story" };
const secondary = { ...primary, id: "button--secondary", name: "Secondary" };
const docs = { ...primary, id: "button--docs", name: "Docs", type: "docs" };
const index = JSON.stringify({ v: 5, entries: { docs, secondary, primary } });
const review = {
  id: "note-1",
  storyId: primary.id,
  note: "Increase the button padding.",
  status: "open",
  selector: "#primary",
  domContext: { target: { tagName: "button", text: "Save" } },
  replies: [{ id: "reply-1", author: "Sam", note: "Use 16px." }],
};

let base: string;
let holdFeedback: Promise<void> | undefined;
const fixture = createServer(async (request, response) => {
  const route = request.url;
  response.setHeader("Content-Type", "application/json");
  if (route === "/storybook/index.json") {
    response.end(index);
  } else if (route === "/__canvas-comments/comments") {
    await holdFeedback;
    response.end(JSON.stringify([
      review,
      { ...review, id: "resolved", status: "resolved" },
      { ...review, id: "other-story", storyId: secondary.id },
    ]));
  } else if (route === "/legacy/index.json") {
    response.end(JSON.stringify({ v: 3, stories: { primary: { ...primary, type: undefined } } }));
  } else if (route === "/bad-index/index.json") {
    response.end(JSON.stringify({ v: 5, entries: { primary: { id: primary.id } } }));
  } else if (route === "/bad-json/index.json") {
    response.end("{");
  } else if (route === "/dropped/index.json") {
    response.destroy();
  } else {
    response.statusCode = route === "/offline/index.json" ? 503 : 404;
    response.end("{}");
  }
});

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

before(async () => {
  base = await listen(fixture);
});
after(() => close(fixture));

test("normalizes Storybook URLs and preserves the base path for direct stories", async () => {
  assert.equal(normalizeStorybookUrl(" HTTPS://EXAMPLE.COM/base///?path=/story/old#anchor "), "https://example.com/base/");
  assert.throws(() => normalizeStorybookUrl("file:///tmp/storybook"), /HTTP or HTTPS/);
  assert.throws(() => normalizeStorybookUrl("storybook"), /HTTP or HTTPS/);
  const result = await listStories({ url: `${base}/storybook/index.html?path=/docs/button--docs`, query: "pRimARY" });
  assert.deepEqual(result, {
    url: `${base}/storybook/`,
    stories: [{ id: primary.id, title: primary.title, name: primary.name, storyUrl: `${base}/storybook/?path=/story/${primary.id}` }],
  });
  assert.equal(normalizeStorybookUrl(`${base}/storybook/iframe.html?id=${primary.id}`), `${base}/storybook/`);
  assert.deepEqual((await listStories({ url: `${base}/storybook` })).stories.map(({ id }) => id).sort(), [primary.id, secondary.id]);
  assert.equal((await listStories({ url: `${base}/legacy` })).stories[0]?.id, primary.id);
});

test("reports invalid indexes, invalid JSON, HTTP errors, and canceled requests", async () => {
  await assert.rejects(listStories({ url: `${base}/bad-index` }), /invalid Storybook index/i);
  await assert.rejects(listStories({ url: `${base}/bad-json` }), /index.*JSON/i);
  await assert.rejects(listStories({ url: `${base}/offline` }), /index.*HTTP 503/i);
  await assert.rejects(listStories({ url: `${base}/dropped` }), /could not reach.*index.*daemon/i);
  await assert.rejects(listStories({ url: `${base}/storybook` }, AbortSignal.abort()), /cancel/i);
});

test("validates story IDs before selection and filters feedback while preserving context", async () => {
  const owner = { workspaceId: "workspace-1", agentId: "owner-1" };
  const url = `${base}/storybook`;
  await assert.rejects(selectStory({ url, storyId: docs.id }, owner), /story.*not found/i);
  await assert.rejects(selectStory({ url, storyId: "missing" }, owner), /story.*not found/i);
  const target = await selectStory({ url, storyId: primary.id }, owner);
  assert.deepEqual(await readFeedback(target), { target, comments: [review] });
});

test("uses a separate browser address without fetching it from the daemon", async () => {
  const url = `${base}/storybook`;
  const browserUrl = "https://forward.invalid/review/index.html?path=/story/old";
  const storyUrl = `https://forward.invalid/review/?path=/story/${primary.id}`;
  const list = await listStories({ url, browserUrl, query: "primary" });
  assert.equal(list.stories[0]?.storyUrl, storyUrl);
  const target = await selectStory({ url, browserUrl, storyId: primary.id }, { workspaceId: "workspace-1", agentId: "owner-1" });
  assert.equal(target.url, `${url}/`);
  assert.equal(target.storyUrl, storyUrl);
  assert.deepEqual((await readFeedback(target)).comments, [review]);
  await assert.rejects(listStories({ url, browserUrl: "https://user:password@forward.invalid" }), /without embedded credentials/);
});

test("reports missing or invalid addon responses at the root of the selected origin", async (t) => {
  const responses = [
    { status: 404, contentType: "application/json", body: "{}", error: /Canvas Comments.*HTTP 404/i },
    { status: 200, contentType: "text/html", body: "<!doctype html><title>Storybook</title>", error: /Canvas Comments.*JSON/i },
    { status: 200, contentType: "application/json", body: '[{"id":"incomplete"}]', error: /invalid Canvas Comments/i },
  ];
  for (const { status, contentType, body, error } of responses) {
    const server = createServer((request, response) => {
      if (request.url === "/storybook/index.json") {
        response.writeHead(200, { "Content-Type": "application/json" }).end(index);
        return;
      }
      if (request.url !== "/__canvas-comments/comments") {
        response.writeHead(500).end();
        return;
      }
      response.writeHead(status, { "Content-Type": contentType }).end(body);
    });
    const origin = await listen(server);
    t.after(() => close(server));
    const target = await selectStory({ url: `${origin}/storybook`, storyId: primary.id }, { workspaceId: "workspace-1", agentId: "owner-1" });
    await assert.rejects(readFeedback(target), error);
  }
});

test("tools capture the owning agent, preserve existing tools, and pin an in-flight review", async () => {
  let open!: (payload: PluginHookPayload<"agent.open.before">, context: PluginHookContext) => Promise<PluginHookResult<"agent.open.before">>;
  const cleanup = contribute({
    addHook(name: string, handler: typeof open) {
      if (name === "agent.open.before") open = handler;
      return () => {};
    },
    handle() {},
  } as unknown as PluginServerContext);
  const existingTool = { name: "existing", description: "Existing tool", input: {} } as PluginSessionOpenRequest["tools"][number];
  const request: PluginSessionOpenRequest = {
    agentId: "helper", workspaceId: "workspace-1", cwd: "/", provider: "codex", title: null,
    reason: "create", purpose: "interactive", background: true, labels: { "cheapskate.owner": "owner-1" },
    metadata: {}, tools: [existingTool], env: {}, mcpServers: {},
  };
  const reviewEntries: { agentId: string; item: unknown }[] = [];
  const toolContext: AgentToolContext = {
    agent: {
      id: request.agentId, workspaceId: request.workspaceId, cwd: request.cwd, provider: request.provider,
      title: request.title, background: request.background, parentAgentId: null, metadata: {},
    },
    signal: new AbortController().signal,
    paseo: { agents: { ref: (agentId: string) => ({ timeline: {
      append: async (item: unknown) => { reviewEntries.push({ agentId, item }); },
    } }) } } as unknown as AgentToolContext["paseo"],
  };
  const openSession = (session: PluginSessionOpenRequest) => open({ request: session }, toolContext);
  assert.equal(await openSession({ ...request, purpose: "history" }), undefined);
  assert.equal(await openSession({ ...request, labels: {} }), undefined);
  const tools = (await openSession(request) as PluginSessionOpenRequest).tools;
  assert.equal(tools[0], existingTool);
  const select = tools.find(({ name }) => name === "storybook_select_story")!;
  const read = tools.find(({ name }) => name === "storybook_read_feedback")!;
  const url = `${base}/storybook`;
  await select.execute({ url, storyId: primary.id }, toolContext);
  await assert.rejects(async () => select.execute({ url, storyId: docs.id }, toolContext), /not found/i);
  assert.deepEqual(reviewEntries, [{
    agentId: "owner-1",
    item: { type: "plugin", id: "review-ready", kind: "review-ready", version: 1, data: { workspaceId: "workspace-1" } },
  }]);
  let resolve!: () => void;
  holdFeedback = new Promise<void>((release) => { resolve = release; });
  try {
    const pending = read.execute({}, toolContext);
    const otherTools = (await openSession({ ...request, background: false, agentId: "owner-2", labels: {} }) as PluginSessionOpenRequest).tools;
    await otherTools.find(({ name }) => name === select.name)!.execute({ url, storyId: secondary.id }, toolContext);
    resolve();
    const oldTarget = await selectStory({ url, storyId: primary.id }, { workspaceId: "workspace-1", agentId: "owner-1" });
    assert.deepEqual((await pending).structuredContent, { target: oldTarget, comments: [review] });
    const newTarget = await selectStory({ url, storyId: secondary.id }, { workspaceId: "workspace-1", agentId: "owner-2" });
    assert.deepEqual((await read.execute({}, toolContext)).structuredContent, {
      target: newTarget,
      comments: [{ ...review, id: "other-story", storyId: secondary.id }],
    });
  } finally {
    resolve();
    holdFeedback = undefined;
    await cleanup();
  }
});

test("draft handoff resolves the pinned conversation after feedback loads and preserves typing", async () => {
  const target = await selectStory({ url: `${base}/storybook`, storyId: primary.id }, { workspaceId: "workspace-1", agentId: "owner-1" });
  let draft = "Original draft";
  const pending = readFeedback(target);
  draft += " with new typing ";
  const feedback = await pending;
  assert.throws(() => appendFeedbackToDraft(feedback, () => []), /conversation.*unavailable/i);
  appendFeedbackToDraft(feedback, ({ agentId }) => {
    assert.equal(agentId, "owner-1");
    return [{ prompt: draft, setPrompt: (text) => { draft = text; } }];
  });
  assert(draft.startsWith("Original draft with new typing \n\n"));
  for (const expected of [target.storyUrl, review.note, review.selector, "domContext", "Use 16px."]) {
    assert(draft.includes(expected));
  }
});
