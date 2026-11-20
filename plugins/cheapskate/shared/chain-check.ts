import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { chainSettings } from "./settings";

export const checkChain = defineRpc({
  name: "routing.check-chain",
  input: chainSettings.pick({ chain: true }),
  output: z.object({
    defaultMode: z.string(),
    modes: z.array(z.object({ id: z.string(), label: z.string() })),
    rows: z.array(z.object({
      label: z.string(),
      error: z.string().optional(),
      mappings: z.record(z.string(), z.string().nullable()),
    })),
  }),
});
