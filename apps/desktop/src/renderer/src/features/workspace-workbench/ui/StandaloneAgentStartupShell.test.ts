import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const standaloneWorkbenchSource = readFileSync(
  resolve(currentDirectory, "StandaloneAgentWorkbench.tsx"),
  "utf8"
);
const standaloneWindowSource = readFileSync(
  resolve(currentDirectory, "StandaloneAgentWindow.tsx"),
  "utf8"
);
const toolSidebarSource = readFileSync(
  resolve(currentDirectory, "StandaloneAgentToolSidebar.tsx"),
  "utf8"
);
const sharedToolSidebarSource = readFileSync(
  resolve(
    currentDirectory,
    "../../../../../../../../packages/agent/gui/workbench/tool-sidebar/AgentToolSidebar.tsx"
  ),
  "utf8"
);
const toolSidebarPanelSource = readFileSync(
  resolve(currentDirectory, "StandaloneAgentToolSidebarPanel.tsx"),
  "utf8"
);
const toolLoadingStateSource = readFileSync(
  resolve(currentDirectory, "StandaloneAgentToolLoadingState.tsx"),
  "utf8"
);
const browserToolPanelSource = readFileSync(
  resolve(currentDirectory, "StandaloneAgentBrowserToolPanel.tsx"),
  "utf8"
);
const terminalPanelSource = readFileSync(
  resolve(currentDirectory, "StandaloneAgentTerminalPanel.tsx"),
  "utf8"
);
const workspaceWindowSource = readFileSync(
  resolve(
    currentDirectory,
    "../../../app/windows/workspace/WorkspaceWindow.tsx"
  ),
  "utf8"
);
const workspaceAgentGuiContributionSource = readFileSync(
  resolve(
    currentDirectory,
    "../services/internal/workspaceAgentGuiContribution.ts"
  ),
  "utf8"
);

test("Agent surfaces render a structured startup shell at every blocking boundary", () => {
  assert.match(
    workspaceWindowSource,
    /routeView === "agent" \? \(\s*<StandaloneAgentStartupShell \/>/
  );
  assert.equal(
    standaloneWorkbenchSource.match(/<StandaloneAgentStartupShell \/>/g)
      ?.length,
    2
  );
  assert.doesNotMatch(
    standaloneWindowSource,
    /LazyDesktopAgentGUIWorkbenchBody/
  );
  assert.match(
    workspaceAgentGuiContributionSource,
    /import \{ DesktopAgentGUIWorkbenchBody \} from "@renderer\/features\/workspace-agent\/ui\/DesktopAgentGUIWorkbenchBody\.tsx"/
  );
});

test("OS and standalone Agent routes statically own the AgentGUI body", () => {
  assert.doesNotMatch(
    workspaceAgentGuiContributionSource,
    /React\.lazy|lazy\(/
  );
  assert.doesNotMatch(
    workspaceAgentGuiContributionSource,
    /import\("@renderer\/features\/workspace-agent\/ui\/DesktopAgentGUIWorkbenchBody\.tsx"\)/
  );
  assert.match(
    workspaceAgentGuiContributionSource,
    /createElement\(DesktopAgentGUIWorkbenchBody, \{/
  );
});

test("standalone Agent tool panels expose loading UI while deferred modules start", () => {
  assert.match(
    toolSidebarSource,
    /renderLoading=\{\(\) => \(\s*<StandaloneAgentToolLoadingState/
  );
  assert.match(
    sharedToolSidebarSource,
    /activeTabId === tab\.id \? \(\s*\(renderLoading\?\.\(tab\) \?\? null\)/
  );
  assert.match(toolLoadingStateSource, /<Spinner/);
  const deferredPanelSources = [
    toolSidebarPanelSource,
    browserToolPanelSource,
    terminalPanelSource
  ].join("\n");
  assert.doesNotMatch(
    deferredPanelSources,
    /<Suspense fallback=\{null\}>\s*<Lazy(?:WorkspaceFileManagerPane|StandaloneAgentAppCenterToolPanel|StandaloneAgentMessageCenterToolPanel|BrowserNode|TerminalNode)/
  );
});
