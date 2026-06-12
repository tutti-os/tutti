import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(
  resolve("src/react/useWorkbenchGenieAnimation.tsx"),
  "utf8"
);

test("genie anchors keep usable rects while minimized dock slots animate", () => {
  assert.match(source, /const dockAnchorFallbackSizePx = 43\.2;/);
  assert.match(source, /function resolveDockAnchorViewportRect/);
  assert.match(source, /element\.dataset\.desktopDockSlot !== "true"/);
  assert.match(source, /element\.dataset\.nodeState !== "minimized"/);
  assert.match(source, /element\.dataset\.presence === "entering"/);
  assert.match(source, /element\.dataset\.collapsing === "true"/);
  assert.match(
    source,
    /height: rect\.height >= minimumUsableSize \? rect\.height : fallbackSize/
  );
  assert.match(
    source,
    /width: rect\.width >= minimumUsableSize \? rect\.width : fallbackSize/
  );
  assert.match(source, /resolveDockAnchorViewportRect\(element\)/);
  assert.match(source, /shouldAnimateMinimizedDockEnter/);
  assert.match(source, /registerMinimizedDockEnterAnimation\(nodeID\)/);
});

test("genie dock launch does not synchronously flush missing nodes", () => {
  assert.match(source, /if \(!target\) \{/);
  assert.match(
    source,
    /if \(!target\) \{\s*void Promise\.resolve\(launch\(\)\)\.catch\(\(\) => \{\}\);\s*return;\s*\}/
  );
  assert.doesNotMatch(
    source,
    /const shouldAnimate = target\?\.isMinimized === true \|\| !target;/
  );
});
