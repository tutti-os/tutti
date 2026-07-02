import type {
  AgentGUIProvider,
  AgentGUIProviderTarget,
  AgentGUIProviderTargetRef
} from "./types.ts";

const agentGUIProviderTargetFallbackLabels: Record<AgentGUIProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  hermes: "Hermes",
  nexight: "Nexight",
  openclaw: "OpenClaw"
};

export const agentGUIDefaultTargetProviders = [
  "codex",
  "claude-code",
  "nexight",
  "hermes",
  "gemini",
  "openclaw"
] as const satisfies readonly AgentGUIProvider[];

export function createLocalAgentGUIProviderTarget(
  provider: AgentGUIProvider
): AgentGUIProviderTarget {
  const targetId = localAgentGUIProviderTargetId(provider);
  const agentTargetId = localAgentGUIAgentTargetId(provider);
  return {
    targetId,
    ...(agentTargetId ? { agentTargetId } : {}),
    provider,
    ref: {
      kind: "local",
      provider
    },
    label: agentGUIProviderTargetFallbackLabels[provider] ?? provider
  };
}

export function createLocalAgentGUIProviderTargets(
  providers: readonly AgentGUIProvider[] = agentGUIDefaultTargetProviders
): AgentGUIProviderTarget[] {
  return providers.map((provider) =>
    createLocalAgentGUIProviderTarget(provider)
  );
}

export function localAgentGUIProviderTargetId(
  provider: AgentGUIProvider
): string {
  return `local:${provider}`;
}

export function localAgentGUIAgentTargetId(
  provider: AgentGUIProvider
): string | null {
  switch (provider) {
    case "codex":
      return "local:codex";
    case "claude-code":
      return "local:claude-code";
    default:
      return null;
  }
}

export function normalizeAgentGUIProviderTargets(
  targets: readonly AgentGUIProviderTarget[] | null | undefined,
  options?: { fallbackToLocal?: boolean }
): AgentGUIProviderTarget[] {
  const fallbackToLocal = options?.fallbackToLocal !== false;
  const source = targets && targets.length > 0 ? targets : [];
  const normalizedTargets: AgentGUIProviderTarget[] = [];
  const seenTargetKeys = new Set<string>();
  for (const target of source) {
    const normalized = normalizeAgentGUIProviderTarget(target);
    if (!normalized) {
      continue;
    }
    const dedupeKey = `${normalized.provider}\u0000${normalized.targetId}`;
    if (seenTargetKeys.has(dedupeKey)) {
      continue;
    }
    seenTargetKeys.add(dedupeKey);
    normalizedTargets.push(normalized);
  }
  return normalizedTargets.length > 0 || !fallbackToLocal
    ? normalizedTargets
    : createLocalAgentGUIProviderTargets();
}

export function resolveAgentGUIProviderTarget(input: {
  agentTargetId?: string | null;
  defaultProviderTargetId?: string | null;
  fallbackToLocal?: boolean;
  provider: AgentGUIProvider;
  providerTargetId?: string | null;
  providerTargets: readonly AgentGUIProviderTarget[];
}): AgentGUIProviderTarget | null {
  const targetByAgentTargetId = new Map(
    input.providerTargets.flatMap((target) =>
      target.agentTargetId ? [[target.agentTargetId, target] as const] : []
    )
  );
  const agentTarget = targetByAgentTargetId.get(
    input.agentTargetId?.trim() ?? ""
  );
  if (agentTarget) {
    return agentTarget;
  }
  const providerTargets = input.providerTargets.filter(
    (target) => target.provider === input.provider
  );
  const targetById = new Map(
    providerTargets.map((target) => [target.targetId, target])
  );
  return (
    targetById.get(input.providerTargetId?.trim() ?? "") ??
    targetById.get(input.defaultProviderTargetId?.trim() ?? "") ??
    targetById.get(localAgentGUIProviderTargetId(input.provider)) ??
    providerTargets.find((target) => target.disabled !== true) ??
    providerTargets[0] ??
    (input.fallbackToLocal === false
      ? null
      : createLocalAgentGUIProviderTarget(input.provider))
  );
}

export function agentGUIProviderTargetRefsEqual(
  left: AgentGUIProviderTargetRef | null | undefined,
  right: AgentGUIProviderTargetRef | null | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return stableProviderTargetRefKey(left) === stableProviderTargetRefKey(right);
}

function normalizeAgentGUIProviderTarget(
  target: AgentGUIProviderTarget
): AgentGUIProviderTarget | null {
  const targetId = target.targetId.trim();
  const agentTargetId = target.agentTargetId?.trim();
  const label = target.label.trim();
  const kind =
    typeof target.ref.kind === "string" ? target.ref.kind.trim() : "";
  if (!targetId || !label || !kind || target.ref.provider !== target.provider) {
    return null;
  }
  return {
    ...target,
    targetId,
    ...(agentTargetId ? { agentTargetId } : {}),
    provider: target.provider,
    ref: {
      ...target.ref,
      kind,
      provider: target.provider
    },
    label,
    ...(target.description?.trim()
      ? { description: target.description.trim() }
      : {}),
    ...(target.ownerLabel?.trim()
      ? { ownerLabel: target.ownerLabel.trim() }
      : {}),
    ...(target.unavailableReason?.trim()
      ? { unavailableReason: target.unavailableReason.trim() }
      : {})
  };
}

function stableProviderTargetRefKey(ref: AgentGUIProviderTargetRef): string {
  return JSON.stringify(sortProviderTargetRefValue(ref));
}

function sortProviderTargetRefValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortProviderTargetRefValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortProviderTargetRefValue(entryValue)])
  );
}
