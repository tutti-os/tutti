import {
  selectEngineCancelState,
  selectEngineHasVisibleQueuedSubmit,
  selectPendingSubmitsForSession,
  type AgentActivityGoalControlAction
} from "@tutti-os/agent-activity-core";
import { useCallback, useEffect } from "react";
import { translate } from "../../../i18n/index";
import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
import {
  agentPromptContentDisplayText,
  agentPromptContentHasImage,
  emptyAgentComposerDraft,
  normalizeAgentPromptContentBlocks,
  snapshotAgentComposerDraft,
  textPromptContent
} from "../model/agentComposerDraft";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";
import type { AgentComposerSubmitOptions } from "../composer/AgentComposer.types";
import { resolveAgentComposerDraftScopeKey } from "../model/agentComposerDraftScope";
import { composerModelPlanRequiresNewSession } from "../model/composerAggregatedModelPlans";
import {
  PLAN_IMPLEMENTATION_ACTION_CREATE_ISSUE,
  PLAN_IMPLEMENTATION_ACTION_FEEDBACK,
  PLAN_IMPLEMENTATION_ACTION_IMPLEMENT,
  PLAN_IMPLEMENTATION_ACTION_ORCHESTRATE,
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
import { resolveConversationSummaryById } from "./useAgentConversationSelection";
import {
  planIssueCreationOptionsFromPayload,
  planIssueDraftFromPayload,
  type UseAgentGUISubmitInteractionActionsInput
} from "./agentGuiSubmitInteractionContracts";

const ULTRA_PLAN_RUNTIME_INSTRUCTION = `You are in Tutti Ultra Plan mode. Do not implement the requested work or decompose it into Issue tasks in this turn. Produce only a thorough, reviewable plan narrative. The host will ask the user to confirm Issue-level reasoning, orchestration, and token-budget settings before a later Planning Agent turn creates the task graph.

End the response with the exact HTML comment <!-- tutti-ultra-plan-v1 -->. Do not emit a tutti-issue-plan-v1 block yet. Never invent credentials, owner ids, provider account metadata, prices, Agents, Model Plans, or models.`;

export function useAgentGUISubmitInteractionActions(
  input: UseAgentGUISubmitInteractionActionsInput
) {
  const {
    activation,
    activeCanonicalComposerSettings,
    activeConversationIdRef,
    activeEngineActiveTurn,
    activeEnginePendingInteractions,
    agentActivityRuntime,
    conversationListQuery,
    conversationsRef,
    dataRef,
    draftByScopeKeyRef,
    draftSettingsBySessionIdRef,
    executePromptRef,
    isComposerHomeRef,
    isCurrentConversation,
    isRespondingToInteraction,
    isSessionMarkedNonResumable,
    persistActiveConversation,
    planActionsRef,
    previewMode,
    promptImagesSupported,
    sessionEngine,
    setActiveConversationId,
    setDetailError,
    setDraftByScopeKey,
    setGoalClearNoticeSequence,
    setDraftSettingsBySessionId,
    setIntent,
    submittedDraftSnapshotsRef,
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
      options?: {
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
        requiredSettingsPatch: options?.requiredSettingsPatch,
        sendNow: options?.sendNow === true,
        sourceScopeKey: options?.sourceScopeKey,
        trackDraft: options?.trackDraft === true
      });
    },
    [activation, executePrompt, isSessionMarkedNonResumable, workspaceId]
  );

  // Goal controls act on the thread immediately through the dedicated runtime
  // API. They must not enter the normal prompt pipeline: doing so creates a
  // pending submit and pseudo turn that can hide the active turn's stop control
  // and attach its processing indicator to a control message.
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
      void agentActivityRuntime
        .goalControl({
          workspaceId,
          agentSessionId,
          action,
          ...(objective !== undefined ? { objective } : {})
        })
        .then(() => {
          if (action !== "clear" || !isCurrentConversation(agentSessionId)) {
            return;
          }
          setGoalClearNoticeSequence((current) => current + 1);
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
      isCurrentConversation,
      previewMode,
      setDetailError,
      setGoalClearNoticeSequence,
      workspaceId
    ]
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
      if (
        !promptImagesSupported &&
        agentPromptContentHasImage(normalizedContent)
      ) {
        setDetailError(translate("agentHost.agentGui.promptImagesUnsupported"));
        return;
      }
      const ultraPlan = options?.executionMode === "ultra_plan";
      const effectiveContent = ultraPlan
        ? [
            ...textPromptContent(ULTRA_PLAN_RUNTIME_INSTRUCTION),
            ...normalizedContent
          ]
        : normalizedContent;
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
              effectiveContent,
              displayPromptText ??
                (ultraPlan
                  ? agentPromptContentDisplayText(normalizedContent)
                  : undefined),
              {
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
          effectiveContent,
          displayPromptText ??
            (ultraPlan
              ? agentPromptContentDisplayText(normalizedContent)
              : undefined),
          options
        );
        if (activationResult) {
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
      const stagedSettings =
        draftSettingsBySessionIdRef.current[agentSessionId] ?? null;
      if (
        stagedSettings &&
        composerModelPlanRequiresNewSession({
          activeSettings: activeCanonicalComposerSettings,
          draftSettings: stagedSettings
        })
      ) {
        const sourceScopeKey = resolveAgentComposerDraftScopeKey({
          agentSessionId
        });
        const submittedSourceDraft = snapshotAgentComposerDraft(
          draftByScopeKeyRef.current[sourceScopeKey] ??
            emptyAgentComposerDraft()
        );
        const sourceSessionUri = `mention://agent-session/${encodeURIComponent(agentSessionId)}?workspaceId=${encodeURIComponent(workspaceId)}`;
        const crossPlanContent = [
          ...textPromptContent(
            translate(
              "agentHost.agentGui.composerModelSwitchContextInstruction",
              { sessionUri: sourceSessionUri }
            )
          ),
          ...effectiveContent
        ];
        const activationResult = startConversation(
          crossPlanContent,
          displayPromptText ?? agentPromptContentDisplayText(normalizedContent),
          options,
          stagedSettings,
          sourceScopeKey
        );
        if (activationResult) {
          const nextSettingsDrafts = {
            ...draftSettingsBySessionIdRef.current
          };
          delete nextSettingsDrafts[agentSessionId];
          draftSettingsBySessionIdRef.current = nextSettingsDrafts;
          setDraftSettingsBySessionId(nextSettingsDrafts);
          draftByScopeKeyRef.current = clearSubmittedAgentGUIHomeDraft({
            draftKey: sourceScopeKey,
            drafts: draftByScopeKeyRef.current,
            submittedDraft: submittedSourceDraft
          });
          setDraftByScopeKey((current) =>
            clearSubmittedAgentGUIHomeDraft({
              draftKey: sourceScopeKey,
              drafts: current,
              submittedDraft: submittedSourceDraft
            })
          );
        }
        return;
      }
      submitExistingPrompt(
        agentSessionId,
        effectiveContent,
        displayPromptText ??
          (ultraPlan
            ? agentPromptContentDisplayText(normalizedContent)
            : undefined),
        {
          requiredSettingsPatch: options?.requiredSettingsPatch,
          trackDraft: true
        }
      );
    },
    [
      agentActivityRuntime,
      conversationListQuery,
      previewMode,
      promptImagesSupported,
      activeCanonicalComposerSettings,
      setDraftSettingsBySessionId,
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
        { sendNow: true }
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
      if (input.action === PLAN_IMPLEMENTATION_ACTION_CREATE_ISSUE) {
        planActionsRef.current.createIssue(
          planIssueCreationOptionsFromPayload(input.payload)
        );
        return;
      }
      if (input.action === PLAN_IMPLEMENTATION_ACTION_IMPLEMENT) {
        planActionsRef.current.implement();
        return;
      }
      if (input.action === PLAN_IMPLEMENTATION_ACTION_ORCHESTRATE) {
        const draft = planIssueDraftFromPayload(input.payload);
        const displayPrompt =
          typeof input.payload?.displayPrompt === "string"
            ? input.payload.displayPrompt.trim()
            : "";
        if (draft && displayPrompt) {
          planActionsRef.current.orchestrate(draft, displayPrompt);
        }
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
