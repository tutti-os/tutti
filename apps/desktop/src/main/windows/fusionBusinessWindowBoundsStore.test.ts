import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEmptyFusionBusinessWindowBoundsState } from "./fusionBusinessWindowBounds.ts";
import { createFusionBusinessWindowBoundsStore } from "./fusionBusinessWindowBoundsStore.ts";

test("Fusion business bounds store round trips atomically and ignores invalid data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tutti-fusion-bounds-"));
  const path = join(directory, "bounds.json");
  const store = createFusionBusinessWindowBoundsStore(path);
  try {
    assert.equal(await store.read(), null);
    await writeFile(path, JSON.stringify({ version: 2 }), "utf8");
    assert.equal(await store.read(), null);

    const state = createEmptyFusionBusinessWindowBoundsState();
    state.entries.terminal = {
      displayId: 1,
      height: 700,
      updatedAtUnixMs: 10,
      width: 1000,
      x: 40,
      y: 60
    };
    await Promise.all([store.write(state), store.write(state)]);
    assert.deepEqual(await store.read(), state);
    assert.doesNotMatch(await readFile(path, "utf8"), /undefined/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
