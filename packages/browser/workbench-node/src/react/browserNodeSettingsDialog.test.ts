import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./BrowserNodeSettingsDialog.tsx", import.meta.url),
  "utf8"
);

test("settings selects render their menus above the dialog", () => {
  const dialogSelectMenus = source.match(
    /<SelectContent style=\{\{ zIndex: "var\(--z-dialog-popover\)" \}\}>/g
  );

  assert.equal(dialogSelectMenus?.length, 2);
});
