import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { ADDON_NODE, pluginDir } from "./paths";

/**
 * One long-lived Node-in-PATH process for every sharp job. Frame encoding runs for each live view,
 * and annotation saving composites a screenshot; both need the native binary the desktop app's
 * own runtime refuses to load. IPC uses JSON serialization: the signed desktop helper embeds a
 * different Node major than the Node in PATH, and V8-serialized Buffers are not readable across
 * that boundary. Image bytes and JPEG results therefore cross as base64 strings, with no byte or
 * character cap here so a full-size Android raw frame still encodes. Only annotation-only limits
 * in the helper apply to the screenshot being marked.
 */
type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
type Pending = { resolve(value: unknown): void; reject(error: Error): void };

let child: ChildProcess | null = null;
let starting: Promise<ChildProcess> | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function fail(error: Error): void {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function start(): Promise<ChildProcess> {
  if (child?.connected) return Promise.resolve(child);
  if (starting) return starting;
  starting = new Promise<ChildProcess>((resolve, reject) => {
    let ready = false;
    const worker = fork(path.join(pluginDir(), "server", "image-helper.mjs"), [], {
      execPath: ADDON_NODE,
      serialization: "json",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stderr = "";
    worker.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4_000)));
    const detail = (code: number | null, signal: NodeJS.Signals | null) =>
      /^\w*Error\b.*$/m.exec(stderr)?.[0] ?? stderr.trim().split("\n").pop() ?? `(${code ?? signal ?? "gone"})`;
    const stop = (error: Error): void => {
      if (!ready) {
        starting = null;
        reject(error);
      } else if (child === worker) {
        child = null;
        fail(error);
      }
    };

    worker.once("error", (error: NodeJS.ErrnoException) =>
      stop(
        error.code === "ENOENT"
          ? new Error("Image encoding needs Node.js 20 or newer installed on this Mac")
          : error,
      ),
    );
    worker.once("exit", (code, signal) =>
      stop(new Error(`The image helper stopped (${code ?? signal}): ${detail(code, signal)}`)),
    );
    worker.once("disconnect", () => stop(new Error("The image helper disconnected")));
    worker.on("message", (message: Reply | { ready?: boolean }) => {
      if (!ready && message && (message as { ready?: boolean }).ready === true) {
        ready = true;
        child = worker;
        starting = null;
        resolve(worker);
        return;
      }
      const reply = message as Reply;
      if (!reply || typeof reply.id !== "number") return;
      const request = pending.get(reply.id);
      if (!request) return;
      pending.delete(reply.id);
      if (reply.ok) request.resolve(reply.result);
      else request.reject(new Error(reply.error));
    });
  });
  return starting;
}

/** Asks the helper to run one image operation; image bytes and JPEGs are base64 strings on the wire. */
export async function imageRequest<T>(op: "encode" | "composite", payload: object): Promise<T> {
  const worker = await start();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    try {
      worker.send({ id, op, ...payload });
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Releases the helper (plugin teardown). Pending work is rejected and the next call starts fresh. */
export function stopImageHelper(): void {
  const worker = child;
  child = null;
  starting = null;
  fail(new Error("The image helper is stopping"));
  if (worker) {
    worker.removeAllListeners("message");
    worker.kill();
  }
}
