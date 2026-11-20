import { spawnProcess } from "@getpaseo/plugin/server";
import type { ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type { ServerStatus, StartServerInput } from "../shared/contracts";
import { listStories } from "./storybook";

const bindHost = "127.0.0.1";
const startupTimeoutMs = 45_000;
const idle: ServerStatus = { state: "idle" };

type Run = {
  key: string;
  status: ServerStatus;
  abort: AbortController;
  logs: string;
  port?: number;
  process?: { child: ChildProcess; closed: Promise<void> };
  stopping?: Promise<void>;
};

function containsDirectory(base: string, path: string) {
  const fromBase = relative(base, path);
  return fromBase !== ".." && !fromBase.startsWith(`..${sep}`) && !isAbsolute(fromBase);
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, bindHost, () => {
      const address = socket.address();
      socket.close((error) => {
        if (error) reject(error);
        else if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("Could not allocate a port for Storybook."));
      });
    });
  });
}

function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

async function stopProcess({ child, closed }: NonNullable<Run["process"]>) {
  if (child.pid !== undefined) {
    signalGroup(child.pid, "SIGTERM");
    await Promise.race([closed, delay(500, undefined, { ref: false })]);
    // A package-manager wrapper can exit before its children.
    signalGroup(child.pid, "SIGKILL");
  }
  const stopped = await Promise.race([closed.then(() => true), delay(500, false, { ref: false })]);
  if (!stopped) throw new Error("Storybook did not close. Try stopping it again.");
}

export function createManagedStorybook() {
  const runs = new Map<string, Run>();
  let disposed = false;

  function finish(workspaceId: string, run: Run, failure?: string): Promise<void> {
    if (run.stopping) return run.stopping;
    run.status = { state: "stopping" };
    run.abort.abort();
    run.stopping = Promise.resolve().then(async () => {
      try {
        if (run.process) await stopProcess(run.process);
        run.process = undefined;
        run.port = undefined;
        if (failure) {
          const logTail = stripVTControlCharacters(run.logs).trim();
          run.status = { state: "failed", error: logTail ? `${failure}\n${logTail}` : failure };
        } else {
          runs.delete(workspaceId);
        }
      } catch (error) {
        run.status = { state: "failed", error: error instanceof Error ? error.message : String(error) };
        throw error;
      } finally {
        run.stopping = undefined;
      }
    });
    return run.stopping;
  }

  async function launch(workspaceId: string, run: Run, base: string, requestedCwd: string, input: StartServerInput) {
    const { signal } = run.abort;
    function fail(message: string) {
      if (!signal.aborted) void finish(workspaceId, run, message).catch(() => {});
    }
    try {
      const [root, cwd] = await Promise.all([realpath(base), realpath(requestedCwd)]);
      if (!containsDirectory(root, cwd)) throw new Error("Choose a working directory inside the agent checkout.");
      signal.throwIfAborted();
      let port: number;
      do {
        port = await availablePort();
        signal.throwIfAborted();
      } while ([...runs.values()].some((other) => other.port === port));
      run.port = port;
      const url = `http://${bindHost}:${port}/`;
      const child = spawnProcess(input.command, input.args.map((arg) => arg.replace("{port}", String(port))), {
        cwd,
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      run.process = { child, closed };
      const appendLog = (chunk: Buffer) => { run.logs = (run.logs + chunk.toString()).slice(-4096); };
      child.stdout?.on("data", appendLog);
      child.stderr?.on("data", appendLog);
      child.once("error", (error) => fail(`Could not launch Storybook: ${error.message}`));
      child.once("exit", (code, signal) => fail(`Storybook exited (${signal ?? code}).`));
      run.status = { state: "starting", url };

      const timeout = AbortSignal.timeout(startupTimeoutMs);
      const startup = AbortSignal.any([signal, timeout]);
      while (!startup.aborted) {
        try {
          await listStories({ url }, startup);
          if (!startup.aborted) {
            run.status = { state: "ready", url };
            return;
          }
        } catch {
          await delay(250, undefined, { signal: startup });
        }
      }
      if (timeout.aborted) fail("Storybook did not serve a valid story index within 45 seconds.");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError" && !signal.aborted) {
        fail("Storybook did not serve a valid story index within 45 seconds.");
      } else {
        fail(error instanceof Error ? error.message : String(error));
      }
    }
  }

  async function stop(workspaceId: string): Promise<ServerStatus> {
    const run = runs.get(workspaceId);
    if (run) {
      await finish(workspaceId, run);
      if (runs.get(workspaceId) === run && !run.process) runs.delete(workspaceId);
    }
    return idle;
  }

  return {
    start(workspaceId: string, base: string, input: StartServerInput): ServerStatus {
      if (disposed) throw new Error("The Storybook plugin is shutting down.");
      if (process.platform === "win32") throw new Error("Managed Storybook requires a macOS or Linux Paseo host.");
      const requested = input.cwd ?? ".";
      const cwd = resolve(base, requested);
      if (isAbsolute(requested) || !containsDirectory(base, cwd)) {
        throw new Error("Choose a relative working directory inside the agent checkout.");
      }
      const key = JSON.stringify([cwd, input.command, input.args]);
      const current = runs.get(workspaceId);
      if (current && (current.process || current.status.state !== "failed")) {
        if (current.key === key && ["starting", "ready"].includes(current.status.state)) return current.status;
        throw new Error("Stop the existing Storybook process before starting another command.");
      }
      const run: Run = { key, status: { state: "starting" }, abort: new AbortController(), logs: "" };
      runs.set(workspaceId, run);
      void launch(workspaceId, run, base, cwd, input);
      return run.status;
    },
    status(workspaceId: string): ServerStatus {
      return runs.get(workspaceId)?.status ?? idle;
    },
    stop,
    async dispose() {
      disposed = true;
      await Promise.all([...runs.keys()].map(stop));
    },
  };
}

export type ManagedStorybooks = ReturnType<typeof createManagedStorybook>;
