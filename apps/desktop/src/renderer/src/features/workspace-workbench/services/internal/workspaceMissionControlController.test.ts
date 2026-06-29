import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkbenchHostNodeData,
  WorkbenchMissionControlAdapter,
  WorkbenchMissionControlSnapshot
} from "@tutti-os/workbench-surface";
import type { ReporterEventInput } from "../../../analytics/services/reporterService.interface.ts";
import {
  isWorkspaceAgentNewConversationShortcut,
  isWorkspaceMissionControlActivateShortcut,
  isWorkspaceMissionControlLayoutShortcut,
  isWorkspaceSettingsShortcut
} from "../workspaceMissionControlShortcut.ts";
import { createWorkspaceMissionControlController } from "./workspaceMissionControlController.ts";

test("workspace mission control controller stays closed without an adapter", () => {
  const controller = createWorkspaceMissionControlController();

  controller.open("activate");

  assert.deepEqual(controller.getSnapshot(), {
    canOpen: false,
    isOpen: false,
    mode: null,
    nodeIds: null,
    shortcutsEnabled: true,
    visibleWindowCount: 0
  });
});

test("workspace mission control controller requires multiple visible nodes", () => {
  const controller = createWorkspaceMissionControlController();
  controller.setAdapter(createMissionControlAdapter(1));

  controller.open("layout");

  assert.deepEqual(controller.getSnapshot(), {
    canOpen: false,
    isOpen: false,
    mode: null,
    nodeIds: null,
    shortcutsEnabled: true,
    visibleWindowCount: 1
  });
});

test("workspace mission control controller opens and closes from snapshot state", () => {
  const controller = createWorkspaceMissionControlController();
  const notifications: WorkspaceMissionControlSnapshotMode[] = [];
  controller.subscribe(() => {
    notifications.push(controller.getSnapshot().mode);
  });
  controller.setAdapter(createMissionControlAdapter(2));

  controller.open("activate");
  assert.deepEqual(controller.getSnapshot(), {
    canOpen: true,
    isOpen: true,
    mode: "activate",
    nodeIds: null,
    shortcutsEnabled: false,
    visibleWindowCount: 2
  });

  controller.close();
  assert.deepEqual(controller.getSnapshot(), {
    canOpen: true,
    isOpen: false,
    mode: null,
    nodeIds: null,
    shortcutsEnabled: true,
    visibleWindowCount: 2
  });
  assert.deepEqual(notifications, [null, "activate", null]);
});

test("workspace mission control controller tracks activation", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const controller = createWorkspaceMissionControlController({
    reporterService: createReporterService(reporterCalls),
    reporterNow: () => 1749124800000
  });
  controller.setAdapter(createMissionControlAdapter(3));

  controller.open("layout", "keyboard");

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "mission_control.activated",
        params: {
          mode: "layout",
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
  controller.open("activate", "button");

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
  controller.open("layout");

  controller.setAdapter(null);

  assert.deepEqual(controller.getSnapshot(), {
    canOpen: false,
    isOpen: false,
    mode: null,
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
    isOpen: false,
    mode: null,
    nodeIds: null,
    shortcutsEnabled: true,
    visibleWindowCount: 3
  });
});

test("workspace mission control controller scopes open requests to node ids", () => {
  const controller = createWorkspaceMissionControlController();
  controller.setAdapter(createMissionControlAdapter(4));

  controller.open("activate", {
    nodeIds: ["node-1", "node-3"],
    trigger: "button"
  });

  assert.deepEqual(controller.getSnapshot(), {
    canOpen: true,
    isOpen: true,
    mode: "activate",
    nodeIds: ["node-1", "node-3"],
    shortcutsEnabled: false,
    visibleWindowCount: 2
  });
});

test("workspace mission control activate shortcut accepts cmd or ctrl with 1", () => {
  assert.equal(
    isWorkspaceMissionControlActivateShortcut({
      altKey: false,
      ctrlKey: false,
      key: "1",
      metaKey: true
    }),
    true
  );
  assert.equal(
    isWorkspaceMissionControlActivateShortcut({
      altKey: false,
      ctrlKey: true,
      key: "1",
      metaKey: false
    }),
    true
  );
});

test("workspace mission control activate shortcut rejects unrelated combinations", () => {
  assert.equal(
    isWorkspaceMissionControlActivateShortcut({
      altKey: true,
      ctrlKey: false,
      key: "1",
      metaKey: true
    }),
    false
  );
  assert.equal(
    isWorkspaceMissionControlActivateShortcut({
      altKey: false,
      ctrlKey: false,
      key: "1",
      metaKey: false
    }),
    false
  );
  assert.equal(
    isWorkspaceMissionControlActivateShortcut({
      altKey: false,
      ctrlKey: true,
      key: "~",
      metaKey: false
    }),
    false
  );
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

test("workspace settings shortcut accepts cmd or ctrl with comma", () => {
  assert.equal(
    isWorkspaceSettingsShortcut({
      altKey: false,
      ctrlKey: false,
      key: ",",
      metaKey: true
    }),
    true
  );
  assert.equal(
    isWorkspaceSettingsShortcut({
      altKey: false,
      ctrlKey: true,
      key: ",",
      metaKey: false
    }),
    true
  );
});

test("workspace settings shortcut rejects unrelated combinations", () => {
  assert.equal(
    isWorkspaceSettingsShortcut({
      altKey: true,
      ctrlKey: false,
      key: ",",
      metaKey: true
    }),
    false
  );
  assert.equal(
    isWorkspaceSettingsShortcut({
      altKey: false,
      ctrlKey: false,
      key: ",",
      metaKey: false
    }),
    false
  );
  assert.equal(
    isWorkspaceSettingsShortcut({
      altKey: false,
      ctrlKey: true,
      key: "n",
      metaKey: false
    }),
    false
  );
});

test("workspace agent new conversation shortcut accepts cmd or ctrl with n", () => {
  assert.equal(
    isWorkspaceAgentNewConversationShortcut({
      altKey: false,
      ctrlKey: false,
      key: "n",
      metaKey: true
    }),
    true
  );
  assert.equal(
    isWorkspaceAgentNewConversationShortcut({
      altKey: false,
      ctrlKey: true,
      key: "N",
      metaKey: false
    }),
    true
  );
});

test("workspace agent new conversation shortcut rejects unrelated combinations", () => {
  assert.equal(
    isWorkspaceAgentNewConversationShortcut({
      altKey: true,
      ctrlKey: false,
      key: "n",
      metaKey: true
    }),
    false
  );
  assert.equal(
    isWorkspaceAgentNewConversationShortcut({
      altKey: false,
      ctrlKey: false,
      key: "n",
      metaKey: false
    }),
    false
  );
  assert.equal(
    isWorkspaceAgentNewConversationShortcut({
      altKey: false,
      ctrlKey: true,
      key: ",",
      metaKey: false
    }),
    false
  );
});

type WorkspaceMissionControlSnapshotMode = ReturnType<
  ReturnType<typeof createWorkspaceMissionControlController>["getSnapshot"]
>["mode"];

function createMissionControlAdapter(
  visibleNodeCount: number
): WorkbenchMissionControlAdapter<WorkbenchHostNodeData> {
  return {
    applyLayoutPreset() {},
    focusNode() {},
    getSnapshot() {
      return {
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
  const listeners = new Set<() => void>();
  const adapter = {
    ...createMissionControlAdapter(visibleNodeCount),
    getSnapshot() {
      return createMissionControlAdapter(nextVisibleNodeCount).getSnapshot();
    },
    setVisibleNodeCount(count: number) {
      nextVisibleNodeCount = count;
      for (const listener of listeners) {
        listener();
      }
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
