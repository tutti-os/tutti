import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve("src/host/WorkbenchHostDock.tsx"), "utf8");

test("dock hover panels survive pointer travel from slot to panel", () => {
  assert.match(source, /TooltipTrigger asChild/);
  assert.equal(source.match(/<TooltipTrigger asChild>/g)?.length, 3);
  assert.equal(
    source.match(/sideOffset=\{DOCK_MAGNIFIED_TOOLTIP_SIDE_OFFSET\}/g)?.length,
    3
  );
  assert.match(source, /title=\{entry\.label\}/);
  assert.match(source, /title=\{i18n\.t\("minimizedWindows"\)\}/);
  assert.match(source, /title=\{node\.title\}/);
  assert.match(source, /const dockHoverPanelOpenDelayMs = 450;/);
  assert.match(source, /const dockHoverPanelCloseDelayMs = 160;/);
  assert.match(source, /const dockHoverPanelBridgeSlopPx = 6;/);
  assert.match(source, /const dockHoverPanelPointerRestTolerancePx = 4;/);
  assert.match(source, /const hoverPanelCloseTimerRef = useRef/);
  assert.match(source, /const hoverPanelScheduledPointRef = useRef/);
  assert.match(source, /const closeHoverPanelImmediate = useCallback/);
  assert.match(source, /const scheduleHoverPanelClose = useCallback/);
  assert.match(source, /data-dock-hover-panel-open/);
  assert.match(source, /function dockEntryHasHoverPanel/);
  assert.match(
    source,
    /Boolean\(entry\.state\?\.reason\?\.trim\(\)\)[\s\S]*?\(entry\.hoverActions\?\.length \?\? 0\) > 0/
  );
  assert.match(source, /resetMagnification: resetDockMagnification/);
  assert.match(source, /pauseMagnification: pauseDockMagnification/);
  assert.match(source, /pauseDockMagnification\(\);/);
  assert.match(
    source,
    /onPointerEnter=\{\(\) => \{[\s\S]*?if \(hasHoverPanel\) \{[\s\S]*?scheduleHoverPanelAfterRest\(entry\.id, anchorKey\);/
  );
  assert.match(source, /onPointerMoveCapture=/);
  assert.match(
    source,
    /handleDockPointerTravel\(event\.clientX, event\.clientY\)/
  );
  assert.match(source, /data-dock-hover-panel-entry-id=/);
  assert.match(source, /const resolveHoverPanelTargetAtPoint = useCallback/);
  assert.match(source, /slotElement\.dataset\.dockHoverPanelEntryId/);
  assert.match(
    source,
    /const scheduleHoverPanelAtPointAfterRest = useCallback/
  );
  assert.match(
    source,
    /hoverPanelOpenTimerRef\.current !== null[\s\S]*?dockHoverPanelPointerRestTolerancePx[\s\S]*?return;/
  );
  assert.match(
    source,
    /const isPointerInsideActiveHoverPanelRegion = useCallback/
  );
  assert.match(source, /rectContainsPoint\(\s*anchorRect,/);
  assert.match(source, /rectContainsPoint\(\s*panelRect,/);
  assert.match(source, /createHoverPanelBridgeRect\(anchorRect, panelRect\)/);
  assert.match(
    source,
    /handleDockPointerMove\(clientX, clientY\);\s*scheduleHoverPanelAtPointAfterRest\(clientX, clientY\);/
  );
  assert.match(
    source,
    /dockMeasureRef\.current\?\.contains\(relatedTarget\)[\s\S]*?scheduleHoverPanelAtPointAfterRest\(\s*event\.clientX,\s*event\.clientY,?\s*\);[\s\S]*?return;/
  );
  assert.match(source, /beginDockIconInteraction\(anchorKey\)/);
  const beginDockIconInteractionSource =
    source.match(
      /const beginDockIconInteraction = useCallback\(\s*\(anchorKey: string\) => \{([\s\S]*?)\n {4}\},/
    )?.[1] ?? "";
  assert.notEqual(beginDockIconInteractionSource, "");
  assert.match(
    beginDockIconInteractionSource,
    /triggerDockBounce\(anchorKey\);/
  );
  assert.doesNotMatch(beginDockIconInteractionSource, /pauseDockMagnification/);
  assert.doesNotMatch(beginDockIconInteractionSource, /resetDockMagnification/);
  assert.match(source, /const beginDockMinimizedInteraction = useCallback/);
  assert.match(source, /beginDockMinimizedInteraction\(\);/);
  assert.match(source, /beginDockMinimizedInteraction\(slot\.anchorKey\);/);
  assert.match(
    source,
    /const beginDockMinimizedInteraction = useCallback\([\s\S]*?pauseDockMagnification\(\);[\s\S]*?clearSlotMagnification\(anchorKey\);/
  );
  assert.match(
    source,
    /function isDockVisualMutationActive[\s\S]*?data-stack-dispatching="true"[\s\S]*?data-promoted-from-stack="true"/
  );
  assert.match(source, /function resolveNextDockItemPresence/);
  assert.match(source, /shouldAnimateMinimizedDockEnter/);
  assert.match(source, /const shouldAnimateMinimizedDockEnterRef = useRef/);
  assert.match(source, /shouldAnimateMinimizedDockEnterRef\.current/);
  assert.doesNotMatch(
    source,
    /\}, \[itemKeys, shouldAnimateMinimizedDockEnter\]\);/
  );
  assert.match(source, /useMinimizedDockStackPromotion\(minimizedDockSlots\)/);
  assert.match(source, /data-stack-dispatching=\{/);
  assert.match(source, /data-promoted-from-stack=\{/);
  assert.match(source, /--desktop-dock-collapse-inline-size/);
  assert.match(source, /--desktop-dock-collapse-block-size/);
  assert.match(source, /slotElement\.dataset\.collapsing = "true";/);
  assert.match(
    source,
    /const runDockMinimizedLaunchAfterCollapse = useCallback/
  );
  assert.match(
    source,
    /const runDockMinimizedLaunchAfterCollapse = useCallback\([\s\S]*?beginDockMinimizedInteraction\(anchorKey\);[\s\S]*?scheduleCollapsingMinimizedLaunchClear\(anchorKey\);[\s\S]*?launch\(\);/
  );
  assert.match(source, /collapsingMinimizedLaunchAnchorKeys/);
  assert.match(source, /minimizedDockSlotLayoutAnimationMs = 720;/);
  assert.doesNotMatch(source, /dockMinimizedSlotCollapseLaunchDelayMs/);
  assert.doesNotMatch(
    source,
    /desktop-dock__minimized-btn[\s\S]{0,260}?beginDockIconInteraction/
  );
  assert.doesNotMatch(source, /resumeMagnificationAfterIconClick/);
  assert.doesNotMatch(source, /magnifySuspendedRef/);
  assert.doesNotMatch(source, /dockClickMagnifyResumeDelayMs/);
  assert.doesNotMatch(
    source,
    /const beginDockIconInteraction = useCallback\([\s\S]*?handleDockPointerLeave\(\);[\s\S]*?\n {2}\);\n\n {2}const handleDockPointerTravel/
  );
  assert.match(
    source,
    /if \(activeHoverPanelRef\.current !== null\) \{[\s\S]*?isPointerInsideActiveHoverPanelRegion\(clientX, clientY\)[\s\S]*?clearHoverPanelCloseTimer\(\);[\s\S]*?return;[\s\S]*?scheduleHoverPanelClose\(activeHoverPanelRef\.current\.entryId\);[\s\S]*?handleDockPointerLeave\(\);/
  );
  assert.match(source, /setAttribute\("data-bouncing", "true"\)/);
  assert.doesNotMatch(source, /bouncingAnchorKeys/);
  assert.match(source, /onPointerEnter=\{clearHoverPanelCloseTimer\}/);
  assert.match(source, /hoverPanelRef\.current\?\.contains\(relatedTarget\)/);
  assert.match(
    source,
    /onPointerLeave=\{\(event\) => \{[\s\S]*?scheduleHoverPanelClose\(activeHoverPanel\.entryId\);/
  );
  assert.match(source, /function rectContainsPoint/);
  assert.match(source, /function createHoverPanelBridgeRect/);
  assert.doesNotMatch(source, /\[dock-hover\]/);
  assert.doesNotMatch(
    source,
    /addEventListener\("pointermove", handleWindowPointerMove/
  );
});

test("dock slot refs are stable across renders", () => {
  assert.match(source, /const dockSlotRefCallbacksRef = useRef/);
  assert.match(source, /dockSlotRefCallbacksRef\.current\.get\(anchorKey\)/);
  assert.match(
    source,
    /dockSlotRefCallbacksRef\.current\.set\(anchorKey, callback\)/
  );
  assert.match(source, /clearSlotMagnificationRef\.current\(anchorKey\)/);
  assert.match(source, /registerDockAnchorRef\.current\(anchorKey, element\)/);
  assert.doesNotMatch(
    source,
    /const registerDockSlot =\s*\(anchorKey: string\) => \(element: HTMLElement \| null\) =>/
  );
});

test("multi-window popup only uses explicit preview providers", () => {
  assert.match(source, /providePopupItemPreview/);
  assert.match(source, /popupEntry\.entry\.capturePopupItemPreview/);
  assert.doesNotMatch(source, /captureNodePreviewImage\?\.\(item\.node\)/);
  assert.match(source, /descriptor\.revision/);
});

test("multi-window popup remains visible while preview capture is pending", () => {
  assert.doesNotMatch(source, /hideDuringPreviewCapture/);
  assert.doesNotMatch(source, /captureDockPopupVisibleWindowPreview/);
});

test("dock presence animation callback does not retrigger the presence effect", () => {
  assert.match(source, /const shouldAnimateMinimizedDockEnterRef = useRef/);
  assert.match(
    source,
    /shouldAnimateMinimizedDockEnterRef\.current = shouldAnimateMinimizedDockEnter/
  );
  assert.match(source, /shouldAnimateMinimizedDockEnterRef\.current/);
  assert.match(source, /\}, \[itemKeys\]\);/);
  assert.doesNotMatch(
    source,
    /\}, \[itemKeys, shouldAnimateMinimizedDockEnter\]\);/
  );
});

test("dock new window launch returns the created node id to the genie boundary", () => {
  assert.match(
    source,
    /context\.genie\.launchNodeFromAnchor\(\s*anchorKey,\s*entry\.id,\s*\(\) =>\s*host\.launchNode\(\{/
  );
  assert.match(
    source,
    /context\.genie\.launchNodeFromAnchor\(\s*anchorKeyFromPopupEntry\(popupEntry\),\s*popupEntry\.entry\.id,\s*\(\) =>\s*host\.launchNode\(\{/
  );
});
