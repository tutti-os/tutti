import type { AgentActivitySessionUsage } from "./types.ts";

export interface AgentActivityUsage {
  usedTokens: number | null;
  totalTokens: number | null;
  percentUsed: number | null; // 0-100, rounded to integer; null when window unknown
  quotas: AgentActivityQuota[];
}

interface AgentActivityQuota {
  quotaType: "session" | "weekly" | "monthly" | "daily" | "model" | "cost";
  percentRemaining?: number;
  resetsAtUnixMs?: number;
  resetText?: string;
  dollarRemaining?: number;
  modelName?: string;
}

export interface AgentActivityUsageInput {
  sessionUsage?: AgentActivitySessionUsage | null;
}

export function resolveAgentActivityUsage(
  input: AgentActivityUsageInput
): AgentActivityUsage | null {
  const usage = recordValue(input.sessionUsage);
  if (!usage) {
    return null;
  }
  const contextWindow = recordValue(usage.contextWindow);
  const usedTokens = finiteNumber(contextWindow?.usedTokens);
  const totalTokens = finiteNumber(contextWindow?.totalTokens);
  const quotas = Array.isArray(usage.quotas)
    ? usage.quotas
        .map(normalizeQuota)
        .filter((quota): quota is AgentActivityQuota => quota !== null)
    : [];
  const hasWindow =
    usedTokens !== null && totalTokens !== null && totalTokens > 0;
  if (!hasWindow && quotas.length === 0) {
    return null;
  }
  return {
    usedTokens: hasWindow ? usedTokens : null,
    totalTokens: hasWindow ? totalTokens : null,
    percentUsed: hasWindow
      ? Math.min(100, Math.round((usedTokens / totalTokens) * 100))
      : null,
    quotas
  };
}

function normalizeQuota(value: unknown): AgentActivityQuota | null {
  const record = recordValue(value);
  const quotaType = quotaTypeValue(record?.quotaType);
  if (!record || !quotaType) return null;
  const quota: AgentActivityQuota = { quotaType };
  const percentRemaining = finiteNumber(record.percentRemaining);
  if (percentRemaining !== null) quota.percentRemaining = percentRemaining;
  const resetsAtUnixMs = finiteNumber(record.resetsAtUnixMs);
  if (resetsAtUnixMs !== null) quota.resetsAtUnixMs = resetsAtUnixMs;
  const resetText = textValue(record.resetText);
  if (resetText) quota.resetText = resetText;
  const dollarRemaining = finiteNumber(record.dollarRemaining);
  if (dollarRemaining !== null) quota.dollarRemaining = dollarRemaining;
  const modelName = textValue(record.modelName);
  if (modelName) quota.modelName = modelName;
  return quota;
}

function quotaTypeValue(
  value: unknown
): AgentActivityQuota["quotaType"] | null {
  switch (textValue(value)) {
    case "session":
    case "weekly":
    case "monthly":
    case "daily":
    case "model":
    case "cost":
      return textValue(value) as AgentActivityQuota["quotaType"];
    default:
      return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
