import type {
  AgentGUIProvider,
  AgentGUIAgentTarget,
  AgentGUIAgentTargetBadge,
  AgentGUIAgentTargetRef
} from "./types.ts";
import {
  migratedAgentGUIProviderIdentityCatalog,
  resolveAgentGUIProviderCatalogIdentity,
  resolveMigratedAgentGUIProviderIdentity
} from "./providerIdentityCatalog.ts";

export const agentGUIDefaultTargetProviders: readonly AgentGUIProvider[] =
  migratedAgentGUIProviderIdentityCatalog
    .map((identity) => ({
      provider: identity.providerId as AgentGUIProvider,
      sortOrder: identity.target.sortOrder
    }))
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((entry) => entry.provider);

const agentGUIDisabledPlaceholderProviders =
  migratedAgentGUIProviderIdentityCatalog
    .filter((identity) => !identity.target.enabled)
    .map((identity) => identity.providerId as AgentGUIProvider);

export function createLocalAgentGUIAgentTarget(
  provider: AgentGUIProvider
): AgentGUIAgentTarget {
  const identity = resolveAgentGUIProviderCatalogIdentity(provider);
  const migratedIdentity = resolveMigratedAgentGUIProviderIdentity(provider);
  const targetId = localAgentGUIAgentTargetId(provider);
  const agentTargetId = localAgentGUIAgentTargetId(provider);
  return {
    targetId,
    ...(agentTargetId ? { agentTargetId } : {}),
    provider,
    ref: {
      kind: "local",
      provider
    },
    label: identity?.displayName ?? provider,
    ...(migratedIdentity?.target.enabled === false ? { disabled: true } : {})
  };
}

export function createDisabledPlaceholderAgentGUIAgentTarget(
  provider: AgentGUIProvider
): AgentGUIAgentTarget {
  return {
    ...createLocalAgentGUIAgentTarget(provider),
    disabled: true
  };
}

export function createSharedAgentGUIAgentTarget(input: {
  provider: AgentGUIProvider;
  sharedAgentId: string;
  label: string;
  agentTargetId?: string | null;
  badge?: AgentGUIAgentTargetBadge | null;
  ownerLabel?: string | null;
  ownerDeviceLabel?: string | null;
  iconUrl?: string | null;
  maskIconUrl?: string | null;
  unavailableReason?: string | null;
  disabled?: boolean;
  ref?: Record<string, unknown> | null;
}): AgentGUIAgentTarget {
  const sharedAgentId = input.sharedAgentId.trim();
  const targetId = `shared-agent:${sharedAgentId}`;
  const badge = normalizeAgentGUIAgentTargetBadge(input.badge);
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
    ...(badge ? { badge } : {}),
    ...(input.ownerLabel?.trim()
      ? { ownerLabel: input.ownerLabel.trim() }
      : {}),
    ...(input.ownerDeviceLabel?.trim()
      ? { ownerDeviceLabel: input.ownerDeviceLabel.trim() }
      : {}),
    ...(input.iconUrl?.trim() ? { iconUrl: input.iconUrl.trim() } : {}),
    ...(input.maskIconUrl?.trim()
      ? { maskIconUrl: input.maskIconUrl.trim() }
      : {}),
    ...(input.unavailableReason?.trim()
      ? { unavailableReason: input.unavailableReason.trim() }
      : {}),
    ...(input.disabled === true ? { disabled: true } : {})
  };
}

export function createLocalAgentGUIAgentTargets(
  providers: readonly AgentGUIProvider[] = agentGUIDefaultTargetProviders
): AgentGUIAgentTarget[] {
  return providers.map((provider) => createLocalAgentGUIAgentTarget(provider));
}

function createStaticAgentGUIAgentTargets(
  providers: readonly AgentGUIProvider[] = agentGUIDefaultTargetProviders,
  options?: { includeDisabledPlaceholders?: boolean }
): AgentGUIAgentTarget[] {
  const disabledProviders = new Set<AgentGUIProvider>(
    options?.includeDisabledPlaceholders === true
      ? agentGUIDisabledPlaceholderProviders
      : []
  );
  return providers.map((provider) =>
    disabledProviders.has(provider)
      ? createDisabledPlaceholderAgentGUIAgentTarget(provider)
      : createLocalAgentGUIAgentTarget(provider)
  );
}

export function localAgentGUIAgentTargetId(provider: AgentGUIProvider): string {
  return (
    resolveAgentGUIProviderCatalogIdentity(provider)?.target.id ??
    `local:${provider}`
  );
}

export function normalizeAgentGUIAgentTargets(
  targets: readonly AgentGUIAgentTarget[] | null | undefined,
  options?: {
    includeDisabledPlaceholders?: boolean;
    useStaticCatalog?: boolean;
  }
): AgentGUIAgentTarget[] {
  const includeDisabledPlaceholders =
    options?.includeDisabledPlaceholders === true;
  const useStaticCatalog = options?.useStaticCatalog !== false;
  const source = targets && targets.length > 0 ? targets : [];
  const normalizedTargets: AgentGUIAgentTarget[] = [];
  const seenTargetKeys = new Set<string>();
  const seenProviders = new Set<AgentGUIProvider>();
  for (const target of source) {
    const normalized = normalizeAgentGUIAgentTarget(target);
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
        createDisabledPlaceholderAgentGUIAgentTarget(provider)
      );
    }
  }
  return normalizedTargets.length > 0 || !useStaticCatalog
    ? normalizedTargets
    : createStaticAgentGUIAgentTargets(undefined, {
        includeDisabledPlaceholders
      });
}

export function resolveAgentGUIAgentTarget(input: {
  agentTargetId?: string | null;
  defaultAgentTargetId?: string | null;
  provider: AgentGUIProvider;
  agentTargets: readonly AgentGUIAgentTarget[];
  useStaticCatalog?: boolean;
}): AgentGUIAgentTarget | null {
  const explicitAgentTargetId = input.agentTargetId?.trim() ?? "";
  const targetByAgentTargetId = new Map(
    input.agentTargets.flatMap((target) =>
      target.agentTargetId ? [[target.agentTargetId, target] as const] : []
    )
  );
  const agentTarget = targetByAgentTargetId.get(explicitAgentTargetId);
  if (agentTarget) {
    return agentTarget;
  }
  if (explicitAgentTargetId) {
    return null;
  }
  const agentTargets = input.agentTargets.filter(
    (target) => target.provider === input.provider
  );
  const targetById = new Map(
    agentTargets.map((target) => [target.targetId, target])
  );
  return (
    targetById.get(input.defaultAgentTargetId?.trim() ?? "") ??
    targetById.get(localAgentGUIAgentTargetId(input.provider)) ??
    agentTargets.find((target) => target.disabled !== true) ??
    agentTargets[0] ??
    (input.useStaticCatalog === false
      ? null
      : createLocalAgentGUIAgentTarget(input.provider))
  );
}

export function isAgentGUIAgentTargetComingSoon(
  target: AgentGUIAgentTarget | null | undefined,
  comingSoonProviders: readonly AgentGUIProvider[] = []
): boolean {
  return Boolean(
    target &&
    (target.availability?.status === "coming_soon" ||
      comingSoonProviders.includes(target.provider))
  );
}

export function agentGUIAgentTargetRefsEqual(
  left: AgentGUIAgentTargetRef | null | undefined,
  right: AgentGUIAgentTargetRef | null | undefined
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
  return stableAgentTargetRefKey(left) === stableAgentTargetRefKey(right);
}

function normalizeAgentGUIAgentTarget(
  target: AgentGUIAgentTarget
): AgentGUIAgentTarget | null {
  const {
    targetId: _targetId,
    agentTargetId: _agentTargetId,
    provider: _provider,
    ref: _ref,
    label: _label,
    badge,
    description,
    iconUrl,
    maskIconUrl,
    heroImageUrl,
    ownerLabel,
    ownerDeviceLabel,
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
  const normalizedBadge = normalizeAgentGUIAgentTargetBadge(badge);
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
    ...(normalizedBadge ? { badge: normalizedBadge } : {}),
    ...(description?.trim() ? { description: description.trim() } : {}),
    ...(iconUrl?.trim() ? { iconUrl: iconUrl.trim() } : {}),
    ...(maskIconUrl?.trim() ? { maskIconUrl: maskIconUrl.trim() } : {}),
    ...(heroImageUrl?.trim() ? { heroImageUrl: heroImageUrl.trim() } : {}),
    ...(ownerLabel?.trim() ? { ownerLabel: ownerLabel.trim() } : {}),
    ...(ownerDeviceLabel?.trim()
      ? { ownerDeviceLabel: ownerDeviceLabel.trim() }
      : {}),
    ...(unavailableReason?.trim()
      ? { unavailableReason: unavailableReason.trim() }
      : {})
  };
}

function normalizeAgentGUIAgentTargetBadge(
  badge: AgentGUIAgentTargetBadge | null | undefined
): AgentGUIAgentTargetBadge | null {
  const iconUrl = badge?.iconUrl?.trim() ?? "";
  if (!iconUrl) {
    return null;
  }
  const label = badge?.label?.trim() ?? "";
  return {
    iconUrl,
    ...(label ? { label } : {})
  };
}

function stableAgentTargetRefKey(ref: AgentGUIAgentTargetRef): string {
  return JSON.stringify(sortAgentTargetRefValue(ref));
}

function sortAgentTargetRefValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortAgentTargetRefValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortAgentTargetRefValue(entryValue)])
  );
}
