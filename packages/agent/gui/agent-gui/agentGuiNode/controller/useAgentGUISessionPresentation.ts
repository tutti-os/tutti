import {
  selectPlanDecisionForTurn,
  selectPlanTurnDismissed,
  type AgentActivityDisplayStatus,
  type AgentActivityMessage,
  type AgentActivityTurn,
  type CanonicalAgentSession,
  type PendingActivationIntentRecord,
  type SessionGoalControlPresentation,
  type SessionRuntimeAvailability,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import { useEffect, useMemo } from "react";
import type { AgentGUIRuntime } from "../../../agentActivityRuntime";
import { translate } from "../../../i18n/index";
import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type { AgentApprovalItemVM } from "../../../shared/agentConversation/contracts/agentApprovalItemVM";
import {
  latestPlanTurnId,
  planImplementationPromptFromPlanTurn
} from "../../../shared/agentConversation/planImplementationPresentation";
import type { AgentSessionState } from "../../../shared/agentSessionTypes";
import type { AppErrorCode } from "../../../shared/contracts/dto";
import type {
  AgentGUIObservationGapSource,
  AgentGUITargetConnectionSource
} from "../../../types";
import { useEngineSelector } from "../../../shared/engine/useEngineSelector";
import type {
  AgentGUIConversationSummary,
  AgentGUIInteractivePrompt
} from "../model/agentGuiConversationModel";
import {
  isDifferentKnownConversationOwner,
  resolveAgentGUIComposerGate
} from "../model/agentGuiComposerGate";
import type { AgentGUISessionChrome } from "../model/agentGuiNodeTypes";
import { composerSettingsSupportFromOptions } from "../model/composerSettingsSupport";
import {
  agentActivityDisplayStatusBusy,
  conversationBusyStatus
} from "./agentGuiController.draftMessageHelpers";
import { isNonRetryableResumeErrorCode } from "./agentGuiController.errors";
import { projectAgentGUIMessagesToTimelineItems } from "./agentGuiController.promptHelpers";
import { promptRequestId } from "./agentGuiController.diagnostics";
import { reportAgentGUIRenderStateDiagnostic } from "./agentGuiController.reporting";
import { useAgentGUITargetConnectionState } from "./useAgentGUITargetConnectionState";
import { useAgentObservationGap } from "../../../shared/agentConversation/AgentObservationGapContext";

interface CurrentValue<T> {
  current: T;
}

export function resolveAgentGUISharingRevokedRecovery(input: {
  activeConversationId: string | null;
  selectedAgentTargetOwnerLabel: string | null;
  selectedAgentTargetUnavailable: boolean;
  selectedAgentTargetUnavailableReason: string | null;
  sessionRuntimeBlock: Extract<
    SessionRuntimeAvailability,
    { state: "blocked" }
  > | null;
}): AgentGUISessionChrome["recovery"] {
  const selectedTargetSharingRevoked =
    input.activeConversationId === null &&
    input.selectedAgentTargetUnavailable &&
    input.selectedAgentTargetUnavailableReason === "agent_sharing_revoked";
  if (
    input.sessionRuntimeBlock?.reason !== "agent_sharing_revoked" &&
    !selectedTargetSharingRevoked
  ) {
    return null;
  }
  return {
    kind: "agent-sharing-revoked",
    message: translate("agentHost.agentGui.agentSharingRevoked", {
      owner:
        (input.sessionRuntimeBlock?.reason === "agent_sharing_revoked"
          ? input.sessionRuntimeBlock.ownerLabel
          : null) ??
        input.selectedAgentTargetOwnerLabel ??
        translate("agentHost.agentGui.sharedDeviceLabel")
    }),
    canRetry: false
  };
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
  /** In-flight / waiting session settings update; blocks submit until settled. */
  activeEngineSettingsUpdate: {
    status: string;
  } | null;
  activeGoalControlPresentation: SessionGoalControlPresentation;
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
  agentActivityRuntime: AgentGUIRuntime;
  composerSupport: ReturnType<typeof composerSettingsSupportFromOptions>;
  conversation: AgentConversationVM | null;
  currentUserId?: string | null;
  isCreatingConversation: boolean;
  isInterrupting: boolean;
  isLoadingMessages: boolean;
  isRespondingToInteraction: boolean;
  isSubmitting: boolean;
  lastRenderStateDiagnosticKeyRef: CurrentValue<string | null>;
  pendingApproval: AgentApprovalItemVM | null;
  planImplementationTurnIdRef: CurrentValue<string | null>;
  providerReadinessGate:
    | import("../../../types").AgentGUIProviderReadinessGate
    | null;
  selectedAgentTargetUnavailable: boolean;
  selectedAgentTargetUnavailableReason: string | null;
  selectedAgentTargetOwnerLabel: string | null;
  agentTargetsLoading: boolean;
  ownerDeviceLabel?: string | null;
  serverInteractivePrompt: AgentGUIInteractivePrompt | null;
  sessionEngine: AgentSessionEngine;
  targetConnectionAgentTargetId?: string | null;
  targetConnectionSource?: AgentGUITargetConnectionSource | null;
  observationGapSource?: AgentGUIObservationGapSource | null;
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
  const sessionRuntimeBlock =
    input.activeEngineRuntimeAvailability?.state === "blocked"
      ? input.activeEngineRuntimeAvailability
      : null;
  const sessionRuntimeBlockedReason = sessionRuntimeBlock?.reason ?? null;
  const targetConnection = useAgentGUITargetConnectionState({
    agentTargetId: input.targetConnectionAgentTargetId,
    source: input.targetConnectionSource
  });
  const observationGap = useAgentObservationGap(
    input.activeEngineSession?.agentSessionId ?? input.activeConversationId,
    input.activeEngineActiveTurn?.turnId,
    input.observationGapSource
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
    const agentSessionId =
      input.activeEngineSession?.agentSessionId ??
      input.activeGoalControlPresentation.agentSessionId ??
      input.activeConversationId;
    if (!agentSessionId) {
      return null;
    }
    return {
      agentSessionId,
      goal: input.activeGoalControlPresentation.goal,
      goalControlStatus: input.activeGoalControlPresentation.status,
      goalIsOptimistic: input.activeGoalControlPresentation.optimistic
    };
  }, [
    input.activeConversationId,
    input.activeEngineSession?.agentSessionId,
    input.activeGoalControlPresentation
  ]);
  const sessionChrome = useMemo<AgentGUISessionChrome>(() => {
    const sharingRevokedRecovery = resolveAgentGUISharingRevokedRecovery({
      activeConversationId: input.activeConversationId,
      selectedAgentTargetOwnerLabel: input.selectedAgentTargetOwnerLabel,
      selectedAgentTargetUnavailable: input.selectedAgentTargetUnavailable,
      selectedAgentTargetUnavailableReason:
        input.selectedAgentTargetUnavailableReason,
      sessionRuntimeBlock
    });
    if (sharingRevokedRecovery) {
      return {
        auth: null,
        approval: null,
        recovery: sharingRevokedRecovery,
        rawState: sessionChromeRawState
      };
    }
    if (
      targetConnection.visibleState?.status === "connecting" ||
      targetConnection.visibleState?.status === "unavailable"
    ) {
      const device =
        input.ownerDeviceLabel?.trim() ||
        translate("agentHost.agentGui.sharedDeviceLabel");
      const reconnecting =
        targetConnection.visibleState.status === "connecting";
      const retryAttempt = targetConnection.visibleState.retryAttempt;
      return {
        auth: null,
        approval: null,
        recovery: {
          kind: reconnecting ? "transport-connecting" : "transport-unavailable",
          message: translate(
            reconnecting
              ? retryAttempt > 0
                ? "agentHost.agentGui.runtimeReconnectingAttempt"
                : "agentHost.agentGui.runtimeConnecting"
              : input.activeEngineActiveTurn !== null
                ? "agentHost.agentGui.runtimeUnavailableActive"
                : "agentHost.agentGui.runtimeUnavailable",
            { attempt: retryAttempt, device }
          ),
          canRetry: false
        },
        rawState: sessionChromeRawState
      };
    }
    if (observationGap !== null) {
      return {
        auth: null,
        approval: null,
        recovery: {
          kind: "transport-connecting",
          message: translate("agentHost.agentGui.runtimeSynchronizingProgress"),
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
                  canRetry: false
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
    input.selectedAgentTargetOwnerLabel,
    input.selectedAgentTargetUnavailable,
    input.selectedAgentTargetUnavailableReason,
    sessionRuntimeBlock,
    targetConnection.visibleState,
    observationGap,
    sessionChromeRawState
  ]);
  const hasNonRetryableRecoveryFailure =
    (sessionChrome.recovery?.kind === "failed" &&
      sessionChrome.recovery.canRetry === false) ||
    sessionChrome.recovery?.kind === "resume-unavailable";
  const authBlocked = sessionChrome.auth !== null;
  const isCollaboratorConversation = isDifferentKnownConversationOwner({
    conversationUserId: input.activeConversation?.userId,
    currentUserId: input.currentUserId
  });
  const pendingApproval = input.pendingApproval !== null;
  const hasPendingInteractivePrompt = pendingInteractivePrompt !== null;
  const settingsUpdateStatus = input.activeEngineSettingsUpdate?.status;
  const settingsUpdatePending =
    settingsUpdateStatus === "inFlight" ||
    settingsUpdateStatus === "waitingForRuntime" ||
    settingsUpdateStatus === "unknown" ||
    settingsUpdateStatus === "failed";
  const composerGate = useMemo(
    () =>
      resolveAgentGUIComposerGate({
        activeConversationBusy,
        activeConversationId: input.activeConversationId,
        activeEngineHasPendingInteractions:
          input.activeEngineHasPendingInteractions,
        activeLiveState: input.activeLiveState,
        activeConversationResumeUnavailable,
        agentTargetsLoading: input.agentTargetsLoading,
        authBlocked,
        hasNonRetryableRecoveryFailure,
        isCollaboratorConversation,
        isCreatingConversation: input.isCreatingConversation,
        isInterrupting: input.isInterrupting,
        isSubmitting: input.isSubmitting,
        pendingApproval,
        pendingInteractivePrompt: hasPendingInteractivePrompt,
        providerReadinessGate: input.providerReadinessGate,
        selectedAgentTargetUnavailable: input.selectedAgentTargetUnavailable,
        settingsUpdatePending,
        sessionRuntimeBlockedReason,
        targetConnectionBlocked:
          targetConnection.blocked || observationGap !== null
      }),
    [
      activeConversationBusy,
      activeConversationResumeUnavailable,
      authBlocked,
      hasNonRetryableRecoveryFailure,
      hasPendingInteractivePrompt,
      input.activeConversationId,
      input.activeEngineHasPendingInteractions,
      input.activeLiveState,
      input.agentTargetsLoading,
      input.isCreatingConversation,
      input.isInterrupting,
      input.isSubmitting,
      input.providerReadinessGate,
      input.selectedAgentTargetUnavailable,
      isCollaboratorConversation,
      pendingApproval,
      sessionRuntimeBlockedReason,
      settingsUpdatePending,
      targetConnection.blocked,
      observationGap
    ]
  );
  const canSubmit = composerGate.submission.status === "ready";
  const canQueueWhileBusy = composerGate.submission.status === "queue";
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
      input.conversation?.sourceDetail.showProcessingIndicator
        ? "show-processing"
        : "hide-processing",
      input.conversation?.rows
        .filter((row) => row.kind === "processing")
        .map((row) => `${row.id}:${row.turnId ?? ""}`)
        .join(",") ?? "",
      input.isCreatingConversation ? "creating" : "",
      input.isLoadingMessages ? "loading-messages" : "",
      input.isSubmitting ? "submitting" : "",
      canSubmit ? "can-submit" : "cannot-submit",
      canQueueWhileBusy ? "can-queue" : "cannot-queue",
      composerGate.editor.status,
      composerGate.editor.reason ?? "",
      composerGate.submission.reason ?? "",
      composerGate.runtime.reason ?? ""
    ].join(":");
    if (input.lastRenderStateDiagnosticKeyRef.current === diagnosticKey) return;
    input.lastRenderStateDiagnosticKeyRef.current = diagnosticKey;
    reportAgentGUIRenderStateDiagnostic({
      activeActivityDisplayStatus: input.activityDisplayStatus,
      activeConversation: input.activeConversation,
      activeConversationBusy,
      activeConversationId: input.activeConversationId,
      activeEngineActiveTurn: input.activeEngineActiveTurn,
      activeEngineAvailability: input.activeEngineAvailability,
      activeEngineLatestTurn: input.activeEngineLatestTurn,
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
    composerGate,
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
    composerGate,
    hasSentUserMessage,
    isRespondingApproval,
    pendingInteractivePrompt,
    sessionChrome
  };
}
