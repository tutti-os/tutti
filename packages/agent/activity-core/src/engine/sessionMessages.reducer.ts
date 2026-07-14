import type { AgentActivityMessage } from "../types.ts";
import {
  areAgentActivityMessageArraysEqual,
  mergeAgentActivityMessages
} from "../merge.ts";
import type { EngineIntent, EngineReducerResult } from "./types.ts";
import type { SessionMessagesState } from "./sessionMessages.types.ts";

const NO_COMMANDS = [] as const;

/**
 * Minimal session identity the message store needs to resolve a provisional or
 * provider-scoped session id back to its canonical `agentSessionId`. Sourced
 * from the session lifecycle slice via reducer context so the message store
 * stays the single owner of message buckets without duplicating session state.
 */
export interface SessionMessagesSessionIdentity {
  agentSessionId: string;
  provider: string;
  providerSessionId?: string | null;
}

export interface SessionMessagesReducerContext {
  previousSessionsById?: Readonly<
    Record<string, SessionMessagesSessionIdentity>
  >;
  sessionsById: Readonly<Record<string, SessionMessagesSessionIdentity>>;
}

export function createInitialSessionMessagesState(): SessionMessagesState {
  return { messagesBySessionId: {} };
}

export function sessionMessagesReducer(
  state: SessionMessagesState,
  intent: EngineIntent,
  context: SessionMessagesReducerContext = { sessionsById: {} }
): EngineReducerResult<SessionMessagesState> {
  switch (intent.type) {
    case "message/snapshotReceived":
      return mergeIncomingMessages(state, context, intent.messages);
    case "session/snapshotReceived":
    case "session/upserted":
      return canonicalizeMessageBuckets(state, context.sessionsById);
    case "session/removed":
      return dropSessionBuckets(
        state,
        context.previousSessionsById ?? context.sessionsById,
        intent.agentSessionId
      );
    default:
      return unchanged(state);
  }
}

function mergeIncomingMessages(
  state: SessionMessagesState,
  context: SessionMessagesReducerContext,
  messages: readonly AgentActivityMessage[]
): EngineReducerResult<SessionMessagesState> {
  if (messages.length === 0) return unchanged(state);
  const bySessionId = new Map<string, AgentActivityMessage[]>();
  for (const message of messages) {
    const rawId = message.agentSessionId.trim();
    if (!rawId) continue;
    const bucket = bySessionId.get(rawId);
    if (bucket) bucket.push(message);
    else bySessionId.set(rawId, [message]);
  }
  let next = state.messagesBySessionId;
  for (const [rawId, sessionMessages] of bySessionId) {
    next = mergeSessionMessages(next, context, rawId, sessionMessages);
  }
  return next === state.messagesBySessionId
    ? unchanged(state)
    : changed({ messagesBySessionId: next });
}

/**
 * Merge a batch of one session's messages into its canonical bucket. Ports the
 * monotonic, alias-collapsing merge that previously lived in the controller
 * snapshot: a provisional-id bucket is folded into the canonical bucket and
 * removed once the session's canonical identity is known.
 */
function mergeSessionMessages(
  messagesBySessionId: Readonly<
    Record<string, readonly AgentActivityMessage[]>
  >,
  context: SessionMessagesReducerContext,
  rawAgentSessionId: string,
  messages: readonly AgentActivityMessage[]
): Readonly<Record<string, readonly AgentActivityMessage[]>> {
  const canonicalAgentSessionId = resolveCanonicalAgentSessionId(
    context.sessionsById,
    rawAgentSessionId
  );
  if (!canonicalAgentSessionId || messages.length === 0) {
    return messagesBySessionId;
  }
  const currentMessages = messagesBySessionId[canonicalAgentSessionId] ?? [];
  const hasAliasBucket =
    rawAgentSessionId !== "" &&
    rawAgentSessionId !== canonicalAgentSessionId &&
    Object.prototype.hasOwnProperty.call(
      messagesBySessionId,
      rawAgentSessionId
    );
  const aliasMessages = hasAliasBucket
    ? (messagesBySessionId[rawAgentSessionId] ?? [])
    : [];
  const currentCanonicalMessages =
    aliasMessages.length > 0
      ? mergeAgentActivityMessages(
          currentMessages,
          canonicalizeMessages(aliasMessages, canonicalAgentSessionId)
        )
      : currentMessages;
  const mergedMessages = mergeAgentActivityMessages(
    currentCanonicalMessages,
    canonicalizeMessages(messages, canonicalAgentSessionId)
  );
  if (areAgentActivityMessageArraysEqual(currentMessages, mergedMessages)) {
    return hasAliasBucket
      ? deleteBucket(messagesBySessionId, rawAgentSessionId)
      : messagesBySessionId;
  }
  const next = {
    ...messagesBySessionId,
    [canonicalAgentSessionId]: mergedMessages
  };
  if (hasAliasBucket) {
    delete next[rawAgentSessionId];
  }
  return next;
}

function canonicalizeMessageBuckets(
  state: SessionMessagesState,
  sessionsById: Readonly<Record<string, SessionMessagesSessionIdentity>>
): EngineReducerResult<SessionMessagesState> {
  let next = state.messagesBySessionId;
  for (const [rawAgentSessionId, messages] of Object.entries(
    state.messagesBySessionId
  )) {
    const canonicalAgentSessionId = resolveCanonicalAgentSessionId(
      sessionsById,
      rawAgentSessionId
    );
    if (
      !canonicalAgentSessionId ||
      canonicalAgentSessionId === rawAgentSessionId
    ) {
      continue;
    }
    const merged = mergeAgentActivityMessages(
      next[canonicalAgentSessionId] ?? [],
      canonicalizeMessages(messages, canonicalAgentSessionId)
    );
    next = deleteBucket(
      {
        ...next,
        [canonicalAgentSessionId]: merged
      },
      rawAgentSessionId
    );
  }
  return next === state.messagesBySessionId
    ? unchanged(state)
    : changed({ messagesBySessionId: next });
}

function dropSessionBuckets(
  state: SessionMessagesState,
  sessionsById: Readonly<Record<string, SessionMessagesSessionIdentity>>,
  rawAgentSessionId: string
): EngineReducerResult<SessionMessagesState> {
  const id = rawAgentSessionId.trim();
  if (!id) {
    return unchanged(state);
  }
  const session = sessionsById[id];
  const removableIds = new Set([id]);
  const providerSessionId = session?.providerSessionId?.trim() ?? "";
  if (
    providerSessionId &&
    resolveCanonicalAgentSessionId(
      sessionsById,
      providerSessionId,
      session?.provider
    ) === id
  ) {
    removableIds.add(providerSessionId);
  }
  let next = state.messagesBySessionId;
  for (const removableId of removableIds) {
    if (Object.prototype.hasOwnProperty.call(next, removableId)) {
      next = deleteBucket(next, removableId);
    }
  }
  return next === state.messagesBySessionId
    ? unchanged(state)
    : changed({ messagesBySessionId: next });
}

/**
 * Resolve a raw session id (which may be a provisional id or a provider session
 * id) to its canonical `agentSessionId`. Falls back to the raw id when no
 * unambiguous canonical session is known yet.
 */
export function resolveCanonicalAgentSessionId(
  sessionsById: Readonly<Record<string, SessionMessagesSessionIdentity>>,
  rawAgentSessionId: string | null | undefined,
  provider?: string | null
): string {
  const normalizedAgentSessionId = rawAgentSessionId?.trim() ?? "";
  if (!normalizedAgentSessionId) return "";
  if (sessionsById[normalizedAgentSessionId]) {
    return normalizedAgentSessionId;
  }
  const normalizedProvider = provider?.trim() ?? "";
  const candidates = Object.values(sessionsById).filter((session) => {
    if (session.providerSessionId?.trim() !== normalizedAgentSessionId) {
      return false;
    }
    return (
      !normalizedProvider || session.provider.trim() === normalizedProvider
    );
  });
  return candidates.length === 1
    ? candidates[0]!.agentSessionId.trim()
    : normalizedAgentSessionId;
}

function canonicalizeMessages(
  messages: readonly AgentActivityMessage[],
  agentSessionId: string
): AgentActivityMessage[] {
  return messages.map((message) =>
    message.agentSessionId === agentSessionId
      ? message
      : { ...message, agentSessionId }
  );
}

function deleteBucket(
  messagesBySessionId: Readonly<
    Record<string, readonly AgentActivityMessage[]>
  >,
  agentSessionId: string
): Record<string, readonly AgentActivityMessage[]> {
  const next = { ...messagesBySessionId };
  delete next[agentSessionId];
  return next;
}

function changed(
  state: SessionMessagesState
): EngineReducerResult<SessionMessagesState> {
  return { commands: NO_COMMANDS, state };
}

function unchanged(
  state: SessionMessagesState
): EngineReducerResult<SessionMessagesState> {
  return { commands: NO_COMMANDS, state };
}
