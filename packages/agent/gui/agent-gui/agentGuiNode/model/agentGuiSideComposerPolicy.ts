import type { AgentSideConversationState } from "../../../agentSideConversationRuntime";
import type {
  AgentGUIComposerGate,
  AgentGUIComposerSettingsVM
} from "./agentGuiNodeTypes";
import type { AgentComposerCapabilityMenuState } from "../composer/AgentComposer.types";

export function projectAgentSideCapabilityMenuState(
  parent: AgentComposerCapabilityMenuState | undefined
): AgentComposerCapabilityMenuState | undefined {
  return parent?.connectors ? { connectors: parent.connectors } : undefined;
}

export function projectAgentSideComposerGate(
  active: AgentSideConversationState
): AgentGUIComposerGate {
  const terminal = active.status === "error" || active.status === "expired";
  const transitioning =
    active.status === "opening" || active.status === "closing";
  const pendingInteraction = active.pendingInteraction !== null;
  const busy = active.activeTurnId !== null || active.status === "running";
  return {
    conversationBusy: busy,
    runtime: terminal
      ? {
          status: "blocked",
          reason: "session_runtime",
          sessionRuntimeReason: "transport_unavailable"
        }
      : {
          status: "ready",
          reason: null,
          sessionRuntimeReason: null
        },
    editor: terminal
      ? { status: "blocked", reason: "runtime_blocked" }
      : transitioning
        ? { status: "blocked", reason: "submitting" }
        : { status: "editable", reason: null },
    submission: terminal
      ? { status: "blocked", reason: "runtime_blocked" }
      : transitioning
        ? { status: "blocked", reason: "submitting" }
        : pendingInteraction
          ? { status: "blocked", reason: "pending_interactive_prompt" }
          : busy
            ? { status: "blocked", reason: "conversation_busy" }
            : { status: "ready", reason: null }
  };
}

export function projectAgentSideComposerSettings(
  parent: AgentGUIComposerSettingsVM
): AgentGUIComposerSettingsVM {
  return {
    sessionSettings: parent.sessionSettings,
    draftSettings: {
      model: parent.draftSettings.model,
      reasoningEffort: parent.draftSettings.reasoningEffort,
      speed: parent.draftSettings.speed,
      planMode: parent.draftSettings.planMode,
      browserUse: parent.draftSettings.browserUse,
      computerUse: parent.draftSettings.computerUse,
      permissionModeId: parent.draftSettings.permissionModeId
    },
    supportsModel: false,
    supportsReasoningEffort: false,
    supportsSpeed: false,
    supportsPermissionMode: false,
    supportsPlanMode: false,
    supportsBrowser: false,
    supportsComputerUse: false,
    isSettingsLoading: false,
    isCapabilityOptionsLoading: false,
    isModelOptionsLoading: false,
    modelUnavailable: false,
    reasoningUnavailable: false,
    speedUnavailable: false,
    permissionModeUnavailable: false,
    selectedModelValue: parent.selectedModelValue,
    selectedReasoningEffortValue: parent.selectedReasoningEffortValue,
    selectedSpeedValue: parent.selectedSpeedValue,
    selectedPermissionModeValue: parent.selectedPermissionModeValue,
    permissionConfig: parent.permissionConfig,
    selectedProjectPath: parent.selectedProjectPath,
    selectedProjectSectionKey: parent.selectedProjectSectionKey,
    projectLocked: true,
    projectPathIsRemote: parent.projectPathIsRemote,
    availableModels: [],
    availableReasoningEfforts: [],
    availableSpeeds: [],
    availablePermissionModes: []
  };
}
