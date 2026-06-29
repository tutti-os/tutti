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

test("fullscreen windows always keep their own header visible", () => {
  const source = readFileSync(
    resolve("src/react/WorkbenchWindowFrame.tsx"),
    "utf8"
  );
  const styleSource = readFileSync(resolve("src/styles/workbench.css"), "utf8");

  assert.match(
    source,
    /const resolvedFullscreenHeaderMode: WorkbenchFullscreenHeaderMode =\s*"persistent";/
  );
  assert.doesNotMatch(source, /fullscreenHeaderMode \?\? "reveal"/);
  assert.doesNotMatch(source, /workbench-window__header-reveal-zone/);
  assert.doesNotMatch(styleSource, /workbench-window__header-reveal-zone/);
  assert.doesNotMatch(
    styleSource,
    /\.workbench-window\[data-display-mode="fullscreen"\]\s+\.workbench-window__header\s*\{[^}]*opacity:\s*0;/s
  );
  assert.doesNotMatch(
    styleSource,
    /\.workbench-window\[data-display-mode="fullscreen"\]\s+\.workbench-window__body\s*\{[^}]*grid-row:\s*1;/s
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

test("layout selection chrome uses tutti purple and stationary check tokens", () => {
  const source = readFileSync(
    resolve("src/react/WorkbenchWindowFrame.tsx"),
    "utf8"
  );

  assert.match(source, /border-2 border-\[var\(--tutti-purple\)\]/);
  assert.match(
    source,
    /data-\[state=checked\]:border-\[var\(--tutti-purple\)\]/
  );
  assert.match(source, /data-\[state=checked\]:bg-\[var\(--tutti-purple\)\]/);
  assert.match(source, /text-\[var\(--white-stationary\)\]/);
  assert.doesNotMatch(source, /border-2 border-\[var\(--accent\)\]/);
  assert.doesNotMatch(source, /border-2 border-\[var\(--border-focus\)\]/);
});

test("mission control hides windows outside the presentation target set", () => {
  const source = readFileSync(
    resolve("src/react/WorkbenchWindowFrame.tsx"),
    "utf8"
  );

  assert.match(source, /const isPresentationHidden =/);
  assert.match(source, /!presentation\?\.visibleNodeIds\.has\(node\.id\)/);
  assert.match(
    source,
    /data-presentation-visibility=\{\s*isPresentationHidden \? "hidden" : "visible"\s*\}/
  );
  assert.match(
    source,
    /aria-hidden=\{hiddenMounted \|\| isPresentationHidden \? true : undefined\}/
  );
});

test("mission control presentation tracks the visible target window ids", () => {
  const stateSource = readFileSync(
    resolve("src/mission-control/useWorkbenchMissionControlState.ts"),
    "utf8"
  );
  const typeSource = readFileSync(resolve("src/react/types.ts"), "utf8");

  assert.match(typeSource, /visibleNodeIds: ReadonlySet<string>;/);
  assert.match(
    stateSource,
    /visibleNodeIds: new Set\(orderedNodes\.map\(\(node\) => node\.id\)\)/
  );
});

test("dialog popover windows render through a body-level portal", () => {
  const source = readFileSync(
    resolve("src/react/WorkbenchNodeLayer.tsx"),
    "utf8"
  );

  assert.match(source, /import \{ createPortal \} from "react-dom";/);
  assert.match(
    source,
    /resolveWindowSurfaceLayer\(\{ node \}\) === "dialog-popover"/
  );
  assert.match(
    source,
    /className="workbench-node-layer workbench-node-layer--dialog-popover"/
  );
  assert.match(source, /createPortal\(dialogPopoverLayer, document\.body\)/);
});
