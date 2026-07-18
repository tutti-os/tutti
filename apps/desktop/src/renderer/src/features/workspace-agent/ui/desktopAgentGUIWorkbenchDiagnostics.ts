import type { DesktopRuntimeApi } from "@preload/types";
import type { DesktopAgentGUIProvider } from "../desktopAgentGUINodeState";

const agentComposerDefaultsFields = new Set([
  "model",
  "permissionModeId",
  "reasoningEffort",
  "speed"
]);

interface AgentComposerDefaultsFailureDetails {
  agentTargetId?: string;
  attemptCount?: number;
  changedFields?: string[];
  correlationId?: string;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
}

export function logAgentComposerDefaultsDiagnostic(input: {
  agentTargetId: string;
  error: unknown;
  provider: DesktopAgentGUIProvider;
  runtimeApi?: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  workspaceId: string;
}): void {
  if (!input.runtimeApi) {
    return;
  }
  const failure = readAgentComposerDefaultsFailureDetails(input.error);
  void input.runtimeApi.logTerminalDiagnostic({
    details: {
      agentTargetId: failure?.agentTargetId ?? input.agentTargetId,
      attemptCount: failure?.attemptCount ?? 1,
      changedFields: failure?.changedFields?.join(",") ?? "",
      correlationId: failure?.correlationId ?? null,
      durationMs: failure?.durationMs ?? null,
      errorCode: failure?.errorCode ?? "unknown",
      errorMessage:
        failure?.errorMessage ?? stringifyDiagnosticError(input.error),
      provider: input.provider
    },
    event: "agent.gui.composer_defaults.remember_failed",
    level: "warn",
    workspaceId: input.workspaceId
  });
}

function readAgentComposerDefaultsFailureDetails(
  error: unknown
): AgentComposerDefaultsFailureDetails | null {
  if (
    !(error instanceof Error) ||
    error.name !== "AgentComposerDefaultsPatchFailure" ||
    !("details" in error) ||
    typeof error.details !== "object" ||
    error.details === null
  ) {
    return null;
  }
  const details = error.details as AgentComposerDefaultsFailureDetails;
  return {
    agentTargetId:
      typeof details.agentTargetId === "string"
        ? details.agentTargetId
        : undefined,
    attemptCount:
      typeof details.attemptCount === "number"
        ? details.attemptCount
        : undefined,
    changedFields: Array.isArray(details.changedFields)
      ? details.changedFields.filter((field) =>
          agentComposerDefaultsFields.has(field)
        )
      : undefined,
    correlationId:
      typeof details.correlationId === "string"
        ? details.correlationId
        : undefined,
    durationMs:
      typeof details.durationMs === "number" ? details.durationMs : undefined,
    errorCode:
      typeof details.errorCode === "string" ? details.errorCode : undefined,
    errorMessage:
      typeof details.errorMessage === "string"
        ? details.errorMessage
        : undefined
  };
}

export function logAgentGUIConversationRailPreferenceDiagnostic(input: {
  collapsed: boolean;
  error?: unknown;
  provider: DesktopAgentGUIProvider;
  runtimeApi?: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  workspaceId: string;
}): void {
  if (!input.runtimeApi) {
    return;
  }
  void input.runtimeApi.logTerminalDiagnostic({
    details: {
      collapsed: input.collapsed,
      ...(input.error ? { error: stringifyDiagnosticError(input.error) } : {}),
      provider: input.provider
    },
    event: input.error
      ? "agent.gui.conversation_rail_preference.remember_failed"
      : "agent.gui.conversation_rail_preference.remembered",
    level: input.error ? "warn" : "info",
    workspaceId: input.workspaceId
  });
}

export function stringifyDiagnosticError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
