import { z } from "zod";

export const activeRouteKey = "cheapskate.activeRoute";
export const primaryRequestKey = "cheapskate.tryPrimary";
export const handledPrimaryKey = "cheapskate.handledPrimary";

export const activeRoute = z.object({
  selection: z.string(),
  label: z.string(),
  change: z.object({
    reason: z.enum(["limit", "unavailable", "permissions", "requested", "removed"]),
    from: z.string(),
  }).optional(),
});

export type RouteChange = NonNullable<z.infer<typeof activeRoute>["change"]>;
