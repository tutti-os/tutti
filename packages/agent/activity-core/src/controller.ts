import type { AgentActivityAdapter } from "./adapter.ts";
import {
  areAgentActivityMessageArraysEqual,
  cloneAgentActivityMessage,
  latestAgentActivityMessageVersion,
  mergeAgentActivityMessages
} from "./merge.ts";
import { loadAllAgentSessionMessages } from "./pagination.ts";
import type {
  AgentActivityComposerOptions,
  AgentActivityLoadComposerOptionsInput,
  AgentActivityMessage,
  AgentActivityMessageOrder,
  AgentActivityMessagePage,
  AgentActivityStatePatch,
  AgentActivitySession,
  AgentActivitySessionEventEnvelope,
  AgentActivitySnapshot,
  AgentActivityUpdatedApplyResult,
  AgentActivityUpdatedEvent
} from "./types.ts";

export interface CreateAgentActivityControllerInput {
  adapter: AgentActivityAdapter;
  autoRetainSessionEvents?: boolean;
  workspaceId: string;
}

export interface AgentActivityController {
  getSnapshot(): AgentActivitySnapshot;
  subscribe(listener: AgentActivitySnapshotListener): () => void;
  load(signal?: AbortSignal): Promise<AgentActivitySnapshot>;
  loadComposerOptions(
    input: Omit<AgentActivityLoadComposerOptionsInput, "workspaceId"> & {
      force?: boolean;
    }
  ): Promise<AgentActivityComposerOptions>;
  listSessionMessages(input: {
    agentSessionId: string;
    afterVersion?: number;
    beforeVersion?: number;
    cache?: boolean;
    limit?: number;
    order?: AgentActivityMessageOrder;
    signal?: AbortSignal;
  }): Promise<AgentActivityMessagePage>;
  retainSessionEvents(input: {
    agentSessionId: string;
    afterVersion?: number;
    onError?: (error: unknown) => void;
  }): () => void;
  removeSession(agentSessionId: string): void;
  upsertSession(session: AgentActivitySession): void;
  applyActivityUpdatedEvent(
    event: AgentActivityUpdatedEvent
  ): AgentActivityUpdatedApplyResult;
  applySessionEvent(event: AgentActivitySessionEventEnvelope): void;
}

export type AgentActivitySnapshotListener = (
  snapshot: AgentActivitySnapshot
) => void;

interface RetainedSessionStream {
  abortController: AbortController;
  refCount: number;
  unsubscribe: (() => void) | null;
}

export function createAgentActivityController({
  adapter,
  autoRetainSessionEvents = true,
  workspaceId
}: CreateAgentActivityControllerInput): AgentActivityController {
  const listeners = new Set<AgentActivitySnapshotListener>();
  const activeMessageSyncs = new Map<string, Promise<void>>();
  const activeComposerOptionsLoads = new Map<
    string,
    Promise<AgentActivityComposerOptions>
  >();
  const composerOptionsLoadVersions = new Map<string, number>();
  const composerOptionsCwdByProvider = new Map<string, string>();
  const activeComposerOptionsLoadCwds = new Map<string, string>();
  const normalizeComposerCwd = (cwd: string | null | undefined): string =>
    (cwd ?? "").trim();
  const autoRetainedStreamReleases = new Map<string, () => void>();
  const retainedStreams = new Map<string, RetainedSessionStream>();
  let snapshot: AgentActivitySnapshot =
    createEmptyAgentActivitySnapshot(workspaceId);

  const emit = (): void => {
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const updateSnapshot = (
    updater: (current: AgentActivitySnapshot) => AgentActivitySnapshot
  ): AgentActivitySnapshot => {
    const nextSnapshot = updater(snapshot);
    if (nextSnapshot === snapshot) {
      return snapshot;
    }
    snapshot = cloneAgentActivitySnapshot(nextSnapshot);
    emit();
    return snapshot;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },
    async load(signal) {
      const response = await adapter.listSessions({ workspaceId, signal });
      const nextSessions = response.sessions;
      const nextPresences = response.presences ?? [];
      const nextSnapshot = updateSnapshot((current) => {
        const sessionDataUnchanged =
          areShallowObjectArraysEqual(current.sessions, nextSessions) &&
          areShallowObjectArraysEqual(current.presences, nextPresences);
        const source = sessionDataUnchanged
          ? current
          : {
              ...current,
              presences: nextPresences,
              sessions: nextSessions
            };
        const canonical = canonicalizeSnapshotMessageBuckets(source);
        if (canonical !== source) {
          return canonical;
        }
        return sessionDataUnchanged ? current : source;
      });
      if (autoRetainSessionEvents) {
        reconcileAutoRetainedSessionStreams(nextSnapshot.sessions, signal);
      }
      return nextSnapshot;
    },
    async loadComposerOptions(input) {
      const provider = input.provider.trim();
      if (!provider) {
        throw new Error("Agent composer options provider is required.");
      }
      const requestedCwd = normalizeComposerCwd(input.cwd);
      if (!input.force) {
        const cached = snapshot.composerOptionsByProvider?.[provider];
        if (
          cached &&
          composerOptionsCwdByProvider.get(provider) === requestedCwd
        ) {
          return cloneAgentActivityComposerOptions(cached);
        }
      }
      const existingLoad = activeComposerOptionsLoads.get(provider);
      if (
        existingLoad &&
        !input.force &&
        activeComposerOptionsLoadCwds.get(provider) === requestedCwd
      ) {
        return existingLoad.then(cloneAgentActivityComposerOptions);
      }
      const loadVersion = (composerOptionsLoadVersions.get(provider) ?? 0) + 1;
      composerOptionsLoadVersions.set(provider, loadVersion);
      const load = adapter
        .loadComposerOptions({
          workspaceId,
          provider,
          cwd: input.cwd,
          settings: input.settings,
          signal: input.signal
        })
        .then((options) => {
          const normalizedOptions = cloneAgentActivityComposerOptions({
            ...options,
            provider,
            loadedAtUnixMs: options.loadedAtUnixMs || Date.now()
          });
          if (composerOptionsLoadVersions.get(provider) !== loadVersion) {
            return cloneAgentActivityComposerOptions(normalizedOptions);
          }
          composerOptionsCwdByProvider.set(provider, requestedCwd);
          updateSnapshot((current) => {
            const currentOptions =
              current.composerOptionsByProvider?.[provider];
            if (
              currentOptions &&
              areComposerOptionsEqual(currentOptions, normalizedOptions)
            ) {
              return current;
            }
            return {
              ...current,
              composerOptionsByProvider: {
                ...current.composerOptionsByProvider,
                [provider]: normalizedOptions
              }
            };
          });
          return cloneAgentActivityComposerOptions(normalizedOptions);
        })
        .finally(() => {
          if (activeComposerOptionsLoads.get(provider) === load) {
            activeComposerOptionsLoads.delete(provider);
            activeComposerOptionsLoadCwds.delete(provider);
          }
        });
      activeComposerOptionsLoads.set(provider, load);
      activeComposerOptionsLoadCwds.set(provider, requestedCwd);
      return load.then(cloneAgentActivityComposerOptions);
    },
    async listSessionMessages({
      agentSessionId,
      afterVersion,
      beforeVersion,
      cache = true,
      limit,
      order,
      signal
    }) {
      const response = await adapter.listSessionMessages({
        workspaceId,
        agentSessionId,
        afterVersion,
        beforeVersion,
        limit,
        order,
        signal
      });
      if (cache) {
        updateSnapshot((current) =>
          mergeSnapshotMessages(current, agentSessionId, response.messages)
        );
      }
      return {
        ...response,
        messages: response.messages.map((message) => ({
          ...message,
          payload: { ...message.payload }
        }))
      };
    },
    retainSessionEvents: retainSessionEventsImpl,
    removeSession(agentSessionId) {
      updateSnapshot((current) =>
        removeSnapshotSession(current, agentSessionId)
      );
    },
    upsertSession(session) {
      if (session.workspaceId && session.workspaceId !== snapshot.workspaceId) {
        return;
      }
      updateSnapshot((current) => upsertSnapshotSession(current, session));
    },
    applyActivityUpdatedEvent(event) {
      const result = applyActivityUpdatedEvent(snapshot, event);
      if (result.snapshot !== snapshot) {
        snapshot = result.snapshot;
        emit();
      }
      return {
        applied: result.applied,
        messages: result.messages.map(cloneAgentActivityMessage),
        session: result.session
          ? cloneAgentActivitySession(result.session)
          : null,
        statePatch: result.statePatch
          ? cloneAgentActivityStatePatch(result.statePatch)
          : null
      };
    },
    applySessionEvent(event) {
      updateSnapshot((current) => applySessionEvent(current, event));
    }
  };

  function retainSessionEventsImpl({
    agentSessionId,
    afterVersion,
    onRetainFailed,
    onError
  }: {
    agentSessionId: string;
    afterVersion?: number;
    onRetainFailed?: () => void;
    onError?: (error: unknown) => void;
  }): () => void {
    const normalizedAgentSessionId = agentSessionId.trim();
    if (!normalizedAgentSessionId) {
      return () => {};
    }

    const existing = retainedStreams.get(normalizedAgentSessionId);
    if (existing) {
      existing.refCount += 1;
      return createRetainedStreamRelease(normalizedAgentSessionId);
    }

    const abortController = new AbortController();
    const stream: RetainedSessionStream = {
      abortController,
      refCount: 1,
      unsubscribe: null
    };
    retainedStreams.set(normalizedAgentSessionId, stream);

    const cachedMessages =
      snapshot.sessionMessagesById[normalizedAgentSessionId] ?? [];
    const streamAfterVersion =
      afterVersion ?? latestAgentActivityMessageVersion(cachedMessages);

    void adapter
      .subscribeSessionEvents({
        workspaceId,
        agentSessionId: normalizedAgentSessionId,
        afterVersion: streamAfterVersion,
        signal: abortController.signal,
        onEvent(event) {
          if (!abortController.signal.aborted) {
            updateSnapshot((current) => applySessionEvent(current, event));
          }
        },
        onError
      })
      .then((unsubscribe) => {
        const retained = retainedStreams.get(normalizedAgentSessionId);
        if (!retained || retained.abortController.signal.aborted) {
          unsubscribe();
          return;
        }
        retained.unsubscribe = unsubscribe;
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) {
          onError?.(error);
        }
        if (retainedStreams.get(normalizedAgentSessionId) === stream) {
          retainedStreams.delete(normalizedAgentSessionId);
        }
        onRetainFailed?.();
        abortController.abort();
        stream.unsubscribe?.();
      });

    return createRetainedStreamRelease(normalizedAgentSessionId);
  }

  function reconcileAutoRetainedSessionStreams(
    sessions: readonly AgentActivitySession[],
    signal: AbortSignal | undefined
  ): void {
    const activeSessionIds = new Set(
      sessions
        .filter(shouldAutoRetainSessionEvents)
        .map((session) => session.agentSessionId.trim())
        .filter(Boolean)
    );

    for (const [agentSessionId, release] of autoRetainedStreamReleases) {
      if (!activeSessionIds.has(agentSessionId)) {
        release();
        autoRetainedStreamReleases.delete(agentSessionId);
      }
    }

    for (const agentSessionId of activeSessionIds) {
      if (!autoRetainedStreamReleases.has(agentSessionId)) {
        autoRetainedStreamReleases.set(
          agentSessionId,
          retainSessionEventsImpl({
            agentSessionId,
            onRetainFailed() {
              autoRetainedStreamReleases.delete(agentSessionId);
            }
          })
        );
      }
      syncSessionMessages(agentSessionId, signal);
    }
  }

  function syncSessionMessages(
    agentSessionId: string,
    signal: AbortSignal | undefined
  ): void {
    if (activeMessageSyncs.has(agentSessionId)) {
      return;
    }
    const cachedMessages = snapshot.sessionMessagesById[agentSessionId] ?? [];
    const afterVersion = latestAgentActivityMessageVersion(cachedMessages);
    const sync = loadAllAgentSessionMessages({
      afterVersion,
      shouldAbort: () => signal?.aborted ?? false,
      listPage: (cursor) =>
        adapter.listSessionMessages({
          workspaceId,
          agentSessionId,
          afterVersion: cursor,
          signal
        }),
      onPage: (messages) => {
        updateSnapshot((current) =>
          mergeSnapshotMessages(current, agentSessionId, messages)
        );
      }
    })
      .then(() => undefined)
      .catch(() => {})
      .finally(() => {
        if (activeMessageSyncs.get(agentSessionId) === sync) {
          activeMessageSyncs.delete(agentSessionId);
        }
      });
    activeMessageSyncs.set(agentSessionId, sync);
  }

  function createRetainedStreamRelease(agentSessionId: string): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      releaseRetainedStream(agentSessionId);
    };
  }

  function releaseRetainedStream(agentSessionId: string): void {
    const stream = retainedStreams.get(agentSessionId);
    if (!stream) {
      return;
    }
    stream.refCount -= 1;
    if (stream.refCount > 0) {
      return;
    }
    retainedStreams.delete(agentSessionId);
    stream.abortController.abort();
    stream.unsubscribe?.();
  }
}

export function createEmptyAgentActivitySnapshot(
  workspaceId: string
): AgentActivitySnapshot {
  return {
    workspaceId,
    sessions: [],
    presences: [],
    sessionMessagesById: {},
    composerOptionsByProvider: {}
  };
}

export function cloneAgentActivitySnapshot(
  snapshot: AgentActivitySnapshot
): AgentActivitySnapshot {
  return {
    workspaceId: snapshot.workspaceId,
    sessions: snapshot.sessions.map(cloneAgentActivitySession),
    presences: snapshot.presences.map((presence) => ({ ...presence })),
    composerOptionsByProvider: Object.fromEntries(
      Object.entries(snapshot.composerOptionsByProvider ?? {}).map(
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

function cloneAgentActivityComposerOptions(
  options: AgentActivityComposerOptions
): AgentActivityComposerOptions {
  return {
    provider: options.provider,
    models: options.models.map((option) => ({ ...option })),
    reasoningEfforts: options.reasoningEfforts.map((option) => ({
      ...option
    })),
    speeds: (options.speeds ?? []).map((option) => ({
      ...option
    })),
    modelConfigurable: options.modelConfigurable ?? false,
    reasoningConfigurable: options.reasoningConfigurable ?? false,
    speedConfigurable: options.speedConfigurable ?? false,
    permissionConfig: options.permissionConfig
      ? {
          configurable: options.permissionConfig.configurable,
          defaultValue: options.permissionConfig.defaultValue ?? null,
          modes: options.permissionConfig.modes.map((mode) => ({ ...mode }))
        }
      : (options.permissionConfig ?? null),
    runtimeContext: cloneJSONRecord(options.runtimeContext),
    skills: options.skills.map((skill) => ({ ...skill })),
    capabilityCatalog: (options.capabilityCatalog ?? []).map((capability) => ({
      ...capability
    })),
    loadedAtUnixMs: options.loadedAtUnixMs
  };
}

function cloneAgentActivitySession(
  session: AgentActivitySession
): AgentActivitySession {
  return {
    ...session,
    turnLifecycle: session.turnLifecycle
      ? (cloneJSONValue(
          session.turnLifecycle
        ) as AgentActivitySession["turnLifecycle"])
      : session.turnLifecycle,
    submitAvailability: session.submitAvailability
      ? { ...session.submitAvailability }
      : session.submitAvailability,
    runtimeContext: cloneJSONRecord(session.runtimeContext)
  };
}

function areComposerOptionsEqual(
  left: AgentActivityComposerOptions,
  right: AgentActivityComposerOptions
): boolean {
  const { loadedAtUnixMs: _leftLoadedAtUnixMs, ...leftComparable } = left;
  const { loadedAtUnixMs: _rightLoadedAtUnixMs, ...rightComparable } = right;
  return JSON.stringify(leftComparable) === JSON.stringify(rightComparable);
}

function cloneJSONRecord<T extends Record<string, unknown> | undefined>(
  value: T
): T {
  if (value === undefined) {
    return value;
  }
  return cloneJSONValue(value) as T;
}

function cloneJSONValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneJSONValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        cloneJSONValue(entry)
      ])
    );
  }
  return value;
}

function areShallowObjectArraysEqual<T extends object>(
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

function applyActivityUpdatedEvent(
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

  if (event.eventType === "state_patch") {
    return applyActivityUpdatedStatePatch(snapshot, {
      agentSessionId,
      data: event.data,
      workspaceId
    });
  }

  return emptyActivityUpdatedApplyResult(snapshot);
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
      snapshot,
      statePatch: null
    };
  }
  return {
    applied: true,
    messages,
    session: null,
    snapshot: nextSnapshot,
    statePatch: null
  };
}

function applyActivityUpdatedStatePatch(
  snapshot: AgentActivitySnapshot,
  input: {
    agentSessionId: string;
    data: unknown;
    workspaceId: string;
  }
): AgentActivityUpdatedApplyResult & { snapshot: AgentActivitySnapshot } {
  const statePatch = inlineStatePatchFromActivityUpdateData(input.data);
  if (!statePatch) {
    return emptyActivityUpdatedApplyResult(snapshot);
  }
  const canonicalEventSessionId = resolveCanonicalAgentSessionId(
    snapshot,
    input.agentSessionId,
    statePatch.provider
  );
  const canonicalPatchSessionId = resolveCanonicalAgentSessionId(
    snapshot,
    statePatch.agentSessionId,
    statePatch.provider
  );
  if (canonicalPatchSessionId !== canonicalEventSessionId) {
    return emptyActivityUpdatedApplyResult(snapshot);
  }
  const canonicalStatePatch = {
    ...statePatch,
    agentSessionId: canonicalPatchSessionId
  };
  const existingSession =
    snapshot.sessions.find(
      (session) => session.agentSessionId === canonicalPatchSessionId
    ) ?? null;
  if (
    !existingSession ||
    isStaleStatePatch(existingSession, canonicalStatePatch)
  ) {
    return emptyActivityUpdatedApplyResult(snapshot);
  }
  const session = agentActivitySessionFromInlineStatePatch({
    existingSession,
    patch: canonicalStatePatch,
    workspaceId: input.workspaceId
  });
  return {
    applied: true,
    messages: [],
    session,
    snapshot: upsertSnapshotSession(snapshot, session),
    statePatch: canonicalStatePatch
  };
}

function emptyActivityUpdatedApplyResult(
  snapshot: AgentActivitySnapshot
): AgentActivityUpdatedApplyResult & { snapshot: AgentActivitySnapshot } {
  return {
    applied: false,
    messages: [],
    session: null,
    snapshot,
    statePatch: null
  };
}

function applySessionEvent(
  snapshot: AgentActivitySnapshot,
  event: AgentActivitySessionEventEnvelope
): AgentActivitySnapshot {
  if (event.workspaceId && event.workspaceId !== snapshot.workspaceId) {
    return snapshot;
  }

  const data = recordValue(event.data) ?? {};
  if (event.eventType === "message_update") {
    const message = messageFromEvent(event, data);
    return message
      ? mergeSnapshotMessages(snapshot, message.agentSessionId, [message])
      : snapshot;
  }

  if (event.eventType === "session_update") {
    const session = sessionFromEvent(snapshot.workspaceId, event, data);
    return session ? upsertSnapshotSession(snapshot, session) : snapshot;
  }

  return snapshot;
}

function mergeSnapshotMessages(
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

function upsertSnapshotSession(
  snapshot: AgentActivitySnapshot,
  session: AgentActivitySession
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
  const sessions = [...snapshot.sessions];
  sessions[index] = session;
  return canonicalizeSnapshotMessageBuckets({
    ...snapshot,
    sessions
  });
}

function removeSnapshotSession(
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

function canonicalizeSnapshotMessageBuckets(
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

function resolveCanonicalAgentSessionId(
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

function shouldAutoRetainSessionEvents(session: AgentActivitySession): boolean {
  if (!session.agentSessionId.trim()) {
    return false;
  }
  switch (session.status.trim()) {
    case "canceled":
    case "completed":
    case "failed":
      return false;
    default:
      return true;
  }
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
    id: numberValue(source.id),
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

function sessionFromEvent(
  workspaceId: string,
  event: AgentActivitySessionEventEnvelope,
  data: Record<string, unknown>
): AgentActivitySession | null {
  const source = recordValue(data.session) ?? data;
  const agentSessionId =
    stringValue(source.agentSessionId) || event.agentSessionId;
  if (!agentSessionId) {
    return null;
  }
  return {
    workspaceId: stringValue(source.workspaceId) || workspaceId,
    agentSessionId,
    provider: stringValue(source.provider),
    providerSessionId: nullableStringValue(source.providerSessionId),
    model: nullableStringValue(source.model),
    cwd: stringValue(source.cwd),
    title: stringValue(source.title),
    status: stringValue(source.status) || "unknown",
    turnLifecycle: recordValue(source.turnLifecycle)
      ? (cloneJSONValue(
          source.turnLifecycle
        ) as AgentActivitySession["turnLifecycle"])
      : undefined,
    submitAvailability: recordValue(source.submitAvailability)
      ? (cloneJSONValue(
          source.submitAvailability
        ) as AgentActivitySession["submitAvailability"])
      : undefined,
    resumable: booleanValue(source.resumable),
    currentPhase: nullableStringValue(source.currentPhase),
    lastError: nullableStringValue(source.lastError),
    runtimeContext: cloneJSONRecord(
      recordValue(source.runtimeContext) ?? undefined
    ),
    messageVersion: numberValue(source.messageVersion),
    lastEventUnixMs: numberValue(source.lastEventUnixMs),
    startedAtUnixMs: numberValue(source.startedAtUnixMs),
    endedAtUnixMs: numberValue(source.endedAtUnixMs),
    createdAtUnixMs: numberValue(source.createdAtUnixMs),
    updatedAtUnixMs: numberValue(source.updatedAtUnixMs)
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
    id: numberValue(input.message.id),
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

function inlineStatePatchFromActivityUpdateData(
  data: unknown
): AgentActivityStatePatch | null {
  const source = recordValue(data);
  const agentSessionId = stringValue(source?.agentSessionId);
  if (!source || !agentSessionId) {
    return null;
  }
  const turn = recordValue(source.turn);
  const submitAvailability = recordValue(source.submitAvailability);
  return {
    agentSessionId,
    currentPhase: stringValue(source.currentPhase) || undefined,
    cwd: stringValue(source.cwd) || undefined,
    lastError: stringValue(source.lastError) || undefined,
    lastEventUnixMs: numberValue(source.lastEventUnixMs),
    lifecycleStatus: stringValue(source.lifecycleStatus) || undefined,
    model: stringValue(source.model) || undefined,
    occurredAtUnixMs: numberValue(source.occurredAtUnixMs),
    provider: stringValue(source.provider) || undefined,
    providerSessionId: stringValue(source.providerSessionId) || undefined,
    runtimeContext: cloneJSONRecord(
      recordValue(source.runtimeContext) ?? undefined
    ),
    startedAtUnixMs: numberValue(source.startedAtUnixMs),
    endedAtUnixMs: numberValue(source.endedAtUnixMs),
    title: stringValue(source.title) || undefined,
    turn: turn
      ? {
          ...(turn.activeTurnId !== undefined
            ? { activeTurnId: nullableStringValue(turn.activeTurnId) }
            : {}),
          ...(recordValue(turn.completedCommand)
            ? {
                completedCommand: cloneJSONValue(
                  turn.completedCommand
                ) as NonNullable<
                  NonNullable<
                    AgentActivityStatePatch["turn"]
                  >["completedCommand"]
                >
              }
            : {}),
          completedAtUnixMs: numberValue(turn.completedAtUnixMs),
          fileChanges: turn.fileChanges,
          outcome: stringValue(turn.outcome) || undefined,
          phase: stringValue(turn.phase) || undefined,
          ...(turn.settling !== undefined
            ? { settling: booleanValue(turn.settling) }
            : {}),
          ...(recordValue(turn.submitAvailability)
            ? {
                submitAvailability: cloneJSONValue(
                  turn.submitAvailability
                ) as NonNullable<
                  NonNullable<
                    AgentActivityStatePatch["turn"]
                  >["submitAvailability"]
                >
              }
            : {}),
          startedAtUnixMs: numberValue(turn.startedAtUnixMs),
          turnId: stringValue(turn.turnId)
        }
      : undefined,
    submitAvailability: submitAvailability
      ? (cloneJSONValue(
          submitAvailability
        ) as AgentActivityStatePatch["submitAvailability"])
      : undefined,
    workspaceId: stringValue(source.workspaceId) || undefined
  };
}

function isStaleStatePatch(
  session: AgentActivitySession,
  patch: AgentActivityStatePatch
): boolean {
  const nextTime = patch.lastEventUnixMs ?? patch.occurredAtUnixMs;
  const currentTime = session.lastEventUnixMs ?? session.updatedAtUnixMs;
  return (
    typeof nextTime === "number" &&
    typeof currentTime === "number" &&
    nextTime < currentTime
  );
}

function agentActivitySessionFromInlineStatePatch(input: {
  existingSession: AgentActivitySession;
  patch: AgentActivityStatePatch;
  workspaceId: string;
}): AgentActivitySession {
  return {
    ...input.existingSession,
    workspaceId: input.patch.workspaceId ?? input.workspaceId,
    agentSessionId: input.patch.agentSessionId,
    provider: input.patch.provider ?? input.existingSession.provider,
    providerSessionId:
      input.patch.providerSessionId ?? input.existingSession.providerSessionId,
    model: input.patch.model ?? input.existingSession.model,
    cwd: input.patch.cwd ?? input.existingSession.cwd,
    title: input.patch.title ?? input.existingSession.title,
    status: input.patch.lifecycleStatus ?? input.existingSession.status,
    turnLifecycle:
      turnLifecycleFromStatePatch(input.patch) ??
      (cloneJSONValue(
        input.existingSession.turnLifecycle
      ) as AgentActivitySession["turnLifecycle"]),
    submitAvailability:
      input.patch.submitAvailability ??
      input.patch.turn?.submitAvailability ??
      input.existingSession.submitAvailability,
    currentPhase:
      input.patch.currentPhase ??
      input.patch.turn?.phase ??
      input.existingSession.currentPhase,
    lastError: input.patch.lastError ?? input.existingSession.lastError,
    runtimeContext:
      cloneJSONRecord(input.patch.runtimeContext) ??
      cloneJSONRecord(input.existingSession.runtimeContext),
    lastEventUnixMs:
      input.patch.lastEventUnixMs ??
      input.patch.occurredAtUnixMs ??
      input.existingSession.lastEventUnixMs,
    startedAtUnixMs:
      input.patch.startedAtUnixMs ?? input.existingSession.startedAtUnixMs,
    endedAtUnixMs:
      input.patch.endedAtUnixMs ?? input.existingSession.endedAtUnixMs,
    updatedAtUnixMs:
      input.patch.occurredAtUnixMs ??
      input.patch.lastEventUnixMs ??
      input.existingSession.updatedAtUnixMs
  };
}

function cloneAgentActivityStatePatch(
  statePatch: AgentActivityStatePatch
): AgentActivityStatePatch {
  return {
    ...statePatch,
    runtimeContext: cloneJSONRecord(statePatch.runtimeContext),
    ...(statePatch.submitAvailability
      ? { submitAvailability: { ...statePatch.submitAvailability } }
      : {}),
    turn: statePatch.turn
      ? {
          ...statePatch.turn,
          ...(statePatch.turn.completedCommand
            ? {
                completedCommand: {
                  ...statePatch.turn.completedCommand
                }
              }
            : {}),
          ...(statePatch.turn.submitAvailability
            ? {
                submitAvailability: {
                  ...statePatch.turn.submitAvailability
                }
              }
            : {})
        }
      : undefined
  };
}

function turnLifecycleFromStatePatch(
  patch: AgentActivityStatePatch
): AgentActivitySession["turnLifecycle"] | undefined {
  const turn = patch.turn;
  if (!turn?.phase) {
    return undefined;
  }
  const phase = turn.phase;
  const activeTurnId =
    turn.activeTurnId !== undefined
      ? turn.activeTurnId
      : phase === "settled"
        ? null
        : turn.turnId || null;
  return {
    activeTurnId,
    phase,
    settling: turn.settling,
    outcome: turn.outcome ?? null,
    completedCommand: turn.completedCommand ?? null
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableStringValue(value: unknown): string | null | undefined {
  return typeof value === "string" ? value : value === null ? null : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function messageVersionValue(source: Record<string, unknown>): number {
  return numberValue(source.version) ?? numberValue(source.seq) ?? 0;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
