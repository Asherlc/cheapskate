import assert from "node:assert/strict";
import test from "node:test";
import { formatChain, moveRow, readRows, searchModels } from "../client/chain-picker.ts";

test("saved entries round-trip in order, including unavailable IDs and model IDs containing slashes", () => {
  const chain = "cheapskate-opencode/opencode/hy4-flash-free\nmissing/vendor/old-model";
  const rows = readRows(chain);
  assert.equal(rows[0].provider, "cheapskate-opencode");
  assert.equal(rows[0].model, "opencode/hy4-flash-free");
  assert.equal(rows[1].model, "vendor/old-model");
  assert.equal(formatChain(rows), chain);
  assert.equal(formatChain([]), "");
  assert.equal(formatChain([...rows, { id: 2, provider: "codex", model: "" }]), null);
});

test("moving an entry keeps its identity and changes only the save order", () => {
  const rows = readRows("codex/model-a\nclaude/model-b\nopencode/vendor/model-c");
  const next = moveRow(rows, rows[2].id, -1);
  assert.deepEqual(next.map(({ id }) => id), [rows[0].id, rows[2].id, rows[1].id]);
  assert.equal(formatChain(next), "codex/model-a\nopencode/vendor/model-c\nclaude/model-b");
  assert.equal(moveRow(rows, rows[0].id, -1), rows);
  assert.equal(moveRow(rows, 99, 1), rows);
});

test("model search matches native labels, IDs and aliases and hides non-selectable models", () => {
  const models = [
    { id: "vendor/a", label: "Example Alpha", aliases: ["stable"] },
    { id: "vendor/b", label: "Example Beta", isSelectable: false },
    { id: "other/c", label: "Other" },
  ];
  assert.deepEqual(searchModels(models, " EXAMPLE ").map(({ id }) => id), ["vendor/a"]);
  assert.deepEqual(searchModels(models, "vendor/a").map(({ id }) => id), ["vendor/a"]);
  assert.deepEqual(searchModels(models, "stable").map(({ id }) => id), ["vendor/a"]);
  assert.deepEqual(searchModels(models, "").map(({ id }) => id), ["vendor/a", "other/c"]);
});
