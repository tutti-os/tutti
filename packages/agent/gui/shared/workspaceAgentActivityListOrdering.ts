import type {
  AgentActivityMessage,
  AgentActivitySession
} from "@tutti-os/agent-activity-core";
import { resolveDisplayableWorkspaceAgentSessionTitle } from "./workspaceAgentSessionTitle";
import type {
  BuildWorkspaceAgentActivityListOptions,
  WorkspaceAgentActivityCard,
  WorkspaceAgentActivityStatus
} from "./workspaceAgentActivityListTypes";

export function shouldHideEmptyRuntimePlaceholderSession(
  session: AgentActivitySession,
  messages: readonly AgentActivityMessage[],
  status: WorkspaceAgentActivityStatus,
  options: BuildWorkspaceAgentActivityListOptions
): boolean {
  if (messages.length > 0) {
    return false;
  }
  if (!hasLoadedSessionMessageRecord(session, options.sessionMessagesById)) {
    return false;
  }
  if (!isRuntimePlaceholderTerminalStatus(status)) {
    return false;
  }
  return resolveDisplayableWorkspaceAgentSessionTitle(session) === "";
}

function hasLoadedSessionMessageRecord(
  session: AgentActivitySession,
  sessionMessagesById: Record<string, AgentActivityMessage[]> | undefined
): boolean {
  if (!sessionMessagesById) {
    return false;
  }
  return workspaceAgentSessionMessageAliases(session).some(
    (alias) => alias in sessionMessagesById
  );
}

function isRuntimePlaceholderTerminalStatus(
  status: WorkspaceAgentActivityStatus
): boolean {
  return status === "idle" || status === "completed" || status === "canceled";
}

export function compareActivities(
  left: WorkspaceAgentActivityCard,
  right: WorkspaceAgentActivityCard
): number {
  const timeDiff = right.sortTimeUnixMs - left.sortTimeUnixMs;
  if (timeDiff !== 0) {
    return timeDiff;
  }
  return left.sessionId.localeCompare(right.sessionId);
}

export function workspaceAgentSessionMessageAliases(
  session: AgentActivitySession
): string[] {
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

/** Remove trailing ` (user@host...)` that some APIs pack into names. */
