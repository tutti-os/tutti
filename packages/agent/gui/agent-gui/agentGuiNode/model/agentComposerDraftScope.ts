import {
  areWorkspaceUserProjectPathsEqual,
  normalizeWorkspaceUserProjectPath
} from "@tutti-os/workspace-user-project/core";

/** Shared home-composer draft scope. Project selection does not partition this. */
export const AGENT_COMPOSER_HOME_DRAFT_SCOPE = "home";

export function normalizeAgentComposerDraftProjectPath(
  value: string | null | undefined
): string | null {
  return normalizeWorkspaceUserProjectPath(value) || null;
}

export function areAgentComposerProjectPathsEqual(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  return areWorkspaceUserProjectPathsEqual(left, right);
}

export function resolveAgentComposerDraftScopeKey(input: {
  agentSessionId?: string | null;
  /**
   * Retained for call-site compatibility. Home drafts ignore project identity;
   * only an active session partitions composer draft content.
   */
  projectPath?: string | null;
}): string {
  const agentSessionId = input.agentSessionId?.trim() ?? "";
  if (agentSessionId) {
    return `session:${agentSessionId}`;
  }
  return AGENT_COMPOSER_HOME_DRAFT_SCOPE;
}
