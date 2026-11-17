import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

export type WorkerState = { id: string; selection: string; inFlight: boolean };
export type Checkpoint = { items: ProviderTimelineItem[]; worker?: WorkerState };

export function createCheckpoint(owner: string) {
  const root = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "cheapskate");
  const file = join(root, createHash("sha256").update(owner).digest("hex") + ".json");
  return {
    async read(): Promise<Checkpoint> {
      try {
        return JSON.parse(await readFile(file, "utf8")) as Checkpoint;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [] };
        throw error;
      }
    },
    async write(value: Checkpoint) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const temporary = file + "." + randomUUID();
      try {
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}
