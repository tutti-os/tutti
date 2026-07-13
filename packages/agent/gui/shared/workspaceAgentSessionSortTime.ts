export interface WorkspaceAgentSessionSortTimeSession {
  createdAtUnixMs?: number;
  endedAtUnixMs?: number | null;
  id?: number;
  agentSessionId?: string;
  providerSessionId?: string | null;
  startedAtUnixMs?: number;
  updatedAtUnixMs?: number;
}

export interface WorkspaceAgentSessionSortTimeMessage {
  agentSessionId?: string;
  occurredAtUnixMs?: number;
  role?: string;
  turnId?: string | null;
}

export interface WorkspaceAgentSessionSortTimeContext {
  messages?: readonly WorkspaceAgentSessionSortTimeMessage[];
}

export function resolveWorkspaceAgentSessionSortTimeUnixMs(
  session: WorkspaceAgentSessionSortTimeSession,
  context: WorkspaceAgentSessionSortTimeContext = {}
): number {
  const hasSortContext = hasWorkspaceAgentSessionSortContext(context);
  const fallbackUpdatedAtUnixMs = hasSortContext
    ? null
    : positiveNumber(session.updatedAtUnixMs);
  return (
    latestUserTurnStartTimeUnixMs(session, context) ??
    positiveNumber(session.endedAtUnixMs) ??
    fallbackUpdatedAtUnixMs ??
    positiveNumber(session.startedAtUnixMs) ??
    positiveNumber(session.createdAtUnixMs) ??
    positiveNumber(session.id) ??
    0
  );
}

function hasWorkspaceAgentSessionSortContext(
  context: WorkspaceAgentSessionSortTimeContext
): boolean {
  return Boolean(context.messages?.length);
}

function latestUserTurnStartTimeUnixMs(
  session: WorkspaceAgentSessionSortTimeSession,
  context: WorkspaceAgentSessionSortTimeContext
): number | null {
  const sessionIds = new Set(
    [session.agentSessionId, session.providerSessionId]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value))
  );
  const startsByTurnId = new Map<string, number>();
  for (const message of context.messages ?? []) {
    if (!matchesSession(message.agentSessionId, sessionIds)) {
      continue;
    }
    const turnId = message.turnId?.trim();
    if (!turnId) {
      continue;
    }
    const role = normalizeToken(message.role);
    if (role === "user") {
      const startedAtUnixMs = positiveNumber(message.occurredAtUnixMs);
      if (startedAtUnixMs !== null) {
        startsByTurnId.set(
          turnId,
          minNullable(startsByTurnId.get(turnId) ?? null, startedAtUnixMs)!
        );
      }
    }
  }
  let latest: number | null = null;
  for (const startedAtUnixMs of startsByTurnId.values()) {
    latest =
      latest === null ? startedAtUnixMs : Math.max(latest, startedAtUnixMs);
  }
  return latest;
}

function matchesSession(
  agentSessionId: string | undefined,
  sessionIds: ReadonlySet<string>
): boolean {
  if (sessionIds.size === 0) {
    return true;
  }
  const normalized = agentSessionId?.trim();
  return Boolean(normalized && sessionIds.has(normalized));
}

function minNullable(left: number | null, right: number | null): number | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return Math.min(left, right);
}

function normalizeToken(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}
