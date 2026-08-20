import type {
  AgentProbeProvider,
  AgentUsageQuota,
  AgentUsageSnapshot
} from "@tutti-os/agent-gui";
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
  "credits",
  "cost"
]);
const accountUsageBillingModes = new Set([
  "subscription",
  "api",
  "coding_plan",
  "provider_account"
]);
const accountUsageQuotaStates = new Set([
  "complete",
  "unavailable",
  "not_applicable"
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
      "quotaState",
      "quotas",
      "errorCode"
    ]) ||
    result.schemaVersion !== "tutti.agent.account-usage.v2" ||
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
      "quotaState",
      "quotas"
    ]) ||
    typeof result.billingMode !== "string" ||
    !accountUsageBillingModes.has(result.billingMode) ||
    typeof result.quotaState !== "string" ||
    !accountUsageQuotaStates.has(result.quotaState) ||
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
    const amountRemaining =
      quota?.amountRemaining === undefined
        ? undefined
        : numberValue(quota.amountRemaining);
    const amountLimit =
      quota?.amountLimit === undefined
        ? undefined
        : numberValue(quota.amountLimit);
    if (
      !quota ||
      !hasOnlyKeys(quota, [
        "quotaType",
        "percentRemaining",
        "amountRemaining",
        "amountLimit",
        "amountUnit",
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
      (quota.modelName !== undefined &&
        (!modelName || modelName.length > 128)) ||
      (quota.quotaType === "credits"
        ? typeof quota.amountRemaining !== "number" ||
          typeof amountRemaining !== "number" ||
          amountRemaining < 0 ||
          typeof quota.amountLimit !== "number" ||
          typeof amountLimit !== "number" ||
          amountLimit < amountRemaining ||
          quota.amountUnit !== "credits"
        : quota.amountRemaining !== undefined ||
          quota.amountLimit !== undefined ||
          quota.amountUnit !== undefined)
    ) {
      return [];
    }
    return [
      {
        quotaType: quota.quotaType as AgentUsageQuota["quotaType"],
        percentRemaining,
        ...(amountRemaining === undefined
          ? {}
          : { amountRemaining: amountRemaining as number }),
        ...(amountLimit === undefined
          ? {}
          : { amountLimit: amountLimit as number }),
        ...(quota.amountUnit === "credits"
          ? { amountUnit: "credits" as const }
          : {}),
        ...(resetsAtUnixMs === undefined
          ? {}
          : { resetsAtUnixMs: resetsAtUnixMs as number }),
        ...(modelName ? { modelName } : {})
      }
    ];
  });
  if (
    quotas.length !== result.quotas.length ||
    !validQuotaState(result.billingMode, result.quotaState, quotas.length)
  ) {
    return failedDesktopAgentProbe(resolvedTarget, "parse_failed");
  }
  const billingMode = result.billingMode as NonNullable<
    AgentUsageSnapshot["billingMode"]
  >;
  const quotaState = result.quotaState as NonNullable<
    AgentUsageSnapshot["quotaState"]
  >;
  return {
    agentTargetId: target.agentTargetId,
    availability: { detailsVisible: false, status: "unknown" },
    provider,
    usage: {
      billingMode,
      quotaState,
      capturedAtUnixMs,
      quotas
    }
  };
}

function validQuotaState(
  billingMode: unknown,
  quotaState: unknown,
  quotaCount: number
): boolean {
  if (quotaState === "complete") return billingMode !== "api" && quotaCount > 0;
  if (quotaState === "unavailable")
    return billingMode !== "api" && quotaCount === 0;
  return (
    quotaState === "not_applicable" && billingMode === "api" && quotaCount === 0
  );
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
