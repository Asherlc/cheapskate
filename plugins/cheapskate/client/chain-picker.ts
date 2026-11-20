import { parseChain } from "../shared/settings.ts";

export type ChainRow = { id: number; provider: string; model: string };
export type CatalogModel = {
  id: string;
  label: string;
  aliases?: readonly string[];
  isSelectable?: boolean;
};

export function readRows(chain: string): ChainRow[] {
  return parseChain(chain).map((selection, id) => {
    const slash = selection.indexOf("/");
    return { id, provider: selection.slice(0, slash), model: selection.slice(slash + 1) };
  });
}

export function formatChain(rows: readonly ChainRow[]) {
  if (rows.some(({ provider, model }) => !provider || !model)) return null;
  return rows.map(({ provider, model }) => `${provider}/${model}`).join("\n");
}

export function moveRow<Row extends ChainRow>(rows: Row[], id: number, direction: -1 | 1) {
  const from = rows.findIndex((row) => row.id === id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= rows.length) return rows;
  const reordered = [...rows];
  [reordered[from], reordered[to]] = [reordered[to], reordered[from]];
  return reordered;
}

export function searchModels(models: readonly CatalogModel[], query: string) {
  const needle = query.trim().toLowerCase();
  return models.filter(({ id, label, aliases, isSelectable }) =>
    isSelectable !== false && [id, label, ...(aliases ?? [])].some((value) => value.toLowerCase().includes(needle)));
}
