import {
  selectPlanDecisionForTurn,
  selectPlanTurnDismissed,
  type AgentActivityDisplayStatus,
  type AgentActivityMessage,
  type AgentActivityTurn,
  type CanonicalAgentSession,
  type PendingActivationIntentRecord,
  type SessionRuntimeAvailability,
  type AgentSessionEngine,
  selectEngineSessionRuntimeAvailability
} from "@tutti-os/agent-activity-core";
import { useEffect, useMemo } from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { translate } from "../../../i18n/index";
import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type { AgentApprovalItemVM } from "../../../shared/agentConversation/contracts/agentApprovalItemVM";
import {
  latestPlanTurnId,
  planImplementationPromptFromPlanTurn
} from "../../../shared/agentConversation/planImplementationPresentation";
import type { AgentSessionState } from "../../../shared/agentSessionTypes";
import type { AppErrorCode } from "../../../shared/contracts/dto";
import { useEngineSelector } from "../../../shared/engine/useEngineSelector";
import type {
  AgentGUIConversationSummary,
  AgentGUIInteractivePrompt
} from "../model/agentGuiConversationModel";
import type {
  AgentGUIOptimisticGoalControl,
  AgentGUISessionChrome
} from "../model/agentGuiNodeTypes";
import { composerSettingsSupportFromOptions } from "../model/composerSettingsSupport";
import {
  agentActivityDisplayStatusBusy,
  conversationBusyStatus
} from "./agentGuiController.draftMessageHelpers";
import { unresolvedOptimisticGoalControl } from "./agentGuiOptimisticGoal";
import { isNonRetryableResumeErrorCode } from "./agentGuiController.errors";
import { projectAgentGUIMessagesToTimelineItems } from "./agentGuiController.promptHelpers";
import { promptRequestId } from "./agentGuiController.diagnostics";
import { reportAgentGUIRenderStateDiagnostic } from "./agentGuiController.reporting";
import { AgentGUITransportAvailabilityController } from "./AgentGUITransportAvailabilityController";

interface CurrentValue<T> {
  current: T;
}

interface UseAgentGUISessionPresentationInput {
  activeConversation: AgentGUIConversationSummary | null;
  activeConversationId: string | null;
  activeEngineActiveTurn: AgentActivityTurn | null;
  activeEngineAvailability: "available" | "blocked" | "missing";
  activeEngineHasPendingInteractions: boolean;
  activeEngineLatestTurn: AgentActivityTurn | null;
  activeEngineRuntimeAvailability: SessionRuntimeAvailability | null;
  activeEngineSession: CanonicalAgentSession | null;
  activeLatestPendingSubmitTurnId: string | null;
  activeLiveState: "inactive" | "activating" | "active" | "failed";
  activeMessages: readonly AgentActivityMessage[];
  activePendingActivation: PendingActivationIntentRecord | null;
  activeSessionState: AgentSessionState | null;
  activeTimelineItems: ReturnType<
    typeof projectAgentGUIMessagesToTimelineItems
  >;
  activationError: string | null;
  activationErrorCode: AppErrorCode | null;
  activationState: "inactive" | "activating" | "active" | "failed" | null;
  activityDisplayStatus: AgentActivityDisplayStatus | null;
  agentActivityRuntime: AgentActivityRuntime;
  composerSupport: ReturnType<typeof composerSettingsSupportFromOptions>;
  conversation: AgentConversationVM | null;
  isCreatingConversation: boolean;
  isInterrupting: boolean;
  isLoadingMessages: boolean;
  isRespondingToInteraction: boolean;
  isSubmitting: boolean;
  lastRenderStateDiagnosticKeyRef: CurrentValue<string | null>;
  pendingApproval: AgentApprovalItemVM | null;
  planImplementationTurnIdRef: CurrentValue<string | null>;
  optimisticGoalControl: AgentGUIOptimisticGoalControl | null;
  agentTargetsLoading: boolean;
  ownerDeviceLabel?: string | null;
  serverInteractivePrompt: AgentGUIInteractivePrompt | null;
  sessionEngine: AgentSessionEngine;
  workspaceId: string;
}

export function useAgentGUISessionPresentation(
  input: UseAgentGUISessionPresentationInput
) {
  const latestTimelinePlanTurnId = latestPlanTurnId(input.activeTimelineItems);
  const planImplementationTurnId =
    input.activeConversationId !== null &&
    input.composerSupport.planImplementation &&
    input.composerSupport.plan &&
    input.activeEngineLatestTurn?.phase === "settled" &&
    input.activeEngineLatestTurn.outcome === "completed" &&
    input.activeEngineLatestTurn.turnId === latestTimelinePlanTurnId
      ? latestTimelinePlanTurnId
      : null;
  const activePlanDecision = useEngineSelector(input.sessionEngine, (state) =>
    selectPlanDecisionForTurn(
      state,
      input.activeConversationId,
      planImplementationTurnId
    )
  );
  const isRespondingApproval =
    input.isRespondingToInteraction ||
    activePlanDecision?.status === "requested" ||
    activePlanDecision?.status === "unknown";
  const activePlanTurnDismissed = useEngineSelector(
    input.sessionEngine,
    (state) =>
      selectPlanTurnDismissed(
        state,
        input.activeConversationId,
        planImplementationTurnId
      )
  );
  input.planImplementationTurnIdRef.current = planImplementationTurnId;
  const planImplementationPrompt =
    planImplementationTurnId !== null &&
    input.activeConversationId !== null &&
    !activePlanTurnDismissed
      ? planImplementationPromptFromPlanTurn(
          planImplementationTurnId,
          input.activeConversation?.title ?? ""
        )
      : null;
  const pendingInteractivePrompt =
    input.serverInteractivePrompt ?? planImplementationPrompt;

  const activeHasPendingSubmittedTurn = Boolean(
    input.activeConversationId && input.activeLatestPendingSubmitTurnId
  );
  const activeSubmitBlocked = input.activeEngineAvailability === "blocked";
  const sessionRuntimeBlocked =
    input.activeEngineRuntimeAvailability?.state === "blocked";
  const transportAvailabilityController = useMemo(
    () =>
      new AgentGUITransportAvailabilityController({
        source: {
          getAvailability: () =>
            selectEngineSessionRuntimeAvailability(
              input.sessionEngine.getSnapshot(),
              input.activeConversationId
            ),
          subscribe: input.sessionEngine.subscribe
        }
      }),
    [input.activeConversationId, input.sessionEngine]
  );
  const visibleTransportAvailability = useEngineSelector(
    transportAvailabilityController,
    identityAvailability,
    Object.is
  );
  const activeConversationBusy = input.activeEngineSession
    ? input.activeEngineAvailability === "blocked"
    : agentActivityDisplayStatusBusy(input.activityDisplayStatus) ||
      conversationBusyStatus(input.activeConversation?.status ?? null) ||
      activeHasPendingSubmittedTurn ||
      activeSubmitBlocked;
  const activeSessionResumable =
    input.activeEngineSession?.resumable ??
    input.activeConversation?.resumable ??
    input.activeSessionState?.resumable;
  const activeConversationRequiresResume =
    input.activeConversationId !== null && input.activationState !== "active";
  const activeConversationResumeUnavailable =
    activeConversationRequiresResume && activeSessionResumable === false;
  const sessionChromeRawState = useMemo<
    AgentGUISessionChrome["rawState"]
  >(() => {
    const optimisticGoalControl = unresolvedOptimisticGoalControl(
      input.optimisticGoalControl,
      input.activeConversationId,
      input.activeEngineSession
    );
    const agentSessionId =
      input.activeEngineSession?.agentSessionId ??
      optimisticGoalControl?.agentSessionId;
    if (!agentSessionId) {
      return null;
    }
    return {
      agentSessionId,
      goal: optimisticGoalControl
        ? optimisticGoalControl.goal
        : (input.activeEngineSession?.goal ?? null),
      goalIsOptimistic: optimisticGoalControl !== null
    };
  }, [
    input.activeConversationId,
    input.activeEngineSession?.agentSessionId,
    input.activeEngineSession?.goal,
    input.optimisticGoalControl
  ]);
  const sessionChrome = useMemo<AgentGUISessionChrome>(() => {
    if (visibleTransportAvailability?.state === "blocked") {
      const device =
        input.ownerDeviceLabel?.trim() ||
        translate("agentHost.agentGui.sharedDeviceLabel");
      const reconnecting =
        visibleTransportAvailability.reason === "transport_reconnecting";
      return {
        auth: null,
        approval: null,
        recovery: {
          kind: reconnecting ? "transport-connecting" : "transport-unavailable",
          message: translate(
            reconnecting
              ? "agentHost.agentGui.runtimeConnecting"
              : input.activeEngineActiveTurn !== null
                ? "agentHost.agentGui.runtimeUnavailableActive"
                : "agentHost.agentGui.runtimeUnavailable",
            { device }
          ),
          canRetry: false
        },
        rawState: sessionChromeRawState
      };
    }
    const normalizedError = input.activationError?.trim() ?? "";
    const authState = input.activeSessionState?.authState?.trim() ?? "";
    const providerSessionMissing = isNonRetryableResumeErrorCode(
      input.activationErrorCode
    );
    const isAuthError =
      !providerSessionMissing &&
      (authState !== "" ||
        (normalizedError !== "" &&
          /auth|sign in|log in|login|unauthorized|authenticated/i.test(
            normalizedError
          )));
    const isResumeNotLocalRecovery =
      providerSessionMissing || activeConversationResumeUnavailable;
    const recoveryMessage = isResumeNotLocalRecovery
      ? translate(
          input.activeConversation?.isImported === true
            ? "messages.agentImportedSessionResumeUnavailable"
            : "messages.agentResumeSessionNotLocal"
        )
      : normalizedError;
    return {
      auth: providerSessionMissing
        ? null
        : authState !== ""
          ? { message: authState }
          : isAuthError
            ? { message: normalizedError }
            : null,
      approval: input.pendingApproval,
      recovery:
        input.activeLiveState === "activating" &&
        input.activePendingActivation?.mode !== "new"
          ? {
              kind: "activating",
              message: translate("messages.agentSessionReconnecting")
            }
          : !isAuthError && recoveryMessage
            ? isResumeNotLocalRecovery
              ? {
                  kind: "resume-unavailable",
                  message: recoveryMessage,
                  followupAction: "continue-in-new-conversation" as const
                }
              : {
                  kind: "failed",
                  message: recoveryMessage,
                  canRetry: !providerSessionMissing
                }
            : null,
      rawState: sessionChromeRawState
    };
  }, [
    activeConversationResumeUnavailable,
    input.activeConversation,
    input.activationError,
    input.activationErrorCode,
    input.activeConversationId,
    input.activeEngineActiveTurn,
    input.activeLiveState,
    input.activeSessionState,
    input.activePendingActivation?.mode,
    input.pendingApproval,
    input.ownerDeviceLabel,
    visibleTransportAvailability,
    sessionChromeRawState
  ]);
  const canSubmit =
    !input.agentTargetsLoading &&
    input.activeLiveState !== "activating" &&
    input.activeLiveState !== "failed" &&
    !activeConversationResumeUnavailable &&
    input.pendingApproval === null &&
    pendingInteractivePrompt === null &&
    sessionChrome.auth === null &&
    !activeConversationBusy &&
    !input.isCreatingConversation &&
    !input.isSubmitting &&
    !input.isInterrupting;
  const canQueueWhileBusy =
    input.activeConversationId !== null &&
    !sessionRuntimeBlocked &&
    (activeConversationBusy ||
      input.isSubmitting ||
      input.activeEngineHasPendingInteractions);
  const hasSentUserMessage = input.activeTimelineItems.some(
    (item) => item.role === "user"
  );

  useEffect(() => {
    const diagnosticKey = [
      input.activeConversationId ?? "",
      input.activeConversation?.status ?? "",
      input.activityDisplayStatus ?? "",
      input.activeLiveState,
      input.activeEngineActiveTurn?.phase ??
        input.activeEngineLatestTurn?.phase ??
        "",
      input.activeEngineActiveTurn?.outcome ??
        input.activeEngineLatestTurn?.outcome ??
        "",
      input.activeEngineActiveTurn?.turnId ?? "",
      input.activeEngineAvailability,
      activeConversationBusy ? "busy" : "ready",
      activeHasPendingSubmittedTurn ? "pending-turn" : "no-pending-turn",
      activeSubmitBlocked ? "submit-blocked" : "submit-open",
      input.pendingApproval?.requestId ?? "",
      promptRequestId(pendingInteractivePrompt) ?? "",
      input.conversation?.activity.status ?? "",
      input.isCreatingConversation ? "creating" : "",
      input.isLoadingMessages ? "loading-messages" : "",
      input.isSubmitting ? "submitting" : "",
      canSubmit ? "can-submit" : "cannot-submit",
      canQueueWhileBusy ? "can-queue" : "cannot-queue"
    ].join(":");
    if (input.lastRenderStateDiagnosticKeyRef.current === diagnosticKey) return;
    input.lastRenderStateDiagnosticKeyRef.current = diagnosticKey;
    reportAgentGUIRenderStateDiagnostic({
      activeActivityDisplayStatus: input.activityDisplayStatus,
      activeConversation: input.activeConversation,
      activeConversationBusy,
      activeConversationId: input.activeConversationId,
      activeHasPendingSubmittedTurn,
      activeLiveState: input.activeLiveState,
      activeRuntimeSession: input.activeEngineSession,
      activeSessionState: input.activeSessionState,
      activeSubmitBlocked,
      canQueueWhileBusy,
      canSubmit,
      conversation: input.conversation,
      isCreatingConversation: input.isCreatingConversation,
      isLoadingMessages: input.isLoadingMessages,
      isSubmitting: input.isSubmitting,
      pendingApproval: input.pendingApproval,
      pendingInteractivePrompt,
      runtime: input.agentActivityRuntime,
      workspaceId: input.workspaceId
    });
  }, [
    activeConversationBusy,
    activeHasPendingSubmittedTurn,
    activeSubmitBlocked,
    canQueueWhileBusy,
    canSubmit,
    input.activeConversation,
    input.activeConversationId,
    input.activeEngineActiveTurn,
    input.activeEngineAvailability,
    input.activeEngineLatestTurn,
    input.activeEngineSession,
    input.activeLiveState,
    input.activeSessionState,
    input.activityDisplayStatus,
    input.agentActivityRuntime,
    input.conversation,
    input.isCreatingConversation,
    input.isLoadingMessages,
    input.isSubmitting,
    input.lastRenderStateDiagnosticKeyRef,
    input.pendingApproval,
    input.workspaceId,
    pendingInteractivePrompt
  ]);

  return {
    activeConversationBusy,
    canQueueWhileBusy,
    canSubmit,
    hasSentUserMessage,
    isRespondingApproval,
    pendingInteractivePrompt,
    sessionRuntimeBlocked,
    sessionChrome
  };
}

function identityAvailability(
  availability: SessionRuntimeAvailability | null
): SessionRuntimeAvailability | null {
  return availability;
}
