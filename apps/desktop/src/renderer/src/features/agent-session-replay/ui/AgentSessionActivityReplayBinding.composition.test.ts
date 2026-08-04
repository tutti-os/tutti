import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const nodeBodySource = readFileSync(
  new URL(
    "../../workspace-agent/ui/DesktopAgentGUIWorkbenchBody.tsx",
    import.meta.url
  ),
  "utf8"
);
const workspaceSource = readFileSync(
  new URL(
    "../../workspace-workbench/ui/WorkspaceWorkbench.tsx",
    import.meta.url
  ),
  "utf8"
);
const workspaceRuntimeSource = readFileSync(
  new URL("./AgentSessionReplayWorkspaceRuntime.tsx", import.meta.url),
  "utf8"
);
const composerFooterSource = readFileSync(
  new URL(
    "../../workspace-agent/ui/useDesktopAgentGUIComposerFooterAccessory.tsx",
    import.meta.url
  ),
  "utf8"
);
const workspaceChromeSource = readFileSync(
  new URL("../../workspace-workbench/ui/WorkspaceChrome.tsx", import.meta.url),
  "utf8"
);
const standaloneSource = readFileSync(
  new URL(
    "../../workspace-workbench/ui/StandaloneAgentWindow.tsx",
    import.meta.url
  ),
  "utf8"
);
const standalonePanelHostsSource = readFileSync(
  new URL(
    "../../workspace-workbench/ui/StandaloneAgentWindowPanelHosts.tsx",
    import.meta.url
  ),
  "utf8"
);

test("activity replay binding is owned by the bootstrapped workspace renderer", () => {
  assert.doesNotMatch(nodeBodySource, /AgentSessionActivityReplayBinding/);
  assert.doesNotMatch(nodeBodySource, /useAgentSessionReplayNodeReadiness/);
  assert.equal(bindingMountCount(workspaceSource), 0);
  assert.equal(bindingMountCount(workspaceRuntimeSource), 1);
  assert.equal(bindingMountCount(standaloneSource), 0);
  assert.doesNotMatch(
    standaloneSource,
    /AgentSessionReplayWorkspace(?:Coordinator|Provider)/
  );
});

test("workspace replay machinery mounts only in the isolated replay runtime", () => {
  // The normal workspace only keeps a lazy boundary; the coordinator and
  // bindings live in a replay-only chunk.
  assert.match(workspaceSource, /isAgentSessionReplayRuntime\?\.\(\)/);
  assert.match(
    workspaceSource,
    /import\("@renderer\/features\/agent-session-replay\/ui\/AgentSessionReplayWorkspaceRuntime\.tsx"\)/
  );
  assert.doesNotMatch(
    workspaceSource,
    /from "@renderer\/features\/agent-session-replay\/(?:ui|services)\/(?:AgentSessionReplayWorkspaceBinding|AgentSessionReplayWorkspaceContext|AgentSessionReplayWorkspaceCoordinator)/
  );
  assert.equal(
    workspaceRuntimeSource.match(
      /new AgentSessionReplayWorkspaceCoordinator\(/g
    )?.length,
    1
  );
});

test("normal Agent nodes keep replay readiness and composer code out of the hot path", () => {
  assert.match(
    nodeBodySource,
    /import\("\.\.\/\.\.\/agent-session-replay\/ui\/AgentSessionReplayNodeReadiness\.tsx"\)/
  );
  assert.match(nodeBodySource, /replayRuntimeActive/);
  assert.match(
    composerFooterSource,
    /import\("\.\.\/\.\.\/agent-session-replay\/ui\/AgentSessionReplayComposerFooterAccessory\.tsx"\)/
  );
  assert.doesNotMatch(
    composerFooterSource,
    /from "\.\.\/\.\.\/agent-session-replay\/(?:services|ui)\//
  );
});

test("workspace replay runtime suppresses the external Agent import prompt", () => {
  assert.match(
    workspaceSource,
    /externalAgentSessionImportPromptEnabled=\{!replayRuntimeActive\}/
  );
  assert.match(
    workspaceChromeSource,
    /\{externalAgentSessionImportPromptEnabled \? \(\s*<ExternalAgentSessionImportPrompt\b/
  );
  assert.equal(
    workspaceChromeSource.match(/<ExternalAgentSessionImportPrompt\b/g)?.length,
    1
  );
  assert.match(
    standalonePanelHostsSource,
    /<ExternalAgentSessionImportPrompt\b/
  );
});

function bindingMountCount(source: string): number {
  return (
    source.match(/<WorkspaceAgentSessionActivityReplayBinding\b/g)?.length ?? 0
  );
}
