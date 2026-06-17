// Agent GUI controller — plan mode state as a small derivation hook.
//
// Wraps the pure planModeHelpers derivations so the controller consumes a
// single effectivePlanMode (plus the timeline observed state used downstream)
// instead of three inlined memos. Behavior is identical to the previous inlined
// memos — see the "effective plan mode contract" tests in
// useAgentGUINodeController.spec.tsx, which pin the derivation.

import { useMemo } from "react";
import type { AgentSessionState } from "../../../shared/agentSessionTypes";
import type { WorkspaceAgentActivityTimelineItem } from "../../../shared/workspaceAgentActivityTypes";
import {
  latestPlanModeStateFromTimelineItems,
  planModeStateFromSessionState,
  resolveEffectivePlanModeFromStates,
  type AgentPlanModeObservedState
} from "./agentGuiController.planModeHelpers";

export interface AgentGuiPlanModeState {
  effectivePlanMode: boolean;
  sessionPlanModeState: AgentPlanModeObservedState | null;
  timelinePlanModeState: AgentPlanModeObservedState | null;
}

export function usePlanModeState(input: {
  activeTimelineItems: readonly WorkspaceAgentActivityTimelineItem[];
  activeSessionState: AgentSessionState | null;
  // Matches the controller's draft value (boolean | undefined); Boolean()-ed
  // into the fallback exactly as the previous inlined memo did.
  draftPlanMode: boolean | undefined;
}): AgentGuiPlanModeState {
  const { activeTimelineItems, activeSessionState, draftPlanMode } = input;
  const timelinePlanModeState = useMemo(
    () => latestPlanModeStateFromTimelineItems(activeTimelineItems),
    [activeTimelineItems]
  );
  const sessionPlanModeState = useMemo(
    () => planModeStateFromSessionState(activeSessionState),
    [activeSessionState]
  );
  const effectivePlanMode = useMemo(
    () =>
      resolveEffectivePlanModeFromStates({
        sessionPlanModeState,
        timelinePlanModeState,
        fallbackPlanMode: Boolean(draftPlanMode)
      }),
    [draftPlanMode, sessionPlanModeState, timelinePlanModeState]
  );
  return { effectivePlanMode, sessionPlanModeState, timelinePlanModeState };
}
