import type { AgentActivityRuntime } from "../../../agentActivityRuntime";

export const CONVERSATION_RAIL_SLOW_DIAGNOSTIC_THRESHOLD_MS = 250;

export type ConversationRailRefreshReason =
  | "attach"
  | "membership_change"
  | "scope_change";

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
  returnedSessionCount: number;
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
  requestMs: number;
  returnedSessionCount: number;
  sectionCount: number;
  status: "ready" | "error";
  toAgentTargetId: string | null;
  workspaceId: string;
}

export type ConversationRailDiagnosticLogger = (
  payload:
    | ConversationRailFirstPagesDiagnostic
    | ConversationRailProviderSwitchDiagnostic
) => void;

interface PendingProviderSwitchDiagnostic {
  cacheStatus: "fresh" | "miss" | "stale";
  fromAgentTargetId: string | null;
  scopeKey: string;
  startedAtMs: number;
  toAgentTargetId: string | null;
}

export class ConversationRailProviderSwitchDiagnosticTracker {
  private pending: PendingProviderSwitchDiagnostic | null = null;

  constructor(
    private readonly diagnosticLogger: ConversationRailDiagnosticLogger,
    private readonly now: () => number,
    private readonly workspaceId: string
  ) {}

  configure(input: {
    attached: boolean;
    nextAgentTargetId: string;
    nextScopeKey: string;
    previousAgentTargetId: string;
    previousScopeKey: string | null;
  }): void {
    if (
      input.nextScopeKey !== input.previousScopeKey &&
      this.pending?.scopeKey !== input.nextScopeKey
    ) {
      this.pending = null;
    }
    if (
      input.attached &&
      input.nextScopeKey !== input.previousScopeKey &&
      input.previousScopeKey !== null &&
      input.previousAgentTargetId !== input.nextAgentTargetId
    ) {
      this.pending = {
        cacheStatus: "miss",
        fromAgentTargetId: input.previousAgentTargetId || null,
        scopeKey: input.nextScopeKey,
        startedAtMs: this.now(),
        toAgentTargetId: input.nextAgentTargetId || null
      };
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
      | "toAgentTargetId"
      | "workspaceId"
    >
  ): void {
    const pending = this.pending;
    if (!pending || pending.scopeKey !== scopeKey) return;
    this.pending = null;
    emitConversationRailProviderSwitchDiagnostic({
      ...result,
      diagnosticLogger: this.diagnosticLogger,
      durationMs: Math.max(0, this.now() - pending.startedAtMs),
      fromAgentTargetId: pending.fromAgentTargetId,
      toAgentTargetId: pending.toAgentTargetId,
      workspaceId: this.workspaceId
    });
  }
}

export function emitConversationRailProviderSwitchDiagnostic(input: {
  cacheStatus: ConversationRailProviderSwitchDiagnostic["cacheStatus"];
  controllerApplyMs: number;
  diagnosticLogger: ConversationRailDiagnosticLogger;
  durationMs: number;
  error?: unknown;
  fromAgentTargetId: string | null;
  requestMs: number;
  returnedSessionCount: number;
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
    requestMs: input.requestMs,
    returnedSessionCount: input.returnedSessionCount,
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
  returnedSessionCount: number;
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
    returnedSessionCount: input.returnedSessionCount,
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
