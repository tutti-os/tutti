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

test("genie dock launch skips animation setup when motion is reduced or disabled", () => {
  assert.match(
    source,
    /const effectiveMinimizeAnimation = shouldReduceMotion\(\)\s*\? "off"\s*: minimizeAnimation;\s*if \(effectiveMinimizeAnimation === "off"\) \{\s*stopAnimation\(\);\s*flushSync\(\(\) => \{\s*showNodeForGenie\(nodeID\);\s*\}\);\s*void Promise\.resolve\(launch\(\)\)\.catch\(\(\) => \{\}\);\s*return;\s*\}\s*stopAnimation\(\);\s*const dockRectFallback = resolveDockAnchorRect\(anchorKey\);\s*hideNodeForGenie\(nodeID\);/
  );
});

test("genie animation remains the default minimize animation", () => {
  assert.match(source, /minimizeAnimation = "genie"/);
  assert.doesNotMatch(source, /minimizeAnimation = "scale"/);
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

test("genie texture capture only records retained image clones", () => {
  assert.match(
    genieAnimationSource,
    /if \(!includeSelf && clone\.childNodes\.length === 0\) \{\s*return null;\s*\}\s*if \(sourceElement instanceof HTMLImageElement\)/
  );
});

test("genie inline image downsampling tolerates tainted canvases", () => {
  assert.match(
    source,
    /try \{\s*context\.drawImage\(image, 0, 0, targetSize\.width, targetSize\.height\);\s*return canvas\.toDataURL\("image\/png"\);\s*\} catch \{\s*return null;\s*\}/
  );
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

test("scale and off minimize skip focus and preview capture for component previews", () => {
  assert.match(source, /shouldCaptureNodePreviewImage\?:/);
  assert.match(
    source,
    /const shouldCapturePreview =\s*shouldCaptureNodePreviewImage\?\.\(target\) \?\? true;/
  );
  assert.match(
    source,
    /if \(shouldCapturePreview\) \{\s*void captureProvidedWorkbenchNodePreviewImageForNode\(target,/
  );
  assert.match(
    source,
    /const wasFocusedForCapture =\s*shouldCapturePreview && isFocusedWorkbenchNode\(controller, nodeID\);/
  );
  assert.match(source, /if \(shouldCapturePreview && !wasFocusedForCapture\)/);
});

test("scale minimize resolves its target from a pending minimized dock slot", () => {
  assert.match(
    source,
    /const previousVisibility = nodeElement\.style\.visibility/
  );
  assert.match(source, /nodeElement\.style\.visibility = "visible"/);
  assert.match(source, /pendingMinimizedNode: WorkbenchNode<TData> \| null/);
  assert.match(source, /setPendingMinimizedNode\(pendingMinimizedNode\)/);
  assert.match(source, /resolveAnchorKeyForNode\(pendingMinimizedNode\)/);
  assert.match(
    source,
    /runScaleWindowAnimation\(\{[\s\S]*direction: "minimize"[\s\S]*skipStop: true/
  );
  assert.match(
    source,
    /onComplete: \(\) => \{[\s\S]*clearPendingMinimizedNode\(nodeID\);[\s\S]*commitMinimize\(\);/
  );
});

test("off minimize gives immediate shell feedback and defers the state commit", () => {
  assert.match(
    source,
    /flushSync\(\(\) => \{\s*hideNodeForGenie\(nodeID\);\s*setPendingMinimizedNode\(\{/
  );
  assert.doesNotMatch(source, /nodeElement\.style\.visibility = "hidden"/);
  assert.match(
    source,
    /setPendingMinimizedNode\(\{[\s\S]*isMinimized: true,[\s\S]*minimizedAtUnixMs: Date\.now\(\)[\s\S]*\}\);/
  );
  assert.match(
    source,
    /flushSync\(\(\) => \{\s*clearPendingMinimizedNode\(nodeID\);\s*showNodeForGenie\(nodeID\);\s*runMinimize\(\);/
  );
  assert.match(
    source,
    /frameID = window\.requestAnimationFrame\(\(\) => \{[\s\S]*timerID = setTimeout\(commitMinimize, 0\);/
  );
});

test("genie minimize resolves its target from a pending minimized dock slot", () => {
  assert.match(
    source,
    /const pendingMinimizedNode: WorkbenchNode<TData> = \{[\s\S]*isMinimized: true,[\s\S]*minimizedAtUnixMs: Date\.now\(\)[\s\S]*\};[\s\S]*setPendingMinimizedNode\(pendingMinimizedNode\);[\s\S]*hideNodeForGenie\(nodeID\);[\s\S]*const anchorKey = resolveAnchorKeyForNode\(pendingMinimizedNode\);[\s\S]*runGenieAnimation/
  );
});
