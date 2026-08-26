import type {
  AgentProviderProbeListInput,
  AgentProviderProbeListResult,
  AgentProbeProvider
} from "@tutti-os/agent-gui";
import type { AgentTargetAccountUsageProbeResult } from "@tutti-os/client-tuttid-ts";
import {
  migratedAgentGUIProviderIdentityCatalog,
  resolveAgentGUIProviderCatalogIdentity
} from "@tutti-os/agent-gui/provider-catalog";

import { getDesktopLogger } from "./logging.ts";
import {
  failedDesktopAgentProbe,
  mapProviderOwnedAccountUsageResult,
  type DesktopAgentProbeTarget
} from "./agentTargetAccountUsageProbe.ts";

export async function listDesktopWorkspaceAgentProbes(
  input: AgentProviderProbeListInput,
  dependencies: DesktopAgentUsageProbeDependencies = {}
): Promise<AgentProviderProbeListResult> {
  const capturedAtUnixMs = Date.now();
  const targets = normalizeProbeTargets(input);
  const results = await Promise.all(
    targets.map((target) =>
      probeDesktopAgentTarget(target, input, capturedAtUnixMs, dependencies)
    )
  );
  return {
    capturedAtUnixMs,
    providers: results,
    roomId: input.roomId,
    workspaceId: input.workspaceId
  };
}

export interface DesktopAgentUsageProbeDependencies {
  probeAgentTargetAccountUsage?: (
    agentTargetId: string
  ) => Promise<AgentTargetAccountUsageProbeResult>;
}

function normalizeProbeTargets(
  input: AgentProviderProbeListInput
): DesktopAgentProbeTarget[] {
  const requestedTargetIds = (input.agentTargetIds ?? [])
    .map((targetId) => targetId.trim())
    .filter(Boolean);
  if (requestedTargetIds.length > 0) {
    const targets = requestedTargetIds.map((agentTargetId, index) => {
      const identity = resolveAgentGUIProviderCatalogIdentity(agentTargetId);
      const providerHint = input.providers?.[index]?.trim() ?? "";
      return {
        agentTargetId,
        provider: providerHint || identity?.providerId || "unknown"
      };
    });
    return Array.from(
      new Map(targets.map((target) => [target.agentTargetId, target])).values()
    );
  }

  const defaults = migratedAgentGUIProviderIdentityCatalog
    .filter((entry) => entry.desktop.usageProbeKind !== "")
    .map((entry) => entry.providerId);
  const normalized = (input.providers ?? defaults).flatMap((rawProvider) => {
    const provider = rawProvider.trim();
    if (!provider) return [];
    const identity = resolveAgentGUIProviderCatalogIdentity(provider);
    return [
      {
        agentTargetId: identity?.target.id ?? "",
        provider: identity?.providerId ?? provider
      }
    ];
  });
  return Array.from(
    new Map(
      normalized.map((target) => [
        target.agentTargetId || `provider:${target.provider}`,
        target
      ])
    ).values()
  );
}

// Coalesce rapid repeat usage probes so window mounts, menu opens, hover
// tooltips and manual refresh clicks don't each hit the vendor account API.
const USAGE_PROBE_CACHE_TTL_MS = 10_000;
// After a rate-limit (HTTP 429) response, stop calling the endpoint for this
// long so it can recover instead of being hammered by continued retries.
const USAGE_PROBE_RATE_LIMIT_COOLDOWN_MS = 60_000;

interface UsageProbeCacheEntry {
  result: AgentProbeProvider;
  fetchedAtMs: number;
  /** Do not re-fetch before this time (set after a 429). 0 when not cooling. */
  retryNotBeforeMs: number;
}

const usageProbeCacheByTarget = new Map<string, UsageProbeCacheEntry>();
const usageProbeInFlightByTarget = new Map<
  string,
  Promise<AgentProbeProvider>
>();

/** Test hook: clears the exact-target usage probe cache between cases. */
export function resetUsageProbeCacheForTesting(): void {
  usageProbeCacheByTarget.clear();
  usageProbeInFlightByTarget.clear();
}

function isRateLimitedProbeResult(result: AgentProbeProvider): boolean {
  return result.lastError?.code === "rate_limited";
}

async function probeDesktopAgentTarget(
  target: DesktopAgentProbeTarget,
  input: AgentProviderProbeListInput,
  capturedAtUnixMs: number,
  dependencies: DesktopAgentUsageProbeDependencies
): Promise<AgentProbeProvider> {
  const identity = target.agentTargetId
    ? resolveAgentGUIProviderCatalogIdentity(target.agentTargetId)
    : resolveAgentGUIProviderCatalogIdentity(target.provider);
  const exactCatalogTarget =
    identity &&
    (!target.agentTargetId || identity.target.id === target.agentTargetId)
      ? identity
      : null;
  if (
    exactCatalogTarget &&
    target.provider !== "unknown" &&
    exactCatalogTarget.providerId !== target.provider
  ) {
    return failedDesktopAgentProbe(target, "parse_failed");
  }
  // Availability-only probes are cheap, differently shaped, and not what
  // rate-limits the account API — never cache them.
  if (!input.includeUsage) {
    return failedDesktopAgentProbe(target, undefined);
  }

  const cacheKey = target.agentTargetId || `provider:${target.provider}`;
  const cached = usageProbeCacheByTarget.get(cacheKey);
  if (cached) {
    const freshEnough =
      capturedAtUnixMs - cached.fetchedAtMs < USAGE_PROBE_CACHE_TTL_MS;
    const coolingDown = capturedAtUnixMs < cached.retryNotBeforeMs;
    if (freshEnough || coolingDown) {
      // Reuse the previous probe rather than re-hitting an endpoint that itself
      // rate-limits. This is what stops a storm of "Claude OAuth usage API is
      // rate limited" (429) failures when the limits popover is opened/refreshed
      // repeatedly, and the 429 cooldown gives the endpoint time to recover.
      if (coolingDown && !freshEnough) {
        getDesktopLogger().debug("agent usage probe held during 429 cooldown", {
          event: "agent.usage_probe.cooldown",
          agentTargetId: target.agentTargetId || null,
          provider: target.provider,
          workspaceId: input.workspaceId,
          retryInMs: cached.retryNotBeforeMs - capturedAtUnixMs
        });
      }
      return cached.result;
    }
  }

  const inFlight = usageProbeInFlightByTarget.get(cacheKey);
  if (inFlight) return inFlight;

  const probe = resolveDesktopAgentProbe(
    target,
    input,
    capturedAtUnixMs,
    dependencies
  ).then((result) => {
    logDesktopAgentUsageProbeOutcome(target, input, result);
    usageProbeCacheByTarget.set(cacheKey, {
      result,
      fetchedAtMs: capturedAtUnixMs,
      retryNotBeforeMs: isRateLimitedProbeResult(result)
        ? capturedAtUnixMs + USAGE_PROBE_RATE_LIMIT_COOLDOWN_MS
        : 0
    });
    return result;
  });
  usageProbeInFlightByTarget.set(cacheKey, probe);
  try {
    return await probe;
  } finally {
    if (usageProbeInFlightByTarget.get(cacheKey) === probe) {
      usageProbeInFlightByTarget.delete(cacheKey);
    }
  }
}

async function resolveDesktopAgentProbe(
  target: DesktopAgentProbeTarget,
  input: AgentProviderProbeListInput,
  capturedAtUnixMs: number,
  dependencies: DesktopAgentUsageProbeDependencies
): Promise<AgentProbeProvider> {
  if (target.agentTargetId && dependencies.probeAgentTargetAccountUsage) {
    try {
      const result = await dependencies.probeAgentTargetAccountUsage(
        target.agentTargetId
      );
      return mapProviderOwnedAccountUsageResult(target, result);
    } catch {
      return failedDesktopAgentProbe(target, "runtime_unavailable");
    }
  }
  return failedDesktopAgentProbe(
    target,
    input.includeUsage ? "unsupported" : undefined
  );
}

// The Electron process consumes the daemon's provider-owned usage result and
// never reads vendor OAuth files or calls vendor account APIs directly. Emit one
// bounded structured outcome so missing quotas remain diagnosable.
function logDesktopAgentUsageProbeOutcome(
  target: DesktopAgentProbeTarget,
  input: AgentProviderProbeListInput,
  result: AgentProbeProvider
): void {
  if (!input.includeUsage) {
    return;
  }
  const quotaCount = result.usage?.quotas?.length ?? 0;
  const usageErrorCode = result.lastError?.code ?? null;
  const level = desktopAgentUsageProbeLogLevel(quotaCount, usageErrorCode);
  const fields: Record<string, unknown> = {
    event: "agent.usage_probe.result",
    agentTargetId: result.agentTargetId ?? target.agentTargetId ?? null,
    provider: result.provider,
    workspaceId: input.workspaceId,
    availability: result.availability.status,
    quotaCount,
    usageErrorCode,
    attempts: (result.attempts ?? []).map((attempt) => ({
      strategy: attempt.strategy,
      success: attempt.success,
      errorCode: attempt.errorCode ?? null
    }))
  };
  const logger = getDesktopLogger();
  if (level === "warn") {
    logger.warn("agent usage probe failed", fields);
    return;
  }
  if (level === "info") {
    logger.info("agent usage probe returned no quotas", fields);
    return;
  }
  logger.debug("agent usage probe resolved", fields);
}

/**
 * Severity for a usage-probe outcome line:
 * - "warn": a real fetch failure (expired/invalid credentials, rate limiting,
 *   a non-2xx HTTP status, invalid JSON). Actionable.
 * - "info": resolved without error but produced no displayable quotas (a usage
 *   response with no rate-limit windows, or a custom-API account with no
 *   subscription limits). Explains an empty limits UI.
 * - "debug": usage present, or a provider that simply has no usage concept
 *   ("unsupported").
 */
export function desktopAgentUsageProbeLogLevel(
  quotaCount: number,
  usageErrorCode: string | null
): "warn" | "info" | "debug" {
  if (usageErrorCode === "unsupported") {
    return "debug";
  }
  if (usageErrorCode) {
    return "warn";
  }
  return quotaCount === 0 ? "info" : "debug";
}
