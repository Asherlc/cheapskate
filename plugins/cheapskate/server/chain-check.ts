import type { PaseoApi } from "./backend";
import { readControls, routePermissions, type BackendControls } from "./controls";

export async function inspectChain(paseo: PaseoApi, chain: string[]) {
  const { entries } = await paseo.providers.snapshot();
  const checks = [];
  for (const selection of chain) {
    const providerId = selection.slice(0, selection.indexOf("/"));
    try {
      const provider = entries.find(({ provider }) => provider === providerId);
      if (provider?.enabled === false) throw new Error("This provider is disabled on this host.");
      const backend: BackendControls = await readControls(paseo, selection);
      checks.push(backend.selectable ? { label: backend.label, backend }
        : { label: backend.label, error: "Paseo does not list this model as selectable." });
    } catch (error) {
      checks.push({ label: selection, error: error instanceof Error ? error.message : "Unable to read backend controls." });
    }
  }

  const primary = checks[0]?.backend;
  const modes = primary ? [...primary.modes] : [];
  if (primary && !modes.length) modes.push({ id: "", label: "Provider default" });
  return {
    modes,
    defaultMode: modes.find(({ id }) => id === primary?.defaultMode)?.id ?? modes[0]?.id ?? "",
    rows: checks.map(({ label, backend, error }) => ({
      label, error,
      mappings: primary && backend ? Object.fromEntries(modes.map(({ id }) => {
        const result = routePermissions(id || undefined, primary, backend, primary.options);
        const mappedMode = backend.modes.find((mode) => mode.id === result?.mode)?.label;
        return [id, result ? mappedMode ?? result.mode ?? "Provider default" : null];
      })) : {},
    })),
  };
}
