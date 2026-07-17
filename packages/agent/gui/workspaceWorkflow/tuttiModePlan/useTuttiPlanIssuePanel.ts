import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalTuttiModePlanReviewRuntime } from "../workspaceWorkflowRuntime";
import type { TuttiPlanIssueSnapshot } from "../workspaceWorkflowRuntime";
import type { TuttiPlanIssueTaskDecision } from "./TuttiPlanIssuePanel";

interface PlanIssueState {
  issue: TuttiPlanIssueSnapshot | null;
  scopeKey: string;
}

/**
 * Live view of the Issue a session's accepted Tutti plan materialized. Loads
 * on mount and refreshes on workspace issue updates. The only mutation the
 * embed owns is the acceptance decision (accept / rework) on a pending task;
 * everything else stays in the Issue Manager.
 */
export function useTuttiPlanIssuePanel(input: {
  enabled?: boolean;
  sourceSessionId: string | null;
  workspaceId: string;
}): {
  issue: TuttiPlanIssueSnapshot | null;
  decideTask:
    | ((taskId: string, decision: TuttiPlanIssueTaskDecision) => Promise<void>)
    | null;
} {
  const runtime = useOptionalTuttiModePlanReviewRuntime();
  const source = runtime?.planIssues ?? null;
  const enabled = input.enabled ?? true;
  const workspaceId = input.workspaceId.trim();
  const sourceSessionId = input.sourceSessionId?.trim() ?? "";
  const scopeKey =
    enabled && source && workspaceId && sourceSessionId
      ? JSON.stringify([workspaceId, sourceSessionId])
      : "";
  const [state, setState] = useState<PlanIssueState>({
    issue: null,
    scopeKey: ""
  });
  const activeScopeRef = useRef("");

  useEffect(() => {
    activeScopeRef.current = scopeKey;
    setState({ issue: null, scopeKey });
    if (!scopeKey || !source) {
      return;
    }
    const capturedScope = scopeKey;
    let inFlight = false;
    let trailing = false;
    const refresh = (): void => {
      if (inFlight) {
        // An update arrived mid-fetch: run one trailing refresh so the view
        // never settles on a snapshot older than the last event.
        trailing = true;
        return;
      }
      inFlight = true;
      void source
        .getSessionPlanIssue({ workspaceId, sourceSessionId })
        .then((issue) => {
          if (activeScopeRef.current !== capturedScope) return;
          setState((current) =>
            current.scopeKey === capturedScope
              ? { issue, scopeKey: capturedScope }
              : current
          );
        })
        .catch(() => {
          // Best-effort read model; a later update event retries.
        })
        .finally(() => {
          inFlight = false;
          if (trailing && activeScopeRef.current === capturedScope) {
            trailing = false;
            refresh();
          }
        });
    };
    refresh();
    const unsubscribe = source.subscribeIssueUpdates(workspaceId, () => {
      refresh();
    });
    return () => {
      unsubscribe();
      if (activeScopeRef.current === capturedScope) {
        activeScopeRef.current = "";
      }
    };
  }, [scopeKey, source, sourceSessionId, workspaceId]);

  const issue = state.scopeKey === scopeKey ? state.issue : null;
  const issueId = issue?.issueId ?? "";
  const decideTask = useCallback(
    async (
      taskId: string,
      decision: TuttiPlanIssueTaskDecision
    ): Promise<void> => {
      if (!source || !issueId) return;
      // The daemon publishes workspace.issue.updated for the transition, so
      // the subscription above refreshes the snapshot without a manual poke.
      if (decision === "accept") {
        await source.acceptTask({ workspaceId, issueId, taskId });
        return;
      }
      await source.rejectTask({ workspaceId, issueId, taskId });
    },
    [issueId, source, workspaceId]
  );

  return {
    issue,
    decideTask: source && issueId ? decideTask : null
  };
}
