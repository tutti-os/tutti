import {
  selectEngineCancelState,
  selectEngineHasVisibleQueuedSubmit,
  selectLatestPendingSubmitForSession,
  type AgentActivityGoalControlAction,
  type AgentActivityInteraction,
  type AgentActivityTurn,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect } from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { translate } from "../../../i18n/index";
import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
import type { AgentGUINodeData } from "../../../types";
import {
  agentPromptContentDisplayText,
  agentPromptContentHasImage,
  emptyAgentComposerDraft,
  normalizeAgentPromptContentBlocks,
  textPromptContent
} from "../model/agentComposerDraft";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import {
  PLAN_IMPLEMENTATION_ACTION_FEEDBACK,
  PLAN_IMPLEMENTATION_ACTION_IMPLEMENT,
  PLAN_IMPLEMENTATION_ACTION_SKIP
} from "../../../shared/agentConversation/planImplementationPresentation";
import {
  GOAL_CLEAR_PROMPT,
  shouldClearSubmittedDraft,
  toRuntimeSendContent
} from "./agentGuiController.draftMessageHelpers";
import {
  AGENT_RESUME_SESSION_NOT_LOCAL_ERROR,
  buildProviderSessionNotFoundActivationError,
  buildResumeSessionNotLocalActivationError,
  getAgentGUIErrorMessage,
  isNonRetryableResumeErrorCode
} from "./agentGuiController.errors";
import { createAgentGUIConversationId } from "./agentGuiController.promptHelpers";
import {
  agentSubmitTraceDiagnostics,
  createAgentSubmitTraceState,
  reportAgentGUISubmitRecoveredActiveConversation,
  reportAgentGUISubmitWithoutActiveConversation,
  reportAgentSubmitTraceDiagnostic,
  scheduleAgentSubmitTracePaint
} from "./agentGuiController.reporting";
import { nodeDefaultDraftKey } from "./agentGuiController.composerHelpers";
import type { AgentGUIComposerTargetData } from "./agentGuiController.composerPresentation";
import {
  resolveConversationSummaryById,
  type ConversationIntent
} from "./useAgentConversationSelection";
import type { useAgentGUIActivation } from "./useAgentGUIActivation";

interface UseAgentGUISubmitInteractionActionsInput {
  activation: ReturnType<typeof useAgentGUIActivation>;
  activeConversationIdRef: RefObject<string | null>;
  activeEngineActiveTurn: AgentActivityTurn | null;
  activeEnginePendingInteractions: readonly AgentActivityInteraction[];
  activeLatestPendingSubmit: ReturnType<
    typeof selectLatestPendingSubmitForSession
  >;
  agentActivityRuntime: AgentActivityRuntime;
  conversationListQuery: unknown | null;
  conversationsRef: RefObject<AgentGUIConversationSummary[]>;
  dataRef: RefObject<AgentGUINodeData>;
  draftBySessionIdRef: RefObject<Record<string, AgentComposerDraft>>;
  executePromptRef: RefObject<
    (
      agentSessionId: string,
      content: AgentPromptContentBlock[],
      displayPrompt?: string,
      options?: { guidance?: boolean; immediate?: boolean }
    ) => void
  >;
  isComposerHomeRef: RefObject<boolean>;
  isCurrentConversation(agentSessionId: string): boolean;
  isRespondingToInteraction: boolean;
  isSessionMarkedNonResumable(agentSessionId: string): boolean;
  persistActiveConversation(agentSessionId: string | null): void;
  planActionsRef: RefObject<{
    implement(): void;
    feedback(value: string): void;
    skip(): void;
  }>;
  previewMode: boolean;
  promptImagesSupported: boolean;
  selectedComposerTargetDataRef: RefObject<AgentGUIComposerTargetData>;
  sessionEngine: AgentSessionEngine;
  setActiveConversationId: Dispatch<SetStateAction<string | null>>;
  setDetailError: Dispatch<SetStateAction<string | null>>;
  setDraftBySessionId: Dispatch<
    SetStateAction<Record<string, AgentComposerDraft>>
  >;
  setIntent: Dispatch<SetStateAction<ConversationIntent>>;
  startConversation(
    content: AgentPromptContentBlock[],
    displayPrompt?: string
  ): void;
  submitPromptRef: RefObject<
    (content: AgentPromptContentBlock[], displayPrompt?: string) => void
  >;
  transientConversation: AgentGUIConversationSummary | null;
  workspaceId: string;
}

export function useAgentGUISubmitInteractionActions(
  input: UseAgentGUISubmitInteractionActionsInput
) {
  const {
    activation,
    activeConversationIdRef,
    activeEngineActiveTurn,
    activeEnginePendingInteractions,
    activeLatestPendingSubmit,
    agentActivityRuntime,
    conversationListQuery,
    conversationsRef,
    dataRef,
    draftBySessionIdRef,
    executePromptRef,
    isComposerHomeRef,
    isCurrentConversation,
    isRespondingToInteraction,
    isSessionMarkedNonResumable,
    persistActiveConversation,
    planActionsRef,
    previewMode,
    promptImagesSupported,
    selectedComposerTargetDataRef,
    sessionEngine,
    setActiveConversationId,
    setDetailError,
    setDraftBySessionId,
    setIntent,
    startConversation,
    submitPromptRef,
    transientConversation,
    workspaceId
  } = input;
  const retryActivation = useCallback(() => {
    const agentSessionId = activeConversationIdRef.current;
    if (!agentSessionId) {
      return;
    }
    if (isSessionMarkedNonResumable(agentSessionId)) {
      return;
    }
    if (isNonRetryableResumeErrorCode(activation.codeFor(agentSessionId))) {
      return;
    }
    setDetailError(null);
    activation.activate({ mode: "existing", agentSessionId });
  }, [
    agentActivityRuntime,
    activation,
    isCurrentConversation,
    isSessionMarkedNonResumable,
    workspaceId
  ]);

  const executePrompt = useCallback(
    (
      agentSessionId: string,
      content: AgentPromptContentBlock[],
      displayPrompt?: string,
      options?: { guidance?: boolean; immediate?: boolean }
    ) => {
      const normalizedContent = normalizeAgentPromptContentBlocks(content);
      if (!agentSessionId || normalizedContent.length === 0) {
        return;
      }
      const targetIsActiveConversation =
        activeConversationIdRef.current === agentSessionId;
      // displayPrompt(如 bundle 折叠成单 chip)优先用于回显;否则回退到 content 派生文本。
      const submittedPromptText =
        displayPrompt && displayPrompt.trim()
          ? displayPrompt
          : agentPromptContentDisplayText(normalizedContent);
      const submittedAtUnixMs = Date.now();
      const submitTrace = createAgentSubmitTraceState({
        agentSessionId,
        content: normalizedContent,
        prompt: submittedPromptText,
        queued: false,
        startedAtUnixMs: submittedAtUnixMs
      });
      const targetConversation = resolveConversationSummaryById(
        conversationsRef.current,
        agentSessionId,
        transientConversation
      );
      reportAgentSubmitTraceDiagnostic({
        event: "submit.begin",
        runtime: agentActivityRuntime,
        trace: submitTrace,
        workspaceId,
        fields: {
          activeConversationId: activeConversationIdRef.current,
          conversationKnown: targetConversation !== null,
          conversationStatus: targetConversation?.status ?? null,
          isComposerHome: isComposerHomeRef.current,
          targetIsActiveConversation,
          targetMode: "existing"
        }
      });
      sessionEngine.dispatch({
        agentSessionId,
        clientSubmitId: submitTrace.clientSubmitId,
        content: normalizedContent,
        expiresAtUnixMs: submittedAtUnixMs + 120_000,
        ...(displayPrompt && displayPrompt.trim() ? { displayPrompt } : {}),
        ...(options?.guidance === true ? { guidance: true } : {}),
        submitDiagnostics: agentSubmitTraceDiagnostics(submitTrace),
        requestedAtUnixMs: submittedAtUnixMs,
        ...(options?.immediate === true ? { routing: "immediate" } : {}),
        runtimeContent: toRuntimeSendContent(normalizedContent),
        type: "submit/requested",
        workspaceId
      });
      const queued = Boolean(
        selectEngineHasVisibleQueuedSubmit(
          sessionEngine.getSnapshot(),
          agentSessionId,
          submitTrace.clientSubmitId
        )
      );
      submitTrace.queued = queued;
      if (queued) {
        setDraftBySessionId((current) => ({
          ...current,
          [agentSessionId]: emptyAgentComposerDraft()
        }));
        setDetailError(null);
      }
      if (!queued) {
        setDetailError(null);
      }
      reportAgentSubmitTraceDiagnostic({
        event: "send_input.requested",
        runtime: agentActivityRuntime,
        trace: submitTrace,
        workspaceId
      });
      scheduleAgentSubmitTracePaint({
        runtime: agentActivityRuntime,
        trace: submitTrace,
        workspaceId
      });
    },
    [agentActivityRuntime, sessionEngine, workspaceId]
  );

  useEffect(() => {
    executePromptRef.current = executePrompt;
  }, [executePrompt]);

  useEffect(() => {
    if (
      !activeLatestPendingSubmit ||
      (activeLatestPendingSubmit.status !== "accepted" &&
        activeLatestPendingSubmit.status !== "confirmed")
    ) {
      return;
    }
    const { agentSessionId, content } = activeLatestPendingSubmit;
    setDraftBySessionId((current) => {
      const currentDraft = current[agentSessionId];
      if (
        !shouldClearSubmittedDraft({
          currentDraft,
          submittedContent: content
        })
      ) {
        return current;
      }
      return {
        ...current,
        [agentSessionId]: emptyAgentComposerDraft()
      };
    });
  }, [activeLatestPendingSubmit]);

  const submitExistingPrompt = useCallback(
    (
      agentSessionId: string,
      normalizedContent: AgentPromptContentBlock[],
      displayPromptText?: string,
      options?: { bypassLocalQueue?: boolean; guidance?: boolean }
    ) => {
      if (isSessionMarkedNonResumable(agentSessionId)) {
        setDetailError(
          getAgentGUIErrorMessage(buildResumeSessionNotLocalActivationError())
        );
        return;
      }
      if (isNonRetryableResumeErrorCode(activation.codeFor(agentSessionId))) {
        setDetailError(
          getAgentGUIErrorMessage(
            activation.codeFor(agentSessionId) ===
              AGENT_RESUME_SESSION_NOT_LOCAL_ERROR
              ? buildResumeSessionNotLocalActivationError(
                  activation.errorFor(agentSessionId)
                )
              : buildProviderSessionNotFoundActivationError(
                  activation.errorFor(agentSessionId)
                )
          )
        );
        return;
      }
      executePrompt(agentSessionId, normalizedContent, displayPromptText, {
        guidance: options?.guidance === true,
        immediate: options?.bypassLocalQueue === true
      });
    },
    [activation, executePrompt, isSessionMarkedNonResumable, workspaceId]
  );

  // Goal control commands (/goal clear|paused|active) act on the running
  // thread immediately; the local prompt queue would defer them until the
  // turn ends, defeating their purpose (e.g. stopping a runaway goal).
  // Clearing sends a visible "/goal clear" prompt so the transcript shows
  // what was sent: executePrompt skips the local queue (and its resume
  // side effect), and mid-turn the daemon steers the command as a
  // thread-level exec instead of opening a competing turn. The remaining
  // controls (set/pause/resume) stay on the dedicated control API — no
  // prompt, no queue, no transcript entry — matching the codex desktop
  // goal bar.
  const goalControl = useCallback(
    (action: AgentActivityGoalControlAction, objective?: string) => {
      if (previewMode) {
        return;
      }
      const agentSessionId = activeConversationIdRef.current;
      if (!agentSessionId) {
        return;
      }
      setDetailError(null);
      if (action === "clear") {
        executePrompt(
          agentSessionId,
          textPromptContent(GOAL_CLEAR_PROMPT),
          GOAL_CLEAR_PROMPT,
          { immediate: true }
        );
        return;
      }
      void agentActivityRuntime
        .goalControl({
          workspaceId,
          agentSessionId,
          action,
          ...(objective !== undefined ? { objective } : {})
        })
        .catch((error: unknown) => {
          if (!isCurrentConversation(agentSessionId)) {
            return;
          }
          setDetailError(getAgentGUIErrorMessage(error));
        });
    },
    [
      agentActivityRuntime,
      executePrompt,
      isCurrentConversation,
      previewMode,
      setDetailError,
      workspaceId
    ]
  );

  const submitPrompt = useCallback(
    (content: AgentPromptContentBlock[], displayPrompt?: string) => {
      if (previewMode) {
        return;
      }
      const agentSessionId = activeConversationIdRef.current;
      const normalizedContent = normalizeAgentPromptContentBlocks(content);
      if (normalizedContent.length === 0) {
        return;
      }
      const displayPromptText =
        displayPrompt && displayPrompt.trim() ? displayPrompt : undefined;
      if (
        !promptImagesSupported &&
        agentPromptContentHasImage(normalizedContent)
      ) {
        setDetailError(translate("agentHost.agentGui.promptImagesUnsupported"));
        return;
      }
      if (!agentSessionId) {
        if (!isComposerHomeRef.current) {
          const promptLength =
            agentPromptContentDisplayText(normalizedContent).length;
          reportAgentGUISubmitWithoutActiveConversation({
            blockCount: normalizedContent.length,
            conversationCount: conversationsRef.current.length,
            conversationListQueryReady: conversationListQuery !== null,
            dataLastActiveAgentSessionId:
              dataRef.current.lastActiveAgentSessionId ?? null,
            isComposerHome: isComposerHomeRef.current,
            promptLength,
            provider: dataRef.current.provider ?? null,
            runtime: agentActivityRuntime,
            workspaceId
          });
          const recoveredAgentSessionId =
            dataRef.current.lastActiveAgentSessionId?.trim() ?? "";
          if (recoveredAgentSessionId) {
            reportAgentGUISubmitRecoveredActiveConversation({
              blockCount: normalizedContent.length,
              conversationCount: conversationsRef.current.length,
              conversationListQueryReady: conversationListQuery !== null,
              promptLength,
              provider: dataRef.current.provider ?? null,
              recoveredAgentSessionId,
              runtime: agentActivityRuntime,
              workspaceId
            });
            activeConversationIdRef.current = recoveredAgentSessionId;
            setActiveConversationId(recoveredAgentSessionId);
            setIntent({ tag: "active", id: recoveredAgentSessionId });
            persistActiveConversation(recoveredAgentSessionId);
            submitExistingPrompt(
              recoveredAgentSessionId,
              normalizedContent,
              displayPromptText
            );
            return;
          }
        }
        startConversation(normalizedContent, displayPromptText);
        return;
      }
      submitExistingPrompt(
        agentSessionId,
        normalizedContent,
        displayPromptText
      );
    },
    [
      agentActivityRuntime,
      conversationListQuery,
      previewMode,
      promptImagesSupported,
      persistActiveConversation,
      startConversation,
      submitExistingPrompt,
      workspaceId
    ]
  );

  useEffect(() => {
    submitPromptRef.current = submitPrompt;
  }, [submitPrompt]);

  const submitGuidancePrompt = useCallback(
    (content: AgentPromptContentBlock[], displayPrompt?: string) => {
      const agentSessionId = activeConversationIdRef.current;
      const normalizedContent = normalizeAgentPromptContentBlocks(content);
      if (!agentSessionId || normalizedContent.length === 0) {
        return;
      }
      if (
        !promptImagesSupported &&
        agentPromptContentHasImage(normalizedContent)
      ) {
        setDetailError(translate("agentHost.agentGui.promptImagesUnsupported"));
        return;
      }
      const activeTurnId = activeEngineActiveTurn?.turnId.trim() ?? "";
      if (activeTurnId === "") {
        return;
      }
      const displayPromptText =
        displayPrompt && displayPrompt.trim() ? displayPrompt : undefined;
      submitExistingPrompt(
        agentSessionId,
        normalizedContent,
        displayPromptText,
        { bypassLocalQueue: true, guidance: true }
      );
    },
    [
      activeEngineActiveTurn,
      promptImagesSupported,
      submitExistingPrompt,
      translate
    ]
  );

  const showPromptImagesUnsupported = useCallback(() => {
    setDetailError(translate("agentHost.agentGui.promptImagesUnsupported"));
  }, []);

  const submitInteractivePrompt = useCallback(
    (input: {
      requestId: string;
      action?: string;
      optionId?: string;
      payload?: Record<string, unknown>;
    }) => {
      // Plan-implementation actions are client-orchestrated; route them to the
      // plan decision handlers instead of submitInteractive.
      if (input.action === PLAN_IMPLEMENTATION_ACTION_IMPLEMENT) {
        planActionsRef.current.implement();
        return;
      }
      if (input.action === PLAN_IMPLEMENTATION_ACTION_FEEDBACK) {
        planActionsRef.current.feedback(
          typeof input.payload?.text === "string" ? input.payload.text : ""
        );
        return;
      }
      if (input.action === PLAN_IMPLEMENTATION_ACTION_SKIP) {
        planActionsRef.current.skip();
        return;
      }
      const agentSessionId = activeConversationIdRef.current;
      const normalizedRequestId = input.requestId.trim();
      const normalizedOptionId = input.optionId?.trim() ?? "";
      const turnId =
        activeEnginePendingInteractions.find(
          (interaction) => interaction.requestId === normalizedRequestId
        )?.turnId ?? "";
      if (
        !agentSessionId ||
        !normalizedRequestId ||
        !turnId ||
        isRespondingToInteraction
      ) {
        return;
      }
      setDetailError(null);
      sessionEngine.dispatch({
        ...(input.action?.trim() ? { action: input.action.trim() } : {}),
        agentSessionId,
        commandId: `interaction:${createAgentGUIConversationId()}`,
        ...(normalizedOptionId ? { optionId: normalizedOptionId } : {}),
        ...(input.payload ? { payload: { ...input.payload } } : {}),
        requestId: normalizedRequestId,
        turnId,
        timeoutMs: 30_000,
        type: "interaction/responseRequested",
        workspaceId
      });
    },
    [
      activeEnginePendingInteractions,
      isRespondingToInteraction,
      sessionEngine,
      workspaceId
    ]
  );

  const submitApprovalOption = useCallback(
    (requestId: string, optionId: string) => {
      void submitInteractivePrompt({ requestId, optionId });
    },
    [submitInteractivePrompt]
  );

  const interruptCurrentTurn = useCallback(
    (noRunningResponseMessage: string) => {
      const agentSessionId = activeConversationIdRef.current;
      const cancelStatus = agentSessionId
        ? selectEngineCancelState(sessionEngine.getSnapshot(), agentSessionId)
            ?.status
        : null;
      if (
        !agentSessionId ||
        cancelStatus === "requested" ||
        cancelStatus === "awaitingTurn"
      ) {
        return;
      }
      void noRunningResponseMessage;
      // A user stop means "stop everything": hold the queued prompts instead
      // of letting the drainer fire the next one the moment the session
      // becomes available. An explicit user send (submit or send-now on a
      // queued item) lifts the hold.
      sessionEngine.dispatch({
        agentSessionId,
        reason: "user_stop",
        type: "queue/suspended"
      });
      setDetailError(null);
      sessionEngine.dispatch({
        agentSessionId,
        awaitingTurnExpiresAtUnixMs: Date.now() + 30_000,
        commandId: createAgentGUIConversationId(),
        timeoutMs: 30_000,
        type: "session/cancelRequested"
      });
    },
    [sessionEngine]
  );

  const updateDraftContent = useCallback((draftContent: AgentComposerDraft) => {
    const agentSessionId = activeConversationIdRef.current;
    const targetData = selectedComposerTargetDataRef.current;
    const draftKey =
      agentSessionId ??
      nodeDefaultDraftKey(targetData.provider, targetData.agentTargetId);
    draftBySessionIdRef.current = {
      ...draftBySessionIdRef.current,
      [draftKey]: draftContent
    };
    setDraftBySessionId((current) => ({
      ...current,
      [draftKey]: draftContent
    }));
  }, []);

  return {
    goalControl,
    interruptCurrentTurn,
    retryActivation,
    showPromptImagesUnsupported,
    submitApprovalOption,
    submitGuidancePrompt,
    submitInteractivePrompt,
    submitPrompt,
    updateDraftContent
  };
}
