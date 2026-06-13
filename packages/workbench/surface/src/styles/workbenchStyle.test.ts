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
    /\.desktop-dock__hover-panel\[data-dock-placement="left"\]\s*{[^}]*left:\s*calc\(\s*var\(--desktop-dock-hover-panel-anchor-left\)\s*\+\s*var\(--desktop-dock-hover-panel-anchor-width\)\s*\+\s*var\(--desktop-dock-tooltip-gap, 32px\)\s*\);/s
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
    /\.desktop-dock\[data-dock-placement="left"\]\s+\.desktop-dock__slot\[data-node-state="open"\]::before,[\s\S]*?\.desktop-dock\[data-dock-placement="left"\]\s+\.desktop-dock__slot\[data-node-state="minimized"\]::before\s*{[^}]*right:\s*auto;[^}]*left:\s*var\(--desktop-dock-indicator-offset\);/s
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
    /\.desktop-dock__hover-panel\s*{[^}]*top:\s*var\(--desktop-dock-hover-panel-anchor-top\);[^}]*pointer-events:\s*auto;/s
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
  assert.match(css, /\.desktop-dock__slot\s*{[^}]*flex:\s*0 0 auto;/s);
  assert.match(
    css,
    /\.desktop-dock__separator\s*{[^}]*flex:\s*0 0 auto;[^}]*margin:\s*0 4px var\(--desktop-dock-separator-center-offset\);[^}]*align-self:\s*flex-end;[^}]*background:\s*var\(--line-1\);/s
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
    /\.desktop-dock__slot--minimized\[data-presence="entering"\]\s*{[^}]*animation:\s*desktop-dock-minimized-slot-expand 720ms/s
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
    /\.desktop-dock\[data-dock-placement="left"\]\s+\.desktop-dock__slot--minimized\[data-presence="entering"\]\s*{[^}]*animation-name:\s*desktop-dock-minimized-slot-expand-left;/s
  );
  assert.match(
    css,
    /@keyframes desktop-dock-minimized-slot-expand\s*{[\s\S]*?width:\s*0;[\s\S]*?margin-inline:\s*calc\(var\(--desktop-dock-gap\) \/ -2\);[\s\S]*?width:\s*var\(--desktop-dock-size\);/
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

test("launchpad top bar remains draggable without stealing controls", () => {
  const css = readFileSync(resolve("src/styles/workbench.css"), "utf8");

  assert.match(
    css,
    /\.workspace-launchpad-overlay__content\s*{[^}]*-webkit-app-region:\s*drag;/s
  );
  assert.match(
    css,
    /\.workspace-launchpad-overlay__topbar\s*{[^}]*-webkit-app-region:\s*drag;/s
  );
  assert.match(
    css,
    /\.workspace-launchpad-search\s*{[^}]*-webkit-app-region:\s*no-drag;/s
  );
  assert.match(
    css,
    /\.workspace-launchpad-grid-viewport\s*{[^}]*-webkit-app-region:\s*no-drag;/s
  );
  assert.match(
    css,
    /\.workspace-launchpad-grid-viewport\s*{[^}]*overflow:\s*visible;/s
  );
  assert.match(
    css,
    /\.workspace-launchpad-dock-hover-panel\s*{[^}]*--workspace-launchpad-hover-panel-shift:\s*0px;[^}]*left:\s*50%;[^}]*right:\s*auto;[^}]*max-width:\s*min\(240px, calc\(100vw - 32px\)\);[^}]*transform:\s*translateX\(\s*calc\(-50% \+ var\(--workspace-launchpad-hover-panel-shift\)\)\s*\)/s
  );
  assert.doesNotMatch(
    css,
    /workspace-launchpad-dock-hover-panel\[data-hover-panel-align=/
  );
  assert.match(
    css,
    /\.workspace-launchpad-pages\s*{[^}]*-webkit-app-region:\s*no-drag;/s
  );
});
