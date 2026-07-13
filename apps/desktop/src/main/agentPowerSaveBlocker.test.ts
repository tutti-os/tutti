import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentActivityUpdatedEventV1,
  TuttidEventStreamClient,
  TuttidClient,
  WorkspaceAgentSession
} from "@tutti-os/client-tuttid-ts";
import {
  defaultDesktopWorkbenchShortcuts,
  type DesktopSleepPreventionMode
} from "../shared/preferences/index.ts";
import {
  connectAgentPowerSaveBlocker,
  isAgentSessionRunningTask,
  shouldBlockSleep,
  type AgentPowerSaveBlockerRuntime
} from "./agentPowerSaveBlocker.ts";
import type { DesktopHostPreferencesState } from "./desktopHostPreferences.ts";
import type { DesktopLogger } from "./logging.ts";

test("isAgentSessionRunningTask only treats active work as running", () => {
  assert.equal(isAgentSessionRunningTask("running"), true);
  assert.equal(isAgentSessionRunningTask("working"), true);
  assert.equal(isAgentSessionRunningTask("streaming"), true);
  assert.equal(isAgentSessionRunningTask("waiting"), false);
  assert.equal(isAgentSessionRunningTask("completed"), false);
});

test("shouldBlockSleep maps sleep prevention modes to blocker state", () => {
  assert.equal(shouldBlockSleep("never", 1), false);
  assert.equal(shouldBlockSleep("whileAgentRunning", 0), false);
  assert.equal(shouldBlockSleep("whileAgentRunning", 1), true);
  assert.equal(shouldBlockSleep("always", 0), true);
});

test("agent power save blocker starts while enabled sessions are running", async () => {
  const eventStreamClient = createFakeEventStreamClient();
  const preferences = createFakePreferences("whileAgentRunning");
  const runtime = createFakeRuntime();
  const client = createFakeTuttidClient({
    sessions: {
      "ws-1:session-1": createSession("session-1", "running")
    }
  });

  const blocker = connectAgentPowerSaveBlocker({
    eventStreamClient,
    logger: createLogger(),
    tuttidClient: client,
    preferences,
    runtime
  });

  await settle();
  await settle();

  assert.deepEqual(runtime.startedTypes, ["prevent-app-suspension"]);
  assert.equal(runtime.activeIDs.size, 1);

  blocker.dispose();
});

test("agent power save blocker starts immediately in always mode", async () => {
  const eventStreamClient = createFakeEventStreamClient();
  const preferences = createFakePreferences("always");
  const runtime = createFakeRuntime();
  const client = createFakeTuttidClient({ sessions: {} });

  const blocker = connectAgentPowerSaveBlocker({
    eventStreamClient,
    logger: createLogger(),
    tuttidClient: client,
    preferences,
    runtime
  });

  await settle();

  assert.deepEqual(runtime.startedTypes, ["prevent-app-suspension"]);
  assert.equal(runtime.activeIDs.size, 1);

  blocker.dispose();
});

test("agent power save blocker stops when running session completes", async () => {
  const eventStreamClient = createFakeEventStreamClient();
  const preferences = createFakePreferences("whileAgentRunning");
  const runtime = createFakeRuntime();
  const client = createFakeTuttidClient({
    sessions: {
      "ws-1:session-1": createSession("session-1", "running")
    }
  });

  const blocker = connectAgentPowerSaveBlocker({
    eventStreamClient,
    logger: createLogger(),
    tuttidClient: client,
    preferences,
    runtime
  });

  await settle();
  client.sessions["ws-1:session-1"] = createSession("session-1", "completed");
  eventStreamClient.emitAgentActivityUpdated("ws-1", "session-1");
  await settle();

  assert.deepEqual(runtime.stoppedIDs, [1]);
  assert.equal(runtime.activeIDs.size, 0);

  blocker.dispose();
});

test("agent power save blocker follows preference changes", async () => {
  const eventStreamClient = createFakeEventStreamClient();
  const preferences = createFakePreferences("never");
  const runtime = createFakeRuntime();
  const client = createFakeTuttidClient({
    sessions: {
      "ws-1:session-1": createSession("session-1", "running")
    }
  });

  const blocker = connectAgentPowerSaveBlocker({
    eventStreamClient,
    logger: createLogger(),
    tuttidClient: client,
    preferences,
    runtime
  });

  await settle();
  assert.equal(runtime.activeIDs.size, 0);

  preferences.setSleepPreventionMode("whileAgentRunning");
  await settle();
  await settle();
  assert.equal(runtime.activeIDs.size, 1);

  preferences.setSleepPreventionMode("never");
  assert.equal(runtime.activeIDs.size, 0);
  assert.deepEqual(runtime.stoppedIDs, [1]);

  blocker.dispose();
});

function createFakeTuttidClient(input: {
  sessions: Record<string, WorkspaceAgentSession>;
}): Pick<
  TuttidClient,
  "getWorkspaceAgentSession" | "listWorkspaceAgentSessions" | "listWorkspaces"
> & {
  sessions: Record<string, WorkspaceAgentSession>;
} {
  return {
    sessions: input.sessions,
    async getWorkspaceAgentSession(workspaceID, agentSessionID) {
      const session = input.sessions[`${workspaceID}:${agentSessionID}`];
      if (!session) {
        throw new Error("session not found");
      }
      return session;
    },
    async listWorkspaceAgentSessions(workspaceID) {
      return {
        workspaceId: workspaceID,
        sessions: Object.entries(input.sessions)
          .filter(([key]) => key.startsWith(`${workspaceID}:`))
          .map(([, session]) => session)
      };
    },
    async listWorkspaces() {
      return {
        totalCount: 1,
        workspaces: [
          {
            id: "ws-1",
            lastOpenedAt: "2026-06-08T00:00:00Z",
            name: "Workspace"
          }
        ]
      };
    }
  };
}

function createSession(id: string, status: string): WorkspaceAgentSession {
  const active = status === "working" || status === "running";
  return {
    agentTargetId: null,
    backgroundAgents: null,
    capabilities: null,
    createdAtUnixMs: 1,
    cwd: "/tmp/ws-1",
    endedAtUnixMs: null,
    goal: null,
    id,
    imported: false,
    activeTurn: active
      ? {
          agentSessionId: id,
          completedCommand: null,
          error: null,
          fileChanges: null,
          outcome: null,
          phase: "running",
          settledAtUnixMs: null,
          startedAtUnixMs: 1,
          turnId: "turn-1",
          updatedAtUnixMs: 2
        }
      : null,
    activeTurnId: active ? "turn-1" : null,
    latestTurn: null,
    latestTurnInteractions: [],
    pendingInteractions: [],
    permissionConfig: { configurable: false, modes: [] },
    pinnedAtUnixMs: null,
    provider: "codex",
    providerSessionId: null,
    resumable: true,
    settings: {},
    title: "Session",
    updatedAtUnixMs: 2,
    usage: null,
    visible: true
  };
}

function createFakeEventStreamClient(): TuttidEventStreamClient & {
  emitAgentActivityUpdated(workspaceID: string, agentSessionID: string): void;
} {
  const activityListeners = new Set<
    (event: AgentActivityUpdatedEventV1) => void
  >();
  const connectionListeners = new Set<(state: "connected") => void>();

  return {
    async connect() {
      for (const listener of connectionListeners) {
        listener("connected");
      }
    },
    dispose() {},
    emitAgentActivityUpdated(workspaceID, agentSessionID) {
      const event: AgentActivityUpdatedEventV1 = {
        emittedAt: "2026-06-08T00:00:00Z",
        id: "event-1",
        payload: {
          agentSessionId: agentSessionID,
          data: {
            agentSessionId: agentSessionID,
            eventType: "session_reconcile_required",
            lastEventUnixMs: 1,
            workspaceId: workspaceID
          },
          eventType: "session_reconcile_required",
          workspaceId: workspaceID
        },
        topic: "agent.activity.updated",
        version: 2
      };
      for (const listener of activityListeners) {
        listener(event);
      }
    },
    async publishIntent() {},
    subscribe(topic, listener) {
      assert.equal(topic, "agent.activity.updated");
      activityListeners.add(
        listener as (event: AgentActivityUpdatedEventV1) => void
      );
      return () => {
        activityListeners.delete(
          listener as (event: AgentActivityUpdatedEventV1) => void
        );
      };
    },
    subscribeConnectionState(listener) {
      connectionListeners.add(listener);
      return () => {
        connectionListeners.delete(listener);
      };
    }
  };
}

function createFakePreferences(
  initialMode: DesktopSleepPreventionMode
): DesktopHostPreferencesState & {
  setSleepPreventionMode(mode: DesktopSleepPreventionMode): void;
} {
  const listeners = new Set<() => void>();
  let mode = initialMode;

  return {
    getAgentComposerDefaultsByProvider() {
      return {};
    },
    getAgentGUIConversationRailCollapsedByProvider() {
      return {};
    },
    getAgentConversationDetailMode() {
      return "coding";
    },
    getAppCatalogChannel() {
      return "production";
    },
    getDefaultAgentProvider() {
      return "codex";
    },
    getFeatureFlags() {
      return {};
    },
    getBrowserUseConnectionMode() {
      return "isolated";
    },
    getDockIconStyle() {
      return "default";
    },
    getDockPlacement() {
      return "bottom";
    },
    getFileDefaultOpenersByExtension() {
      return { html: "defaultBrowser" };
    },
    getLocale() {
      return "en";
    },
    getMinimizeAnimation() {
      return "scale";
    },
    getSleepPreventionMode() {
      return mode;
    },
    getThemeSource() {
      return "system";
    },
    getUpdateChannel() {
      return "stable";
    },
    getUpdatePolicy() {
      return "prompt";
    },
    getWorkbenchShortcuts() {
      return defaultDesktopWorkbenchShortcuts;
    },
    getWorkbenchWindowSnapping() {
      return {
        enabled: false,
        shortcutPreset: "commandArrows"
      };
    },
    setSleepPreventionMode(nextMode) {
      mode = nextMode;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sync(input) {
      if (input.sleepPreventionMode !== undefined) {
        mode = input.sleepPreventionMode;
      }
      for (const listener of listeners) {
        listener();
      }
    }
  };
}

function createFakeRuntime(): AgentPowerSaveBlockerRuntime & {
  activeIDs: Set<number>;
  startedTypes: string[];
  stoppedIDs: number[];
} {
  const activeIDs = new Set<number>();
  const startedTypes: string[] = [];
  const stoppedIDs: number[] = [];
  let nextID = 1;

  return {
    activeIDs,
    isStarted(id) {
      return activeIDs.has(id);
    },
    start(type) {
      const id = nextID;
      nextID += 1;
      activeIDs.add(id);
      startedTypes.push(type);
      return id;
    },
    startedTypes,
    stop(id) {
      activeIDs.delete(id);
      stoppedIDs.push(id);
    },
    stoppedIDs
  };
}

function createLogger(): DesktopLogger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    close: async () => {}
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
