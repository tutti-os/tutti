import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("./workspaceWindow.ts", import.meta.url),
  "utf8"
);
const fusionCoordinatorSource = await readFile(
  new URL("./fusionWindowCoordinator.ts", import.meta.url),
  "utf8"
);

test("standalone native window chrome is an explicit opt-in", () => {
  assert.match(source, /windowChrome\?: "native" \| "renderer"/);
  assert.match(
    source,
    /usesNativeWindowChrome =\s*isStandaloneWindow && options\.windowChrome === "native"/
  );
  assert.match(
    source,
    /isStandaloneWindow\s*\? \{ frame: usesNativeWindowChrome \}/
  );
  assert.match(source, /titleBarStyle: "default" as const/);
});

test("legacy detached Agent keeps renderer chrome and centered placement", () => {
  assert.match(
    source,
    /usesRendererWindowChrome =\s*isStandaloneWindow && !usesNativeWindowChrome/
  );
  assert.match(
    source,
    /windowKind === "agent" && usesRendererWindowChrome\s*\? resolveCenteredWindowBounds/
  );
  assert.match(
    source,
    /windowKind === "agent" && usesRendererWindowChrome\s*\? \{ maximizable: false \}/
  );
});

test("legacy Workspace keeps its hidden macOS titlebar", () => {
  assert.match(
    source,
    /windowKind === "workspace"[\s\S]*titleBarStyle: "hidden" as const[\s\S]*trafficLightPosition/
  );
});

test("Fusion business windows opt into native chrome and native macOS discovery", () => {
  assert.match(
    fusionCoordinatorSource,
    /windowChrome: "native"[\s\S]*windowKind:/
  );
  assert.match(
    fusionCoordinatorSource,
    /target\.setHiddenInMissionControl\(false\)/
  );
  assert.match(
    fusionCoordinatorSource,
    /target\.excludedFromShownWindowsMenu = false/
  );
});

test("Fusion launcher stays out of native window discovery", () => {
  assert.match(
    fusionCoordinatorSource,
    /dockWindow\.setHiddenInMissionControl\(true\)/
  );
  assert.match(
    fusionCoordinatorSource,
    /dockWindow\.excludedFromShownWindowsMenu = true/
  );
  assert.match(
    fusionCoordinatorSource,
    /registerWorkspaceWindowCommandCloseHandler\([\s\S]*?this\.hideDock\(\)/
  );
});

test("all desktop renderer windows install the immutable navigation policy", () => {
  assert.match(
    source,
    /installDesktopRendererWindowNavigationPolicy\(workspaceWindow, logger\)/
  );
  assert.match(source, /loadAuthorizedDesktopRendererUrl/);
  assert.match(source, /loadAuthorizedDesktopRendererFile/);
  assert.match(
    fusionCoordinatorSource,
    /installDesktopRendererWindowNavigationPolicy\([\s\S]*?dockWindow/
  );
});
