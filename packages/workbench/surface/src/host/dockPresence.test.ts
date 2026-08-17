import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchHostDockItem } from "./dockItems.ts";
import {
  resolveDockPresenceItems,
  resolveDockPresenceSettleMs,
  resolveNextDockItemPresence,
  type WorkbenchHostPresentDockItem
} from "./dockPresence.ts";
import type { WorkbenchMinimizedDockNode } from "./minimizedDockSlots.ts";

test("marks initial items present without an entrance transition", () => {
  const item = separator("separator:first");

  assert.equal(
    resolveNextDockItemPresence(item, false, undefined, no),
    "present"
  );
});

test("retains removed items in place while they exit", () => {
  const first = separator("first");
  const removed = separator("removed");
  const last = separator("last");
  const current = [first, removed, last].map(present);

  const next = resolveDockPresenceItems({
    current,
    initialized: true,
    nextSourceItems: [first, last],
    shouldAnimateMinimizedDockEnter: no
  });

  assert.deepEqual(
    next.map((item) => [item.key, item.presence]),
    [
      ["first", "present"],
      ["removed", "exiting"],
      ["last", "present"]
    ]
  );
});

test("turns a re-entering item back into an entrance transition", () => {
  const item = separator("entry:agent");

  assert.equal(
    resolveNextDockItemPresence(item, true, "exiting", no),
    "entering"
  );
});

test("only animates eligible minimized node slots", () => {
  const nodeItem = minimized("node-1");
  const stackItem: WorkbenchHostDockItem = {
    key: "minimized:minimized-stack",
    kind: "minimized",
    slot: {
      anchorKey: "minimized-stack",
      kind: "stack",
      nodes: [minimizedNode("node-1")]
    }
  };

  assert.equal(
    resolveNextDockItemPresence(
      nodeItem,
      true,
      undefined,
      (id) => id === "node-1"
    ),
    "entering"
  );
  assert.equal(
    resolveNextDockItemPresence(nodeItem, true, undefined, no),
    "present"
  );
  assert.equal(
    resolveNextDockItemPresence(stackItem, true, undefined, () => true),
    "present"
  );
});

test("uses the longer settle window whenever a minimized slot is moving", () => {
  const minimizedItem = minimized("node-1");
  const moving: WorkbenchHostPresentDockItem = {
    item: minimizedItem,
    key: minimizedItem.key,
    presence: "entering"
  };

  assert.equal(resolveDockPresenceSettleMs([moving]), 720);
  assert.equal(
    resolveDockPresenceSettleMs([
      {
        item: separator("entry:agent"),
        key: "entry:agent",
        presence: "entering"
      }
    ]),
    300
  );
});

function no(): boolean {
  return false;
}

function present(item: WorkbenchHostDockItem): WorkbenchHostPresentDockItem {
  return { item, key: item.key, presence: "present" };
}

function separator(key: string): WorkbenchHostDockItem {
  return { key, kind: "separator" };
}

function minimized(id: string): WorkbenchHostDockItem {
  return {
    key: `minimized:${id}`,
    kind: "minimized",
    slot: {
      anchorKey: `minimized:${id}`,
      kind: "node",
      node: minimizedNode(id)
    }
  };
}

function minimizedNode(id: string): WorkbenchMinimizedDockNode {
  return {
    data: { instanceId: id, typeId: "agent" },
    displayMode: "floating",
    frame: { height: 100, width: 100, x: 0, y: 0 },
    id,
    isMinimized: true,
    kind: "agent",
    restoreFrame: null,
    title: id
  };
}
