import {
  normalizeAgentActivityDisplayStatus,
  selectNeedsAttentionCount,
  selectNeedsAttentionItems,
  type AgentActivityMessage,
  type AgentActivityDisplayStatus,
  type AgentActivityNeedsAttentionItem,
  type AgentActivityPresence,
  type AgentActivitySession,
  type AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import type {
  AgentHostWorkspaceAgentMessage,
  AgentHostWorkspaceAgentPresence,
  AgentHostWorkspaceAgentSession,
  AgentHostWorkspaceAgentSnapshot
} from "./contracts/dto";
import {
  buildWorkspaceAgentActivityListViewModel,
  type BuildWorkspaceAgentActivityListOptions,
  type WorkspaceAgentActivityListViewModel
} from "./workspaceAgentActivityListViewModel";

export interface AgentActivitySnapshotProjection {
  view: WorkspaceAgentActivityListViewModel;
  sessionsById: Record<string, AgentHostWorkspaceAgentSession>;
  sessionMessagesById: Record<string, AgentHostWorkspaceAgentMessage[]>;
  needsAttentionCount: number;
  needsAttentionItems: AgentActivityNeedsAttentionItem[];
}

export function buildAgentActivitySnapshotProjection(
  snapshot: AgentActivitySnapshot,
  options: BuildWorkspaceAgentActivityListOptions = {}
): AgentActivitySnapshotProjection {
  const hostSnapshot = agentHostSnapshotFromAgentActivitySnapshot(snapshot);
  const view = buildWorkspaceAgentActivityListViewModel(snapshot, options);
  return {
    view,
    sessionsById: agentHostSessionsById(hostSnapshot.sessions),
    sessionMessagesById:
      agentHostMessagesBySessionIdFromActivitySnapshot(snapshot),
    needsAttentionCount: selectNeedsAttentionCount(snapshot),
    needsAttentionItems: selectNeedsAttentionItems(snapshot)
  };
}

export function agentHostSnapshotFromAgentActivitySnapshot(
  snapshot: AgentActivitySnapshot
): AgentHostWorkspaceAgentSnapshot {
  const presences = snapshot.presences.map(agentHostPresenceFromCore);
  const presenceIdsByProvider = new Map(
    presences.map((presence) => [presence.provider, presence.id])
  );
  return {
    presences,
    sessionMessagesById:
      agentHostMessagesBySessionIdFromActivitySnapshot(snapshot),
    sessions: snapshot.sessions.map((session, index) =>
      agentHostSessionFromCore(
        session,
        index + 1,
        presenceIdsByProvider.get(session.provider) ?? 0
      )
    )
  };
}

function agentHostMessagesBySessionIdFromActivitySnapshot(
  snapshot: AgentActivitySnapshot
): Record<string, AgentHostWorkspaceAgentMessage[]> {
  return Object.fromEntries(
    Object.entries(snapshot.sessionMessagesById).map(
      ([agentSessionId, messages]) => [
        agentSessionId,
        messages.map(agentHostMessageFromCore)
      ]
    )
  );
}

function agentHostSessionsById(
  sessions: readonly AgentHostWorkspaceAgentSession[]
): Record<string, AgentHostWorkspaceAgentSession> {
  return Object.fromEntries(
    sessions.map((session) => [session.agentSessionId, session])
  );
}

function agentHostPresenceFromCore(
  presence: AgentActivityPresence,
  index: number
): AgentHostWorkspaceAgentPresence {
  return {
    id: typeof presence.id === "number" ? presence.id : index + 1,
    provider: presence.provider,
    status: presence.status,
    userId: presence.userId ?? "local",
    workspaceId: presence.workspaceId
  };
}

function agentHostSessionFromCore(
  session: AgentActivitySession,
  id: number,
  presenceId: number
): AgentHostWorkspaceAgentSession {
  const displayStatus = agentActivityDisplayStatusFromSession(session);
  return {
    agentSessionId: session.agentSessionId,
    endedAtUnixMs: session.endedAtUnixMs,
    startedAtUnixMs: session.startedAtUnixMs,
    createdAtUnixMs: session.createdAtUnixMs,
    cwd: session.cwd,
    effectiveStatus: agentHostEffectiveStatusFromDisplay(displayStatus),
    id,
    lifecycleStatus: agentHostLifecycleStatusFromDisplay(displayStatus),
    // Import-classification markers ride on runtimeContext; dropping them
    // here would strip `imported`/no-project flags from every projected
    // snapshot and leave summaries depending on the initial daemon list.
    ...(session.runtimeContext
      ? { runtimeContext: session.runtimeContext }
      : {}),
    presenceId,
    pinnedAtUnixMs: session.pinnedAtUnixMs,
    provider: session.provider,
    providerSessionId: session.providerSessionId ?? session.agentSessionId,
    resumable: session.resumable ?? false,
    sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
    status: agentHostSessionStatusFromDisplay(displayStatus),
    syncState: session.lastError
      ? {
          agentSessionId: session.agentSessionId,
          lastError: session.lastError,
          status: "failed",
          updatedAtUnixMs: session.updatedAtUnixMs ?? session.lastEventUnixMs,
          workspaceId: session.workspaceId
        }
      : undefined,
    title: session.title || undefined,
    turnPhase: agentHostTurnPhaseFromDisplay(displayStatus),
    updatedAtUnixMs: session.updatedAtUnixMs ?? session.lastEventUnixMs,
    userId: session.userId?.trim() || "local",
    workspaceId: session.workspaceId
  };
}

export function agentHostMessageFromCore(
  message: AgentActivityMessage
): AgentHostWorkspaceAgentMessage {
  return {
    agentSessionId: message.agentSessionId,
    completedAtUnixMs: message.completedAtUnixMs,
    id: message.id ?? message.version,
    kind: message.kind,
    messageId: message.messageId,
    occurredAtUnixMs: message.occurredAtUnixMs,
    payload: { ...message.payload },
    role: message.role,
    startedAtUnixMs: message.startedAtUnixMs,
    status: message.status ?? undefined,
    turnId: message.turnId,
    version: message.version,
    workspaceId: message.workspaceId ?? ""
  };
}

/**
 * The single boundary where a raw core session status (e.g. "created",
 * "queued") becomes host/GUI vocabulary. Use this for any core status that
 * reaches the GUI outside the snapshot projection (cancel / sendInput results).
 */
export function projectCoreSessionStatus(status: string): string {
  return agentHostSessionStatusFromCore(status);
}

function agentHostSessionStatusFromCore(status: string): string {
  switch (status) {
    case "active":
    case "created":
    case "queued":
      return "ready";
    case "running":
      return "working";
    case "waiting":
      return "ready";
    default:
      return status;
  }
}

function agentActivityDisplayStatusFromSession(
  session: AgentActivitySession
): AgentActivityDisplayStatus {
  return normalizeAgentActivityDisplayStatus(session.status, {
    currentPhase: session.currentPhase,
    turnLifecycleOutcome: session.turnLifecycle?.outcome,
    turnLifecyclePhase: session.turnLifecycle?.phase
  });
}

function agentHostSessionStatusFromDisplay(
  status: AgentActivityDisplayStatus
): string {
  return status === "idle" ? "ready" : status;
}

function agentHostEffectiveStatusFromDisplay(
  status: AgentActivityDisplayStatus
): string {
  return status === "idle" ? "ready" : status;
}

function agentHostLifecycleStatusFromDisplay(
  status: AgentActivityDisplayStatus
): string {
  switch (status) {
    case "failed":
      return "failed";
    case "completed":
    case "canceled":
      return "ended";
    default:
      return "active";
  }
}

function agentHostTurnPhaseFromDisplay(
  status: AgentActivityDisplayStatus
): string {
  switch (status) {
    case "working":
    case "waiting":
    case "failed":
      return status;
    default:
      return "idle";
  }
}
