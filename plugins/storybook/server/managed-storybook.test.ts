import type {
  AgentToolContext, PluginHookContext, PluginHookPayload, PluginHookResult, PluginServerContext,
} from "@getpaseo/plugin/server";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import contribute from "../index.server";
import { serverStatusRpc, startServerInput, type ServerStatus } from "../shared/contracts";
import { createManagedStorybook, type ManagedStorybooks } from "./managed-storybook";
import { listStories } from "./storybook";

const serve = `
  require("node:http").createServer((request, response) => {
    response.end(JSON.stringify({ entries: {
      "button--primary": { type: "story", id: "button--primary", title: "Button", name: "Primary" }
    }}));
  }).listen(Number(process.argv[1]), "127.0.0.1");
`;
const wrapper = `
  const child = require("node:child_process").spawn(process.execPath, [
    "-e", process.argv[1], process.argv[2]
  ], { stdio: "inherit" });
  child.on("exit", code => process.exit(code ?? 1));
`;
const launch = { command: process.execPath, args: ["-e", wrapper, serve, "{port}"] };
const posixOnly = { skip: process.platform === "win32" };

async function waitFor(manager: Pick<ManagedStorybooks, "status">, workspaceId: string, state: ServerStatus["state"]) {
  const deadline = Date.now() + 5000;
  do {
    const current = manager.status(workspaceId);
    if (current.state === state) return current;
    if (current.state === "failed") assert.fail(current.error);
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(`Storybook did not enter ${state}: ${JSON.stringify(manager.status(workspaceId))}`);
}

test("starts one workspace-owned server and stops the full command tree", posixOnly, async (t) => {
  const manager = createManagedStorybook();
  t.after(() => manager.dispose());
  assert.equal(manager.start("one", process.cwd(), launch).state, "starting");
  assert.equal(manager.start("one", process.cwd(), launch).state, "starting");
  assert.throws(() => manager.start("one", process.cwd(), { ...launch, args: ["--port={port}"] }), /stop/i);
  manager.start("two", process.cwd(), launch);
  const first = await waitFor(manager, "one", "ready");
  const second = await waitFor(manager, "two", "ready");
  assert(first.url && second.url);
  assert.notEqual(first.url, second.url);
  assert.equal(manager.start("one", process.cwd(), launch).url, first.url);
  assert.equal((await listStories({ url: first.url })).stories[0].id, "button--primary");

  await manager.stop("one");
  assert.equal(manager.status("one").state, "idle");
  await assert.rejects(fetch(new URL("index.json", first.url)));
  assert.equal((await listStories({ url: second.url })).stories.length, 1);
  await manager.dispose();
  await assert.rejects(fetch(new URL("index.json", second.url)));
});

test("cancels a pending launch and allows retry after a failed process", posixOnly, async (t) => {
  const manager = createManagedStorybook();
  t.after(() => manager.dispose());
  manager.start("cancel", process.cwd(), launch);
  await manager.stop("cancel");
  assert.equal(manager.status("cancel").state, "idle");

  manager.start("retry", process.cwd(), { command: "paseo-missing-storybook-smoke-binary", args: ["{port}"] });
  const failure = await waitFor(manager, "retry", "failed");
  assert.match(failure.error ?? "", /ENOENT|paseo-missing-storybook/i);
  manager.start("retry", process.cwd(), launch);
  assert.equal((await waitFor(manager, "retry", "ready")).state, "ready");
  assert.equal(manager.status("cancel").state, "idle");
});

test("rejects a working directory outside the agent checkout", posixOnly, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-storybook-cwd-"));
  const manager = createManagedStorybook();
  t.after(async () => {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  assert.throws(() => manager.start("relative", cwd, { ...launch, cwd: ".." }), /working directory/i);
  await symlink(dirname(cwd), join(cwd, "outside"), "junction");
  manager.start("symlink", cwd, { ...launch, cwd: "outside" });
  assert.match((await waitFor(manager, "symlink", "failed")).error ?? "", /working directory/i);
});

test("agent launch is workspace-scoped and archiving stops it", posixOnly, async (t) => {
  let open!: (payload: PluginHookPayload<"agent.open.before">, context: PluginHookContext) => Promise<PluginHookResult<"agent.open.before">>;
  let archive!: (payload: PluginHookPayload<"workspace.archive.after">) => Promise<void>;
  let status!: (input: { workspaceId: string }) => ServerStatus;
  const cleanup = contribute({
    addHook(name: string, callback: typeof open | typeof archive) {
      if (name === "agent.open.before") open = callback as typeof open;
      if (name === "workspace.archive.after") archive = callback as typeof archive;
      return () => {};
    },
    handle(contract: { name: string }, callback: typeof status) {
      if (contract.name === serverStatusRpc.name) status = callback;
    },
  } as unknown as PluginServerContext);
  t.after(cleanup);
  const workspaceId = "review-workspace";
  const cwd = process.cwd();
  const signal = new AbortController().signal;
  const context = { agent: { workspaceId, cwd }, signal } as AgentToolContext;
  const session = {
    request: { purpose: "interactive", labels: {}, tools: [] },
  } as unknown as PluginHookPayload<"agent.open.before">;
  const request = await open(session, { signal } as PluginHookContext);
  const start = request?.tools.find(({ name }) => name === "storybook_start");
  assert(start);
  assert.equal(startServerInput.safeParse({ ...launch, args: ["{port}={port}"] }).success, false);
  await start.execute(startServerInput.parse(launch), context);
  const current = await waitFor({ status: (id) => status({ workspaceId: id }) }, workspaceId, "ready");
  assert(current.url);
  assert.equal(status({ workspaceId: "someone-else" }).state, "idle");
  await archive({ workspace: { id: workspaceId, cwd, projectId: "fixture", name: null, archivedAt: null, metadata: {} } });
  assert.equal(status({ workspaceId }).state, "idle");
  await assert.rejects(fetch(new URL("index.json", current.url)));
});
