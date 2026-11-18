import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const base = z.object({ key: z.string(), label: z.string(), icon: z.string().optional() });
const control = z.discriminatedUnion("type", [
  base.extend({ type: z.literal("toggle"), defaultValue: z.boolean().optional() }),
  base.extend({
    type: z.literal("select"),
    defaultValue: z.string().optional(),
    choices: z.array(z.object({ value: z.string(), label: z.string(), description: z.string().optional() })),
  }),
]);

export const prepareDraft = defineRpc({
  name: "routing.prepare-draft",
  input: z.object({ model: z.string().optional() }),
  output: z.object({
    controls: z.array(control), options: z.record(z.string(), z.json()),
    modes: z.array(z.object({ id: z.string(), label: z.string(), description: z.string().optional() })),
  }),
});
