import type {
  AgentGUIProvider,
  AgentGUIProviderTarget,
  AgentGUIProviderTargetRef
} from "./types.ts";

const agentGUIProviderTargetStaticLabels: Record<AgentGUIProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
  hermes: "Hermes",
  nexight: "Tutti Agent",
  openclaw: "OpenClaw"
};

export const agentGUIDefaultTargetProviders = [
  "codex",
  "claude-code",
  "cursor",
  "nexight",
  "hermes",
  "openclaw"
] as const satisfies readonly AgentGUIProvider[];

const agentGUIDisabledPlaceholderProviders = [
  "nexight",
  "hermes",
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
    label: agentGUIProviderTargetStaticLabels[provider] ?? provider
  };
}

export function createDisabledPlaceholderAgentGUIProviderTarget(
  provider: AgentGUIProvider
): AgentGUIProviderTarget {
  return {
    ...createLocalAgentGUIProviderTarget(provider),
    disabled: true
  };
}

export function createSharedAgentGUIProviderTarget(input: {
  provider: AgentGUIProvider;
  sharedAgentId: string;
  label: string;
  agentTargetId?: string | null;
  ownerLabel?: string | null;
  iconUrl?: string | null;
  unavailableReason?: string | null;
  disabled?: boolean;
  ref?: Record<string, unknown> | null;
}): AgentGUIProviderTarget {
  const sharedAgentId = input.sharedAgentId.trim();
  const targetId = `shared-agent:${sharedAgentId}`;
  return {
    targetId,
    ...(input.agentTargetId?.trim()
      ? { agentTargetId: input.agentTargetId.trim() }
      : {}),
    provider: input.provider,
    ref: {
      ...(input.ref ?? {}),
      kind: "shared-agent",
      provider: input.provider,
      sharedAgentId
    },
    label: input.label,
    ...(input.ownerLabel?.trim()
      ? { ownerLabel: input.ownerLabel.trim() }
      : {}),
    ...(input.iconUrl?.trim() ? { iconUrl: input.iconUrl.trim() } : {}),
    ...(input.unavailableReason?.trim()
      ? { unavailableReason: input.unavailableReason.trim() }
      : {}),
    ...(input.disabled === true ? { disabled: true } : {})
  };
}

export function createLocalAgentGUIProviderTargets(
  providers: readonly AgentGUIProvider[] = agentGUIDefaultTargetProviders
): AgentGUIProviderTarget[] {
  return providers.map((provider) =>
    createLocalAgentGUIProviderTarget(provider)
  );
}

function createStaticAgentGUIProviderTargets(
  providers: readonly AgentGUIProvider[] = agentGUIDefaultTargetProviders,
  options?: { includeDisabledPlaceholders?: boolean }
): AgentGUIProviderTarget[] {
  const disabledProviders = new Set<AgentGUIProvider>(
    options?.includeDisabledPlaceholders === true
      ? agentGUIDisabledPlaceholderProviders
      : []
  );
  return providers.map((provider) =>
    disabledProviders.has(provider)
      ? createDisabledPlaceholderAgentGUIProviderTarget(provider)
      : createLocalAgentGUIProviderTarget(provider)
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
    case "cursor":
      return "local:cursor";
    case "hermes":
      return "local:hermes";
    case "nexight":
      return "local:nexight";
    case "openclaw":
      return "local:openclaw";
    default:
      return null;
  }
}

export function normalizeAgentGUIProviderTargets(
  targets: readonly AgentGUIProviderTarget[] | null | undefined,
  options?: {
    includeDisabledPlaceholders?: boolean;
    useStaticCatalog?: boolean;
  }
): AgentGUIProviderTarget[] {
  const includeDisabledPlaceholders =
    options?.includeDisabledPlaceholders === true;
  const useStaticCatalog = options?.useStaticCatalog !== false;
  const source = targets && targets.length > 0 ? targets : [];
  const normalizedTargets: AgentGUIProviderTarget[] = [];
  const seenTargetKeys = new Set<string>();
  const seenProviders = new Set<AgentGUIProvider>();
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
    seenProviders.add(normalized.provider);
    normalizedTargets.push(normalized);
  }
  if (includeDisabledPlaceholders && normalizedTargets.length > 0) {
    for (const provider of agentGUIDisabledPlaceholderProviders) {
      if (seenProviders.has(provider)) {
        continue;
      }
      normalizedTargets.push(
        createDisabledPlaceholderAgentGUIProviderTarget(provider)
      );
    }
  }
  return normalizedTargets.length > 0 || !useStaticCatalog
    ? normalizedTargets
    : createStaticAgentGUIProviderTargets(undefined, {
        includeDisabledPlaceholders
      });
}

export function resolveAgentGUIProviderTarget(input: {
  agentTargetId?: string | null;
  defaultProviderTargetId?: string | null;
  provider: AgentGUIProvider;
  providerTargetId?: string | null;
  providerTargets: readonly AgentGUIProviderTarget[];
  useStaticCatalog?: boolean;
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
    (input.useStaticCatalog === false
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
  const {
    targetId: _targetId,
    agentTargetId: _agentTargetId,
    provider: _provider,
    ref: _ref,
    label: _label,
    description,
    iconUrl,
    ownerLabel,
    unavailableReason,
    ...rest
  } = target;
  const targetId = target.targetId.trim();
  const agentTargetId = target.agentTargetId?.trim();
  const label = target.label.trim();
  const kind =
    typeof target.ref.kind === "string" ? target.ref.kind.trim() : "";
  if (!targetId || !label || !kind || target.ref.provider !== target.provider) {
    return null;
  }
  return {
    ...rest,
    targetId,
    ...(agentTargetId ? { agentTargetId } : {}),
    provider: target.provider,
    ref: {
      ...target.ref,
      kind,
      provider: target.provider
    },
    label,
    ...(description?.trim() ? { description: description.trim() } : {}),
    ...(iconUrl?.trim() ? { iconUrl: iconUrl.trim() } : {}),
    ...(ownerLabel?.trim() ? { ownerLabel: ownerLabel.trim() } : {}),
    ...(unavailableReason?.trim()
      ? { unavailableReason: unavailableReason.trim() }
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
