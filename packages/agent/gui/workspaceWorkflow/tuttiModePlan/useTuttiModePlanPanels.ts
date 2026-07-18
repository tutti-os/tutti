import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptionalTuttiModePlanReviewRuntime } from "../workspaceWorkflowRuntime";
import type {
  TuttiModePlanAssignmentAgentDetail,
  TuttiModePlanAssignmentAgentOption,
  TuttiModePlanTaskAssignmentInput
} from "../workspaceWorkflowRuntime";
import type { TuttiPlanIssueSnapshot } from "../workspaceWorkflowRuntime";
import type { TuttiPlanIssueTaskDecision } from "./TuttiPlanIssuePanel";
import {
  projectTuttiModePlanPanel,
  type TuttiModePlanPanelViewModel,
  type TuttiModePlanReviewSnapshot
} from "./tuttiModePlanPanelProjection";

interface PanelState {
  error: unknown;
  loading: boolean;
  scopeKey: string;
  snapshots: readonly TuttiModePlanReviewSnapshot[];
  submittingCheckpointId: string | null;
}

interface PlanIssueState {
  issue: TuttiPlanIssueSnapshot | null;
  scopeKey: string;
}

interface AssignmentCatalogState {
  agents: readonly TuttiModePlanAssignmentAgentOption[] | null;
  optionsByAgentId: Readonly<
    Record<string, TuttiModePlanAssignmentAgentDetail>
  >;
  scopeKey: string;
}

export interface TuttiModePlanAssignmentCatalog {
  /** Null until loaded; empty array is a real "no agents" answer. */
  agents: readonly TuttiModePlanAssignmentAgentOption[] | null;
  optionsByAgentId: Readonly<
    Record<string, TuttiModePlanAssignmentAgentDetail>
  >;
  loadAgentOptions(agentTargetId: string): void;
}

function emptyState(scopeKey: string): PanelState {
  return {
    error: null,
    loading: false,
    scopeKey,
    snapshots: [],
    submittingCheckpointId: null
  };
}

function emptyAssignmentState(scopeKey: string): AssignmentCatalogState {
  return { agents: null, optionsByAgentId: {}, scopeKey };
}

const EMPTY_AGENT_DETAIL: TuttiModePlanAssignmentAgentDetail = {
  models: [],
  modelPlans: [],
  permissionModes: [],
  reasoningEfforts: []
};

export function useTuttiModePlanPanels(input: {
  decidedBy: string;
  /** Passive previews keep the hook mounted without starting transport work. */
  enabled?: boolean;
  sourceSessionId: string | null;
  workspaceId: string;
}): {
  assignmentCatalog: TuttiModePlanAssignmentCatalog;
  decide(input: {
    checkpointId: string;
    decision: "accepted" | "rejected" | "canceled";
    reason?: string | null;
    taskAssignments?: readonly TuttiModePlanTaskAssignmentInput[];
    workflowId: string;
  }): Promise<void>;
  error: unknown;
  loading: boolean;
  panels: readonly TuttiModePlanPanelViewModel[];
  /** Live snapshot of the Issue this session's accepted plan materialized. */
  planIssue: TuttiPlanIssueSnapshot | null;
  /** Accept/rework a pending task from the embedded panel; null until loaded. */
  decidePlanIssueTask:
    | ((taskId: string, decision: TuttiPlanIssueTaskDecision) => Promise<void>)
    | null;
  /** Stop the plan issue's execution (pause + cancel runs); null until loaded. */
  cancelPlanIssueExecution: (() => Promise<void>) | null;
  retry(): void;
  submittingCheckpointId: string | null;
} {
  const runtime = useOptionalTuttiModePlanReviewRuntime();
  const [state, setState] = useState<PanelState>(() => emptyState(""));
  const [assignmentState, setAssignmentState] =
    useState<AssignmentCatalogState>(() => emptyAssignmentState(""));
  const [planIssueState, setPlanIssueState] = useState<PlanIssueState>({
    issue: null,
    scopeKey: ""
  });
  const requestSequenceRef = useRef(0);
  const [retrySequence, setRetrySequence] = useState(0);
  const enabled = input.enabled ?? true;
  const workspaceId = input.workspaceId.trim();
  const sourceSessionId = input.sourceSessionId?.trim() ?? "";
  const scopeKey =
    enabled && runtime && workspaceId && sourceSessionId
      ? JSON.stringify([workspaceId, sourceSessionId])
      : "";
  const activeScopeRef = useRef("");
  const assignmentRequestsRef = useRef(new Set<string>());

  const assignmentSource = runtime?.assignmentOptions ?? null;

  const loadAgentOptions = useCallback(
    (agentTargetId: string): void => {
      const capturedScope = scopeKey;
      const trimmed = agentTargetId.trim();
      if (
        !capturedScope ||
        !assignmentSource ||
        !trimmed ||
        assignmentRequestsRef.current.has(trimmed)
      ) {
        return;
      }
      assignmentRequestsRef.current.add(trimmed);
      void assignmentSource
        .loadAgentOptions({ workspaceId, agentTargetId: trimmed })
        .then((options) => {
          if (activeScopeRef.current !== capturedScope) return;
          setAssignmentState((current) =>
            current.scopeKey === capturedScope
              ? {
                  ...current,
                  optionsByAgentId: {
                    ...current.optionsByAgentId,
                    [trimmed]: options
                  }
                }
              : current
          );
        })
        .catch(() => {
          // Allow a later explicit agent re-selection to retry the load, but
          // settle the entry with an empty catalog so selectors degrade to
          // the current values instead of wedging on the loading placeholder.
          assignmentRequestsRef.current.delete(trimmed);
          if (activeScopeRef.current !== capturedScope) return;
          setAssignmentState((current) =>
            current.scopeKey === capturedScope &&
            current.optionsByAgentId[trimmed] === undefined
              ? {
                  ...current,
                  optionsByAgentId: {
                    ...current.optionsByAgentId,
                    [trimmed]: EMPTY_AGENT_DETAIL
                  }
                }
              : current
          );
        });
    },
    [assignmentSource, scopeKey, workspaceId]
  );

  // Catalog loading piggybacks on snapshot refreshes instead of adding a
  // component effect: every successful listPending with pending work triggers
  // the (deduplicated) agent-directory load plus a preload of the option
  // catalogs for agents already referenced by the plan document.
  const ensureAssignmentCatalog = useCallback(
    (
      capturedScope: string,
      snapshots: readonly TuttiModePlanReviewSnapshot[]
    ): void => {
      if (!capturedScope || !assignmentSource || snapshots.length === 0) {
        return;
      }
      if (!assignmentRequestsRef.current.has("__agents__")) {
        assignmentRequestsRef.current.add("__agents__");
        void assignmentSource
          .listAgents({ workspaceId })
          .then((agents) => {
            if (activeScopeRef.current !== capturedScope) return;
            setAssignmentState((current) =>
              current.scopeKey === capturedScope
                ? { ...current, agents: [...agents] }
                : current
            );
          })
          .catch(() => {
            assignmentRequestsRef.current.delete("__agents__");
          });
      }
      for (const snapshot of snapshots) {
        const revision = snapshot.revisions.find(
          (candidate) => candidate.id === snapshot.workflow.currentRevisionId
        );
        for (const task of revision?.document.tasks ?? []) {
          if (task.agentTargetId?.trim()) {
            loadAgentOptions(task.agentTargetId);
          }
        }
      }
    },
    [assignmentSource, loadAgentOptions, workspaceId]
  );

  const refresh = useCallback(async (): Promise<void> => {
    const capturedScope = scopeKey;
    if (activeScopeRef.current !== capturedScope) return;
    if (!enabled || !runtime || !workspaceId || !sourceSessionId) {
      requestSequenceRef.current += 1;
      setState(emptyState(capturedScope));
      return;
    }
    const sequence = ++requestSequenceRef.current;
    setState((current) =>
      current.scopeKey === capturedScope
        ? { ...current, error: null, loading: true }
        : { ...emptyState(capturedScope), loading: true }
    );
    try {
      const snapshots = await runtime.listPending({
        workspaceId,
        sourceSessionId
      });
      if (
        requestSequenceRef.current !== sequence ||
        activeScopeRef.current !== capturedScope
      ) {
        return;
      }
      setState((current) => ({
        ...current,
        error: null,
        loading: false,
        scopeKey: capturedScope,
        snapshots: [...snapshots]
      }));
      ensureAssignmentCatalog(capturedScope, snapshots);
    } catch (error) {
      if (
        requestSequenceRef.current !== sequence ||
        activeScopeRef.current !== capturedScope
      ) {
        return;
      }
      setState((current) => ({
        ...current,
        error,
        loading: false,
        scopeKey: capturedScope,
        snapshots: []
      }));
    }
  }, [
    enabled,
    ensureAssignmentCatalog,
    runtime,
    scopeKey,
    sourceSessionId,
    workspaceId
  ]);

  const planIssueSource = runtime?.planIssues ?? null;

  useEffect(() => {
    requestSequenceRef.current += 1;
    activeScopeRef.current = scopeKey;
    assignmentRequestsRef.current = new Set<string>();
    setAssignmentState(emptyAssignmentState(scopeKey));
    setPlanIssueState({ issue: null, scopeKey });
    void refresh();
    const capturedScope = scopeKey;
    // The materialized plan Issue shares this scope's lifecycle: load with the
    // review snapshots and refresh on workspace issue events, with a trailing
    // re-read so the view never settles on a snapshot older than the last one.
    let planIssueInFlight = false;
    let planIssueTrailing = false;
    const refreshPlanIssue = (): void => {
      if (!capturedScope || !planIssueSource) return;
      if (planIssueInFlight) {
        planIssueTrailing = true;
        return;
      }
      planIssueInFlight = true;
      void planIssueSource
        .getSessionPlanIssue({ workspaceId, sourceSessionId })
        .then((issue) => {
          if (activeScopeRef.current !== capturedScope) return;
          setPlanIssueState((current) =>
            current.scopeKey === capturedScope
              ? { issue, scopeKey: capturedScope }
              : current
          );
        })
        .catch(() => {
          // Best-effort read model; a later update event retries.
        })
        .finally(() => {
          planIssueInFlight = false;
          if (planIssueTrailing && activeScopeRef.current === capturedScope) {
            planIssueTrailing = false;
            refreshPlanIssue();
          }
        });
    };
    refreshPlanIssue();
    const unsubscribe =
      enabled && runtime && workspaceId && sourceSessionId
        ? runtime.subscribe(workspaceId, (update) => {
            if (
              update.kind === "connection_restored" ||
              update.sourceSessionId === sourceSessionId
            ) {
              void refresh();
            }
          })
        : undefined;
    const unsubscribePlanIssue =
      capturedScope && planIssueSource
        ? planIssueSource.subscribeIssueUpdates(workspaceId, () => {
            refreshPlanIssue();
          })
        : undefined;
    return () => {
      unsubscribe?.();
      unsubscribePlanIssue?.();
      if (activeScopeRef.current === scopeKey) {
        activeScopeRef.current = "";
      }
      requestSequenceRef.current += 1;
    };
  }, [
    enabled,
    planIssueSource,
    refresh,
    retrySequence,
    runtime,
    scopeKey,
    sourceSessionId,
    workspaceId
  ]);

  const decide = useCallback(
    async (decision: {
      checkpointId: string;
      decision: "accepted" | "rejected" | "canceled";
      reason?: string | null;
      taskAssignments?: readonly TuttiModePlanTaskAssignmentInput[];
      workflowId: string;
    }): Promise<void> => {
      const capturedScope = scopeKey;
      if (
        !runtime ||
        !capturedScope ||
        activeScopeRef.current !== capturedScope
      )
        return;
      setState((current) => ({
        ...(current.scopeKey === capturedScope
          ? current
          : emptyState(capturedScope)),
        error: null,
        submittingCheckpointId: decision.checkpointId,
        scopeKey: capturedScope
      }));
      try {
        await runtime.decide({
          workspaceId,
          workflowId: decision.workflowId,
          checkpointId: decision.checkpointId,
          decision: decision.decision,
          decidedBy: input.decidedBy,
          reason: decision.reason,
          taskAssignments: decision.taskAssignments
        });
        if (activeScopeRef.current !== capturedScope) return;
        await refresh();
      } catch (error) {
        if (activeScopeRef.current === capturedScope) {
          setState((current) => ({ ...current, error }));
        }
      } finally {
        if (activeScopeRef.current === capturedScope) {
          setState((current) => ({
            ...current,
            submittingCheckpointId: null
          }));
        }
      }
    },
    [input.decidedBy, refresh, runtime, scopeKey, workspaceId]
  );

  const visibleState =
    state.scopeKey === scopeKey ? state : emptyState(scopeKey);

  const panels = useMemo(
    () =>
      visibleState.snapshots
        .map(projectTuttiModePlanPanel)
        .filter((panel): panel is TuttiModePlanPanelViewModel => panel !== null)
        .sort(
          (left, right) =>
            left.checkpoint.createdAtUnixMs - right.checkpoint.createdAtUnixMs
        ),
    [visibleState.snapshots]
  );

  const visiblePlanIssue =
    planIssueState.scopeKey === scopeKey ? planIssueState.issue : null;
  const planIssueId = visiblePlanIssue?.issueId ?? "";
  const decidePlanIssueTask =
    planIssueSource && planIssueId
      ? async (
          taskId: string,
          decision: TuttiPlanIssueTaskDecision
        ): Promise<void> => {
          // The daemon publishes workspace.issue.updated for the transition,
          // so the subscription above refreshes without a manual poke.
          if (decision === "accept") {
            await planIssueSource.acceptTask({
              workspaceId,
              issueId: planIssueId,
              taskId
            });
            return;
          }
          await planIssueSource.rejectTask({
            workspaceId,
            issueId: planIssueId,
            taskId
          });
        }
      : null;
  const cancelPlanIssueExecution =
    planIssueSource && planIssueId
      ? async (): Promise<void> => {
          // Stop is one daemon-owned cascade: pause dispatch, cancel every
          // running run. The issue-updated event refreshes the embed.
          await planIssueSource.cancelExecution({
            workspaceId,
            issueId: planIssueId
          });
        }
      : null;

  const visibleAssignmentState =
    assignmentState.scopeKey === scopeKey
      ? assignmentState
      : emptyAssignmentState(scopeKey);

  return {
    assignmentCatalog: {
      agents: assignmentSource ? visibleAssignmentState.agents : null,
      optionsByAgentId: visibleAssignmentState.optionsByAgentId,
      loadAgentOptions
    },
    decide,
    error: visibleState.error,
    loading: visibleState.loading,
    panels,
    planIssue: visiblePlanIssue,
    decidePlanIssueTask,
    cancelPlanIssueExecution,
    retry: () => setRetrySequence((current) => current + 1),
    submittingCheckpointId: visibleState.submittingCheckpointId
  };
}
