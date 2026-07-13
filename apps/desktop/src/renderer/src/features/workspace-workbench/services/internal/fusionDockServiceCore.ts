import type {
  WorkspaceAgentSession,
  WorkspaceApp,
  WorkspaceSummary,
  WorkspaceTerminalSession
} from "@tutti-os/client-tuttid-ts";
import type {
  DesktopFusionWindowDescriptor,
  DesktopFusionWindowKind
} from "@shared/contracts/fusion.ts";
import {
  projectFusionBackgroundResources,
  type FusionBackgroundResource
} from "../fusionDockResourceModel.ts";
import type { FusionDockResourceClient } from "../fusionDockService.interface.ts";
import { createStandaloneAgentWindowLaunchPayload } from "../standaloneAgentWindowIntent.ts";

const resourceDiscoveryIntervalTicks = 12;
const resourceWorkspaceConcurrency = 4;

export interface FusionDockResourceSnapshot {
  readonly agentSessions: readonly WorkspaceAgentSession[];
  readonly apps: readonly WorkspaceApp[];
  readonly terminals: readonly WorkspaceTerminalSession[];
}

export interface FusionDockWorkspaceResourceSnapshot extends FusionDockResourceSnapshot {
  readonly workspaceId: string;
  readonly workspaceName: string;
}

export async function loadFusionDockResourceSnapshot(input: {
  client: FusionDockResourceClient;
  current: FusionDockResourceSnapshot;
  workspaceId: string;
}): Promise<FusionDockResourceSnapshot> {
  const [agentResult, terminalResult, appResult] = await Promise.allSettled([
    input.client.listWorkspaceAgentSessions(input.workspaceId),
    input.client.listWorkspaceTerminals(input.workspaceId),
    input.client.listWorkspaceApps(input.workspaceId)
  ]);
  return {
    agentSessions:
      agentResult.status === "fulfilled"
        ? agentResult.value.sessions
        : input.current.agentSessions,
    apps:
      appResult.status === "fulfilled"
        ? appResult.value.apps
        : input.current.apps,
    terminals:
      terminalResult.status === "fulfilled"
        ? terminalResult.value.terminals
        : input.current.terminals
  };
}

export async function loadFusionDockWorkspaceResourceSnapshots(input: {
  client: FusionDockResourceClient;
  current: readonly FusionDockWorkspaceResourceSnapshot[];
  fallbackWorkspaceId: string;
  maxConcurrentWorkspaces?: number;
}): Promise<readonly FusionDockWorkspaceResourceSnapshot[]> {
  const currentById = new Map(
    input.current.map((snapshot) => [snapshot.workspaceId, snapshot])
  );
  let workspaces: readonly WorkspaceSummary[];
  try {
    workspaces = (await input.client.listWorkspaces()).workspaces;
  } catch {
    workspaces = input.current.map((snapshot) => ({
      id: snapshot.workspaceId,
      lastOpenedAt: null,
      name: snapshot.workspaceName
    }));
  }
  if (
    input.fallbackWorkspaceId &&
    !workspaces.some((workspace) => workspace.id === input.fallbackWorkspaceId)
  ) {
    workspaces = [
      ...workspaces,
      {
        id: input.fallbackWorkspaceId,
        lastOpenedAt: null,
        name:
          currentById.get(input.fallbackWorkspaceId)?.workspaceName ??
          input.fallbackWorkspaceId
      }
    ];
  }
  return mapWithConcurrency(
    workspaces,
    input.maxConcurrentWorkspaces ?? resourceWorkspaceConcurrency,
    async (workspace) => ({
      ...(await loadFusionDockResourceSnapshot({
        client: input.client,
        current: currentById.get(workspace.id) ?? createEmptyResourceSnapshot(),
        workspaceId: workspace.id
      })),
      workspaceId: workspace.id,
      workspaceName: workspace.name.trim() || workspace.id
    })
  );
}

export async function refreshFusionDockKnownWorkspaceResourceSnapshots(input: {
  client: FusionDockResourceClient;
  current: readonly FusionDockWorkspaceResourceSnapshot[];
  maxConcurrentWorkspaces?: number;
  workspaceIds: ReadonlySet<string>;
}): Promise<readonly FusionDockWorkspaceResourceSnapshot[]> {
  const snapshots = [...input.current];
  const knownWorkspaceIds = new Set(
    snapshots.map((snapshot) => snapshot.workspaceId)
  );
  for (const workspaceId of input.workspaceIds) {
    if (!workspaceId || knownWorkspaceIds.has(workspaceId)) {
      continue;
    }
    snapshots.push({
      ...createEmptyResourceSnapshot(),
      workspaceId,
      workspaceName: workspaceId
    });
  }
  return mapWithConcurrency(
    snapshots,
    input.maxConcurrentWorkspaces ?? resourceWorkspaceConcurrency,
    async (snapshot) =>
      input.workspaceIds.has(snapshot.workspaceId)
        ? {
            ...(await loadFusionDockResourceSnapshot({
              client: input.client,
              current: snapshot,
              workspaceId: snapshot.workspaceId
            })),
            workspaceId: snapshot.workspaceId,
            workspaceName: snapshot.workspaceName
          }
        : snapshot
  );
}

export function selectFusionDockFastRefreshWorkspaceIds(input: {
  current: readonly FusionDockWorkspaceResourceSnapshot[];
  fallbackWorkspaceId: string;
  windows: readonly DesktopFusionWindowDescriptor[];
}): ReadonlySet<string> {
  const selected = new Set<string>([input.fallbackWorkspaceId]);
  for (const window of input.windows) {
    selected.add(window.workspaceId);
  }
  for (const snapshot of input.current) {
    const resources = projectFusionBackgroundResources({
      agentSessions: snapshot.agentSessions,
      apps: snapshot.apps,
      terminals: snapshot.terminals,
      windows: input.windows,
      workspaceId: snapshot.workspaceId,
      workspaceName: snapshot.workspaceName
    });
    if (resources.some((resource) => resource.category === "background-task")) {
      selected.add(snapshot.workspaceId);
    }
  }
  selected.delete("");
  return selected;
}

export function fusionDockResourcePollScope(
  elapsedTicks: number
): "all" | "known" {
  return elapsedTicks > 0 && elapsedTicks % resourceDiscoveryIntervalTicks === 0
    ? "all"
    : "known";
}

export type FusionDockResourceStopResult =
  | { readonly status: "ignored" | "stopped" }
  | {
      readonly details: string | null;
      readonly status: "confirmation-required";
    };

export async function requestFusionDockResourceStop(input: {
  client: FusionDockResourceClient;
  forceTerminalStop?: boolean;
  resource: FusionBackgroundResource;
}): Promise<FusionDockResourceStopResult> {
  if (!input.resource.canStop) {
    return { status: "ignored" };
  }
  if (input.resource.kind === "terminal") {
    if (!input.forceTerminalStop) {
      const guard = await input.client.checkWorkspaceTerminalCloseGuard(
        input.resource.workspaceId,
        input.resource.id
      );
      if (guard.requiresConfirmation) {
        return {
          details: guard.leaderCommand?.trim() || null,
          status: "confirmation-required"
        };
      }
    }
    await input.client.terminateWorkspaceTerminal(
      input.resource.workspaceId,
      input.resource.id
    );
  } else if (input.resource.kind === "agent") {
    await input.client.cancelWorkspaceAgentSessionWithResult(
      input.resource.workspaceId,
      input.resource.id
    );
  } else {
    await input.client.stopWorkspaceApp(
      input.resource.workspaceId,
      input.resource.id
    );
  }
  return { status: "stopped" };
}

export function createFusionWindowDuplicateRequest(
  window: DesktopFusionWindowDescriptor,
  resource?: FusionBackgroundResource | null
) {
  const resourceId = window.resourceId?.trim() || null;
  if (window.kind === "file-preview" && resourceId) {
    return {
      forceNew: true,
      kind: "files" as const,
      launchPayload: { mode: "reveal", path: resourceId },
      resourceId,
      title: window.title,
      workspaceId: window.workspaceId
    };
  }
  return {
    forceNew: true,
    kind: window.kind,
    ...(resourceId
      ? {
          launchPayload: createWindowResourceLaunchPayload(
            window.kind,
            resourceId,
            resource
          ),
          resourceId
        }
      : {}),
    title: window.title,
    workspaceId: window.workspaceId
  };
}

export function createFusionResourceLaunchPayload(
  resource: FusionBackgroundResource
) {
  switch (resource.kind) {
    case "agent":
      return createStandaloneAgentWindowLaunchPayload({
        agentSessionId: resource.id,
        ...(resource.provider ? { provider: resource.provider } : {})
      });
    case "terminal":
      return { sessionId: resource.id };
    case "workspace-app":
      return { appId: resource.id };
  }
}

export function resolveMostRecentResourceWindow(
  windows: readonly DesktopFusionWindowDescriptor[],
  resource: FusionBackgroundResource
): DesktopFusionWindowDescriptor | null {
  return (
    [...windows]
      .filter(
        (window) =>
          window.kind === resource.kind &&
          window.resourceId === resource.id &&
          window.workspaceId === resource.workspaceId
      )
      .sort(
        (left, right) =>
          right.lastFocusedAtUnixMs - left.lastFocusedAtUnixMs ||
          right.createdAtUnixMs - left.createdAtUnixMs
      )[0] ?? null
  );
}

function createWindowResourceLaunchPayload(
  kind: DesktopFusionWindowKind,
  resourceId: string,
  resource?: FusionBackgroundResource | null
): unknown {
  switch (kind) {
    case "agent":
      return createStandaloneAgentWindowLaunchPayload({
        agentSessionId: resourceId,
        ...(resource?.kind === "agent" && resource.provider
          ? { provider: resource.provider }
          : {})
      });
    case "terminal":
      return { sessionId: resourceId };
    case "workspace-app":
      return { appId: resourceId };
    case "files":
      return { mode: "reveal", path: resourceId };
    case "issue-manager":
      return { issueId: resourceId };
    default:
      return undefined;
  }
}

function createEmptyResourceSnapshot(): FusionDockResourceSnapshot {
  return { agentSessions: [], apps: [], terminals: [] };
}

async function mapWithConcurrency<T, Result>(
  values: readonly T[],
  requestedConcurrency: number,
  map: (value: T, index: number) => Promise<Result>
): Promise<Result[]> {
  if (values.length === 0) {
    return [];
  }
  const results = Array.from(
    { length: values.length },
    () => undefined as Result
  );
  let nextIndex = 0;
  const concurrency = Math.max(
    1,
    Math.min(values.length, Math.floor(requestedConcurrency) || 1)
  );
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await map(values[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
