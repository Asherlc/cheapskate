import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import type { Device } from "../shared/contracts";
import { splitDevices } from "../shared/select";
import { waitFor } from "./exec";

// state.ts picks its file from PASEO_HOME at import time: point it at a throwaway folder first
let state: typeof import("./state");
before(async () => {
  process.env.PASEO_HOME = mkdtempSync(path.join(os.tmpdir(), "devices-test-"));
  // paths.ts finds the installed plugin by its manifest in the daemon config
  writeFileSync(
    path.join(process.env.PASEO_HOME, "config.json"),
    JSON.stringify({ plugins: { devices: { path: path.join(import.meta.dirname, ".."), enabled: true } } }),
  );
  state = await import("./state");
  await state.loadState();
});

const A = { workspaceId: "a", workspaceName: "Checkout", directory: "/w/app" };
const B = { workspaceId: "b", workspaceName: "Onboarding", directory: "/w/app-worktrees/onboarding" };

test("Device tool paths follow the active checkout when a Git update replaces it", async () => {
  const { dependencyFile } = await import("./paths");
  const config = path.join(process.env.PASEO_HOME!, "config.json");
  const original = readFileSync(config);
  const next = mkdtempSync(path.join(os.tmpdir(), "devices-updated-"));
  try {
    writeFileSync(path.join(next, "paseo-plugin.json"), JSON.stringify({ id: "devices" }));
    symlinkSync(path.join(import.meta.dirname, "..", "node_modules"), path.join(next, "node_modules"), "dir");
    writeFileSync(config, JSON.stringify({ plugins: { devices: { path: next, enabled: true } } }));
    assert.equal(
      dependencyFile("agent-device", "bin/agent-device.mjs"),
      path.join(next, "node_modules", "agent-device", "bin", "agent-device.mjs"),
    );
  } finally {
    writeFileSync(config, original);
    rmSync(next, { recursive: true });
  }
});

test("a held device isn't silently taken by another workspace", async () => {
  await state.addAssignment(A, "ios:1", false);
  await assert.rejects(state.addAssignment(B, "ios:1", false), /In use by Checkout/);
  assert.equal(state.holderOf("ios:1")?.workspaceId, "a");
  assert.equal(await state.addAssignment(B, "ios:1", true), "Taken over from Checkout");
  assert.equal(state.holderOf("ios:1")?.workspaceId, "b");
  assert.equal(state.assignments().filter((x) => x.workspaceId === "a").length, 0);
});

test("a workspace holds several devices; agents drive one; release frees one", async () => {
  await state.addAssignment(A, "ios:2", false);
  await state.addAssignment(A, "android:emulator-5554", false);
  await state.addAssignment(A, "ios:3", false);
  const mine = () =>
    state
      .assignments()
      .filter((x) => x.workspaceId === "a")
      .map((x) => x.deviceId);
  assert.deepEqual(mine(), ["ios:2", "android:emulator-5554", "ios:3"]);
  // only devices allowed for agents; the first allowed until agents choose
  assert.equal(state.targetOf("a"), undefined);
  await state.allowAgentTools("ios:3", true);
  assert.equal(state.targetOf("a")?.deviceId, "ios:3");
  // allowing one added earlier doesn't move agents off the one they drive
  await state.allowAgentTools("android:emulator-5554", true);
  assert.equal(state.targetOf("a")?.deviceId, "ios:3");
  await state.setTarget("a", "android:emulator-5554");
  assert.equal(state.targetOf("a")?.deviceId, "android:emulator-5554");
  await state.setTarget("a", "ios:3");
  assert.equal(state.targetOf("a")?.deviceId, "ios:3");
  // only the workspace holding it can release it (a panel a poll behind can't take it from another)
  assert.equal(await state.removeAssignment("b", "ios:3"), false);
  assert.equal(await state.removeAssignment("a", "ios:3"), true);
  assert.deepEqual(mine(), ["ios:2", "android:emulator-5554"]);
  assert.equal(state.holderOf("ios:3"), undefined);
  assert.equal(state.targetOf("a")?.deviceId, "android:emulator-5554");
  // releasing forgets that agents chose it: back again, it doesn't take over from the current one
  await state.addAssignment(A, "ios:3", false);
  assert.equal(state.targetOf("a")?.deviceId, "android:emulator-5554");
  // so does withdrawing consent
  await state.setTarget("a", "ios:3");
  await state.allowAgentTools("ios:3", false);
  await state.allowAgentTools("ios:3", true);
  assert.equal(state.targetOf("a")?.deviceId, "android:emulator-5554");
  // a device the workspace no longer holds can't become its target
  await state.removeAssignment("a", "ios:3");
  await state.setTarget("a", "ios:3");
  await state.addAssignment(A, "ios:3", false);
  assert.equal(state.targetOf("a")?.deviceId, "android:emulator-5554");
  for (const id of mine()) await state.removeAssignment("a", id);
});

test("agents in a subfolder of a workspace find its device; the deepest workspace wins", async () => {
  await state.addAssignment({ workspaceId: "root", workspaceName: "Root", directory: "/w" }, "ios:4", false);
  assert.equal(state.assignmentFor("/w/app-worktrees/onboarding/src")?.workspaceId, "b");
  assert.equal(state.assignmentFor("/w/other")?.workspaceId, "root");
  assert.equal(state.assignmentFor("/wx"), undefined);
});

test("featured devices: on, held, owned, Android, and newest-iOS iPhones", () => {
  const d = (id: string, name: string, detail: string, extra: Partial<Device> = {}): Device => ({
    id,
    platform: id.startsWith("ios") ? "ios" : "android",
    name,
    detail,
    state: "shutdown",
    kind: "simulator",
    owned: false,
    agentTools: false,
    error: null,
    ...extra,
  });
  const devices = [
    d("ios:old", "iPhone 17", "iOS 26.4"),
    d("ios:new", "iPhone 17", "iOS 26.5"),
    d("ios:ipad", "iPad mini", "iOS 26.5"),
    d("ios:on", "iPad Air", "iOS 26.4", { state: "booted" }),
    d("ios:held", "iPhone Air", "iOS 26.4"),
    d("avd:pixel", "Pixel", "Android emulator", { kind: "avd" }),
  ];
  const { main, rest } = splitDevices(devices, new Set(["ios:held"]));
  assert.deepEqual(main.map((x) => x.id).sort(), ["avd:pixel", "ios:held", "ios:new", "ios:on"]);
  assert.deepEqual(rest.map((x) => x.id).sort(), ["ios:ipad", "ios:old"]);
});

test("typing: US keyboard usages, shift around capitals and symbols", async () => {
  const { keyEvents } = await import("../shared/keyboard");
  assert.deepEqual(keyEvents("a1"), [
    { type: "down", usage: 4 },
    { type: "up", usage: 4 },
    { type: "down", usage: 30 },
    { type: "up", usage: 30 },
  ]);
  assert.deepEqual(
    keyEvents("A?").map((e) => `${e.type}:${e.usage}`),
    ["down:225", "down:4", "up:4", "up:225", "down:225", "down:56", "up:56", "up:225"],
  );
  assert.equal(keyEvents("hi there\r\n").length, 18);
  assert.throws(() => keyEvents("é"), /can't type "é"/);
});

test("agent tools are off until allowed per device, and forgotten with a deleted copy", async () => {
  assert.equal(state.agentToolsAllowed("ios:5"), false);
  await state.allowAgentTools("ios:5", true);
  assert.equal(state.agentToolsAllowed("ios:5"), true);
  await state.allowAgentTools("ios:5", false);
  assert.equal(state.agentToolsAllowed("ios:5"), false);
  await state.setOwned("android:emulator-5556", true);
  await state.allowAgentTools("android:emulator-5556", true);
  await state.setOwned("android:emulator-5556", false);
  assert.equal(state.agentToolsAllowed("android:emulator-5556"), false);
});

test("every RPC contract is valid (defineRpc throws on load otherwise)", async () => {
  await assert.doesNotReject(import("../shared/contracts"));
});

test("normalized marks become pixels clipped to the picture, numbered in order", async () => {
  const { placed, region } = await import("../shared/annotation");
  assert.deepEqual(region({ kind: "point", x: 0.5, y: 0.25, text: "" }, 1000, 500), {
    x: 487,
    y: 112,
    w: 26,
    h: 26,
  });
  assert.deepEqual(region({ kind: "box", x: 0.8, y: 0.9, w: 0.4, h: 0.3, text: "" }, 100, 100), {
    x: 80,
    y: 90,
    w: 20,
    h: 10,
  });
  assert.deepEqual(
    placed(
      [
        { kind: "point", x: 1, y: 0, text: "" },
        { kind: "box", x: 0, y: 0, w: 2, h: 2, text: "" },
      ],
      100,
      100,
    ).map((mark) => [mark.n, mark.kind, mark.region.w, mark.region.h]),
    [
      [1, "point", 6, 6],
      [2, "box", 100, 100],
    ],
  );
  // a mark starting past the edge begins on the last drawable pixel and stays inside the frame
  assert.deepEqual(region({ kind: "box", x: 1, y: 1, w: 0.5, h: 0.5, text: "" }, 100, 100), {
    x: 99,
    y: 99,
    w: 1,
    h: 1,
  });
});

test("a saved annotation lands in the plugin data area under an unguessable name", async () => {
  const { annotationFile, newAnnotationName } = await import("./annotations");
  const name = newAnnotationName();
  assert.match(name, /^annotation-[0-9a-f-]{36}\.jpg$/);
  assert.notEqual(name, newAnnotationName());
  assert.equal(path.dirname(annotationFile(name)), path.join(state.STATE_DIR, "annotations"));
  assert.equal(path.basename(annotationFile(name)), name);
});

test("the draft carries the path and readable numbered notes, not drawing text", async () => {
  const { annotationText } = await import("../shared/annotation");
  assert.equal(annotationText("/a b.jpg", []), "Annotated screenshot: /a b.jpg");
  assert.equal(
    annotationText("/tmp/x.jpg", [
      { kind: "point", x: 0.33333, y: 0.5, text: "hello" },
      { kind: "box", x: 0, y: 0, w: 0.5, h: 1, text: "" },
    ]),
    "Annotated screenshot: /tmp/x.jpg\n\n1. point at (0.333, 0.5) — hello\n2. box from (0, 0) to (0.5, 1)",
  );
});

test("the picker answers an agent's MCP messages over stdio, in its own workspace", async () => {
  const { spawn } = await import("node:child_process");
  const { servePicker } = await import("./picker");
  const socket = path.join(mkdtempSync(path.join(os.tmpdir(), "picker-")), "picker.sock");
  const used: string[] = [];
  const stop = servePicker(socket, {
    list: async (w) => `devices for ${w.workspaceName}`,
    use: async (w, id) => {
      if (id === "ios:held") throw new Error("In use by Checkout");
      used.push(`${w.workspaceId}:${id}`);
      return "ok";
    },
    listPreviews: async () => "no previews",
    openPreview: async () => "no preview",
  });
  const bridge = spawn(process.execPath, [path.join(import.meta.dirname, "picker-bridge.mjs")], {
    env: { PASEO_DEVICES_SOCKET: socket, PASEO_DEVICES_WORKSPACE: JSON.stringify(B) },
  });
  const call = (id: number, name: string, args = {}) =>
    JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  bridge.stdin.end(
    [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      call(3, "list_devices"),
      call(4, "use_device", { deviceId: "ios:held" }),
      call(5, "use_device", { deviceId: "ios:1" }),
    ].join("\n") + "\n",
  );
  let out = "";
  for await (const chunk of bridge.stdout) out += chunk;
  stop();
  const answers = out
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  // the notification gets no answer
  assert.deepEqual(
    answers.map((a) => a.id),
    [1, 2, 3, 4, 5],
  );
  assert.equal(answers[0].result.capabilities.tools !== undefined, true);
  assert.deepEqual(
    answers[1].result.tools.map((t: { name: string }) => t.name),
    ["list_devices", "use_device", "list_previews", "open_preview"],
  );
  assert.equal(answers[2].result.content[0].text, "devices for Onboarding");
  assert.deepEqual(
    [answers[3].result.isError, answers[3].result.content[0].text],
    [true, "In use by Checkout"],
  );
  assert.deepEqual(used, ["b:ios:1"]);
});

test("two agents claim a device; legacy calls, wrong workspace and consent guards leave the owner", async () => {
  await state.addAssignment(A, "ios:owner", false);
  await state.addAssignment(A, "ios:other", false);
  await state.allowAgentTools("ios:owner", true);
  const owner = () => state.assignments().find((a) => a.deviceId === "ios:owner")?.agentId;

  // an anonymous legacy use_device drives the device but claims no chat
  await state.setTarget("a", "ios:owner");
  assert.equal(owner(), undefined);

  // the latest explicit claim on this exact assignment wins
  await state.setTarget("a", "ios:owner", "agent-1");
  assert.equal(owner(), "agent-1");
  await state.setTarget("a", "ios:owner", "agent-2");
  assert.equal(owner(), "agent-2");
  // a claim on another device doesn't move this one's owner
  await state.setTarget("a", "ios:other", "agent-3");
  assert.equal(owner(), "agent-2");
  // a legacy call doesn't erase the owner either
  await state.setTarget("a", "ios:owner");
  assert.equal(owner(), "agent-2");

  // the workspace and permission guards apply to claims too
  await state.setTarget("b", "ios:owner", "agent-4");
  assert.equal(owner(), "agent-2");
  await state.allowAgentTools("ios:owner", false);
  await state.setTarget("a", "ios:owner", "agent-5");
  assert.equal(owner(), "agent-2");
  await state.allowAgentTools("ios:owner", true);

  // releasing clears the owner with its assignment; adding it back starts unclaimed
  assert.equal(await state.removeAssignment("a", "ios:owner"), true);
  assert.equal(state.holderOf("ios:owner"), undefined);
  await state.addAssignment(A, "ios:owner", false);
  assert.equal(owner(), undefined);

  // so does a takeover: the new workspace's assignment has no owner
  await state.setTarget("a", "ios:owner", "agent-6");
  assert.equal(owner(), "agent-6");
  assert.equal(await state.addAssignment(B, "ios:owner", true), "Taken over from Checkout");
  assert.equal(owner(), undefined);

  await state.removeAssignment("b", "ios:owner");
  await state.removeAssignment("a", "ios:other");
});

test("the stdio bridge passes its agent identity to use_device, or nothing for a legacy bridge", async () => {
  const { spawn } = await import("node:child_process");
  const { servePicker } = await import("./picker");
  const socket = path.join(mkdtempSync(path.join(os.tmpdir(), "picker-agent-")), "picker.sock");
  const claims: string[] = [];
  const stop = servePicker(socket, {
    list: async () => "ok",
    use: async (w, id, agentId) => {
      claims.push(`${w.workspaceId}:${id}:${agentId ?? "-"}`);
      return "ok";
    },
    listPreviews: async () => "ok",
    openPreview: async () => "ok",
  });
  const run = (env: Record<string, string>) =>
    new Promise<void>((resolve, reject) => {
      const bridge = spawn(process.execPath, [path.join(import.meta.dirname, "picker-bridge.mjs")], {
        env: { PASEO_DEVICES_SOCKET: socket, PASEO_DEVICES_WORKSPACE: JSON.stringify(B), ...env },
      });
      bridge.stdin.end(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "use_device", arguments: { deviceId: "ios:1" } },
        })}\n`,
      );
      let out = "";
      bridge.stdout.on("data", (chunk) => (out += chunk));
      bridge.on("error", reject);
      bridge.on("close", () => {
        assert.deepEqual(JSON.parse(out.trim()), {
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "ok" }] },
        });
        resolve();
      });
    });
  await run({ PASEO_DEVICES_AGENT: "agent-9" });
  await run({});
  stop();
  assert.deepEqual(claims, ["b:ios:1:agent-9", "b:ios:1:-"]);
});

test("the stdio bridge passes its agent identity to open_preview, or nothing for a legacy bridge", async () => {
  const { spawn } = await import("node:child_process");
  const { servePicker } = await import("./picker");
  const socket = path.join(mkdtempSync(path.join(os.tmpdir(), "picker-open-agent-")), "picker.sock");
  const claims: string[] = [];
  const stop = servePicker(socket, {
    list: async () => "ok",
    use: async () => "ok",
    listPreviews: async () => "ok",
    openPreview: async (w, id, d, agentId) => {
      claims.push(`${w.workspaceId}:${id}:${d ?? "-"}:${agentId ?? "-"}`);
      return "ok";
    },
  });
  const run = (env: Record<string, string>) =>
    new Promise<void>((resolve, reject) => {
      const bridge = spawn(process.execPath, [path.join(import.meta.dirname, "picker-bridge.mjs")], {
        env: { PASEO_DEVICES_SOCKET: socket, PASEO_DEVICES_WORKSPACE: JSON.stringify(B), ...env },
      });
      bridge.stdin.end(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "open_preview", arguments: { previewId: "home/empty", deviceId: "ios:1" } },
        })}\n`,
      );
      let out = "";
      bridge.stdout.on("data", (chunk) => (out += chunk));
      bridge.on("error", reject);
      bridge.on("close", () => {
        assert.deepEqual(JSON.parse(out.trim()), {
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "ok" }] },
        });
        resolve();
      });
    });
  await run({ PASEO_DEVICES_AGENT: "agent-preview" });
  await run({});
  stop();
  assert.deepEqual(claims, ["b:home/empty:ios:1:agent-preview", "b:home/empty:ios:1:-"]);
});

const previewFixture = () => ({
  project: "App.xcodeproj",
  scheme: "Previews",
  bundleId: "com.example.previews",
  previews: [{ id: "home/empty", title: "Home empty" }],
});

test("preview catalog: absent file is empty, bad data is clear, project stays inside the workspace", async () => {
  const { readCatalog } = await import("./previews");
  const dir = mkdtempSync(path.join(os.tmpdir(), "previews-catalog-"));
  const file = path.join(dir, "paseo-previews.json");
  assert.equal(await readCatalog(dir), null);
  writeFileSync(file, "{not json");
  await assert.rejects(readCatalog(dir), /isn't valid JSON/);
  const valid = previewFixture();
  writeFileSync(file, JSON.stringify(valid));
  assert.deepEqual((await readCatalog(dir))?.previews, valid.previews);
  writeFileSync(file, JSON.stringify({ ...valid, previews: [valid.previews[0], valid.previews[0]] }));
  await assert.rejects(readCatalog(dir), /unique/i);
  writeFileSync(file, JSON.stringify({ ...valid, previews: [{ id: "../escape", title: "bad" }] }));
  await assert.rejects(readCatalog(dir), /invalid preview id/i);
  writeFileSync(file, JSON.stringify({ ...valid, project: "/tmp/App.xcodeproj" }));
  await assert.rejects(readCatalog(dir), /relative/i);
  writeFileSync(file, JSON.stringify({ ...valid, project: "notes.txt" }));
  await assert.rejects(readCatalog(dir), /xcodeproj|xcodeworkspace/i);
  const outside = mkdtempSync(path.join(os.tmpdir(), "previews-outside-"));
  symlinkSync(outside, path.join(dir, "link"));
  writeFileSync(file, JSON.stringify({ ...valid, project: "link/App.xcodeproj" }));
  await assert.rejects(readCatalog(dir), /outside the workspace/i);
});

test("preview build settings: finds the preview app by bundle id in Xcode's nested target shape", async () => {
  const { previewProduct } = await import("./previews");
  // the real `-showBuildSettings -json` output is an array of targets with settings nested below
  const settings = JSON.stringify([
    {
      action: "build",
      target: "GratefulElk",
      buildSettings: {
        PRODUCT_BUNDLE_IDENTIFIER: "com.paseo.gratefulelk",
        TARGET_BUILD_DIR: "/build/Debug-iphonesimulator",
        FULL_PRODUCT_NAME: "GratefulElk.app",
      },
    },
    {
      action: "build",
      target: "HangTenPreview",
      buildSettings: {
        PRODUCT_BUNDLE_IDENTIFIER: "com.paseo.preview.gratefulelk",
        TARGET_BUILD_DIR: "/build/preview/Debug-iphonesimulator",
        FULL_PRODUCT_NAME: "HangTenPreview.app",
      },
    },
  ]);
  assert.deepEqual(previewProduct(settings, "com.paseo.preview.gratefulelk"), {
    appPath: path.join("/build/preview/Debug-iphonesimulator", "HangTenPreview.app"),
  });
  assert.throws(() => previewProduct(settings, "com.missing"), /No build product has the bundle id/);
  assert.throws(() => previewProduct("{}", "com.paseo.preview.gratefulelk"), /Unexpected build settings/);
  assert.throws(() => previewProduct("{", "com.paseo.preview.gratefulelk"), /as JSON/);
  // the right bundle id but a missing product path is still a hard error
  assert.throws(
    () =>
      previewProduct(
        JSON.stringify([{ buildSettings: { PRODUCT_BUNDLE_IDENTIFIER: "com.paseo.preview.gratefulelk" } }]),
        "com.paseo.preview.gratefulelk",
      ),
    /didn't report the preview app's build product/,
  );
});

test("preview launch: one build per workspace, shared statuses, consent rechecked after build", async () => {
  const { previewCatalog } = await import("../shared/previews");
  const { Previews } = await import("./previews");
  const catalog = previewCatalog.parse(previewFixture());
  const plan = { udid: "UDID", bundleId: catalog.bundleId, previewId: "home/empty", appPath: "/tmp/App.app" };
  const request = {
    directory: "/w/app",
    workspaceId: "a",
    deviceId: "ios:preview",
    previewId: "home/empty",
    agentRequest: true,
  };
  const tick = async () => {
    for (let i = 0; i < 25; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  await state.addAssignment(A, "ios:preview", false);
  await state.allowAgentTools("ios:preview", true);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let installs = 0;
  let launches = 0;
  const tracker = new Previews(
    async () => {
      await gate;
      return plan;
    },
    async () => {
      installs++;
    },
    async () => {
      launches++;
    },
  );
  assert.deepEqual(tracker.statusOf("a", "ios:preview"), { state: "idle" });
  const building = await tracker.launch(request, catalog);
  assert.equal(building.state, "building");
  assert.deepEqual(tracker.statusOf("a", "ios:preview"), building);
  await assert.rejects(tracker.launch(request, catalog), /already building/i);
  release();
  await tick();
  assert.deepEqual(tracker.statusOf("a", "ios:preview"), {
    state: "opened",
    previewId: "home/empty",
    deviceId: "ios:preview",
  });
  assert.equal(installs, 1);
  assert.equal(launches, 1);

  const failed = new Previews(
    async () => {
      throw new Error("xcodebuild failed");
    },
    async () => {
      installs++;
    },
    async () => {
      launches++;
    },
  );
  await failed.launch(request, catalog);
  await tick();
  const failedStatus = failed.statusOf("a", "ios:preview");
  assert.equal(failedStatus.state, "error");
  assert.match(failedStatus.state === "error" ? failedStatus.error : "", /xcodebuild failed/);

  // consent withdrawn after the build blocks install; the failed state is visible to UI and agent
  await state.allowAgentTools("ios:preview", false);
  const revoked = new Previews(
    async () => plan,
    async () => {
      installs++;
    },
    async () => {
      launches++;
    },
  );
  await revoked.launch(request, catalog);
  await tick();
  assert.equal(installs, 1);
  assert.equal(launches, 1);
  const revokedStatus = revoked.statusOf("a", "ios:preview");
  assert.equal(revokedStatus.state, "error");
  assert.match(revokedStatus.state === "error" ? revokedStatus.error : "", /no longer allowed/);
  await state.removeAssignment("a", "ios:preview");
});

test("a preview build that outlives a takeover cannot write into the new holder's status", async () => {
  const { previewCatalog } = await import("../shared/previews");
  const { Previews } = await import("./previews");
  const catalog = previewCatalog.parse({
    ...previewFixture(),
    previews: [
      { id: "a/state", title: "A state" },
      { id: "b/state", title: "B state" },
    ],
  });
  const tick = async () => {
    for (let i = 0; i < 25; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  await state.addAssignment(A, "ios:swap", false);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tracker = new Previews(
    async (usedCatalog, request) => {
      if (request.workspaceId === "a") await gate;
      return {
        udid: "UDID",
        bundleId: usedCatalog.bundleId,
        previewId: request.previewId,
        appPath: "/tmp/App.app",
      };
    },
    async () => {},
    async () => {},
  );
  const requestA = {
    directory: A.directory,
    workspaceId: "a",
    deviceId: "ios:swap",
    previewId: "a/state",
    agentRequest: false,
  };
  assert.equal((await tracker.launch(requestA, catalog)).state, "building");

  // A loses the simulator to B while its build is still in flight
  await state.removeAssignment("a", "ios:swap");
  await state.addAssignment(B, "ios:swap", false);
  assert.deepEqual(tracker.statusOf("b", "ios:swap"), { state: "idle" });

  const requestB = { ...requestA, directory: B.directory, workspaceId: "b", previewId: "b/state" };
  assert.equal((await tracker.launch(requestB, catalog)).state, "building");
  await tick();
  const opened = { state: "opened", previewId: "b/state", deviceId: "ios:swap" };
  assert.deepEqual(tracker.statusOf("b", "ios:swap"), opened);

  // A's build finishes later: its error belongs to A alone and must not overwrite B's opened status
  release();
  await tick();
  const stale = tracker.statusOf("a", "ios:swap");
  assert.equal(stale.state, "error");
  assert.equal(stale.state === "error" ? stale.previewId : "", "a/state");
  assert.match(stale.state === "error" ? stale.error : "", /isn't assigned/);
  assert.deepEqual(tracker.statusOf("b", "ios:swap"), opened);

  await state.removeAssignment("b", "ios:swap");
});

test("preview launch rechecks workspace and consent between install and launch", async () => {
  const { previewCatalog } = await import("../shared/previews");
  const { Previews } = await import("./previews");
  const catalog = previewCatalog.parse(previewFixture());
  const plan = { udid: "UDID", bundleId: catalog.bundleId, previewId: "home/empty", appPath: "/tmp/App.app" };
  const request = {
    directory: "/w/app",
    workspaceId: "a",
    deviceId: "ios:between",
    previewId: "home/empty",
    agentRequest: true,
  };
  await state.addAssignment(A, "ios:between", false);
  await state.allowAgentTools("ios:between", true);
  let launches = 0;
  const tracker = new Previews(
    async () => plan,
    async () => {
      // consent is revoked while the app is being installed, so the guard before launch must fire
      await state.allowAgentTools("ios:between", false);
    },
    async () => {
      launches++;
    },
  );
  await tracker.launch(request, catalog);
  await waitFor(
    () => Promise.resolve(tracker.statusOf("a", "ios:between").state !== "building"),
    5_000,
    "preview build to settle",
  );
  assert.equal(launches, 0);
  const status = tracker.statusOf("a", "ios:between");
  assert.equal(status.state, "error");
  assert.match(status.state === "error" ? status.error : "", /no longer allowed/);
  await state.removeAssignment("a", "ios:between");
});

test("preview launch guards: unknown id and another workspace's simulator", async () => {
  const { previewCatalog } = await import("../shared/previews");
  const { assertKnownPreview, assertWorkspaceDevice } = await import("./previews");
  const catalog = previewCatalog.parse(previewFixture());
  assert.doesNotThrow(() => assertKnownPreview(catalog, "home/empty"));
  assert.throws(() => assertKnownPreview(catalog, "missing"), /Unknown preview/);
  assert.throws(() => assertKnownPreview(null, "home/empty"), /paseo-previews.json/);
  await state.addAssignment(A, "ios:guard", false);
  assert.equal(assertWorkspaceDevice("a", "ios:guard").directory, "/w/app");
  assert.throws(() => assertWorkspaceDevice("b", "ios:guard"), /isn't assigned/);
  assert.throws(() => assertWorkspaceDevice("a", "android:guard"), /iOS simulators/);
  await state.removeAssignment("a", "ios:guard");
});

test("preview status is limited to this workspace's assigned, permitted simulator", async () => {
  const { previewStatusDevice } = await import("./previews");
  await state.addAssignment(A, "ios:status-a", false);
  await state.addAssignment(B, "ios:status-b", false);
  await state.allowAgentTools("ios:status-a", true);
  await state.allowAgentTools("ios:status-b", true);
  // with no override, status follows this workspace's current target
  assert.equal(previewStatusDevice("a"), "ios:status-a");
  // an explicit device of this workspace's is accepted
  assert.equal(previewStatusDevice("a", "ios:status-a"), "ios:status-a");
  // another workspace's simulator can't be named to expose its status
  assert.throws(() => previewStatusDevice("a", "ios:status-b"), /isn't assigned/);
  assert.throws(() => previewStatusDevice("a", "android:status"), /iOS simulators/);
  // a simulator agents may not drive can't be named either
  await state.allowAgentTools("ios:status-a", false);
  assert.throws(() => previewStatusDevice("a", "ios:status-a"), /not allowed/);
  await state.allowAgentTools("ios:status-a", true);
  await state.removeAssignment("a", "ios:status-a");
  await state.removeAssignment("b", "ios:status-b");
});

test("claiming a started preview drives its simulator and routes annotations to the agent's chat", async () => {
  const { claimPreviewTarget } = await import("./agents");
  await state.addAssignment(A, "ios:claim", false);
  await state.allowAgentTools("ios:claim", true);
  await claimPreviewTarget("a", "ios:claim", "agent-chat");
  assert.equal(state.assignments().find((x) => x.deviceId === "ios:claim")?.agentId, "agent-chat");
  assert.equal(state.targetOf("a")?.deviceId, "ios:claim");
  // configs were synced, so the device tools drive this simulator
  const written = JSON.parse(readFileSync(path.join(state.STATE_DIR, "agent-device", "a.json"), "utf8"));
  assert.deepEqual([written.platform, written.udid], ["ios", "claim"]);
  // a legacy anonymous launch still drives it but leaves the chat owner alone
  await claimPreviewTarget("a", "ios:claim");
  assert.equal(state.assignments().find((x) => x.deviceId === "ios:claim")?.agentId, "agent-chat");
  await state.removeAssignment("a", "ios:claim");
});

test("the picker offers list_previews and open_preview and routes them to shared logic", async () => {
  const { spawn } = await import("node:child_process");
  const { servePicker } = await import("./picker");
  const socket = path.join(mkdtempSync(path.join(os.tmpdir(), "picker-previews-")), "picker.sock");
  const calls: string[] = [];
  const stop = servePicker(socket, {
    list: async () => "ok",
    use: async () => "ok",
    listPreviews: async (w, d) => {
      calls.push(`list:${w.workspaceId}:${d ?? "-"}`);
      return `previews for ${w.workspaceName}`;
    },
    openPreview: async (w, id, d) => {
      calls.push(`open:${w.workspaceId}:${id}:${d ?? "-"}`);
      return `building ${id}`;
    },
  });
  const bridge = spawn(process.execPath, [path.join(import.meta.dirname, "picker-bridge.mjs")], {
    env: { PASEO_DEVICES_SOCKET: socket, PASEO_DEVICES_WORKSPACE: JSON.stringify(B) },
  });
  const call = (id: number, name: string, args: Record<string, string> = {}) =>
    JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  bridge.stdin.end(
    [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      call(2, "list_previews"),
      call(3, "list_previews", { deviceId: "ios:1" }),
      call(4, "open_preview", { previewId: "home/empty" }),
      call(5, "open_preview"),
    ].join("\n") + "\n",
  );
  let out = "";
  for await (const chunk of bridge.stdout) out += chunk;
  stop();
  const answers = out
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    answers.map((a) => a.id),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    answers[0].result.tools.map((t: { name: string }) => t.name),
    ["list_devices", "use_device", "list_previews", "open_preview"],
  );
  assert.equal(answers[1].result.content[0].text, "previews for Onboarding");
  assert.equal(answers[2].result.content[0].text, "previews for Onboarding");
  assert.equal(answers[3].result.content[0].text, "building home/empty");
  assert.equal(answers[4].result.isError, true);
  assert.match(answers[4].result.content[0].text, /previewId/);
  assert.deepEqual(calls, ["list:b:-", "list:b:ios:1", "open:b:home/empty:-"]);
});
