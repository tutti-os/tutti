import type { AgentProbeProvider, AgentUsageQuota } from "@tutti-os/agent-gui";
import type { AgentTargetAccountUsageProbeResult } from "@tutti-os/client-tuttid-ts";

export interface DesktopAgentProbeTarget {
  agentTargetId: string;
  provider: string;
}

const accountUsageErrorCodes = new Set([
  "auth_required",
  "config_invalid",
  "execution_failed",
  "no_data",
  "parse_failed",
  "rate_limited",
  "runtime_unavailable",
  "session_expired",
  "timeout"
]);
const accountUsageQuotaTypes = new Set([
  "session",
  "daily",
  "weekly",
  "monthly",
  "model",
  "cost"
]);

export function mapProviderOwnedAccountUsageResult(
  target: DesktopAgentProbeTarget,
  rawResult: AgentTargetAccountUsageProbeResult
): AgentProbeProvider {
  const result = objectValue(rawResult);
  const provider = stringValue(result?.provider);
  const capturedAtUnixMs = numberValue(result?.capturedAtUnixMs);
  if (
    !result ||
    !hasOnlyKeys(result, [
      "schemaVersion",
      "agentTargetId",
      "provider",
      "outcome",
      "capturedAtUnixMs",
      "billingMode",
      "quotas",
      "errorCode"
    ]) ||
    result.schemaVersion !== "tutti.agent.account-usage.v1" ||
    result.agentTargetId !== target.agentTargetId ||
    !provider ||
    (target.provider !== "unknown" && provider !== target.provider) ||
    typeof result.capturedAtUnixMs !== "number" ||
    capturedAtUnixMs === null ||
    !Number.isSafeInteger(capturedAtUnixMs) ||
    capturedAtUnixMs < 0
  ) {
    return failedDesktopAgentProbe(target, "parse_failed");
  }
  const resolvedTarget = { ...target, provider };
  if (result.outcome === "unsupported") {
    if (
      !hasOnlyKeys(result, [
        "schemaVersion",
        "agentTargetId",
        "provider",
        "outcome",
        "capturedAtUnixMs"
      ])
    ) {
      return failedDesktopAgentProbe(resolvedTarget, "parse_failed");
    }
    return failedDesktopAgentProbe(resolvedTarget, "unsupported");
  }
  if (result.outcome === "error") {
    if (
      !hasOnlyKeys(result, [
        "schemaVersion",
        "agentTargetId",
        "provider",
        "outcome",
        "capturedAtUnixMs",
        "errorCode"
      ]) ||
      typeof result.errorCode !== "string" ||
      !accountUsageErrorCodes.has(result.errorCode)
    ) {
      return failedDesktopAgentProbe(resolvedTarget, "parse_failed");
    }
    return failedDesktopAgentProbe(resolvedTarget, result.errorCode);
  }
  if (
    result.outcome !== "available" ||
    !hasOnlyKeys(result, [
      "schemaVersion",
      "agentTargetId",
      "provider",
      "outcome",
      "capturedAtUnixMs",
      "billingMode",
      "quotas"
    ]) ||
    (result.billingMode !== "subscription" && result.billingMode !== "api") ||
    !Array.isArray(result.quotas) ||
    result.quotas.length > 64
  ) {
    return failedDesktopAgentProbe(resolvedTarget, "parse_failed");
  }
  const quotas = result.quotas.flatMap((rawQuota) => {
    const quota = objectValue(rawQuota);
    const percentRemaining = numberValue(quota?.percentRemaining);
    const resetsAtUnixMs =
      quota?.resetsAtUnixMs === undefined
        ? undefined
        : numberValue(quota.resetsAtUnixMs);
    const modelName =
      quota?.modelName === undefined ? undefined : stringValue(quota.modelName);
    if (
      !quota ||
      !hasOnlyKeys(quota, [
        "quotaType",
        "percentRemaining",
        "resetsAtUnixMs",
        "modelName"
      ]) ||
      typeof quota.quotaType !== "string" ||
      !accountUsageQuotaTypes.has(quota.quotaType) ||
      typeof quota.percentRemaining !== "number" ||
      percentRemaining === null ||
      percentRemaining < 0 ||
      percentRemaining > 100 ||
      (resetsAtUnixMs !== undefined &&
        (typeof quota.resetsAtUnixMs !== "number" ||
          resetsAtUnixMs === null ||
          !Number.isSafeInteger(resetsAtUnixMs) ||
          resetsAtUnixMs < 0)) ||
      (quota.quotaType === "model" && !modelName) ||
      (quota.modelName !== undefined && (!modelName || modelName.length > 128))
    ) {
      return [];
    }
    return [
      {
        quotaType: quota.quotaType as AgentUsageQuota["quotaType"],
        percentRemaining,
        ...(resetsAtUnixMs === undefined
          ? {}
          : { resetsAtUnixMs: resetsAtUnixMs as number }),
        ...(modelName ? { modelName } : {})
      }
    ];
  });
  if (
    quotas.length !== result.quotas.length ||
    (result.billingMode === "subscription" && quotas.length === 0) ||
    (result.billingMode === "api" && quotas.length !== 0)
  ) {
    return failedDesktopAgentProbe(resolvedTarget, "parse_failed");
  }
  return {
    agentTargetId: target.agentTargetId,
    availability: { detailsVisible: false, status: "unknown" },
    provider,
    usage: {
      billingMode: result.billingMode,
      capturedAtUnixMs,
      quotas
    }
  };
}

export function failedDesktopAgentProbe(
  target: DesktopAgentProbeTarget,
  code?: string
): AgentProbeProvider {
  return {
    ...(target.agentTargetId ? { agentTargetId: target.agentTargetId } : {}),
    availability: { detailsVisible: false, status: "unknown" },
    ...(code ? { lastError: { code } } : {}),
    provider: target.provider
  };
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
