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

  assert.match(source, /onClick:\s*\(event\) =>/);
  assert.match(
    source,
    /event\.currentTarget\.blur\(\);[\s\S]*controller\.commands\.enterFullscreen\(node\.id\);/
  );
});

test("window controls use left-aligned traffic lights", () => {
  const frameSource = readFileSync(
    resolve("src/react/WorkbenchWindowFrame.tsx"),
    "utf8"
  );
  const fullscreenSource = readFileSync(
    resolve("src/react/WorkbenchWindowFullscreenToggle.tsx"),
    "utf8"
  );
  const hostActionsSource = readFileSync(
    resolve("src/host/WorkbenchHostWindowActions.tsx"),
    "utf8"
  );
  const styleSource = readFileSync(resolve("src/styles/workbench.css"), "utf8");

  assert.match(
    frameSource,
    /className="workbench-window__traffic-light-actions"/
  );
  assert.match(
    frameSource,
    /\{defaultActions\}[\s\S]*<div className="workbench-window__title">/
  );
  assert.match(hostActionsSource, /<WorkbenchWindowTrafficLights[\s\S]*close=/);
  assert.match(
    hostActionsSource,
    /<WorkbenchWindowTrafficLights[\s\S]*minimize=/
  );
  assert.match(
    fullscreenSource,
    /<WorkbenchWindowTrafficLights[\s\S]*maximize=/
  );
  assert.match(
    styleSource,
    /\.workbench-window__header\s*\{[\s\S]*justify-content:\s*flex-start;[\s\S]*padding:\s*0 12px 0 16px;/s
  );
  assert.match(
    styleSource,
    /\.workbench-window__title\s*\{[\s\S]*font-size:\s*15px;[\s\S]*font-weight:\s*600;[\s\S]*line-height:\s*20px;/s
  );
  assert.match(
    styleSource,
    /\.workbench-window-traffic-light::before\s*\{[\s\S]*inset:\s*4px;/s
  );
  const trafficLightsSource = readFileSync(
    resolve("src/react/WorkbenchWindowTrafficLights.tsx"),
    "utf8"
  );
  assert.match(
    trafficLightsSource,
    /<TooltipProvider delayDuration=\{250\} skipDelayDuration=\{0\}>[\s\S]*<TooltipTrigger asChild>\{button\}<\/TooltipTrigger>[\s\S]*<TooltipContent side="bottom">\{input\.label\}<\/TooltipContent>/
  );
  assert.match(
    trafficLightsSource,
    /const iconName =[\s\S]*tone === "maximize"[\s\S]*input\.pressed[\s\S]*"unfullscreen"[\s\S]*"fullscreen"[\s\S]*: tone;/
  );
  assert.match(
    trafficLightsSource,
    /<WindowTrafficLightIcon[\s\S]*className="workbench-window-traffic-light__icon"[\s\S]*data-workbench-traffic-light-icon=\{iconName\}[\s\S]*iconName=\{iconName\}/
  );
});

test("custom headers can opt out of the window header divider", () => {
  const styleSource = readFileSync(resolve("src/styles/workbench.css"), "utf8");

  assert.match(
    styleSource,
    /\.workbench-window__header--custom:has\(\s*\[data-workbench-custom-header-border="none"\]\s*\)\s*\{[\s\S]*border-bottom-color:\s*transparent;/s
  );
});

test("corner resize handles render outside the clipped window surface", () => {
  const frameSource = readFileSync(
    resolve("src/react/WorkbenchWindowFrame.tsx"),
    "utf8"
  );
  const styleSource = readFileSync(resolve("src/styles/workbench.css"), "utf8");

  assert.match(
    frameSource,
    /<div className="workbench-window__body">\{children\}<\/div>\s*<\/div>\s*\{node\.displayMode === "floating"/
  );
  assert.match(
    styleSource,
    /\.workbench-window__resize-handle\[data-handle="north-east"\]\s*\{[\s\S]*top:\s*-8px;[\s\S]*right:\s*-8px;[\s\S]*width:\s*24px;[\s\S]*height:\s*24px;[\s\S]*cursor:\s*nesw-resize;/s
  );
  assert.match(
    styleSource,
    /\.workbench-window__resize-handle\[data-handle="north-west"\]\s*\{[\s\S]*top:\s*-12px;[\s\S]*left:\s*-12px;[\s\S]*cursor:\s*nwse-resize;/s
  );
  assert.match(
    styleSource,
    /\.workbench-window__resize-handle\[data-handle="south-east"\]\s*\{[\s\S]*right:\s*-12px;[\s\S]*bottom:\s*-12px;[\s\S]*cursor:\s*nwse-resize;/s
  );
  assert.match(
    styleSource,
    /\.workbench-window__resize-handle\[data-handle="south-west"\]\s*\{[\s\S]*bottom:\s*-12px;[\s\S]*left:\s*-12px;[\s\S]*cursor:\s*nesw-resize;/s
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
