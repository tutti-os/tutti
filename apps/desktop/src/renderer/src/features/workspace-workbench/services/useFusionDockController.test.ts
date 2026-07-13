import assert from "node:assert/strict";
import test from "node:test";
import type {
  TuttidClient,
  WorkspaceAgentSession,
  WorkspaceTerminalSession
} from "@tutti-os/client-tuttid-ts";
import type { FusionBackgroundResource } from "./fusionDockResourceModel.ts";
import {
  createFusionWindowDuplicateRequest,
  createFusionResourceLaunchPayload,
  fusionDockResourcePollScope,
  loadFusionDockResourceSnapshot,
  loadFusionDockWorkspaceResourceSnapshots,
  refreshFusionDockKnownWorkspaceResourceSnapshots,
  requestFusionDockResourceStop,
  selectFusionDockFastRefreshWorkspaceIds
} from "./internal/fusionDockServiceCore.ts";

test("Fusion Dock duplicates a Workspace App window with its app identity", () => {
  assert.deepEqual(
    createFusionWindowDuplicateRequest({
      createdAtUnixMs: 1,
      focused: true,
      kind: "workspace-app",
      lastFocusedAtUnixMs: 1,
      resourceId: "app-1",
      title: "App One",
      visibility: "visible",
      windowInstanceId: "window-1",
      workspaceId: "workspace-2"
    }),
    {
      forceNew: true,
      kind: "workspace-app",
      launchPayload: { appId: "app-1" },
      resourceId: "app-1",
      title: "App One",
      workspaceId: "workspace-2"
    }
  );
});

test("Fusion Dock reconnects and duplicates non-Codex Agent sessions with their provider", () => {
  const resource: FusionBackgroundResource = {
    attachedWindowCount: 1,
    canStop: true,
    category: "background-task",
    id: "agent-session-1",
    kind: "agent",
    provider: "claude-code",
    status: "waiting",
    subtitle: null,
    title: "Claude session",
    updatedAtUnixMs: 1,
    workspaceId: "workspace-2",
    workspaceName: "Two"
  };
  assert.deepEqual(createFusionResourceLaunchPayload(resource), {
    agentSessionId: "agent-session-1",
    provider: "claude-code"
  });
  assert.deepEqual(
    createFusionWindowDuplicateRequest(
      {
        createdAtUnixMs: 1,
        focused: true,
        kind: "agent",
        lastFocusedAtUnixMs: 1,
        resourceId: "agent-session-1",
        title: "Claude session",
        visibility: "visible",
        windowInstanceId: "window-1",
        workspaceId: "workspace-2"
      },
      resource
    ),
    {
      forceNew: true,
      kind: "agent",
      launchPayload: {
        agentSessionId: "agent-session-1",
        provider: "claude-code"
      },
      resourceId: "agent-session-1",
      title: "Claude session",
      workspaceId: "workspace-2"
    }
  );
});

test("Fusion Dock resource refresh preserves a previous lane when that daemon request fails", async () => {
  const previousAgent = { id: "agent-previous" } as WorkspaceAgentSession;
  const terminal = { id: "terminal-1" } as WorkspaceTerminalSession;
  const snapshot = await loadFusionDockResourceSnapshot({
    client: createClient({
      async listWorkspaceAgentSessions() {
        throw new Error("agent lane unavailable");
      },
      async listWorkspaceApps() {
        return { apps: [] } as never;
      },
      async listWorkspaceTerminals() {
        return { terminals: [terminal] } as never;
      }
    }),
    current: {
      agentSessions: [previousAgent],
      apps: [],
      terminals: []
    },
    workspaceId: "workspace-1"
  });

  assert.deepEqual(snapshot.agentSessions, [previousAgent]);
  assert.deepEqual(snapshot.terminals, [terminal]);
});

test("Fusion Dock terminal stop returns a confirmation before termination", async () => {
  const workspaceIds: string[] = [];
  let terminated = false;
  const client = createClient({
    async checkWorkspaceTerminalCloseGuard(workspaceId) {
      workspaceIds.push(workspaceId);
      return {
        leaderCommand: "  pnpm dev  ",
        requiresConfirmation: true
      } as never;
    },
    async terminateWorkspaceTerminal(workspaceId) {
      workspaceIds.push(workspaceId);
      terminated = true;
      return {} as never;
    }
  });

  const guarded = await requestFusionDockResourceStop({
    client,
    resource: createTerminalResource()
  });
  assert.deepEqual(guarded, {
    details: "pnpm dev",
    status: "confirmation-required"
  });
  assert.equal(terminated, false);

  const confirmed = await requestFusionDockResourceStop({
    client,
    forceTerminalStop: true,
    resource: createTerminalResource()
  });
  assert.deepEqual(confirmed, { status: "stopped" });
  assert.equal(terminated, true);
  assert.deepEqual(workspaceIds, ["workspace-2", "workspace-2"]);
});

test("Fusion Dock Agent stop targets the owning workspace and session", async () => {
  const canceled: string[][] = [];
  const result = await requestFusionDockResourceStop({
    client: createClient({
      async cancelWorkspaceAgentSessionWithResult(workspaceId, agentSessionId) {
        canceled.push([workspaceId, agentSessionId]);
        return {} as never;
      }
    }),
    resource: {
      attachedWindowCount: 0,
      canStop: true,
      category: "background-task",
      id: "agent-session-1",
      kind: "agent",
      provider: "codex",
      status: "running",
      subtitle: null,
      title: "Agent",
      updatedAtUnixMs: 1,
      workspaceId: "workspace-2",
      workspaceName: "Two"
    }
  });

  assert.deepEqual(result, { status: "stopped" });
  assert.deepEqual(canceled, [["workspace-2", "agent-session-1"]]);
});

test("Fusion Dock aggregates every workspace and requests the complete Agent list", async () => {
  const requested: Array<{ request: unknown; workspaceId: string }> = [];
  const snapshots = await loadFusionDockWorkspaceResourceSnapshots({
    client: createClient({
      async listWorkspaces() {
        return {
          totalCount: 2,
          workspaces: [
            { id: "workspace-1", lastOpenedAt: null, name: "One" },
            { id: "workspace-2", lastOpenedAt: null, name: "Two" }
          ]
        };
      },
      async listWorkspaceAgentSessions(workspaceId, request) {
        requested.push({ request, workspaceId });
        return {
          sessions: Array.from({ length: 81 }, (_, index) => ({
            id: `${workspaceId}-agent-${index}`
          }))
        } as never;
      },
      async listWorkspaceApps() {
        return { apps: [] } as never;
      },
      async listWorkspaceTerminals() {
        return { terminals: [] } as never;
      }
    }),
    current: [],
    fallbackWorkspaceId: "workspace-1"
  });

  assert.deepEqual(
    snapshots.map((snapshot) => [
      snapshot.workspaceId,
      snapshot.workspaceName,
      snapshot.agentSessions.length
    ]),
    [
      ["workspace-1", "One", 81],
      ["workspace-2", "Two", 81]
    ]
  );
  assert.deepEqual(requested, [
    { request: undefined, workspaceId: "workspace-1" },
    { request: undefined, workspaceId: "workspace-2" }
  ]);
});

test("Fusion Dock bounds concurrent workspace resource refreshes", async () => {
  let activeWorkspaceRequests = 0;
  let maxActiveWorkspaceRequests = 0;
  const snapshots = await loadFusionDockWorkspaceResourceSnapshots({
    client: createClient({
      async listWorkspaces() {
        return {
          totalCount: 6,
          workspaces: Array.from({ length: 6 }, (_, index) => ({
            id: `workspace-${index}`,
            lastOpenedAt: null,
            name: `Workspace ${index}`
          }))
        };
      },
      async listWorkspaceAgentSessions() {
        activeWorkspaceRequests += 1;
        maxActiveWorkspaceRequests = Math.max(
          maxActiveWorkspaceRequests,
          activeWorkspaceRequests
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeWorkspaceRequests -= 1;
        return { sessions: [] } as never;
      },
      async listWorkspaceApps() {
        return { apps: [] } as never;
      },
      async listWorkspaceTerminals() {
        return { terminals: [] } as never;
      }
    }),
    current: [],
    fallbackWorkspaceId: "workspace-0",
    maxConcurrentWorkspaces: 2
  });

  assert.equal(snapshots.length, 6);
  assert.equal(maxActiveWorkspaceRequests, 2);
});

test("Fusion Dock fast refresh selects its current, visible, and active workspaces", () => {
  const selected = selectFusionDockFastRefreshWorkspaceIds({
    current: [
      {
        agentSessions: [],
        apps: [],
        terminals: [],
        workspaceId: "workspace-empty",
        workspaceName: "Empty"
      },
      {
        agentSessions: [],
        apps: [],
        terminals: [
          {
            createdAt: "2026-01-01T00:00:00Z",
            cwd: "/tmp",
            id: "terminal-1",
            status: "running",
            title: "Running"
          } as WorkspaceTerminalSession
        ],
        workspaceId: "workspace-active",
        workspaceName: "Active"
      },
      {
        agentSessions: [
          {
            createdAt: "2026-01-01T00:00:00Z",
            id: "agent-completed",
            provider: "codex",
            resumable: true,
            status: "completed",
            title: "Recoverable",
            updatedAt: "2026-01-01T00:00:01Z",
            visible: true
          } as WorkspaceAgentSession
        ],
        apps: [],
        terminals: [],
        workspaceId: "workspace-recoverable",
        workspaceName: "Recoverable"
      }
    ],
    fallbackWorkspaceId: "workspace-current",
    windows: [
      {
        workspaceId: "workspace-window"
      } as never
    ]
  });

  assert.deepEqual([...selected].sort(), [
    "workspace-active",
    "workspace-current",
    "workspace-window"
  ]);
});

test("Fusion Dock performs full discovery once per minute while visible", () => {
  assert.equal(fusionDockResourcePollScope(0), "known");
  assert.equal(fusionDockResourcePollScope(1), "known");
  assert.equal(fusionDockResourcePollScope(11), "known");
  assert.equal(fusionDockResourcePollScope(12), "all");
  assert.equal(fusionDockResourcePollScope(24), "all");
});

test("Fusion Dock fast refresh adds a newly visible workspace before discovery", async () => {
  const requestedWorkspaceIds: string[] = [];
  const snapshots = await refreshFusionDockKnownWorkspaceResourceSnapshots({
    client: createClient({
      async listWorkspaceAgentSessions(workspaceId) {
        requestedWorkspaceIds.push(workspaceId);
        return { sessions: [] } as never;
      },
      async listWorkspaceApps() {
        return { apps: [] } as never;
      },
      async listWorkspaceTerminals() {
        return { terminals: [] } as never;
      }
    }),
    current: [],
    workspaceIds: new Set(["workspace-window"])
  });

  assert.deepEqual(requestedWorkspaceIds, ["workspace-window"]);
  assert.deepEqual(
    snapshots.map(({ workspaceId, workspaceName }) => ({
      workspaceId,
      workspaceName
    })),
    [
      {
        workspaceId: "workspace-window",
        workspaceName: "workspace-window"
      }
    ]
  );
});

function createClient(overrides: Partial<TuttidClient>): TuttidClient {
  return overrides as TuttidClient;
}

function createTerminalResource(): FusionBackgroundResource {
  return {
    attachedWindowCount: 0,
    canStop: true,
    category: "background-task",
    id: "terminal-1",
    kind: "terminal",
    provider: null,
    status: "running",
    subtitle: null,
    title: "Dev server",
    updatedAtUnixMs: 1,
    workspaceId: "workspace-2",
    workspaceName: "Two"
  };
}
