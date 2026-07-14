export const AGENT_COMPOSER_NO_PROJECT_SCOPE = "project:<none>";

export function normalizeAgentComposerDraftProjectPath(
  value: string | null | undefined
): string | null {
  const slashed = value?.trim().replaceAll("\\", "/") ?? "";
  const normalized = /^\/+$/u.test(slashed)
    ? "/"
    : /^[A-Za-z]:\/+$/u.test(slashed)
      ? `${slashed.slice(0, 2)}/`
      : slashed.replace(/\/+$/, "");
  return normalized ? normalized : null;
}

export function resolveAgentComposerDraftScopeKey(input: {
  agentSessionId?: string | null;
  projectPath?: string | null;
}): string {
  const agentSessionId = input.agentSessionId?.trim() ?? "";
  if (agentSessionId) {
    return `session:${agentSessionId}`;
  }
  const projectPath = normalizeAgentComposerDraftProjectPath(input.projectPath);
  return projectPath
    ? `project:${projectPath}`
    : AGENT_COMPOSER_NO_PROJECT_SCOPE;
}
