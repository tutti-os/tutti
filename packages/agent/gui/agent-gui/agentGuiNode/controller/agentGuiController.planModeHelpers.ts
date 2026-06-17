// Agent GUI controller — plan mode state observation and resolution.

import type { AgentSessionState } from "../../../shared/agentSessionTypes";
import type { WorkspaceAgentActivityTimelineItem } from "../../../shared/workspaceAgentActivityTypes";
import { stringPayloadValue } from "./agentGuiController.promptHelpers";
import { timelineItemTime } from "./agentGuiController.sessionHelpers";

export interface AgentPlanModeObservedState {
  planMode: boolean;
  observedAtUnixMs: number;
}

export function latestPlanModeStateFromTimelineItems(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): AgentPlanModeObservedState | null {
  let latest: AgentPlanModeObservedState | null = null;
  for (const item of timelineItems) {
    const toolName = normalizePlanModeToolName(
      item.name ??
        stringPayloadValue(item.payload, "toolName") ??
        stringPayloadValue(item.payload, "name") ??
        stringPayloadValue(item.payload, "title")
    );
    if (toolName !== "enterplanmode" && toolName !== "exitplanmode") {
      continue;
    }
    const status = normalizePlanModeToolStatus(
      item.status ?? stringPayloadValue(item.payload, "status")
    );
    if (status === "failed" || status === "canceled") {
      continue;
    }
    if (toolName === "exitplanmode" && status !== "completed") {
      continue;
    }
    const next = {
      planMode: toolName === "enterplanmode",
      observedAtUnixMs: timelineItemTime(item)
    };
    if (!latest || next.observedAtUnixMs >= latest.observedAtUnixMs) {
      latest = next;
    }
  }
  return latest;
}

export function planModeStateFromSessionState(
  state: AgentSessionState | null
): AgentPlanModeObservedState | null {
  if (!state) {
    return null;
  }
  const runtimeMode = normalizePlanModeToolName(
    typeof state.runtimeContext?.mode === "string"
      ? state.runtimeContext.mode
      : undefined
  );
  if (runtimeMode) {
    return {
      planMode: runtimeMode === "plan",
      observedAtUnixMs: state.updatedAtUnixMs
    };
  }
  if (state.settings?.planMode !== undefined) {
    return {
      planMode: Boolean(state.settings.planMode),
      observedAtUnixMs: state.updatedAtUnixMs
    };
  }
  return null;
}

export function resolveEffectivePlanModeFromStates(input: {
  sessionPlanModeState: AgentPlanModeObservedState | null;
  timelinePlanModeState: AgentPlanModeObservedState | null;
  fallbackPlanMode: boolean;
}): boolean {
  if (
    input.timelinePlanModeState &&
    (!input.sessionPlanModeState ||
      input.timelinePlanModeState.observedAtUnixMs >=
        input.sessionPlanModeState.observedAtUnixMs)
  ) {
    return input.timelinePlanModeState.planMode;
  }
  return input.sessionPlanModeState?.planMode ?? input.fallbackPlanMode;
}

export function normalizePlanModeToolName(
  value: string | null | undefined
): string {
  return (value ?? "")
    .replace(/[_\s-]+/g, "")
    .trim()
    .toLowerCase();
}

export function normalizePlanModeToolStatus(
  value: string | null | undefined
): "completed" | "failed" | "canceled" | "other" {
  switch (value?.trim().toLowerCase()) {
    case "completed":
    case "complete":
    case "succeeded":
    case "success":
    case "done":
      return "completed";
    case "failed":
    case "failure":
    case "error":
      return "failed";
    case "canceled":
    case "cancelled":
    case "rejected":
    case "aborted":
      return "canceled";
    default:
      return "other";
  }
}
