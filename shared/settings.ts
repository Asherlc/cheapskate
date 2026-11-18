import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const providerId = "cheapskate";

export function parseChain(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export const preferences = defineSettings({
  id: "routing",
  scope: "host",
  version: 1,
  schema: z.object({
    chain: z.string().max(4096).default("").superRefine((text, context) => {
      const chain = parseChain(text);
      const invalid = chain.find(
        (entry) => !/^[a-z][a-z0-9-]*\/\S+$/.test(entry) || entry.startsWith(providerId + "/"),
      );
      if (invalid) {
        context.addIssue({ code: "custom", message: "Choose a provider and model for every entry. Cheapskate cannot route to itself." });
      } else if (new Set(chain).size !== chain.length) {
        context.addIssue({ code: "custom", message: "Each provider/model can appear only once." });
      }
    }),
    overload: z.boolean().default(false),
  }),
});
