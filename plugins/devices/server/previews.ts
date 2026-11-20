import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Assignment } from "../shared/contracts";
import {
  CATALOG_GUIDANCE,
  previewCatalog,
  type PreviewCatalog,
  type PreviewStatus,
} from "../shared/previews";
import { run } from "./exec";
import { agentToolsAllowed, holderOf, isInside, STATE_DIR, targetOf } from "./state";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Reads the optional catalog. Missing file means no previews; malformed data names the problem. */
export async function readCatalog(directory: string): Promise<PreviewCatalog | null> {
  const file = path.join(directory, "paseo-previews.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Couldn't read paseo-previews.json: ${message(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("paseo-previews.json isn't valid JSON");
  }
  const result = previewCatalog.safeParse(parsed);
  if (!result.success)
    throw new Error(
      `paseo-previews.json is invalid: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`,
    );
  // walk the relative path: a symlink in any segment must not lead out of the workspace
  const root = await realpath(directory);
  let current = root;
  for (const part of result.data.project.split(/[\\/]+/).filter(Boolean)) {
    const next = path.join(current, part);
    let real = next;
    try {
      real = await realpath(next);
    } catch {
      // the project may not have been created yet; the lexical path is still inside the workspace
    }
    if (!isInside(real, root)) throw new Error("The preview project resolves outside the workspace");
    current = real;
  }
  return result.data;
}

export function assertKnownPreview(catalog: PreviewCatalog | null, previewId: string): void {
  if (!catalog) throw new Error(CATALOG_GUIDANCE);
  if (!catalog.previews.some((preview) => preview.id === previewId))
    throw new Error(`Unknown preview ${previewId}; call list_previews for the available ids`);
}

/** The simulator must still belong to the requesting workspace; preview builds never claim one. */
export function assertWorkspaceDevice(workspaceId: string, deviceId: string): Assignment {
  if (!deviceId.startsWith("ios:")) throw new Error("Previews are for iOS simulators only");
  const holder = holderOf(deviceId);
  if (holder?.workspaceId !== workspaceId) throw new Error("That simulator isn't assigned to this workspace");
  return holder;
}

/**
 * The only simulator whose preview status an agent may read: an explicit id must be this workspace's
 * and allowed for agents, else fall back to its current target. An arbitrary deviceId can never
 * expose another workspace's status.
 */
export function previewStatusDevice(workspaceId: string, deviceId?: string): string | undefined {
  if (!deviceId) return targetOf(workspaceId)?.deviceId;
  assertWorkspaceDevice(workspaceId, deviceId);
  if (!agentToolsAllowed(deviceId)) throw new Error("Agent tools are not allowed on this simulator");
  return deviceId;
}

export type PreviewRequest = {
  directory: string;
  workspaceId: string;
  deviceId: string;
  previewId: string;
  // agent requests also need consent; a click in the user's own pane doesn't
  agentRequest: boolean;
};

export type PreviewPlan = { udid: string; bundleId: string; previewId: string; appPath: string };
export type PreviewBuild = (catalog: PreviewCatalog, request: PreviewRequest) => Promise<PreviewPlan>;
export type PreviewInstall = (plan: PreviewPlan) => Promise<void>;
export type PreviewLaunch = (plan: PreviewPlan) => Promise<void>;

/** One target from `xcodebuild -showBuildSettings -json`: settings are nested under `buildSettings`. */
type BuildSettingsTarget = { buildSettings?: Record<string, string> };

/**
 * Finds the separate preview app by its configured bundle id in the real shape Xcode reports: an
 * array of target objects whose settings live under `.buildSettings`, never flattened on the entry.
 * Kept pure so the exact shape can be covered without driving Xcode.
 */
export function previewProduct(settingsJson: string, bundleId: string): { appPath: string } {
  let targets: BuildSettingsTarget[];
  try {
    targets = JSON.parse(settingsJson) as BuildSettingsTarget[];
  } catch {
    throw new Error("Xcode didn't report build settings as JSON");
  }
  if (!Array.isArray(targets)) throw new Error("Unexpected build settings from Xcode");
  const build = targets
    .map((target) => target?.buildSettings)
    .find((settings) => settings?.PRODUCT_BUNDLE_IDENTIFIER === bundleId);
  if (!build) throw new Error(`No build product has the bundle id ${bundleId}`);
  if (!build.TARGET_BUILD_DIR || !build.FULL_PRODUCT_NAME)
    throw new Error("Xcode didn't report the preview app's build product");
  return { appPath: path.join(build.TARGET_BUILD_DIR, build.FULL_PRODUCT_NAME) };
}

const derivedData = (workspaceId: string) =>
  path.join(STATE_DIR, "derived-data", workspaceId.replace(/[^A-Za-z0-9_-]/g, "_"));

const defaultBuild: PreviewBuild = async (catalog, request) => {
  const udid = request.deviceId.slice(4);
  const project = path.resolve(request.directory, catalog.project);
  const args = [
    catalog.project.endsWith(".xcworkspace") ? "-workspace" : "-project",
    project,
    "-scheme",
    catalog.scheme,
    "-configuration",
    "Debug",
    "-destination",
    `platform=iOS Simulator,id=${udid}`,
    "-derivedDataPath",
    derivedData(request.workspaceId),
  ];
  await run("xcrun", ["xcodebuild", ...args, "build"], 900_000);
  // the preview app is a separate target: find the product by its configured bundle id only
  const settings = await run("xcrun", ["xcodebuild", ...args, "-showBuildSettings", "-json"], 300_000);
  const { appPath } = previewProduct(settings, catalog.bundleId);
  return {
    udid,
    bundleId: catalog.bundleId,
    previewId: request.previewId,
    appPath,
  };
};

const defaultInstall: PreviewInstall = async (plan) => {
  await run("xcrun", ["simctl", "install", plan.udid, plan.appPath]);
};

const defaultLaunch: PreviewLaunch = async (plan) => {
  // --terminate-running-process restarts the app so a different --paseo-preview id takes effect
  await run("xcrun", [
    "simctl",
    "launch",
    "--terminate-running-process",
    plan.udid,
    plan.bundleId,
    "--paseo-preview",
    plan.previewId,
  ]);
};

/**
 * One build at a time per workspace. launch() returns a building status immediately, since an
 * Xcode build outlasts an RPC timeout; the background task moves that status to opened or error.
 */
export class Previews {
  private readonly status = new Map<string, PreviewStatus>();
  private readonly building = new Map<string, { deviceId: string; previewId: string }>();

  constructor(
    private readonly build: PreviewBuild = defaultBuild,
    private readonly install: PreviewInstall = defaultInstall,
    private readonly launchApp: PreviewLaunch = defaultLaunch,
  ) {}

  statusOf(deviceId: string): PreviewStatus {
    return this.status.get(deviceId) ?? { state: "idle" };
  }

  async launch(request: PreviewRequest, catalog: PreviewCatalog): Promise<PreviewStatus> {
    if (this.building.has(request.workspaceId))
      throw new Error("A preview is already building in this workspace; wait for it to finish");
    const current: PreviewStatus = {
      state: "building",
      previewId: request.previewId,
      deviceId: request.deviceId,
    };
    this.building.set(request.workspaceId, { deviceId: request.deviceId, previewId: request.previewId });
    this.status.set(request.deviceId, current);
    void (async () => {
      try {
        const plan = await this.build(catalog, request);
        // a long build, then an install, can outlive a release, takeover or consent change:
        // recheck before installing and again before launching the app
        const assertCurrent = () => {
          assertWorkspaceDevice(request.workspaceId, request.deviceId);
          if (request.agentRequest && !agentToolsAllowed(request.deviceId))
            throw new Error("Agent tools are no longer allowed on this simulator");
        };
        assertCurrent();
        await this.install(plan);
        assertCurrent();
        await this.launchApp(plan);
        this.status.set(request.deviceId, {
          state: "opened",
          previewId: request.previewId,
          deviceId: request.deviceId,
        });
      } catch (error) {
        this.status.set(request.deviceId, {
          state: "error",
          previewId: request.previewId,
          deviceId: request.deviceId,
          error: message(error),
        });
      } finally {
        this.building.delete(request.workspaceId);
      }
    })();
    return current;
  }
}

/** Shared by the pane RPCs and the agent MCP: validate, then start a background build. */
export async function openPreview(
  directory: string,
  workspaceId: string,
  previewId: string,
  deviceId: string,
  agentRequest: boolean,
): Promise<{ catalog: PreviewCatalog; status: PreviewStatus }> {
  const catalog = await readCatalog(directory);
  if (!catalog) throw new Error(CATALOG_GUIDANCE);
  assertKnownPreview(catalog, previewId);
  assertWorkspaceDevice(workspaceId, deviceId);
  if (agentRequest && !agentToolsAllowed(deviceId))
    throw new Error("Agent tools are not allowed on this simulator");
  const status = await previews.launch({ directory, workspaceId, deviceId, previewId, agentRequest }, catalog);
  return { catalog, status };
}

/** Shared catalog and status read for both the pane and the picker. */
export async function previewsFor(
  directory: string,
  deviceId?: string,
): Promise<{ catalog: PreviewCatalog | null; status: PreviewStatus }> {
  const catalog = await readCatalog(directory);
  return { catalog, status: deviceId ? previews.statusOf(deviceId) : { state: "idle" } };
}

export const previews = new Previews();
