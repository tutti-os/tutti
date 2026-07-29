import type { AgentUsageQuota } from "../../../shared/contracts/dto";
import {
  agentGuiScheduler,
  type AgentGuiScheduledTask
} from "../agentGuiScheduler";

export type AgentStatusSectionState = "available" | "unavailable" | "error";

export type AgentStatusRequestReason =
  | "slash-status"
  | "agent-info"
  | "agent-config";

export interface AgentStatusQuery {
  /** Exact host-owned execution target identity. AgentGUI treats it as opaque. */
  scopeKey: string;
  agentSessionId?: string | null;
  reason: AgentStatusRequestReason;
  forceRefresh?: boolean;
}

export interface AgentStatusValue {
  agentSessionId?: string | null;
  contextWindow?: {
    usedTokens?: number | null;
    totalTokens?: number | null;
  } | null;
  contextState: AgentStatusSectionState;
  quotas: readonly AgentUsageQuota[];
  limitsState: AgentStatusSectionState;
  limitsCapturedAtUnixMs?: number | null;
  limitsStale?: boolean;
}

export interface AgentStatusFrame {
  kind: "snapshot" | "refreshed";
  value: AgentStatusValue;
}

export interface AgentStatusStreamObserver {
  onFrame(frame: AgentStatusFrame): void;
  onError(error: AgentStatusSourceError): void;
  onComplete(): void;
}

export interface AgentStatusSourceError {
  /** Structured host error code. Raw provider errors must not cross this port. */
  code: string;
}

export interface AgentStatusSource {
  open(
    query: AgentStatusQuery,
    observer: AgentStatusStreamObserver
  ): () => void;
}

export type AgentStatusRequestPhase = "idle" | "loading" | "ready" | "error";

export interface AgentStatusControllerSnapshot {
  query: AgentStatusQuery | null;
  value: AgentStatusValue | null;
  phase: AgentStatusRequestPhase;
  isRefreshing: boolean;
  errorCode: string | null;
}

export interface AgentStatusController {
  getSnapshot(): AgentStatusControllerSnapshot;
  subscribe(listener: () => void): () => void;
  open(query: AgentStatusQuery): void;
  close(): void;
  invalidate(scopeKey?: string): void;
}

export interface AgentStatusControllerOptions {
  source: AgentStatusSource;
  now?: () => number;
  requestTimeoutMs?: number;
  retainedSnapshotMs?: number;
  forcedRefreshDebounceMs?: number;
}

export interface AgentStatusSelectionKey {
  scopeKey: string;
  agentSessionId?: string | null;
  reasons?: readonly AgentStatusRequestReason[];
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RETAINED_SNAPSHOT_MS = 60 * 60_000;
const DEFAULT_FORCED_REFRESH_DEBOUNCE_MS = 5_000;

const IDLE_SNAPSHOT: AgentStatusControllerSnapshot = {
  query: null,
  value: null,
  phase: "idle",
  isRefreshing: false,
  errorCode: null
};

interface RetainedStatusValue {
  value: AgentStatusValue;
  receivedAtUnixMs: number;
}

interface ActiveRequest {
  id: number;
  cacheKey: string;
  frameCount: number;
  lastFrameKind: AgentStatusFrame["kind"] | null;
  receivedFrame: boolean;
  timeout: AgentGuiScheduledTask | null;
  unsubscribe: (() => void) | null;
}

function normalizeQuery(query: AgentStatusQuery): AgentStatusQuery | null {
  const scopeKey = query.scopeKey.trim();
  if (!scopeKey) {
    return null;
  }
  return {
    scopeKey,
    agentSessionId: query.agentSessionId?.trim() || null,
    reason: query.reason,
    forceRefresh: query.forceRefresh === true
  };
}

function cacheKeyFor(query: AgentStatusQuery): string {
  return `${query.scopeKey}\u0000${query.agentSessionId ?? ""}`;
}

/** Selects status only for the exact target and caller-visible Session. */
export function selectAgentStatusControllerSnapshot(
  snapshot: AgentStatusControllerSnapshot,
  key: AgentStatusSelectionKey
): AgentStatusControllerSnapshot {
  const scopeKey = key.scopeKey.trim();
  const agentSessionId = key.agentSessionId?.trim() || null;
  if (
    snapshot.query?.scopeKey !== scopeKey ||
    (snapshot.query.agentSessionId?.trim() || null) !== agentSessionId ||
    (key.reasons !== undefined && !key.reasons.includes(snapshot.query.reason))
  ) {
    return IDLE_SNAPSHOT;
  }
  return snapshot;
}

/**
 * Creates the shared AgentGUI interaction controller for bounded status reads.
 * The host owns transport, authorization and provider probing. The controller
 * owns only request visibility, a bounded presentation snapshot, timeout and
 * stale-response fencing.
 */
export function createAgentStatusController(
  options: AgentStatusControllerOptions
): AgentStatusController {
  const now = options.now ?? Date.now;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const retainedSnapshotMs =
    options.retainedSnapshotMs ?? DEFAULT_RETAINED_SNAPSHOT_MS;
  const forcedRefreshDebounceMs =
    options.forcedRefreshDebounceMs ?? DEFAULT_FORCED_REFRESH_DEBOUNCE_MS;
  const listeners = new Set<() => void>();
  const retained = new Map<string, RetainedStatusValue>();
  const lastForcedRefreshAt = new Map<string, number>();

  let snapshot = IDLE_SNAPSHOT;
  let active: ActiveRequest | null = null;
  let nextRequestId = 1;

  const publish = (next: AgentStatusControllerSnapshot): void => {
    if (snapshot === next) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  };

  const stopActive = (): void => {
    const current = active;
    active = null;
    if (!current) {
      return;
    }
    if (current.timeout !== null) {
      current.timeout.cancel();
    }
    current.unsubscribe?.();
  };

  const finishRequest = (request: ActiveRequest): boolean => {
    if (active?.id !== request.id) {
      return false;
    }
    active = null;
    if (request.timeout !== null) {
      request.timeout.cancel();
      request.timeout = null;
    }
    const unsubscribe = request.unsubscribe;
    request.unsubscribe = null;
    unsubscribe?.();
    return true;
  };

  const controller: AgentStatusController = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open: (requestedQuery) => {
      const query = normalizeQuery(requestedQuery);
      if (!query) {
        stopActive();
        publish({
          query: null,
          value: null,
          phase: "error",
          isRefreshing: false,
          errorCode: "invalid_target"
        });
        return;
      }

      const cacheKey = cacheKeyFor(query);
      const requestedAt = now();
      if (query.forceRefresh) {
        const previousForcedRefreshAt = lastForcedRefreshAt.get(cacheKey);
        if (
          previousForcedRefreshAt !== undefined &&
          requestedAt - previousForcedRefreshAt < forcedRefreshDebounceMs
        ) {
          return;
        }
        lastForcedRefreshAt.set(cacheKey, requestedAt);
      }

      stopActive();
      const retainedEntry = retained.get(cacheKey);
      const retainedValue =
        retainedEntry &&
        requestedAt - retainedEntry.receivedAtUnixMs <= retainedSnapshotMs
          ? retainedEntry.value
          : null;
      if (retainedEntry && retainedValue === null) {
        retained.delete(cacheKey);
      }

      const request: ActiveRequest = {
        id: nextRequestId++,
        cacheKey,
        frameCount: 0,
        lastFrameKind: null,
        receivedFrame: false,
        timeout: null,
        unsubscribe: null
      };
      active = request;
      publish({
        query,
        value: retainedValue,
        phase: retainedValue ? "ready" : "loading",
        isRefreshing: true,
        errorCode: null
      });

      request.timeout = agentGuiScheduler.schedule(requestTimeoutMs, () => {
        if (active?.id !== request.id) {
          return;
        }
        stopActive();
        publish({
          ...snapshot,
          phase: snapshot.value ? "ready" : "error",
          isRefreshing: false,
          errorCode: "timeout"
        });
      });

      const isCurrent = (): boolean => active?.id === request.id;
      const observer: AgentStatusStreamObserver = {
        onFrame: (frame) => {
          if (!isCurrent()) {
            return;
          }
          const responseSessionId = frame.value.agentSessionId?.trim() || null;
          const expectedSessionId = query.agentSessionId?.trim() || null;
          const invalidSequence =
            request.frameCount >= 2 ||
            (request.frameCount === 1 &&
              (request.lastFrameKind !== "snapshot" ||
                frame.kind !== "refreshed"));
          if (invalidSequence || responseSessionId !== expectedSessionId) {
            if (!finishRequest(request)) return;
            publish({
              ...snapshot,
              phase: snapshot.value ? "ready" : "error",
              isRefreshing: false,
              errorCode: "unavailable"
            });
            return;
          }
          request.frameCount++;
          request.lastFrameKind = frame.kind;
          request.receivedFrame = true;
          retained.set(cacheKey, {
            value: frame.value,
            receivedAtUnixMs: now()
          });
          publish({
            query,
            value: frame.value,
            phase: "ready",
            isRefreshing: true,
            errorCode: null
          });
        },
        onError: (error) => {
          if (!finishRequest(request)) {
            return;
          }
          publish({
            ...snapshot,
            phase: snapshot.value ? "ready" : "error",
            isRefreshing: false,
            errorCode: error.code.trim() || "unavailable"
          });
        },
        onComplete: () => {
          if (!finishRequest(request)) {
            return;
          }
          const errorCode = request.receivedFrame
            ? snapshot.errorCode
            : "unavailable";
          publish({
            ...snapshot,
            phase: snapshot.value ? "ready" : "error",
            isRefreshing: false,
            errorCode
          });
        }
      };

      try {
        const unsubscribe = options.source.open(query, observer);
        if (active?.id === request.id) {
          request.unsubscribe = unsubscribe;
        } else {
          unsubscribe();
        }
      } catch {
        observer.onError({ code: "unavailable" });
      }
    },
    close: () => {
      stopActive();
      if (snapshot.isRefreshing) {
        publish({ ...snapshot, isRefreshing: false });
      }
    },
    invalidate: (scopeKey) => {
      const normalizedScopeKey = scopeKey?.trim() ?? "";
      if (!normalizedScopeKey) {
        retained.clear();
        lastForcedRefreshAt.clear();
      } else {
        for (const key of retained.keys()) {
          if (key.startsWith(`${normalizedScopeKey}\u0000`)) {
            retained.delete(key);
          }
        }
        for (const key of lastForcedRefreshAt.keys()) {
          if (key.startsWith(`${normalizedScopeKey}\u0000`)) {
            lastForcedRefreshAt.delete(key);
          }
        }
      }
      if (
        snapshot.query &&
        (!normalizedScopeKey || snapshot.query.scopeKey === normalizedScopeKey)
      ) {
        stopActive();
        publish(IDLE_SNAPSHOT);
      }
    }
  };

  return controller;
}
