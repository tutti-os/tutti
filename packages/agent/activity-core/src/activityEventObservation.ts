import { parseInlineActivityMessages } from "./inlineActivityMessages.ts";
import type {
  AgentActivityMessage,
  AgentActivityUpdatedEvent
} from "./types.ts";
import type { SessionActivityObservedIntent } from "./engine/sessionReconcile.types.ts";

type ObservableAgentActivityUpdatedEvent = Exclude<
  AgentActivityUpdatedEvent,
  { eventType: "message_delta" | "session_deleted" }
>;

export interface InlineMessageVersionContinuity {
  cachedVersion: number;
  continuous: boolean;
  firstUnseenVersion: number | null;
  latestIncomingVersion: number;
}

export interface AgentActivityEventObservation {
  canApplyInlineMessages: boolean;
  inlineContinuity: InlineMessageVersionContinuity;
  inlineMessages: readonly AgentActivityMessage[];
  intent: SessionActivityObservedIntent;
}

/**
 * Derives the one engine observation for an authoritative activity event.
 *
 * Hosts may apply continuous inline messages before dispatching `intent`.
 * The engine remains responsible for choosing the authoritative reconcile
 * scope. Message deltas and deletion tombstones have separate stateful host
 * handling and are deliberately excluded from this helper.
 */
export function analyzeAgentActivityEventObservation(input: {
  cachedMessages: readonly AgentActivityMessage[];
  event: ObservableAgentActivityUpdatedEvent;
  hasCachedSession: boolean;
}): AgentActivityEventObservation {
  const inlineMessages = parseInlineActivityMessages(input.event);
  const inlinePayloadConsistent = isInlinePayloadConsistent(
    input.event,
    inlineMessages
  );
  const inlineContinuity = analyzeInlineMessageVersionContinuity(
    input.cachedMessages,
    inlineMessages
  );
  const canApplyInlineMessages =
    inlineMessages.length > 0 &&
    inlinePayloadConsistent &&
    inlineContinuity.continuous;
  return {
    canApplyInlineMessages,
    inlineContinuity,
    inlineMessages,
    intent: {
      agentSessionId: input.event.agentSessionId,
      eventType: input.event.eventType,
      hasCachedSession: input.hasCachedSession,
      hasInlineMessages: inlineMessages.length > 0,
      inlineApplied: input.hasCachedSession && canApplyInlineMessages,
      type: "session/activityObserved",
      workspaceId: input.event.workspaceId
    }
  };
}

function isInlinePayloadConsistent(
  event: ObservableAgentActivityUpdatedEvent,
  inlineMessages: readonly AgentActivityMessage[]
): boolean {
  if (!agentActivityEventEnvelopeIsConsistent(event)) {
    return false;
  }
  const workspaceId = event.workspaceId.trim();
  const agentSessionId = event.agentSessionId.trim();
  if (
    inlineMessages.some(
      (message) =>
        message.workspaceId !== workspaceId ||
        message.agentSessionId !== agentSessionId
    )
  )
    return false;

  if (event.eventType === "session_audit") {
    return inlineMessages.length === 1;
  }
  if (event.eventType !== "message_update") {
    return false;
  }

  if (
    inlineMessages.length !== event.data.messages.length ||
    event.data.acceptedCount !== event.data.messages.length
  ) {
    return false;
  }
  const latestInlineVersion = inlineMessages.reduce(
    (latest, message) => Math.max(latest, message.version),
    0
  );
  return (
    Number.isSafeInteger(event.data.latestVersion) &&
    event.data.latestVersion >= 0 &&
    latestInlineVersion === event.data.latestVersion
  );
}

export function agentActivityEventEnvelopeIsConsistent(
  event: AgentActivityUpdatedEvent
): boolean {
  const workspaceId = event.workspaceId.trim();
  const agentSessionId = event.agentSessionId.trim();
  const data: Record<string, unknown> | null = isRecord(event.data)
    ? (event.data as unknown as Record<string, unknown>)
    : null;
  if (
    !workspaceId ||
    !agentSessionId ||
    !data ||
    data.workspaceId !== workspaceId ||
    data.agentSessionId !== agentSessionId ||
    (event.eventType !== "message_delta" && data.eventType !== event.eventType)
  ) {
    return false;
  }
  if (
    event.eventType === "turn_update" &&
    event.data.turn !== undefined &&
    (!isRecord(event.data.turn) ||
      event.data.turn.agentSessionId !== agentSessionId)
  ) {
    return false;
  }
  return (
    event.eventType !== "interaction_update" ||
    event.data.interaction === undefined ||
    (isRecord(event.data.interaction) &&
      event.data.interaction.agentSessionId === agentSessionId)
  );
}

/**
 * Realtime messages may be folded directly only when they extend the cached
 * per-session change cursor without a hole. Otherwise a later incremental read
 * could skip a missed mutable snapshot permanently.
 */
export function analyzeInlineMessageVersionContinuity(
  cached: readonly AgentActivityMessage[],
  incoming: readonly AgentActivityMessage[]
): InlineMessageVersionContinuity {
  const cachedVersion = latestMessageVersion(cached);
  const incomingVersions = [
    ...new Set(incoming.map((message) => message.version))
  ].sort((left, right) => left - right);
  const latestIncomingVersion = incomingVersions.at(-1) ?? 0;
  const unseenVersions = incomingVersions.filter(
    (version) => version > cachedVersion
  );
  const versionsAreValid = incomingVersions.every(
    (version) => Number.isSafeInteger(version) && version > 0
  );
  return {
    cachedVersion,
    continuous:
      versionsAreValid &&
      unseenVersions.every(
        (version, index) => version === cachedVersion + index + 1
      ),
    firstUnseenVersion: unseenVersions[0] ?? null,
    latestIncomingVersion
  };
}

function latestMessageVersion(
  messages: readonly AgentActivityMessage[]
): number {
  return messages.reduce(
    (latest, message) => Math.max(latest, message.version),
    0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
