import {
  selectEngineCancelState,
  selectEngineHasVisibleQueuedSubmit,
  selectPendingSubmitsForSession,
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
  snapshotAgentComposerDraft
} from "../model/agentComposerDraft";
import type {
  AgentComposerDraft,
  AgentGUIOptimisticGoalControl,
  SubmittedDraftSnapshot
} from "../model/agentGuiNodeTypes";
import { resolveAgentComposerDraftScopeKey } from "../model/agentComposerDraftScope";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type { AgentComposerSubmitOptions } from "../composer/AgentComposer.types";
import {
  PLAN_IMPLEMENTATION_ACTION_FEEDBACK,
  PLAN_IMPLEMENTATION_ACTION_IMPLEMENT,
  PLAN_IMPLEMENTATION_ACTION_SKIP
} from "../../../shared/agentConversation/planImplementationPresentation";
import {
  clearSubmittedDraftIfUnchanged,
  deleteUnacceptedSubmittedDraftSnapshot,
  toRuntimeSendContent
} from "./agentGuiController.draftMessageHelpers";
import { clearSubmittedAgentGUIHomeDraft } from "./agentGuiController.homeDraftHelpers";
import { AgentGUIHomeDraftSettlementController } from "./AgentGUIHomeDraftSettlementController";
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
import { resolveAgentGUIInteractionTarget } from "./agentGuiController.interactionHelpers";
import {
  resolveConversationSummaryById,
  type ConversationIntent
} from "./useAgentConversationSelection";
import type { useAgentGUIActivation } from "./useAgentGUIActivation";
import type { AgentGUINewConversationActivationResult } from "./agentGuiNewConversationActivation.types";
import { useAgentGUIGoalControlActions } from "./useAgentGUIGoalControlActions";

interface UseAgentGUISubmitInteractionActionsInput {
  activation: ReturnType<typeof useAgentGUIActivation>;
  activeConversationIdRef: RefObject<string | null>;
  activeEngineActiveTurn: AgentActivityTurn | null;
  activeEnginePendingInteractions: readonly AgentActivityInteraction[];
  agentActivityRuntime: AgentActivityRuntime;
  conversationListQuery: unknown | null;
  conversationsRef: RefObject<AgentGUIConversationSummary[]>;
  dataRef: RefObject<AgentGUINodeData>;
  draftByScopeKeyRef: RefObject<Record<string, AgentComposerDraft>>;
  executePromptRef: RefObject<
    (
      agentSessionId: string,
      content: AgentPromptContentBlock[],
      displayPrompt?: string,
      options?: {
        immediate?: boolean;
        requiredSettingsPatch?: AgentComposerSubmitOptions["requiredSettingsPatch"];
        sendNow?: boolean;
        sourceScopeKey?: string;
        trackDraft?: boolean;
      }
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
  optimisticGoalControl: AgentGUIOptimisticGoalControl | null;
  sessionEngine: AgentSessionEngine;
  setActiveConversationId: Dispatch<SetStateAction<string | null>>;
  setDetailError: Dispatch<SetStateAction<string | null>>;
  setDraftByScopeKey: Dispatch<
    SetStateAction<Record<string, AgentComposerDraft>>
  >;
  setGoalClearNoticeSequence: Dispatch<SetStateAction<number>>;
  setIntent: Dispatch<SetStateAction<ConversationIntent>>;
  setOptimisticGoalControl: Dispatch<
    SetStateAction<AgentGUIOptimisticGoalControl | null>
  >;
  submittedDraftSnapshotsRef: RefObject<Record<string, SubmittedDraftSnapshot>>;
  startConversation(
    content: AgentPromptContentBlock[],
    displayPrompt?: string,
    options?: AgentComposerSubmitOptions,
    initialTurnExpected?: boolean,
    initialGoalControl?: {
      action: AgentActivityGoalControlAction;
      objective?: string;
    }
  ): AgentGUINewConversationActivationResult | null;
  submitPromptRef: RefObject<
    (
      content: AgentPromptContentBlock[],
      displayPrompt?: string,
      options?: AgentComposerSubmitOptions
    ) => void
  >;
  transientConversation: AgentGUIConversationSummary | null;
  workspaceId: string;
}

export function typedGoalControlFromComposer(
  content: AgentPromptContentBlock[],
  _displayPrompt?: string
): { action: AgentActivityGoalControlAction; objective?: string } | null {
  if (content.length !== 1 || content[0]?.type !== "text") {
    return null;
  }
  // Structured content owns command semantics. displayPrompt may collapse a
  // bundle into a chip, but it must neither hide nor manufacture a control.
  const prompt = (content[0].text ?? "").trim();
  const match = /^\/goal(?:\s+([\s\S]+))?$/iu.exec(prompt);
  const args = match?.[1]?.trim() ?? "";
  if (!match || !args) {
    return null;
  }
  switch (args.toLowerCase()) {
    case "clear":
    case "reset":
      return { action: "clear" };
    case "pause":
      return { action: "pause" };
    case "resume":
    case "active":
      return { action: "resume" };
    default:
      return { action: "set", objective: args };
  }
}
export function useAgentGUISubmitInteractionActions(
  input: UseAgentGUISubmitInteractionActionsInput
) {
  const {
    activation,
    activeConversationIdRef,
    activeEngineActiveTurn,
    activeEnginePendingInteractions,
    agentActivityRuntime,
    conversationListQuery,
    conversationsRef,
    dataRef,
    draftByScopeKeyRef,
    executePromptRef,
    isComposerHomeRef,
    isCurrentConversation,
    isRespondingToInteraction,
    isSessionMarkedNonResumable,
    persistActiveConversation,
    planActionsRef,
    previewMode,
    promptImagesSupported,
    optimisticGoalControl,
    sessionEngine,
    setActiveConversationId,
    setDetailError,
    setDraftByScopeKey,
    setGoalClearNoticeSequence,
    setIntent,
    setOptimisticGoalControl,
    submittedDraftSnapshotsRef,
    startConversation,
    submitPromptRef,
    transientConversation,
    workspaceId
  } = input;
  const { beginOptimisticGoalControl, goalControl } =
    useAgentGUIGoalControlActions({
      activeConversationIdRef,
      agentActivityRuntime,
      draftByScopeKeyRef,
      isCurrentConversation,
      optimisticGoalControl,
      previewMode,
      sessionEngine,
      setDetailError,
      setDraftByScopeKey,
      setGoalClearNoticeSequence,
      setOptimisticGoalControl,
      workspaceId
    });
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
      options?: {
        capabilityRefs?: AgentComposerSubmitOptions["capabilityRefs"];
        immediate?: boolean;
        requiredSettingsPatch?: AgentComposerSubmitOptions["requiredSettingsPatch"];
        sendNow?: boolean;
        sourceScopeKey?: string;
        trackDraft?: boolean;
      }
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
      if (options?.trackDraft === true) {
        const sourceScopeKey =
          options.sourceScopeKey ??
          resolveAgentComposerDraftScopeKey({ agentSessionId });
        const submittedDraft =
          draftByScopeKeyRef.current[sourceScopeKey] ??
          emptyAgentComposerDraft();
        submittedDraftSnapshotsRef.current[submitTrace.clientSubmitId] = {
          sourceScopeKey,
          content: snapshotAgentComposerDraft(submittedDraft),
          targetAgentSessionId: agentSessionId
        };
      }
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
        ...(options?.capabilityRefs?.length
          ? { capabilityRefs: options.capabilityRefs }
          : {}),
        clientSubmitId: submitTrace.clientSubmitId,
        content: normalizedContent,
        expiresAtUnixMs: submittedAtUnixMs + 120_000,
        ...(displayPrompt && displayPrompt.trim() ? { displayPrompt } : {}),
        submitDiagnostics: agentSubmitTraceDiagnostics(submitTrace),
        requestedAtUnixMs: submittedAtUnixMs,
        ...(options?.requiredSettingsPatch
          ? {
              requiredSettingsPatch: {
                ...options.requiredSettingsPatch
              }
            }
          : {}),
        ...(options?.immediate === true
          ? { routing: "immediate" as const }
          : options?.sendNow === true
            ? { routing: "send_now" as const }
            : {}),
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
      const accepted = selectPendingSubmitsForSession(
        sessionEngine.getSnapshot(),
        agentSessionId
      ).some((record) => record.clientSubmitId === submitTrace.clientSubmitId);
      submitTrace.queued = queued;
      setDetailError(null);
      // Clear the composer optimistically the instant the engine takes the
      // prompt — whether it was queued behind a busy turn or accepted straight
      // into an idle session. The snapshot is retained so
      // AgentGUIHomeDraftSettlementController can restore it if the send is
      // later rejected. A submit the engine never accepted is left untouched so
      // its text is not lost (deleteUnacceptedSubmittedDraftSnapshot cleans up).
      const submittedSnapshot =
        submittedDraftSnapshotsRef.current[submitTrace.clientSubmitId];
      if ((accepted || queued) && submittedSnapshot) {
        setDraftByScopeKey((current) => {
          const next = clearSubmittedDraftIfUnchanged({
            drafts: current,
            snapshot: submittedSnapshot
          });
          draftByScopeKeyRef.current = next;
          return next;
        });
      }
      deleteUnacceptedSubmittedDraftSnapshot({
        snapshots: submittedDraftSnapshotsRef.current,
        clientSubmitId: submitTrace.clientSubmitId,
        accepted,
        queued
      });
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
    [agentActivityRuntime, sessionEngine, setDraftByScopeKey, workspaceId]
  );

  useEffect(() => {
    executePromptRef.current = executePrompt;
  }, [executePrompt]);

  useEffect(() => {
    const controller = new AgentGUIHomeDraftSettlementController({
      applyDraftUpdate: (update) => {
        setDraftByScopeKey((current) => {
          const next = update(current);
          draftByScopeKeyRef.current = next;
          return next;
        });
      },
      engine: sessionEngine,
      snapshots: submittedDraftSnapshotsRef.current
    });
    return controller.attach();
  }, [
    draftByScopeKeyRef,
    sessionEngine,
    setDraftByScopeKey,
    submittedDraftSnapshotsRef
  ]);

  const submitExistingPrompt = useCallback(
    (
      agentSessionId: string,
      normalizedContent: AgentPromptContentBlock[],
      displayPromptText?: string,
      options?: {
        capabilityRefs?: AgentComposerSubmitOptions["capabilityRefs"];
        requiredSettingsPatch?: AgentComposerSubmitOptions["requiredSettingsPatch"];
        sendNow?: boolean;
        sourceScopeKey?: string;
        trackDraft?: boolean;
      }
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
        capabilityRefs: options?.capabilityRefs,
        requiredSettingsPatch: options?.requiredSettingsPatch,
        sendNow: options?.sendNow === true,
        sourceScopeKey: options?.sourceScopeKey,
        trackDraft: options?.trackDraft === true
      });
    },
    [activation, executePrompt, isSessionMarkedNonResumable, workspaceId]
  );

  const submitPrompt = useCallback(
    (
      content: AgentPromptContentBlock[],
      displayPrompt?: string,
      options?: AgentComposerSubmitOptions
    ) => {
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
      const typedGoal = typedGoalControlFromComposer(
        normalizedContent,
        displayPromptText
      );
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
            if (typedGoal) {
              goalControl(
                typedGoal.action,
                typedGoal.objective,
                resolveAgentComposerDraftScopeKey({})
              );
              return;
            }
            submitExistingPrompt(
              recoveredAgentSessionId,
              normalizedContent,
              displayPromptText,
              {
                capabilityRefs: options?.capabilityRefs,
                requiredSettingsPatch: options?.requiredSettingsPatch,
                sourceScopeKey: resolveAgentComposerDraftScopeKey({}),
                trackDraft: true
              }
            );
            return;
          }
        }
        const homeDraftKey = resolveAgentComposerDraftScopeKey({});
        const submittedHomeDraft = snapshotAgentComposerDraft(
          draftByScopeKeyRef.current[homeDraftKey] ?? emptyAgentComposerDraft()
        );
        const activationResult = startConversation(
          normalizedContent,
          displayPromptText,
          options,
          typedGoal ? false : undefined,
          typedGoal ?? undefined
        );
        if (activationResult) {
          if (typedGoal) {
            beginOptimisticGoalControl(
              activationResult.agentSessionId,
              typedGoal.action,
              typedGoal.objective,
              `goal-activation:${activationResult.requestId}`,
              true
            );
          }
          draftByScopeKeyRef.current = clearSubmittedAgentGUIHomeDraft({
            draftKey: homeDraftKey,
            drafts: draftByScopeKeyRef.current,
            submittedDraft: submittedHomeDraft
          });
          setDraftByScopeKey((current) =>
            clearSubmittedAgentGUIHomeDraft({
              draftKey: homeDraftKey,
              drafts: current,
              submittedDraft: submittedHomeDraft
            })
          );
        }
        return;
      }
      if (typedGoal) {
        goalControl(
          typedGoal.action,
          typedGoal.objective,
          resolveAgentComposerDraftScopeKey({ agentSessionId })
        );
        return;
      }
      submitExistingPrompt(
        agentSessionId,
        normalizedContent,
        displayPromptText,
        {
          capabilityRefs: options?.capabilityRefs,
          requiredSettingsPatch: options?.requiredSettingsPatch,
          trackDraft: true
        }
      );
    },
    [
      agentActivityRuntime,
      beginOptimisticGoalControl,
      conversationListQuery,
      previewMode,
      promptImagesSupported,
      goalControl,
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
    (
      content: AgentPromptContentBlock[],
      displayPrompt?: string,
      options?: AgentComposerSubmitOptions
    ) => {
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
        {
          capabilityRefs: options?.capabilityRefs,
          sendNow: true,
          trackDraft: true
        }
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
      const normalizedRequestId = input.requestId.trim();
      const normalizedOptionId = input.optionId?.trim() ?? "";
      const target = resolveAgentGUIInteractionTarget(
        activeEnginePendingInteractions,
        normalizedRequestId
      );
      const agentSessionId = target?.agentSessionId ?? "";
      const turnId = target?.turnId ?? "";
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
      setDetailError(null);
      sessionEngine.dispatch({
        agentSessionId,
        awaitingTurnExpiresAtUnixMs: Date.now() + 30_000,
        commandId: createAgentGUIConversationId(),
        timeoutMs: 30_000,
        type: "session/stopRequested",
        workspaceId
      });
    },
    [sessionEngine, workspaceId]
  );

  const updateDraftContent = useCallback(
    (draftContent: AgentComposerDraft, sourceScopeKey?: string) => {
      const agentSessionId = activeConversationIdRef.current;
      const draftKey =
        sourceScopeKey ??
        resolveAgentComposerDraftScopeKey({
          agentSessionId
        });
      draftByScopeKeyRef.current = {
        ...draftByScopeKeyRef.current,
        [draftKey]: draftContent
      };
      setDraftByScopeKey((current) => ({
        ...current,
        [draftKey]: draftContent
      }));
    },
    []
  );

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
