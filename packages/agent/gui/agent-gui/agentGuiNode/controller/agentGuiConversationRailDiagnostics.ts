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

export type ConversationRailDiagnosticLogger = (
  payload: ConversationRailFirstPagesDiagnostic
) => void;

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
