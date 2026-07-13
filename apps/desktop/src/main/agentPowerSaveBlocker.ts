import { createRequire } from "node:module";
import type {
  AgentActivityUpdatedEventV1,
  TuttidClient,
  TuttidEventStreamClient,
  WorkspaceAgentSession
} from "@tutti-os/client-tuttid-ts";
import { workspaceAgentSessionStatus } from "@tutti-os/agent-activity-core";
import type { DesktopSleepPreventionMode } from "../shared/preferences/index.ts";
import type { DesktopHostPreferencesState } from "./desktopHostPreferences.ts";
import type { DesktopLogger } from "./logging.ts";

const require = createRequire(import.meta.url);

export interface AgentPowerSaveBlocker {
  dispose(): void;
}

export interface AgentPowerSaveBlockerRuntime {
  isStarted(id: number): boolean;
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
}

export interface AgentPowerSaveBlockerDependencies {
  eventStreamClient: TuttidEventStreamClient;
  logger: DesktopLogger;
  tuttidClient: Pick<
    TuttidClient,
    "getWorkspaceAgentSession" | "listWorkspaceAgentSessions" | "listWorkspaces"
  >;
  preferences: DesktopHostPreferencesState;
  runtime?: AgentPowerSaveBlockerRuntime;
}

export function connectAgentPowerSaveBlocker(
  deps: AgentPowerSaveBlockerDependencies
): AgentPowerSaveBlocker {
  const runtime = deps.runtime ?? createElectronPowerSaveBlockerRuntime();
  const activeSessionKeys = new Set<string>();
  let blockerID: number | null = null;
  let disposed = false;
  let refreshSequence = 0;

  const unsubscribePreferences = deps.preferences.subscribe(() => {
    const mode = deps.preferences.getSleepPreventionMode();
    if (mode === "never") {
      activeSessionKeys.clear();
      updateBlocker();
      return;
    }

    if (mode === "always") {
      updateBlocker();
      return;
    }

    void refreshActiveSessions();
  });

  const unsubscribeActivity = deps.eventStreamClient.subscribe(
    "agent.activity.updated",
    (event) => {
      if (deps.preferences.getSleepPreventionMode() !== "whileAgentRunning") {
        return;
      }
      if (event.payload.eventType !== "session_reconcile_required") {
        return;
      }
      void syncSession(event);
    },
    { scope: null }
  );

  const unsubscribeConnection = deps.eventStreamClient.subscribeConnectionState(
    (state) => {
      if (
        state === "connected" &&
        deps.preferences.getSleepPreventionMode() === "whileAgentRunning"
      ) {
        void refreshActiveSessions();
      }
    }
  );

  if (deps.preferences.getSleepPreventionMode() === "always") {
    updateBlocker();
  } else if (
    deps.preferences.getSleepPreventionMode() === "whileAgentRunning"
  ) {
    void refreshActiveSessions();
  }

  void deps.eventStreamClient.connect().catch((error: unknown) => {
    deps.logger.warn(
      "failed to connect agent power save blocker event stream",
      {
        error: error instanceof Error ? error.message : String(error)
      }
    );
  });

  return {
    dispose() {
      disposed = true;
      unsubscribePreferences();
      unsubscribeActivity();
      unsubscribeConnection();
      deps.eventStreamClient.dispose();
      activeSessionKeys.clear();
      stopBlocker();
    }
  };

  async function syncSession(
    event: AgentActivityUpdatedEventV1
  ): Promise<void> {
    const { workspaceId, agentSessionId } = event.payload;
    try {
      const session = await deps.tuttidClient.getWorkspaceAgentSession(
        workspaceId,
        agentSessionId
      );
      if (disposed) {
        return;
      }
      updateSessionActiveState(workspaceId, session);
      updateBlocker();
    } catch (error) {
      deps.logger.warn("failed to sync agent session power save state", {
        agent_session_id: agentSessionId,
        error: error instanceof Error ? error.message : String(error),
        workspace_id: workspaceId
      });
      await refreshActiveSessions();
    }
  }

  async function refreshActiveSessions(): Promise<void> {
    const sequence = ++refreshSequence;
    try {
      const workspaces = await deps.tuttidClient.listWorkspaces();
      const nextActiveSessionKeys = new Set<string>();
      for (const workspace of workspaces.workspaces) {
        const sessions = await deps.tuttidClient.listWorkspaceAgentSessions(
          workspace.id
        );
        for (const session of sessions.sessions) {
          if (isAgentSessionRunningTask(workspaceAgentSessionStatus(session))) {
            nextActiveSessionKeys.add(
              createSessionKey(workspace.id, session.id)
            );
          }
        }
      }
      if (disposed || sequence !== refreshSequence) {
        return;
      }
      activeSessionKeys.clear();
      for (const key of nextActiveSessionKeys) {
        activeSessionKeys.add(key);
      }
      updateBlocker();
    } catch (error) {
      deps.logger.warn("failed to refresh agent power save state", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  function updateSessionActiveState(
    workspaceID: string,
    session: WorkspaceAgentSession
  ): void {
    const key = createSessionKey(workspaceID, session.id);
    if (isAgentSessionRunningTask(workspaceAgentSessionStatus(session))) {
      activeSessionKeys.add(key);
    } else {
      activeSessionKeys.delete(key);
    }
  }

  function updateBlocker(): void {
    const shouldBlock = shouldBlockSleep(
      deps.preferences.getSleepPreventionMode(),
      activeSessionKeys.size
    );

    if (shouldBlock) {
      startBlocker();
      return;
    }

    stopBlocker();
  }

  function startBlocker(): void {
    if (blockerID !== null && runtime.isStarted(blockerID)) {
      return;
    }
    blockerID = runtime.start("prevent-app-suspension");
    deps.logger.info("agent power save blocker started", {
      active_session_count: activeSessionKeys.size,
      blocker_id: blockerID
    });
  }

  function stopBlocker(): void {
    if (blockerID === null) {
      return;
    }
    const currentBlockerID = blockerID;
    blockerID = null;
    if (!runtime.isStarted(currentBlockerID)) {
      return;
    }
    runtime.stop(currentBlockerID);
    deps.logger.info("agent power save blocker stopped", {
      blocker_id: currentBlockerID
    });
  }
}

export function shouldBlockSleep(
  mode: DesktopSleepPreventionMode,
  activeSessionCount: number
): boolean {
  switch (mode) {
    case "always":
      return true;
    case "whileAgentRunning":
      return activeSessionCount > 0;
    case "never":
      return false;
  }
}

export function isAgentSessionRunningTask(status: string): boolean {
  switch (status.trim().toLowerCase()) {
    case "running":
    case "streaming":
    case "working":
      return true;
    default:
      return false;
  }
}

function createSessionKey(workspaceID: string, agentSessionID: string): string {
  return `${workspaceID}:${agentSessionID}`;
}

function createElectronPowerSaveBlockerRuntime(): AgentPowerSaveBlockerRuntime {
  const { powerSaveBlocker } = require("electron") as {
    powerSaveBlocker: AgentPowerSaveBlockerRuntime;
  };
  return powerSaveBlocker;
}
