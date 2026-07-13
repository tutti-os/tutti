import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const coordinatorSource = await readFile(
  new URL("./fusionWindowCoordinator.ts", import.meta.url),
  "utf8"
);

test("Fusion coordinator restores and persists only business window bounds", () => {
  assert.match(
    coordinatorSource,
    /createFusionBusinessWindowBoundsStore\([\s\S]*fusion-business-window-bounds\.json/
  );
  assert.match(
    coordinatorSource,
    /resolveFusionBusinessWindowBounds\([\s\S]*cascade: launchRecord\.forceNew === true/
  );
  assert.match(coordinatorSource, /target\.on\("move"/);
  assert.match(coordinatorSource, /target\.on\("resize"/);
  assert.match(
    coordinatorSource,
    /#handleDisplaysChanged[\s\S]*#restoreBusinessWindowToAvailableDisplay/
  );
  const dockWindowStart = coordinatorSource.indexOf("async #createDockWindow");
  const businessWindowStart = coordinatorSource.indexOf(
    "async #createBusinessWindow"
  );
  assert.ok(dockWindowStart >= 0 && businessWindowStart > dockWindowStart);
  assert.doesNotMatch(
    coordinatorSource.slice(dockWindowStart, businessWindowStart),
    /BusinessWindowBounds/
  );
});
