import {
  isAgentGuiWorkbenchProvider,
  resolveAgentGuiWorkbenchProviderLabel
} from "@tutti-os/agent-gui/workbench/providerCatalog";
import type { WorkbenchHostCloseDialogRequest } from "@tutti-os/workbench-surface";
import {
  workspaceWorkbenchDesktopI18nKeys,
  type WorkspaceWorkbenchDesktopI18nRuntime
} from "../../../../../../shared/i18n/index.ts";

const agentQuitGuardDetailLimit = 5;

export interface AgentQuitGuardSession {
  agentSessionId: string;
  currentPhase?: string | null;
  effectiveStatus?: string | null;
  provider?: string | null;
  status?: string | null;
  title?: string | null;
  turnLifecycle?: {
    phase?: string | null;
  } | null;
  turnPhase?: string | null;
}

export function createAgentQuitGuardRequest(input: {
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
  sessions: readonly AgentQuitGuardSession[];
}): WorkbenchHostCloseDialogRequest | null {
  const runningSessions = input.sessions.filter(isAgentSessionQuitSensitive);
  if (runningSessions.length === 0) {
    return null;
  }

  const detailLines = runningSessions
    .slice(0, agentQuitGuardDetailLimit)
    .map(formatAgentQuitGuardSession);
  const remainingCount = runningSessions.length - detailLines.length;
  if (remainingCount > 0) {
    detailLines.push(
      input.i18n.t(
        workspaceWorkbenchDesktopI18nKeys.agentQuitGuard.detailsMore,
        { count: remainingCount }
      )
    );
  }

  return {
    cancelLabel: input.i18n.t(
      workspaceWorkbenchDesktopI18nKeys.agentQuitGuard.cancel
    ),
    confirmLabel: input.i18n.t(
      workspaceWorkbenchDesktopI18nKeys.agentQuitGuard.confirm
    ),
    description: input.i18n.t(
      workspaceWorkbenchDesktopI18nKeys.agentQuitGuard.description
    ),
    details: detailLines.join("\n"),
    scope: "window",
    title: input.i18n.t(workspaceWorkbenchDesktopI18nKeys.agentQuitGuard.title),
    variant: "destructive"
  };
}

function formatAgentQuitGuardSession(session: AgentQuitGuardSession): string {
  const provider = session.provider?.trim() ?? "";
  const providerLabel = isAgentGuiWorkbenchProvider(provider)
    ? resolveAgentGuiWorkbenchProviderLabel(provider)
    : provider || "Agent";
  const title = session.title?.trim();
  return title ? `${providerLabel}: ${title}` : providerLabel;
}

function isAgentSessionQuitSensitive(session: AgentQuitGuardSession): boolean {
  return [
    session.currentPhase,
    session.effectiveStatus,
    session.status,
    session.turnLifecycle?.phase,
    session.turnPhase
  ].some(isQuitSensitiveAgentStatus);
}

function isQuitSensitiveAgentStatus(
  status: string | null | undefined
): boolean {
  switch (status?.trim().toLowerCase()) {
    case "submitted":
    case "working":
    case "running":
    case "streaming":
    case "waiting":
    case "waiting_approval":
    case "awaiting_approval":
    case "waiting_input":
      return true;
    default:
      return false;
  }
}
