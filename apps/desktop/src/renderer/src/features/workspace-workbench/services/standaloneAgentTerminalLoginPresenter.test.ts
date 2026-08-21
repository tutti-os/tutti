import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopRuntimeApi } from "@preload/types";
import type {
  TerminalDataEvent,
  TerminalTransport
} from "@tutti-os/workspace-terminal/contracts";
import type { WorkbenchContribution } from "@tutti-os/workbench-surface";
import { registerWorkspaceTerminalLoginLaunchHandler } from "../../workspace-agent/services/workspaceTerminalLoginLaunchCoordinator.ts";
import { createAgentProviderTerminalCommandRunner } from "./createAgentProviderTerminalCommandRunner.ts";
import { createStandaloneAgentTerminalLoginPresenter } from "./standaloneAgentTerminalLoginPresenter.ts";
import { registerWorkspaceTerminalSurfaceRuntime } from "./workspaceTerminalSurfaceRuntime.ts";

test("provider login reaches a standalone Agent Terminal tab through the shared coordinator", async () => {
  const contribution = {} as WorkbenchContribution;
  const createRequests: unknown[] = [];
  registerWorkspaceTerminalSurfaceRuntime(contribution, {
    async createSession(input) {
      createRequests.push(input);
      return { sessionId: "terminal-e2e-session" } as never;
    },
    feature: {
      launchService: { async terminate() {} },
      transport: createTransportHarness().transport
    } as never,
    getExternalState: () => null,
    subscribe: () => () => {}
  });
  const openedSessionIds: string[] = [];
  const presenter = createStandaloneAgentTerminalLoginPresenter({
    closeTab() {},
    contributions: [contribution],
    openTab(sessionId) {
      openedSessionIds.push(sessionId);
      return "terminal-e2e-tab";
    },
    runtimeApi: createRuntimeApi()
  });
  const unregister = registerWorkspaceTerminalLoginLaunchHandler(
    "workspace-e2e",
    presenter
  );
  try {
    const runner = createAgentProviderTerminalCommandRunner(
      createRuntimeApi() as DesktopRuntimeApi
    );
    const handle = await runner.runTerminalCommand(
      { input: "claude auth login" },
      { workspaceId: "workspace-e2e" }
    );

    assert.deepEqual(createRequests, [
      { cwd: undefined, initialInput: "claude auth login\n" }
    ]);
    assert.deepEqual(openedSessionIds, ["terminal-e2e-session"]);
    assert.ok(handle);
  } finally {
    unregister();
  }
});

test("standalone Agent terminal login creates a dedicated tab with the login command", async () => {
  const contribution = {} as WorkbenchContribution;
  const transport = createTransportHarness();
  const createRequests: unknown[] = [];
  const terminatedSessionIds: string[] = [];
  registerWorkspaceTerminalSurfaceRuntime(contribution, {
    async createSession(input) {
      createRequests.push(input);
      return { sessionId: "terminal-session-1" } as never;
    },
    feature: {
      launchService: {
        async terminate({ sessionId }: { sessionId: string }) {
          terminatedSessionIds.push(sessionId);
        }
      },
      transport: transport.transport
    } as never,
    getExternalState: () => null,
    subscribe: () => () => {}
  });
  const openedSessionIds: string[] = [];
  const closedTabIds: string[] = [];
  const presenter = createStandaloneAgentTerminalLoginPresenter({
    closeTab: (tabId) => closedTabIds.push(tabId),
    contributions: [contribution],
    openTab: (sessionId) => {
      openedSessionIds.push(sessionId);
      return "terminal-tab-1";
    },
    runtimeApi: createRuntimeApi()
  });

  const handle = await presenter({
    command: "claude auth login",
    cwd: "/workspace",
    workspaceId: "workspace-1"
  });

  assert.ok(handle);
  assert.deepEqual(createRequests, [
    { cwd: "/workspace", initialInput: "claude auth login\n" }
  ]);
  assert.deepEqual(openedSessionIds, ["terminal-session-1"]);
  assert.equal(await handle.startupCompletion, "not_required");
  handle.close();
  await Promise.resolve();
  assert.deepEqual(closedTabIds, ["terminal-tab-1"]);
  assert.deepEqual(terminatedSessionIds, ["terminal-session-1"]);
});

test("standalone Agent terminal login preserves typed startup actions", async () => {
  const contribution = {} as WorkbenchContribution;
  const transport = createTransportHarness();
  registerWorkspaceTerminalSurfaceRuntime(contribution, {
    async createSession() {
      return { sessionId: "terminal-session-2" } as never;
    },
    feature: {
      launchService: { async terminate() {} },
      transport: transport.transport
    } as never,
    getExternalState: () => null,
    subscribe: () => () => {}
  });
  const presenter = createStandaloneAgentTerminalLoginPresenter({
    closeTab() {},
    contributions: [contribution],
    openTab: () => "terminal-tab-2",
    runtimeApi: createRuntimeApi()
  });

  const handle = await presenter({
    command: "/opt/kimi/bin/kimi",
    startupAction: {
      commandName: "login",
      readyText: "Welcome to Kimi Code!",
      type: "slash_command"
    },
    workspaceId: "workspace-1"
  });
  assert.ok(handle);
  transport.emit({
    data: "Welcome to Kimi Code!",
    sessionId: "terminal-session-2"
  });
  assert.equal(await handle.startupCompletion, "submitted");
  assert.deepEqual(transport.writes, [
    {
      data: "/login\r",
      encoding: "utf8",
      provenance: "auto",
      sessionId: "terminal-session-2"
    }
  ]);
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

function createRuntimeApi(): Pick<DesktopRuntimeApi, "logTerminalDiagnostic"> {
  return { async logTerminalDiagnostic() {} };
}
