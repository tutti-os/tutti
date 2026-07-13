import type { AgentActivitySessionUsage } from "./types.ts";

export interface AgentActivityUsage {
  usedTokens: number | null;
  totalTokens: number | null;
  percentUsed: number | null; // 0-100, rounded to integer; null when window unknown
  quotas: Array<Record<string, unknown>>;
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
    ? usage.quotas.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null
      )
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
