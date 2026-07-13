import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const actionsMenuSource = readFileSync(
  resolve(currentDirectory, "BrowserNodeActionsMenu.tsx"),
  "utf8"
);

test("Browser Node actions render inline without a portal", () => {
  assert.match(actionsMenuSource, /<MenuSurface/);
  assert.doesNotMatch(
    actionsMenuSource,
    /(?:DropdownMenu|ViewportMenuSurface)(?:Content|Sub|Trigger)?/
  );
  assert.match(
    actionsMenuSource,
    /const hostOverlayOpen = clearDialogOpen \|\| settingsOpen/
  );
  assert.doesNotMatch(actionsMenuSource, /hostOverlayOpen = menuOpen/);
});

test("Browser Node nested actions stay inside one host menu surface", () => {
  for (const panel of ["find", "device", "screenshot", "downloads"]) {
    assert.match(actionsMenuSource, new RegExp(`menuPanel === "${panel}"`));
  }
});
