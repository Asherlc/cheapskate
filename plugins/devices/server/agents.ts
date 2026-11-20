import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginHookContext, PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import type { Assignment } from "../shared/contracts";
import { serialOf } from "./android";
import { NODE, NODE_ENV, PLUGIN_DIR, dependencyFile } from "./paths";
import type { Workspace } from "./picker";
import { STATE_DIR, anyAgentTools, assignmentFor, assignments, isInside, setTarget, targetOf } from "./state";

const AGENT_DEVICE = dependencyFile("agent-device", "bin/agent-device.mjs");
const CONFIG_DIR = path.join(STATE_DIR, "agent-device");
export const PICKER_SOCKET = path.join(STATE_DIR, "picker.sock");
const configFile = (workspaceId: string) =>
  path.join(CONFIG_DIR, `${workspaceId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

/**
 * The picker MCP server as an agent runs it. The launch hook reissues this same config with the
 * agent's identity, so use_device records which chat owns the device for screenshot annotations.
 */
function pickerServer(workspace: Workspace, agentId?: string) {
  return {
    type: "stdio" as const,
    command: NODE,
    args: [path.join(PLUGIN_DIR, "server", "picker-bridge.mjs")],
    env: {
      ...NODE_ENV,
      PASEO_DEVICES_SOCKET: PICKER_SOCKET,
      PASEO_DEVICES_WORKSPACE: JSON.stringify(workspace),
      ...(agentId ? { PASEO_DEVICES_AGENT: agentId } : {}),
    },
  };
}

/**
 * agent-device reads this file on every tool call, so agents follow it as soon as it changes. It
 * names the device the workspace's agents drive and a session named after that device: a session
 * stays on the device it first used, so a new device needs a new session.
 */
async function writeAgentConfig(assignment: Assignment): Promise<string> {
  let target: { platform: "ios"; udid: string } | { platform: "android"; serial: string };
  if (assignment.deviceId.startsWith("ios:"))
    target = { platform: "ios", udid: assignment.deviceId.slice(4) };
  else {
    // An AVD that is off has no serial yet. Name one that can't match: without a serial,
    // agent-device would pick any running emulator, possibly another workspace's.
    const serial = await serialOf(assignment.deviceId).catch(() => null);
    target = { platform: "android", serial: serial ?? "off" };
  }
  const device = target.platform === "ios" ? target.udid : target.serial;
  const session = `paseo-${assignment.workspaceId}-${device}`.replace(/[^A-Za-z0-9_.-]/g, "_");
  const file = configFile(assignment.workspaceId);
  await writeFile(
    `${file}.tmp`,
    `${JSON.stringify({ session, sessionLock: "strip", ...target }, null, 2)}\n`,
  );
  await rename(`${file}.tmp`, file);
  return file;
}

/**
 * After a preview starts, point the workspace's device tools at its simulator and record which chat
 * claimed it, so interaction works and annotation drafts reach that chat's Device panel.
 */
export async function claimPreviewTarget(
  workspaceId: string,
  deviceId: string,
  agentId?: string,
): Promise<void> {
  await setTarget(workspaceId, deviceId, agentId);
  await syncAgentConfigs();
}

let syncing = Promise.resolve();

/**
 * Brings every workspace's file in line with the device its agents drive (targetOf) and deletes
 * the others. A file is only written for a device the user allowed agent tools on, so agents
 * already running stop reaching a device that was released, taken over, deleted or had consent
 * withdrawn: they move to another of the workspace's allowed devices, or with none left, the
 * missing file fails every agent-device call. agent-device never installs its helpers on a device
 * without consent. Runs after every change, consent included; one sync at a time.
 */
export function syncAgentConfigs(): Promise<void> {
  syncing = syncing
    .catch(() => {})
    .then(async () => {
      await mkdir(CONFIG_DIR, { recursive: true });
      const keep = new Set<string>();
      for (const workspaceId of new Set(assignments().map((a) => a.workspaceId))) {
        const target = targetOf(workspaceId);
        if (target) keep.add(path.basename(await writeAgentConfig(target)));
      }
      for (const name of await readdir(CONFIG_DIR))
        if (!keep.has(name)) await rm(path.join(CONFIG_DIR, name), { force: true });
    });
  return syncing;
}

type PaseoApi = PluginHookContext["paseo"];

/** The Paseo workspace containing cwd (the deepest one), whether or not it holds a device. */
async function workspaceAt(paseo: PaseoApi, cwd: string): Promise<Workspace | null> {
  const entries: Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>["entries"] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    entries.push(...page.entries);
    cursor = page.pageInfo?.nextCursor ?? undefined;
  } while (cursor);
  const found = entries
    .filter((w) => isInside(cwd, w.workspaceDirectory))
    .sort((a, b) => b.workspaceDirectory.length - a.workspaceDirectory.length)[0];
  return found
    ? { workspaceId: found.id, workspaceName: found.title ?? found.name, directory: found.workspaceDirectory }
    : null;
}

const NO_DEVICE =
  "This workspace has no simulator or emulator agents may drive yet, so the `device` tools fail " +
  "until it has one. To use one, call `device-picker`'s list_devices, then use_device with a free device.";

const USE_DEVICE =
  "Before driving a device, call `device-picker`'s use_device with the simulator you'll use. " +
  "That claim tells the Device panel which chat to send your screenshot annotations to.";

/**
 * The workspace an agent session belongs to: prefer the id Paseo opened it with, then the one
 * containing its cwd. cwd alone is ambiguous for worktrees; the id is authoritative when present.
 */
async function requestWorkspace(paseo: PaseoApi, request: PluginSessionOpenRequest): Promise<Workspace | null> {
  const ref = request.workspaceId ? paseo.workspaces.ref(request.workspaceId).current() : null;
  if (ref?.workspaceDirectory)
    return { workspaceId: ref.id, workspaceName: ref.title ?? ref.name, directory: ref.workspaceDirectory };
  const found = await workspaceAt(paseo, request.cwd).catch(() => null);
  if (!found) return null;
  return request.workspaceId ? { ...found, workspaceId: request.workspaceId } : found;
}

/**
 * Agents started in a workspace get agent-device's MCP tools for one of its devices once the user
 * has allowed agent tools on it: agent-device installs its helpers there on first use. They also
 * get the picker, to switch between the workspace's devices or take a free one the user allowed
 * agents on; agent-device follows its config file, rewritten on every change.
 */
export function injectDeviceTools(server: PluginServerContext, ready: Promise<void>) {
  const unhookCreate = server.before("agent.create", async ({ request }, { paseo }) => {
    const { config } = request;
    // Paseo's own background agents (commit messages, PR descriptions) don't drive devices
    if (config.internal) return undefined;
    await ready;
    if (!anyAgentTools()) return undefined;
    const workspace = assignmentFor(config.cwd) ?? (await workspaceAt(paseo, config.cwd).catch(() => null));
    if (!workspace) return undefined;
    // picks up an emulator started outside the plugin since the last change
    await syncAgentConfigs().catch((error) => console.error("syncing agent-device configs:", error));
    return {
      ...request,
      config: {
        ...config,
        mcpServers: {
          ...config.mcpServers,
          device: {
            type: "stdio" as const,
            command: NODE,
            args: [AGENT_DEVICE, "mcp"],
            env: {
              ...NODE_ENV,
              AGENT_DEVICE_CONFIG: configFile(workspace.workspaceId),
              AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
            },
          },
          "device-picker": pickerServer(workspace),
        },
        systemPrompt: [config.systemPrompt, targetOf(workspace.workspaceId) ? USE_DEVICE : NO_DEVICE]
          .filter(Boolean)
          .join("\n\n"),
      },
    };
  });

  // agent.create has no agentId; the launch hook does. Reissue the picker with it so use_device
  // records the owner, which is how the Device panel routes annotations to the right chat.
  const unhookOpen = server.addHook("agent.open.before", async ({ request }, { paseo }) => {
    // history sessions only read old turns; unrelated background agents don't drive devices
    if (request.purpose === "history") return undefined;
    if (request.background && !request.labels["cheapskate.owner"]) return undefined;
    await ready;
    if (!anyAgentTools()) return undefined;
    const workspace = await requestWorkspace(paseo, request);
    if (!workspace) return undefined;
    const agentId = request.labels["cheapskate.owner"] ?? request.agentId;
    return {
      ...request,
      mcpServers: { ...request.mcpServers, "device-picker": pickerServer(workspace, agentId) },
    };
  });

  return () => {
    unhookCreate();
    unhookOpen();
  };
}
