import type { AgentActivityDisplayStatus } from "@tutti-os/agent-activity-core";
import { useEffect, useMemo, useRef } from "react";
import { AGENT_PROVIDER_LABEL } from "../../../contexts/settings/domain/agentSettings";
import type { AgentHostUserProject } from "../../../host/agentHostApi";
import { translate } from "../../../i18n/index";
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
import { stableConversationSummaryList } from "./agentGuiController.stableHelpers";
import { conversationBusyStatusFromAgentActivityDisplayStatus } from "./agentGuiController.draftMessageHelpers";
import { mergeVisibleConversations } from "./agentGuiController.conversationHelpers";
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
  previewMode: boolean;
  agentTargetsLoading: boolean;
  shouldUseStaticProviderTargets: boolean;
  transientConversation: AgentGUIConversationSummary | null;
  userProjects: readonly AgentHostUserProject[];
  workspacePath: string;
}

export function useAgentGUIConversationPresentation(
  input: UseAgentGUIConversationPresentationInput
) {
  const activeConversation = useMemo(() => {
    const resolved = resolveConversationSummaryById(
      input.conversations,
      input.activeConversationId,
      input.transientConversation
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
      return status === resolved.status ? resolved : { ...resolved, status };
    }
    if (!input.activeConversationId) return null;
    const providerLabel =
      AGENT_PROVIDER_LABEL[input.data.provider] ??
      input.data.provider ??
      translate("sidebar.fallbackAgentLabel");
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
    const fallbackUpdatedAtUnixMs = Date.now();
    return {
      id: input.activeConversationId,
      userId: input.currentUserId?.trim() || undefined,
      provider: input.data.provider,
      title: providerLabel,
      titleFallback: null,
      status: activityBusyStatus ?? fallbackStatus,
      cwd: input.workspacePath,
      project: resolveAgentGUIConversationProject(
        input.workspacePath,
        input.userProjects,
        { isNoProjectPath: input.isNoProjectPath }
      ),
      sortTimeUnixMs: fallbackUpdatedAtUnixMs,
      updatedAtUnixMs: fallbackUpdatedAtUnixMs
    };
  }, [
    input.activeConversationId,
    input.activeLatestPendingSubmitTurnId,
    input.activityDisplayStatuses,
    input.conversations,
    input.currentUserId,
    input.data.provider,
    input.draftByScopeKey,
    input.hasUnconfirmedSubmit,
    input.isCreatingConversation,
    input.isNoProjectPath,
    input.isSubmitting,
    input.transientConversation,
    input.userProjects,
    input.workspacePath
  ]);

  useEffect(() => {
    if (
      input.previewMode ||
      input.agentTargetsLoading ||
      !input.activeConversationId
    ) {
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
    if (!providerMismatch && !agentTargetMismatch) return;
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
      if (
        current.provider === targetData.provider &&
        normalizeOptionalText(current.agentTargetId) ===
          targetData.agentTargetId
      ) {
        return current;
      }
      input.dataRef.current = targetData.data;
      return targetData.data;
    });
  }, [
    input.activeConversationId,
    input.conversations,
    input.dataRef,
    input.defaultAgentTargetId,
    input.normalizedExplicitProviderTargets,
    input.normalizedProviderTargets,
    input.onDataChangeRef,
    input.previewMode,
    input.agentTargetsLoading,
    input.shouldUseStaticProviderTargets,
    input.transientConversation
  ]);

  const visibleConversationsRef = useRef<AgentGUIConversationSummary[] | null>(
    null
  );
  const visibleConversations = useMemo(() => {
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
    const stableNext = stableConversationSummaryList(
      visibleConversationsRef.current,
      next
    );
    visibleConversationsRef.current = stableNext;
    return stableNext;
  }, [
    input.activityDisplayStatuses,
    input.conversations,
    input.isNoProjectPath,
    input.transientConversation,
    input.userProjects
  ]);

  return { activeConversation, visibleConversations };
}
