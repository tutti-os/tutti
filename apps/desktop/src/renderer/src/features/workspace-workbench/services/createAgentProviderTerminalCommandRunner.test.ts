import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProviderTerminalCommand } from "@tutti-os/client-tuttid-ts";
import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import type { DesktopRuntimeApi } from "@preload/types";
import { createAgentProviderTerminalCommandRunner } from "./createAgentProviderTerminalCommandRunner.ts";
import { defaultWorkspaceTerminalWorkbenchTypeId } from "./internal/workspaceTerminalWorkbenchConstants.ts";

test("agent provider terminal runner opens a terminal with the login command", async () => {
  const launchRequests: unknown[] = [];
  const runner = createAgentProviderTerminalCommandRunner(createRuntimeApi());

  await runner.runTerminalCommand(createCommand("claude auth login\n"), {
    workbenchHost: createWorkbenchHost(launchRequests),
    workspaceId: "workspace-1"
  });

  assert.deepEqual(launchRequests, [
    {
      payload: {
        cwd: undefined,
        initialInput: "claude auth login\n"
      },
      reason: "host",
      typeId: defaultWorkspaceTerminalWorkbenchTypeId
    }
  ]);
});

test("agent provider terminal runner appends enter for login commands", async () => {
  const launchRequests: unknown[] = [];
  const runner = createAgentProviderTerminalCommandRunner(createRuntimeApi());

  await runner.runTerminalCommand(createCommand("claude auth login"), {
    workbenchHost: createWorkbenchHost(launchRequests)
  });

  assert.deepEqual(launchRequests, [
    {
      payload: {
        cwd: undefined,
        initialInput: "claude auth login\n"
      },
      reason: "host",
      typeId: defaultWorkspaceTerminalWorkbenchTypeId
    }
  ]);
});

test("agent provider terminal runner exits a focused fullscreen node before opening terminal", async () => {
  const launchRequests: unknown[] = [];
  const exitedFullscreenNodeIds: string[] = [];
  const runner = createAgentProviderTerminalCommandRunner(createRuntimeApi());

  await runner.runTerminalCommand(createCommand("claude auth login\n"), {
    workbenchHost: createWorkbenchHost(launchRequests, {
      exitFullscreenNode(nodeId: string) {
        exitedFullscreenNodeIds.push(nodeId);
      },
      getSnapshot: () =>
        ({
          nodeStack: ["agent-node"],
          nodes: [
            {
              displayMode: "fullscreen",
              id: "agent-node"
            }
          ]
        }) as never
    })
  });

  assert.deepEqual(exitedFullscreenNodeIds, ["agent-node"]);
  assert.equal(launchRequests.length, 1);
});

test("agent provider terminal runner rejects terminal commands without a host", async () => {
  const runner = createAgentProviderTerminalCommandRunner(createRuntimeApi());

  await assert.rejects(
    () => runner.runTerminalCommand(createCommand("claude auth login\n")),
    /Missing workbench host/u
  );
});

test("agent provider terminal runner rejects when no workbench node opens", async () => {
  const runner = createAgentProviderTerminalCommandRunner(createRuntimeApi());

  await assert.rejects(
    () =>
      runner.runTerminalCommand(createCommand("claude auth login\n"), {
        workbenchHost: createWorkbenchHost([], {
          launchNode: async () => null
        })
      }),
    /did not open/u
  );
});

function createCommand(input: string): AgentProviderTerminalCommand {
  return {
    input
  };
}

function createRuntimeApi(): DesktopRuntimeApi {
  return {
    async logTerminalDiagnostic() {}
  } as Partial<DesktopRuntimeApi> as DesktopRuntimeApi;
}

function createWorkbenchHost(
  launchRequests: unknown[],
  overrides: Partial<WorkbenchHostHandle> = {}
): WorkbenchHostHandle {
  return {
    activateNode() {},
    closeNode() {},
    collectWindowCloseEffects: async () => [],
    dispose() {},
    exitFullscreenNode() {},
    focusNode() {},
    getSnapshot() {
      return {
        nodeStack: [],
        nodes: []
      } as never;
    },
    async launchNode(request) {
      launchRequests.push(request);
      return "terminal-node";
    },
    load: async () => undefined,
    reconcileProjectedNodes() {},
    requestNodeClose() {},
    setNodeRuntimeState() {},
    setNodeSizeConstraints() {},
    setSnapshotNodeState() {},
    ...overrides,
    minimizeNode: overrides.minimizeNode ?? (() => {}),
    setNodeTitle: overrides.setNodeTitle ?? (() => {})
  };
}
