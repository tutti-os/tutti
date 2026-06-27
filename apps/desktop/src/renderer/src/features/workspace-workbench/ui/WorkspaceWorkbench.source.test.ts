import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(
  resolve(
    "src/renderer/src/features/workspace-workbench/ui/WorkspaceWorkbench.tsx"
  ),
  "utf8"
);

test("WorkspaceWorkbench does not render a global agent install pending overlay", () => {
  assert.doesNotMatch(source, /WorkspaceAgentConnectingCard/);
  assert.doesNotMatch(
    source,
    /pendingActions\.find\(\s*\(action\) => action\.actionId === "install"/s
  );
});

test("WorkspaceWorkbench forwards open-directory mode to workspace files", () => {
  assert.match(
    source,
    /payload:\s*\{\s*\.\.\.\(request\.mode \? \{ mode: request\.mode \} : \{\}\),\s*path: request\.path\s*\}/s
  );
});

test("WorkspaceWorkbench validates requested file targets before opening workspace files", () => {
  assert.match(
    source,
    /request\.validateExists[\s\S]*workspaceFileManagerService\.entryExists\(\{[\s\S]*path: request\.path[\s\S]*workspaceID: request\.workspaceId[\s\S]*return false;[\s\S]*host\.launchNode/s
  );
});

test("WorkspaceWorkbench uses temporary dock retention to control app visibility", () => {
  assert.match(source, /temporaryWorkspaceAppDockRetentionActionPrefix/);
  assert.match(source, /resolveTemporaryDockRetentionContribution/);
  assert.match(
    source,
    /contribution\.dockEntries\.map\(\(entry\) =>\s*resolveTemporaryDockRetentionEntry/
  );
  assert.match(source, /findTemporaryDockRetentionEntry/);
  assert.match(source, /entry\.id === workspaceLaunchpadDockEntryId/);
  assert.match(source, /entry\.id === workspaceFilesNodeID/);
  assert.match(
    source,
    /actionId:\s*`\$\{temporaryWorkspaceAppDockRetentionActionPrefix\}\$\{encodeURIComponent\(entry\.id\)\}`/
  );
  assert.match(
    source,
    /return app\?\.installed \?\? \(entry\.visibility \?\? "always"\) === "always";/
  );
  assert.match(source, /visibility:\s*retained \? "always" : "when-open"/);
});

test("WorkspaceWorkbench opens manage agents dialog from agent-manage feature request", () => {
  assert.match(source, /DesktopAgentProviderManageDialog/);
  assert.match(source, /request\.feature === "agent-manage"/);
  assert.match(source, /setAgentProviderManageDialogOpen\(true\)/);
  assert.match(
    source,
    /setAgentProviderManageFocusedProvider\(\s*isDesktopAgentGUIProvider\(request\.provider\) \? request\.provider : null\s*\)/s
  );
});
