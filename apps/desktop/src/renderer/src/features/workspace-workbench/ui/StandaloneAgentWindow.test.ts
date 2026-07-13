import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const standaloneWindowSource = readFileSync(
  resolve(currentDirectory, "StandaloneAgentWindow.tsx"),
  "utf8"
);
const workbenchBodySource = readFileSync(
  resolve(
    currentDirectory,
    "../../workspace-agent/ui/DesktopAgentGUIWorkbenchBody.tsx"
  ),
  "utf8"
);

test("standalone Agent reuses the OS account menu in the sidebar footer", () => {
  assert.match(
    standaloneWindowSource,
    /import\("\.\/WorkspaceAccountMenu"\)[\s\S]*?default: WorkspaceAccountMenu/
  );
  assert.match(
    standaloneWindowSource,
    /function renderStandaloneAgentSidebarFooter\(\): ReactNode \{[\s\S]*<LazyWorkspaceAccountMenu \/>/
  );
  assert.match(
    standaloneWindowSource,
    /renderSidebarFooter=\{renderStandaloneAgentSidebarFooter\}/
  );
  assert.match(
    workbenchBodySource,
    /renderSlots=\{\{[\s\S]*sidebarFooter: previewMode \? undefined : renderSidebarFooter[\s\S]*\}\}/
  );
});

test("standalone Agent defers non-critical panel hosts until after the first frame", () => {
  assert.match(
    standaloneWindowSource,
    /window\.requestAnimationFrame\(\(\) => \{\s*setPanelHostsReady\(true\)/
  );
  assert.match(
    standaloneWindowSource,
    /panelHostsReady \? \([\s\S]*?<LazyStandaloneAgentWindowPanelHosts/
  );
});

test("standalone Agent starts the app runtime lifecycle only when apps open", () => {
  assert.match(
    standaloneWindowSource,
    /const ensureWorkspaceAppPolling = useCallback\([\s\S]*?startWorkspacePolling\(workspaceId\)/
  );
  assert.match(
    standaloneWindowSource,
    /onAppsOpen=\{ensureWorkspaceAppPolling\}/
  );
  assert.match(
    standaloneWindowSource,
    /setWorkspaceAppLauncher\([\s\S]*?ensureWorkspaceAppPolling\(\);[\s\S]*?state: \{ openAppId: appId \}/
  );
});

test("standalone Agent routes files and apps into the right sidebar", () => {
  assert.match(
    standaloneWindowSource,
    /setCanvasFilePreviewLauncher\([\s\S]*?openFileInSidebar\(target\.path\)/
  );
  assert.match(standaloneWindowSource, /workspaceFilePreviewMode: "canvas"/);
  assert.match(
    standaloneWindowSource,
    /action\.type !== "open-local-asset-preview"[\s\S]*?action\.type !== "open-workspace-file"[\s\S]*?openFileInSidebar\(action\.path\)/
  );
  assert.match(
    standaloneWindowSource,
    /setWorkspaceAppLauncher\([\s\S]*?state: \{ openAppId: appId \}/
  );
  assert.match(
    standaloneWindowSource,
    /<StandaloneAgentToolSidebar[\s\S]*?appOpenId=\{openAppId\}[\s\S]*?fileOpenRequest=\{fileOpenRequest\}/
  );
});

test("standalone Agent duplicates the active window without minimizing its source", () => {
  assert.match(
    standaloneWindowSource,
    /openDetachedWindow: i18n\.t\(\s*"workspace\.agentGui\.openDetachedWindow"\s*\)/
  );
  assert.match(
    standaloneWindowSource,
    /onOpenDetachedWindow=\{handleDuplicateStandaloneWindow\}/
  );
  assert.match(
    standaloneWindowSource,
    /handleDuplicateStandaloneWindow[\s\S]*?openAgentWindow\(\{[\s\S]*?agentDirectorySnapshot[\s\S]*?agentSessionId: nodeState\.lastActiveAgentSessionId[\s\S]*?agentTargetId: activeAgentTargetId[\s\S]*?minimizeSourceWindow: false[\s\S]*?provider: headerProvider[\s\S]*?workspaceId/
  );
});
