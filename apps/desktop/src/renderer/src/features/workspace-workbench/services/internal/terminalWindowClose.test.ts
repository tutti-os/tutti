import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import { closeWindowTerminalNodes } from "./terminalWindowClose.ts";

test("closeWindowTerminalNodes terminates idle terminal sessions before closing the window", async () => {
  const closedNodeIds: string[] = [];
  const terminatedSessionIds: string[] = [];

  const closed = await closeWindowTerminalNodes({
    getTerminalState() {
      return {
        createdAt: null,
        cwd: null,
        endedAt: null,
        host: null,
        lastError: null,
        profileId: null,
        runtimeKind: "local",
        sessionId: "session-1",
        status: "running",
        title: "Terminal",
        updatedAt: null
      };
    },
    host: createWorkbenchHostHandleStub({
      closeNode(nodeId) {
        closedNodeIds.push(nodeId);
      }
    }),
    terminalFeature: {
      closeGuard: {
        async check() {
          return {
            reason: "not-running",
            requiresConfirmation: false,
            status: "running"
          };
        }
      },
      diagnostics: {
        log() {
          return undefined;
        }
      },
      launchService: {
        async terminate(input: { sessionId: string }) {
          terminatedSessionIds.push(input.sessionId);
        }
      }
    }
  });

  assert.equal(closed, true);
  assert.deepEqual(terminatedSessionIds, ["session-1"]);
  assert.deepEqual(closedNodeIds, ["terminal:session-1"]);
});

test("closeWindowTerminalNodes keeps the window open when detached terminal termination fails", async () => {
  const closedNodeIds: string[] = [];

  const closed = await closeWindowTerminalNodes({
    getTerminalState() {
      return {
        createdAt: null,
        cwd: null,
        endedAt: null,
        host: null,
        lastError: null,
        profileId: null,
        runtimeKind: "local",
        sessionId: "session-1",
        status: "detached",
        title: "Terminal",
        updatedAt: null
      };
    },
    host: createWorkbenchHostHandleStub({
      closeNode(nodeId) {
        closedNodeIds.push(nodeId);
      }
    }),
    terminalFeature: {
      closeGuard: {
        async check() {
          return {
            reason: "foreground-process",
            requiresConfirmation: true,
            status: "detached"
          };
        }
      },
      diagnostics: {
        log() {
          return undefined;
        }
      },
      launchService: {
        async terminate() {
          throw new Error("terminate failed");
        }
      }
    }
  });

  assert.equal(closed, false);
  assert.deepEqual(closedNodeIds, []);
});

function createWorkbenchHostHandleStub(input: {
  closeNode(nodeId: string): void;
}): WorkbenchHostHandle {
  return {
    activateNode() {
      return undefined;
    },
    closeNode(nodeId) {
      input.closeNode(nodeId);
    },
    collectWindowCloseEffects: async () => [],
    dispose() {
      return undefined;
    },
    exitFullscreenNode() {
      return undefined;
    },
    focusNode() {
      return undefined;
    },
    getSnapshot() {
      return {
        activeNodeId: null,
        activeDragNodeId: null,
        activeResizeNodeId: null,
        activeSnapTarget: null,
        focusedNodeId: null,
        layoutConstraints: null,
        nodeStack: ["terminal:session-1"],
        nodes: [
          {
            data: {
              instanceId: "session-1",
              instanceKey: "session-1",
              typeId: "workspace-terminal"
            },
            displayMode: "floating",
            frame: {
              height: 520,
              width: 860,
              x: 260,
              y: 140
            },
            id: "terminal:session-1",
            isMinimized: false,
            kind: "window",
            restoreFrame: null,
            title: "Terminal"
          }
        ],
        surfaceSize: null
      } as never;
    },
    launchNode: async () => null,
    load: async () => undefined,
    minimizeNode() {
      return undefined;
    },
    reconcileProjectedNodes() {
      return undefined;
    },
    requestNodeClose() {
      return undefined;
    },
    setNodeRuntimeState() {
      return undefined;
    },
    setNodeSizeConstraints() {
      return undefined;
    },
    setSnapshotNodeState() {
      return undefined;
    },
    setNodeTitle() {
      return undefined;
    }
  };
}
