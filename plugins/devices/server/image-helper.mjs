// Sharp's native binary isn't signed by Paseo, so the desktop app's hardened helper won't load it.
// This process runs on the Node in PATH (ADDON_NODE) and owns every image operation: live frame
// encoding and annotation compositing. IPC uses JSON serialization, not V8's advanced mode: the
// signed desktop helper embeds a different Node major than this child, so cloned Buffers cannot
// cross the boundary. Image bytes and JPEG results travel as base64 strings with no size cap;
// only the annotation-only limits below constrain the screenshot being marked.
import sharp from "sharp";

const MAX_SIDE = 4096;
const MAX_MARKS = 30;

const bad = (message) => {
  throw new Error(message);
};
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function decode(image) {
  if (typeof image !== "string" || !image.length) bad("Bad image data");
  return Buffer.from(image, "base64");
}

async function encode({ image, raw, rotate, maxWidth }) {
  const input = decode(image);
  if (!Number.isInteger(maxWidth) || maxWidth < 120 || maxWidth > 1600) bad("Bad width");
  let source;
  if (raw) {
    if (
      !Number.isInteger(raw.width) ||
      !Number.isInteger(raw.height) ||
      raw.width < 1 ||
      raw.height < 1 ||
      input.length !== raw.width * raw.height * 3
    )
      bad("Bad raw frame");
    source = sharp(input, { raw: { width: raw.width, height: raw.height, channels: 3 } });
  } else {
    source = sharp(input);
  }
  const { data, info } = await source
    .rotate(Number.isFinite(rotate) ? rotate : 0)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .jpeg({ quality: 72 })
    .toBuffer({ resolveWithObject: true });
  return { jpeg: data.toString("base64"), width: info.width, height: info.height };
}

/** Draws only numbers and outlines; comments travel to the chat draft, never into this SVG. */
function overlay(placed, width, height) {
  const shapes = placed.map(({ n, kind, region }) => {
    const { x, y, w, h } = region;
    const outline =
      kind === "point"
        ? `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="rgba(255,69,58,0.25)" stroke="#ff453a" stroke-width="3"/>`
        : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="rgba(255,69,58,0.12)" stroke="#ff453a" stroke-width="3"/>`;
    const bx = clamp(x, 12, Math.max(12, width - 12));
    const by = clamp(y, 12, Math.max(12, height - 12));
    return `${outline}<circle cx="${bx}" cy="${by}" r="11" fill="#ff453a" stroke="#fff" stroke-width="2"/><text x="${bx}" y="${by + 4}" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#fff" text-anchor="middle">${n}</text>`;
  });
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${shapes.join("")}</svg>`,
  );
}

async function composite({ image, placed, width: expectedWidth, height: expectedHeight }) {
  const input = decode(image);
  const meta = await sharp(input).metadata();
  const width = meta.width;
  const height = meta.height;
  // Annotation-only limits: the saved picture is small and the marks must land on the real pixels.
  if (!width || !height || width > MAX_SIDE || height > MAX_SIDE) bad("Bad picture size");
  if (expectedWidth !== width || expectedHeight !== height) bad("Screenshot dimensions don't match the picture");
  if (!Array.isArray(placed) || placed.length > MAX_MARKS) bad("Too many marks");
  const data = await sharp(input)
    .composite([{ input: overlay(placed, width, height) }])
    .jpeg({ quality: 88 })
    .toBuffer();
  return { jpeg: data.toString("base64") };
}

const ops = { encode, composite };

const reply = (message) => {
  try {
    process.send(message);
  } catch {
    // parent went away; it will reject its pending request on disconnect
  }
};

process.on("message", async (request) => {
  if (!request || typeof request.id !== "number") return;
  try {
    const run = ops[request.op];
    if (!run) bad("Unknown image operation");
    const result = await run(request);
    reply({ id: request.id, ok: true, result });
  } catch (error) {
    reply({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

reply({ ready: true });
