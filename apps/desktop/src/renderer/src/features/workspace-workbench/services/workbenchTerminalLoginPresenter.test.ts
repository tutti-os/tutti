import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopRuntimeApi } from "@preload/types";
import type {
  TerminalDataEvent,
  TerminalTransport
} from "@tutti-os/workspace-terminal/contracts";
import type {
  WorkbenchContribution,
  WorkbenchHostHandle
} from "@tutti-os/workbench-surface";
import { createWorkbenchTerminalLoginPresenter } from "./workbenchTerminalLoginPresenter.ts";
import { registerWorkspaceTerminalSurfaceRuntime } from "./workspaceTerminalSurfaceRuntime.ts";
import { defaultWorkspaceTerminalWorkbenchTypeId } from "./workspaceWorkbenchNodeIds.ts";

test("workbench terminal login presenter submits a typed slash command to the launched session", async () => {
  const contribution = {} as WorkbenchContribution;
  const transport = createTransportHarness();
  registerWorkspaceTerminalSurfaceRuntime(contribution, {
    createSession: async () => ({}) as never,
    feature: { transport: transport.transport } as never,
    getExternalState: () => null,
    subscribe: () => () => {}
  });
  const launchRequests: unknown[] = [];
  const closedNodeIds: string[] = [];
  const presenter = createWorkbenchTerminalLoginPresenter({
    contributions: [contribution],
    host: createWorkbenchHost({ closedNodeIds, launchRequests }),
    runtimeApi: createRuntimeApi()
  });

  const handle = await presenter({
    command: "/opt/kimi/bin/kimi",
    startupAction: {
      type: "slash_command",
      commandName: "login",
      readyText: "Welcome to Kimi Code!"
    },
    workspaceId: "workspace-1"
  });
  assert.ok(handle);
  transport.emit({
    data: "Welcome to Kimi Code!",
    sessionId: "terminal-session-1"
  });

  assert.equal(await handle.startupCompletion, "submitted");
  assert.deepEqual(transport.writes, [
    {
      data: "/login\r",
      encoding: "utf8",
      provenance: "auto",
      sessionId: "terminal-session-1"
    }
  ]);
  assert.deepEqual(launchRequests, [
    {
      payload: {
        cwd: undefined,
        initialInput: "/opt/kimi/bin/kimi\n"
      },
      reason: "host",
      typeId: defaultWorkspaceTerminalWorkbenchTypeId
    }
  ]);

  handle.close();
  assert.deepEqual(closedNodeIds, ["terminal-node-1"]);
});

test("workbench terminal login presenter supports terminal methods without a startup action", async () => {
  const presenter = createWorkbenchTerminalLoginPresenter({
    contributions: [],
    host: createWorkbenchHost({ closedNodeIds: [], launchRequests: [] }),
    runtimeApi: createRuntimeApi()
  });

  const handle = await presenter({
    command: "provider auth login",
    workspaceId: "workspace-1"
  });

  assert.ok(handle);
  assert.equal(await handle.startupCompletion, "not_required");
});

function createTransportHarness(): {
  emit(event: TerminalDataEvent): void;
  transport: Pick<TerminalTransport, "onData" | "write">;
  writes: Array<Parameters<TerminalTransport["write"]>[0]>;
} {
  const listeners = new Set<(event: TerminalDataEvent) => void>();
  const writes: Array<Parameters<TerminalTransport["write"]>[0]> = [];
  return {
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    transport: {
      onData(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async write(request) {
        writes.push(request);
      }
    },
    writes
  };
}

function createWorkbenchHost(input: {
  closedNodeIds: string[];
  launchRequests: unknown[];
}): WorkbenchHostHandle {
  return {
    closeNode(nodeId: string) {
      input.closedNodeIds.push(nodeId);
    },
    getSnapshot: () =>
      ({
        nodes: [
          {
            data: { instanceKey: "terminal-session-1" },
            id: "terminal-node-1"
          }
        ]
      }) as never,
    async launchNode(
      request: Parameters<WorkbenchHostHandle["launchNode"]>[0]
    ) {
      input.launchRequests.push(request);
      return "terminal-node-1";
    }
  } as unknown as WorkbenchHostHandle;
}

function createRuntimeApi(): Pick<DesktopRuntimeApi, "logTerminalDiagnostic"> {
  return {
    async logTerminalDiagnostic() {}
  };
}
