import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkbenchHostNodeBodyContext,
  WorkbenchHostNodeData
} from "@tutti-os/workbench-surface";
import type { TerminalNodeExternalState } from "../contracts/index.ts";
import type { TerminalNodeFeature } from "../core/feature.ts";
import { resolveTerminalWorkbenchBodyProps } from "./bodyProps.ts";
import { resolveTerminalWindowCloseEffect } from "./windowCloseEffect.ts";

test("terminal workbench body lets the mounted surface retain its session", () => {
  const props = resolveTerminalWorkbenchBodyProps({
    context: createTerminalWorkbenchBodyTestContext({
      externalNodeState: null,
      sessionId: "session-1"
    }),
    feature: {
      i18n: {
        t(key: string) {
          return key;
        }
      }
    } as TerminalNodeFeature
  });

  assert.equal("controllerLeaseRetainedExternally" in props, false);
  assert.equal(props.sessionId, "session-1");
});

test("terminal workbench body forwards preview changes to the host", () => {
  const onPreviewChange = () => undefined;
  const props = resolveTerminalWorkbenchBodyProps({
    context: createTerminalWorkbenchBodyTestContext({
      externalNodeState: null,
      sessionId: "session-1"
    }),
    feature: {
      i18n: {
        t(key: string) {
          return key;
        }
      }
    } as TerminalNodeFeature,
    onPreviewChange
  });

  assert.equal(props.onPreviewChange, onPreviewChange);
});

function createTerminalWorkbenchBodyTestContext({
  externalNodeState,
  isFocused = true,
  sessionId = "session-1"
}: {
  externalNodeState: TerminalNodeExternalState | null;
  isFocused?: boolean;
  sessionId?: string | null;
}): WorkbenchHostNodeBodyContext<TerminalNodeExternalState | null, unknown> {
  const data: WorkbenchHostNodeData = {
    instanceId: sessionId ?? "terminal",
    instanceKey: sessionId,
    typeId: "workspace-terminal"
  };

  return {
    activation: null,
    displayMode: "floating",
    externalNodeState,
    externalWorkspaceState: undefined,
    focus() {
      return undefined;
    },
    host: {
      activateNode() {},
      async collectWindowCloseEffects() {
        return [];
      },
      controller: null,
      dispose() {},
      focusNode() {},
      async launchNode() {
        return null;
      },
      async load() {},
      reconcileProjectedNodes() {},
      requestNodeClose() {},
      setNodeRuntimeState() {},
      setSnapshotNodeState() {}
    } as unknown as WorkbenchHostNodeBodyContext<
      TerminalNodeExternalState | null,
      unknown
    >["host"],
    instanceId: data.instanceId,
    instanceKey: data.instanceKey,
    isFocused,
    node: {
      data,
      displayMode: "floating",
      frame: {
        height: 520,
        width: 860,
        x: 260,
        y: 140
      },
      id: "workspace-terminal:session-1",
      isMinimized: false,
      kind: "window",
      restoreFrame: null,
      title: "Terminal"
    },
    setNodeRuntimeState() {
      return undefined;
    },
    setSnapshotNodeState() {
      return undefined;
    }
  };
}

test("terminal workbench window close effect ignores idle running terminals", async () => {
  const effect = await resolveTerminalWindowCloseEffect({
    closeGuard: {
      async check() {
        return {
          reason: "not-running",
          requiresConfirmation: false,
          status: "running"
        };
      }
    },
    description:
      "This terminal still has running work. Terminating it will stop the session.",
    externalNodeState: {
      createdAt: null,
      cwd: null,
      endedAt: null,
      host: null,
      lastError: null,
      profileId: null,
      runtimeKind: "local",
      sessionId: "session-1",
      status: "running",
      title: "Terminal A",
      updatedAt: null
    },
    nodeId: "terminal:session-1",
    sessionId: "session-1",
    title: "Terminal A",
    typeId: "workspace-terminal"
  });

  assert.equal(effect, null);
});

test("terminal workbench window close effect keeps blocking terminals with foreground work", async () => {
  const effect = await resolveTerminalWindowCloseEffect({
    closeGuard: {
      async check() {
        return {
          leaderCommand: "npm run dev",
          reason: "foreground-process",
          requiresConfirmation: true,
          status: "running"
        };
      }
    },
    description:
      "This terminal still has running work. Terminating it will stop the session.",
    externalNodeState: {
      createdAt: null,
      cwd: null,
      endedAt: null,
      host: null,
      lastError: null,
      profileId: null,
      runtimeKind: "local",
      sessionId: "session-1",
      status: "running",
      title: "Terminal A",
      updatedAt: null
    },
    nodeId: "terminal:session-1",
    sessionId: "session-1",
    title: "Terminal A",
    typeId: "workspace-terminal"
  });

  assert.deepEqual(effect, {
    description:
      "This terminal still has running work. Terminating it will stop the session.",
    nodeId: "terminal:session-1",
    title: "Terminal A",
    typeId: "workspace-terminal"
  });
});
