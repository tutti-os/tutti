import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkbenchHostNodeData,
  WorkbenchMissionControlAdapter,
  WorkbenchMissionControlSnapshot
} from "@tutti-os/workbench-surface";
import type { ReporterEventInput } from "../../../analytics/services/reporterService.interface.ts";
import { isWorkspaceMissionControlLayoutShortcut } from "../workspaceMissionControlShortcut.ts";
import { createWorkspaceMissionControlController } from "./workspaceMissionControlController.ts";

test("workspace mission control controller stays closed without an adapter", () => {
  const controller = createWorkspaceMissionControlController();

  controller.open();

  assert.deepEqual(controller.getSnapshot(), {
    canOpen: false,
    isLayoutLocked: false,
    isOpen: false,
    nodeIds: null,
    shortcutsEnabled: true,
    visibleWindowCount: 0
  });
});

test("workspace mission control controller requires multiple visible nodes", () => {
  const controller = createWorkspaceMissionControlController();
  controller.setAdapter(createMissionControlAdapter(1));

  controller.open();

  assert.deepEqual(controller.getSnapshot(), {
    canOpen: false,
    isLayoutLocked: false,
    isOpen: false,
    nodeIds: null,
    shortcutsEnabled: true,
    visibleWindowCount: 1
  });
});

test("workspace mission control controller opens and closes from snapshot state", () => {
  const controller = createWorkspaceMissionControlController();
  const notifications: boolean[] = [];
  controller.subscribe(() => {
    notifications.push(controller.getSnapshot().isOpen);
  });
  controller.setAdapter(createMissionControlAdapter(2));

  controller.open();
  assert.deepEqual(controller.getSnapshot(), {
    canOpen: true,
    isLayoutLocked: false,
    isOpen: true,
    nodeIds: null,
    shortcutsEnabled: false,
    visibleWindowCount: 2
  });

  controller.close();
  assert.deepEqual(controller.getSnapshot(), {
    canOpen: true,
    isLayoutLocked: false,
    isOpen: false,
    nodeIds: null,
    shortcutsEnabled: true,
    visibleWindowCount: 2
  });
  assert.deepEqual(notifications, [false, true, false]);
});

test("workspace mission control controller tracks activation", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const controller = createWorkspaceMissionControlController({
    reporterService: createReporterService(reporterCalls),
    reporterNow: () => 1749124800000
  });
  controller.setAdapter(createMissionControlAdapter(3));

  controller.open("keyboard");

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "mission_control.activated",
        params: {
          trigger: "keyboard",
          window_count: 3
        }
      }
    ]
  ]);
});

test("workspace mission control controller tracks deactivation duration", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  let now = 1749124800000;
  const controller = createWorkspaceMissionControlController({
    reporterService: createReporterService(reporterCalls),
    reporterNow: () => now
  });
  controller.setAdapter(createMissionControlAdapter(2));
  controller.open("button");

  now = 1749124800540;
  controller.close();

  assert.deepEqual(reporterCalls[1], [
    {
      clientTS: 1749124800540,
      name: "mission_control.deactivated",
      params: {
        duration_ms: 540
      }
    }
  ]);
});

test("workspace mission control controller closes when adapter is removed", () => {
  const controller = createWorkspaceMissionControlController();
  controller.setAdapter(createMissionControlAdapter(2));
  controller.open();

  controller.setAdapter(null);

  assert.deepEqual(controller.getSnapshot(), {
    canOpen: false,
    isLayoutLocked: false,
    isOpen: false,
    nodeIds: null,
    shortcutsEnabled: true,
    visibleWindowCount: 0
  });
});

test("workspace mission control controller follows adapter visible node updates", () => {
  const controller = createWorkspaceMissionControlController();
  const adapter = createMutableMissionControlAdapter(1);
  controller.setAdapter(adapter);

  assert.equal(controller.getSnapshot().canOpen, false);

  adapter.setVisibleNodeCount(3);

  assert.deepEqual(controller.getSnapshot(), {
    canOpen: true,
    isLayoutLocked: false,
    isOpen: false,
    nodeIds: null,
    shortcutsEnabled: true,
    visibleWindowCount: 3
  });
});

test("workspace mission control controller follows adapter locked layout updates", () => {
  const controller = createWorkspaceMissionControlController();
  const adapter = createMutableMissionControlAdapter(2);
  controller.setAdapter(adapter);

  assert.equal(controller.getSnapshot().isLayoutLocked, false);

  adapter.setLayoutLocked(true);

  assert.equal(controller.getSnapshot().isLayoutLocked, true);

  adapter.setLayoutLocked(false);

  assert.equal(controller.getSnapshot().isLayoutLocked, false);
});

test("workspace mission control controller unlocks the layout through the adapter", () => {
  const controller = createWorkspaceMissionControlController();
  const adapter = createMutableMissionControlAdapter(2);
  controller.setAdapter(adapter);
  adapter.setLayoutLocked(true);

  assert.equal(controller.getSnapshot().isLayoutLocked, true);

  controller.unlockLayout();

  assert.equal(controller.getSnapshot().isLayoutLocked, false);
});

test("workspace mission control controller scopes open requests to node ids", () => {
  const controller = createWorkspaceMissionControlController();
  controller.setAdapter(createMissionControlAdapter(4));

  controller.open({
    nodeIds: ["node-1", "node-3"],
    trigger: "button"
  });

  assert.deepEqual(controller.getSnapshot(), {
    canOpen: true,
    isLayoutLocked: false,
    isOpen: true,
    nodeIds: ["node-1", "node-3"],
    shortcutsEnabled: false,
    visibleWindowCount: 2
  });
});

test("workspace mission control layout shortcut accepts cmd or ctrl with 2", () => {
  assert.equal(
    isWorkspaceMissionControlLayoutShortcut({
      altKey: false,
      ctrlKey: false,
      key: "2",
      metaKey: true
    }),
    true
  );
  assert.equal(
    isWorkspaceMissionControlLayoutShortcut({
      altKey: false,
      ctrlKey: true,
      key: "2",
      metaKey: false
    }),
    true
  );
});

test("workspace mission control layout shortcut rejects unrelated combinations", () => {
  assert.equal(
    isWorkspaceMissionControlLayoutShortcut({
      altKey: true,
      ctrlKey: false,
      key: "2",
      metaKey: true
    }),
    false
  );
  assert.equal(
    isWorkspaceMissionControlLayoutShortcut({
      altKey: false,
      ctrlKey: false,
      key: "2",
      metaKey: false
    }),
    false
  );
  assert.equal(
    isWorkspaceMissionControlLayoutShortcut({
      altKey: false,
      ctrlKey: true,
      key: "1",
      metaKey: false
    }),
    false
  );
});

function createMissionControlAdapter(
  visibleNodeCount: number,
  options: { isLayoutLocked?: boolean } = {}
): WorkbenchMissionControlAdapter<WorkbenchHostNodeData> {
  return {
    applyLayoutPreset() {},
    releaseLockedLayout() {},
    getSnapshot() {
      return {
        isLayoutLocked: options.isLayoutLocked ?? false,
        layoutConstraints: {
          minHeight: 160,
          minWidth: 280,
          safeArea: {
            bottom: 88,
            left: 0,
            right: 0,
            top: 52
          },
          surfacePadding: 0
        },
        surfaceSize: {
          height: 600,
          width: 800
        },
        visibleNodes: Array.from({ length: visibleNodeCount }, (_, index) => ({
          id: `node-${index}`
        })) as unknown as WorkbenchMissionControlSnapshot<WorkbenchHostNodeData>["visibleNodes"]
      };
    },
    subscribe() {
      return () => {};
    }
  };
}

function createMutableMissionControlAdapter(visibleNodeCount: number) {
  let nextVisibleNodeCount = visibleNodeCount;
  let nextIsLayoutLocked = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const adapter = {
    ...createMissionControlAdapter(nextVisibleNodeCount),
    getSnapshot() {
      return createMissionControlAdapter(nextVisibleNodeCount, {
        isLayoutLocked: nextIsLayoutLocked
      }).getSnapshot();
    },
    setLayoutLocked(locked: boolean) {
      nextIsLayoutLocked = locked;
      notify();
    },
    releaseLockedLayout() {
      nextIsLayoutLocked = false;
      notify();
    },
    setVisibleNodeCount(count: number) {
      nextVisibleNodeCount = count;
      notify();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
  return adapter;
}

function createReporterService(calls: ReporterEventInput[][] = []) {
  return {
    async trackEvents(events: ReporterEventInput[]) {
      calls.push(events);
    }
  };
}
