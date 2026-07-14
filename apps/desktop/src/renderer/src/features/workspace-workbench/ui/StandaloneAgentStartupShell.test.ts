import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const startupShellSource = readFileSync(
  resolve(currentDirectory, "StandaloneAgentStartupShell.tsx"),
  "utf8"
);
const startupBodyShellSource = readFileSync(
  resolve(
    currentDirectory,
    "../../../../../../../../packages/agent/gui/AgentGUIStartupShell.tsx"
  ),
  "utf8"
);
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

test("standalone Agent startup shell keeps the rail and new-conversation hero visible", () => {
  assert.match(startupShellSource, /data-agent-gui-startup-shell="window"/);
  assert.match(
    startupShellSource,
    /<AgentGUIStartupShell loadingLabel=\{loadingLabel\} \/>/
  );
  assert.doesNotMatch(startupBodyShellSource, /AgentGUIStartupSource|source:/);
  assert.doesNotMatch(startupBodyShellSource, /data-agent-gui-source/);
  assert.match(
    startupBodyShellSource,
    /gridTemplateColumns: "52px 280px minmax\(0, 1fr\)"/
  );
  assert.match(
    startupBodyShellSource,
    /agent-gui-node__conversation-list-skeleton-row/
  );
  assert.match(
    startupBodyShellSource,
    /agent-gui-node__empty-hero[\s\S]*?agent-gui-node__empty-hero-title/
  );
  assert.match(
    startupBodyShellSource,
    /agent-gui-node__timeline agent-gui-node__timeline-centered[\s\S]*?data-agent-gui-startup-timeline-content="true"/
  );
  assert.match(
    startupBodyShellSource,
    /agent-gui-node__empty-hero-icon-slot[\s\S]*?data-carousel-placeholder=\{true\}[\s\S]*?h-28/
  );
  assert.match(
    startupBodyShellSource,
    /agent-gui-node__composer-hero[\s\S]*?data-layout="hero"[\s\S]*?agent-gui-node__composer-hero-prompt-input-area[\s\S]*?<textarea[\s\S]*?disabled/
  );
  assert.match(
    startupBodyShellSource,
    /agent-gui-node__composer-footer[\s\S]*?agent-gui-node__composer-footer-left[\s\S]*?agent-gui-node__composer-footer-right/
  );
  assert.match(
    startupBodyShellSource,
    /agent-gui-node__composer-project-row[\s\S]*?agent-gui-node__composer-prompt-tips[\s\S]*?agent-gui-node__composer-prompt-tip/
  );
  assert.match(
    startupBodyShellSource,
    /agent-gui-node__empty-hero-suggestions[\s\S]*?agent-gui-node__empty-hero-suggestions-chips/
  );
  assert.doesNotMatch(startupBodyShellSource, /agent-gui-node__bottom-dock/);
  assert.doesNotMatch(startupBodyShellSource, /data-layout="dock"/);
  assert.match(startupBodyShellSource, /<Spinner/);
});

test("standalone Agent tool panels expose loading UI while deferred modules start", () => {
  assert.match(
    toolSidebarSource,
    /activePanel === panel \? \(\s*<StandaloneAgentToolLoadingState/
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
