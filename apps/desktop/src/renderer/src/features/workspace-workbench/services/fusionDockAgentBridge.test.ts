import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopFusionApi } from "@preload/types";
import type { AgentProviderStatusSnapshot } from "@renderer/features/workspace-agent/services/agentProviderStatusService.interface.ts";
import {
  openFusionNotificationAgent,
  startFusionDockAgentBridge
} from "./fusionDockAgentBridge.ts";

test("Fusion Dock alone broadcasts Agent binding state for Workspace Apps", () => {
  let statusListener: () => void = () => undefined;
  let navigationListener: () => void = () => undefined;
  let snapshot = createSnapshot("unavailable");
  const broadcasts: boolean[] = [];
  const release = startFusionDockAgentBridge({
    agentProviderStatusService: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        statusListener = listener;
        return () => {
          statusListener = () => undefined;
        };
      }
    },
    fusionApi: createFusionApi(),
    workbenchHostService: {
      broadcastAgentStatus: ({ agentBound }) => broadcasts.push(agentBound),
      onNotificationNavigate(listener) {
        navigationListener = () =>
          listener({
            agentSessionId: "session-1",
            provider: "codex",
            workspaceId: "workspace-2"
          });
        return () => {
          navigationListener = () => undefined;
        };
      }
    }
  });

  snapshot = createSnapshot("ready");
  statusListener();
  assert.deepEqual(broadcasts, [false, true]);
  release();
  statusListener();
  navigationListener();
  assert.deepEqual(broadcasts, [false, true]);
});

test("notification navigation reconnects the Agent in the payload workspace", async () => {
  const opened: unknown[] = [];
  const focused: unknown[] = [];
  const fusionApi = createFusionApi({ focused, opened });

  await openFusionNotificationAgent({
    fusionApi,
    payload: {
      agentSessionId: "same-session",
      provider: "codex",
      workspaceId: "workspace-2"
    }
  });

  assert.deepEqual(focused, []);
  assert.deepEqual(opened, [
    {
      forceNew: false,
      kind: "agent",
      launchPayload: {
        agentSessionId: "same-session",
        provider: "codex"
      },
      resourceId: "same-session",
      workspaceId: "workspace-2"
    }
  ]);
});

test("notification navigation failures reach the diagnostic callback", async () => {
  const failure = new Error("window launch failed");
  let navigationListener: () => void = () => undefined;
  const received = new Promise<{
    error: unknown;
    payload: {
      agentSessionId: string;
      provider: string;
      workspaceId: string;
    };
  }>((resolve) => {
    startFusionDockAgentBridge({
      agentProviderStatusService: {
        getSnapshot: () => createSnapshot("ready"),
        subscribe: () => () => undefined
      },
      fusionApi: {
        ...createFusionApi(),
        async openWindow() {
          throw failure;
        }
      },
      onNavigationError(error, payload) {
        resolve({ error, payload });
      },
      workbenchHostService: {
        broadcastAgentStatus() {},
        onNotificationNavigate(listener) {
          navigationListener = () =>
            listener({
              agentSessionId: "session-failed",
              provider: "claude-code",
              workspaceId: "workspace-2"
            });
          return () => undefined;
        }
      }
    });
  });

  navigationListener();

  assert.deepEqual(await received, {
    error: failure,
    payload: {
      agentSessionId: "session-failed",
      provider: "claude-code",
      workspaceId: "workspace-2"
    }
  });
});

function createSnapshot(
  availability: "ready" | "unavailable"
): AgentProviderStatusSnapshot {
  return {
    capturedAt: null,
    defaultProvider: null,
    error: null,
    isLoading: false,
    pendingActions: [],
    statuses: [
      {
        availability: { status: availability },
        provider: "codex"
      }
    ]
  } as unknown as AgentProviderStatusSnapshot;
}

function createFusionApi(input?: {
  focused: unknown[];
  opened: unknown[];
}): DesktopFusionApi {
  return {
    async closeWindow() {},
    async focusWindow(target) {
      input?.focused.push(target);
    },
    async getState() {
      return {
        active: true,
        dockSearchExpanded: false,
        dockSearchScope: "all",
        dockVisible: true,
        revision: 1,
        shortcut: { binding: null, error: null },
        windows: [
          {
            createdAtUnixMs: 1,
            focused: false,
            kind: "agent" as const,
            lastFocusedAtUnixMs: 1,
            resourceId: "same-session",
            title: null,
            visibility: "visible" as const,
            windowInstanceId: "other-workspace-window",
            workspaceId: "workspace-1"
          }
        ],
        workspaceId: "workspace-1"
      };
    },
    async hideDock() {},
    async openWindow(request) {
      input?.opened.push(request);
      return {
        createdAtUnixMs: 1,
        focused: true,
        kind: request.kind,
        lastFocusedAtUnixMs: 1,
        resourceId: request.resourceId ?? null,
        title: null,
        visibility: "visible",
        windowInstanceId: "opened-window",
        workspaceId: request.workspaceId
      };
    },
    onState() {
      return () => undefined;
    },
    async showDock() {},
    async toggleDock() {},
    async updateWindow() {
      throw new Error("not used");
    }
  };
}
