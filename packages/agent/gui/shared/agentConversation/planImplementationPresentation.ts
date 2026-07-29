import type { AgentConversationPromptVM } from "./contracts/agentConversationVM";

export const PLAN_IMPLEMENTATION_PROMPT = "Implement the plan.";
export const PLAN_IMPLEMENTATION_ACTION_IMPLEMENT = "implement";
export const PLAN_IMPLEMENTATION_ACTION_FEEDBACK = "feedback";
export const PLAN_IMPLEMENTATION_ACTION_SKIP = "skip";

export function planImplementationPromptFromPlanTurn(
  planTurnId: string,
  title: string
): Extract<AgentConversationPromptVM, { kind: "plan-implementation" }> {
  return {
    kind: "plan-implementation",
    requestId: planTurnId,
    title
  };
}

interface PlanTimelineItem {
  turnId?: string | null;
  occurredAtUnixMs?: number | null;
  createdAtUnixMs?: number | null;
  seq?: number | null;
  payload?: Record<string, unknown> | null;
}

function itemTime(item: PlanTimelineItem): number {
  return item.occurredAtUnixMs ?? item.createdAtUnixMs ?? item.seq ?? 0;
}

function isPlanItem(item: PlanTimelineItem): boolean {
  return item.payload?.messageKind === "plan";
}

export function latestPlanTurnId(
  timelineItems: readonly PlanTimelineItem[]
): string | null {
  let latestTurnId: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const item of timelineItems) {
    const turnId = item.turnId?.trim();
    if (!turnId) continue;
    const time = itemTime(item);
    if (time >= latestTime) {
      latestTime = time;
      latestTurnId = turnId;
    }
  }
  if (!latestTurnId) return null;
  return timelineItems.some(
    (item) => item.turnId?.trim() === latestTurnId && isPlanItem(item)
  )
    ? latestTurnId
    : null;
}

export const MINIMUM_AUTO_TOKEN_BUDGET = 32_000;
export const MAXIMUM_AUTO_TOKEN_BUDGET = 2_000_000;

export interface PlanIssueExecutionProfile {
  reasoningIntensity: number;
  orchestrationIntensity: number;
}

export interface PlanIssueBudget {
  mode: "auto" | "fixed";
  tokenLimit: number;
  quotaWaterlinePercent: number;
}

/**
 * Remembered planning defaults chosen before a Plan turn is submitted. The
 * generated plan can still provide explicit values; otherwise these values
 * seed the mandatory Issue-decomposition review.
 */
export interface PlanIssueBudgetPreset {
  executionProfile: PlanIssueExecutionProfile;
  budget: PlanIssueBudget;
}

export function autoTokenBudget(
  taskCount: number,
  profile: PlanIssueExecutionProfile
): number {
  const count = Number.isSafeInteger(taskCount) ? Math.max(1, taskCount) : 1;
  const compiled =
    16_000 +
    count *
      (24_000 +
        Math.round(profile.reasoningIntensity) * 320 +
        Math.round(profile.orchestrationIntensity) * 160);
  return Math.min(
    MAXIMUM_AUTO_TOKEN_BUDGET,
    Math.max(MINIMUM_AUTO_TOKEN_BUDGET, compiled)
  );
}

export function defaultPlanIssueBudgetPreset(): PlanIssueBudgetPreset {
  const executionProfile: PlanIssueExecutionProfile = {
    reasoningIntensity: 50,
    orchestrationIntensity: 50
  };
  return {
    executionProfile,
    budget: {
      mode: "auto",
      tokenLimit: autoTokenBudget(1, executionProfile),
      quotaWaterlinePercent: 10
    }
  };
}

/** Strict persisted-state reader; malformed values are dropped safely. */
export function normalizePlanIssueBudgetPreset(
  value: unknown
): PlanIssueBudgetPreset | null {
  if (!isRecord(value)) return null;
  const executionProfileValue = isRecord(value.executionProfile)
    ? value.executionProfile
    : null;
  const budgetValue = isRecord(value.budget) ? value.budget : null;
  if (!executionProfileValue || !budgetValue) return null;
  const reasoningIntensity = percentValue(
    executionProfileValue.reasoningIntensity
  );
  const orchestrationIntensity = percentValue(
    executionProfileValue.orchestrationIntensity
  );
  const mode = budgetValue.mode === "fixed" ? "fixed" : "auto";
  const tokenLimit = positiveInteger(budgetValue.tokenLimit);
  const quotaWaterlinePercent = percentValue(budgetValue.quotaWaterlinePercent);
  if (
    reasoningIntensity === undefined ||
    orchestrationIntensity === undefined ||
    tokenLimit === undefined ||
    quotaWaterlinePercent === undefined
  ) {
    return null;
  }
  return {
    executionProfile: { reasoningIntensity, orchestrationIntensity },
    budget: { mode, tokenLimit, quotaWaterlinePercent }
  };
}

export function planIssueBudgetPresetsEqual(
  left: PlanIssueBudgetPreset | null | undefined,
  right: PlanIssueBudgetPreset | null | undefined
): boolean {
  return (
    (left?.executionProfile.reasoningIntensity ?? null) ===
      (right?.executionProfile.reasoningIntensity ?? null) &&
    (left?.executionProfile.orchestrationIntensity ?? null) ===
      (right?.executionProfile.orchestrationIntensity ?? null) &&
    (left?.budget.mode ?? null) === (right?.budget.mode ?? null) &&
    (left?.budget.tokenLimit ?? null) === (right?.budget.tokenLimit ?? null) &&
    (left?.budget.quotaWaterlinePercent ?? null) ===
      (right?.budget.quotaWaterlinePercent ?? null)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function percentValue(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}
