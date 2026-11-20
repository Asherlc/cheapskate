import { z } from "zod";

/** A short path-shaped name for one state of the preview app, e.g. "home/empty". */
export const previewId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_./-]{0,63}$/)
  .refine(
    (id) => !id.endsWith("/") && !id.includes("//") && !id.split("/").includes(".."),
    "invalid preview id",
  );

export const previewEntry = z.object({
  id: previewId,
  title: z.string().min(1).max(120),
});

/** `paseo-previews.json` at the workspace root. Points at a separate preview app, never the main one. */
export const previewCatalog = z
  .object({
    project: z.string().min(1).refine(
      (project) =>
        !project.startsWith("/") &&
        !project.startsWith("\\") &&
        !project.includes(":") &&
        !/(^|[\\/])\.\.([\\/]|$)/.test(project) &&
        /\.(xcodeproj|xcworkspace)$/.test(project),
      "project must be a relative .xcodeproj or .xcworkspace inside the workspace",
    ),
    scheme: z.string().min(1),
    bundleId: z.string().min(1),
    previews: z.array(previewEntry).min(1),
  })
  .superRefine((catalog, ctx) => {
    const seen = new Set<string>();
    for (const preview of catalog.previews) {
      if (seen.has(preview.id))
        ctx.addIssue({ code: "custom", path: ["previews"], message: "previews must have unique ids" });
      seen.add(preview.id);
    }
  });

export type PreviewCatalog = z.infer<typeof previewCatalog>;
export type PreviewEntry = z.infer<typeof previewEntry>;

/** The launch state of one preview on one simulator. UI and agent MCP read the same values. */
export const previewStatus = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle") }),
  z.object({ state: z.literal("building"), previewId: z.string(), deviceId: z.string() }),
  z.object({ state: z.literal("opened"), previewId: z.string(), deviceId: z.string() }),
  z.object({ state: z.literal("error"), previewId: z.string(), deviceId: z.string(), error: z.string() }),
]);
export type PreviewStatus = z.infer<typeof previewStatus>;

/** Shown by both the pane and the picker when a workspace has no usable catalog. */
export const CATALOG_GUIDANCE =
  "Add paseo-previews.json to the workspace root: { project: a relative .xcodeproj or .xcworkspace, " +
  "scheme, bundleId: the separate preview app's bundle identifier, previews: [{ id, title }] }. " +
  "The id is a short path-shaped name passed to the app as --paseo-preview <id>.";
