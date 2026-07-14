import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(
  new URL("../styles/workbench.css", import.meta.url),
  "utf8"
);

test("custom headers can opt inline overlays out of header clipping", () => {
  assert.match(
    styles,
    /\.workbench-window__header--custom:has\(\s*\[data-workbench-custom-header-overflow="visible"\]\s*\) \{\s*overflow: visible;\s*\}/u
  );
});

test("browser tab headers can opt into a double-height workbench row", () => {
  assert.match(
    styles,
    /\.workbench-window:has\(\s*\[data-workbench-custom-header-layout="browser-tabs"\]\s*\) \{\s*--workbench-header-height: 76px;\s*\}/u
  );
});
