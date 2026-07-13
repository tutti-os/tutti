import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("waiting notifications stay with the legacy Workspace or Fusion Dock owner", async () => {
  const [
    actionSource,
    dockOwnersSource,
    dockSource,
    panelHostsSource,
    workspaceChromeSource
  ] = await Promise.all([
    readFile(
      new URL("./WorkspaceAgentMessageCenterAction.tsx", import.meta.url),
      "utf8"
    ),
    readFile(
      new URL("./FusionDockAgentNotificationOwners.tsx", import.meta.url),
      "utf8"
    ),
    readFile(new URL("./FusionDockWindow.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("./StandaloneAgentWindowPanelHosts.tsx", import.meta.url),
      "utf8"
    ),
    readFile(new URL("./WorkspaceChrome.tsx", import.meta.url), "utf8")
  ]);

  assert.doesNotMatch(actionSource, /notifications\.notify|toast\.custom/);
  assert.match(panelHostsSource, /handlesNotificationNavigation=\{false\}/);
  assert.doesNotMatch(panelHostsSource, /WaitingNotificationOwner/);
  assert.match(dockSource, /FusionDockAgentNotificationOwners/);
  assert.match(dockOwnersSource, /showDecisionToasts=\{false\}/);
  assert.match(workspaceChromeSource, /WorkspaceAgentWaitingNotificationOwner/);
});
