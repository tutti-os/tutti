import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  fileURLToPath(new URL("./styles/workbench-launchpad.css", import.meta.url)),
  "utf8"
);

test("launchpad dock icon adapts to wallpaper tone", () => {
  assert.match(
    css,
    /\.workspace-launchpad-dock-icon\s*{[^}]*--workspace-launchpad-dock-icon-bg:\s*var\(--transparency-block\);[^}]*--workspace-launchpad-dock-icon-border:\s*var\(--line-1\);[^}]*background:\s*var\(--workspace-launchpad-dock-icon-bg\);/s
  );
  assert.match(
    css,
    /\.desktop-dock__slot\[data-wallpaper-tone="dark"\]\s+\.workspace-launchpad-dock-icon\s*{[^}]*--workspace-launchpad-dock-icon-bg:\s*rgb\(255 255 255 \/ 18%\);[^}]*--workspace-launchpad-dock-icon-border:\s*rgb\(255 255 255 \/ 15%\);/s
  );
  assert.match(
    css,
    /\.desktop-dock__slot\[data-wallpaper-tone="light"\]\s+\.workspace-launchpad-dock-icon\s*{[^}]*--workspace-launchpad-dock-icon-bg:\s*rgb\(0 0 0 \/ 10%\);[^}]*--workspace-launchpad-dock-icon-border:\s*rgb\(0 0 0 \/ 10%\);/s
  );
});

test("launchpad blank areas stay dismissible instead of trapping clicks in a drag region", () => {
  // Electron drag regions swallow pointerdown at the OS level before it
  // reaches the document, so any area marked `drag` breaks click-to-dismiss
  // (see WorkspaceChrome's header fix for the same class of bug). The
  // launchpad overlay only exists while it is open, so none of its
  // sub-regions should claim the drag region.
  assert.doesNotMatch(
    css,
    /\.workspace-launchpad-overlay__content\s*{[^}]*-webkit-app-region:\s*drag;/s
  );
  assert.match(
    css,
    /\.workspace-launchpad-overlay__content\s*{[^}]*-webkit-app-region:\s*no-drag;/s
  );
  assert.doesNotMatch(
    css,
    /\.workspace-launchpad-overlay__topbar\s*{[^}]*-webkit-app-region:\s*drag;/s
  );
  assert.match(
    css,
    /\.workspace-launchpad-overlay__topbar\s*{[^}]*-webkit-app-region:\s*no-drag;/s
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

test("launchpad search focus stays neutral", () => {
  assert.match(
    css,
    /\.workspace-launchpad-search__input:focus,\s*\.workspace-launchpad-search__input:focus-visible\s*{[^}]*border-color:\s*color-mix\(in srgb,\s*var\(--text-primary\)\s*18%,\s*var\(--border-1\)\);[^}]*box-shadow:\s*0 0 0 2px\s*color-mix\(in srgb,\s*var\(--text-primary\)\s*10%,\s*transparent\);/s
  );
  assert.doesNotMatch(
    css,
    /\.workspace-launchpad-search__input:focus,\s*\.workspace-launchpad-search__input:focus-visible\s*{[^}]*border-color:\s*var\(--border-focus\);/s
  );
});

test("launchpad search icon is vertically centered", () => {
  assert.match(
    css,
    /\.workspace-launchpad-search__icon\s*{[^}]*top:\s*50%;[^}]*display:\s*grid;[^}]*place-items:\s*center;[^}]*transform:\s*translateY\(-50%\);/s
  );
  assert.match(
    css,
    /\.workspace-launchpad-search__icon svg\s*{[^}]*width:\s*16px;[^}]*height:\s*16px;/s
  );
});

test("launchpad item labels use stationary white on content", () => {
  assert.match(
    css,
    /\.workspace-launchpad-item__label\s*{[^}]*color:\s*var\(--white-stationary\);/s
  );
});
