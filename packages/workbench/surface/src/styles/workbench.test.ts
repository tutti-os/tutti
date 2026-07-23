import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("./workbench.css", import.meta.url), "utf8");

test("workbench structural selectors use explicit subject state", () => {
  assert.doesNotMatch(css, /:has\(/);
  assert.match(
    css,
    /\.workbench-window\[data-window-header-overflow="visible"\]/
  );
  assert.match(css, /\.desktop-dock-plate\[data-dock-pointer-active="true"\]/);
});
