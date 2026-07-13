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
