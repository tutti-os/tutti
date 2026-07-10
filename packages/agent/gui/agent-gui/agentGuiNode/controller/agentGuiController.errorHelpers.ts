export const AGENT_CONFIG_DEPENDENCY_UNAVAILABLE_REASON =
  "agent.config_dependency_unavailable";

export interface AgentGUIConfigDependencyErrorDetails {
  provider: string;
  configKey: string;
  dependencyPath: string;
  failureKind: string;
}

export function getAgentGUIConfigDependencyErrorDetails(
  error: unknown
): AgentGUIConfigDependencyErrorDetails | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const record = error as Record<string, unknown>;
  if (record.reason !== AGENT_CONFIG_DEPENDENCY_UNAVAILABLE_REASON) {
    return null;
  }
  const params =
    record.params && typeof record.params === "object"
      ? (record.params as Record<string, unknown>)
      : {};
  return {
    provider: normalizedString(params.provider),
    configKey: normalizedString(params.configKey),
    dependencyPath: normalizedString(params.dependencyPath),
    failureKind: normalizedString(params.failureKind)
  };
}

function normalizedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
