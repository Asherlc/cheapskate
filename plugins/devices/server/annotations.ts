import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { placed, type Mark } from "../shared/annotation";
import { imageRequest } from "./images";
import { STATE_DIR } from "./state";

const DIR = path.join(STATE_DIR, "annotations");

/** Saved pictures live beside the plugin's state, never in a workspace the agent might edit. */
export const annotationFile = (name: string) => path.join(DIR, name);

/** An unguessable name: two screenshots of the same device don't overwrite each other. */
export const newAnnotationName = () => `annotation-${randomUUID()}.jpg`;

/** Draws the numbered marks into a copy of the frame and stores it owner-only. Returns its path. */
export async function saveAnnotation(
  image: Buffer,
  width: number,
  height: number,
  marks: readonly Mark[],
): Promise<string> {
  const { jpeg } = await imageRequest<{ jpeg: string }>("composite", {
    image: image.toString("base64"),
    width,
    height,
    placed: placed(marks, width, height),
  });
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  const file = annotationFile(newAnnotationName());
  await writeFile(file, Buffer.from(jpeg, "base64"), { mode: 0o600, flag: "wx" });
  return file;
}
