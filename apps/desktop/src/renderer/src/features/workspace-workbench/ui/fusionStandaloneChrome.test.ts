import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Fusion standalone windows defer outer chrome to the native window", async () => {
  const [
    agentPanelHostsSource,
    agentSource,
    dockListsSource,
    dockSource,
    fallbackSource,
    fusionToolSource,
    standaloneSource,
    trafficLightsSource
  ] = await Promise.all([
    readFile(
      new URL("./StandaloneAgentWindowPanelHosts.tsx", import.meta.url),
      "utf8"
    ),
    readFile(new URL("./StandaloneAgentWindow.tsx", import.meta.url), "utf8"),
    readFile(new URL("./FusionDockLists.tsx", import.meta.url), "utf8"),
    readFile(new URL("./FusionDockWindow.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("./FusionFallbackWindowChrome.tsx", import.meta.url),
      "utf8"
    ),
    readFile(new URL("./FusionToolWindow.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("./StandaloneWorkbenchNodeWindow.tsx", import.meta.url),
      "utf8"
    ),
    readFile(
      new URL("./WorkspaceWorkbenchTrafficLights.ts", import.meta.url),
      "utf8"
    )
  ]);

  assert.doesNotMatch(fallbackSource, /h-\[52px\]/);
  assert.doesNotMatch(fallbackSource, /WorkspaceWorkbenchTrafficLights/);
  assert.doesNotMatch(fallbackSource, /-webkit-app-region:drag/);
  assert.doesNotMatch(fusionToolSource, /state\.workspaceError\s*\?\?/);
  assert.match(standaloneSource, /presentation="window"/);
  assert.match(
    standaloneSource,
    /data-fusion-native-window-content-header="true"/
  );
  assert.match(
    standaloneSource,
    /<WorkspaceWorkbenchWindowChromeProvider mode="native">/
  );
  assert.doesNotMatch(standaloneSource, /appCenterState\.error\s*\?\?/);
  assert.match(
    trafficLightsSource,
    /createContext<WorkspaceWorkbenchWindowChromeMode>\("workbench"\)/
  );
  assert.match(
    trafficLightsSource,
    /if \(windowChromeMode === "native"\) \{\s*return null;/
  );
  const contentHeaderPolicy = standaloneSource.slice(
    standaloneSource.indexOf("function shouldRenderStandaloneContentHeader")
  );
  assert.match(contentHeaderPolicy, /kind === "browser"/);
  assert.match(contentHeaderPolicy, /kind === "file-preview"/);
  assert.match(contentHeaderPolicy, /kind === "issue-manager"/);
  assert.match(contentHeaderPolicy, /kind === "terminal"/);
  assert.doesNotMatch(contentHeaderPolicy, /kind === "files"/);
  assert.doesNotMatch(contentHeaderPolicy, /kind === "app-center"/);
  assert.doesNotMatch(contentHeaderPolicy, /kind === "workspace-app"/);
  assert.match(agentSource, /usesNativeWindowChrome = fusionWindowId !== null/);
  assert.match(agentSource, /showWindowControls=\{!usesNativeWindowChrome\}/);
  assert.match(
    agentSource,
    /style=\{usesNativeWindowChrome \? \{ cursor: "default" \} : undefined\}/
  );
  assert.match(agentSource, /"data-workbench-drag-handle": "true" as const/);
  assert.match(
    standaloneSource,
    /\[&_\[data-workbench-drag-handle\]\]:!cursor-default/
  );
  assert.match(standaloneSource, /\[&_button\]:\[-webkit-app-region:no-drag\]/);
  assert.match(
    standaloneSource,
    /\[&_\[role=button\]\]:\[-webkit-app-region:no-drag\]/
  );
  assert.match(
    standaloneSource,
    /\[&_\.nodrag\]:\[-webkit-app-region:no-drag\]/
  );
  assert.match(dockSource, /<AppUpdateStatus density="compact" \/>/);
  assert.match(dockListsSource, /event\.target !== event\.currentTarget/);
  assert.match(agentSource, /onLinkAction=\{fusionWindowId/);
  assert.match(agentSource, /providerStatusSnapshot:/);
  assert.match(agentSource, /resolveWorkspaceAgentProviderLaunchIntent/);
  assert.match(agentPanelHostsSource, /DesktopAgentProviderManageDialog/);
  assert.match(agentPanelHostsSource, /WorkspaceAgentMessageCenterAction/);
});
