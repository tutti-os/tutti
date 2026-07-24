import {
  selectEngineSession,
  type AgentActivityGoalControlAction,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useRef } from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type {
  AgentComposerDraft,
  AgentGUIOptimisticGoalControl
} from "../model/agentGuiNodeTypes";
import {
  emptyAgentComposerDraft,
  snapshotAgentComposerDraft
} from "../model/agentComposerDraft";
import { clearSubmittedDraftIfUnchanged } from "./agentGuiController.draftMessageHelpers";
import { getAgentGUIErrorMessage } from "./agentGuiController.errors";
import {
  projectOptimisticGoalControl,
  unresolvedOptimisticGoalControl
} from "./agentGuiOptimisticGoal";

interface UseAgentGUIGoalControlActionsInput {
  activeConversationIdRef: RefObject<string | null>;
  agentActivityRuntime: AgentActivityRuntime;
  draftByScopeKeyRef: RefObject<Record<string, AgentComposerDraft>>;
  isCurrentConversation(agentSessionId: string): boolean;
  optimisticGoalControl: AgentGUIOptimisticGoalControl | null;
  sessionEngine: AgentSessionEngine;
  setDetailError: Dispatch<SetStateAction<string | null>>;
  setDraftByScopeKey: Dispatch<
    SetStateAction<Record<string, AgentComposerDraft>>
  >;
  setGoalClearNoticeSequence: Dispatch<SetStateAction<number>>;
  setOptimisticGoalControl: Dispatch<
    SetStateAction<AgentGUIOptimisticGoalControl | null>
  >;
  workspaceId: string;
}

export function useAgentGUIGoalControlActions(
  input: UseAgentGUIGoalControlActionsInput
) {
  const requestSequenceRef = useRef(0);
  const beginOptimisticGoalControl = useCallback(
    (
      agentSessionId: string,
      action: AgentActivityGoalControlAction,
      objective?: string,
      requestId?: string,
      reconcileOnObjectiveMatch = false
    ): string => {
      const canonicalSession =
        selectEngineSession(
          input.sessionEngine.getSnapshot(),
          agentSessionId
        ) ?? null;
      const pendingGoalControl = unresolvedOptimisticGoalControl(
        input.optimisticGoalControl,
        agentSessionId,
        canonicalSession
      );
      const nextRequestId =
        requestId ??
        `goal-control:${Date.now()}:${++requestSequenceRef.current}`;
      input.setOptimisticGoalControl({
        agentSessionId,
        goal: projectOptimisticGoalControl(
          pendingGoalControl?.goal ?? canonicalSession?.goal ?? null,
          action,
          objective
        ),
        reconcileOnObjectiveMatch,
        requestId: nextRequestId
      });
      return nextRequestId;
    },
    [
      input.optimisticGoalControl,
      input.sessionEngine,
      input.setOptimisticGoalControl
    ]
  );
  const clearOptimisticGoalControl = useCallback(
    (requestId: string) => {
      input.setOptimisticGoalControl((current) =>
        current?.requestId === requestId ? null : current
      );
    },
    [input.setOptimisticGoalControl]
  );
  const goalControl = useCallback(
    (
      action: AgentActivityGoalControlAction,
      objective?: string,
      submittedDraftScopeKey?: string
    ) => {
      const agentSessionId = input.activeConversationIdRef.current;
      if (!agentSessionId) return;
      const submittedDraftSnapshot = submittedDraftScopeKey
        ? {
            sourceScopeKey: submittedDraftScopeKey,
            content: snapshotAgentComposerDraft(
              input.draftByScopeKeyRef.current[submittedDraftScopeKey] ??
                emptyAgentComposerDraft()
            ),
            targetAgentSessionId: agentSessionId
          }
        : null;
      input.setDetailError(null);
      const optimisticRequestId = beginOptimisticGoalControl(
        agentSessionId,
        action,
        objective
      );
      void input.agentActivityRuntime
        .goalControl({
          workspaceId: input.workspaceId,
          agentSessionId,
          action,
          clientSubmitId: optimisticRequestId,
          ...(objective !== undefined ? { objective } : {})
        })
        .then(() => {
          clearOptimisticGoalControl(optimisticRequestId);
          if (submittedDraftSnapshot) {
            input.setDraftByScopeKey((current) => {
              const next = clearSubmittedDraftIfUnchanged({
                drafts: current,
                snapshot: submittedDraftSnapshot
              });
              input.draftByScopeKeyRef.current = next;
              return next;
            });
          }
          if (
            action === "clear" &&
            input.isCurrentConversation(agentSessionId)
          ) {
            input.setGoalClearNoticeSequence((current) => current + 1);
          }
        })
        .catch((error: unknown) => {
          clearOptimisticGoalControl(optimisticRequestId);
          if (input.isCurrentConversation(agentSessionId)) {
            input.setDetailError(getAgentGUIErrorMessage(error));
          }
        });
    },
    [
      beginOptimisticGoalControl,
      clearOptimisticGoalControl,
      input.activeConversationIdRef,
      input.agentActivityRuntime,
      input.draftByScopeKeyRef,
      input.isCurrentConversation,
      input.setDetailError,
      input.setDraftByScopeKey,
      input.setGoalClearNoticeSequence,
      input.workspaceId
    ]
  );
  return { beginOptimisticGoalControl, goalControl };
}
