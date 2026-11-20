import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import sharp from "sharp";

// paths.ts resolves the installed plugin from PASEO_HOME when it is imported.
process.env.PASEO_HOME = mkdtempSync(path.join(os.tmpdir(), "devices-images-test-"));
writeFileSync(
  path.join(process.env.PASEO_HOME, "config.json"),
  JSON.stringify({ plugins: { devices: { path: path.join(import.meta.dirname, ".."), enabled: true } } }),
);
// Import lazily: tsx runs these .ts files as CJS, so a top-level await would fail to transform.
let imageRequest!: typeof import("./images").imageRequest;
let stopImageHelper!: typeof import("./images").stopImageHelper;
before(async () => {
  ({ imageRequest, stopImageHelper } = await import("./images"));
});
after(() => stopImageHelper());

test("a full-size Android raw frame encodes over base64 JSON IPC, with no body limit", async () => {
  const width = 1080;
  const height = 2400;
  const raw = Buffer.alloc(width * height * 3, 128); // 7.8 MB, past the old 6 MB cap
  const result = await imageRequest<{ jpeg: string; width: number; height: number }>("encode", {
    image: raw.toString("base64"),
    raw: { width, height },
    rotate: 0,
    maxWidth: 720,
  });
  assert.equal(typeof result.jpeg, "string");
  assert.equal(result.width, 720);
  assert.equal(result.height, 1600);
  const meta = await sharp(Buffer.from(result.jpeg, "base64")).metadata();
  assert.equal(meta.width, 720);
  assert.equal(meta.height, 1600);
});

test("encode rejects a raw frame whose byte length disagrees with its dimensions", async () => {
  await assert.rejects(
    imageRequest("encode", {
      image: Buffer.alloc(100).toString("base64"),
      raw: { width: 1080, height: 2400 },
      rotate: 0,
      maxWidth: 720,
    }),
    /Bad raw frame/,
  );
});

test("point and box marks composite an SVG overlay into a valid JPEG", async () => {
  const width = 200;
  const height = 100;
  const input = await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
    .jpeg()
    .toBuffer();
  const { jpeg } = await imageRequest<{ jpeg: string }>("composite", {
    image: input.toString("base64"),
    width,
    height,
    placed: [
      { n: 1, kind: "point", region: { x: 50, y: 25, w: 10, h: 10 } },
      { n: 2, kind: "box", region: { x: 100, y: 50, w: 60, h: 30 } },
    ],
  });
  assert.equal(typeof jpeg, "string");
  const decoded = Buffer.from(jpeg, "base64");
  const meta = await sharp(decoded).metadata();
  assert.equal(meta.width, width);
  assert.equal(meta.height, height);
  const { data, info } = await sharp(decoded).raw().toBuffer({ resolveWithObject: true });
  let reddish = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i] > 150 && data[i] > data[i + 1] + 40) reddish++;
  }
  assert.ok(reddish > 0, "expected red numbered outlines in the composite");
});

test("composite refuses annotation dimensions that don't match the real picture", async () => {
  const input = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#ffffff" } })
    .jpeg()
    .toBuffer();
  await assert.rejects(
    imageRequest("composite", { image: input.toString("base64"), width: 51, height: 50, placed: [] }),
    /don't match/,
  );
});
