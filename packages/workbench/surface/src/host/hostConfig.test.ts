import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWorkbenchHostConfig,
  resolveWorkbenchHostDockEntries,
  resolveWorkbenchHostRuntimeConfig
} from "./hostConfig.ts";
import type {
  WorkbenchContribution,
  WorkbenchHostDockEntry,
  WorkbenchHostLaunchRequest,
  WorkbenchHostLaunchResult,
  WorkbenchHostNodeDefinition
} from "./types.ts";

test("resolveWorkbenchHostConfig keeps explicit node and dock overrides last", () => {
  const contributionNode = createNodeDefinition("browser", "Contribution");
  const explicitNode = createNodeDefinition("browser", "Explicit");
  const contributionDockEntry = createDockEntry("browser", "Contribution");
  const explicitDockEntry = createDockEntry("browser", "Explicit");

  const resolved = resolveWorkbenchHostConfig({
    contributions: [
      {
        dockEntries: [contributionDockEntry],
        id: "browser",
        nodes: [contributionNode]
      }
    ],
    dockEntries: [explicitDockEntry],
    nodes: [explicitNode]
  });

  assert.deepEqual(resolved.nodes, [explicitNode]);
  assert.deepEqual(resolved.dockEntries, [explicitDockEntry]);
});

test("resolveWorkbenchHostConfig supports contribution-only nodes and dock entries", () => {
  const terminalNode = createNodeDefinition("terminal", "Terminal");
  const terminalDockEntry = createDockEntry("terminal", "Terminal");

  const resolved = resolveWorkbenchHostConfig({
    contributions: [
      {
        dockEntries: [terminalDockEntry],
        id: "terminal",
        nodes: [terminalNode]
      }
    ]
  });

  assert.deepEqual(resolved.nodes, [terminalNode]);
  assert.deepEqual(resolved.dockEntries, [terminalDockEntry]);
});

test("resolveWorkbenchHostDockEntries merges dock entries without touching runtime config inputs", () => {
  const browserDockEntry = createDockEntry("browser", "Browser");
  const explicitDockEntry = createDockEntry("terminal", "Terminal");

  const resolved = resolveWorkbenchHostDockEntries({
    contributions: [
      {
        dockEntries: [browserDockEntry],
        id: "browser"
      }
    ],
    dockEntries: [explicitDockEntry]
  });

  assert.deepEqual(resolved, [browserDockEntry, explicitDockEntry]);
});

test("resolveWorkbenchHostDockEntries applies presentation overrides without reordering merged entries", () => {
  const browserDockEntry = createDockEntry("browser", "Browser");
  const terminalDockEntry = createDockEntry("terminal", "Terminal");

  const resolved = resolveWorkbenchHostDockEntries({
    contributions: [
      {
        dockEntries: [browserDockEntry, terminalDockEntry],
        id: "tools"
      }
    ],
    dockEntryPresentationOverrides: {
      browser: {
        dockRetention: {
          actionId: "dock-retention:browser",
          retained: false
        },
        visibility: "when-open"
      }
    }
  });

  assert.deepEqual(
    resolved.map((entry) => entry.id),
    ["browser", "terminal"]
  );
  assert.deepEqual(resolved[0], {
    ...browserDockEntry,
    dockRetention: {
      actionId: "dock-retention:browser",
      retained: false
    },
    visibility: "when-open"
  });
  assert.equal(resolved[1], terminalDockEntry);
});

test("resolveWorkbenchHostRuntimeConfig supports contribution-only nodes", () => {
  const terminalNode = createNodeDefinition("terminal", "Terminal");

  const resolved = resolveWorkbenchHostRuntimeConfig({
    contributions: [
      {
        id: "terminal",
        nodes: [terminalNode]
      }
    ]
  });

  assert.deepEqual(resolved.nodes, [terminalNode]);
});

test("resolveWorkbenchHostConfig combines contribution external state in order", () => {
  let subscribeCount = 0;
  let disposeCount = 0;
  const resolved = resolveWorkbenchHostConfig({
    contributions: [
      {
        externalStateSource: {
          getNodeState() {
            return null;
          },
          getSnapshotNodeState() {
            return null;
          },
          getWorkspaceState() {
            return undefined;
          },
          subscribe() {
            subscribeCount += 1;
            return () => {
              disposeCount += 1;
            };
          }
        },
        id: "empty"
      },
      {
        externalStateSource: {
          getNodeState() {
            return { title: "Browser" };
          },
          getSnapshotNodeState() {
            return { title: "Persisted Browser" };
          },
          getWorkspaceState() {
            return { workspaceId: "workspace-1" };
          },
          subscribe() {
            subscribeCount += 1;
            return () => {
              disposeCount += 1;
            };
          }
        },
        id: "browser"
      }
    ]
  });

  assert.deepEqual(
    resolved.externalStateSource?.getNodeState({
      instanceId: "browser-1",
      nodeId: "browser:browser-1",
      typeId: "browser",
      workspaceId: "workspace-1"
    }),
    { title: "Browser" }
  );
  assert.deepEqual(
    resolved.externalStateSource?.getWorkspaceState({
      workspaceId: "workspace-1"
    }),
    { workspaceId: "workspace-1" }
  );
  assert.deepEqual(
    resolved.externalStateSource?.getSnapshotNodeState?.({
      instanceId: "browser-1",
      nodeId: "browser:browser-1",
      typeId: "browser",
      workspaceId: "workspace-1"
    }),
    { title: "Persisted Browser" }
  );

  const dispose = resolved.externalStateSource?.subscribe?.(() => {});
  assert.equal(subscribeCount, 2);
  dispose?.();
  assert.equal(disposeCount, 2);
});

test("resolveWorkbenchHostConfig gives explicit external state source full precedence", () => {
  const explicitState = {
    getNodeState() {
      return { source: "explicit" };
    },
    getWorkspaceState() {
      return { source: "explicit" };
    }
  };

  const resolved = resolveWorkbenchHostConfig({
    contributions: [
      {
        externalStateSource: {
          getNodeState() {
            return { source: "contribution" };
          },
          getWorkspaceState() {
            return { source: "contribution" };
          }
        },
        id: "browser"
      }
    ],
    externalStateSource: explicitState
  });

  assert.equal(resolved.externalStateSource, explicitState);
});

test("resolveWorkbenchHostConfig runs explicit launch handler before contributions", async () => {
  const calls: string[] = [];
  const resolved = resolveWorkbenchHostConfig({
    contributions: [
      createLaunchContribution("browser", calls, {
        dockEntryId: "browser",
        framePolicy: "cascade",
        instanceId: "browser-1",
        typeId: "browser"
      })
    ],
    onLaunchRequest: (request) => {
      calls.push("explicit");
      return request.typeId === "browser"
        ? null
        : {
            dockEntryId: "files",
            framePolicy: "absolute",
            instanceId: "files",
            typeId: "files"
          };
    }
  });

  assert.deepEqual(
    await resolved.onLaunchRequest?.({
      ...createLaunchRequestContext(),
      reason: "dock",
      typeId: "browser",
      workspaceId: "workspace-1"
    }),
    {
      dockEntryId: "browser",
      framePolicy: "cascade",
      instanceId: "browser-1",
      typeId: "browser"
    }
  );
  assert.deepEqual(calls, ["explicit", "browser"]);

  calls.length = 0;
  assert.deepEqual(
    await resolved.onLaunchRequest?.({
      ...createLaunchRequestContext(),
      reason: "dock",
      typeId: "files",
      workspaceId: "workspace-1"
    }),
    {
      dockEntryId: "files",
      framePolicy: "absolute",
      instanceId: "files",
      typeId: "files"
    }
  );
  assert.deepEqual(calls, ["explicit"]);
});

test("resolveWorkbenchHostConfig runs close handlers until a decision is returned", async () => {
  const calls: string[] = [];
  const resolved = resolveWorkbenchHostConfig({
    contributions: [
      {
        id: "noop",
        onNodeCloseRequest() {
          calls.push("noop");
          return undefined;
        }
      },
      {
        id: "terminal",
        onNodeCloseRequest() {
          calls.push("terminal");
          return "keep-open";
        }
      }
    ]
  });

  assert.equal(
    await resolved.onNodeCloseRequest?.({
      instanceId: "terminal-1",
      isProjected: false,
      nodeId: "terminal:terminal-1",
      typeId: "terminal",
      workspaceId: "workspace-1"
    }),
    "keep-open"
  );
  assert.deepEqual(calls, ["noop", "terminal"]);
});

test("resolveWorkbenchHostConfig composes host close preparers in contribution order", async () => {
  const calls: string[] = [];
  const resolved = resolveWorkbenchHostConfig({
    contributions: [
      {
        id: "first",
        prepareHostClose() {
          calls.push("first");
          return true;
        }
      },
      {
        id: "second",
        prepareHostClose() {
          calls.push("second");
          return false;
        }
      },
      {
        id: "third",
        prepareHostClose() {
          calls.push("third");
          return true;
        }
      }
    ]
  });

  assert.equal(
    await resolved.prepareHostClose?.({
      host: {} as never,
      workspaceId: "workspace-1"
    }),
    false
  );
  assert.deepEqual(calls, ["first", "second"]);
});

function createNodeDefinition(
  typeId: string,
  title: string
): WorkbenchHostNodeDefinition {
  return {
    frame: { height: 480, width: 640, x: 10, y: 20 },
    renderBody: () => null,
    title,
    typeId
  };
}

function createDockEntry(id: string, label: string): WorkbenchHostDockEntry {
  return {
    icon: null,
    id,
    label,
    typeId: id
  };
}

function createLaunchRequestContext(): Pick<
  WorkbenchHostLaunchRequest,
  "layoutConstraints" | "surfaceSize"
> {
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
      height: 720,
      width: 1024
    }
  };
}

function createLaunchContribution(
  id: string,
  calls: string[],
  result: WorkbenchHostLaunchResult
): WorkbenchContribution {
  return {
    id,
    onLaunchRequest() {
      calls.push(id);
      return result;
    }
  };
}
