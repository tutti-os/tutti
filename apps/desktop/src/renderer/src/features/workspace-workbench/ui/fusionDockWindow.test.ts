import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("./FusionDockWindow.tsx", import.meta.url),
  "utf8"
);
const railSource = await readFile(
  new URL("./FusionLauncherRail.tsx", import.meta.url),
  "utf8"
);
const workbenchStyles = await readFile(
  new URL(
    "../../../../../../../../packages/workbench/surface/src/styles/workbench.css",
    import.meta.url
  ),
  "utf8"
);
const rendererMainSource = await readFile(
  new URL("../../../main.tsx", import.meta.url),
  "utf8"
);

test("Fusion Dock consumes the canonical Workspace launcher catalog and resident app projection", () => {
  assert.match(source, /resolveWorkspaceDockLauncherCatalog/);
  assert.match(source, /resolveFusionDockLaunchers/);
  assert.match(source, /WorkspaceAppCenterIntegration/);
  assert.doesNotMatch(source, /fusionPrimaryLaunchKinds/);
});

test("Fusion Dock renders search only for the native expanded state and focuses it in renderer", () => {
  assert.match(source, /dockSearchExpanded/);
  assert.match(source, /searchExpanded \? \(/);
  assert.match(source, /searchRef\.current\?\.focus\(\)/);
  assert.doesNotMatch(source, /FusionWindowList|FusionResourceList/);
  assert.doesNotMatch(source, /executeJavaScript/);
});

test("Fusion Dock exposes localized shortcut errors in expanded and narrow presentations", () => {
  assert.match(source, /shortcutErrorKey/);
  assert.match(railSource, /shortcutErrorKey/);
  assert.match(railSource, /role="status"/);
  assert.match(source, /workspace\.fusion\.actionFailed/);
});

test("Fusion launcher rail presents native windows separately from background-only tasks", () => {
  assert.match(railSource, /projectFusionDockLauncherInstanceCounts/);
  assert.match(railSource, /data-native-window-count/);
  assert.match(railSource, /data-background-task-count/);
  assert.match(railSource, /data-fusion-background-count/);
  assert.match(railSource, /data-status=\{counts\.backgroundStatus/);
  assert.match(railSource, /workspace\.fusion\.nativeWindowCount/);
  assert.match(
    railSource,
    /data-node-state=\{counts\.windowCount > 0 \? "open" : "closed"\}/
  );
});

test("Fusion launcher rail inherits the canonical Workbench Dock metrics", () => {
  assert.match(railSource, /desktop-dock--fixed-metrics/);
  assert.match(
    railSource,
    /width: desktopFusionDockLayout\.launcherRailWidthPx/
  );
  assert.match(railSource, /"--desktop-dock-left-indicator-gutter": "0px"/);
  assert.doesNotMatch(
    railSource,
    /\[--desktop-dock-left-indicator-gutter:0px\]/
  );
  assert.match(
    workbenchStyles,
    /\.desktop-dock-plate,\s*\.desktop-dock--fixed-metrics\s*\{[\s\S]*?--desktop-dock-size: 43\.2px;[\s\S]*?--desktop-dock-gap: 16px;/
  );
});

test("Fusion Dock draws one inset surface over a transparent narrow renderer canvas", () => {
  assert.match(source, /data-fusion-dock-window="true"/);
  assert.match(
    source,
    /rounded-\[18px\][^"\n]*border-\[color-mix\(in_srgb,var\(--border-1\)_55%,transparent\)\]/
  );
  assert.match(
    source,
    /width: searchExpanded \? "100%" : desktopFusionDockLayout\.panelWidthPx/
  );
  assert.match(
    rendererMainSource,
    /rendererWindowIntent\.kind === "fusion-dock" \? "transparent" : "opaque"/
  );
  for (const className of [
    "min-w-0",
    "w-full",
    "h-full",
    "min-h-0",
    "overflow-hidden",
    "bg-none",
    "bg-transparent"
  ]) {
    assert.match(rendererMainSource, new RegExp(`"${className}"`));
  }
  assert.match(
    rendererMainSource,
    /element\.classList\.add\(\.\.\.transparentWindowCanvasClasses\)/
  );
});
