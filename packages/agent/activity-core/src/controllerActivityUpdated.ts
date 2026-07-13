import {
  cloneJSONValue,
  nullableStringValue,
  numberValue,
  recordValue,
  stringValue,
  messageVersionValue
} from "./controllerValues.ts";
import {
  mergeSnapshotMessages,
  resolveCanonicalAgentSessionId
} from "./controllerSnapshot.ts";
import type {
  AgentActivityInteraction,
  AgentActivityMessage,
  AgentActivitySession,
  AgentActivitySnapshot,
  AgentActivityTurn,
  AgentActivityUpdatedApplyResult,
  AgentActivityUpdatedEvent
} from "./types.ts";

export function applyActivityUpdatedEvent(
  snapshot: AgentActivitySnapshot,
  event: AgentActivityUpdatedEvent
): AgentActivityUpdatedApplyResult & { snapshot: AgentActivitySnapshot } {
  if (event.workspaceId && event.workspaceId !== snapshot.workspaceId) {
    return emptyActivityUpdatedApplyResult(snapshot);
  }

  const workspaceId = event.workspaceId || snapshot.workspaceId;
  const agentSessionId = event.agentSessionId.trim();
  if (!agentSessionId) {
    return emptyActivityUpdatedApplyResult(snapshot);
  }

  if (event.eventType === "message_update") {
    return applyActivityUpdatedMessages(snapshot, {
      agentSessionId,
      data: event.data,
      workspaceId
    });
  }

  if (event.eventType === "turn_update") {
    return applyActivityUpdatedTurn(snapshot, {
      agentSessionId,
      data: event.data,
      workspaceId
    });
  }

  if (event.eventType === "interaction_update") {
    return applyActivityUpdatedInteraction(snapshot, {
      agentSessionId,
      data: event.data,
      workspaceId
    });
  }

  return emptyActivityUpdatedApplyResult(snapshot);
}

function applyActivityUpdatedTurn(
  snapshot: AgentActivitySnapshot,
  input: { agentSessionId: string; data: unknown; workspaceId: string }
): AgentActivityUpdatedApplyResult & { snapshot: AgentActivitySnapshot } {
  const data = recordValue(input.data);
  const turn = workspaceAgentTurnFromValue(data?.turn);
  if (!data || !turn || turn.agentSessionId !== input.agentSessionId) {
    return emptyActivityUpdatedApplyResult(snapshot);
  }
  const sessionIndex = snapshot.sessions.findIndex(
    (session) => session.agentSessionId === input.agentSessionId
  );
  if (sessionIndex < 0) {
    return emptyActivityUpdatedApplyResult(snapshot);
  }
  const current = snapshot.sessions[sessionIndex]!;
  if (
    current.activeTurn?.turnId === turn.turnId &&
    (current.activeTurn.updatedAtUnixMs ?? 0) > turn.updatedAtUnixMs
  ) {
    return emptyActivityUpdatedApplyResult(snapshot);
  }
  const hasActiveTurnId = Object.prototype.hasOwnProperty.call(
    data,
    "activeTurnId"
  );
  const activeTurnId = hasActiveTurnId
    ? (nullableStringValue(data.activeTurnId) ?? null)
    : turn.phase === "settled"
      ? null
      : turn.turnId;
  const session: AgentActivitySession = {
    ...current,
    activeTurnId,
    activeTurn: turn,
    pendingInteractions:
      activeTurnId === null ? [] : (current.pendingInteractions ?? []),
    updatedAtUnixMs: numberValue(data.occurredAtUnixMs) ?? turn.updatedAtUnixMs,
    lastEventUnixMs: numberValue(data.occurredAtUnixMs) ?? turn.updatedAtUnixMs
  };
  const sessions = [...snapshot.sessions];
  sessions[sessionIndex] = session;
  return {
    applied: true,
    messages: [],
    session,
    snapshot: { ...snapshot, sessions }
  };
}

function applyActivityUpdatedInteraction(
  snapshot: AgentActivitySnapshot,
  input: { agentSessionId: string; data: unknown; workspaceId: string }
): AgentActivityUpdatedApplyResult & { snapshot: AgentActivitySnapshot } {
  const data = recordValue(input.data);
  const interaction = workspaceAgentInteractionFromValue(data?.interaction);
  if (
    !data ||
    !interaction ||
    interaction.agentSessionId !== input.agentSessionId
  ) {
    return emptyActivityUpdatedApplyResult(snapshot);
  }
  const sessionIndex = snapshot.sessions.findIndex(
    (session) => session.agentSessionId === input.agentSessionId
  );
  if (sessionIndex < 0) {
    return emptyActivityUpdatedApplyResult(snapshot);
  }
  const current = snapshot.sessions[sessionIndex]!;
  const pendingInteractions = (current.pendingInteractions ?? []).filter(
    (candidate) => candidate.requestId !== interaction.requestId
  );
  if (interaction.status === "pending") {
    pendingInteractions.push(interaction);
  }
  const latestTurnInteractions = mergeLatestTurnInteraction(
    current.latestTurnInteractions ?? [],
    interaction
  );
  const session: AgentActivitySession = {
    ...current,
    latestTurnInteractions,
    pendingInteractions,
    updatedAtUnixMs:
      numberValue(data.occurredAtUnixMs) ?? interaction.updatedAtUnixMs,
    lastEventUnixMs:
      numberValue(data.occurredAtUnixMs) ?? interaction.updatedAtUnixMs
  };
  const sessions = [...snapshot.sessions];
  sessions[sessionIndex] = session;
  return {
    applied: true,
    messages: [],
    session,
    snapshot: { ...snapshot, sessions }
  };
}

function mergeLatestTurnInteraction(
  current: readonly AgentActivityInteraction[],
  incoming: AgentActivityInteraction
): AgentActivityInteraction[] {
  const sameTurn = current.filter(
    (candidate) => candidate.turnId === incoming.turnId
  );
  const existing = sameTurn.find(
    (candidate) => candidate.requestId === incoming.requestId
  );
  if (existing && !shouldUseIncomingInteraction(existing, incoming)) {
    return [...sameTurn];
  }
  return [
    ...sameTurn.filter(
      (candidate) => candidate.requestId !== incoming.requestId
    ),
    incoming
  ].sort(
    (left, right) =>
      left.createdAtUnixMs - right.createdAtUnixMs ||
      left.requestId.localeCompare(right.requestId)
  );
}

function shouldUseIncomingInteraction(
  current: AgentActivityInteraction,
  incoming: AgentActivityInteraction
): boolean {
  if (incoming.updatedAtUnixMs < current.updatedAtUnixMs) return false;
  const currentTerminal = current.status !== "pending";
  const incomingTerminal = incoming.status !== "pending";
  if (currentTerminal && incoming.status !== current.status) return false;
  if (
    incoming.updatedAtUnixMs === current.updatedAtUnixMs &&
    currentTerminal !== incomingTerminal
  ) {
    return incomingTerminal;
  }
  return true;
}

function applyActivityUpdatedMessages(
  snapshot: AgentActivitySnapshot,
  input: {
    agentSessionId: string;
    data: unknown;
    workspaceId: string;
  }
): AgentActivityUpdatedApplyResult & { snapshot: AgentActivitySnapshot } {
  const inlineMessages = inlineMessagesFromActivityUpdateData(input.data);
  if (inlineMessages.length === 0) {
    return emptyActivityUpdatedApplyResult(snapshot);
  }
  const messagesBySessionId = new Map<string, AgentActivityMessage[]>();
  for (const message of inlineMessages) {
    const targetSessionId = inlineMessageTargetAgentSessionId(
      snapshot,
      input.agentSessionId,
      message
    );
    if (!targetSessionId) {
      continue;
    }
    const activityMessage = agentActivityMessageFromInlineMessage({
      agentSessionId: targetSessionId,
      message,
      workspaceId: input.workspaceId
    });
    if (!activityMessage) {
      continue;
    }
    messagesBySessionId.set(targetSessionId, [
      ...(messagesBySessionId.get(targetSessionId) ?? []),
      activityMessage
    ]);
  }
  if (messagesBySessionId.size === 0) {
    return emptyActivityUpdatedApplyResult(snapshot);
  }
  let nextSnapshot = snapshot;
  const messages: AgentActivityMessage[] = [];
  for (const [agentSessionId, sessionMessages] of messagesBySessionId) {
    nextSnapshot = mergeSnapshotMessages(
      nextSnapshot,
      agentSessionId,
      sessionMessages
    );
    messages.push(...sessionMessages);
  }
  if (nextSnapshot === snapshot) {
    return {
      applied: true,
      messages: [],
      session: null,
      snapshot
    };
  }
  return {
    applied: true,
    messages,
    session: null,
    snapshot: nextSnapshot
  };
}

function emptyActivityUpdatedApplyResult(
  snapshot: AgentActivitySnapshot
): AgentActivityUpdatedApplyResult & { snapshot: AgentActivitySnapshot } {
  return {
    applied: false,
    messages: [],
    session: null,
    snapshot
  };
}

function inlineMessagesFromActivityUpdateData(
  data: unknown
): Record<string, unknown>[] {
  const source = recordValue(data);
  const messages = Array.isArray(source?.messages) ? source.messages : [];
  return messages.flatMap((message) => {
    const record = recordValue(message);
    return record ? [record] : [];
  });
}

function inlineMessageTargetAgentSessionId(
  snapshot: AgentActivitySnapshot,
  eventAgentSessionId: string,
  message: Record<string, unknown>
): string {
  const canonicalEventSessionId = resolveCanonicalAgentSessionId(
    snapshot,
    eventAgentSessionId
  );
  if (!canonicalEventSessionId) {
    return "";
  }
  const messageAgentSessionId = stringValue(message.agentSessionId);
  return messageAgentSessionId === "" ||
    resolveCanonicalAgentSessionId(snapshot, messageAgentSessionId) ===
      canonicalEventSessionId
    ? canonicalEventSessionId
    : knownSessionIdentity(snapshot, eventAgentSessionId)
      ? ""
      : resolveCanonicalAgentSessionId(snapshot, messageAgentSessionId);
}

function knownSessionIdentity(
  snapshot: AgentActivitySnapshot,
  agentSessionId: string
): boolean {
  const normalizedAgentSessionId = agentSessionId.trim();
  return (
    normalizedAgentSessionId !== "" &&
    (snapshot.sessions.some(
      (session) => session.agentSessionId.trim() === normalizedAgentSessionId
    ) ||
      resolveCanonicalAgentSessionId(snapshot, normalizedAgentSessionId) !==
        normalizedAgentSessionId)
  );
}

function agentActivityMessageFromInlineMessage(input: {
  agentSessionId: string;
  message: Record<string, unknown>;
  workspaceId: string;
}): AgentActivityMessage | null {
  const messageId = stringValue(input.message.messageId);
  const role = stringValue(input.message.role);
  const kind = stringValue(input.message.kind);
  const turnId = stringValue(input.message.turnId);
  const version = messageVersionValue(input.message);
  const occurredAtUnixMs = numberValue(input.message.occurredAtUnixMs);
  if (
    !messageId ||
    !role ||
    !kind ||
    !turnId ||
    version <= 0 ||
    occurredAtUnixMs === undefined ||
    occurredAtUnixMs <= 0
  ) {
    return null;
  }
  return {
    workspaceId: stringValue(input.message.workspaceId) || input.workspaceId,
    agentSessionId: input.agentSessionId,
    messageId,
    version,
    turnId,
    role,
    kind,
    status: nullableStringValue(input.message.status),
    semantics: recordValue(input.message.semantics)
      ? (cloneJSONValue(
          input.message.semantics
        ) as AgentActivityMessage["semantics"])
      : undefined,
    payload: recordValue(input.message.payload) ?? {},
    occurredAtUnixMs,
    startedAtUnixMs: numberValue(input.message.startedAtUnixMs),
    completedAtUnixMs: numberValue(input.message.completedAtUnixMs)
  };
}

function workspaceAgentTurnFromValue(value: unknown): AgentActivityTurn | null {
  const source = recordValue(value);
  const turnId = stringValue(source?.turnId);
  const agentSessionId = stringValue(source?.agentSessionId);
  const phase = stringValue(source?.phase);
  const startedAtUnixMs = numberValue(source?.startedAtUnixMs);
  const updatedAtUnixMs = numberValue(source?.updatedAtUnixMs);
  if (
    !source ||
    !turnId ||
    !agentSessionId ||
    !["submitted", "running", "waiting", "settling", "settled"].includes(
      phase
    ) ||
    startedAtUnixMs === undefined ||
    updatedAtUnixMs === undefined
  ) {
    return null;
  }
  return cloneJSONValue(source) as AgentActivityTurn;
}

function workspaceAgentInteractionFromValue(
  value: unknown
): AgentActivityInteraction | null {
  const source = recordValue(value);
  const requestId = stringValue(source?.requestId);
  const agentSessionId = stringValue(source?.agentSessionId);
  const turnId = stringValue(source?.turnId);
  const kind = stringValue(source?.kind);
  const status = stringValue(source?.status);
  const createdAtUnixMs = numberValue(source?.createdAtUnixMs);
  const updatedAtUnixMs = numberValue(source?.updatedAtUnixMs);
  if (
    !source ||
    !requestId ||
    !agentSessionId ||
    !turnId ||
    !["approval", "question", "plan"].includes(kind) ||
    !["pending", "answered", "superseded"].includes(status) ||
    createdAtUnixMs === undefined ||
    updatedAtUnixMs === undefined
  ) {
    return null;
  }
  return cloneJSONValue(source) as AgentActivityInteraction;
}
