import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { ConversationRailQueryState } from "../model/agentGuiConversationRail";
import type { CachedConversationRailQuery } from "./agentGuiConversationRailQueryCache";

export const CONVERSATION_RAIL_SLOW_DIAGNOSTIC_THRESHOLD_MS = 250;

export type ConversationRailRefreshReason =
  | "attach"
  | "membership_change"
  | "scope_change";

export type ConversationRailFilterKind = "all" | "agentTarget";

export interface ConversationRailDiagnosticContext {
  nodeId: string | null;
  runtimeOrigin: string;
  workspaceId: string;
}

export interface ConversationRailFirstPagesDiagnostic {
  agentTargetId: string | null;
  controllerApplyMs: number;
  durationMs: number;
  errorKind?: string;
  event:
    | "agent_gui.conversation_rail.first_pages_slow"
    | "agent_gui.conversation_rail.first_pages_failed";
  requestId: number;
  requestMs: number;
  refreshReason: ConversationRailRefreshReason;
  returnedSessionIds: readonly string[];
  returnedSessionCount: number;
  nodeId: string | null;
  runtimeOrigin: string;
  sectionCount: number;
  status: "ready" | "error";
  workspaceId: string;
}

export interface ConversationRailProviderSwitchDiagnostic {
  cacheStatus: "fresh" | "miss" | "stale";
  controllerApplyMs: number;
  durationMs: number;
  errorKind?: string;
  event:
    | "agent_gui.provider_switch.completed"
    | "agent_gui.provider_switch.failed";
  fromAgentTargetId: string | null;
  nodeId: string | null;
  requestId: number | null;
  requestMs: number;
  returnedSessionIds: readonly string[];
  returnedSessionCount: number;
  runtimeOrigin: string;
  sectionCount: number;
  status: "ready" | "error";
  toAgentTargetId: string | null;
  workspaceId: string;
}

export interface ConversationRailScopeChangeDiagnostic {
  activeConversationId: string | null;
  cacheStatus: "fresh" | "miss" | "stale" | "unknown";
  controllerApplyMs: number;
  durationMs: number;
  errorKind?: string;
  event:
    | "agent_gui.conversation_rail.scope_change.started"
    | "agent_gui.conversation_rail.scope_change.completed"
    | "agent_gui.conversation_rail.scope_change.failed"
    | "agent_gui.conversation_rail.scope_change.superseded";
  fromAgentTargetId: string | null;
  fromFilterKind: ConversationRailFilterKind | null;
  nodeId: string | null;
  preservedSectionCount: number;
  preservedSessionIds: readonly string[];
  requestId: number | null;
  requestMs: number;
  retainedPreviousSections: boolean;
  returnedSessionIds: readonly string[];
  returnedSessionCount: number;
  runtimeOrigin: string;
  sectionCount: number;
  status: "pending" | "ready" | "error" | "superseded";
  toAgentTargetId: string | null;
  toFilterKind: ConversationRailFilterKind;
  workspaceId: string;
}

export type ConversationRailDiagnosticLogger = (
  payload:
    | ConversationRailFirstPagesDiagnostic
    | ConversationRailProviderSwitchDiagnostic
    | ConversationRailScopeChangeDiagnostic
) => void;

interface PendingProviderSwitchDiagnostic {
  activeConversationId: string | null;
  cacheStatus: "fresh" | "miss" | "stale" | "unknown";
  fromAgentTargetId: string | null;
  fromFilterKind: ConversationRailFilterKind | null;
  preservedSectionCount: number;
  preservedSessionIds: readonly string[];
  retainedPreviousSections: boolean;
  scopeKey: string;
  startedAtMs: number;
  toAgentTargetId: string | null;
  toFilterKind: ConversationRailFilterKind;
}

export class ConversationRailProviderSwitchDiagnosticTracker {
  private pending: PendingProviderSwitchDiagnostic | null = null;

  constructor(
    private readonly diagnosticLogger: ConversationRailDiagnosticLogger,
    private readonly now: () => number,
    private readonly context: ConversationRailDiagnosticContext,
    private readonly slowThresholdMs: number
  ) {}

  configure(input: {
    activeConversationId: string | null;
    attached: boolean;
    nextFilterKind: ConversationRailFilterKind;
    nextAgentTargetId: string;
    nextScopeKey: string;
    preservedSectionCount: number;
    preservedSessionIds: readonly string[];
    previousFilterKind: ConversationRailFilterKind | null;
    previousAgentTargetId: string;
    previousScopeKey: string | null;
    retainedPreviousSections: boolean;
  }): void {
    if (
      input.nextScopeKey !== input.previousScopeKey &&
      this.pending?.scopeKey !== input.nextScopeKey
    ) {
      if (this.pending) {
        emitConversationRailScopeChangeDiagnostic({
          ...this.pending,
          ...this.context,
          controllerApplyMs: 0,
          diagnosticLogger: this.diagnosticLogger,
          durationMs: Math.max(0, this.now() - this.pending.startedAtMs),
          requestId: null,
          requestMs: 0,
          returnedSessionCount: 0,
          returnedSessionIds: [],
          sectionCount: 0,
          status: "superseded"
        });
      }
      this.pending = null;
    }
    if (
      input.attached &&
      input.nextScopeKey !== input.previousScopeKey &&
      input.previousScopeKey !== null
    ) {
      this.pending = {
        activeConversationId: input.activeConversationId,
        cacheStatus: "unknown",
        fromAgentTargetId: input.previousAgentTargetId || null,
        fromFilterKind: input.previousFilterKind,
        preservedSectionCount: input.preservedSectionCount,
        preservedSessionIds: input.preservedSessionIds,
        retainedPreviousSections: input.retainedPreviousSections,
        scopeKey: input.nextScopeKey,
        startedAtMs: this.now(),
        toAgentTargetId: input.nextAgentTargetId || null,
        toFilterKind: input.nextFilterKind
      };
      emitConversationRailScopeChangeDiagnostic({
        ...this.pending,
        ...this.context,
        controllerApplyMs: 0,
        diagnosticLogger: this.diagnosticLogger,
        durationMs: 0,
        requestId: null,
        requestMs: 0,
        returnedSessionCount: 0,
        returnedSessionIds: [],
        sectionCount: 0,
        status: "pending"
      });
    }
  }

  hasPending(scopeKey: string): boolean {
    return this.pending?.scopeKey === scopeKey;
  }

  setCacheStatus(
    scopeKey: string,
    cacheStatus: PendingProviderSwitchDiagnostic["cacheStatus"]
  ): void {
    if (this.pending?.scopeKey === scopeKey) {
      this.pending.cacheStatus = cacheStatus;
    }
  }

  complete(
    scopeKey: string,
    result: Omit<
      Parameters<typeof emitConversationRailProviderSwitchDiagnostic>[0],
      | "diagnosticLogger"
      | "durationMs"
      | "fromAgentTargetId"
      | "nodeId"
      | "runtimeOrigin"
      | "toAgentTargetId"
      | "workspaceId"
    >
  ): void {
    const pending = this.pending;
    if (!pending || pending.scopeKey !== scopeKey) return;
    this.pending = null;
    emitConversationRailScopeChangeDiagnostic({
      ...pending,
      ...result,
      ...this.context,
      diagnosticLogger: this.diagnosticLogger,
      durationMs: Math.max(0, this.now() - pending.startedAtMs),
      status: result.status
    });
    if (pending.fromAgentTargetId !== pending.toAgentTargetId) {
      emitConversationRailProviderSwitchDiagnostic({
        ...result,
        ...this.context,
        diagnosticLogger: this.diagnosticLogger,
        durationMs: Math.max(0, this.now() - pending.startedAtMs),
        fromAgentTargetId: pending.fromAgentTargetId,
        toAgentTargetId: pending.toAgentTargetId
      });
    }
  }

  completeFirstPages(
    scopeKey: string,
    input: {
      agentTargetId: string | null;
      cacheStatus: "miss" | "stale";
      completedAt: number;
      query: CachedConversationRailQuery;
      refreshReason: ConversationRailRefreshReason;
      requestId: number;
      requestResolvedAt: number;
      requestStartedAt: number;
    }
  ): void {
    const controllerApplyMs = Math.max(
      0,
      input.completedAt - input.requestResolvedAt
    );
    const requestMs = Math.max(
      0,
      input.requestResolvedAt - input.requestStartedAt
    );
    const returnedSessionIds = conversationRailQuerySessionIds(
      input.query.queryState
    );
    this.complete(scopeKey, {
      cacheStatus: input.cacheStatus,
      controllerApplyMs,
      requestId: input.requestId,
      requestMs,
      returnedSessionIds,
      returnedSessionCount: input.query.returnedSessionCount,
      sectionCount: input.query.sectionCount,
      status: "ready"
    });
    emitConversationRailFirstPagesDiagnostic({
      agentTargetId: input.agentTargetId,
      controllerApplyMs,
      diagnosticLogger: this.diagnosticLogger,
      diagnosticSlowThresholdMs: this.slowThresholdMs,
      durationMs: Math.max(0, input.completedAt - input.requestStartedAt),
      requestId: input.requestId,
      requestMs,
      refreshReason: input.refreshReason,
      returnedSessionIds,
      returnedSessionCount: input.query.returnedSessionCount,
      ...this.context,
      sectionCount: input.query.sectionCount,
      status: "ready"
    });
  }

  completeCachedFirstPages(
    scopeKey: string,
    input: {
      controllerApplyMs: number;
      query: CachedConversationRailQuery;
    }
  ): void {
    this.complete(scopeKey, {
      cacheStatus: "fresh",
      controllerApplyMs: input.controllerApplyMs,
      requestId: null,
      requestMs: 0,
      returnedSessionIds: conversationRailQuerySessionIds(
        input.query.queryState
      ),
      returnedSessionCount: input.query.returnedSessionCount,
      sectionCount: input.query.sectionCount,
      status: "ready"
    });
  }

  failFirstPages(
    scopeKey: string,
    input: {
      agentTargetId: string | null;
      cacheStatus: "miss" | "stale";
      error: unknown;
      failedAt: number;
      refreshReason: ConversationRailRefreshReason;
      requestId: number;
      requestStartedAt: number;
    }
  ): void {
    const requestMs = Math.max(0, input.failedAt - input.requestStartedAt);
    this.complete(scopeKey, {
      cacheStatus: input.cacheStatus,
      controllerApplyMs: 0,
      error: input.error,
      requestId: input.requestId,
      requestMs,
      returnedSessionIds: [],
      returnedSessionCount: 0,
      sectionCount: 0,
      status: "error"
    });
    emitConversationRailFirstPagesDiagnostic({
      agentTargetId: input.agentTargetId,
      controllerApplyMs: 0,
      diagnosticLogger: this.diagnosticLogger,
      diagnosticSlowThresholdMs: this.slowThresholdMs,
      durationMs: requestMs,
      error: input.error,
      requestId: input.requestId,
      requestMs,
      refreshReason: input.refreshReason,
      returnedSessionIds: [],
      returnedSessionCount: 0,
      ...this.context,
      sectionCount: 0,
      status: "error"
    });
  }
}

export function emitConversationRailScopeChangeDiagnostic(input: {
  activeConversationId: string | null;
  cacheStatus: ConversationRailScopeChangeDiagnostic["cacheStatus"];
  controllerApplyMs: number;
  diagnosticLogger: ConversationRailDiagnosticLogger;
  durationMs: number;
  error?: unknown;
  fromAgentTargetId: string | null;
  fromFilterKind: ConversationRailFilterKind | null;
  nodeId: string | null;
  preservedSectionCount: number;
  preservedSessionIds: readonly string[];
  requestId: number | null;
  requestMs: number;
  retainedPreviousSections: boolean;
  returnedSessionIds: readonly string[];
  returnedSessionCount: number;
  runtimeOrigin: string;
  sectionCount: number;
  status: ConversationRailScopeChangeDiagnostic["status"];
  toAgentTargetId: string | null;
  toFilterKind: ConversationRailFilterKind;
  workspaceId: string;
}): void {
  const event: ConversationRailScopeChangeDiagnostic["event"] =
    input.status === "pending"
      ? "agent_gui.conversation_rail.scope_change.started"
      : input.status === "error"
        ? "agent_gui.conversation_rail.scope_change.failed"
        : input.status === "superseded"
          ? "agent_gui.conversation_rail.scope_change.superseded"
          : "agent_gui.conversation_rail.scope_change.completed";
  const payload: ConversationRailScopeChangeDiagnostic = {
    activeConversationId: input.activeConversationId,
    cacheStatus: input.cacheStatus,
    controllerApplyMs: input.controllerApplyMs,
    durationMs: input.durationMs,
    ...(input.status === "error"
      ? { errorKind: conversationRailErrorKind(input.error) }
      : {}),
    event,
    fromAgentTargetId: input.fromAgentTargetId,
    fromFilterKind: input.fromFilterKind,
    nodeId: input.nodeId,
    preservedSectionCount: input.preservedSectionCount,
    preservedSessionIds: input.preservedSessionIds,
    requestId: input.requestId,
    requestMs: input.requestMs,
    retainedPreviousSections: input.retainedPreviousSections,
    returnedSessionIds: input.returnedSessionIds,
    returnedSessionCount: input.returnedSessionCount,
    runtimeOrigin: input.runtimeOrigin,
    sectionCount: input.sectionCount,
    status: input.status,
    toAgentTargetId: input.toAgentTargetId,
    toFilterKind: input.toFilterKind,
    workspaceId: input.workspaceId
  };
  try {
    input.diagnosticLogger(payload);
  } catch (error) {
    ignoreConversationRailDiagnosticFailure(error);
  }
}

export function emitConversationRailProviderSwitchDiagnostic(input: {
  cacheStatus: ConversationRailProviderSwitchDiagnostic["cacheStatus"];
  controllerApplyMs: number;
  diagnosticLogger: ConversationRailDiagnosticLogger;
  durationMs: number;
  error?: unknown;
  fromAgentTargetId: string | null;
  nodeId: string | null;
  requestId: number | null;
  requestMs: number;
  returnedSessionIds: readonly string[];
  returnedSessionCount: number;
  runtimeOrigin: string;
  sectionCount: number;
  status: "ready" | "error";
  toAgentTargetId: string | null;
  workspaceId: string;
}): void {
  const payload: ConversationRailProviderSwitchDiagnostic = {
    cacheStatus: input.cacheStatus,
    controllerApplyMs: input.controllerApplyMs,
    durationMs: input.durationMs,
    ...(input.status === "error"
      ? { errorKind: conversationRailErrorKind(input.error) }
      : {}),
    event:
      input.status === "error"
        ? "agent_gui.provider_switch.failed"
        : "agent_gui.provider_switch.completed",
    fromAgentTargetId: input.fromAgentTargetId,
    nodeId: input.nodeId,
    requestId: input.requestId,
    requestMs: input.requestMs,
    returnedSessionIds: input.returnedSessionIds,
    returnedSessionCount: input.returnedSessionCount,
    runtimeOrigin: input.runtimeOrigin,
    sectionCount: input.sectionCount,
    status: input.status,
    toAgentTargetId: input.toAgentTargetId,
    workspaceId: input.workspaceId
  };
  try {
    input.diagnosticLogger(payload);
  } catch (error) {
    ignoreConversationRailDiagnosticFailure(error);
  }
}

export function emitConversationRailFirstPagesDiagnostic(input: {
  agentTargetId: string | null;
  controllerApplyMs: number;
  diagnosticLogger: ConversationRailDiagnosticLogger;
  diagnosticSlowThresholdMs: number;
  durationMs: number;
  error?: unknown;
  requestId: number;
  requestMs: number;
  refreshReason: ConversationRailRefreshReason;
  returnedSessionIds: readonly string[];
  returnedSessionCount: number;
  nodeId: string | null;
  runtimeOrigin: string;
  sectionCount: number;
  status: "ready" | "error";
  workspaceId: string;
}): void {
  if (
    input.status === "ready" &&
    input.durationMs < input.diagnosticSlowThresholdMs
  ) {
    return;
  }
  const payload: ConversationRailFirstPagesDiagnostic = {
    agentTargetId: input.agentTargetId,
    controllerApplyMs: input.controllerApplyMs,
    durationMs: input.durationMs,
    ...(input.status === "error"
      ? { errorKind: conversationRailErrorKind(input.error) }
      : {}),
    event:
      input.status === "error"
        ? "agent_gui.conversation_rail.first_pages_failed"
        : "agent_gui.conversation_rail.first_pages_slow",
    requestId: input.requestId,
    requestMs: input.requestMs,
    refreshReason: input.refreshReason,
    returnedSessionIds: input.returnedSessionIds,
    returnedSessionCount: input.returnedSessionCount,
    nodeId: input.nodeId,
    runtimeOrigin: input.runtimeOrigin,
    sectionCount: input.sectionCount,
    status: input.status,
    workspaceId: input.workspaceId
  };
  try {
    input.diagnosticLogger(payload);
  } catch (error) {
    // Diagnostics must never affect rail state or interaction locking.
    ignoreConversationRailDiagnosticFailure(error);
  }
}

export function createConversationRailDiagnosticLogger(
  runtime: Pick<AgentActivityRuntime, "reportDiagnostic">
): ConversationRailDiagnosticLogger {
  return (payload) => {
    const reportDiagnostic = runtime.reportDiagnostic;
    if (!reportDiagnostic) return;
    try {
      void Promise.resolve(
        reportDiagnostic.call(runtime, {
          details: { ...payload },
          event: payload.event,
          level: payload.status === "error" ? "warn" : "info",
          source: "agent-gui",
          workspaceId: payload.workspaceId
        })
      ).catch(ignoreConversationRailDiagnosticFailure);
    } catch (error) {
      // Best-effort diagnostics only; avoid console fallback noise.
      ignoreConversationRailDiagnosticFailure(error);
    }
  };
}

function ignoreConversationRailDiagnosticFailure(error: unknown): void {
  void error;
}

function conversationRailErrorKind(error: unknown): string {
  if (error instanceof Error) {
    return error.name || "Error";
  }
  if (typeof error === "string") {
    return "string";
  }
  return error === null ? "null" : typeof error;
}

export function conversationRailQuerySessionIds(
  queryState: ConversationRailQueryState
): string[] {
  return [
    ...new Set(
      (queryState.sections ?? []).flatMap((section) => section.sessionIds)
    )
  ];
}
