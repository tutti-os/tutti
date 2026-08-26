import {
  analyzeAgentActivityEventObservation,
  agentActivityEventEnvelopeIsConsistent
} from "./activityEventObservation.ts";
import { parseAgentActivityMessageDeltaEvent } from "./liveEventParsing.ts";
import { createAgentActivityOptimisticMessageOverlay } from "./optimisticMessageOverlay.ts";
import type {
  AgentActivityMessage,
  AgentActivitySnapshot,
  AgentActivityTurn,
  AgentActivityUpdatedEvent
} from "./types.ts";
import type {
  AgentSessionEngine,
  EngineConnectionStatus,
  EngineScheduledTask,
  EngineScheduler
} from "./engine/types.ts";

const EMPTY_MESSAGES: readonly AgentActivityMessage[] = [];
export const AGENT_ACTIVITY_NOTIFICATION_BATCH_DELAY_MS = 33;

export interface AgentActivityWorkspaceReconcileKey {
  agentSessionId?: string;
  workspaceId: string;
}

export interface AgentActivityWorkspaceEventResult {
  accepted: boolean;
  eventType: AgentActivityUpdatedEvent["eventType"];
  inlineApplied: boolean;
  inlineGap: {
    cachedVersion: number;
    firstUnseenVersion: number | null;
    latestIncomingVersion: number;
  } | null;
  inlineMessages: readonly AgentActivityMessage[];
  optimisticMessage: AgentActivityMessage | null;
  reason:
    | "applied"
    | "deleted"
    | "restored"
    | "identity_mismatch"
    | "invalid_delta"
    | "invalid_turn"
    | "tombstoned";
}

export type AgentActivityWorkspaceEventInput =
  | Exclude<AgentActivityUpdatedEvent, { eventType: "message_delta" }>
  | {
      agentSessionId: string;
      data: unknown;
      eventType: "message_delta";
      workspaceId: string;
    };

export interface AgentActivityWorkspaceEventCoordinator {
  eventStreamConnectionChanged(input: {
    prioritySessionIds?: readonly string[];
    status: EngineConnectionStatus;
  }): void;
  dispose(): void;
  ingestEvent(
    event: AgentActivityWorkspaceEventInput,
    options?: AgentActivityWorkspaceEventIngestOptions
  ): AgentActivityWorkspaceEventResult;
  isSessionDeleted(agentSessionId: string): boolean;
  project(canonical: AgentActivitySnapshot): AgentActivitySnapshot;
  reconcileDiscontinuity(input: {
    fallbackSessionIds?: readonly string[];
    reconcileKeys: readonly AgentActivityWorkspaceReconcileKey[];
  }): void;
  reconcileMessages(
    agentSessionId: string,
    canonicalMessages?: readonly AgentActivityMessage[]
  ): void;
  reconcileAuthoritativeHistory(
    agentSessionId: string,
    canonicalMessages: readonly AgentActivityMessage[],
    effectiveTurns: readonly AgentActivityTurn[]
  ): void;
  removeSession(agentSessionId: string): boolean;
  subscribe(listener: () => void): () => void;
}

export interface AgentActivityWorkspaceEventIngestOptions {
  /**
   * Use only after the host has fenced transport identity and ordering. It
   * makes settlement absorbing for the same immutable Turn across otherwise
   * incomparable source version domains.
   */
  hostFencedSameTurnSettlement?: true;
}

export interface CreateAgentActivityWorkspaceEventCoordinatorInput {
  engine: AgentSessionEngine;
  notificationBatchDelayMs?: number;
  notificationScheduler: EngineScheduler;
  readCanonicalSnapshot: () => AgentActivitySnapshot;
  workspaceId: string;
}

/**
 * Owns the host-neutral stateful event/reconcile workflow for one workspace.
 *
 * Desktop WebSocket and Mobile DeviceLink adapters normalize transport
 * deliveries before calling this module. It owns optimistic message state,
 * authoritative inline application, deletion tombstones, discontinuity
 * reconciliation, and reconnect hydration. Platform adapters retain socket
 * lifecycle, diagnostics, analytics, and presentation invalidation.
 */
export function createAgentActivityWorkspaceEventCoordinator({
  engine,
  notificationBatchDelayMs = AGENT_ACTIVITY_NOTIFICATION_BATCH_DELAY_MS,
  notificationScheduler,
  readCanonicalSnapshot,
  workspaceId
}: CreateAgentActivityWorkspaceEventCoordinatorInput): AgentActivityWorkspaceEventCoordinator {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) {
    throw new Error(
      "agent activity workspace event coordinator requires a workspaceId"
    );
  }

  const overlay = createAgentActivityOptimisticMessageOverlay();
  const overlaySessionIds = new Set<string>();
  const listeners = new Set<() => void>();
  let revision = 0;
  let connectionStatus: EngineConnectionStatus = "unknown";
  let snapshotCache: {
    canonical: AgentActivitySnapshot;
    projected: AgentActivitySnapshot;
    revision: number;
  } | null = null;
  let pendingNotification: EngineScheduledTask | null = null;
  let disposed = false;

  const notifyListeners = (): void => {
    for (const listener of listeners) listener();
  };

  const flushPendingNotification = (): void => {
    if (pendingNotification) {
      pendingNotification.cancel();
      pendingNotification = null;
    }
    notifyListeners();
  };

  const markChanged = (mode: "batched" | "immediate" = "immediate"): void => {
    revision += 1;
    snapshotCache = null;
    if (mode === "immediate") {
      flushPendingNotification();
      return;
    }
    if (pendingNotification) return;
    pendingNotification = notificationScheduler.schedule(
      notificationBatchDelayMs,
      () => {
        pendingNotification = null;
        if (!disposed) notifyListeners();
      }
    );
  };

  const requestSessionReconcile = (input: {
    agentSessionId: string;
    live?: boolean;
    needsMessages: boolean;
    needsState: boolean;
  }): void => {
    const normalizedSessionId = input.agentSessionId.trim();
    const { live = false, needsMessages, needsState } = input;
    if (!normalizedSessionId || (!needsMessages && !needsState)) return;
    engine.dispatch({
      agentSessionId: normalizedSessionId,
      live,
      needsMessages,
      needsState,
      type: "session/reconcileRequested",
      workspaceId: normalizedWorkspaceId
    });
  };

  const removeSession = (agentSessionId: string): boolean => {
    const normalizedSessionId = agentSessionId.trim();
    if (!normalizedSessionId) return false;
    const wasDeleted = Boolean(
      engine.getSnapshot().sessionLifecycle.deletedSessionIds[
        normalizedSessionId
      ]
    );
    engine.dispatch({
      agentSessionId: normalizedSessionId,
      type: "session/removed"
    });
    overlay.reset({
      agentSessionId: normalizedSessionId,
      workspaceId: normalizedWorkspaceId
    });
    overlaySessionIds.delete(normalizedSessionId);
    markChanged();
    return !wasDeleted;
  };

  const project = (canonical: AgentActivitySnapshot): AgentActivitySnapshot => {
    if (
      snapshotCache?.canonical === canonical &&
      snapshotCache.revision === revision
    ) {
      return snapshotCache.projected;
    }
    const sessionIds = new Set([
      ...Object.keys(canonical.sessionMessagesById),
      ...overlaySessionIds
    ]);
    if (sessionIds.size === 0) {
      snapshotCache = { canonical, projected: canonical, revision };
      return canonical;
    }
    const sessionMessagesById = { ...canonical.sessionMessagesById };
    for (const agentSessionId of sessionIds) {
      sessionMessagesById[agentSessionId] = overlay.project(
        { agentSessionId, workspaceId: normalizedWorkspaceId },
        canonical.sessionMessagesById[agentSessionId] ?? EMPTY_MESSAGES
      );
    }
    const projected = { ...canonical, sessionMessagesById };
    snapshotCache = { canonical, projected, revision };
    return projected;
  };

  return {
    eventStreamConnectionChanged(input) {
      if (disposed) return;
      const transitioned = connectionStatus !== input.status;
      const recovered =
        connectionStatus === "disconnected" && input.status === "connected";
      connectionStatus = input.status;
      if (input.status === "disconnected" && transitioned) {
        for (const agentSessionId of Object.keys(
          engine.getSnapshot().sessionLifecycle.operationBySessionId
        )) {
          engine.dispatch({
            agentSessionId,
            occurredAtUnixMs: 0,
            state: "idle",
            type: "session/runtimeActivityChanged"
          });
        }
      }
      if (input.status !== "connected" || !transitioned) return;

      engine.dispatch({
        retry: true,
        type: "workspace/reconcileRequested",
        workspaceId: normalizedWorkspaceId
      });

      const prioritySessionIds = normalizedSessionIds(
        input.prioritySessionIds ?? []
      );
      for (const agentSessionId of prioritySessionIds) {
        requestSessionReconcile({
          agentSessionId,
          needsMessages: true,
          needsState: true
        });
      }
      if (!recovered) return;

      const prioritySet = new Set(prioritySessionIds);
      const canonical = readCanonicalSnapshot();
      for (const agentSessionId of normalizedSessionIds([
        ...overlaySessionIds
      ])) {
        if (prioritySet.has(agentSessionId)) continue;
        requestSessionReconcile({
          agentSessionId,
          needsMessages: true,
          needsState: !hasCachedSession(canonical, agentSessionId)
        });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingNotification?.cancel();
      pendingNotification = null;
      overlaySessionIds.clear();
      listeners.clear();
      snapshotCache = null;
    },
    ingestEvent(event, options) {
      const agentSessionId = event.agentSessionId.trim();
      const eventType = event.eventType;
      if (
        disposed ||
        event.workspaceId.trim() !== normalizedWorkspaceId ||
        !agentSessionId
      ) {
        if (
          !disposed &&
          event.workspaceId.trim() === normalizedWorkspaceId &&
          agentSessionId
        ) {
          requestSessionReconcile({
            agentSessionId,
            needsMessages: true,
            needsState: true
          });
        }
        return eventResult(eventType, false, "identity_mismatch");
      }

      if (event.eventType === "message_delta") {
        const parsed = parseAgentActivityMessageDeltaEvent(event);
        if (!parsed) {
          requestSessionReconcile({
            agentSessionId,
            needsMessages: true,
            needsState: !hasCachedSession(
              readCanonicalSnapshot(),
              agentSessionId
            )
          });
          return eventResult(eventType, false, "invalid_delta");
        }
        if (
          engine.getSnapshot().sessionLifecycle.deletedSessionIds[
            agentSessionId
          ]
        ) {
          return eventResult(eventType, false, "tombstoned");
        }
        const applied = overlay.apply(parsed);
        if (applied.applied) {
          overlaySessionIds.add(agentSessionId);
          markChanged("batched");
        }
        if (applied.needsReconcile) {
          requestSessionReconcile({
            agentSessionId,
            needsMessages: true,
            needsState: !hasCachedSession(
              readCanonicalSnapshot(),
              agentSessionId
            )
          });
        }
        const optimisticMessage = applied.applied
          ? overlay.getOptimisticMessage(
              {
                agentSessionId,
                workspaceId: normalizedWorkspaceId
              },
              parsed.data.messageId
            )
          : null;
        return {
          ...eventResult(eventType, applied.applied, "applied"),
          optimisticMessage
        };
      }

      if (!agentActivityEventEnvelopeIsConsistent(event)) {
        requestSessionReconcile({
          agentSessionId,
          needsMessages: true,
          needsState: true
        });
        return eventResult(eventType, false, "identity_mismatch");
      }
      if (event.eventType === "session_deleted") {
        removeSession(agentSessionId);
        return eventResult(eventType, true, "deleted");
      }
      if (event.eventType === "session_restored") {
        engine.dispatch({
          agentSessionId,
          type: "session/restored"
        });
        overlay.reset({
          agentSessionId,
          workspaceId: normalizedWorkspaceId
        });
        overlaySessionIds.delete(agentSessionId);
        requestSessionReconcile({
          agentSessionId,
          needsMessages: true,
          needsState: true
        });
        markChanged();
        return eventResult(eventType, true, "restored");
      }
      if (
        engine.getSnapshot().sessionLifecycle.deletedSessionIds[agentSessionId]
      ) {
        return eventResult(eventType, false, "tombstoned");
      }
      if (event.eventType === "runtime_activity_update") {
        if (
          (event.data.state !== "idle" && event.data.state !== "running") ||
          !Number.isSafeInteger(event.data.occurredAtUnixMs) ||
          event.data.occurredAtUnixMs <= 0
        ) {
          return eventResult(eventType, false, "identity_mismatch");
        }
        engine.dispatch({
          agentSessionId,
          occurredAtUnixMs: event.data.occurredAtUnixMs,
          state: event.data.state,
          type: "session/runtimeActivityChanged"
        });
        return eventResult(eventType, true, "applied");
      }
      if (event.eventType === "turn_update") {
        const projection = agentActivityTurnProjectionFromEvent(event);
        if (!projection) {
          requestSessionReconcile({
            agentSessionId,
            live: true,
            needsMessages: false,
            needsState: true
          });
          return eventResult(eventType, false, "invalid_turn");
        }
        engine.dispatch({
          ...projection,
          ...(options?.hostFencedSameTurnSettlement
            ? { hostFencedSameTurnSettlement: true as const }
            : {}),
          type: "turn/projectionReceived",
          workspaceId: normalizedWorkspaceId
        });
        return eventResult(eventType, true, "applied");
      }

      const canonical = readCanonicalSnapshot();
      const cachedMessages =
        canonical.sessionMessagesById[agentSessionId] ?? [];
      const observation = analyzeAgentActivityEventObservation({
        cachedMessages,
        event,
        hasCachedSession: hasCachedSession(canonical, agentSessionId)
      });
      if (event.eventType === "interaction_update") {
        if (isRecord(event.data.interaction)) {
          engine.dispatch({
            interaction: event.data
              .interaction as unknown as import("./types.ts").AgentActivityInteraction,
            type: "interaction/upserted"
          });
        }
      }
      if (observation.canApplyInlineMessages) {
        engine.dispatch(
          {
            messages: observation.inlineMessages,
            type: "message/snapshotReceived",
            workspaceId: normalizedWorkspaceId
          },
          { batch: true }
        );
        overlay.reconcile(
          { agentSessionId, workspaceId: normalizedWorkspaceId },
          [...cachedMessages, ...observation.inlineMessages]
        );
        markChanged();
      }
      engine.dispatch(observation.intent);
      return {
        ...eventResult(eventType, true, "applied"),
        inlineApplied: observation.canApplyInlineMessages,
        inlineGap:
          observation.inlineMessages.length > 0 &&
          !observation.canApplyInlineMessages
            ? {
                cachedVersion: observation.inlineContinuity.cachedVersion,
                firstUnseenVersion:
                  observation.inlineContinuity.firstUnseenVersion,
                latestIncomingVersion:
                  observation.inlineContinuity.latestIncomingVersion
              }
            : null,
        inlineMessages: observation.inlineMessages
      };
    },
    isSessionDeleted(agentSessionId) {
      const normalizedSessionId = agentSessionId.trim();
      return Boolean(
        normalizedSessionId &&
        engine.getSnapshot().sessionLifecycle.deletedSessionIds[
          normalizedSessionId
        ]
      );
    },
    project,
    reconcileDiscontinuity(input) {
      if (disposed) return;
      const sessionIds = normalizedSessionIds(
        input.reconcileKeys
          .filter((key) => key.workspaceId.trim() === normalizedWorkspaceId)
          .flatMap((key) => (key.agentSessionId ? [key.agentSessionId] : []))
      );
      if (sessionIds.length === 0) {
        engine.dispatch({
          retry: true,
          type: "workspace/reconcileRequested",
          workspaceId: normalizedWorkspaceId
        });
      }
      const targets = normalizedSessionIds([
        ...sessionIds,
        ...(sessionIds.length === 0 ? (input.fallbackSessionIds ?? []) : [])
      ]);
      for (const agentSessionId of targets) {
        requestSessionReconcile({
          agentSessionId,
          needsMessages: true,
          needsState: true
        });
      }
    },
    reconcileMessages(agentSessionId, canonicalMessages) {
      if (disposed) return;
      const normalizedSessionId = agentSessionId.trim();
      if (!normalizedSessionId) return;
      overlay.reconcile(
        {
          agentSessionId: normalizedSessionId,
          workspaceId: normalizedWorkspaceId
        },
        canonicalMessages ??
          readCanonicalSnapshot().sessionMessagesById[normalizedSessionId] ??
          []
      );
      markChanged();
    },
    reconcileAuthoritativeHistory(
      agentSessionId,
      canonicalMessages,
      effectiveTurns
    ) {
      if (disposed) return;
      const normalizedSessionId = agentSessionId.trim();
      if (!normalizedSessionId) return;
      overlay.reconcileAuthoritativeHistory(
        {
          agentSessionId: normalizedSessionId,
          workspaceId: normalizedWorkspaceId
        },
        canonicalMessages,
        effectiveTurns
      );
      overlaySessionIds.add(normalizedSessionId);
      markChanged();
    },
    removeSession,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

function eventResult(
  eventType: AgentActivityUpdatedEvent["eventType"],
  accepted: boolean,
  reason: AgentActivityWorkspaceEventResult["reason"]
): AgentActivityWorkspaceEventResult {
  return {
    accepted,
    eventType,
    inlineApplied: false,
    inlineGap: null,
    inlineMessages: [],
    optimisticMessage: null,
    reason
  };
}

function hasCachedSession(
  snapshot: AgentActivitySnapshot,
  agentSessionId: string
): boolean {
  return snapshot.sessions.some(
    (session) => session.agentSessionId === agentSessionId
  );
}

function normalizedSessionIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function agentActivityTurnProjectionFromEvent(
  event: Extract<AgentActivityUpdatedEvent, { eventType: "turn_update" }>
): {
  activeTurnId: string | null;
  turn: AgentActivityTurn;
} | null {
  if (!isRecord(event.data.turn)) return null;
  const activeTurnId =
    typeof event.data.activeTurnId === "string"
      ? event.data.activeTurnId.trim()
      : event.data.activeTurnId;
  const turn: AgentActivityTurn = {
    ...event.data.turn,
    completedCommand: event.data.turn
      .completedCommand as AgentActivityTurn["completedCommand"],
    error: event.data.turn.error as AgentActivityTurn["error"],
    fileChanges: event.data.turn.fileChanges as AgentActivityTurn["fileChanges"]
  };
  if (
    !turn.turnId.trim() ||
    !Number.isSafeInteger(event.data.occurredAtUnixMs) ||
    event.data.occurredAtUnixMs < 0 ||
    (turn.phase === "settled"
      ? activeTurnId !== null
      : activeTurnId !== turn.turnId.trim())
  ) {
    return null;
  }
  return {
    activeTurnId,
    turn
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
