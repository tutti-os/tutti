import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptionalTuttiModePlanReviewRuntime } from "../workspaceWorkflowRuntime";
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

function emptyState(scopeKey: string): PanelState {
  return {
    error: null,
    loading: false,
    scopeKey,
    snapshots: [],
    submittingCheckpointId: null
  };
}

export function useTuttiModePlanPanels(input: {
  decidedBy: string;
  /** Passive previews keep the hook mounted without starting transport work. */
  enabled?: boolean;
  sourceSessionId: string | null;
  workspaceId: string;
}): {
  decide(input: {
    checkpointId: string;
    decision: "accepted" | "rejected" | "canceled";
    reason?: string | null;
    workflowId: string;
  }): Promise<void>;
  error: unknown;
  loading: boolean;
  panels: readonly TuttiModePlanPanelViewModel[];
  retry(): void;
  submittingCheckpointId: string | null;
} {
  const runtime = useOptionalTuttiModePlanReviewRuntime();
  const [state, setState] = useState<PanelState>(() => emptyState(""));
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
  }, [enabled, runtime, scopeKey, sourceSessionId, workspaceId]);

  useEffect(() => {
    requestSequenceRef.current += 1;
    activeScopeRef.current = scopeKey;
    void refresh();
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
    return () => {
      unsubscribe?.();
      if (activeScopeRef.current === scopeKey) {
        activeScopeRef.current = "";
      }
      requestSequenceRef.current += 1;
    };
  }, [
    enabled,
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
          reason: decision.reason
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

  return {
    decide,
    error: visibleState.error,
    loading: visibleState.loading,
    panels,
    retry: () => setRetrySequence((current) => current + 1),
    submittingCheckpointId: visibleState.submittingCheckpointId
  };
}
