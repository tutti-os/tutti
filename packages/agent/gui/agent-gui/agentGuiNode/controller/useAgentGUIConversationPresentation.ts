import type { AgentActivityDisplayStatus } from "@tutti-os/agent-activity-core";
import { useEffect, useMemo, useRef } from "react";
import type { AgentHostUserProject } from "../../../host/agentHostApi";
import {
  agentGUIAgentTargetRefsEqual,
  resolveAgentGUIAgentTarget
} from "../../../agentTargets";
import type { AgentGUINodeData, AgentGUIAgentTarget } from "../../../types";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";
import { resolveAgentComposerDraftScopeKey } from "../model/agentComposerDraftScope";
import {
  applyAgentGUIConversationProjects,
  resolveAgentGUIConversationProject,
  type AgentGUIConversationSummary
} from "../model/agentGuiConversationModel";
import { isAgentGUIProviderUnresolved } from "../../../shared/agentConversationTitleProjection.ts";
import { normalizeOptionalText } from "./agentGuiController.promptHelpers";
import { composerTargetDataFromProviderTarget } from "./agentGuiController.providerHelpers";
import {
  conversationSummariesRenderEqual,
  stableConversationSummaryList
} from "./agentGuiController.stableHelpers";
import { conversationBusyStatusFromAgentActivityDisplayStatus } from "./agentGuiController.draftMessageHelpers";
import { mergeVisibleConversations } from "./agentGuiController.conversationHelpers";
import { rememberAgentGUIActiveConversation } from "../model/agentGuiSessionNavigationMemory";
import { resolveConversationSummaryById } from "./useAgentConversationSelection";

interface CurrentValue<T> {
  current: T;
}

interface UseAgentGUIConversationPresentationInput {
  activeConversationId: string | null;
  activeLatestPendingSubmitTurnId: string | null;
  activityDisplayStatuses: ReadonlyMap<string, AgentActivityDisplayStatus>;
  conversations: readonly AgentGUIConversationSummary[];
  currentUserId: string | null | undefined;
  data: AgentGUINodeData;
  dataRef: CurrentValue<AgentGUINodeData>;
  defaultAgentTargetId: string | null;
  draftByScopeKey: Record<string, AgentComposerDraft>;
  hasUnconfirmedSubmit: boolean;
  isCreatingConversation: boolean;
  isNoProjectPath?: (input: { path: string }) => boolean;
  isSubmitting: boolean;
  normalizedExplicitProviderTargets: readonly AgentGUIAgentTarget[];
  normalizedProviderTargets: readonly AgentGUIAgentTarget[];
  onDataChangeRef: CurrentValue<
    (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
  >;
  agentTargetsLoading: boolean;
  shouldUseStaticProviderTargets: boolean;
  transientConversation: AgentGUIConversationSummary | null;
  userProjects: readonly AgentHostUserProject[];
  workspacePath: string;
}

export function useAgentGUIConversationPresentation(
  input: UseAgentGUIConversationPresentationInput
) {
  const visibleConversationsRef = useRef<AgentGUIConversationSummary[] | null>(
    null
  );
  const conversationProjection = useMemo(() => {
    const source = mergeVisibleConversations(
      input.conversations,
      input.transientConversation
    );
    const mapped = source.map((conversation) => {
      const activityBusyStatus =
        conversationBusyStatusFromAgentActivityDisplayStatus(
          input.activityDisplayStatuses.get(conversation.id)
        );
      return activityBusyStatus && conversation.status !== activityBusyStatus
        ? { ...conversation, status: activityBusyStatus }
        : conversation;
    });
    const next = applyAgentGUIConversationProjects(mapped, input.userProjects, {
      isNoProjectPath: input.isNoProjectPath
    });
    const visibleConversations = stableConversationSummaryList(
      visibleConversationsRef.current,
      next
    );
    visibleConversationsRef.current = visibleConversations;
    return { semanticConversations: next, visibleConversations };
  }, [
    input.activityDisplayStatuses,
    input.conversations,
    input.isNoProjectPath,
    input.transientConversation,
    input.userProjects
  ]);
  const visibleConversations = conversationProjection.visibleConversations;
  const activeConversationRef = useRef<AgentGUIConversationSummary[] | null>(
    null
  );

  const activeConversation = useMemo(() => {
    const stabilize = (
      next: AgentGUIConversationSummary | null
    ): AgentGUIConversationSummary | null => {
      const previous = activeConversationRef.current?.[0] ?? null;
      const canReusePrevious =
        previous !== null &&
        next !== null &&
        conversationSummariesRenderEqual(previous, next) &&
        previous.agentTargetId === next.agentTargetId &&
        previous.resumable === next.resumable;
      const stable = next ? [canReusePrevious ? previous : next] : [];
      activeConversationRef.current = stable;
      return stable[0] ?? null;
    };
    const resolved = resolveConversationSummaryById(
      conversationProjection.semanticConversations,
      input.activeConversationId
    );
    if (resolved) {
      const activityDisplayStatus = input.activityDisplayStatuses.get(
        resolved.id
      );
      const activityBusyStatus =
        conversationBusyStatusFromAgentActivityDisplayStatus(
          activityDisplayStatus
        );
      const hasCanonicalTerminalStatus =
        activityDisplayStatus === "completed" ||
        activityDisplayStatus === "failed" ||
        activityDisplayStatus === "canceled";
      const status =
        (input.isSubmitting || input.hasUnconfirmedSubmit
          ? ("working" as const)
          : hasCanonicalTerminalStatus
            ? activityDisplayStatus
            : activityBusyStatus) ??
        (resolved.status === "ready" &&
        (input.activeLatestPendingSubmitTurnId || input.isSubmitting)
          ? ("working" as const)
          : resolved.status);
      return stabilize(
        status === resolved.status ? resolved : { ...resolved, status }
      );
    }
    if (!input.activeConversationId) return stabilize(null);
    const fallbackAgentTarget = resolveAgentGUIAgentTarget({
      agentTargetId: input.data.agentTargetId,
      defaultAgentTargetId: input.defaultAgentTargetId,
      provider: input.data.provider,
      agentTargets: input.normalizedProviderTargets,
      useStaticCatalog: input.shouldUseStaticProviderTargets
    });
    const fallbackStatus =
      input.isSubmitting ||
      input.isCreatingConversation ||
      Object.prototype.hasOwnProperty.call(
        input.draftByScopeKey,
        resolveAgentComposerDraftScopeKey({
          agentSessionId: input.activeConversationId
        })
      )
        ? ("working" as const)
        : ("ready" as const);
    const activityBusyStatus =
      conversationBusyStatusFromAgentActivityDisplayStatus(
        input.activityDisplayStatuses.get(input.activeConversationId)
      );
    const previousActiveConversation = activeConversationRef.current?.[0];
    const fallbackUpdatedAtUnixMs =
      previousActiveConversation?.id === input.activeConversationId
        ? previousActiveConversation.updatedAtUnixMs
        : Date.now();
    return stabilize({
      id: input.activeConversationId,
      agentTargetId:
        normalizeOptionalText(input.data.agentTargetId) ??
        fallbackAgentTarget?.agentTargetId,
      userId: input.currentUserId?.trim() || undefined,
      provider: input.data.provider,
      title: "",
      titleFallback: "untitled-conversation",
      status: activityBusyStatus ?? fallbackStatus,
      cwd: input.workspacePath,
      project: resolveAgentGUIConversationProject(
        input.workspacePath,
        input.userProjects,
        { isNoProjectPath: input.isNoProjectPath }
      ),
      sortTimeUnixMs: fallbackUpdatedAtUnixMs,
      updatedAtUnixMs: fallbackUpdatedAtUnixMs
    });
  }, [
    input.activeConversationId,
    input.activeLatestPendingSubmitTurnId,
    input.activityDisplayStatuses,
    input.currentUserId,
    input.data.agentTargetId,
    input.data.provider,
    input.defaultAgentTargetId,
    input.draftByScopeKey,
    input.hasUnconfirmedSubmit,
    input.isCreatingConversation,
    input.isNoProjectPath,
    input.isSubmitting,
    input.normalizedProviderTargets,
    input.shouldUseStaticProviderTargets,
    input.userProjects,
    conversationProjection.semanticConversations,
    input.workspacePath
  ]);

  useEffect(() => {
    if (input.agentTargetsLoading || !input.activeConversationId) {
      return;
    }
    const summary = resolveConversationSummaryById(
      input.conversations,
      input.activeConversationId,
      input.transientConversation
    );
    if (!summary || isAgentGUIProviderUnresolved(summary.provider)) return;
    const summaryAgentTargetId = normalizeOptionalText(summary.agentTargetId);
    const providerMismatch =
      input.dataRef.current.provider !== summary.provider;
    const agentTargetMismatch =
      summaryAgentTargetId !== null &&
      normalizeOptionalText(input.dataRef.current.agentTargetId) !==
        summaryAgentTargetId;
    const rememberedSessionMismatch =
      summaryAgentTargetId !== null &&
      input.dataRef.current.lastActiveAgentSessionIdByAgentTargetId?.[
        summaryAgentTargetId
      ] !== input.activeConversationId;
    if (
      !providerMismatch &&
      !agentTargetMismatch &&
      !rememberedSessionMismatch
    ) {
      return;
    }
    const sessionTarget = resolveAgentGUIAgentTarget({
      agentTargetId: summaryAgentTargetId,
      defaultAgentTargetId: input.defaultAgentTargetId,
      provider: summary.provider,
      agentTargets: input.normalizedProviderTargets,
      useStaticCatalog: input.shouldUseStaticProviderTargets
    });
    if (!sessionTarget || sessionTarget.provider !== summary.provider) return;
    if (
      !providerMismatch &&
      summaryAgentTargetId !== null &&
      (sessionTarget.agentTargetId?.trim() ?? "") !== summaryAgentTargetId
    ) {
      return;
    }
    const sessionTargetIsExplicit =
      input.normalizedExplicitProviderTargets.some(
        (target) =>
          target.provider === sessionTarget.provider &&
          target.targetId === sessionTarget.targetId &&
          agentGUIAgentTargetRefsEqual(target.ref, sessionTarget.ref)
      );
    input.onDataChangeRef.current((current) => {
      const targetData = composerTargetDataFromProviderTarget({
        current,
        isExplicit: sessionTargetIsExplicit,
        target: sessionTarget
      });
      const nextData = rememberAgentGUIActiveConversation(
        targetData.data,
        input.activeConversationId,
        summaryAgentTargetId
      );
      if (
        current.provider === targetData.provider &&
        normalizeOptionalText(current.agentTargetId) ===
          targetData.agentTargetId &&
        (summaryAgentTargetId === null ||
          current.lastActiveAgentSessionIdByAgentTargetId?.[
            summaryAgentTargetId
          ] === input.activeConversationId)
      ) {
        return current;
      }
      input.dataRef.current = nextData;
      return nextData;
    });
  }, [
    input.activeConversationId,
    input.conversations,
    input.dataRef,
    input.defaultAgentTargetId,
    input.normalizedExplicitProviderTargets,
    input.normalizedProviderTargets,
    input.onDataChangeRef,
    input.agentTargetsLoading,
    input.shouldUseStaticProviderTargets,
    input.transientConversation
  ]);

  return { activeConversation, visibleConversations };
}
