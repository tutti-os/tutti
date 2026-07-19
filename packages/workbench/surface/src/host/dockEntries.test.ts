import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchNode } from "../core/types.ts";
import {
  matchWorkbenchDockEntryNode,
  resolveWorkbenchDockEntries,
  resolveWorkbenchDockEntryClick
} from "./dockEntries.ts";
import type { WorkbenchHostDockEntry, WorkbenchHostNodeData } from "./types.ts";

test("dock entries match by dockEntryId before fallback matchers", () => {
  const entry: WorkbenchHostDockEntry = {
    icon: null,
    id: "agent:codex",
    label: "Codex",
    matchNode: () => true,
    typeId: "agentGui"
  };

  assert.equal(
    matchWorkbenchDockEntryNode(
      entry,
      makeNode("agent-1", "agentGui", "agent:codex")
    ),
    true
  );
  assert.equal(
    matchWorkbenchDockEntryNode(
      entry,
      makeNode("agent-2", "agentGui", "agent:claude")
    ),
    false
  );
});

test("dock entries render when-open entries only when matching nodes exist", () => {
  const entries = resolveWorkbenchDockEntries({
    dockEntries: [
      {
        icon: null,
        id: "browser",
        label: "Browser",
        order: 20,
        sectionId: "apps",
        typeId: "browser",
        visibility: "always"
      },
      {
        icon: null,
        id: "agent:codex",
        label: "Codex",
        order: 10,
        sectionId: "agents",
        typeId: "agentGui",
        visibility: "when-open"
      }
    ],
    minimizedNodeIds: new Set<string>(),
    nodes: [makeNode("agent-1", "agentGui", "agent:codex")]
  });

  assert.deepEqual(
    entries.map((entry) => ({
      id: entry.entry.id,
      sectionBreakBefore: entry.sectionBreakBefore
    })),
    [
      { id: "browser", sectionBreakBefore: false },
      { id: "agent:codex", sectionBreakBefore: true }
    ]
  );
});

test("dock entries can recover existing nodes through matchNode fallback", () => {
  const entries = resolveWorkbenchDockEntries({
    dockEntries: [
      {
        icon: null,
        id: "browser",
        label: "Browser",
        matchNode: (node) => node.data.typeId === "browser",
        typeId: "browser",
        visibility: "always"
      }
    ],
    minimizedNodeIds: new Set<string>(),
    nodes: [makeNode("browser-1", "browser")]
  });
  const [entry] = entries;

  assert.ok(entry);
  assert.equal(entry?.hasMatchingNodes, true);
  assert.equal(entry?.dockNodeState, "open");
  assert.deepEqual(
    resolveWorkbenchDockEntryClick({
      entry: entry.entry,
      instanceMode: "multi",
      matchedNodes: entry.matchedNodes
    }),
    { kind: "open-popup" }
  );
});

test("canonical AgentGUI and workspace app affinities expose open and minimized states", () => {
  const entries = resolveWorkbenchDockEntries({
    dockEntries: [
      {
        icon: null,
        id: "agent-gui:unified",
        label: "Agent",
        typeId: "agent-gui"
      },
      {
        icon: null,
        id: "workspace-app:calendar",
        label: "Calendar",
        typeId: "workspace-app-webview"
      }
    ],
    minimizedNodeIds: new Set(["workspace-app-webview:app:calendar"]),
    nodes: [
      makeNode("agent-gui:codex:panel:1", "agent-gui", "agent-gui:unified"),
      makeNode(
        "app:calendar",
        "workspace-app-webview",
        "workspace-app:calendar"
      )
    ]
  });

  assert.deepEqual(
    entries.map((entry) => [entry.entry.id, entry.dockNodeState]),
    [
      ["agent-gui:unified", "open"],
      ["workspace-app:calendar", "minimized"]
    ]
  );
});

test("dock click resolution follows instance strategy for existing nodes", () => {
  const entry: WorkbenchHostDockEntry = {
    icon: null,
    id: "browser",
    label: "Browser",
    typeId: "browser"
  };

  assert.deepEqual(
    resolveWorkbenchDockEntryClick({
      entry,
      instanceMode: "multi",
      matchedNodes: [makeNode("browser-1", "browser", "browser")]
    }),
    { kind: "open-popup" }
  );
  assert.deepEqual(
    resolveWorkbenchDockEntryClick({
      entry,
      instanceMode: "single",
      matchedNodes: [makeNode("browser-1", "browser", "browser")]
    }),
    { kind: "focus-node", nodeId: "browser:browser-1" }
  );
  assert.deepEqual(
    resolveWorkbenchDockEntryClick({
      entry,
      instanceMode: "single",
      matchedNodes: [
        makeNode("browser-1", "browser", "browser"),
        makeNode("browser-2", "browser", "browser")
      ]
    }),
    { kind: "open-popup" }
  );
  assert.deepEqual(
    resolveWorkbenchDockEntryClick({
      entry: {
        ...entry,
        state: {
          kind: "loading"
        }
      },
      matchedNodes: []
    }),
    { kind: "blocked" }
  );
  assert.deepEqual(
    resolveWorkbenchDockEntryClick({
      entry: {
        ...entry,
        launchBehavior: "disabled"
      },
      matchedNodes: []
    }),
    { kind: "blocked" }
  );
  assert.deepEqual(
    resolveWorkbenchDockEntryClick({
      entry: {
        ...entry,
        state: {
          kind: "disabled"
        }
      },
      instanceMode: "single",
      matchedNodes: [makeNode("browser-1", "browser", "browser")]
    }),
    { kind: "blocked" }
  );
  assert.deepEqual(
    resolveWorkbenchDockEntryClick({
      entry: {
        ...entry,
        state: {
          kind: "disabled"
        }
      },
      instanceMode: "multi",
      matchedNodes: [makeNode("browser-1", "browser", "browser")]
    }),
    { kind: "blocked" }
  );
  assert.deepEqual(
    resolveWorkbenchDockEntryClick({
      entry,
      matchedNodes: []
    }),
    { kind: "launch" }
  );
});

test("dock click resolution allows a dock entry to override a multi node type", () => {
  const entry: WorkbenchHostDockEntry = {
    icon: null,
    id: "workspace-app:calendar",
    instanceMode: "single",
    label: "Calendar",
    typeId: "workspace-app-webview"
  };

  assert.deepEqual(
    resolveWorkbenchDockEntryClick({
      entry,
      instanceMode: entry.instanceMode,
      matchedNodes: [
        makeNode(
          "workspace-app:calendar",
          "workspace-app-webview",
          "workspace-app:calendar"
        )
      ]
    }),
    {
      kind: "focus-node",
      nodeId: "workspace-app-webview:workspace-app:calendar"
    }
  );
});

test("dock click resolution can keep an entry on the launch path", () => {
  const entry: WorkbenchHostDockEntry = {
    clickBehavior: "launch",
    icon: null,
    id: "workspace-app:calendar",
    instanceMode: "single",
    label: "Calendar",
    typeId: "workspace-app-webview"
  };

  assert.deepEqual(
    resolveWorkbenchDockEntryClick({
      entry,
      instanceMode: entry.instanceMode,
      matchedNodes: [
        makeNode(
          "workspace-app:calendar",
          "workspace-app-webview",
          "workspace-app:calendar"
        )
      ]
    }),
    { kind: "launch" }
  );
});

test("dock click resolution can trigger host actions", () => {
  const entry: WorkbenchHostDockEntry = {
    clickActionId: "open-launchpad",
    icon: null,
    id: "launchpad",
    label: "Launchpad",
    typeId: "launchpad"
  };

  assert.deepEqual(
    resolveWorkbenchDockEntryClick({
      entry,
      matchedNodes: []
    }),
    { actionId: "open-launchpad", kind: "action" }
  );
});

test("dock action entries respect blocked entry state", () => {
  const entry: WorkbenchHostDockEntry = {
    clickActionId: "open-launchpad",
    icon: null,
    id: "launchpad",
    label: "Launchpad",
    state: {
      kind: "disabled"
    },
    typeId: "launchpad"
  };

  assert.deepEqual(
    resolveWorkbenchDockEntryClick({
      entry,
      matchedNodes: []
    }),
    { kind: "blocked" }
  );
});

test("dock click resolution toggles to minimize when node is already focused", () => {
  const entry: WorkbenchHostDockEntry = {
    icon: null,
    id: "agent:codex",
    label: "Codex",
    typeId: "agentGui"
  };

  const focusedNode = makeNode("agent-1", "agentGui", "agent:codex");

  // Node is focused (matches focusedNodeId) and not minimized → should minimize
  assert.deepEqual(
    resolveWorkbenchDockEntryClick({
      entry,
      focusedNodeId: focusedNode.id,
      instanceMode: "single",
      matchedNodes: [focusedNode]
    }),
    { kind: "minimize-node", nodeId: "agentGui:agent-1" }
  );
});

test("dock click resolution focuses node when it is minimized", () => {
  const entry: WorkbenchHostDockEntry = {
    icon: null,
    id: "agent:codex",
    label: "Codex",
    typeId: "agentGui"
  };

  const minimizedNode: WorkbenchNode<WorkbenchHostNodeData> = {
    ...makeNode("agent-1", "agentGui", "agent:codex"),
    isMinimized: true
  };

  // Node is minimized → should focus/restore even though focusedNodeId matches
  assert.deepEqual(
    resolveWorkbenchDockEntryClick({
      entry,
      focusedNodeId: minimizedNode.id,
      instanceMode: "single",
      matchedNodes: [minimizedNode]
    }),
    { kind: "focus-node", nodeId: "agentGui:agent-1" }
  );
});

test("dock click resolution focuses node when another node is focused", () => {
  const entry: WorkbenchHostDockEntry = {
    icon: null,
    id: "agent:codex",
    label: "Codex",
    typeId: "agentGui"
  };

  const node = makeNode("agent-1", "agentGui", "agent:codex");

  // A different node is focused → should focus this one
  assert.deepEqual(
    resolveWorkbenchDockEntryClick({
      entry,
      focusedNodeId: "agentGui:agent-other",
      instanceMode: "single",
      matchedNodes: [node]
    }),
    { kind: "focus-node", nodeId: "agentGui:agent-1" }
  );
});

test("dock click resolution defaults to focus when focusedNodeId is not provided", () => {
  const entry: WorkbenchHostDockEntry = {
    icon: null,
    id: "agent:codex",
    label: "Codex",
    typeId: "agentGui"
  };

  const node = makeNode("agent-1", "agentGui", "agent:codex");

  // No focusedNodeId provided → backward compatible, always focus
  assert.deepEqual(
    resolveWorkbenchDockEntryClick({
      entry,
      instanceMode: "single",
      matchedNodes: [node]
    }),
    { kind: "focus-node", nodeId: "agentGui:agent-1" }
  );
});

test("dock click resolution does not toggle minimize for null focusedNodeId", () => {
  const entry: WorkbenchHostDockEntry = {
    icon: null,
    id: "agent:codex",
    label: "Codex",
    typeId: "agentGui"
  };

  const node = makeNode("agent-1", "agentGui", "agent:codex");

  assert.deepEqual(
    resolveWorkbenchDockEntryClick({
      entry,
      focusedNodeId: null,
      instanceMode: "single",
      matchedNodes: [node]
    }),
    { kind: "focus-node", nodeId: "agentGui:agent-1" }
  );
});

function makeNode(
  instanceId: string,
  typeId: string,
  dockEntryId?: string
): WorkbenchNode<WorkbenchHostNodeData> {
  return {
    data: {
      dockEntryId: dockEntryId ?? null,
      instanceId,
      instanceKey: null,
      typeId
    },
    displayMode: "floating",
    frame: { x: 24, y: 24, width: 320, height: 220 },
    id: `${typeId}:${instanceId}`,
    isMinimized: false,
    kind: typeId,
    restoreFrame: null,
    title: `${typeId}:${instanceId}`
  };
}
