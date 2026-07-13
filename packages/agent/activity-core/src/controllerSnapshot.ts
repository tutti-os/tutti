import {
  areAgentActivityMessageArraysEqual,
  areJsonLikeValuesEqual,
  mergeAgentActivityMessages
} from "./merge.ts";
import {
  cloneJSONValue,
  messageVersionValue,
  nullableStringValue,
  numberValue,
  recordValue,
  stringValue
} from "./controllerValues.ts";
import type {
  AgentActivityComposerOptions,
  AgentActivityMessage,
  AgentActivitySession,
  AgentActivitySessionEventEnvelope,
  AgentActivitySnapshot
} from "./types.ts";

export function createEmptyAgentActivitySnapshot(
  workspaceId: string
): AgentActivitySnapshot {
  return {
    workspaceId,
    sessions: [],
    presences: [],
    sessionMessagesById: {},
    composerOptionsByTargetKey: {}
  };
}

export function cloneAgentActivitySnapshot(
  snapshot: AgentActivitySnapshot
): AgentActivitySnapshot {
  return {
    workspaceId: snapshot.workspaceId,
    sessions: snapshot.sessions.map(cloneAgentActivitySession),
    presences: snapshot.presences.map((presence) => ({ ...presence })),
    composerOptionsByTargetKey: Object.fromEntries(
      Object.entries(snapshot.composerOptionsByTargetKey ?? {}).map(
        ([provider, options]) => [
          provider,
          cloneAgentActivityComposerOptions(options)
        ]
      )
    ),
    sessionMessagesById: Object.fromEntries(
      Object.entries(snapshot.sessionMessagesById).map(
        ([agentSessionId, messages]) => [
          agentSessionId,
          messages.map((message) => ({
            ...message,
            payload: { ...message.payload }
          }))
        ]
      )
    )
  };
}

export function cloneAgentActivityComposerOptions(
  options: AgentActivityComposerOptions
): AgentActivityComposerOptions {
  return {
    provider: options.provider,
    models: options.models.map((option) => ({ ...option })),
    reasoningEfforts: options.reasoningEfforts.map((option) => ({ ...option })),
    reasoningOptionsByModel: options.reasoningOptionsByModel
      ? Object.fromEntries(
          Object.entries(options.reasoningOptionsByModel).map(
            ([model, profile]) => [
              model,
              {
                ...profile,
                options: profile.options.map((option) => ({ ...option }))
              }
            ]
          )
        )
      : undefined,
    speeds: (options.speeds ?? []).map((option) => ({ ...option })),
    modelConfigurable: options.modelConfigurable ?? false,
    reasoningConfigurable: options.reasoningConfigurable ?? false,
    speedConfigurable: options.speedConfigurable ?? false,
    effectiveSettings: options.effectiveSettings
      ? { ...options.effectiveSettings }
      : (options.effectiveSettings ?? null),
    permissionConfig: cloneJSONValue(
      options.permissionConfig ?? null
    ) as AgentActivityComposerOptions["permissionConfig"],
    draftAgentSessionId: options.draftAgentSessionId ?? null,
    modelOptionsLoading: options.modelOptionsLoading,
    skills: options.skills.map((skill) => ({ ...skill })),
    capabilityCatalog: (options.capabilityCatalog ?? []).map((capability) => ({
      ...capability
    })),
    behavior: { ...options.behavior },
    slashCommandPolicy: cloneJSONValue(
      options.slashCommandPolicy ?? null
    ) as AgentActivityComposerOptions["slashCommandPolicy"],
    loadedAtUnixMs: options.loadedAtUnixMs
  };
}
export function cloneAgentActivitySession(
  session: AgentActivitySession
): AgentActivitySession {
  return {
    ...session,
    activeTurn: session.activeTurn
      ? (cloneJSONValue(
          session.activeTurn
        ) as AgentActivitySession["activeTurn"])
      : session.activeTurn,
    latestTurn: session.latestTurn
      ? (cloneJSONValue(
          session.latestTurn
        ) as AgentActivitySession["latestTurn"])
      : session.latestTurn,
    latestTurnInteractions: session.latestTurnInteractions?.map(
      (interaction) =>
        cloneJSONValue(interaction) as NonNullable<
          AgentActivitySession["latestTurnInteractions"]
        >[number]
    ),
    pendingInteractions: session.pendingInteractions?.map(
      (interaction) =>
        cloneJSONValue(interaction) as NonNullable<
          AgentActivitySession["pendingInteractions"]
        >[number]
    ),
    settings: cloneJSONValue(
      session.settings
    ) as AgentActivitySession["settings"],
    permissionConfig: cloneJSONValue(
      session.permissionConfig
    ) as AgentActivitySession["permissionConfig"],
    capabilities: cloneJSONValue(
      session.capabilities
    ) as AgentActivitySession["capabilities"],
    usage: cloneJSONValue(session.usage) as AgentActivitySession["usage"],
    backgroundAgents: cloneJSONValue(
      session.backgroundAgents
    ) as AgentActivitySession["backgroundAgents"],
    goal: cloneJSONValue(session.goal) as AgentActivitySession["goal"]
  };
}

export function areComposerOptionsEqual(
  left: AgentActivityComposerOptions,
  right: AgentActivityComposerOptions
): boolean {
  const { loadedAtUnixMs: _leftLoadedAtUnixMs, ...leftComparable } = left;
  const { loadedAtUnixMs: _rightLoadedAtUnixMs, ...rightComparable } = right;
  return JSON.stringify(leftComparable) === JSON.stringify(rightComparable);
}

export function areShallowObjectArraysEqual<T extends object>(
  left: readonly T[],
  right: readonly T[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (!areShallowObjectsEqual(left[index]!, right[index]!)) {
      return false;
    }
  }
  return true;
}

function areShallowObjectsEqual(left: object, right: object): boolean {
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = new Set([
    ...Object.keys(leftRecord),
    ...Object.keys(rightRecord)
  ]);
  for (const key of keys) {
    if (!Object.is(leftRecord[key], rightRecord[key])) {
      return false;
    }
  }
  return true;
}

export function applySessionMessageEvent(
  snapshot: AgentActivitySnapshot,
  event: AgentActivitySessionEventEnvelope
): AgentActivitySnapshot {
  if (event.workspaceId && event.workspaceId !== snapshot.workspaceId) {
    return snapshot;
  }

  const data = recordValue(event.data) ?? {};
  if (event.eventType === "message_update") {
    const messages = Array.isArray(data.messages)
      ? data.messages.flatMap((value) => {
          const messageData = recordValue(value);
          const message = messageData
            ? messageFromEvent(event, messageData)
            : null;
          return message ? [message] : [];
        })
      : [];
    return messages.length > 0
      ? mergeSnapshotMessages(snapshot, event.agentSessionId, messages)
      : snapshot;
  }

  return snapshot;
}

export function mergeSnapshotMessages(
  snapshot: AgentActivitySnapshot,
  agentSessionId: string,
  messages: readonly AgentActivityMessage[]
): AgentActivitySnapshot {
  const rawAgentSessionId = agentSessionId.trim();
  const canonicalAgentSessionId = resolveCanonicalAgentSessionId(
    snapshot,
    rawAgentSessionId
  );
  if (!canonicalAgentSessionId || messages.length === 0) {
    return snapshot;
  }
  const currentMessages =
    snapshot.sessionMessagesById[canonicalAgentSessionId] ?? [];
  const aliasMessages =
    rawAgentSessionId && rawAgentSessionId !== canonicalAgentSessionId
      ? (snapshot.sessionMessagesById[rawAgentSessionId] ?? [])
      : [];
  const currentCanonicalMessages =
    aliasMessages.length > 0
      ? mergeAgentActivityMessages(
          currentMessages,
          canonicalizeAgentActivityMessages(
            aliasMessages,
            canonicalAgentSessionId
          )
        )
      : currentMessages;
  const canonicalMessages = canonicalizeAgentActivityMessages(
    messages,
    canonicalAgentSessionId
  );
  const mergedMessages = mergeAgentActivityMessages(
    currentCanonicalMessages,
    canonicalMessages
  );
  const hasAliasBucket =
    rawAgentSessionId !== "" &&
    rawAgentSessionId !== canonicalAgentSessionId &&
    Object.prototype.hasOwnProperty.call(
      snapshot.sessionMessagesById,
      rawAgentSessionId
    );
  if (areAgentActivityMessageArraysEqual(currentMessages, mergedMessages)) {
    return hasAliasBucket
      ? {
          ...snapshot,
          sessionMessagesById: deleteSessionMessageBucket(
            snapshot.sessionMessagesById,
            rawAgentSessionId
          )
        }
      : snapshot;
  }
  const sessionMessagesById = {
    ...snapshot.sessionMessagesById,
    [canonicalAgentSessionId]: mergedMessages
  };
  if (hasAliasBucket) {
    delete sessionMessagesById[rawAgentSessionId];
  }
  return {
    ...snapshot,
    sessionMessagesById
  };
}

// Diagnostic sink (temporary instrumentation): surfaces store anomalies —
// version regressions on unguarded write paths and stale-patch drops — to the
// host's logging so field exports show WHICH channel overwrote WHAT.
type AgentActivityStoreDiagnosticSink = (
  event: string,
  details: Record<string, unknown>
) => void;

function createAgentActivityStoreDiagnosticSinkHolder(): {
  report: (event: string, details: Record<string, unknown>) => void;
  set: (sink: AgentActivityStoreDiagnosticSink | null) => void;
} {
  let sink: AgentActivityStoreDiagnosticSink | null = null;
  return {
    report(event, details) {
      try {
        sink?.(event, details);
      } catch (error) {
        console.error(
          "[agent-activity-store-diagnostic]",
          JSON.stringify({
            event: "diagnostic_sink_failed",
            diagnosticEvent: event,
            error: error instanceof Error ? error.message : String(error)
          })
        );
      }
    },
    set(nextSink) {
      sink = nextSink;
    }
  };
}

const agentActivityStoreDiagnosticSinkHolder =
  createAgentActivityStoreDiagnosticSinkHolder();

export function setAgentActivityStoreDiagnosticSink(
  sink: AgentActivityStoreDiagnosticSink | null
): void {
  agentActivityStoreDiagnosticSinkHolder.set(sink);
}

export function reportAgentActivityStoreDiagnostic(
  event: string,
  details: Record<string, unknown>
): void {
  agentActivityStoreDiagnosticSinkHolder.report(event, details);
}

function sessionVersionKey(session: AgentActivitySession): number | null {
  return session.lastEventUnixMs ?? session.updatedAtUnixMs ?? null;
}

export function isSessionVersionRegression(
  source: string,
  existing: AgentActivitySession,
  incoming: AgentActivitySession
): boolean {
  const previousKey = sessionVersionKey(existing);
  const nextKey = sessionVersionKey(incoming);
  if (previousKey === null || nextKey === null || nextKey >= previousKey) {
    return false;
  }
  reportAgentActivityStoreDiagnostic("session_version_regression", {
    agentSessionId: incoming.agentSessionId,
    workspaceId: incoming.workspaceId,
    source,
    previousKey,
    nextKey
  });
  return true;
}

export function upsertSnapshotSession(
  snapshot: AgentActivitySnapshot,
  session: AgentActivitySession,
  source = "unknown"
): AgentActivitySnapshot {
  const index = snapshot.sessions.findIndex(
    (item) => item.agentSessionId === session.agentSessionId
  );
  if (index < 0) {
    return canonicalizeSnapshotMessageBuckets({
      ...snapshot,
      sessions: [...snapshot.sessions, session]
    });
  }
  const existingSession = snapshot.sessions[index];
  if (
    existingSession &&
    isSessionVersionRegression(source, existingSession, session)
  ) {
    return snapshot;
  }
  if (
    existingSession &&
    areAgentActivitySessionsEqual(existingSession, session)
  ) {
    return snapshot;
  }
  const sessions = [...snapshot.sessions];
  sessions[index] = session;
  return canonicalizeSnapshotMessageBuckets({
    ...snapshot,
    sessions
  });
}

export function areAgentActivitySessionsEqual(
  left: AgentActivitySession,
  right: AgentActivitySession
): boolean {
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const keys = new Set([
    ...Object.keys(leftRecord),
    ...Object.keys(rightRecord)
  ]);
  for (const key of keys) {
    if (!areJsonLikeValuesEqual(leftRecord[key], rightRecord[key])) {
      return false;
    }
  }
  return true;
}

export function removeSnapshotSession(
  snapshot: AgentActivitySnapshot,
  agentSessionId: string
): AgentActivitySnapshot {
  const normalizedAgentSessionId = agentSessionId.trim();
  if (!normalizedAgentSessionId) {
    return snapshot;
  }
  const sessions = snapshot.sessions.filter(
    (session) => session.agentSessionId !== normalizedAgentSessionId
  );
  const removedSession =
    snapshot.sessions.find(
      (session) => session.agentSessionId === normalizedAgentSessionId
    ) ?? null;
  const removableMessageBuckets = new Set([normalizedAgentSessionId]);
  if (removedSession) {
    for (const alias of sessionMessageAliases(removedSession)) {
      if (
        alias === normalizedAgentSessionId ||
        resolveCanonicalAgentSessionId(
          snapshot,
          alias,
          removedSession.provider
        ) === normalizedAgentSessionId
      ) {
        removableMessageBuckets.add(alias);
      }
    }
  }
  if (
    sessions.length === snapshot.sessions.length &&
    [...removableMessageBuckets].every(
      (bucket) => !snapshot.sessionMessagesById[bucket]
    )
  ) {
    return snapshot;
  }
  const sessionMessagesById = { ...snapshot.sessionMessagesById };
  for (const bucket of removableMessageBuckets) {
    delete sessionMessagesById[bucket];
  }
  return {
    ...snapshot,
    sessions,
    sessionMessagesById
  };
}

export function canonicalizeSnapshotMessageBuckets(
  snapshot: AgentActivitySnapshot
): AgentActivitySnapshot {
  let sessionMessagesById = snapshot.sessionMessagesById;
  let changed = false;

  for (const session of snapshot.sessions) {
    const canonicalAgentSessionId = session.agentSessionId.trim();
    if (!canonicalAgentSessionId) {
      continue;
    }

    let mergedMessages = sessionMessagesById[canonicalAgentSessionId] ?? [];
    for (const alias of sessionMessageAliases(session)) {
      if (
        alias !== canonicalAgentSessionId &&
        resolveCanonicalAgentSessionId(snapshot, alias, session.provider) !==
          canonicalAgentSessionId
      ) {
        continue;
      }
      const aliasMessages = sessionMessagesById[alias];
      if (!aliasMessages) {
        continue;
      }
      const canonicalMessages = canonicalizeAgentActivityMessages(
        aliasMessages,
        canonicalAgentSessionId
      );
      if (alias === canonicalAgentSessionId) {
        if (
          !areAgentActivityMessageArraysEqual(aliasMessages, canonicalMessages)
        ) {
          sessionMessagesById = {
            ...sessionMessagesById,
            [canonicalAgentSessionId]: canonicalMessages
          };
          mergedMessages = canonicalMessages;
          changed = true;
        }
        continue;
      }
      mergedMessages = mergeAgentActivityMessages(
        mergedMessages,
        canonicalMessages
      );
      sessionMessagesById = deleteSessionMessageBucket(
        sessionMessagesById,
        alias
      );
      changed = true;
    }

    const currentMessages = sessionMessagesById[canonicalAgentSessionId] ?? [];
    if (!areAgentActivityMessageArraysEqual(currentMessages, mergedMessages)) {
      sessionMessagesById = {
        ...sessionMessagesById,
        [canonicalAgentSessionId]: mergedMessages
      };
      changed = true;
    }
  }

  return changed ? { ...snapshot, sessionMessagesById } : snapshot;
}

export function resolveCanonicalAgentSessionId(
  snapshot: AgentActivitySnapshot,
  rawAgentSessionId: string | null | undefined,
  provider?: string | null
): string {
  const normalizedAgentSessionId = rawAgentSessionId?.trim() ?? "";
  if (!normalizedAgentSessionId) {
    return "";
  }

  const exactSession = snapshot.sessions.find(
    (session) => session.agentSessionId.trim() === normalizedAgentSessionId
  );
  if (exactSession) {
    return exactSession.agentSessionId.trim();
  }

  const normalizedProvider = provider?.trim() ?? "";
  const candidates = snapshot.sessions.filter((session) => {
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

function sessionMessageAliases(session: AgentActivitySession): string[] {
  const values = [session.agentSessionId, session.providerSessionId];
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const value of values) {
    const normalized = value?.trim() ?? "";
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    aliases.push(normalized);
  }
  return aliases;
}

function canonicalizeAgentActivityMessages(
  messages: readonly AgentActivityMessage[],
  agentSessionId: string
): AgentActivityMessage[] {
  return messages.map((message) =>
    message.agentSessionId === agentSessionId
      ? message
      : { ...message, agentSessionId }
  );
}

function deleteSessionMessageBucket(
  sessionMessagesById: Record<string, AgentActivityMessage[]>,
  agentSessionId: string
): Record<string, AgentActivityMessage[]> {
  if (
    !Object.prototype.hasOwnProperty.call(sessionMessagesById, agentSessionId)
  ) {
    return sessionMessagesById;
  }
  const next = { ...sessionMessagesById };
  delete next[agentSessionId];
  return next;
}

export function shouldAutoRetainSessionEvents(
  session: AgentActivitySession
): boolean {
  if (!session.agentSessionId.trim()) {
    return false;
  }
  return session.activeTurn?.phase !== "settled" && !session.latestTurn;
}

function messageFromEvent(
  event: AgentActivitySessionEventEnvelope,
  data: Record<string, unknown>
): AgentActivityMessage | null {
  const source = recordValue(data.message) ?? data;
  const agentSessionId =
    stringValue(source.agentSessionId) || event.agentSessionId;
  const messageId = stringValue(source.messageId);
  const role = stringValue(source.role);
  const kind = stringValue(source.kind);
  const turnId = stringValue(source.turnId);
  const version = messageVersionValue(source);
  const occurredAtUnixMs = numberValue(source.occurredAtUnixMs);
  if (
    !agentSessionId ||
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
    workspaceId: stringValue(source.workspaceId) || event.workspaceId,
    agentSessionId,
    messageId,
    version,
    turnId,
    role,
    kind,
    status: nullableStringValue(source.status),
    semantics: recordValue(source.semantics)
      ? (cloneJSONValue(source.semantics) as AgentActivityMessage["semantics"])
      : undefined,
    payload: recordValue(source.payload) ?? {},
    occurredAtUnixMs,
    startedAtUnixMs: numberValue(source.startedAtUnixMs),
    completedAtUnixMs: numberValue(source.completedAtUnixMs)
  };
}
