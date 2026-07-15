import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const styles = readFileSync(resolve("src/styles/workbench.css"), "utf8");

test("left dock centers its icon column without an indicator gutter", () => {
  assert.doesNotMatch(styles, /--desktop-dock-left-indicator-gutter/u);
  assert.match(
    styles,
    /\.desktop-dock\[data-dock-placement="left"\] \.desktop-dock__items \{[\s\S]*?align-items: center;[\s\S]*?padding: var\(--desktop-dock-left-items-padding-block\) 0;/u
  );
  assert.match(
    styles,
    /\.desktop-dock\[data-dock-placement="left"\] \.desktop-dock__slot \{[\s\S]*?justify-content: center;/u
  );
  assert.match(
    styles,
    /\.desktop-dock\[data-dock-placement="left"\] \.desktop-dock__scroll-button \{[\s\S]*?left: 50%;/u
  );
});

test("left dock renders state indicators beside open and minimized entries", () => {
  assert.doesNotMatch(styles, /content: none !important;/u);
  assert.match(
    styles,
    /\.desktop-dock\[data-dock-placement="left"\][\s\S]*?\.desktop-dock__slot\[data-node-state="open"\]::before,[\s\S]*?\.desktop-dock__slot\[data-node-state="minimized"\]::before \{[\s\S]*?top: 50%;[\s\S]*?bottom: auto;[\s\S]*?left: calc\(var\(--desktop-dock-indicator-offset\) - 2px\);[\s\S]*?transform: translateY\(-50%\);/u
  );
});
