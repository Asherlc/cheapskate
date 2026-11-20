import { z } from "zod";

/** Screenshots are squared down before saving, and notes are short: no room for a wall of text. */
export const MAX_MARKS = 30;
export const MAX_NOTE_CHARS = 280;
export const MAX_SIDE = 4096;
export const MAX_PIXELS = 8_000_000;
export const MAX_JPEG_CHARS = 4_000_000;

const unit = z.number().min(0).max(1);

/** One numbered mark. Coordinates are fractions of the picture, origin top-left. */
export const markSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("point"),
    x: unit,
    y: unit,
    text: z.string().max(MAX_NOTE_CHARS),
  }),
  z.object({
    kind: z.literal("box"),
    x: unit,
    y: unit,
    w: unit,
    h: unit,
    text: z.string().max(MAX_NOTE_CHARS),
  }),
]);
export type Mark = z.infer<typeof markSchema>;

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedMark {
  n: number;
  kind: Mark["kind"];
  region: Region;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function inside(x: number, y: number, w: number, h: number, width: number, height: number): Region {
  // A shape starts on the last drawable pixel and its far edge stays inside the frame.
  const left = clamp(Math.round(x), 0, Math.max(0, width - 1));
  const top = clamp(Math.round(y), 0, Math.max(0, height - 1));
  return {
    x: left,
    y: top,
    w: Math.max(1, clamp(Math.round(x + w), left, width) - left),
    h: Math.max(1, clamp(Math.round(y + h), top, height) - top),
  };
}

/**
 * A mark's normalized coordinates to whole pixels inside the picture. A box that runs past an
 * edge is clipped, not rejected, so a rough drag still lands on the screenshot. Points become a
 * small square centred on the spot; the renderer draws it as a ring with the number beside it.
 */
export function region(mark: Mark, width: number, height: number): Region {
  const x = clamp(mark.x, 0, 1) * width;
  const y = clamp(mark.y, 0, 1) * height;
  if (mark.kind === "point") {
    const radius = Math.max(6, Math.round(Math.min(width, height) * 0.025));
    return inside(x - radius, y - radius, radius * 2, radius * 2, width, height);
  }
  return inside(x, y, clamp(mark.w, 0, 1) * width, clamp(mark.h, 0, 1) * height, width, height);
}

/** Numbers come from order, so removing a mark renumbers the ones after it. */
export function placed(marks: readonly Mark[], width: number, height: number): PlacedMark[] {
  return marks.map((mark, index) => ({ n: index + 1, kind: mark.kind, region: region(mark, width, height) }));
}

const short = (value: number) => Math.round(value * 1_000) / 1_000;

/**
 * Text for the chosen chat's draft: the saved file the agent can open, then numbered notes that
 * match the badges drawn on the image. Comments live here rather than inside the picture, so a
 * sentence can't be cropped by a small screenshot.
 */
export function annotationText(path: string, marks: readonly Mark[]): string {
  const notes = marks.map((mark, index) => {
    const where =
      mark.kind === "point"
        ? `point at (${short(mark.x)}, ${short(mark.y)})`
        : `box from (${short(mark.x)}, ${short(mark.y)}) to (${short(mark.x + mark.w)}, ${short(mark.y + mark.h)})`;
    return `${index + 1}. ${where}${mark.text ? ` — ${mark.text}` : ""}`;
  });
  return [`Annotated screenshot: ${path}`, ...(notes.length ? ["", ...notes] : [])].join("\n");
}
