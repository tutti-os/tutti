import type { AgentActivityAdapter } from "./adapter.ts";
import {
  areAgentActivityMessageArraysEqual,
  cloneAgentActivityMessage,
  latestAgentActivityMessageVersion,
  mergeAgentActivityMessages
} from "./merge.ts";
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
        if (
          areShallowObjectArraysEqual(current.sessions, nextSessions) &&
          areShallowObjectArraysEqual(current.presences, nextPresences)
        ) {
          return current;
        }
        return {
          ...current,
          presences: nextPresences,
          sessions: nextSessions
        };
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
      updateSnapshot((current) =>
        mergeSnapshotMessages(current, agentSessionId, response.messages)
      );
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
        session: result.session ? { ...result.session } : null,
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
    const sync = adapter
      .listSessionMessages({
        workspaceId,
        agentSessionId,
        afterVersion,
        signal
      })
      .then((response) => {
        if (signal?.aborted) {
          return;
        }
        updateSnapshot((current) =>
          mergeSnapshotMessages(current, agentSessionId, response.messages)
        );
      })
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
    sessions: snapshot.sessions.map((session) => ({ ...session })),
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
    loadedAtUnixMs: options.loadedAtUnixMs
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
  const sessionMessages = inlineMessages.filter((message) =>
    inlineMessageBelongsToSession(message, input.agentSessionId)
  );
  if (sessionMessages.length === 0) {
    return emptyActivityUpdatedApplyResult(snapshot);
  }
  const messages = sessionMessages.map((message) =>
    agentActivityMessageFromInlineMessage({
      agentSessionId: input.agentSessionId,
      message,
      workspaceId: input.workspaceId
    })
  );
  const nextSnapshot = mergeSnapshotMessages(
    snapshot,
    input.agentSessionId,
    messages
  );
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
  if (!statePatch || statePatch.agentSessionId !== input.agentSessionId) {
    return emptyActivityUpdatedApplyResult(snapshot);
  }
  const existingSession =
    snapshot.sessions.find(
      (session) => session.agentSessionId === input.agentSessionId
    ) ?? null;
  if (!existingSession || isStaleStatePatch(existingSession, statePatch)) {
    return emptyActivityUpdatedApplyResult(snapshot);
  }
  const session = agentActivitySessionFromInlineStatePatch({
    existingSession,
    patch: statePatch,
    workspaceId: input.workspaceId
  });
  return {
    applied: true,
    messages: [],
    session,
    snapshot: upsertSnapshotSession(snapshot, session),
    statePatch
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
  const normalizedAgentSessionId = agentSessionId.trim();
  if (!normalizedAgentSessionId || messages.length === 0) {
    return snapshot;
  }
  const currentMessages =
    snapshot.sessionMessagesById[normalizedAgentSessionId] ?? [];
  const mergedMessages = mergeAgentActivityMessages(currentMessages, messages);
  if (areAgentActivityMessageArraysEqual(currentMessages, mergedMessages)) {
    return snapshot;
  }
  return {
    ...snapshot,
    sessionMessagesById: {
      ...snapshot.sessionMessagesById,
      [normalizedAgentSessionId]: mergedMessages
    }
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
    return {
      ...snapshot,
      sessions: [...snapshot.sessions, session]
    };
  }
  const sessions = [...snapshot.sessions];
  sessions[index] = session;
  return {
    ...snapshot,
    sessions
  };
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
  if (
    sessions.length === snapshot.sessions.length &&
    !snapshot.sessionMessagesById[normalizedAgentSessionId]
  ) {
    return snapshot;
  }
  const sessionMessagesById = { ...snapshot.sessionMessagesById };
  delete sessionMessagesById[normalizedAgentSessionId];
  return {
    ...snapshot,
    sessions,
    sessionMessagesById
  };
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
  if (!agentSessionId || !messageId || !role || !kind) {
    return null;
  }
  return {
    workspaceId: stringValue(source.workspaceId) || event.workspaceId,
    agentSessionId,
    messageId,
    id: numberValue(source.id),
    version: numberValue(source.version) ?? 0,
    turnId: nullableStringValue(source.turnId),
    role,
    kind,
    status: nullableStringValue(source.status),
    payload: recordValue(source.payload) ?? {},
    occurredAtUnixMs: numberValue(source.occurredAtUnixMs),
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
    resumable: booleanValue(source.resumable),
    currentPhase: nullableStringValue(source.currentPhase),
    lastError: nullableStringValue(source.lastError),
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

function inlineMessageBelongsToSession(
  message: Record<string, unknown>,
  agentSessionId: string
): boolean {
  const messageAgentSessionId = stringValue(message.agentSessionId);
  return !messageAgentSessionId || messageAgentSessionId === agentSessionId;
}

function agentActivityMessageFromInlineMessage(input: {
  agentSessionId: string;
  message: Record<string, unknown>;
  workspaceId: string;
}): AgentActivityMessage {
  return {
    workspaceId: stringValue(input.message.workspaceId) || input.workspaceId,
    agentSessionId:
      stringValue(input.message.agentSessionId) || input.agentSessionId,
    messageId: stringValue(input.message.messageId),
    id: numberValue(input.message.id),
    version: numberValue(input.message.version) ?? 0,
    turnId: nullableStringValue(input.message.turnId),
    role: stringValue(input.message.role),
    kind: stringValue(input.message.kind),
    status: nullableStringValue(input.message.status),
    payload: recordValue(input.message.payload) ?? {},
    occurredAtUnixMs: numberValue(input.message.occurredAtUnixMs),
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
    startedAtUnixMs: numberValue(source.startedAtUnixMs),
    endedAtUnixMs: numberValue(source.endedAtUnixMs),
    title: stringValue(source.title) || undefined,
    turn: turn
      ? {
          completedAtUnixMs: numberValue(turn.completedAtUnixMs),
          fileChanges: turn.fileChanges,
          outcome: stringValue(turn.outcome) || undefined,
          phase: stringValue(turn.phase) || undefined,
          startedAtUnixMs: numberValue(turn.startedAtUnixMs),
          turnId: stringValue(turn.turnId)
        }
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
    currentPhase:
      input.patch.currentPhase ??
      input.patch.turn?.phase ??
      input.existingSession.currentPhase,
    lastError: input.patch.lastError ?? input.existingSession.lastError,
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
    turn: statePatch.turn ? { ...statePatch.turn } : undefined
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

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
