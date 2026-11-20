import { imageRequest } from "./images";

export interface Frame {
  seq: number;
  image: Buffer;
  // RGB pixels when set (Android gRPC); otherwise `image` is an encoded JPEG/PNG
  raw?: { width: number; height: number };
  // degrees to turn the picture clockwise to show it upright
  rotate?: number;
}

const cache = new Map<
  string,
  { seq: number; maxWidth: number; rotate: number; jpeg: string; width: number; height: number }
>();

/** A JPEG no wider than maxWidth, as base64. Re-encodes only when the frame or the width changed. */
export async function encode(deviceId: string, frame: Frame, maxWidth: number) {
  const hit = cache.get(deviceId);
  const rotate = frame.rotate ?? 0;
  if (hit && hit.seq === frame.seq && hit.maxWidth === maxWidth && hit.rotate === rotate) return hit;
  const encoded = await imageRequest<{ jpeg: string; width: number; height: number }>("encode", {
    image: frame.image.toString("base64"),
    raw: frame.raw,
    rotate,
    maxWidth,
  });
  const entry = {
    seq: frame.seq,
    maxWidth,
    rotate,
    jpeg: encoded.jpeg,
    width: encoded.width,
    height: encoded.height,
  };
  cache.set(deviceId, entry);
  return entry;
}

export const forget = (deviceId: string) => cache.delete(deviceId);
