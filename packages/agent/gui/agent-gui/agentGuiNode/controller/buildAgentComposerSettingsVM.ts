import type { AgentActivityComposerOptions } from "@tutti-os/agent-activity-core";
import type {
  AgentSessionComposerSettings,
  AgentSessionReasoningEffort,
  AgentSessionSpeed
} from "../../../shared/agentSessionTypes";
import type { AgentGUINodeData } from "../../../types";
import type { AgentGUIComposerSettingsVM } from "../model/agentGuiNodeTypes";
import {
  modelSelectionFromComposerOptions,
  normalizePermissionModeId,
  permissionConfigFromComposerOptions,
  permissionModeOptions,
  reasoningSelectionFromComposerOptions,
  speedSelectionFromComposerOptions
} from "./agentGuiController.composerHelpers";

export function buildAgentComposerSettingsVM(input: {
  data: AgentGUINodeData;
  activeConversationId: string | null;
  activeConversationCwd: string | null | undefined;
  selectedProjectPath: string | null;
  sessionSettings: AgentSessionComposerSettings | null;
  draftSettings: AgentSessionComposerSettings;
  draftModel: string | null;
  draftReasoningEffort: AgentSessionReasoningEffort | null;
  draftSpeed?: AgentSessionSpeed | null;
  effectivePlanMode: boolean;
  composerSupport: {
    model: boolean;
    reasoning: boolean;
    plan: boolean;
    speed: boolean;
    browser: boolean;
  };
  providerComposerOptions: AgentActivityComposerOptions | null;
  activeSessionModelSelection: ReturnType<
    typeof modelSelectionFromComposerOptions
  >;
  activeSessionReasoningSelection: ReturnType<
    typeof reasoningSelectionFromComposerOptions
  >;
  activeSessionSpeedSelection?: ReturnType<
    typeof speedSelectionFromComposerOptions
  >;
}): AgentGUIComposerSettingsVM {
  const permissionConfig = permissionConfigFromComposerOptions(
    input.providerComposerOptions
  );
  const supportsPermissionMode = Boolean(
    permissionConfig?.configurable && permissionConfig.modes.length > 0
  );
  const hasOptionsSource = input.providerComposerOptions !== null;
  const hasACPSettings =
    hasOptionsSource &&
    (!input.composerSupport.model ||
      input.activeSessionModelSelection !== null) &&
    (!input.composerSupport.reasoning ||
      input.activeSessionReasoningSelection !== null);
  const isSettingsLoading = !hasACPSettings;
  const selectedModelValue = input.draftModel;
  const selectedReasoningEffortValue =
    input.draftReasoningEffort as AgentSessionReasoningEffort | null;
  const selectedPermissionModeValue =
    normalizePermissionModeId(input.draftSettings.permissionModeId) ??
    normalizePermissionModeId(permissionConfig?.defaultValue);

  const selectedSpeedValue = (input.draftSpeed ??
    input.draftSettings.speed ??
    null) as AgentSessionSpeed | null;
  const activeSessionSpeedSelection =
    input.activeSessionSpeedSelection ??
    speedSelectionFromComposerOptions(
      input.providerComposerOptions,
      selectedSpeedValue
    );

  return {
    sessionSettings: input.sessionSettings,
    draftSettings: {
      model: input.draftModel,
      reasoningEffort: input.draftReasoningEffort,
      speed: selectedSpeedValue,
      planMode: Boolean(input.draftSettings.planMode),
      browserUse: input.draftSettings.browserUse ?? true,
      permissionModeId: normalizePermissionModeId(
        input.draftSettings.permissionModeId
      )
    },
    effectivePlanMode: input.composerSupport.plan
      ? input.effectivePlanMode
      : false,
    supportsModel: input.composerSupport.model,
    supportsReasoningEffort: input.composerSupport.reasoning,
    supportsSpeed: input.composerSupport.speed,
    supportsPermissionMode,
    supportsPlanMode: input.composerSupport.plan,
    supportsBrowser: input.composerSupport.browser,
    isSettingsLoading,
    modelUnavailable:
      input.activeConversationId !== null &&
      input.sessionSettings === null &&
      input.composerSupport.model &&
      input.draftModel === null,
    reasoningUnavailable:
      input.activeConversationId !== null &&
      input.sessionSettings === null &&
      input.composerSupport.reasoning &&
      input.draftReasoningEffort === null,
    speedUnavailable:
      input.activeConversationId !== null &&
      input.sessionSettings === null &&
      input.composerSupport.speed &&
      selectedSpeedValue === null,
    permissionModeUnavailable:
      input.activeConversationId !== null &&
      input.sessionSettings === null &&
      supportsPermissionMode &&
      selectedPermissionModeValue === null,
    planUnavailable:
      input.activeConversationId !== null &&
      input.sessionSettings === null &&
      input.composerSupport.plan &&
      !input.effectivePlanMode,
    selectedModelValue,
    selectedReasoningEffortValue,
    selectedSpeedValue,
    selectedPermissionModeValue,
    permissionConfig,
    selectedProjectPath:
      input.activeConversationId !== null
        ? (input.activeConversationCwd ?? null)
        : input.selectedProjectPath,
    projectLocked: input.activeConversationId !== null,
    availableModels:
      input.composerSupport.model &&
      hasOptionsSource &&
      input.activeSessionModelSelection !== null
        ? input.activeSessionModelSelection.options
        : [],
    availableReasoningEfforts:
      input.composerSupport.reasoning &&
      hasOptionsSource &&
      input.activeSessionReasoningSelection !== null
        ? input.activeSessionReasoningSelection.options
        : [],
    availableSpeeds:
      input.composerSupport.speed &&
      hasOptionsSource &&
      activeSessionSpeedSelection !== null
        ? activeSessionSpeedSelection.options
        : [],
    availablePermissionModes: supportsPermissionMode
      ? permissionModeOptions(input.data.provider, permissionConfig)
      : []
  };
}
