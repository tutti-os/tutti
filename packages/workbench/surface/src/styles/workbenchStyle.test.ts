import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("floating window bodies do not reserve a right-side content margin", () => {
  const css = readFileSync(resolve("src/styles/workbench.css"), "utf8");

  assert.doesNotMatch(
    css,
    /\.workbench-window\[data-display-mode="floating"\]\s+\.workbench-window__body\s*{[^}]*margin-right/s
  );
});

test("traffic lights keep visual layout while expanding the pointer hit area", () => {
  const css = readFileSync(resolve("src/styles/workbench.css"), "utf8");

  assert.match(
    css,
    /\.workbench-window-traffic-light\s*{[^}]*width:\s*20px;[^}]*height:\s*20px;[^}]*margin:\s*-4px;[^}]*cursor:\s*pointer;[^}]*transition:\s*opacity 160ms ease;/s
  );
  assert.match(
    css,
    /\.workbench-window-traffic-light::before\s*{[^}]*inset:\s*4px;[^}]*content:\s*"";[^}]*transition:\s*background-color 160ms ease;/s
  );
  assert.match(
    css,
    /\.workbench-window-traffic-light__icon\s*{[^}]*inset:\s*5px;[^}]*width:\s*10px;[^}]*height:\s*10px;[^}]*opacity:\s*0;[^}]*transition:\s*opacity 120ms ease;/s
  );
  assert.match(
    css,
    /\.workbench-window-traffic-lights:hover\s+\.workbench-window-traffic-light__icon,\s*\.workbench-window-traffic-lights:focus-within\s+\.workbench-window-traffic-light__icon\s*{[^}]*opacity:\s*1;/s
  );
  assert.match(
    css,
    /\.workbench-window-traffic-lights:hover\s+\.workbench-window-traffic-light\[data-workbench-traffic-light="close"\]::before,\s*\.workbench-window-traffic-lights:focus-within\s+\.workbench-window-traffic-light\[data-workbench-traffic-light="close"\]::before\s*{[^}]*background-color:\s*#ff5f57;/s
  );
});

test("floating window corner resize handles do not intrude further than the edge handles", () => {
  const css = readFileSync(resolve("src/styles/workbench.css"), "utf8");

  // Resize handles render outside `.workbench-window`, which keeps most of
  // the corner hot zone outside the clipped window while still leaving a small
  // diagonal resize target over the visible border.
  assert.match(
    css,
    /\.workbench-window__resize-handle\[data-handle="north-east"\],\s*\.workbench-window__resize-handle\[data-handle="north-west"\],\s*\.workbench-window__resize-handle\[data-handle="south-east"\],\s*\.workbench-window__resize-handle\[data-handle="south-west"\]\s*{[^}]*width:\s*16px;[^}]*height:\s*16px;/s
  );
  assert.match(
    css,
    /\.workbench-window__resize-handle\[data-handle="south-west"\]\s*{[^}]*bottom:\s*-12px;[^}]*left:\s*-12px;/s
  );
});

test("mission control hidden presentation windows are invisible and inert", () => {
  const css = readFileSync(resolve("src/styles/workbench.css"), "utf8");

  assert.match(
    css,
    /\.workbench-window-shell\[data-presentation-visibility="hidden"\]\s*{[^}]*visibility:\s*hidden;[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s
  );
});

test("mission control overlay lets layout controls sit above dialog overlays", () => {
  const css = readFileSync(resolve("src/styles/workbench.css"), "utf8");
  const source = readFileSync(
    resolve("src/mission-control/WorkbenchMissionControlOverlay.tsx"),
    "utf8"
  );

  assert.match(
    css,
    /\.workbench-mission-control\s*{[^}]*z-index:\s*var\(--z-tooltip,\s*100700\);/s
  );
  assert.match(
    source,
    /className="workbench-mission-control pointer-events-none absolute inset-0 overflow-hidden"/
  );
  assert.match(
    source,
    /className="workbench-mission-control__layout-dock desktop-dock-plate pointer-events-auto"/
  );
  assert.match(
    css,
    /\.desktop-dock-plate\.workbench-mission-control__layout-dock\s*{[^}]*pointer-events:\s*auto;/s
  );
});

test("mission control backdrop uses the shared dark scrim value", () => {
  const css = readFileSync(resolve("src/styles/workbench.css"), "utf8");

  assert.match(
    css,
    /\.workbench-surface\s*{[^}]*--workbench-chrome-active-foreground:\s*var\(--foreground\);/s
  );
  assert.match(
    css,
    /\.workbench-surface\[data-mission-control-phase="entering"\],[\s\S]*?\.workbench-surface\[data-presentation-mode="mission-control"\]\s*{[^}]*--workbench-chrome-active-foreground:\s*var\(--white-stationary\);[^}]*--workbench-chrome-foreground:\s*var\(--white-stationary\);/s
  );
  assert.match(
    css,
    /\.workbench-mission-control-backdrop\s*{[^}]*background:\s*rgb\(0 0 0 \/ 60%\);[^}]*box-shadow:\s*none;/s
  );
  assert.match(
    css,
    /\.workbench-mission-control-backdrop::before\s*{[^}]*background:\s*none;[^}]*opacity:\s*0;/s
  );
  assert.match(
    css,
    /\.workbench-mission-control-backdrop::after\s*{[^}]*background:\s*none;[^}]*opacity:\s*0;/s
  );
  assert.doesNotMatch(
    css,
    /\.workbench-mission-control-backdrop\s*{[^}]*var\(--workbench-surface-background\)/s
  );
});

test("dialog popover node layer sits above dialog overlays and remains clickable", () => {
  const css = readFileSync(resolve("src/styles/workbench.css"), "utf8");

  assert.match(
    css,
    /\.workbench-node-layer--dialog-popover\s*{[^}]*position:\s*fixed;[^}]*z-index:\s*var\(--z-dialog-popover\);[^}]*pointer-events:\s*none;/s
  );
  assert.match(
    css,
    /\.workbench-node-layer--dialog-popover\[data-workbench-interactive="true"\]\s+\.workbench-window-shell\[data-minimized-mount="visible"\]\[data-genie-state="visible"\]\s*{[^}]*pointer-events:\s*auto;/s
  );
});

test("dock retained entry removal animates width and icon exit", () => {
  const css = readFileSync(resolve("src/styles/workbench.css"), "utf8");

  assert.match(
    css,
    /\.desktop-dock-plate\s*{[^}]*transition:\s*width 220ms cubic-bezier\(0\.22, 1, 0\.36, 1\);/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-dock-placement="left"\]\s*{[^}]*transition:\s*height 600ms cubic-bezier\(0\.16, 1, 0\.3, 1\);/s
  );
  assert.match(
    css,
    /\.desktop-dock__slot\[data-presence="exiting"\]\s*{[^}]*animation:\s*desktop-dock-slot-collapse 600ms cubic-bezier\(0\.4, 0, 0\.2, 1\)[^}]*both;/s
  );
  assert.match(
    css,
    /\.desktop-dock__slot\[data-presence="exiting"\]\s+\.desktop-dock__icon-shell\s*{[^}]*animation:\s*desktop-dock-presence-exit 420ms cubic-bezier\(0\.4, 0, 0\.2, 1\)[^}]*both;/s
  );
  assert.match(
    css,
    /\.desktop-dock__separator\[data-presence="exiting"\]\s*{[^}]*animation:\s*desktop-dock-separator-collapse 600ms/s
  );
  assert.match(css, /@keyframes desktop-dock-slot-collapse/);
  assert.match(css, /@keyframes desktop-dock-slot-collapse-left/);
  assert.match(css, /@keyframes desktop-dock-separator-collapse/);
  assert.match(css, /@keyframes desktop-dock-separator-collapse-left/);
});

test("dock transparent hover padding lets clicks reach windows behind it", () => {
  const css = readFileSync(resolve("src/styles/workbench.css"), "utf8");

  assert.match(
    css,
    /\.desktop-dock-plate\s*{[^}]*pointer-events:\s*none;[^}]*transition:\s*width 220ms/s
  );
  assert.match(
    css,
    /\.desktop-dock\s*{[^}]*pointer-events:\s*none;[^}]*transition:\s*width 600ms/s
  );
  assert.match(css, /\.desktop-dock__items\s*{[^}]*pointer-events:\s*none;/s);
  assert.match(css, /\.desktop-dock__slot\s*{[^}]*pointer-events:\s*auto;/s);
  assert.match(
    css,
    /\.desktop-dock\[data-dock-pointer-active="true"\]\s+\.desktop-dock__btn\[data-dock-hover-panel-trigger="true"\],[\s\S]*?pointer-events:\s*auto;/s
  );
  assert.match(
    css,
    /\.desktop-dock__hover-panel\s*{[^}]*pointer-events:\s*auto;/s
  );
});

test("dock badge chrome uses inverted outlines and 11px count text", () => {
  const css = readFileSync(resolve("src/styles/workbench.css"), "utf8");

  assert.match(
    css,
    /\.desktop-dock__icon-shell,\s*\.desktop-dock__minimized-stack-icon\s*{[^}]*--desktop-dock-loading-badge-offset:\s*-3\.6px;[^}]*--desktop-dock-loading-badge-size:\s*16\.2px;/s
  );
  assert.match(
    css,
    /\.desktop-dock__icon-shell\[data-entry-state="loading"\]::before,\s*\.desktop-dock__count-badge\s*{[^}]*border:\s*1px solid var\(--text-inverted\);/s
  );
  assert.match(
    css,
    /\.desktop-dock__count-badge\s*{[^}]*color:\s*var\(--text-inverted\);[^}]*font-size:\s*11px;/s
  );
  assert.match(
    css,
    /\.desktop-dock__status-badge\s*{[^}]*border:\s*1\.8px solid var\(--text-inverted\);/s
  );
  assert.match(
    css,
    /\.desktop-dock__slot--minimized\s+\.desktop-dock__count-badge\s*{[^}]*right:\s*-12px;[^}]*bottom:\s*var\(--desktop-dock-loading-badge-offset\);/s
  );
});

test("left dock placement owns vertical frame and popup placement styles", () => {
  const css = readFileSync(resolve("src/styles/workbench.css"), "utf8");

  assert.match(
    css,
    /\.workbench-dock-frame\s*{[^}]*--workbench-left-dock-bottom-inset:\s*24px;[^}]*--workbench-left-dock-left-inset:\s*4px;[^}]*--workbench-left-dock-top-inset:\s*54px;/s
  );
  assert.match(
    css,
    /\.workbench-dock-frame\[data-dock-placement="left"\]\s*{[^}]*top:\s*var\(--workbench-left-dock-top-inset\);[^}]*bottom:\s*var\(--workbench-left-dock-bottom-inset\);[^}]*left:\s*var\(--workbench-left-dock-left-inset\);[^}]*align-items:\s*center;/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-dock-placement="left"\]\s+\.desktop-dock__items\s*{[^}]*align-items:\s*flex-start;[^}]*flex-direction:\s*column;/s
  );
  assert.match(
    css,
    /\.desktop-dock__hover-panel\[data-dock-placement="left"\]\s*{[^}]*left:\s*calc\(\s*var\(--desktop-dock-hover-panel-anchor-left\)\s*\+\s*var\(--desktop-dock-hover-panel-anchor-width\)\s*\+\s*var\(--desktop-dock-hover-panel-gap, 12px\)\s*\);/s
  );
  assert.match(
    css,
    /\.desktop-dock-popup-root\s*{[^}]*z-index:\s*var\(--z-popover, 100200\);/s
  );
  assert.match(
    css,
    /body\[data-desktop-dock-minimized-stack-open="true"\]\s+\.workbench-dock-frame,\s*body\[data-desktop-dock-minimized-stack-open="true"\]\s+\.desktop-dock-plate,\s*body\[data-desktop-dock-minimized-stack-open="true"\]\s+\.desktop-dock\s*{[^}]*z-index:\s*0;/s
  );
  assert.match(
    css,
    /\.desktop-dock-popup-root\[data-dock-placement="bottom"\]\s*{[^}]*transform:\s*translate\(-50%, -100%\);/s
  );
  assert.match(
    css,
    /\.desktop-dock-popup\[data-popup-variant="minimized-stack"\]\s*>\s*div:nth-child\(2\)\s*{[^}]*overflow:\s*visible;/s
  );
  assert.match(
    css,
    /\.desktop-dock-popup-root\[data-dock-placement="left"\]\s*{[^}]*transform:\s*translate\(0, -50%\);/s
  );
  assert.match(
    css,
    /\.desktop-dock-popup-root\[data-dock-placement="left"\]\[data-popup-variant="minimized-stack"\]\s*{[^}]*z-index:\s*100300;[^}]*pointer-events:\s*none;[^}]*transform:\s*translate\(0, -100%\);/s
  );
  assert.match(
    css,
    /\.desktop-dock-popup-root\[data-dock-placement="left"\]\s+\.desktop-dock-popup__fan-title-tip\s*{[^}]*right:\s*auto;[^}]*left:\s*calc\(100% \+ 12px\);/s
  );
  assert.doesNotMatch(css, /desktop-dock-left-stack-card-fan-in/);
  assert.match(
    css,
    /\.desktop-dock\[data-dock-placement="left"\]\s+\.desktop-dock__slot\[data-node-state="open"\]::before,[\s\S]*?\.desktop-dock\[data-dock-placement="left"\]\s+\.desktop-dock__slot\[data-node-state="minimized"\]::before\s*{[^}]*right:\s*auto;[^}]*left:\s*calc\(var\(--desktop-dock-indicator-offset\) - 2px\);/s
  );
  assert.match(
    css,
    /\.desktop-dock__slot\[data-node-state="open"\]::before,[\s\S]*?\.desktop-dock__slot\[data-node-state="minimized"\]::before\s*{[^}]*--desktop-dock-indicator-color:\s*rgb\(0 0 0 \/ 46%\);[^}]*bottom:\s*calc\(var\(--desktop-dock-indicator-offset\) - 2px\);[^}]*width:\s*5px;[^}]*height:\s*5px;[^}]*background:\s*var\(--desktop-dock-indicator-color\);[^}]*box-shadow:\s*0 0 0 0\.5px rgb\(0 0 0 \/ 12%\);/s
  );
  assert.match(
    css,
    /\.desktop-dock__slot\[data-node-state="open"\]\[data-wallpaper-tone="dark"\]::before,[\s\S]*?\.desktop-dock__slot\[data-node-state="minimized"\]\[data-wallpaper-tone="dark"\]::before\s*{[^}]*--desktop-dock-indicator-color:\s*rgb\(255 255 255 \/ 78%\);[^}]*box-shadow:\s*0 0 0 0\.5px rgb\(0 0 0 \/ 42%\);/s
  );
  assert.match(
    css,
    /\.desktop-dock__slot\[data-node-state="open"\]\[data-wallpaper-tone="light"\]::before,[\s\S]*?\.desktop-dock__slot\[data-node-state="minimized"\]\[data-wallpaper-tone="light"\]::before\s*{[^}]*--desktop-dock-indicator-color:\s*rgb\(0 0 0 \/ 46%\);[^}]*box-shadow:\s*0 0 0 0\.5px rgb\(255 255 255 \/ 58%\);/s
  );
  assert.doesNotMatch(
    css,
    /\.desktop-dock__slot\[data-node-state="minimized"\]::before\s*{[^}]*opacity:/s
  );
});

test("dock overflow keeps scroll controls viewport-bound", () => {
  const css = readFileSync(resolve("src/styles/workbench.css"), "utf8");

  assert.match(
    css,
    /\.desktop-dock-plate\s*{[^}]*--desktop-dock-safe-inline:\s*64px;/s
  );
  assert.match(
    css,
    /\.desktop-dock-plate\s*{[^}]*max-width:\s*calc\(100vw - var\(--desktop-dock-safe-inline\) \* 2\);/s
  );
  assert.match(
    css,
    /\.desktop-dock\s*{[^}]*max-width:\s*calc\(100vw - var\(--desktop-dock-safe-inline\) \* 2\);/s
  );
  assert.match(
    css,
    /\.desktop-dock-plate\s*{[^}]*--desktop-dock-viewport-size:\s*88px;/s
  );
  assert.match(
    css,
    /\.desktop-dock-plate\s*{[^}]*--desktop-dock-left-viewport-size:\s*124px;/s
  );
  assert.match(
    css,
    /\.desktop-dock-plate\s*{[^}]*--desktop-dock-icon-half-size:\s*21\.6px;[^}]*--desktop-dock-icon-center-block-end:\s*calc\(\s*var\(--desktop-dock-items-padding-block-end\)\s*\+\s*var\(--desktop-dock-icon-half-size\)\s*\);/s
  );
  assert.match(
    css,
    /\.desktop-dock-plate\s*{[^}]*--desktop-dock-separator-center-offset:\s*calc\(\s*var\(--desktop-dock-icon-half-size\)\s*-\s*var\(--desktop-dock-separator-length\)\s*\/\s*2\s*\);/s
  );
  assert.match(
    css,
    /\.desktop-dock-plate\s*{[^}]*--desktop-dock-plate-padding-block-end:\s*0px;[^}]*--desktop-dock-plate-padding-block-start:\s*21\.6px;/s
  );
  assert.match(
    css,
    /\.desktop-dock\s*{[^}]*height:\s*var\(--desktop-dock-viewport-size\);/s
  );
  assert.match(
    css,
    /\.desktop-dock\s*{[^}]*--desktop-dock-scroll-button-gap:\s*32px;/s
  );
  assert.match(
    css,
    /\.desktop-dock\s*{[^}]*--desktop-dock-tooltip-gap:\s*32px;/s
  );
  assert.match(
    css,
    /\.desktop-dock\s*{[^}]*--desktop-dock-hover-panel-gap:\s*12px;/s
  );
  assert.match(
    css,
    /\.desktop-dock__hover-panel\s*{[^}]*top:\s*var\(--desktop-dock-hover-panel-anchor-top\);[^}]*pointer-events:\s*auto;[^}]*var\(--desktop-dock-hover-panel-gap, 12px\)/s
  );
  assert.match(
    css,
    /\.desktop-dock__label-tooltip\s*{[^}]*top:\s*var\(--desktop-dock-label-tooltip-anchor-top\);[^}]*pointer-events:\s*none;[^}]*var\(--desktop-dock-tooltip-gap, 32px\)/s
  );
  assert.match(
    css,
    /\.desktop-dock__label-tooltip\s*{[^}]*width:\s*max-content;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s
  );
  assert.match(
    css,
    /\.desktop-dock__label-tooltip\s*{[^}]*max-width:\s*min\(180px, calc\(100vw - 32px\)\);[^}]*padding:\s*4px 7px;[^}]*border-radius:\s*6px;[^}]*font-size:\s*11px;[^}]*line-height:\s*14px;/s
  );
  assert.match(
    css,
    /\.desktop-dock__label-tooltip\[data-dock-placement="left"\]\s*{[^}]*left:\s*calc\(\s*var\(--desktop-dock-label-tooltip-anchor-left\)\s*\+\s*var\(--desktop-dock-label-tooltip-anchor-width\)\s*\+\s*var\(--desktop-dock-tooltip-gap, 32px\)\s*\);/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-dock-pointer-active="true"\]:not\(\s*\[data-dock-hover-panel-open="true"\]\s*\)\s+\.desktop-dock__hover-panel\s*{[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;/s
  );
  assert.match(
    css,
    /\.desktop-dock\s*{[^}]*--desktop-dock-scroll-button-z-index:\s*120;/s
  );
  assert.match(
    css,
    /\.desktop-dock\s*{[^}]*--desktop-dock-scroll-fade-size:\s*48px;/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-scroll-overflow="true"\]\s+\.desktop-dock__items\s*{[^}]*padding-right:\s*calc\(\s*var\(--desktop-dock-scroll-button-size\)\s*\+\s*var\(--desktop-dock-scroll-button-gap\)\s*\);[^}]*padding-left:\s*calc\(\s*var\(--desktop-dock-scroll-button-size\)\s*\+\s*var\(--desktop-dock-scroll-button-gap\)\s*\);/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-dock-placement="left"\]\s*{[^}]*width:\s*var\(--desktop-dock-left-viewport-size\);[^}]*max-height:\s*calc\(\s*100vh - var\(--workbench-left-dock-top-inset\) -\s*var\(--workbench-left-dock-bottom-inset\)\s*\);/s
  );
  assert.match(
    css,
    /\.desktop-dock__items\s*{[^}]*align-items:\s*flex-end;[^}]*overflow:\s*visible;[^}]*scrollbar-width:\s*none;/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-scroll-overflow="true"\]\s+\.desktop-dock__items\s*{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/s
  );
  assert.match(
    css,
    /\.desktop-dock-plate\s*{[^}]*--desktop-dock-left-indicator-gutter:\s*8px;/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-dock-placement="left"\]\s+\.desktop-dock__items\s*{[^}]*width:\s*var\(--desktop-dock-left-viewport-size\);[^}]*padding:\s*var\(--desktop-dock-left-items-padding-block\) 0\s*var\(--desktop-dock-left-items-padding-block\)\s*var\(--desktop-dock-left-indicator-gutter\);/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-dock-placement="left"\]\[data-scroll-overflow="true"\]\s+\.desktop-dock__items\s*{[^}]*overflow-x:\s*visible;[^}]*overflow-y:\s*auto;/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-dock-placement="left"\]\s+\.desktop-dock__icon-shell\s*{[^}]*transform-origin:\s*left center;/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-dock-placement="left"\]\s+\.desktop-dock__minimized-preview\s*{[^}]*transform-origin:\s*left center;/s
  );
  assert.match(
    css,
    /\.desktop-dock__minimized-preview--component\s*{[^}]*padding:\s*0;[^}]*background:\s*var\(--background-panel\);/s
  );
  assert.match(
    css,
    /\.desktop-dock__minimized-preview--component > \*\s*{[^}]*width:\s*100%;[^}]*height:\s*100%;/s
  );
  assert.match(
    css,
    /\.desktop-dock__minimized-preview-freeze-source\s*{[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;/s
  );
  assert.match(
    css,
    /\.desktop-dock__minimized-preview-frozen-content\s*{[^}]*display:\s*block;[^}]*overflow:\s*hidden;/s
  );
  assert.doesNotMatch(css, /\.workbench-genie-preview-capture__fallback/);
  assert.match(css, /\.desktop-dock__slot\s*{[^}]*flex:\s*0 0 auto;/s);
  assert.match(
    css,
    /\.desktop-dock__separator\s*{[^}]*--desktop-dock-separator-color:\s*var\(--line-1\);[^}]*flex:\s*0 0 auto;[^}]*margin:\s*0 4px var\(--desktop-dock-separator-center-offset\);[^}]*align-self:\s*flex-end;[^}]*background:\s*var\(--desktop-dock-separator-color\);/s
  );
  assert.match(
    css,
    /\.desktop-dock__separator\[data-wallpaper-tone="dark"\]\s*{[^}]*--desktop-dock-separator-color:\s*rgb\(255 255 255 \/ 15%\);/s
  );
  assert.match(
    css,
    /\.desktop-dock__separator\[data-wallpaper-tone="light"\]\s*{[^}]*--desktop-dock-separator-color:\s*rgb\(0 0 0 \/ 12%\);/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-dock-placement="left"\]\s+\.desktop-dock__separator\s*{[^}]*align-self:\s*flex-start;[^}]*margin:\s*4px 0 4px var\(--desktop-dock-separator-center-offset\);/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-scroll-overflow="true"\]:hover\s+\.desktop-dock__scroll-button:not\(:disabled\)/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-dock-pointer-active="true"\]\s+\.desktop-dock__items\s*{[^}]*mask-image:\s*none;/s
  );
  assert.doesNotMatch(
    css,
    /\.desktop-dock\[data-dock-pointer-active="true"\]\s+\[data-radix-popper-content-wrapper\]\s*{[^}]*display:\s*none !important;/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-dock-pointer-active="true"\]:not\(\s*\[data-dock-hover-panel-open="true"\]\s*\)\s+\.desktop-dock__hover-panel\s*{[^}]*visibility:\s*hidden;/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-dock-hover-panel-open="true"\]\s+\.desktop-dock__items\s*{[^}]*mask-image:\s*none;/s
  );
  assert.match(css, /@keyframes desktop-dock-bounce-translate/s);
  assert.match(
    css,
    /@keyframes desktop-dock-bounce-translate\s*{[\s\S]*?45%\s*{[^}]*translate:\s*0 -14px;/s
  );
  assert.match(
    css,
    /@keyframes desktop-dock-bounce-translate-left\s*{[\s\S]*?45%\s*{[^}]*translate:\s*14px 0;/s
  );
  assert.match(
    css,
    /\.desktop-dock__slot\[data-bouncing="true"\]\s+\.desktop-dock__icon-content,/s
  );
  assert.doesNotMatch(
    css,
    /\.desktop-dock__slot\[data-bouncing="true"\]\s+\.desktop-dock__icon-shell,/s
  );
  assert.match(
    css,
    /\.desktop-dock:not\(\[data-dock-pointer-active="true"\]\)\s+\.desktop-dock__btn\[data-interactive="true"\]:active\s*{[^}]*transform:\s*translateY\(-1px\) scale\(0\.99\);/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-dock-placement="left"\]:not\(\[data-dock-pointer-active="true"\]\)\s+\.desktop-dock__btn\[data-interactive="true"\]:active\s*{[^}]*transform:\s*translateX\(1px\) scale\(0\.99\);/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-dock-pointer-active="true"\]\s+\.desktop-dock__btn\s*{[^}]*transition:\s*none;/s
  );
  assert.match(
    css,
    /\.desktop-dock__slot--minimized\[data-presence="entering"\]\s*{[^}]*animation:\s*none;/s
  );
  assert.match(
    css,
    /\.desktop-dock__slot--minimized\[data-promoted-from-stack="true"\]\[data-presence="entering"\]\s*{[^}]*animation:\s*none;/s
  );
  assert.match(
    css,
    /@keyframes desktop-dock-minimized-preview-promote\s*{[\s\S]*?translate:\s*28px 10px;/s
  );
  assert.match(
    css,
    /\.desktop-dock:not\(\[data-dock-pointer-active="true"\]\)\s+\.desktop-dock__minimized-stack-layer\s*{[^}]*transition:[^}]*transform 520ms/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-dock-placement="left"\]\s+\.desktop-dock__slot--minimized\[data-presence="entering"\]\s*{[^}]*animation:\s*none;/s
  );
  assert.match(
    css,
    /\.desktop-dock__slot--minimized\[data-presence="entering"\]\s+\.desktop-dock__minimized-preview,[\s\S]*?\.desktop-dock__slot--minimized\[data-presence="entering"\]\s+\.desktop-dock__minimized-stack-icon\s*{[^}]*animation:\s*desktop-dock-minimized-icon-appear 640ms/s
  );
  assert.match(
    css,
    /\.desktop-dock__slot--minimized\[data-pending-minimize="true"\]\[data-presence="entering"\]\s+\.desktop-dock__minimized-preview,[\s\S]*?\.desktop-dock__slot--minimized\[data-pending-minimize="true"\]\[data-presence="entering"\]\s+\.desktop-dock__minimized-stack-icon\s*{[^}]*animation:\s*none;/s
  );
  assert.match(
    css,
    /\.desktop-dock__slot--minimized\[data-collapsing="true"\],[\s\S]*?\.desktop-dock__slot--minimized\[data-presence="exiting"\]\s*{[^}]*animation:\s*desktop-dock-minimized-slot-collapse 720ms[^}]*pointer-events:\s*none;/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-dock-placement="left"\]\s+\.desktop-dock__slot--minimized\[data-collapsing="true"\],[\s\S]*?\.desktop-dock\[data-dock-placement="left"\]\s+\.desktop-dock__slot--minimized\[data-presence="exiting"\]\s*{[^}]*animation-name:\s*desktop-dock-minimized-slot-collapse-left;/s
  );
  assert.match(
    css,
    /@keyframes desktop-dock-minimized-slot-collapse\s*{[\s\S]*?width:\s*var\(--desktop-dock-collapse-inline-size, var\(--desktop-dock-size\)\);[\s\S]*?width:\s*0;[\s\S]*?margin-inline:\s*calc\(var\(--desktop-dock-gap\) \/ -2\);/
  );
  assert.match(
    css,
    /@keyframes desktop-dock-minimized-icon-disappear\s*{[\s\S]*?scale:\s*0\.08 0\.92;/
  );
  assert.match(
    css,
    /\.desktop-dock-popup\[data-popup-variant="minimized-stack"\]\s+\[data-desktop-dock-popup-card="true"\]\[data-launching="true"\]\s*{[^}]*opacity:\s*0;[^}]*scale:\s*0\.94;[^}]*pointer-events:\s*none;/s
  );
  assert.match(
    css,
    /\.desktop-dock__scroll-button--backward\s*{[^}]*top:\s*calc\(100% - var\(--desktop-dock-icon-center-block-end\)\);[^}]*left:\s*0;/s
  );
  assert.match(
    css,
    /\.desktop-dock__scroll-button--forward\s*{[^}]*top:\s*calc\(100% - var\(--desktop-dock-icon-center-block-end\)\);[^}]*right:\s*0;/s
  );
  assert.match(
    css,
    /\.desktop-dock__scroll-button\s*{[^}]*z-index:\s*var\(--desktop-dock-scroll-button-z-index\);/s
  );
  assert.match(
    css,
    /\.desktop-dock__scroll-button\s*{[^}]*background:\s*var\(--background-fronted\);/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-dock-placement="left"\]\s+\.desktop-dock__scroll-button\s*{[^}]*left:\s*calc\(\s*var\(--desktop-dock-left-indicator-gutter\)\s*\+\s*var\(--desktop-dock-icon-half-size\)\s*\);/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-scroll-forward="true"\]\s+\.desktop-dock__items\s*{[^}]*mask-image:\s*linear-gradient\(\s*to right,/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-scroll-backward="true"\]\[data-scroll-forward="true"\]\s+\.desktop-dock__items\s*{[^}]*transparent 0,[^}]*transparent 100%/s
  );
  assert.match(
    css,
    /\.desktop-dock\[data-dock-placement="left"\]\[data-scroll-forward="true"\]\s+\.desktop-dock__items\s*{[^}]*mask-image:\s*linear-gradient\(\s*to bottom,/s
  );
});
