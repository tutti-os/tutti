import type {
  AgentActivityMessage,
  AgentActivitySession
} from "@tutti-os/agent-activity-core";
import { setAgentActivityStoreDiagnosticSink } from "@tutti-os/agent-activity-core";
import { normalizeTuttidError } from "@tutti-os/client-tuttid-ts";
import type { DesktopRuntimeApi } from "@preload/types";

export function registerAgentActivityStoreDiagnostics(
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">
): void {
  setAgentActivityStoreDiagnosticSink((event, details) => {
    const flatDetails: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(details)) {
      flatDetails[key] =
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
          ? value
          : JSON.stringify(value);
    }
    void runtimeApi
      .logTerminalDiagnostic({
        details: flatDetails,
        event: `agent.activity.store.${event}`,
        level: "warn",
        workspaceId:
          typeof details.workspaceId === "string" ? details.workspaceId : null
      })
      .catch(() => {});
  });
}

export function agentActivitySessionReconcileDiagnosticDetails(
  session: AgentActivitySession | null
): Record<string, unknown> | null {
  if (!session) return null;
  return {
    activeTurnId: session.activeTurnId ?? null,
    agentSessionId: session.agentSessionId,
    lastEventUnixMs: session.lastEventUnixMs ?? null,
    messageVersion: session.messageVersion ?? null,
    outcome: session.activeTurn?.outcome ?? null,
    provider: session.provider,
    turnPhase: session.activeTurn?.phase ?? null,
    updatedAtUnixMs: session.updatedAtUnixMs ?? null
  };
}

export function normalizeWorkspaceId(workspaceId: string): string {
  return workspaceId.trim() || "__default__";
}

export function isWorkspaceAgentSessionNotFoundError(error: unknown): boolean {
  const normalized = normalizeTuttidError(error);
  return (
    normalized?.code === "workspace_not_found" &&
    normalized.reason === "workspace_agent_session_not_found"
  );
}

export function reconcileAfterVersion(
  messages: readonly AgentActivityMessage[]
): number {
  const latest = messages.reduce(
    (version, message) => Math.max(version, message.version),
    0
  );
  if (
    messages.length === 0 ||
    messages.some((message) => message.role.trim().toLowerCase() === "user")
  ) {
    return latest;
  }
  return messages.some((message) => {
    const role = message.role.trim().toLowerCase();
    const kind = message.kind.trim().toLowerCase();
    return role === "assistant" || role === "agent" || kind === "tool_call";
  })
    ? 0
    : latest;
}

export function hasInlineMessagesData(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    Array.isArray((data as { messages?: unknown }).messages)
  );
}

export function hostMessageEventFromCore(
  message: AgentActivityMessage
): unknown {
  return {
    data: {
      agentSessionId: message.agentSessionId,
      completedAtUnixMs: message.completedAtUnixMs,
      kind: message.kind,
      messageId: message.messageId,
      occurredAtUnixMs: message.occurredAtUnixMs,
      payload: message.payload,
      role: message.role,
      seq: message.version,
      version: message.version,
      startedAtUnixMs: message.startedAtUnixMs,
      status: message.status ?? undefined,
      turnId: message.turnId,
      workspaceId: message.workspaceId
    },
    eventType: "message_update"
  };
}

export function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
