import type { AgentConversationPromptVM } from "../../../shared/agentConversation/contracts/agentConversationVM";

/**
 * Codex has no provider-driven exit-plan approval flow (unlike claude-code's
 * ExitPlanMode tool): the official TUI offers a local "implement this plan?"
 * prompt after a plan-mode turn completes and submits a literal coding
 * message in default mode. This mirrors that contract for the GUI.
 * See codex-rs/tui/src/chatwidget/plan_implementation.rs.
 */
export const PLAN_IMPLEMENTATION_PROMPT = "Implement the plan.";

/** Action ids carried by the plan-implementation interactive prompt. */
export const PLAN_IMPLEMENTATION_ACTION_IMPLEMENT = "implement";
export const PLAN_IMPLEMENTATION_ACTION_FEEDBACK = "feedback";
export const PLAN_IMPLEMENTATION_ACTION_SKIP = "skip";

/**
 * Builds the plan-implementation interactive prompt VM for a plan turn so the
 * controller and the message center surface the codex plan decision through
 * the same `pendingInteractivePrompt` machinery as claude-code exit-plan.
 */
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

/**
 * Returns the turn id of the latest turn that produced a plan item, or null.
 * Driven by the same timeline data that renders the plan card (no race with a
 * separate status flag), keyed by turn id so a given plan is offered once and
 * a fresh plan turn re-arms the offer. Mirrors the codex TUI gate
 * (saw_plan_item_this_turn) but evaluated against the latest turn rather than
 * a transient per-turn boolean.
 */
export function latestPlanTurnId(
  timelineItems: readonly PlanTimelineItem[]
): string | null {
  let latestTurnId: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const item of timelineItems) {
    const turnId = item.turnId?.trim();
    if (!turnId) {
      continue;
    }
    const time = itemTime(item);
    if (time >= latestTime) {
      latestTime = time;
      latestTurnId = turnId;
    }
  }
  if (!latestTurnId) {
    return null;
  }
  const hasPlan = timelineItems.some(
    (item) => item.turnId?.trim() === latestTurnId && isPlanItem(item)
  );
  return hasPlan ? latestTurnId : null;
}
