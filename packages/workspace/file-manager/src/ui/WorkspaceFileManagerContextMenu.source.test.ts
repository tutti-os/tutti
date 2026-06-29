import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(
    new URL("./WorkspaceFileManagerContextMenu.tsx", import.meta.url)
  ),
  "utf8"
);

test("open-with submenu starts actions before closing the context menu", () => {
  assert.match(
    source,
    /const openPromise = onOpenWithApplication\(\s*application\.applicationPath\s*\);\s*onClose\(\);\s*void openPromise;/s
  );
  assert.match(
    source,
    /const openPromise = onOpenWithOtherApplication\(\);\s*onClose\(\);\s*void openPromise;/s
  );
  assert.match(
    source,
    /const openPromise = onOpenInDefaultBrowser\(\);\s*onClose\(\);\s*void openPromise;/s
  );
});

test("open-with submenu actions can activate on pointer down", () => {
  assert.match(
    source,
    /activateOnPointerDown = false[\s\S]*onPointerDown=\{\(event\) => \{[\s\S]*!activateOnPointerDown[\s\S]*event\.preventDefault\(\);[\s\S]*event\.stopPropagation\(\);[\s\S]*pointerActivatedRef\.current = true;[\s\S]*onClick\(\);[\s\S]*\}\}/
  );
  assert.match(
    source,
    /if \(pointerActivatedRef\.current\) \{[\s\S]*pointerActivatedRef\.current = false;[\s\S]*return;[\s\S]*\}/
  );
  const activateOnPointerDownCount =
    source.match(/<ContextMenuActionButton\s+activateOnPointerDown/g)?.length ??
    0;
  assert.ok(activateOnPointerDownCount >= 5);
});
