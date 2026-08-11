import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedWorkbenchHostDockEntry } from "./dockEntries.ts";
import {
  createWorkbenchHostDockItems,
  minimizedDockSlotNodes,
  resolveDockEntryInstanceMode,
  resolveWorkbenchHostDockItemsWidth
} from "./dockItems.ts";
import type {
  WorkbenchMinimizedDockNode,
  WorkbenchMinimizedDockSlot
} from "./minimizedDockSlots.ts";
import type {
  WorkbenchHostDockEntry,
  WorkbenchHostNodeDefinition
} from "./types.ts";

test("builds entry separators and minimized slots in source order", () => {
  const first = resolvedEntry("first", { separatorAfter: true });
  const second = resolvedEntry("second", {}, true);
  const node = minimizedNode("node-1");
  const minimizedSlot: WorkbenchMinimizedDockSlot = {
    anchorKey: "minimized:node-1",
    kind: "node",
    node
  };

  const items = createWorkbenchHostDockItems({
    minimizedDockSlots: [minimizedSlot],
    resolvedEntries: [first, second]
  });

  assert.deepEqual(
    items.map((item) => [item.kind, item.key]),
    [
      ["entry", "entry:first"],
      ["separator", "separator:after:first"],
      ["separator", "separator:before:second"],
      ["entry", "entry:second"],
      ["separator", "separator:minimized"],
      ["minimized", "minimized:minimized:node-1"]
    ]
  );
  assert.deepEqual(minimizedDockSlotNodes(minimizedSlot), [node]);
});

test("does not add the minimized separator without entry items", () => {
  const nodes = [minimizedNode("node-1"), minimizedNode("node-2")];
  const stack: WorkbenchMinimizedDockSlot = {
    anchorKey: "minimized-stack",
    kind: "stack",
    nodes
  };

  const items = createWorkbenchHostDockItems({
    minimizedDockSlots: [stack],
    resolvedEntries: []
  });

  assert.deepEqual(
    items.map((item) => item.key),
    ["minimized:minimized-stack"]
  );
  assert.deepEqual(minimizedDockSlotNodes(stack), nodes);
});

test("calculates the dock axis size from slots, separators, gaps, and padding", () => {
  const items = createWorkbenchHostDockItems({
    minimizedDockSlots: [],
    resolvedEntries: [
      resolvedEntry("first", { separatorAfter: true }),
      resolvedEntry("second")
    ]
  });

  assert.equal(resolveWorkbenchHostDockItemsWidth([]), 12.6);
  assert.equal(resolveWorkbenchHostDockItemsWidth(items), 128.7);
});

test("prefers an entry instance mode over its node definition", () => {
  const definitions = new Map<string, WorkbenchHostNodeDefinition>([
    [
      "agent",
      {
        instance: { mode: "single" },
        typeId: "agent"
      } as WorkbenchHostNodeDefinition
    ]
  ]);

  assert.equal(
    resolveDockEntryInstanceMode(
      {
        icon: null,
        id: "agent",
        instanceMode: "multi",
        label: "Agent",
        typeId: "agent"
      },
      definitions
    ),
    "multi"
  );
  assert.equal(
    resolveDockEntryInstanceMode(
      { icon: null, id: "agent", label: "Agent", typeId: "agent" },
      definitions
    ),
    "single"
  );
});

function resolvedEntry(
  id: string,
  overrides: Partial<WorkbenchHostDockEntry> = {},
  sectionBreakBefore = false
): ResolvedWorkbenchHostDockEntry {
  return {
    anchorKey: id,
    dockNodeState: "closed",
    entry: {
      icon: null,
      id,
      label: id,
      typeId: id,
      ...overrides
    },
    hasMatchingNodes: false,
    matchedNodes: [],
    sectionBreakBefore
  };
}

function minimizedNode(id: string): WorkbenchMinimizedDockNode {
  return {
    data: {
      instanceId: id,
      typeId: "agent"
    },
    displayMode: "floating",
    frame: { height: 100, width: 100, x: 0, y: 0 },
    id,
    isMinimized: true,
    kind: "agent",
    restoreFrame: null,
    title: id
  };
}
