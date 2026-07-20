import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  WorkbenchContribution,
  WorkbenchHostHandle,
  WorkbenchHostLaunchRequest
} from "@tutti-os/workbench-surface";
import {
  createStandaloneAgentDirectToolHost,
  createStandaloneAgentToolHostGroup,
  createStandaloneAgentToolSnapshotRepository,
  resolveStandaloneAgentToolContribution
} from "./standaloneAgentToolWorkbench.ts";

const standaloneAgentToolSidebarAdapterSource = readFileSync(
  new URL("./StandaloneAgentToolSidebar.tsx", import.meta.url),
  "utf8"
);
const sharedAgentToolSidebarSource = readFileSync(
  new URL(
    "../../../../../../../../packages/agent/gui/workbench/tool-sidebar/AgentToolSidebar.tsx",
    import.meta.url
  ),
  "utf8"
);
const sharedAgentToolSidebarControllerSource = readFileSync(
  new URL(
    "../../../../../../../../packages/agent/gui/workbench/tool-sidebar/useAgentToolSidebarController.ts",
    import.meta.url
  ),
  "utf8"
);
const standaloneAgentToolSidebarSource =
  standaloneAgentToolSidebarAdapterSource +
  sharedAgentToolSidebarSource +
  sharedAgentToolSidebarControllerSource;
const standaloneAgentToolSidebarPickerSource = readFileSync(
  new URL(
    "../../../../../../../../packages/agent/gui/workbench/tool-sidebar/Picker.tsx",
    import.meta.url
  ),
  "utf8"
);
const standaloneAgentToolSidebarPanelSource = readFileSync(
  new URL("./StandaloneAgentToolSidebarPanel.tsx", import.meta.url),
  "utf8"
);
const workspaceFileManagerPaneSource = readFileSync(
  new URL(
    "../../workspace-file-manager/ui/WorkspaceFileManagerPane.tsx",
    import.meta.url
  ),
  "utf8"
);
const standaloneAgentBrowserToolPanelSource = readFileSync(
  new URL("./StandaloneAgentBrowserToolPanel.tsx", import.meta.url),
  "utf8"
);
const sharedAgentToolBrowserPanelSource = readFileSync(
  new URL(
    "../../../../../../../../packages/agent/gui/workbench/tool-sidebar/AgentToolBrowserPanel.tsx",
    import.meta.url
  ),
  "utf8"
);
const standaloneAgentTerminalPanelSource = readFileSync(
  new URL("./StandaloneAgentTerminalPanel.tsx", import.meta.url),
  "utf8"
);
const standaloneAgentToolSidebarToolbarSource = readFileSync(
  new URL(
    "../../../../../../../../packages/agent/gui/workbench/tool-sidebar/Toolbar.tsx",
    import.meta.url
  ),
  "utf8"
);
const standaloneAgentMessageCenterToolPanelSource = readFileSync(
  new URL("./StandaloneAgentMessageCenterToolPanel.tsx", import.meta.url),
  "utf8"
);
const standaloneAgentDecisionNotificationsSource = readFileSync(
  new URL("./StandaloneAgentDecisionNotifications.tsx", import.meta.url),
  "utf8"
);
const workspaceAgentDecisionNotificationsSource = readFileSync(
  new URL("./useWorkspaceAgentDecisionNotifications.tsx", import.meta.url),
  "utf8"
);
const standaloneAgentIssueManagerToolPanelSource = readFileSync(
  new URL("./StandaloneAgentIssueManagerToolPanel.tsx", import.meta.url),
  "utf8"
);
const workspaceAgentStatusPetIconSource = readFileSync(
  new URL("./WorkspaceAgentStatusPetIcon.tsx", import.meta.url),
  "utf8"
);
const workspaceAgentMessageCenterActionSource = readFileSync(
  new URL("./WorkspaceAgentMessageCenterAction.tsx", import.meta.url),
  "utf8"
);

test("standalone Agent tools load their OS node UI on demand", () => {
  assert.match(standaloneAgentBrowserToolPanelSource, /<AgentToolBrowserPanel/);
  assert.match(
    standaloneAgentBrowserToolPanelSource,
    /chromeCookieImportPrompt=\{getDesktopChromeCookieImportPromptAdapter\(\)\}/
  );
  assert.match(
    standaloneAgentBrowserToolPanelSource,
    /@tutti-os\/agent-gui\/workbench\/browser-element-context/
  );
  assert.match(
    standaloneAgentBrowserToolPanelSource,
    /navigationActions=\{[\s\S]*?<BrowserElementContextAction/
  );
  assert.match(sharedAgentToolBrowserPanelSource, /<LazyBrowserNode/);
  assert.match(sharedAgentToolBrowserPanelSource, /hidden=\{hidden\}/);
  assert.match(
    standaloneAgentToolSidebarPanelSource,
    /<StandaloneAgentBrowserToolPanel[\s\S]*?hidden=\{!active\}/
  );
  assert.match(standaloneAgentTerminalPanelSource, /<LazyTerminalNode/);
  assert.doesNotMatch(standaloneAgentToolSidebarSource, /<WorkbenchHost/);
  assert.match(
    standaloneAgentToolSidebarPanelSource,
    /<LazyStandaloneAgentAppCenterToolPanel/
  );
  assert.match(
    standaloneAgentToolSidebarPanelSource,
    /<LazyStandaloneAgentAppViewerToolPanel/
  );
  assert.doesNotMatch(
    standaloneAgentToolSidebarPanelSource,
    /<WorkspaceAppCenterPane/
  );
  assert.match(
    standaloneAgentMessageCenterToolPanelSource,
    /<WorkspaceAgentMessageCenterPanel[\s\S]*?presentation="embedded"/
  );
});

test("standalone Agent opens an empty right sidebar with the core tool picker", () => {
  assert.match(
    standaloneAgentToolSidebarSource,
    /const isEmptySidebar = isSidebarOpen && state\.mountedTabs\.length === 0/
  );
  assert.match(
    sharedAgentToolSidebarSource,
    /isEmptySidebar \|\| isEmptySidebarClosing \? \([\s\S]*?<AgentToolSidebarPicker\s+panels=\{panels\}/
  );
  assert.match(
    standaloneAgentToolSidebarAdapterSource,
    /id: "files"[\s\S]*?id: "terminal"[\s\S]*?id: "browser"[\s\S]*?id: "tasks"[\s\S]*?id: "apps"[\s\S]*?id: "messages"/
  );
  assert.match(standaloneAgentToolSidebarAdapterSource, /panels=\{panels\}/);
  assert.match(
    standaloneAgentToolSidebarPickerSource,
    /data-standalone-agent-tool-sidebar-picker="true"/
  );
});

test("standalone Agent quick actions open the apps and messages panel tabs", () => {
  assert.match(
    standaloneAgentToolSidebarAdapterSource,
    /quickActionPanels=\{\["tasks", "apps", "messages"\]\}/
  );
  assert.match(
    standaloneAgentToolSidebarToolbarSource,
    /activePanel === null && !isOpen[\s\S]*?quickActions\.map[\s\S]*?data-standalone-agent-tool-sidebar-quick-action=\{panel\}[\s\S]*?variant="chrome"[\s\S]*?onClick=\{\(\) => onOpenPanel\(panel\)\}/
  );
  assert.match(
    standaloneAgentToolSidebarToolbarSource,
    /<ReminderBadge count=\{reminders\[panel\]\}/
  );
  assert.match(
    standaloneAgentToolSidebarToolbarSource,
    /<TooltipContent side="bottom">\{label\}<\/TooltipContent>/
  );
  assert.match(
    standaloneAgentToolSidebarToolbarSource,
    /activePanel === null && !isOpen[\s\S]*?quickActions\.map/
  );
});

test("standalone Agent panel tab buttons switch the active mounted panel", () => {
  assert.match(
    standaloneAgentToolSidebarSource,
    /data-standalone-agent-tool-tab=\{tab\.panel\}[\s\S]*?role="tab"[\s\S]*?onClick=\{\(\) => onOpenPanel\(tab\)\}/
  );
  assert.match(
    standaloneAgentToolSidebarSource,
    /data-standalone-agent-tool-tab-list="true"[\s\S]*?role="tablist"/
  );
});

test("standalone Agent right sidebar reserves layout space and reveals requested files", () => {
  assert.match(
    standaloneAgentToolSidebarSource,
    /width: isSidebarOpen \? `\$\{activePanelLayoutWidth\}px` : "0px"/
  );
  assert.match(
    standaloneAgentToolSidebarSource,
    /fileOpenRequestTabIdRef\.current =[\s\S]*?sidebarRef\.current\?\.openPanel\("files"\) \?\? null/
  );
  assert.match(
    standaloneAgentToolSidebarPanelSource,
    /<LazyWorkspaceFileManagerPane[\s\S]*?revealIntent=\{fileOpenRequest\}[\s\S]*?showPreviewPanel=\{false\}/
  );
});

test("standalone Agent hides internal open-with actions without changing the OS default", () => {
  assert.match(
    standaloneAgentToolSidebarPanelSource,
    /<LazyWorkspaceFileManagerPane[\s\S]*?showInternalOpenWithActions=\{false\}/
  );
  assert.match(
    workspaceFileManagerPaneSource,
    /showInternalOpenWithActions = true/
  );
  assert.match(
    workspaceFileManagerPaneSource,
    /<WorkspaceFileManager[\s\S]*?showInternalOpenWithActions=\{showInternalOpenWithActions\}/
  );
});

test("standalone Agent resizes the native window when panels open, switch, and close", () => {
  assert.match(
    standaloneAgentToolSidebarSource,
    /const scheduleResizeForPanel = useCallback\([\s\S]*?window\.requestAnimationFrame\(\(\) => \{[\s\S]*?resizeForPanel\(panel, preferredWidth, options\)/
  );
  assert.match(
    standaloneAgentToolSidebarSource,
    /const openPanel = useCallback\([\s\S]*?type: "open-panel"[\s\S]*?scheduleResizeForPanel\(panel\)/
  );
  assert.match(
    standaloneAgentToolSidebarSource,
    /const activatePanelTab = useCallback\([\s\S]*?type: "activate-tab"[\s\S]*?scheduleResizeForPanel\(tab\.panel\)/
  );
  assert.match(
    standaloneAgentToolSidebarSource,
    /const closePanel = useCallback\([\s\S]*?dispatch\(\{ type: "close" \}\)[\s\S]*?scheduleResizeForPanel\(null\)/
  );
  assert.match(
    standaloneAgentToolSidebarSource,
    /const closePanelTab = useCallback\([\s\S]*?nextState\.activePanel === null[\s\S]*?scheduleResizeForPanel\(fallbackPanel, agentToolEmptySidebarWidth[\s\S]*?scheduleResizeForPanel\(nextState\.activePanel\)/
  );
});

test("standalone Agent restores the resize baseline after closing the empty picker", () => {
  assert.match(
    standaloneAgentToolSidebarSource,
    /setIsEmptySidebarClosing\(true\);\s+scheduleResizeForPanel\(null, undefined, \{\s+animateContainer: true,\s+preserveBaseline: true/
  );
  assert.match(
    standaloneAgentToolSidebarSource,
    /setIsEmptySidebarClosing\(false\);\s+layout\.resetContainerResizeBaseline\(\)/
  );
  assert.match(
    standaloneAgentToolSidebarSource,
    /state\.mountedTabs\.length === 0[\s\S]*?scheduleResizeForPanel\(nextPanel, agentToolEmptySidebarWidth/
  );
});

test("standalone Agent toolbar exposes task management in the unified panel", () => {
  assert.match(
    standaloneAgentToolSidebarAdapterSource,
    /quickActionPanels=\{\["tasks", "apps", "messages"\]\}/
  );
  assert.match(
    standaloneAgentToolSidebarToolbarSource,
    /panels\.map\(\(panel\)[\s\S]*?onSelect=\{\(\) => onAddPanel\(panel\.id\)\}[\s\S]*?panel=\{panel\.id\}/
  );
  assert.match(standaloneAgentToolSidebarToolbarSource, /tasks: TaskIcon/);
  assert.match(
    standaloneAgentToolSidebarPanelSource,
    /<LazyStandaloneAgentIssueManagerToolPanel/
  );
  assert.match(
    standaloneAgentIssueManagerToolPanelSource,
    /candidate\.id === "workspace-issue-manager"/
  );
  assert.doesNotMatch(
    standaloneAgentIssueManagerToolPanelSource,
    /IssueManagerEmbeddedToolbar/
  );
  assert.match(
    standaloneAgentIssueManagerToolPanelSource,
    /\[issueManagerTopicSelectorPlacementDataKey\]: "sidebar"[\s\S]*?resolved\.definition\.renderBody\(context\)/
  );
  assert.match(
    standaloneAgentIssueManagerToolPanelSource,
    /const context: WorkbenchHostNodeBodyContext = \{\s*activation,/
  );
  assert.match(
    standaloneAgentToolSidebarAdapterSource,
    /issueManagerOpenRequestTabIdRef\.current =[\s\S]*?sidebarRef\.current\?\.openPanel\("tasks"\) \?\? null/
  );
  assert.match(
    standaloneAgentIssueManagerToolPanelSource,
    /source\.subscribeNodeState\?\.\([\s\S]*?updateState/
  );
});

test("standalone Agent message reminders remain activity-driven", () => {
  assert.match(
    workspaceAgentMessageCenterActionSource,
    /<WorkspaceAgentStatusPetIcon mood=\{triggerPetMood\}/
  );
  assert.match(
    workspaceAgentStatusPetIconSource,
    /agent-status-pet\/running\.gif/
  );
  assert.match(
    standaloneAgentToolSidebarSource,
    /selectWorkspaceAgentConsumerCounts\(sessionEngine\.getSnapshot\(\)\)\.working/
  );
  assert.match(
    standaloneAgentToolSidebarSource,
    /messages: messageCenterWorkingCount/
  );
  assert.doesNotMatch(
    standaloneAgentToolSidebarSource,
    /messages:\s*\w+\.waitingCount/
  );
  assert.match(
    standaloneAgentToolSidebarToolbarSource,
    /ReminderBadge count=\{reminders\[panel\]\}/
  );
  assert.doesNotMatch(
    standaloneAgentToolSidebarToolbarSource,
    /Object\.values\(reminders\)/
  );
  assert.doesNotMatch(
    standaloneAgentToolSidebarSource,
    /activityService\.load\(workspaceId\)/
  );
});

test("standalone Agent reuses the OS decision toast for newly arrived approvals", () => {
  assert.match(
    standaloneAgentToolSidebarSource,
    /<StandaloneAgentDecisionNotifications[\s\S]*?messageCenterOpen=\{activePanel === "messages"\}/
  );
  assert.match(
    standaloneAgentDecisionNotificationsSource,
    /useWorkspaceAgentDecisionNotifications\(\{[\s\S]*?sendBackgroundNotification: false,[\s\S]*?sessionEngine,[\s\S]*?workspaceId/
  );
  assert.doesNotMatch(
    standaloneAgentDecisionNotificationsSource,
    /isAgentGuiSessionOpen:/
  );
  assert.match(
    workspaceAgentDecisionNotificationsSource,
    /toast\.custom\([\s\S]*?<WorkspaceAgentDecisionToast/
  );
  assert.match(
    workspaceAgentDecisionNotificationsSource,
    /isAgentGuiSessionOpen\?\.\(item\.agentSessionId\) \?\? false/
  );
  assert.match(
    workspaceAgentDecisionNotificationsSource,
    /type: "interaction\/responseRequested"/
  );
  assert.match(
    workspaceAgentDecisionNotificationsSource,
    /if \(!seenKeys\) \{[\s\S]*?seenWaitingNotificationKeysRef\.current = currentKeys;[\s\S]*?return;/
  );
});

test("standalone Agent terminal contribution keeps the real renderer and opens fullscreen without a dock", async () => {
  const renderBody = () => null;
  const contribution: WorkbenchContribution = {
    dockEntries: [
      {
        icon: null,
        id: "workspace-terminal",
        label: "Terminal",
        typeId: "workspace-terminal"
      }
    ],
    id: "workspace-terminal",
    nodes: [
      {
        frame: { height: 500, width: 800, x: 0, y: 0 },
        renderBody,
        title: "Terminal",
        typeId: "workspace-terminal",
        window: { closable: true, minimizable: true }
      }
    ],
    onLaunchRequest: () => ({
      framePolicy: "cascade",
      instanceId: "terminal-1",
      typeId: "workspace-terminal"
    })
  };

  const resolved = resolveStandaloneAgentToolContribution(
    [contribution],
    "terminal"
  );
  assert.ok(resolved);
  assert.deepEqual(resolved.dockEntries, []);
  assert.equal(resolved.nodes?.[0]?.renderBody, renderBody);
  assert.deepEqual(resolved.nodes?.[0]?.window, {
    closable: false,
    minimizable: false
  });
  const launch = await resolved.onLaunchRequest?.({
    dockEntryId: "workspace-terminal",
    layoutConstraints: {
      minHeight: 0,
      minWidth: 0,
      safeArea: { bottom: 0, left: 0, right: 0, top: 0 },
      surfacePadding: 0
    },
    reason: "host",
    surfaceSize: { height: 600, width: 700 },
    typeId: "workspace-terminal",
    workspaceId: "workspace-1"
  } satisfies WorkbenchHostLaunchRequest);
  assert.equal(launch?.displayMode, "fullscreen");
  assert.equal(launch?.framePolicy, "absolute");
});

test("standalone Agent tool snapshot repository never restores OS workbench windows", async () => {
  const repository = createStandaloneAgentToolSnapshotRepository();
  assert.equal(await repository.load("workspace-1"), null);
});

test("standalone Agent tool host group aggregates terminal close effects and routes node commands", async () => {
  const closedNodeIds: string[] = [];
  const terminalHost = createTestHost(
    "terminal-node",
    [
      {
        description: "running command",
        nodeId: "terminal-node",
        title: "Terminal",
        typeId: "workspace-terminal"
      }
    ],
    closedNodeIds
  );
  const group = createStandaloneAgentToolHostGroup();
  group.setHost("terminal", terminalHost);

  assert.deepEqual(await group.host.collectWindowCloseEffects(), [
    {
      description: "running command",
      nodeId: "terminal-node",
      title: "Terminal",
      typeId: "workspace-terminal"
    }
  ]);
  group.host.closeNode("terminal-node");
  assert.deepEqual(closedNodeIds, ["terminal-node"]);
  assert.equal(group.host.getSnapshot().nodes.length, 1);
});

test("standalone Agent direct terminal host exposes the mounted session to close guards", async () => {
  const directHost = createStandaloneAgentDirectToolHost();
  const closeEffect = {
    description: "running command",
    nodeId: "terminal-node-1",
    title: "zsh",
    typeId: "workspace-terminal"
  };
  directHost.setNode({
    instanceId: "terminal-session-1",
    nodeId: "terminal-node-1",
    resolveCloseEffect: async () => closeEffect,
    title: "zsh",
    typeId: "workspace-terminal"
  });

  assert.deepEqual(directHost.host.getSnapshot().nodes[0]?.data, {
    instanceId: "terminal-session-1",
    instanceKey: "terminal-session-1",
    typeId: "workspace-terminal"
  });
  assert.deepEqual(await directHost.host.collectWindowCloseEffects(), [
    closeEffect
  ]);
  directHost.host.closeNode("terminal-node-1");
  assert.equal(directHost.host.getSnapshot().nodes.length, 0);
});

function createTestHost(
  nodeId: string,
  closeEffects: Awaited<
    ReturnType<WorkbenchHostHandle["collectWindowCloseEffects"]>
  >,
  closedNodeIds: string[]
): WorkbenchHostHandle {
  const snapshot = {
    activeDragNodeId: null,
    activeResizeNodeId: null,
    activeSnapTarget: null,
    layoutConstraints: {
      minHeight: 0,
      minWidth: 0,
      safeArea: { bottom: 0, left: 0, right: 0, top: 0 },
      surfacePadding: 0
    },
    lockedLayout: null,
    nodes: [
      {
        data: { instanceId: nodeId, typeId: "test" },
        displayMode: "floating" as const,
        frame: { height: 100, width: 100, x: 0, y: 0 },
        id: nodeId,
        isMinimized: false,
        kind: "window" as const,
        restoreFrame: null,
        title: nodeId
      }
    ],
    nodeStack: [nodeId],
    surfaceSize: { height: 100, width: 100 }
  };
  return {
    activateNode: () => undefined,
    closeNode: (id) => closedNodeIds.push(id),
    collectWindowCloseEffects: async () => closeEffects,
    dispose: () => undefined,
    exitFullscreenNode: () => undefined,
    focusNode: () => undefined,
    getSnapshot: () => snapshot,
    launchNode: async () => null,
    load: async () => undefined,
    minimizeNode: () => undefined,
    reconcileProjectedNodes: () => undefined,
    requestNodeClose: () => undefined,
    setNodeRuntimeState: () => undefined,
    setNodeSizeConstraints: () => undefined,
    setNodeTitle: () => undefined,
    setSnapshotNodeState: () => undefined
  };
}
