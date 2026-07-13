import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { BrowserNodeEvent } from "@tutti-os/browser-node";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type {
  WorkbenchContribution,
  WorkbenchHostHandle,
  WorkbenchHostLaunchRequest
} from "@tutti-os/workbench-surface";
import {
  createStandaloneAgentBrowserToolFeature,
  createStandaloneAgentDirectToolHost,
  createStandaloneAgentToolHostGroup,
  createStandaloneAgentToolSnapshotRepository,
  resolveStandaloneAgentToolContribution
} from "./standaloneAgentToolWorkbench.ts";

const standaloneAgentToolSidebarSource = readFileSync(
  new URL("./StandaloneAgentToolSidebar.tsx", import.meta.url),
  "utf8"
);
const standaloneAgentToolSidebarToolbarSource = readFileSync(
  new URL("./StandaloneAgentToolSidebarToolbar.tsx", import.meta.url),
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

test("standalone Agent browser and terminal mount their OS node UI directly", () => {
  assert.match(standaloneAgentToolSidebarSource, /<BrowserNode/);
  assert.match(standaloneAgentToolSidebarSource, /hidden=\{hidden\}/);
  assert.match(
    standaloneAgentToolSidebarSource,
    /<StandaloneAgentBrowserToolPanel[\s\S]*?hidden=\{!active\}/
  );
  assert.match(standaloneAgentToolSidebarSource, /<TerminalNode/);
  assert.doesNotMatch(standaloneAgentToolSidebarSource, /<WorkbenchHost/);
  assert.match(
    standaloneAgentToolSidebarSource,
    /data-standalone-agent-terminal-close="true"/
  );
  assert.match(
    standaloneAgentToolSidebarSource,
    /<StandaloneAgentAppCenterToolPanel/
  );
  assert.doesNotMatch(
    standaloneAgentToolSidebarSource,
    /<WorkspaceAppCenterPane/
  );
  assert.match(
    standaloneAgentToolSidebarSource,
    /workspace\.appCenter\.backToApps/
  );
  assert.match(
    standaloneAgentToolSidebarSource,
    /<WorkspaceAgentMessageCenterPanel[\s\S]*?presentation="embedded"/
  );
});

test("standalone Agent right sidebar stays above message-flow content", () => {
  assert.match(
    standaloneAgentToolSidebarSource,
    /data-standalone-agent-tool-sidebar="true"[\s\S]*?zIndex: "var\(--z-panel\)"/
  );
});

test("standalone Agent right sidebar reserves layout space and reveals requested files", () => {
  assert.match(
    standaloneAgentToolSidebarSource,
    /width: activePanel \? `\$\{activePanelLayoutWidth\}px` : "0px"/
  );
  assert.match(
    standaloneAgentToolSidebarSource,
    /dispatch\(\{ panel: "files", type: "open-panel" \}\)/
  );
  assert.match(
    standaloneAgentToolSidebarSource,
    /<WorkspaceFileManagerPane[\s\S]*?revealIntent=\{fileOpenRequest\}/
  );
});

test("standalone Agent right sidebar animates its shell before mounting heavy content", () => {
  assert.match(
    standaloneAgentToolSidebarSource,
    /overflow-hidden transition-\[width\] duration-\[260ms\] ease-\[cubic-bezier\(0\.22,1,0\.36,1\)\]/
  );
  assert.match(
    standaloneAgentToolSidebarSource,
    /motion-reduce:transition-none/
  );
  assert.match(
    standaloneAgentToolSidebarSource,
    /dispatch\(\{ panel, type: "select-tool" \}\);\s*scheduleResizeForPanel\(panel\)/
  );
  assert.match(
    standaloneAgentToolSidebarSource,
    /standaloneAgentToolPanelContentMountDelayMs = 260/
  );
  assert.match(
    standaloneAgentToolSidebarSource,
    /contentReadyPanels\.includes\(panel\)[\s\S]*?motion-safe:animate-in[\s\S]*?<ToolSidebarPanel/
  );
});

test("standalone Agent browser and terminal share one dropdown trigger", () => {
  assert.match(
    standaloneAgentToolSidebarToolbarSource,
    /<DropdownMenuTrigger asChild>[\s\S]*?data-standalone-agent-tool-menu-trigger="true"[\s\S]*?<ToolsIcon[\s\S]*?<ChevronDownIcon[\s\S]*?<\/Button>[\s\S]*?<\/DropdownMenuTrigger>/
  );
  assert.doesNotMatch(
    standaloneAgentToolSidebarToolbarSource,
    /rounded-r-none|rounded-l-none|onToggleTool/
  );
});

test("standalone Agent messages reuse the OS running animation and badge only running sessions", () => {
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
    /messages: messageCenterModel\.counts\.working/
  );
  assert.doesNotMatch(
    standaloneAgentToolSidebarSource,
    /messages:\s*messageCenterModel\.waitingCount/
  );
  assert.match(
    standaloneAgentToolSidebarToolbarSource,
    /\(reminders\.messages \?\? 0\) > 0[\s\S]*?<WorkspaceAgentStatusPetIcon[\s\S]*?mood="running"[\s\S]*?: \([\s\S]*?<ChatIcon/
  );
  assert.match(
    standaloneAgentToolSidebarToolbarSource,
    /reminderCount=\{reminders\.messages\}/
  );
  assert.doesNotMatch(
    standaloneAgentToolSidebarSource,
    /activityService\.load\(workspaceId\)/
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

test("standalone Agent browser tool uses the BrowserNode event lifecycle for its own guest", () => {
  let emitBrowserEvent = (_event: BrowserNodeEvent): void => undefined;
  const feature = createStandaloneAgentBrowserToolFeature({
    browserApi: {
      activate: async () => undefined,
      close: async () => undefined,
      goBack: async () => undefined,
      goForward: async () => undefined,
      navigate: async () => undefined,
      onEvent(listener) {
        emitBrowserEvent = listener;
        return () => {
          emitBrowserEvent = () => undefined;
        };
      },
      prepareSession: async () => undefined,
      registerGuest: async () => undefined,
      reload: async () => undefined,
      unregisterGuest: async () => undefined
    },
    i18n: { t: (key) => key } as I18nRuntime<string>,
    nodeId: "browser:standalone-agent-tool:one"
  });
  const disconnect = feature.connect();

  emitBrowserEvent({
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "browser:another-window",
    title: "Other browser",
    type: "state",
    url: "https://example.com/other"
  });
  assert.equal(
    feature.runtimeStore.getNodeState("browser:standalone-agent-tool:one").url,
    null
  );

  emitBrowserEvent({
    canGoBack: true,
    canGoForward: false,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "browser:standalone-agent-tool:one",
    title: "Tutti",
    type: "state",
    url: "https://tutti.app/"
  });
  assert.equal(
    feature.runtimeStore.getNodeState("browser:standalone-agent-tool:one").url,
    "https://tutti.app/"
  );
  assert.equal(
    feature.resolveAddressInput("browser tool").url,
    "https://www.google.com/search?q=browser+tool"
  );

  disconnect();
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
