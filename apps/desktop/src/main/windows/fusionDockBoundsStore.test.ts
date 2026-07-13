import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFusionDockBoundsStore } from "./fusionDockBoundsStore.ts";

test("Fusion Dock bounds store serializes writes and preserves the latest position", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fusion-dock-bounds-"));
  const store = createFusionDockBoundsStore(join(directory, "bounds.json"));
  const first = {
    displayId: 1,
    height: 520,
    width: 88,
    x: 20,
    y: 180
  };
  const latest = { ...first, displayId: 2, x: 1_440, y: 220 };

  await Promise.all([store.write(first), store.write(latest)]);

  assert.deepEqual(await store.read(), latest);
});
