import {
  selectEngineAvailableCommands,
  type AgentActivityInteraction,
  type AgentActivityMessage,
  type AgentActivityTurn,
  type AgentSessionEngine,
  type EngineQueuedPrompt,
  type PromptQueueInFlightCommand
} from "@tutti-os/agent-activity-core";
import { useEffect, useMemo, useRef } from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type {
  AgentPromptContentBlock,
  AppErrorCode
} from "../../../shared/contracts/dto";
import { useEngineSelector } from "../../../shared/engine/useEngineSelector";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import {
  buildAgentGUIConversationModels,
  type AgentGUIConversationProjectionSource,
  type AgentGUIInteractivePrompt
} from "../model/agentGuiConversationModel";
import type {
  AgentComposerDraft,
  AgentGUIQueuedPromptVM
} from "../model/agentGuiNodeTypes";
import type { AgentGUIComposerTargetData } from "./agentGuiController.composerPresentation";
import { providerSkillsFromComposerOptions } from "./agentGuiController.composerHelpers";
import {
  approvalRequestFromConversation,
  interactiveApprovalFromInteraction,
  interactivePromptFromConversation,
  interactivePromptFromInteraction
} from "./agentGuiController.interactiveHelpers";
import { isNonRetryableResumeErrorCode } from "./agentGuiController.errors";
import { reportAgentGUIMessagePageDiagnostic } from "./agentGuiController.reporting";
import {
  useStableConversationDetail,
  useStableProviderSkillOptions
} from "./agentGuiController.stableHelpers";
import {
  EMPTY_AGENT_COMPOSER_DRAFT,
  readNodeDefaultDraftContent
} from "./agentGuiController.draftMessageHelpers";
import {
  maxFiniteMessageVersion,
  minFiniteMessageVersion
} from "./useAgentConversationMessagePaging";

interface UseAgentGUIConversationDetailInput {
  activeCancelStatus: string | null;
  activeConversation: AgentGUIConversationSummary | null;
  activeConversationId: string | null;
  activeConversationLiveState: "inactive" | "activating" | "active" | "failed";
  activeEngineError: string | null;
  activeMessages: readonly AgentActivityMessage[];
  activePendingInteractions: readonly AgentActivityInteraction[];
  activeQueuedPromptInFlight: PromptQueueInFlightCommand | null;
  activeQueuedPrompts: readonly EngineQueuedPrompt[];
  activeSessionView: {
    hasOlderMessages: boolean;
    isLoadingOlderMessages: boolean;
    olderMessageCount: number;
    oldestLoadedVersion: number | null;
  } | null;
  activeTimelineItems: Parameters<
    typeof buildAgentGUIConversationModels
  >[0]["timelineItems"];
  activeTurn: AgentActivityTurn | null;
  agentActivityRuntime: AgentActivityRuntime;
  avoidGroupingEdits: boolean;
  codeFor(agentSessionId: string | null): AppErrorCode | null;
  detailError: string | null;
  draftBySessionId: Record<string, AgentComposerDraft>;
  errorFor(agentSessionId: string | null): string | null;
  providerComposerOptions: Parameters<
    typeof providerSkillsFromComposerOptions
  >[0];
  selectedComposerTargetData: AgentGUIComposerTargetData;
  sessionEngine: AgentSessionEngine;
  workspaceId: string;
  workspacePath: string;
}

export function useAgentGUIConversationDetail(
  input: UseAgentGUIConversationDetailInput
) {
  const projectionConversationRef =
    useRef<AgentGUIConversationProjectionSource | null>(null);
  const activeCanonicalLiveTurn = Boolean(
    input.activeTurn && input.activeTurn.phase !== "settled"
  );
  const projectionConversation =
    useMemo<AgentGUIConversationProjectionSource | null>(() => {
      if (!input.activeConversation) {
        projectionConversationRef.current = null;
        return null;
      }
      const current = input.activeConversation;
      const previous = projectionConversationRef.current;
      if (
        previous &&
        previous.id === current.id &&
        previous.userId === current.userId &&
        previous.provider === current.provider &&
        previous.title === current.title &&
        previous.titleFallback === current.titleFallback &&
        previous.status === current.status &&
        previous.cwd === current.cwd &&
        previous.activeTurn === input.activeTurn
      ) {
        return previous;
      }
      const next = {
        id: current.id,
        userId: current.userId,
        provider: current.provider,
        title: current.title,
        titleFallback: current.titleFallback,
        status: current.status,
        cwd: current.cwd,
        updatedAtUnixMs: current.updatedAtUnixMs,
        activeTurn: input.activeTurn
      };
      projectionConversationRef.current = next;
      return next;
    }, [input.activeConversation, input.activeTurn]);

  const draftContent = input.activeConversationId
    ? (input.draftBySessionId[input.activeConversationId] ??
      EMPTY_AGENT_COMPOSER_DRAFT)
    : readNodeDefaultDraftContent({
        data: input.selectedComposerTargetData.data,
        drafts: input.draftBySessionId
      });
  const engineAvailableCommands = useEngineSelector(
    input.sessionEngine,
    (state) => selectEngineAvailableCommands(state, input.activeConversationId)
  );
  const availableCommands = useMemo(
    () => engineAvailableCommands.map((command) => ({ ...command })),
    [engineAvailableCommands]
  );
  const availableSkills = useStableProviderSkillOptions(
    useMemo(
      () => providerSkillsFromComposerOptions(input.providerComposerOptions),
      [input.providerComposerOptions]
    )
  );
  const conversationModels = useMemo(
    () =>
      projectionConversation
        ? buildAgentGUIConversationModels({
            timelineItems: input.activeTimelineItems,
            conversation: projectionConversation,
            workspaceRoot: input.workspacePath,
            avoidGroupingEdits: input.avoidGroupingEdits
          })
        : { conversation: null, detail: null },
    [
      input.activeTimelineItems,
      input.avoidGroupingEdits,
      input.workspacePath,
      projectionConversation
    ]
  );
  const conversationDetail = useStableConversationDetail(
    conversationModels.detail
  );
  const conversation = useMemo<AgentConversationVM | null>(() => {
    if (!conversationModels.conversation) return null;
    if (
      conversationDetail &&
      (conversationModels.conversation.sourceDetail !== conversationDetail ||
        conversationModels.conversation.activity !==
          conversationDetail.activity)
    ) {
      return {
        ...conversationModels.conversation,
        activity: conversationDetail.activity,
        sourceDetail: conversationDetail
      };
    }
    return conversationModels.conversation;
  }, [conversationDetail, conversationModels.conversation]);

  const diagnosticKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!input.activeConversationId || !conversation) {
      diagnosticKeyRef.current = null;
      return;
    }
    const firstVersion = minFiniteMessageVersion(input.activeMessages);
    const lastVersion = maxFiniteMessageVersion(input.activeMessages);
    const diagnosticKey = [
      input.activeConversationId,
      input.activeMessages.length,
      input.activeTimelineItems.length,
      conversation.sourceDetail.turns.length,
      conversation.rows.length,
      firstVersion ?? "",
      lastVersion ?? "",
      input.activeSessionView?.hasOlderMessages ? "1" : "0",
      input.activeSessionView?.isLoadingOlderMessages ? "1" : "0"
    ].join(":");
    if (diagnosticKeyRef.current === diagnosticKey) return;
    diagnosticKeyRef.current = diagnosticKey;
    reportAgentGUIMessagePageDiagnostic({
      agentSessionId: input.activeConversationId,
      details: {
        detailMessageCount: input.activeSessionView?.olderMessageCount ?? 0,
        hasOlderMessages: input.activeSessionView?.hasOlderMessages ?? false,
        isLoadingOlderMessages:
          input.activeSessionView?.isLoadingOlderMessages ?? false,
        oldestLoadedVersion:
          input.activeSessionView?.oldestLoadedVersion ?? null,
        rowCount: conversation.rows.length,
        timelineItemCount: input.activeTimelineItems.length,
        turnCount: conversation.sourceDetail.turns.length
      },
      event: "agent.gui.conversation.projection.resolved",
      level: "debug",
      messages: input.activeMessages,
      runtime: input.agentActivityRuntime,
      workspaceId: input.workspaceId
    });
  }, [
    input.activeConversationId,
    input.activeMessages,
    input.activeSessionView,
    input.activeTimelineItems,
    input.agentActivityRuntime,
    input.workspaceId,
    conversation
  ]);

  const activeLiveState =
    input.activeConversationLiveState === "inactive" && activeCanonicalLiveTurn
      ? "active"
      : input.activeConversationLiveState;
  const activationError = input.errorFor(input.activeConversationId);
  const activationErrorCode = input.codeFor(input.activeConversationId);
  const hasProviderSessionNotFoundError =
    isNonRetryableResumeErrorCode(activationErrorCode);
  const rawPendingApproval = useMemo(() => {
    const interaction =
      [...input.activePendingInteractions]
        .reverse()
        .find((candidate) => candidate.kind === "approval") ?? null;
    return (
      interactiveApprovalFromInteraction(interaction) ??
      approvalRequestFromConversation(conversation)
    );
  }, [input.activePendingInteractions, conversation]);
  const rawPendingInteractivePrompt =
    useMemo<AgentGUIInteractivePrompt | null>(() => {
      const interaction =
        [...input.activePendingInteractions]
          .reverse()
          .find((candidate) => candidate.kind !== "approval") ?? null;
      return (
        interactivePromptFromInteraction(interaction) ??
        interactivePromptFromConversation(conversation)
      );
    }, [input.activePendingInteractions, conversation]);
  const queuedPrompts: AgentGUIQueuedPromptVM[] = input.activeConversationId
    ? input.activeQueuedPrompts.map((prompt) => ({
        id: prompt.id,
        content: [...prompt.content] as AgentPromptContentBlock[],
        ...(prompt.displayPrompt
          ? { displayPrompt: prompt.displayPrompt }
          : {}),
        createdAtUnixMs: prompt.createdAtUnixMs
      }))
    : [];

  return {
    activeLiveState,
    activationError,
    activationErrorCode,
    availableCommands,
    availableSkills,
    conversation,
    conversationDetail,
    draftContent,
    draftPrompt: draftContent.prompt,
    drainingQueuedPromptId:
      input.activeQueuedPromptInFlight?.kind === "send"
        ? input.activeQueuedPromptInFlight.promptId
        : null,
    effectiveDetailError:
      input.detailError ??
      (input.activeConversationId !== null ? input.activeEngineError : null),
    hasProviderSessionNotFoundError,
    isCancelPending: input.activeCancelStatus === "awaitingTurn",
    isInterrupting: input.activeCancelStatus === "requested",
    pendingApproval: hasProviderSessionNotFoundError
      ? null
      : rawPendingApproval,
    queuedPrompts,
    serverInteractivePrompt: hasProviderSessionNotFoundError
      ? null
      : rawPendingInteractivePrompt
  };
}
