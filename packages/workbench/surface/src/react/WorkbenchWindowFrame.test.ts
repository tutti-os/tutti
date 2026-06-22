import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("workbench windows define viewport menu boundaries for local floating menus", () => {
  const source = readFileSync(
    resolve("src/react/WorkbenchWindowFrame.tsx"),
    "utf8"
  );

  assert.match(source, /className="workbench-window-shell"/);
  assert.match(source, /data-slot="viewport-menu-boundary"/);
});

test("fullscreen windows default to reveal header mode", () => {
  const source = readFileSync(
    resolve("src/react/WorkbenchWindowFrame.tsx"),
    "utf8"
  );

  assert.match(
    source,
    /const resolvedFullscreenHeaderMode = fullscreenHeaderMode \?\? "reveal";/
  );
  assert.doesNotMatch(
    source,
    /const resolvedFullscreenHeaderMode = fullscreenHeaderMode \?\? "persistent";/
  );
});

test("fullscreen reveal header hover zone stays compact", () => {
  const source = readFileSync(resolve("src/styles/workbench.css"), "utf8");

  assert.match(
    source,
    /\.workbench-window__header-reveal-zone\s*\{[^}]*height:\s*8px;/
  );
  assert.doesNotMatch(
    source,
    /\.workbench-window__header-reveal-zone\s*\{[^}]*height:\s*12px;/
  );
  assert.match(
    source,
    /\.workbench-window\[data-display-mode="fullscreen"\]:has\(\s*\.workbench-window__header-reveal-zone:hover\s*\)\s*\.workbench-window__header\s*\{[^}]*opacity\s+0\.16s\s+ease\s+0\.5s,[^}]*transform\s+0\.2s\s+cubic-bezier\(0\.4,\s*0,\s*0\.2,\s*1\)\s+0\.5s;/
  );
});

test("fullscreen toggle releases button focus when entering fullscreen", () => {
  const source = readFileSync(
    resolve("src/react/WorkbenchWindowFullscreenToggle.tsx"),
    "utf8"
  );

  assert.match(source, /onClick=\{\(event\) =>/);
  assert.match(
    source,
    /event\.currentTarget\.blur\(\);[\s\S]*controller\.commands\.enterFullscreen\(node\.id\);/
  );
});

test("layout selection chrome uses shared accent and stationary check tokens", () => {
  const source = readFileSync(
    resolve("src/react/WorkbenchWindowFrame.tsx"),
    "utf8"
  );

  assert.match(source, /border-2 border-\[var\(--accent\)\]/);
  assert.match(source, /data-\[state=checked\]:border-\[var\(--accent\)\]/);
  assert.match(source, /data-\[state=checked\]:bg-\[var\(--accent\)\]/);
  assert.match(source, /text-\[var\(--white-stationary\)\]/);
  assert.doesNotMatch(source, /border-2 border-\[var\(--border-focus\)\]/);
});
