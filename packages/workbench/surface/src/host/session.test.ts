import assert from "node:assert/strict";
import test from "node:test";
import {
  clampWorkbenchRect,
  getWorkbenchFullscreenRect
} from "../core/geometry.ts";
import { createWorkbenchSnapshotFromState } from "../core/snapshot.ts";
import { resolveWorkbenchCascadedRect } from "../core/placement.ts";
import {
  defaultWorkbenchLayoutConstraints,
  defaultWorkbenchSurfaceSize
} from "../core/types.ts";
import { createWorkbenchHostSession } from "./session.ts";
import {
  COMPACT_LAUNCH_FRAME_SCALE,
  closedDockWindowFramesMetadataKey,
  resolveCompactWorkbenchPreferredFrame
} from "./sessionState.ts";
import type { WorkbenchHostNodeDefinition } from "./types.ts";

const filesNodeDefinition: WorkbenchHostNodeDefinition = {
  frame: { x: 100, y: 80, width: 640, height: 480 },
  renderBody: () => null,
  title: "Files",
  typeId: "workspace-files"
};

const terminalNodeDefinition: WorkbenchHostNodeDefinition = {
  frame: { x: 180, y: 120, width: 720, height: 460 },
  renderBody: () => null,
  title: "Terminal",
  typeId: "terminal",
  window: {
    defaultOpen: false,
    restoreOnLoad: false
  }
};

const browserNodeDefinition: WorkbenchHostNodeDefinition = {
  frame: { x: 220, y: 130, width: 900, height: 560 },
  instance: {
    mode: "multi"
  },
  renderBody: () => null,
  title: "Browser",
  typeId: "browser",
  window: {
    defaultOpen: false,
    restoreOnLoad: true
  }
};

const agentGuiNodeDefinition: WorkbenchHostNodeDefinition = {
  frame: { x: 140, y: 48, width: 960, height: 620 },
  instance: {
    mode: "multi"
  },
  renderBody: () => null,
  title: "Agent",
  typeId: "agent-gui",
  window: {
    defaultOpen: false,
    restoreOnLoad: true
  }
};

test("load restores default singleton nodes for uninitialized snapshots", async () => {
  const session = createWorkbenchHostSession({
    nodes: [filesNodeDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState({
          nodeStack: [],
          nodes: []
        });
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();

  const snapshot = session.controller.getSnapshot();
  assert.equal(snapshot.nodes.length, 1);
  assert.equal(snapshot.nodes[0]?.id, "workspace-files");

  session.dispose();
});

test("load preserves an initialized empty snapshot without reopening defaults", async () => {
  const session = createWorkbenchHostSession({
    nodes: [filesNodeDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: [],
            nodes: []
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();

  const snapshot = session.controller.getSnapshot();
  assert.equal(snapshot.nodes.length, 0);

  session.dispose();
});

test("runtime node state stays out of the workbench host snapshot", async () => {
  let savedSnapshot = createWorkbenchSnapshotFromState({
    nodeStack: [],
    nodes: []
  });
  const repository = {
    async load() {
      return createWorkbenchSnapshotFromState({
        nodeStack: [],
        nodes: []
      });
    },
    save(
      _workspaceId: string,
      snapshot: ReturnType<typeof createWorkbenchSnapshotFromState>
    ) {
      savedSnapshot = snapshot;
      return snapshot;
    }
  };
  const session = createWorkbenchHostSession({
    nodes: [filesNodeDefinition],
    snapshotRepository: repository,
    workspaceId: "workspace-1"
  });

  await session.load();
  session.setNodeRuntimeState("workspace-files", {
    lastActiveAgentSessionId: "session-1"
  });
  session.dispose();

  assert.deepEqual(savedSnapshot.nodes[0]?.data, {
    dockEntryId: null,
    instanceId: "workspace-files",
    instanceKey: null,
    typeId: "workspace-files"
  });

  const restoredSession = createWorkbenchHostSession({
    nodes: [filesNodeDefinition],
    snapshotRepository: {
      async load() {
        return savedSnapshot;
      },
      save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await restoredSession.load();

  assert.equal(
    restoredSession.controller.getSnapshot().nodes[0]?.data.runtimeNodeState,
    undefined
  );
  restoredSession.dispose();
});

test("snapshot node state persists through the workbench host snapshot", async () => {
  let savedSnapshot = createWorkbenchSnapshotFromState({
    nodeStack: [],
    nodes: []
  });
  const repository = {
    async load() {
      return createWorkbenchSnapshotFromState({
        nodeStack: [],
        nodes: []
      });
    },
    save(
      _workspaceId: string,
      snapshot: ReturnType<typeof createWorkbenchSnapshotFromState>
    ) {
      savedSnapshot = snapshot;
      return snapshot;
    }
  };
  const session = createWorkbenchHostSession({
    nodes: [filesNodeDefinition],
    snapshotRepository: repository,
    workspaceId: "workspace-1"
  });

  await session.load();
  session.setSnapshotNodeState("workspace-files", {
    lastActiveAgentSessionId: "session-1"
  });
  session.dispose();

  assert.deepEqual(savedSnapshot.nodes[0]?.data, {
    dockEntryId: null,
    instanceId: "workspace-files",
    instanceKey: null,
    snapshotNodeState: {
      lastActiveAgentSessionId: "session-1"
    },
    typeId: "workspace-files"
  });

  const restoredSession = createWorkbenchHostSession({
    nodes: [filesNodeDefinition],
    snapshotRepository: {
      async load() {
        return savedSnapshot;
      },
      save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await restoredSession.load();

  assert.deepEqual(
    restoredSession.controller.getSnapshot().nodes[0]?.data.snapshotNodeState,
    {
      lastActiveAgentSessionId: "session-1"
    }
  );
  restoredSession.dispose();
});

test("external state persistence subscriptions ignore frame-only node updates", async () => {
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  const session = createWorkbenchHostSession({
    externalStateSource: {
      getNodeState() {
        return null;
      },
      getSnapshotNodeState() {
        return null;
      },
      getWorkspaceState() {
        return null;
      },
      subscribeNodeState() {
        subscribeCount += 1;
        return () => {
          unsubscribeCount += 1;
        };
      }
    },
    nodes: [filesNodeDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState({
          nodeStack: [],
          nodes: []
        });
      },
      save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  assert.equal(subscribeCount, 1);
  session.controller.commands.resizeNode("workspace-files", {
    height: 500,
    width: 650,
    x: 100,
    y: 80
  });

  assert.equal(subscribeCount, 1);
  assert.equal(unsubscribeCount, 0);
  session.controller.commands.closeNode("workspace-files");

  assert.equal(unsubscribeCount, 1);
  session.dispose();
});

test("setNodeTitle updates an existing workbench node title", async () => {
  const session = createWorkbenchHostSession({
    nodes: [filesNodeDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState({
          nodeStack: [],
          nodes: []
        });
      },
      save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.setNodeTitle("workspace-files", "Files localized");

  assert.equal(
    session.controller.getSnapshot().nodes[0]?.title,
    "Files localized"
  );
  session.dispose();
});

test("launch waits for initial snapshot load before opening a node", async () => {
  let resolveLoad!: (
    snapshot: ReturnType<typeof createWorkbenchSnapshotFromState>
  ) => void;
  const loadSnapshot = new Promise<
    ReturnType<typeof createWorkbenchSnapshotFromState>
  >((resolve) => {
    resolveLoad = resolve;
  });
  const session = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    snapshotRepository: {
      async load() {
        return await loadSnapshot;
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  const loadPromise = session.load();
  const launchPromise = session.launchNode({
    reason: "dock",
    typeId: "browser"
  });
  let launchSettled = false;
  void launchPromise.then(() => {
    launchSettled = true;
  });

  await Promise.resolve();
  assert.equal(launchSettled, false);
  assert.equal(session.controller.getSnapshot().nodes.length, 0);

  resolveLoad(
    createWorkbenchSnapshotFromState(
      {
        nodeStack: [],
        nodes: []
      },
      {
        metadata: {
          workbenchHostInitialized: true
        }
      }
    )
  );

  await loadPromise;
  const launchedId = await launchPromise;

  const snapshot = session.controller.getSnapshot();
  assert.equal(launchedId, "browser");
  assert.equal(snapshot.nodes.length, 1);
  assert.equal(snapshot.nodes[0]?.id, "browser");
  assert.deepEqual(snapshot.nodeStack, ["browser"]);

  session.dispose();
});

test("load can restart after dispose without reusing the disposed lifecycle", async () => {
  let resolveFirstLoad!: (
    snapshot: ReturnType<typeof createWorkbenchSnapshotFromState>
  ) => void;
  let resolveSecondLoad!: (
    snapshot: ReturnType<typeof createWorkbenchSnapshotFromState>
  ) => void;
  const firstLoadSnapshot = new Promise<
    ReturnType<typeof createWorkbenchSnapshotFromState>
  >((resolve) => {
    resolveFirstLoad = resolve;
  });
  const secondLoadSnapshot = new Promise<
    ReturnType<typeof createWorkbenchSnapshotFromState>
  >((resolve) => {
    resolveSecondLoad = resolve;
  });
  let loadCount = 0;
  const session = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    snapshotRepository: {
      async load() {
        loadCount += 1;
        return await (loadCount === 1 ? firstLoadSnapshot : secondLoadSnapshot);
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  const firstLoad = session.load();
  session.dispose();
  const secondLoad = session.load();

  resolveFirstLoad(
    createWorkbenchSnapshotFromState(
      {
        nodeStack: ["browser"],
        nodes: [
          {
            data: {
              instanceId: "browser",
              typeId: "browser"
            },
            displayMode: "floating",
            frame: { x: 10, y: 20, width: 800, height: 500 },
            id: "browser",
            isMinimized: false,
            kind: "browser",
            restoreFrame: null,
            title: "Old Browser"
          }
        ]
      },
      {
        metadata: {
          workbenchHostInitialized: true
        }
      }
    )
  );
  await firstLoad;
  assert.equal(session.controller.getSnapshot().nodes.length, 0);

  resolveSecondLoad(
    createWorkbenchSnapshotFromState(
      {
        nodeStack: [],
        nodes: []
      },
      {
        metadata: {
          workbenchHostInitialized: true
        }
      }
    )
  );
  await secondLoad;

  const launchedId = await session.launchNode({
    reason: "dock",
    typeId: "browser"
  });

  assert.equal(launchedId, "browser");
  assert.equal(session.controller.getSnapshot().nodes[0]?.id, "browser");

  session.dispose();
});

test("late final save completion cannot replace a restarted lifecycle snapshot", async () => {
  const lifecycleSnapshot = (lifecycle: string) =>
    createWorkbenchSnapshotFromState(
      {
        nodeStack: [],
        nodes: []
      },
      {
        activeSpaceId: `space-${lifecycle}`,
        metadata: {
          workbenchHostInitialized: true
        },
        spaces: [
          {
            id: `space-${lifecycle}`,
            name: lifecycle,
            nodeIds: []
          }
        ]
      }
    );
  let loadCount = 0;
  let saveCount = 0;
  let resolveFirstSave!: (
    snapshot: ReturnType<typeof lifecycleSnapshot>
  ) => void;
  const firstSave = new Promise<ReturnType<typeof lifecycleSnapshot>>(
    (resolve) => {
      resolveFirstSave = resolve;
    }
  );
  const savedSnapshots: Array<ReturnType<typeof lifecycleSnapshot>> = [];
  const session = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    snapshotRepository: {
      async load() {
        loadCount += 1;
        return lifecycleSnapshot(loadCount === 1 ? "first" : "second");
      },
      save(_workspaceId, snapshot) {
        saveCount += 1;
        savedSnapshots.push(snapshot);
        if (saveCount === 1) {
          return firstSave;
        }
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  await session.launchNode({ reason: "dock", typeId: "browser" });
  session.dispose();
  assert.equal(saveCount, 1);

  await session.load();
  const firstSavedSnapshot = savedSnapshots[0];
  assert.ok(firstSavedSnapshot);
  resolveFirstSave(firstSavedSnapshot);
  await Promise.resolve();

  await session.launchNode({ reason: "dock", typeId: "browser" });
  session.dispose();

  const secondSavedSnapshot = savedSnapshots[1];
  assert.ok(secondSavedSnapshot);
  assert.equal(secondSavedSnapshot.activeSpaceId, "space-second");
});

test("a synchronous repository save failure does not escape session disposal", async () => {
  const session = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          { nodeStack: [], nodes: [] },
          { metadata: { workbenchHostInitialized: true } }
        );
      },
      save() {
        throw new Error("synchronous save failure");
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  await session.launchNode({ reason: "dock", typeId: "browser" });

  assert.doesNotThrow(() => session.dispose());
  await Promise.resolve();
});

test("queued launch from a disposed lifecycle does not run in a restarted load", async () => {
  let resolveFirstLoad!: (
    snapshot: ReturnType<typeof createWorkbenchSnapshotFromState>
  ) => void;
  let resolveSecondLoad!: (
    snapshot: ReturnType<typeof createWorkbenchSnapshotFromState>
  ) => void;
  const firstLoadSnapshot = new Promise<
    ReturnType<typeof createWorkbenchSnapshotFromState>
  >((resolve) => {
    resolveFirstLoad = resolve;
  });
  const secondLoadSnapshot = new Promise<
    ReturnType<typeof createWorkbenchSnapshotFromState>
  >((resolve) => {
    resolveSecondLoad = resolve;
  });
  let loadCount = 0;
  const session = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    snapshotRepository: {
      async load() {
        loadCount += 1;
        return await (loadCount === 1 ? firstLoadSnapshot : secondLoadSnapshot);
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  const firstLoad = session.load();
  const staleLaunch = session.launchNode({
    reason: "dock",
    typeId: "browser"
  });

  session.dispose();
  const secondLoad = session.load();

  assert.equal(await staleLaunch, null);
  assert.equal(session.controller.getSnapshot().nodes.length, 0);

  resolveFirstLoad(
    createWorkbenchSnapshotFromState(
      {
        nodeStack: ["browser"],
        nodes: [
          {
            data: {
              instanceId: "browser",
              typeId: "browser"
            },
            displayMode: "floating",
            frame: { x: 10, y: 20, width: 800, height: 500 },
            id: "browser",
            isMinimized: false,
            kind: "browser",
            restoreFrame: null,
            title: "Stale Browser"
          }
        ]
      },
      {
        metadata: {
          workbenchHostInitialized: true
        }
      }
    )
  );
  await firstLoad;
  assert.equal(session.controller.getSnapshot().nodes.length, 0);

  resolveSecondLoad(
    createWorkbenchSnapshotFromState(
      {
        nodeStack: [],
        nodes: []
      },
      {
        metadata: {
          workbenchHostInitialized: true
        }
      }
    )
  );
  await secondLoad;
  assert.equal(session.controller.getSnapshot().nodes.length, 0);

  session.dispose();
});

test("queued launches continue after snapshot load fails", async () => {
  let rejectLoad!: (error: Error) => void;
  const loadSnapshot = new Promise<ReturnType<
    typeof createWorkbenchSnapshotFromState
  > | null>((_resolve, reject) => {
    rejectLoad = reject;
  });
  const session = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    snapshotRepository: {
      async load() {
        return await loadSnapshot;
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  const loadPromise = session.load();
  const launchPromise = session.launchNode({
    reason: "dock",
    typeId: "browser"
  });

  rejectLoad(new Error("snapshot unavailable"));
  await loadPromise;

  assert.equal(await launchPromise, "browser");
  assert.equal(session.controller.getSnapshot().nodes[0]?.id, "browser");

  session.dispose();
});

test("projected nodes appear from host presence with default shell state", async () => {
  const session = createWorkbenchHostSession({
    nodes: [terminalNodeDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: [],
            nodes: []
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.reconcileProjectedNodes([
    {
      defaultFrame: { x: 30, y: 40, width: 900, height: 520 },
      instanceId: "session-1",
      subject: {
        id: "session-1",
        type: "terminal-session"
      },
      title: "Terminal 1",
      typeId: "terminal"
    }
  ]);

  const node = session.controller.getSnapshot().nodes[0];
  assert.equal(node?.id, "terminal:session-1");
  assert.equal(node?.title, "Terminal 1");
  assert.deepEqual(node?.frame, { x: 30, y: 40, width: 900, height: 520 });
  assert.equal(node?.data.isProjected, true);
  assert.deepEqual(node?.data.projectionSubject, {
    id: "session-1",
    type: "terminal-session"
  });

  session.dispose();
});

test("projected nodes restore snapshot layout only while host projects them", async () => {
  const snapshot = createWorkbenchSnapshotFromState(
    {
      nodeStack: ["terminal:session-1"],
      nodes: [
        {
          data: {
            dockEntryId: "terminal",
            instanceId: "session-1",
            instanceKey: "workspace-terminal",
            typeId: "terminal"
          },
          displayMode: "fullscreen",
          frame: { x: 10, y: 20, width: 820, height: 560 },
          id: "terminal:session-1",
          isMinimized: true,
          kind: "terminal",
          restoreFrame: { x: 40, y: 50, width: 700, height: 430 },
          title: "Old Terminal"
        }
      ]
    },
    {
      metadata: {
        workbenchHostInitialized: true
      }
    }
  );
  const repository = {
    async load() {
      return snapshot;
    },
    async save(_workspaceId: string, savedSnapshot: typeof snapshot) {
      return savedSnapshot;
    }
  };
  const unprojectedSession = createWorkbenchHostSession({
    nodes: [terminalNodeDefinition],
    snapshotRepository: repository,
    workspaceId: "workspace-1"
  });

  await unprojectedSession.load();
  assert.equal(unprojectedSession.controller.getSnapshot().nodes.length, 0);
  unprojectedSession.dispose();

  const projectedSession = createWorkbenchHostSession({
    nodes: [terminalNodeDefinition],
    projectedNodes: [
      {
        instanceId: "session-1",
        instanceKey: "workspace-terminal",
        title: "Live Terminal",
        typeId: "terminal"
      }
    ],
    snapshotRepository: repository,
    workspaceId: "workspace-1"
  });

  await projectedSession.load();

  const node = projectedSession.controller.getSnapshot().nodes[0];
  assert.equal(node?.id, "terminal:session-1");
  assert.equal(node?.title, "Live Terminal");
  assert.equal(node?.displayMode, "fullscreen");
  assert.equal(node?.isMinimized, true);
  assert.deepEqual(node?.frame, { x: 10, y: 20, width: 820, height: 560 });
  assert.deepEqual(node?.restoreFrame, {
    x: 40,
    y: 50,
    width: 700,
    height: 430
  });
  assert.deepEqual(projectedSession.controller.getSnapshot().nodeStack, [
    "terminal:session-1"
  ]);

  projectedSession.dispose();
});

test("projected nodes persist only inert layout for live host projection", async () => {
  let savedSnapshot = createWorkbenchSnapshotFromState(
    {
      nodeStack: [],
      nodes: []
    },
    {
      metadata: {
        workbenchHostInitialized: true
      }
    }
  );
  const repository = {
    async load() {
      return savedSnapshot;
    },
    async save(_workspaceId: string, snapshot: typeof savedSnapshot) {
      savedSnapshot = snapshot;
      return snapshot;
    }
  };
  const projectedSession = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    projectedNodes: [
      {
        instanceId: "browser-1",
        title: "Google",
        typeId: "browser"
      }
    ],
    snapshotRepository: repository,
    workspaceId: "workspace-1"
  });

  await projectedSession.load();
  projectedSession.controller.commands.resizeNode("browser:browser-1", {
    x: 40,
    y: 50,
    width: 760,
    height: 480
  });
  projectedSession.dispose();

  assert.deepEqual(savedSnapshot.nodes[0]?.data, {
    dockEntryId: null,
    instanceId: "browser-1",
    instanceKey: null,
    isProjected: true,
    typeId: "browser"
  });

  const unprojectedSession = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    snapshotRepository: repository,
    workspaceId: "workspace-1"
  });
  await unprojectedSession.load();
  assert.equal(unprojectedSession.controller.getSnapshot().nodes.length, 0);
  unprojectedSession.dispose();

  const restoredProjectedSession = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    projectedNodes: [
      {
        instanceId: "browser-1",
        title: "Google",
        typeId: "browser"
      }
    ],
    snapshotRepository: repository,
    workspaceId: "workspace-1"
  });
  await restoredProjectedSession.load();
  const expectedFrame = clampWorkbenchRect(
    {
      x: 40,
      y: 50,
      width: 760,
      height: 480
    },
    defaultWorkbenchSurfaceSize,
    defaultWorkbenchLayoutConstraints
  );
  assert.deepEqual(
    restoredProjectedSession.controller.getSnapshot().nodes[0]?.frame,
    expectedFrame
  );
  restoredProjectedSession.dispose();
});

test("projected nodes disappear when host presence is removed", async () => {
  const session = createWorkbenchHostSession({
    nodes: [terminalNodeDefinition],
    projectedNodes: [
      {
        instanceId: "session-1",
        title: "Terminal 1",
        typeId: "terminal"
      }
    ],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: [],
            nodes: []
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  assert.equal(session.controller.getSnapshot().nodes.length, 1);

  session.reconcileProjectedNodes([]);

  assert.equal(session.controller.getSnapshot().nodes.length, 0);
  assert.deepEqual(session.controller.getSnapshot().nodeStack, []);

  session.dispose();
});

test("requestNodeClose closes nodes by default", async () => {
  const session = createWorkbenchHostSession({
    nodes: [filesNodeDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState({
          nodeStack: [],
          nodes: []
        });
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  assert.equal(session.controller.getSnapshot().nodes.length, 1);

  session.requestNodeClose("workspace-files");
  await Promise.resolve();

  assert.equal(session.controller.getSnapshot().nodes.length, 0);

  session.dispose();
});

test("host session retains node lease while a node exists", async () => {
  let leaseCreates = 0;
  let leaseReleases = 0;
  const leasedDefinition: WorkbenchHostNodeDefinition = {
    createLease() {
      leaseCreates += 1;
      return {
        release() {
          leaseReleases += 1;
        }
      };
    },
    frame: { x: 100, y: 80, width: 640, height: 480 },
    renderBody: () => null,
    title: "Files",
    typeId: "workspace-files"
  };
  const session = createWorkbenchHostSession({
    nodes: [leasedDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState({
          nodeStack: [],
          nodes: []
        });
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  assert.equal(leaseCreates, 1);
  assert.equal(leaseReleases, 0);

  session.requestNodeClose("workspace-files");
  await Promise.resolve();

  assert.equal(leaseCreates, 1);
  assert.equal(leaseReleases, 1);

  session.dispose();
});

test("host session does not create node leases before load", () => {
  let leaseCreates = 0;
  let leaseReleases = 0;
  const leasedDefinition: WorkbenchHostNodeDefinition = {
    createLease() {
      leaseCreates += 1;
      return {
        release() {
          leaseReleases += 1;
        }
      };
    },
    frame: { x: 100, y: 80, width: 640, height: 480 },
    renderBody: () => null,
    title: "Files",
    typeId: "workspace-files"
  };
  const session = createWorkbenchHostSession({
    nodes: [leasedDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState({
          nodeStack: [],
          nodes: []
        });
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  assert.equal(leaseCreates, 0);
  assert.equal(leaseReleases, 0);

  session.dispose();
  assert.equal(leaseReleases, 0);
});

test("host session does not recreate an existing node lease during load reconciliation", async () => {
  let leaseCreates = 0;
  let leaseReleases = 0;
  const leasedDefinition: WorkbenchHostNodeDefinition = {
    createLease() {
      leaseCreates += 1;
      return {
        release() {
          leaseReleases += 1;
        }
      };
    },
    frame: { x: 100, y: 80, width: 640, height: 480 },
    renderBody: () => null,
    title: "Files",
    typeId: "workspace-files"
  };
  const session = createWorkbenchHostSession({
    nodes: [leasedDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState({
          nodeStack: [],
          nodes: []
        });
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();

  assert.equal(leaseCreates, 1);
  assert.equal(leaseReleases, 0);

  session.dispose();
  assert.equal(leaseReleases, 1);
});

test("requestNodeClose keeps projected shells when host has no close policy", async () => {
  const session = createWorkbenchHostSession({
    nodes: [terminalNodeDefinition],
    projectedNodes: [
      {
        instanceId: "session-1",
        title: "Terminal 1",
        typeId: "terminal"
      }
    ],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: [],
            nodes: []
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.requestNodeClose("terminal:session-1");
  await Promise.resolve();

  assert.equal(session.controller.getSnapshot().nodes.length, 1);
  assert.equal(
    session.controller.getSnapshot().nodes[0]?.id,
    "terminal:session-1"
  );

  session.dispose();
});

test("requestNodeClose keeps shell visible when host rejects close", async () => {
  const closeRequests: string[] = [];
  const session = createWorkbenchHostSession({
    nodes: [terminalNodeDefinition],
    onNodeCloseRequest(request) {
      closeRequests.push(`${request.typeId}:${request.instanceId}`);
      return "keep-open";
    },
    projectedNodes: [
      {
        instanceId: "session-1",
        title: "Terminal 1",
        typeId: "terminal"
      }
    ],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: [],
            nodes: []
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.requestNodeClose("terminal:session-1");
  await Promise.resolve();

  assert.deepEqual(closeRequests, ["terminal:session-1"]);
  assert.equal(session.controller.getSnapshot().nodes.length, 1);
  assert.equal(
    session.controller.getSnapshot().nodes[0]?.id,
    "terminal:session-1"
  );

  session.dispose();
});

test("requestNodeClose closes shell when host accepts close", async () => {
  const session = createWorkbenchHostSession({
    nodes: [terminalNodeDefinition],
    onNodeCloseRequest(request) {
      assert.equal(request.isProjected, true);
      assert.equal(request.subject?.id, "session-1");
      return "close";
    },
    projectedNodes: [
      {
        instanceId: "session-1",
        subject: {
          id: "session-1",
          type: "terminal-session"
        },
        title: "Terminal 1",
        typeId: "terminal"
      }
    ],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: [],
            nodes: []
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.requestNodeClose("terminal:session-1");
  await Promise.resolve();

  assert.equal(session.controller.getSnapshot().nodes.length, 0);

  session.dispose();
});

test("collectWindowCloseEffects gathers effect contributors from live nodes", async () => {
  const session = createWorkbenchHostSession({
    externalStateSource: {
      getNodeState(input) {
        if (input.nodeId === "workspace-files") {
          return {
            dirty: true
          };
        }
        return null;
      },
      getWorkspaceState() {
        return null;
      }
    },
    nodes: [
      {
        frame: { x: 100, y: 80, width: 640, height: 480 },
        getWindowCloseEffect({ externalNodeState, node }) {
          const state = externalNodeState as { dirty?: boolean } | null;
          if (!state?.dirty) {
            return null;
          }
          return {
            description: "Unsaved changes",
            nodeId: node.id,
            title: node.title,
            typeId: node.data.typeId
          };
        },
        renderBody: () => null,
        title: "Files",
        typeId: "workspace-files"
      }
    ],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState({
          nodeStack: [],
          nodes: []
        });
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();

  assert.deepEqual(await session.collectWindowCloseEffects(), [
    {
      description: "Unsaved changes",
      nodeId: "workspace-files",
      title: "Files",
      typeId: "workspace-files"
    }
  ]);

  session.dispose();
});

test("activateNode delivers transient activation to an existing node", async () => {
  const session = createWorkbenchHostSession({
    nodes: [filesNodeDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState({
          nodeStack: [],
          nodes: []
        });
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.controller.commands.minimizeNode("workspace-files");

  session.activateNode(
    { nodeId: "workspace-files" },
    {
      payload: {
        path: "/workspace/demo.txt"
      },
      type: "reveal-file"
    }
  );

  const node = session.controller.getSnapshot().nodes[0];
  assert.equal(node?.isMinimized, false);
  assert.deepEqual(node?.data.activation, {
    payload: {
      path: "/workspace/demo.txt"
    },
    sequence: 1,
    type: "reveal-file"
  });

  session.dispose();
});

test("clearNodeActivation only clears the matching activation sequence", async () => {
  const session = createWorkbenchHostSession({
    nodes: [filesNodeDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState({
          nodeStack: [],
          nodes: []
        });
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.activateNode(
    { nodeId: "workspace-files" },
    {
      payload: {
        path: "/workspace/first.txt"
      },
      type: "reveal-file"
    }
  );
  session.activateNode(
    { nodeId: "workspace-files" },
    {
      payload: {
        path: "/workspace/second.txt"
      },
      type: "reveal-file"
    }
  );

  session.clearNodeActivation?.("workspace-files", 1);
  assert.deepEqual(session.controller.getSnapshot().nodes[0]?.data.activation, {
    payload: {
      path: "/workspace/second.txt"
    },
    sequence: 2,
    type: "reveal-file"
  });

  session.clearNodeActivation?.("workspace-files", 2);
  assert.equal(
    session.controller.getSnapshot().nodes[0]?.data.activation,
    null
  );

  session.dispose();
});

test("activateNode can target singleton nodes by type id", async () => {
  const session = createWorkbenchHostSession({
    nodes: [filesNodeDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState({
          nodeStack: [],
          nodes: []
        });
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.activateNode(
    { typeId: "workspace-files" },
    {
      type: "refresh"
    }
  );

  assert.deepEqual(session.controller.getSnapshot().nodes[0]?.data.activation, {
    sequence: 1,
    type: "refresh"
  });

  session.dispose();
});

test("restored floating nodes compact once when the first real surface size is below 1440", async () => {
  const session = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: ["browser:browser-1"],
            nodes: [
              {
                data: {
                  instanceId: "browser-1",
                  typeId: "browser"
                },
                displayMode: "floating",
                frame: { x: 220, y: 130, width: 900, height: 560 },
                id: "browser:browser-1",
                isMinimized: false,
                kind: "browser",
                restoreFrame: null,
                title: "Browser"
              }
            ]
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.controller.commands.setSurfaceSize({ width: 1280, height: 800 });

  const expectedFrame = resolveCompactWorkbenchPreferredFrame({
    constraints: session.controller.getSnapshot().layoutConstraints,
    preferredFrame: browserNodeDefinition.frame,
    surfaceSize: session.controller.getSnapshot().surfaceSize
  });
  assert.deepEqual(
    session.controller.getSnapshot().nodes[0]?.frame,
    expectedFrame
  );

  session.controller.commands.setSurfaceSize({ width: 1366, height: 820 });
  assert.deepEqual(
    session.controller.getSnapshot().nodes[0]?.frame,
    expectedFrame
  );

  session.dispose();
});

test("restored floating nodes smaller than the compact cap are not enlarged or shrunk", async () => {
  const restoredFrame = { x: 80, y: 100, width: 600, height: 360 };
  const session = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: ["browser:browser-1"],
            nodes: [
              {
                data: {
                  instanceId: "browser-1",
                  typeId: "browser"
                },
                displayMode: "floating",
                frame: restoredFrame,
                id: "browser:browser-1",
                isMinimized: false,
                kind: "browser",
                restoreFrame: null,
                title: "Browser"
              }
            ]
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.controller.commands.setSurfaceSize({ width: 1280, height: 800 });

  assert.deepEqual(
    session.controller.getSnapshot().nodes[0]?.frame,
    restoredFrame
  );

  session.dispose();
});

test("legacy floating snapshots clamp into a smaller wide surface", async () => {
  const session = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: ["browser:browser-1"],
            nodes: [
              {
                data: {
                  instanceId: "browser-1",
                  typeId: "browser"
                },
                displayMode: "floating",
                frame: { x: 1700, y: 100, width: 900, height: 560 },
                id: "browser:browser-1",
                isMinimized: false,
                kind: "browser",
                restoreFrame: null,
                title: "Browser"
              }
            ]
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.controller.commands.setSurfaceSize({ width: 1600, height: 900 });

  assert.deepEqual(session.controller.getSnapshot().nodes[0]?.frame, {
    x: 700,
    y: 100,
    width: 900,
    height: 560
  });

  session.dispose();
});

test("restored fullscreen nodes keep fullscreen sizing below 1440", async () => {
  const session = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: ["browser:browser-1"],
            nodes: [
              {
                data: {
                  instanceId: "browser-1",
                  typeId: "browser"
                },
                displayMode: "fullscreen",
                frame: { x: 0, y: 52, width: 900, height: 560 },
                id: "browser:browser-1",
                isMinimized: false,
                kind: "browser",
                restoreFrame: browserNodeDefinition.frame,
                title: "Browser"
              }
            ]
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.controller.commands.setSurfaceSize({ width: 1280, height: 800 });

  assert.deepEqual(
    session.controller.getSnapshot().nodes[0]?.frame,
    getWorkbenchFullscreenRect(
      session.controller.getSnapshot().surfaceSize,
      session.controller.getSnapshot().layoutConstraints
    )
  );

  session.dispose();
});

test("restored fullscreen nodes migrate their restore frame from the persisted layout basis", async () => {
  const session = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            layoutConstraints: defaultWorkbenchLayoutConstraints,
            nodeStack: ["browser:browser-1"],
            nodes: [
              {
                data: {
                  instanceId: "browser-1",
                  typeId: "browser"
                },
                displayMode: "fullscreen",
                frame: { x: 0, y: 52, width: 1512, height: 845 },
                id: "browser:browser-1",
                isMinimized: false,
                kind: "browser",
                restoreFrame: {
                  x: 151.2,
                  y: 127.7,
                  width: 907.2,
                  height: 454.2
                },
                title: "Browser"
              }
            ],
            surfaceSize: { width: 1512, height: 897 }
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.controller.commands.setSurfaceSize({ width: 1210, height: 759 });

  assert.deepEqual(session.controller.getSnapshot().nodes[0]?.frame, {
    x: 0,
    y: 52,
    width: 1210,
    height: 707
  });
  assert.deepEqual(session.controller.getSnapshot().nodes[0]?.restoreFrame, {
    x: 121,
    y: 113.9,
    width: 726,
    height: 371.4
  });

  session.exitFullscreenNode("browser:browser-1");
  assert.deepEqual(session.controller.getSnapshot().nodes[0]?.frame, {
    x: 121,
    y: 113.9,
    width: 726,
    height: 371.4
  });

  session.dispose();
});

test("restored oversized floating nodes migrate once from their persisted frame", async () => {
  const session = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            layoutConstraints: defaultWorkbenchLayoutConstraints,
            nodeStack: ["browser:browser-1"],
            nodes: [
              {
                data: {
                  instanceId: "browser-1",
                  typeId: "browser"
                },
                displayMode: "floating",
                frame: {
                  x: 100,
                  y: 105,
                  width: 1800,
                  height: 954
                },
                id: "browser:browser-1",
                isMinimized: false,
                kind: "browser",
                restoreFrame: null,
                title: "Browser"
              }
            ],
            surfaceSize: { width: 2000, height: 1200 }
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.controller.commands.setSurfaceSize({ width: 1000, height: 700 });

  assert.deepEqual(session.controller.getSnapshot().nodes[0]?.frame, {
    x: 50,
    y: 80,
    width: 900,
    height: 504
  });

  session.dispose();
});

test("legacy fullscreen snapshots clamp stale restore frames without a layout basis", async () => {
  const session = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: ["browser:browser-1"],
            nodes: [
              {
                data: {
                  instanceId: "browser-1",
                  typeId: "browser"
                },
                displayMode: "fullscreen",
                frame: { x: 0, y: 52, width: 2048, height: 1100 },
                id: "browser:browser-1",
                isMinimized: false,
                kind: "browser",
                restoreFrame: {
                  x: 221,
                  y: 83,
                  width: 1480,
                  height: 792
                },
                title: "Browser"
              }
            ]
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.controller.commands.setSurfaceSize({ width: 1210, height: 759 });
  session.exitFullscreenNode("browser:browser-1");

  assert.deepEqual(session.controller.getSnapshot().nodes[0]?.frame, {
    x: 0,
    y: 52,
    width: 1210,
    height: 619
  });

  session.dispose();
});

test("restores layout after the first measured surface matches the controller default", async () => {
  const session = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            layoutConstraints: defaultWorkbenchLayoutConstraints,
            nodeStack: ["browser:browser-1"],
            nodes: [
              {
                data: {
                  instanceId: "browser-1",
                  typeId: "browser"
                },
                displayMode: "fullscreen",
                frame: { x: 0, y: 52, width: 1512, height: 845 },
                id: "browser:browser-1",
                isMinimized: false,
                kind: "browser",
                restoreFrame: {
                  x: 151.2,
                  y: 127.7,
                  width: 907.2,
                  height: 454.2
                },
                title: "Browser"
              }
            ],
            surfaceSize: { width: 1512, height: 897 }
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.controller.commands.setSurfaceSize(defaultWorkbenchSurfaceSize);

  assert.deepEqual(session.controller.getSnapshot().nodes[0]?.restoreFrame, {
    x: 102.4,
    y: 110,
    width: 614.4,
    height: 348
  });

  session.dispose();
});

test("launchNode asks host to create backing instance before opening shell", async () => {
  const launchRequests: Array<{
    dockEntryId?: string;
    layoutConstraints: typeof defaultWorkbenchLayoutConstraints;
    payload?: unknown;
    reason: string;
    surfaceSize: typeof defaultWorkbenchSurfaceSize;
    typeId: string;
    workspaceId: string;
  }> = [];
  const session = createWorkbenchHostSession({
    nodes: [terminalNodeDefinition],
    async onLaunchRequest(request) {
      launchRequests.push({
        dockEntryId: request.dockEntryId,
        layoutConstraints: request.layoutConstraints,
        payload: request.payload,
        reason: request.reason,
        surfaceSize: request.surfaceSize,
        typeId: request.typeId,
        workspaceId: request.workspaceId
      });
      return {
        activation: {
          payload: {
            paneId: "pane-1"
          },
          type: "focus-pane"
        },
        defaultFrame: { x: 44, y: 55, width: 880, height: 520 },
        dockEntryId: "dock:terminal",
        instanceId: "session-1",
        instanceKey: "workspace-terminal",
        framePolicy: "absolute",
        title: "Terminal 1",
        typeId: "terminal"
      };
    },
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: [],
            nodes: []
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  const nodeId = await session.launchNode({
    dockEntryId: "dock:terminal",
    payload: {
      provider: "codex"
    },
    reason: "dock",
    typeId: "terminal"
  });

  assert.equal(nodeId, "terminal:session-1");
  assert.deepEqual(launchRequests, [
    {
      dockEntryId: "dock:terminal",
      layoutConstraints: defaultWorkbenchLayoutConstraints,
      payload: {
        provider: "codex"
      },
      reason: "dock",
      surfaceSize: defaultWorkbenchSurfaceSize,
      typeId: "terminal",
      workspaceId: "workspace-1"
    }
  ]);
  const node = session.controller.getSnapshot().nodes[0];
  assert.equal(node?.title, "Terminal 1");
  assert.deepEqual(node?.frame, { x: 44, y: 55, width: 880, height: 520 });
  assert.deepEqual(node?.data.activation, {
    payload: {
      paneId: "pane-1"
    },
    sequence: 1,
    type: "focus-pane"
  });
  assert.equal(node?.data.dockEntryId, "dock:terminal");

  session.dispose();
});

test("launchNode restores the last manually resized dock window frame after close", async () => {
  let savedSnapshot = createWorkbenchSnapshotFromState(
    {
      nodeStack: [],
      nodes: []
    },
    {
      metadata: {
        workbenchHostInitialized: true
      }
    }
  );
  const repository = {
    async load() {
      return savedSnapshot;
    },
    async save(
      _workspaceId: string,
      snapshot: ReturnType<typeof createWorkbenchSnapshotFromState>
    ) {
      savedSnapshot = snapshot;
      return snapshot;
    }
  };
  const createSession = () =>
    createWorkbenchHostSession({
      nodes: [terminalNodeDefinition],
      onLaunchRequest(request) {
        return {
          defaultFrame: { x: 44, y: 55, width: 720, height: 460 },
          dockEntryId: request.dockEntryId,
          framePolicy: "cascade",
          instanceId: "session-1",
          title: "Terminal 1",
          typeId: "terminal"
        };
      },
      snapshotRepository: repository,
      workspaceId: "workspace-1"
    });

  const firstSession = createSession();
  await firstSession.load();
  firstSession.controller.commands.setSurfaceSize({
    width: 1600,
    height: 1000
  });
  const firstNodeId = await firstSession.launchNode({
    dockEntryId: "dock:terminal",
    reason: "dock",
    typeId: "terminal"
  });
  assert.equal(firstNodeId, "terminal:session-1");
  firstSession.controller.commands.resizeNode(firstNodeId, {
    x: 70,
    y: 75,
    width: 900,
    height: 600
  });
  firstSession.closeNode(firstNodeId);
  firstSession.dispose();

  const secondSession = createSession();
  await secondSession.load();
  secondSession.controller.commands.setSurfaceSize({
    width: 1600,
    height: 1000
  });
  const secondNodeId = await secondSession.launchNode({
    dockEntryId: "dock:terminal",
    reason: "dock",
    typeId: "terminal"
  });
  const restoredNode = secondSession.controller
    .getSnapshot()
    .nodes.find((node) => node.id === secondNodeId);

  assert.equal(secondNodeId, "terminal:session-1");
  assert.deepEqual(
    {
      height: restoredNode?.frame.height,
      width: restoredNode?.frame.width
    },
    {
      height: 600,
      width: 900
    }
  );

  secondSession.dispose();
});

test("launchNode logs host launch failures without opening a shell", async () => {
  const diagnostics: unknown[] = [];
  const session = createWorkbenchHostSession({
    debugDiagnostics: {
      isEnabled: () => false,
      log(input) {
        diagnostics.push(input);
      }
    },
    nodes: [terminalNodeDefinition],
    async onLaunchRequest() {
      throw new Error("launch exploded");
    },
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: [],
            nodes: []
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  const nodeId = await session.launchNode({
    dockEntryId: "dock:terminal",
    payload: {
      provider: "codex"
    },
    reason: "dock",
    typeId: "terminal"
  });

  assert.equal(nodeId, null);
  assert.equal(session.controller.getSnapshot().nodes.length, 0);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(
    {
      ...(diagnostics[0] as Record<string, unknown>),
      details: {
        ...(diagnostics[0] as { details: Record<string, unknown> }).details,
        error: {
          message: "launch exploded",
          name: "Error",
          stack: Boolean(
            (
              (diagnostics[0] as { details: { error: { stack?: unknown } } })
                .details.error.stack as string | undefined
            )?.includes("launch exploded")
          )
        }
      }
    },
    {
      details: {
        dockEntryId: "dock:terminal",
        error: {
          message: "launch exploded",
          name: "Error",
          stack: true
        },
        launchSource: "dock",
        payload: '{"provider":"codex"}',
        reason: "dock",
        typeId: "terminal"
      },
      event: "host.launch.failed",
      level: "error",
      source: "workbench-host",
      workspaceId: "workspace-1"
    }
  );

  session.dispose();
});

test("launchNode applies host node size constraints", async () => {
  const session = createWorkbenchHostSession({
    nodes: [terminalNodeDefinition],
    async onLaunchRequest() {
      return {
        defaultFrame: { x: 44, y: 55, width: 320, height: 220 },
        framePolicy: "cascade",
        instanceId: "session-1",
        sizeConstraints: { minHeight: 520, minWidth: 720 },
        typeId: "terminal"
      };
    },
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: [],
            nodes: []
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  const nodeId = await session.launchNode({
    reason: "dock",
    typeId: "terminal"
  });

  assert.equal(nodeId, "terminal:session-1");
  const node = session.controller.getSnapshot().nodes[0];
  assert.deepEqual(node?.sizeConstraints, {
    minHeight: 520,
    minWidth: 720
  });
  assert.deepEqual(node?.frame, {
    x: 304,
    y: 112,
    width: 720,
    height: 520
  });

  session.dispose();
});

test("launchNode stores launch source on opened node data", async () => {
  const session = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    onLaunchRequest(request) {
      return {
        dockEntryId: request.dockEntryId,
        framePolicy: "cascade",
        instanceId: "browser-1",
        launchSource: request.launchSource,
        typeId: "browser"
      };
    },
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: [],
            nodes: []
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  const nodeId = await session.launchNode({
    dockEntryId: "browser",
    launchSource: "launchpad",
    reason: "launchpad",
    typeId: "browser"
  });

  const node = session.controller
    .getSnapshot()
    .nodes.find((candidate) => candidate.id === nodeId);
  assert.equal(node?.data.launchSource, "launchpad");

  session.dispose();
});

test("launchNode cascades default frame from the active node", async () => {
  const session = createWorkbenchHostSession({
    nodes: [filesNodeDefinition, browserNodeDefinition],
    onLaunchRequest() {
      return {
        framePolicy: "cascade",
        instanceId: "browser-1",
        typeId: "browser"
      };
    },
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState({
          nodeStack: [],
          nodes: []
        });
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  const expectedFrame = resolveWorkbenchCascadedRect({
    constraints: session.controller.getSnapshot().layoutConstraints,
    currentNodeStack: session.controller.getSnapshot().nodeStack,
    existingNodes: session.controller.getSnapshot().nodes,
    preferredFrame: resolveCompactWorkbenchPreferredFrame({
      constraints: session.controller.getSnapshot().layoutConstraints,
      preferredFrame: browserNodeDefinition.frame,
      surfaceSize: session.controller.getSnapshot().surfaceSize
    }),
    surfaceSize: session.controller.getSnapshot().surfaceSize
  });
  const nodeId = await session.launchNode({
    reason: "dock",
    typeId: "browser"
  });

  assert.equal(nodeId, "browser:browser-1");
  const node = session.controller
    .getSnapshot()
    .nodes.find((entry) => entry.id === nodeId);
  assert.deepEqual(node?.frame, expectedFrame);

  session.dispose();
});

test("launchNode cascades resized windows when the host requests cascade frame policy", async () => {
  const session = createWorkbenchHostSession({
    nodes: [filesNodeDefinition, browserNodeDefinition],
    onLaunchRequest() {
      return {
        defaultFrame: { x: 0, y: 0, width: 980, height: 640 },
        instanceId: "browser-1",
        framePolicy: "cascade",
        typeId: "browser"
      };
    },
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState({
          nodeStack: [],
          nodes: []
        });
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  const expectedFrame = resolveWorkbenchCascadedRect({
    constraints: session.controller.getSnapshot().layoutConstraints,
    currentNodeStack: session.controller.getSnapshot().nodeStack,
    existingNodes: session.controller.getSnapshot().nodes,
    preferredFrame: resolveCompactWorkbenchPreferredFrame({
      constraints: session.controller.getSnapshot().layoutConstraints,
      preferredFrame: { x: 0, y: 0, width: 980, height: 640 },
      surfaceSize: session.controller.getSnapshot().surfaceSize
    }),
    surfaceSize: session.controller.getSnapshot().surfaceSize
  });
  const nodeId = await session.launchNode({
    reason: "dock",
    typeId: "browser"
  });

  assert.equal(nodeId, "browser:browser-1");
  const node = session.controller
    .getSnapshot()
    .nodes.find((entry) => entry.id === nodeId);
  assert.deepEqual(node?.frame, expectedFrame);

  session.dispose();
});

test("launchNode compacts cascade default frames below the 1440 width threshold", async () => {
  const session = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    onLaunchRequest() {
      return {
        defaultFrame: browserNodeDefinition.frame,
        instanceId: "browser-1",
        framePolicy: "cascade",
        typeId: "browser"
      };
    },
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: [],
            nodes: []
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.controller.commands.setSurfaceSize({ width: 1280, height: 800 });
  const expectedFrame = resolveCompactWorkbenchPreferredFrame({
    constraints: session.controller.getSnapshot().layoutConstraints,
    preferredFrame: browserNodeDefinition.frame,
    surfaceSize: session.controller.getSnapshot().surfaceSize
  });
  const nodeId = await session.launchNode({
    reason: "dock",
    typeId: "browser"
  });

  const node = session.controller
    .getSnapshot()
    .nodes.find((entry) => entry.id === nodeId);
  assert.equal(node?.frame.width, Math.round(900 * COMPACT_LAUNCH_FRAME_SCALE));
  assert.equal(
    node?.frame.height,
    Math.round(560 * COMPACT_LAUNCH_FRAME_SCALE)
  );
  assert.deepEqual(node?.frame, expectedFrame);

  session.dispose();
});

test("launchNode keeps cascade default frames at and above the 1440 width threshold", async () => {
  const session = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    onLaunchRequest() {
      return {
        defaultFrame: browserNodeDefinition.frame,
        instanceId: "browser-1",
        framePolicy: "cascade",
        typeId: "browser"
      };
    },
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: [],
            nodes: []
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.controller.commands.setSurfaceSize({ width: 1440, height: 900 });
  const nodeId = await session.launchNode({
    reason: "dock",
    typeId: "browser"
  });

  const node = session.controller
    .getSnapshot()
    .nodes.find((entry) => entry.id === nodeId);
  assert.deepEqual(node?.frame, browserNodeDefinition.frame);

  session.dispose();
});

test("launchNode centers the first same-type-centered cascade window", async () => {
  const session = createWorkbenchHostSession({
    nodes: [filesNodeDefinition, agentGuiNodeDefinition],
    onLaunchRequest() {
      return {
        defaultFrame: agentGuiNodeDefinition.frame,
        instanceId: "agent-gui:codex",
        framePolicy: "cascade-same-type-centered",
        typeId: "agent-gui"
      };
    },
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: ["workspace-files"],
            nodes: [
              {
                data: {
                  instanceId: "workspace-files",
                  typeId: "workspace-files"
                },
                displayMode: "floating",
                frame: { x: 120, y: 90, width: 640, height: 480 },
                id: "workspace-files",
                isMinimized: false,
                kind: "workspace-files",
                restoreFrame: null,
                title: "Files"
              }
            ]
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  const snapshot = session.controller.getSnapshot();
  const expectedFrame = resolveCompactWorkbenchPreferredFrame({
    constraints: snapshot.layoutConstraints,
    preferredFrame: agentGuiNodeDefinition.frame,
    surfaceSize: snapshot.surfaceSize
  });
  const nodeId = await session.launchNode({
    reason: "dock",
    typeId: "agent-gui"
  });

  const node = session.controller
    .getSnapshot()
    .nodes.find((entry) => entry.id === nodeId);
  assert.deepEqual(node?.frame, expectedFrame);

  session.dispose();
});

test("launchNode offsets later same-type-centered cascade windows by same type", async () => {
  const firstAgentFrame = { x: 132, y: 84, width: 960, height: 620 };
  const session = createWorkbenchHostSession({
    nodes: [filesNodeDefinition, agentGuiNodeDefinition],
    onLaunchRequest() {
      return {
        defaultFrame: agentGuiNodeDefinition.frame,
        instanceId: "agent-gui:openclaw",
        framePolicy: "cascade-same-type-centered",
        typeId: "agent-gui"
      };
    },
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: ["workspace-files", "agent-gui:agent-gui:codex"],
            nodes: [
              {
                data: {
                  instanceId: "workspace-files",
                  typeId: "workspace-files"
                },
                displayMode: "floating",
                frame: { x: 40, y: 60, width: 640, height: 480 },
                id: "workspace-files",
                isMinimized: false,
                kind: "workspace-files",
                restoreFrame: null,
                title: "Files"
              },
              {
                data: {
                  instanceId: "agent-gui:codex",
                  typeId: "agent-gui"
                },
                displayMode: "floating",
                frame: firstAgentFrame,
                id: "agent-gui:agent-gui:codex",
                isMinimized: false,
                kind: "agent-gui",
                restoreFrame: null,
                title: "Codex"
              }
            ]
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  const snapshot = session.controller.getSnapshot();
  const centeredPreferredFrame = resolveCompactWorkbenchPreferredFrame({
    constraints: snapshot.layoutConstraints,
    preferredFrame: agentGuiNodeDefinition.frame,
    surfaceSize: snapshot.surfaceSize
  });
  const expectedFrame = resolveWorkbenchCascadedRect({
    constraints: snapshot.layoutConstraints,
    currentNodeStack: ["agent-gui:agent-gui:codex"],
    existingNodes: snapshot.nodes.filter(
      (node) => node.data.typeId === "agent-gui"
    ),
    preferredFrame: centeredPreferredFrame,
    surfaceSize: snapshot.surfaceSize
  });
  const nodeId = await session.launchNode({
    reason: "dock",
    typeId: "agent-gui"
  });

  const node = session.controller
    .getSnapshot()
    .nodes.find((entry) => entry.id === nodeId);
  assert.notDeepEqual(node?.frame, centeredPreferredFrame);
  assert.deepEqual(node?.frame, expectedFrame);

  session.dispose();
});

test("launchNode applies custom same-type cascade offsets", async () => {
  const firstAgentFrame = { x: 140, y: 48, width: 1040, height: 538 };
  const session = createWorkbenchHostSession({
    nodes: [agentGuiNodeDefinition],
    onLaunchRequest() {
      return {
        cascadeOffset: { x: 180, y: 88 },
        defaultFrame: firstAgentFrame,
        instanceId: "agent-gui:codex:panel:new",
        framePolicy: "cascade-same-type-centered",
        typeId: "agent-gui"
      };
    },
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: ["agent-gui:agent-gui:codex:panel:existing"],
            nodes: [
              {
                data: {
                  instanceId: "agent-gui:codex:panel:existing",
                  typeId: "agent-gui"
                },
                displayMode: "floating",
                frame: firstAgentFrame,
                id: "agent-gui:agent-gui:codex:panel:existing",
                isMinimized: false,
                kind: "agent-gui",
                restoreFrame: null,
                title: "Codex"
              }
            ]
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.controller.commands.setSurfaceSize({ width: 1440, height: 900 });
  const nodeId = await session.launchNode({
    reason: "host",
    typeId: "agent-gui"
  });

  const node = session.controller
    .getSnapshot()
    .nodes.find((entry) => entry.id === nodeId);
  assert.deepEqual(node?.frame, { x: 320, y: 140, width: 1040, height: 538 });

  session.dispose();
});

test("launchNode skips closed dock frames when dock entry reuse is disabled", async () => {
  const closedDockFrame = { x: 657, y: 126, width: 884, height: 476 };
  const preferredFrame = { x: 140, y: 48, width: 1040, height: 538 };
  const session = createWorkbenchHostSession({
    nodes: [agentGuiNodeDefinition],
    onLaunchRequest() {
      return {
        cascadeOffset: { x: 180, y: 88 },
        defaultFrame: preferredFrame,
        dockEntryId: "agent-gui",
        instanceId: "agent-gui:codex:panel:new",
        framePolicy: "cascade-same-type-centered",
        reuseDockEntryNode: false,
        typeId: "agent-gui"
      };
    },
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: [],
            nodes: []
          },
          {
            metadata: {
              [closedDockWindowFramesMetadataKey]: {
                version: 1,
                entries: [
                  {
                    dockEntryId: "agent-gui",
                    frame: closedDockFrame,
                    typeId: "agent-gui"
                  }
                ]
              },
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.controller.commands.setSurfaceSize({ width: 1440, height: 900 });
  const nodeId = await session.launchNode({
    reason: "host",
    typeId: "agent-gui"
  });

  const node = session.controller
    .getSnapshot()
    .nodes.find((entry) => entry.id === nodeId);
  assert.notDeepEqual(node?.frame, closedDockFrame);
  assert.deepEqual(node?.frame, { x: 200, y: 163, width: 1040, height: 538 });

  session.dispose();
});

test("launchNode preserves a resized existing window's frame when the host asks to preserve it", async () => {
  const customAgentFrame = { x: 28, y: 64, width: 1200, height: 820 };
  const session = createWorkbenchHostSession({
    nodes: [filesNodeDefinition, agentGuiNodeDefinition],
    onLaunchRequest() {
      return {
        defaultFrame: agentGuiNodeDefinition.frame,
        instanceId: "agent-gui:codex",
        framePolicy: "cascade-same-type-centered",
        preserveExistingNodeFrame: true,
        typeId: "agent-gui"
      };
    },
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: ["agent-gui:agent-gui:codex"],
            nodes: [
              {
                data: {
                  instanceId: "agent-gui:codex",
                  typeId: "agent-gui"
                },
                displayMode: "floating",
                frame: customAgentFrame,
                id: "agent-gui:agent-gui:codex",
                isMinimized: false,
                kind: "agent-gui",
                restoreFrame: null,
                title: "Codex"
              }
            ]
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  const nodeId = await session.launchNode({
    reason: "host",
    typeId: "agent-gui"
  });

  const node = session.controller
    .getSnapshot()
    .nodes.find((entry) => entry.id === nodeId);
  // Regression test for a bug where clicking a completion notification to
  // focus an already-open conversation window reset it back to the default
  // frame instead of leaving the user's current size/position alone.
  assert.deepEqual(node?.frame, customAgentFrame);

  session.dispose();
});

test("launchNode recenters an existing same-type-centered cascade window", async () => {
  const staleAgentFrame = { x: 28, y: 64, width: 960, height: 620 };
  const session = createWorkbenchHostSession({
    nodes: [filesNodeDefinition, agentGuiNodeDefinition],
    onLaunchRequest() {
      return {
        defaultFrame: agentGuiNodeDefinition.frame,
        instanceId: "agent-gui:codex",
        framePolicy: "cascade-same-type-centered",
        typeId: "agent-gui"
      };
    },
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: ["agent-gui:agent-gui:codex"],
            nodes: [
              {
                data: {
                  instanceId: "agent-gui:codex",
                  typeId: "agent-gui"
                },
                displayMode: "floating",
                frame: staleAgentFrame,
                id: "agent-gui:agent-gui:codex",
                isMinimized: false,
                kind: "agent-gui",
                restoreFrame: null,
                title: "Codex"
              }
            ]
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  const snapshot = session.controller.getSnapshot();
  const expectedFrame = resolveCompactWorkbenchPreferredFrame({
    constraints: snapshot.layoutConstraints,
    preferredFrame: agentGuiNodeDefinition.frame,
    surfaceSize: snapshot.surfaceSize
  });
  const nodeId = await session.launchNode({
    reason: "dock",
    typeId: "agent-gui"
  });

  const node = session.controller
    .getSnapshot()
    .nodes.find((entry) => entry.id === nodeId);
  assert.notDeepEqual(staleAgentFrame, expectedFrame);
  assert.deepEqual(node?.frame, expectedFrame);

  session.dispose();
});

test("launchNode can open a host result in fullscreen display mode", async () => {
  const session = createWorkbenchHostSession({
    nodes: [browserNodeDefinition],
    onLaunchRequest() {
      return {
        defaultFrame: { x: 44, y: 55, width: 880, height: 520 },
        displayMode: "fullscreen",
        instanceId: "browser-1",
        framePolicy: "absolute",
        typeId: "browser"
      };
    },
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState({
          nodeStack: [],
          nodes: []
        });
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  const expectedFrame = getWorkbenchFullscreenRect(
    session.controller.getSnapshot().surfaceSize,
    session.controller.getSnapshot().layoutConstraints
  );
  const nodeId = await session.launchNode({
    reason: "dock",
    typeId: "browser"
  });

  assert.equal(nodeId, "browser:browser-1");
  const node = session.controller
    .getSnapshot()
    .nodes.find((entry) => entry.id === nodeId);
  assert.equal(node?.displayMode, "fullscreen");
  assert.deepEqual(node?.frame, expectedFrame);
  assert.deepEqual(node?.restoreFrame, {
    x: 44,
    y: 55,
    width: 880,
    height: 520
  });

  session.dispose();
});

test("launchNode preserves host-specified frame when the host requests absolute frame policy", async () => {
  const session = createWorkbenchHostSession({
    nodes: [filesNodeDefinition, terminalNodeDefinition],
    onLaunchRequest() {
      return {
        defaultFrame: { x: 44, y: 55, width: 880, height: 520 },
        instanceId: "session-1",
        framePolicy: "absolute",
        title: "Terminal 1",
        typeId: "terminal"
      };
    },
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState({
          nodeStack: [],
          nodes: []
        });
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  const nodeId = await session.launchNode({
    reason: "dock",
    typeId: "terminal"
  });

  assert.equal(nodeId, "terminal:session-1");
  const node = session.controller
    .getSnapshot()
    .nodes.find((entry) => entry.id === nodeId);
  assert.deepEqual(node?.frame, { x: 44, y: 55, width: 880, height: 520 });

  session.dispose();
});

test("launchNode keeps host-controlled absolute frames even when they overflow the surface", async () => {
  const session = createWorkbenchHostSession({
    nodes: [filesNodeDefinition, terminalNodeDefinition],
    onLaunchRequest() {
      return {
        defaultFrame: { x: -120, y: 700, width: 880, height: 520 },
        instanceId: "session-1",
        framePolicy: "absolute",
        title: "Terminal 1",
        typeId: "terminal"
      };
    },
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState({
          nodeStack: [],
          nodes: []
        });
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  const nodeId = await session.launchNode({
    reason: "dock",
    typeId: "terminal"
  });

  assert.equal(nodeId, "terminal:session-1");
  const node = session.controller
    .getSnapshot()
    .nodes.find((entry) => entry.id === nodeId);
  assert.deepEqual(node?.frame, { x: -120, y: 700, width: 880, height: 520 });

  session.dispose();
});

test("launchNode reuses existing shell returned by host", async () => {
  const session = createWorkbenchHostSession({
    nodes: [terminalNodeDefinition],
    onLaunchRequest() {
      return {
        activation: {
          payload: {
            paneId: "pane-2"
          },
          type: "focus-pane"
        },
        framePolicy: "cascade",
        instanceId: "session-1",
        title: "Terminal 1",
        typeId: "terminal"
      };
    },
    projectedNodes: [
      {
        instanceId: "session-1",
        title: "Terminal 1",
        typeId: "terminal"
      }
    ],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: [],
            nodes: []
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  const nodeId = await session.launchNode({
    reason: "command",
    typeId: "terminal"
  });

  assert.equal(nodeId, "terminal:session-1");
  assert.equal(session.controller.getSnapshot().nodes.length, 1);
  assert.deepEqual(session.controller.getSnapshot().nodes[0]?.data.activation, {
    payload: {
      paneId: "pane-2"
    },
    sequence: 1,
    type: "focus-pane"
  });

  session.dispose();
});

test("launchNode can reuse and activate an existing dock entry shell", async () => {
  const existingNodeId = "agent-gui:agent-gui:codex:panel:old";
  const existingFrame = { x: 28, y: 64, width: 900, height: 560 };
  const session = createWorkbenchHostSession({
    nodes: [agentGuiNodeDefinition],
    onLaunchRequest() {
      return {
        activation: {
          payload: {
            agentSessionId: "session-2"
          },
          type: "agent-gui:open-session"
        },
        defaultFrame: agentGuiNodeDefinition.frame,
        dockEntryId: "agent-gui",
        framePolicy: "cascade-same-type-centered",
        instanceId: "agent-gui:codex:session:session-2",
        reuseDockEntryNode: true,
        title: "Codex",
        typeId: "agent-gui"
      };
    },
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: [existingNodeId],
            nodes: [
              {
                data: {
                  dockEntryId: "agent-gui",
                  instanceId: "agent-gui:codex:panel:old",
                  typeId: "agent-gui"
                },
                displayMode: "floating",
                frame: existingFrame,
                id: existingNodeId,
                isMinimized: true,
                kind: "agent-gui",
                minimizedAtUnixMs: 1720000000000,
                restoreFrame: null,
                title: "Codex"
              }
            ]
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  const nodeId = await session.launchNode({
    dockEntryId: "agent-gui",
    reason: "host",
    typeId: "agent-gui"
  });

  const snapshot = session.controller.getSnapshot();
  assert.equal(nodeId, existingNodeId);
  assert.equal(snapshot.nodes.length, 1);
  assert.equal(snapshot.nodes[0]?.isMinimized, false);
  assert.deepEqual(snapshot.nodes[0]?.frame, existingFrame);
  assert.deepEqual(snapshot.nodeStack, [existingNodeId]);
  assert.deepEqual(snapshot.nodes[0]?.data.activation, {
    payload: {
      agentSessionId: "session-2"
    },
    sequence: 1,
    type: "agent-gui:open-session"
  });

  session.dispose();
});

test("launchNode does not open a shell when host returns no result", async () => {
  const session = createWorkbenchHostSession({
    nodes: [terminalNodeDefinition],
    onLaunchRequest() {
      return null;
    },
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: [],
            nodes: []
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  const nodeId = await session.launchNode({
    reason: "dock",
    typeId: "terminal"
  });

  assert.equal(nodeId, null);
  assert.equal(session.controller.getSnapshot().nodes.length, 0);

  session.dispose();
});

test("launchNode defaults to a singleton shell when no host handler is provided", async () => {
  const session = createWorkbenchHostSession({
    nodes: [filesNodeDefinition],
    snapshotRepository: {
      async load() {
        return createWorkbenchSnapshotFromState(
          {
            nodeStack: [],
            nodes: []
          },
          {
            metadata: {
              workbenchHostInitialized: true
            }
          }
        );
      },
      async save(_workspaceId, snapshot) {
        return snapshot;
      }
    },
    workspaceId: "workspace-1"
  });

  await session.load();
  session.controller.commands.minimizeNode("workspace-files");

  const nodeId = await session.launchNode({
    reason: "dock",
    typeId: "workspace-files"
  });

  assert.equal(nodeId, "workspace-files");
  assert.equal(session.controller.getSnapshot().nodes.length, 1);
  assert.equal(session.controller.getSnapshot().nodes[0]?.isMinimized, false);

  session.dispose();
});
