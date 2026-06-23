import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(
  resolve("src/react/useWorkbenchGenieAnimation.tsx"),
  "utf8"
);
const genieAnimationSource = readFileSync(
  resolve("src/react/genieAnimation.ts"),
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

test("genie minimize foregrounds the target before preview capture", () => {
  assert.match(source, /function isFocusedWorkbenchNode/);
  assert.match(
    source,
    /controller\.commands\.focusNode\(nodeID\);\s*\}\);\s*await waitForNextAnimationFrame\(\);/
  );
  assert.match(
    source,
    /const previewImageUrlPromise = Promise\.resolve\(\s*captureNodePreviewImage\?\.\(target\) \?\? null\s*\)/
  );
});

test("genie texture capture clones only meaningful visible DOM", () => {
  assert.match(source, /cloneMeaningfulGenieElement\(element, windowRect\)/);
  assert.doesNotMatch(source, /element\.cloneNode\(true\)/);
});

test("genie scanline rendering maps strip edges to avoid horizontal seams", () => {
  assert.match(genieAnimationSource, /function resolveGenieRowTargetY/);
  assert.match(
    genieAnimationSource,
    /const targetTop = resolveGenieRowTargetY/
  );
  assert.match(
    genieAnimationSource,
    /const targetBottom = resolveGenieRowTargetY/
  );
  assert.match(
    genieAnimationSource,
    /const targetHeight = Math\.max\(1, Math\.abs\(targetBottom - targetTop\) \+ 1\)/
  );
});
