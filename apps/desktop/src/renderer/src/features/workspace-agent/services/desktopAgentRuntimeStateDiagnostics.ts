import {
  type AgentActivityMessage,
  type AgentActivityMessagePage,
  type AgentActivitySession,
  type AgentActivitySessionEventEnvelope,
  type AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";

export function agentActivitySnapshotDiagnosticSignature(
  snapshot: AgentActivitySnapshot
): string {
  return snapshot.sessions
    .map((session) => agentActivitySessionDiagnosticSignature(session))
    .sort()
    .join("|");
}

export function agentActivitySnapshotDiagnosticDetails(
  snapshot: AgentActivitySnapshot
): Record<string, unknown> {
  const sessions = [...snapshot.sessions].sort(
    (left, right) =>
      agentActivitySessionSortTimeUnixMs(right) -
      agentActivitySessionSortTimeUnixMs(left)
  );
  const activeOrRecentSessions = sessions
    .filter(
      (session, index) => index < 8 || agentActivitySessionIsBusy(session)
    )
    .slice(0, 12)
    .map((session) => agentActivitySessionDiagnosticDetails(session));
  return {
    activeOrRecentSessions,
    busySessionCount: snapshot.sessions.filter(agentActivitySessionIsBusy)
      .length,
    sessionCount: snapshot.sessions.length,
    workspaceId: snapshot.workspaceId
  };
}

export function agentActivitySessionDiagnosticSignature(
  session: AgentActivitySession
): string {
  const turn = session.activeTurn ?? session.latestTurn;
  return [
    session.agentSessionId,
    session.provider,
    session.activeTurnId ?? "",
    turn?.phase ?? "",
    turn?.outcome ?? "",
    session.messageVersion ?? "",
    session.lastEventUnixMs ?? "",
    session.updatedAtUnixMs ?? ""
  ].join(":");
}

export function agentActivitySessionDiagnosticDetails(
  session: AgentActivitySession
): Record<string, unknown> {
  const turn = session.activeTurn ?? session.latestTurn;
  return {
    activeTurnId: session.activeTurnId ?? null,
    agentSessionId: session.agentSessionId,
    lastEventUnixMs: session.lastEventUnixMs ?? null,
    messageVersion: session.messageVersion ?? null,
    outcome: turn?.outcome ?? null,
    provider: session.provider,
    turnPhase: turn?.phase ?? null,
    updatedAtUnixMs: session.updatedAtUnixMs ?? null
  };
}

export function agentActivitySessionIsBusy(
  session: AgentActivitySession
): boolean {
  const phase = session.activeTurn?.phase;
  return (
    phase === "running" ||
    phase === "submitted" ||
    phase === "settling" ||
    phase === "waiting" ||
    (session.pendingInteractions?.length ?? 0) > 0
  );
}

export function agentActivitySessionSortTimeUnixMs(
  session: AgentActivitySession
): number {
  return (
    session.lastEventUnixMs ??
    session.updatedAtUnixMs ??
    session.createdAtUnixMs ??
    session.startedAtUnixMs ??
    0
  );
}

export function agentActivityMessagePageDiagnosticSignature(
  page: AgentActivityMessagePage
): string {
  return [
    page.latestVersion,
    page.hasMore ? "1" : "0",
    page.messages.length,
    page.messages.at(0)?.version ?? "",
    page.messages.at(-1)?.version ?? "",
    page.messages.at(-1)?.kind ?? "",
    page.messages.at(-1)?.status ?? ""
  ].join(":");
}

export function agentActivityMessageDiagnosticDetails(
  message: AgentActivityMessage | null
): Record<string, unknown> | null {
  if (!message) {
    return null;
  }
  return {
    agentSessionId: message.agentSessionId,
    kind: message.kind,
    messageId: message.messageId,
    role: message.role,
    status: message.status ?? null,
    turnId: message.turnId,
    version: message.version
  };
}

export function reportSessionEventDiagnostic(
  workspaceId: string,
  event: unknown,
  reportRuntimeDiagnostic: (input: {
    details?: Record<string, unknown>;
    event: string;
    level?: "debug" | "info" | "warn" | "error";
    workspaceId?: string | null;
  }) => void
): void {
  const envelope = isAgentActivitySessionEventEnvelope(event) ? event : null;
  reportRuntimeDiagnostic({
    details: envelope
      ? {
          agentSessionId: envelope.agentSessionId,
          data: agentActivitySessionEventDataDiagnosticDetails(envelope.data),
          eventType: envelope.eventType
        }
      : {
          eventType: "unknown"
        },
    event: "agent.gui.runtime.session_event_received",
    level: "debug",
    workspaceId
  });
}

export function isAgentActivitySessionEventEnvelope(
  value: unknown
): value is AgentActivitySessionEventEnvelope {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { agentSessionId?: unknown }).agentSessionId ===
      "string" &&
    typeof (value as { eventType?: unknown }).eventType === "string"
  );
}

export function agentActivitySessionEventDataDiagnosticDetails(
  data: unknown
): Record<string, unknown> | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as Record<string, unknown>;
  return {
    kind: typeof record.kind === "string" ? record.kind : null,
    messageId: typeof record.messageId === "string" ? record.messageId : null,
    role: typeof record.role === "string" ? record.role : null,
    status: typeof record.status === "string" ? record.status : null,
    turnId: typeof record.turnId === "string" ? record.turnId : null,
    version:
      typeof record.version === "number" && Number.isFinite(record.version)
        ? record.version
        : null
  };
}
