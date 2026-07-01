import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve("src/host/WorkbenchHostDock.tsx"), "utf8");

test("dock action callbacks contain synchronous and async failures", () => {
  assert.doesNotMatch(source, /Promise\.resolve\(\s*onDockEntryAction\?\.\(/);
  assert.doesNotMatch(source, /Promise\.resolve\(\s*onDockEntryClick\?\.\(/);
  assert.match(
    source,
    /const runDockEntryAction = useCallback\([\s\S]*?try \{[\s\S]*?await onDockEntryAction\?\.\([\s\S]*?catch \{[\s\S]*?Keep dock action failures contained\.[\s\S]*?finally \{[\s\S]*?setPendingActionKeys/
  );
});

test("dock hover labels use local non-blocking tooltips", () => {
  assert.doesNotMatch(source, /TooltipProvider/);
  assert.doesNotMatch(source, /TooltipTrigger/);
  assert.doesNotMatch(source, /TooltipContent/);
  assert.doesNotMatch(source, /DOCK_MAGNIFIED_TOOLTIP_SIDE_OFFSET/);
  assert.doesNotMatch(source, /title=\{entry\.label\}/);
  assert.doesNotMatch(source, /title=\{i18n\.t\("minimizedWindows"\)\}/);
  assert.doesNotMatch(source, /title=\{node\.title\}/);
  assert.match(source, /const dockHoverPanelOpenDelayMs = 120;/);
  assert.match(source, /const dockHoverPanelCloseDelayMs = 160;/);
  assert.match(source, /const dockHoverPanelBridgeSlopPx = 6;/);
  assert.match(source, /const dockHoverPanelPointerRestTolerancePx = 4;/);
  assert.match(source, /const hoverPanelCloseTimerRef = useRef/);
  assert.match(source, /const labelTooltipOpenTimerRef = useRef/);
  assert.match(source, /const hoverPanelScheduledPointRef = useRef/);
  assert.match(source, /const labelTooltipScheduledPointRef = useRef/);
  assert.match(source, /const closeHoverPanelImmediate = useCallback/);
  assert.match(source, /const closeLabelTooltipImmediate = useCallback/);
  assert.match(source, /const scheduleHoverPanelClose = useCallback/);
  assert.match(source, /const scheduleLabelTooltipAfterRest = useCallback/);
  assert.match(
    source,
    /const scheduleLabelTooltipAtPointAfterRest = useCallback/
  );
  assert.match(source, /data-dock-hover-panel-open/);
  assert.match(source, /data-dock-label-tooltip-key=/);
  assert.match(source, /data-dock-label-tooltip-label=/);
  assert.match(source, /desktop-dock__label-tooltip/);
  assert.match(source, /function dockLabelTooltipTarget/);
  assert.match(source, /function resolveDockLabelTooltipAnchorRect/);
  assert.match(source, /DOCK_ICON_BASE_SIZE/);
  assert.match(
    source,
    /left: slotRect\.left \+ \(slotRect\.width - DOCK_ICON_BASE_SIZE\) \/ 2/
  );
  assert.match(
    source,
    /top: slotRect\.top \+ \(slotRect\.height - DOCK_ICON_BASE_SIZE\) \/ 2/
  );
  assert.match(source, /function WorkbenchHostDockLabelTooltip/);
  assert.match(source, /function dockEntryHasHoverPanel/);
  assert.match(
    source,
    /Boolean\(entry\.state\?\.reason\?\.trim\(\)\)[\s\S]*?\(entry\.hoverActions\?\.length \?\? 0\) > 0/
  );
  assert.match(source, /resetMagnification: resetDockMagnification/);
  assert.match(source, /pauseMagnification: pauseDockMagnification/);
  assert.match(source, /pauseDockMagnification\(\);/);
  const showLabelTooltipSource =
    source.match(
      /const showLabelTooltip = useCallback\(\s*\([\s\S]*?\n {4}\},/
    )?.[0] ?? "";
  assert.notEqual(showLabelTooltipSource, "");
  assert.match(
    showLabelTooltipSource,
    /resolveDockLabelTooltipAnchorRect\(\{\s*dockPlacement,\s*slotElement: anchorElement\s*\}\)/
  );
  assert.doesNotMatch(showLabelTooltipSource, /querySelector/);
  assert.doesNotMatch(showLabelTooltipSource, /pauseDockMagnification/);
  assert.doesNotMatch(showLabelTooltipSource, /setDockHoverPanelOpen/);
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
  assert.match(source, /data-dock-hover-panel-trigger=/);
  assert.match(
    source,
    /data-dock-hover-panel-trigger=\{\s*hasHoverPanel \? "true" : undefined\s*\}/
  );
  assert.match(source, /const resolveHoverPanelTargetAtPoint = useCallback/);
  assert.match(source, /slotElement\.dataset\.dockHoverPanelEntryId/);
  assert.match(
    source,
    /const scheduleHoverPanelAtPointAfterRest = useCallback/
  );
  assert.match(
    source,
    /const scheduleLabelTooltipAtPointAfterRest = useCallback\([\s\S]*?activeLabelTooltipRef\.current !== null[\s\S]*?return;/
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
    /handleDockPointerMove\(clientX, clientY\);\s*scheduleHoverPanelAtPointAfterRest\(clientX, clientY\);\s*scheduleLabelTooltipAtPointAfterRest\(clientX, clientY\);/
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
  assert.doesNotMatch(
    source,
    /beginDockMinimizedInteraction\(restoreIntent\.anchorKey\);/
  );
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
    /const runDockMinimizedLaunchAfterCollapse = useCallback\([\s\S]*?intent: WorkbenchMinimizedDockNodeSlotRestoreIntent[\s\S]*?const \{ anchorKey \} = intent;[\s\S]*?beginDockMinimizedInteraction\(anchorKey\);[\s\S]*?scheduleCollapsingMinimizedLaunchClear\(anchorKey\);[\s\S]*?launch\(intent\);/
  );
  assert.match(source, /const runDockMinimizedStackLaunch = useCallback/);
  assert.match(
    source,
    /const runDockMinimizedStackLaunch = useCallback\([\s\S]*?intent: WorkbenchMinimizedDockStackPopupCardRestoreIntent[\s\S]*?beginDockMinimizedInteraction\(\);[\s\S]*?launch\(intent\);/
  );
  assert.match(source, /resolveWorkbenchMinimizedDockRestoreIntent/);
  assert.match(source, /if \(restoreIntent\?\.kind !== "node-slot"\)/);
  assert.match(source, /if \(restoreIntent\?\.kind !== "stack-popup-card"\)/);
  assert.match(
    source,
    /stackAnchorKey: activeMinimizedStackSlot\.anchorKey[\s\S]*?runDockMinimizedStackLaunch\(restoreIntent, \(intent\) => \{[\s\S]*?context\.genie\.launchNodeFromAnchor\(\s*intent\.anchorKey,\s*intent\.nodeId,/
  );
  assert.doesNotMatch(
    source,
    /stackAnchorKey: activeMinimizedStackSlot\.anchorKey[\s\S]*?runDockMinimizedLaunchAfterCollapse\(restoreIntent/
  );
  assert.match(source, /collapsingMinimizedLaunchAnchorKeys/);
  assert.match(source, /slotElement\?\.removeAttribute\("data-collapsing"\)/);
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

test("pending minimized dock slots reuse minimized layout without preview capture", () => {
  assert.match(source, /nodes: context\.minimizedNodes/);
  assert.doesNotMatch(
    source,
    /resolveWorkbenchMinimizedDockSlots\(\{[\s\S]*nodes: context\.nodes/
  );
  assert.match(
    source,
    /context\.genie\.isPendingMinimizedDockNode\(node\.id\)/
  );
  assert.match(
    source,
    /if \(context\.genie\.isPendingMinimizedDockNode\(node\.id\)\) \{\s*return false;/
  );
  assert.match(
    source,
    /aria-disabled=\{isPendingMinimizedNode \? true : undefined\}/
  );
  assert.match(source, /tabIndex=\{isPendingMinimizedNode \? -1 : 0\}/);
  assert.match(source, /data-pending-minimize=/);
  assert.match(
    source,
    /capturePreview=\{\s*isPendingMinimizedNode\s*\?\s*undefined\s*:\s*captureMinimizedNodePreview\s*\}/
  );
  assert.match(source, /deferPreview=\{isPendingMinimizedNode\}/);
  assert.match(
    source,
    /dockPreviewCache=\{\s*isPendingMinimizedNode \? undefined : dockPreviewCache\s*\}/
  );
  assert.match(
    source,
    /providePreview=\{\s*isPendingMinimizedNode\s*\?\s*undefined\s*:\s*provideMinimizedNodePreviewForNode\(node\)\s*\}/
  );
});

test("component minimized dock previews freeze without snapshot capture", () => {
  assert.match(source, /const provideMinimizedNodePreview = useCallback/);
  assert.match(
    source,
    /if \(minimizedDock\?\.kind !== "component"\) \{\s*return null;\s*\}/
  );
  assert.match(
    source,
    /const provideMinimizedNodePreviewForNode = useCallback/
  );
  assert.match(
    source,
    /return minimizedDock\?\.kind === "component"\s*\?\s*provideMinimizedNodePreview\s*:\s*undefined;/
  );
  assert.match(
    source,
    /providePreview=\{provideMinimizedNodePreviewForNode\(\s*node\s*\)\}/
  );
  assert.match(
    source,
    /const \[componentPreview, setComponentPreview\] = useState<\s*WorkbenchDockPreviewContent \| null \| undefined\s*>\(undefined\);/
  );
  assert.match(source, /deferPreview=\{isPendingMinimizedNode\}/);
  assert.match(
    source,
    /if \(deferPreview \|\| !providePreview \|\| componentPreview !== undefined\) \{\s*return undefined;\s*\}/
  );
  assert.match(
    source,
    /setComponentPreview\(providePreview\(node\) \?\? null\);/
  );
  assert.match(source, /requestIdleCallback/);
  assert.match(
    source,
    /if \(deferPreview \|\| providePreview\) \{\s*return undefined;\s*\}/
  );
  assert.match(
    source,
    /minimizedDock\?\.kind === "snapshot" &&\s*Boolean\(minimizedDock\.capturePreview\)/
  );
  assert.match(
    source,
    /capturePreview=\{\s*isPendingMinimizedNode\s*\?\s*undefined\s*:\s*captureMinimizedNodePreview\s*\}/
  );
  assert.match(source, /renderMinimizedDockPreviewContent/);
  assert.match(source, /WorkbenchHostDockFrozenComponentPreview/);
  assert.match(source, /sourceRef\.current\?\.innerHTML/);
  assert.match(
    source,
    /dangerouslySetInnerHTML=\{\{ __html: frozenMarkup \}\}/
  );
  assert.match(source, /desktop-dock__minimized-preview--component/);
  assert.match(source, /minimizedDockPreviewFreezeKey\(node\)/);
});

test("minimized dock activators allow interactive preview markup", () => {
  const stackActivatorStart = source.indexOf("const stackButton = (");
  const stackActivatorEnd = source.indexOf(
    "return (\n                  <span",
    stackActivatorStart
  );
  const nodeActivatorStart = source.indexOf(
    "const dockButton = (",
    source.indexOf("const node = slot.node;")
  );
  const nodeActivatorEnd = source.indexOf(
    "return (\n                <span",
    nodeActivatorStart
  );
  assert.notEqual(stackActivatorStart, -1);
  assert.notEqual(stackActivatorEnd, -1);
  assert.notEqual(nodeActivatorStart, -1);
  assert.notEqual(nodeActivatorEnd, -1);
  const minimizedActivatorSource = [
    source.slice(stackActivatorStart, stackActivatorEnd),
    source.slice(nodeActivatorStart, nodeActivatorEnd)
  ].join("\n");

  assert.match(source, /function activateDockButtonFromKeyboard/);
  assert.match(source, /event\.key !== "Enter" && event\.key !== " "/);
  assert.match(source, /event\.currentTarget\.click\(\);/);
  assert.doesNotMatch(minimizedActivatorSource, /<button/);
  assert.match(
    minimizedActivatorSource,
    /className="desktop-dock__btn desktop-dock__minimized-btn"[\s\S]*?role="button"[\s\S]*?tabIndex=\{0\}[\s\S]*?onKeyDown=\{activateDockButtonFromKeyboard\}/
  );
  assert.match(
    minimizedActivatorSource,
    /className="desktop-dock__btn desktop-dock__minimized-btn"[\s\S]*?role="button"[\s\S]*?tabIndex=\{isPendingMinimizedNode \? -1 : 0\}[\s\S]*?activateDockButtonFromKeyboard\([\s\S]*?event,[\s\S]*?isPendingMinimizedNode/
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

test("dock entry context menu opens the command menu", () => {
  assert.match(source, /onContextMenu=\{\(event\) => \{/);
  assert.match(
    source,
    /clickResolution\.kind === "blocked" \|\|[\s\S]*?!dockEntryHasContextMenu\(entry, resolvedEntry\)/
  );
  assert.match(source, /"dock\.popup\.context_menu"/);
  assert.match(
    source,
    /setActivePopup\(\{\s*anchorRect: \{\s*height: rect\.height,\s*left: rect\.left,\s*top: rect\.top,\s*width: rect\.width\s*\},\s*kind: "context-menu",\s*entryId: entry\.id\s*\}\);/
  );
});

test("dock action-only entries do not open a context menu", () => {
  assert.match(source, /function dockEntryHasContextMenu/);
  assert.match(
    source,
    /resolvedEntry\.matchedNodes\.length > 0 \|\| entry\.dockRetention/
  );
  assert.match(source, /return entry\.clickActionId === undefined;/);
});

test("dock context menu exposes window and app commands", () => {
  assert.match(source, /canShowAllWindowsFromDockContextMenu/);
  assert.match(source, /const dockContextMenuInstanceMode =/);
  assert.match(
    source,
    /canShowAllWindowsFromDockContextMenu =[\s\S]*?onMissionControlRequestOpen !== undefined &&[\s\S]*?dockContextMenuInstanceMode === "multi" &&[\s\S]*?openDockContextMenuNodeIds\.length > 1;/
  );
  assert.match(
    source,
    /for \(const node of popupEntry\.matchedNodes\) \{[\s\S]*?if \(minimizedNodeIDs\.has\(node\.id\)\) \{[\s\S]*?context\.controller\.commands\.restoreNode\(node\.id\);/
  );
  assert.match(
    source,
    /window\.requestAnimationFrame\(\(\) => \{[\s\S]*?onMissionControlRequestOpen\?\.\(\s*"activate",\s*\{[\s\S]*?nodeIds: openDockContextMenuNodeIds,[\s\S]*?trigger: "dock-context-menu"/
  );
  assert.match(source, /openDockContextMenuNodeIds/);
  assert.match(
    source,
    /const openDockContextMenuNodeIds =\s*popupEntry\?\.matchedNodes\.map\(\(node\) => node\.id\) \?\? \[\];/
  );
  assert.match(source, /host\.minimizeNode\(node\.id\);/);
  assert.match(source, /host\.requestNodeClose\(node\.id\);/);
  assert.match(source, /resolveDockContextMenuFullscreenNode/);
  assert.match(source, /context\.controller\.commands\.enterFullscreen/);
  assert.match(source, /dockContextMenu\.fullscreen/);
  assert.match(source, /canOpenFromDockContextMenu/);
  assert.match(source, /dockContextMenu\.open/);
  assert.match(source, /popupEntry\.entry\.dockRetention/);
  assert.match(source, /dockContextMenu\.keepInDock/);
  assert.match(source, /dockContextMenu\.removeFromDock/);
});

test("dock entry clicks within the bounce window are throttled like a single click", () => {
  assert.match(source, /const DOCK_ENTRY_CLICK_THROTTLE_MS = DOCK_BOUNCE_MS;/);
  assert.match(
    source,
    /const dockEntryClickThrottleUntilRef = useRef\(new Map<string, number>\(\)\);/
  );
  assert.match(
    source,
    /const isDockEntryClickThrottled = useCallback\(\s*\(anchorKey: string\): boolean => \{\s*const throttledUntil =\s*dockEntryClickThrottleUntilRef\.current\.get\(anchorKey\);\s*return throttledUntil !== undefined && Date\.now\(\) < throttledUntil;/
  );
  assert.match(
    source,
    /const claimDockEntryClick = useCallback\(\(anchorKey: string\): void => \{\s*dockEntryClickThrottleUntilRef\.current\.set\(\s*anchorKey,\s*Date\.now\(\) \+ DOCK_ENTRY_CLICK_THROTTLE_MS\s*\);/
  );
  assert.match(
    source,
    /onPointerDown=\{\(event\) => \{\s*if \(event\.button !== 0\) \{\s*return;\s*\}\s*if \(clickResolution\.kind === "blocked"\) \{\s*return;\s*\}\s*if \(isDockEntryClickThrottled\(anchorKey\)\) \{\s*return;\s*\}\s*beginDockIconInteraction\(anchorKey\);\s*\}\}/
  );
  assert.match(
    source,
    /onClick=\{\(event\) => \{\s*if \(clickResolution\.kind === "blocked"\) \{\s*return;\s*\}\s*if \(isDockEntryClickThrottled\(anchorKey\)\) \{\s*return;\s*\}\s*claimDockEntryClick\(anchorKey\);\s*logWorkbenchDockDebug\("dock\.click",/
  );
});

test("dock chrome samples wallpaper luminance for contrast", () => {
  assert.match(source, /useDockWallpaperTones/);
  assert.match(source, /data-wallpaper-tone=\{wallpaperTones\.get/);
  assert.match(
    source,
    /desktop-dock__slot desktop-dock__slot--minimized[\s\S]*?data-wallpaper-tone=\{wallpaperTones\.get\(slot\.anchorKey\)\}/
  );
  assert.match(source, /wallpaperToneElementRefs\.current\.set/);
  assert.ok(source.includes('querySelector(".workbench-surface__wallpaper")'));
  assert.match(source, /getImageData/);
  assert.match(source, /dockWallpaperDarkLuminanceThreshold/);
});
