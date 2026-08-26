import type {
  AgentActivityComposerOptions,
  AgentActivitySessionSettings
} from "@tutti-os/agent-activity-core";
import type {
  AgentSessionReasoningEffort,
  AgentSessionSpeed
} from "./shared/agentSessionTypes";
import type { AgentGUIProvider } from "./types";
import type { AgentGUIComposerSettingsVM } from "./agent-gui/agentGuiNode/model/agentGuiNodeTypes";
import { composerSettingsSupportFromOptions } from "./agent-gui/agentGuiNode/model/composerSettingsSupport";
import {
  modelSelectionFromComposerOptions,
  normalizePermissionModeId,
  permissionConfigFromComposerOptions,
  permissionModeOptions,
  reasoningSelectionFromComposerOptions,
  speedSelectionFromComposerOptions
} from "./agent-gui/agentGuiNode/controller/agentGuiController.composerHelpers";
import { normalizeOptionalText } from "./agent-gui/agentGuiNode/controller/agentGuiController.promptHelpers";

export type AgentGUIQuickComposerSettings = Pick<
  AgentActivitySessionSettings,
  | "browserUse"
  | "model"
  | "permissionModeId"
  | "planMode"
  | "reasoningEffort"
  | "speed"
>;

/** Runtime-narrows the shared Composer patch to settings this entry can send. */
export function pickQuickComposerSettings(
  settings: AgentActivitySessionSettings
): AgentGUIQuickComposerSettings {
  return {
    ...(settings.browserUse !== undefined
      ? { browserUse: settings.browserUse }
      : {}),
    ...(settings.model !== undefined ? { model: settings.model } : {}),
    ...(settings.permissionModeId !== undefined
      ? { permissionModeId: settings.permissionModeId }
      : {}),
    ...(settings.planMode !== undefined ? { planMode: settings.planMode } : {}),
    ...(settings.reasoningEffort !== undefined
      ? { reasoningEffort: settings.reasoningEffort }
      : {}),
    ...(settings.speed !== undefined ? { speed: settings.speed } : {})
  };
}

export interface QuickComposerSettingsProjectionInput {
  agentTargetId: string | null;
  loading: boolean;
  options: AgentActivityComposerOptions | null;
  projectLocked: boolean;
  provider: AgentGUIProvider;
  selectedProjectPath: string | null;
  settings: AgentGUIQuickComposerSettings;
}

/**
 * Projects host-owned pre-session options into the same settings view model as
 * the full Composer. Quick Composer keeps only the controlled draft selection;
 * option loading and provider authority stay with the embedding host.
 */
export function projectQuickComposerSettings(
  input: QuickComposerSettingsProjectionInput
): AgentGUIComposerSettingsVM {
  const support = composerSettingsSupportFromOptions(input.options, null);
  const effectiveSettings = input.options?.effectiveSettings ?? null;
  const selectedModel = normalizeOptionalText(
    input.settings.model ?? effectiveSettings?.model
  );
  const selectedReasoningEffort = normalizeOptionalText(
    input.settings.reasoningEffort ?? effectiveSettings?.reasoningEffort
  ) as AgentSessionReasoningEffort | null;
  const selectedSpeed = normalizeOptionalText(
    input.settings.speed ?? effectiveSettings?.speed
  ) as AgentSessionSpeed | null;
  const modelSelection = modelSelectionFromComposerOptions(
    input.options,
    selectedModel
  );
  const reasoningSelection = reasoningSelectionFromComposerOptions(
    input.options,
    selectedReasoningEffort,
    selectedModel
  );
  const speedSelection = speedSelectionFromComposerOptions(
    input.options,
    selectedSpeed
  );
  const permissionConfig = permissionConfigFromComposerOptions(input.options);
  const selectedPermissionMode =
    normalizePermissionModeId(input.settings.permissionModeId) ??
    normalizePermissionModeId(
      effectiveSettings?.permissionModeId ?? permissionConfig?.defaultValue
    );
  const supportsPermissionMode = Boolean(
    permissionConfig?.configurable && permissionConfig.modes.length > 0
  );

  return {
    availableModels:
      support.model && modelSelection ? modelSelection.options : [],
    availablePermissionModes: supportsPermissionMode
      ? permissionModeOptions(input.provider, permissionConfig)
      : [],
    availableReasoningEfforts:
      support.reasoning && reasoningSelection ? reasoningSelection.options : [],
    availableSpeeds:
      support.speed && speedSelection ? speedSelection.options : [],
    collapseModelOptionsToLatest:
      input.options?.behavior.collapseModelOptionsToLatest === true,
    draftSettings: {
      browserUse: input.settings.browserUse ?? true,
      codexSaverMode: false,
      rtkSaverMode: false,
      computerUse: true,
      model: selectedModel,
      permissionModeId: selectedPermissionMode,
      planMode: Boolean(input.settings.planMode ?? effectiveSettings?.planMode),
      reasoningEffort:
        (reasoningSelection?.currentValue as AgentSessionReasoningEffort | null) ??
        selectedReasoningEffort,
      speed:
        (speedSelection?.currentValue as AgentSessionSpeed | null) ??
        selectedSpeed
    },
    effectiveModelValue: input.options?.effectiveModel ?? null,
    isCapabilityOptionsLoading: input.loading,
    isModelOptionsLoading:
      input.loading || input.options?.modelOptionsLoading === true,
    isSettingsLoading: input.loading,
    modelChoiceHistory: {
      targetId: input.agentTargetId,
      catalog: input.options
        ? {
            authoritative:
              input.options.behavior.modelOptionsAuthoritative === true,
            loading:
              input.loading || input.options.modelOptionsLoading === true,
            effectiveModel: normalizeOptionalText(
              input.options.effectiveSettings?.model
            ),
            models: input.options.models.map((option) => ({
              value: option.value,
              ...(option.requested === true ? { requested: true } : {})
            }))
          }
        : null
    },
    modelPlan: input.options?.modelPlan ?? null,
    modelUnavailable: false,
    permissionConfig,
    permissionModeChangeDuringTurn: false,
    permissionModeUnavailable: false,
    planExclusiveWithPermissionMode:
      input.options?.behavior.planModeExclusiveWithPermissionMode === true,
    projectLocked: input.projectLocked,
    reasoningUnavailable: false,
    selectedModelValue: selectedModel,
    selectedPermissionModeValue: selectedPermissionMode,
    selectedProjectPath: input.selectedProjectPath,
    selectedProjectSectionKey: input.selectedProjectPath
      ? null
      : "conversations",
    selectedReasoningEffortValue:
      (reasoningSelection?.currentValue as AgentSessionReasoningEffort | null) ??
      selectedReasoningEffort,
    selectedSpeedValue:
      (speedSelection?.currentValue as AgentSessionSpeed | null) ??
      selectedSpeed,
    sessionSettings: null,
    shouldApplyPreparedProjectSelection: false,
    speedUnavailable: false,
    supportsBrowser: support.browser,
    supportsCodexSaverMode: false,
    supportsComputerUse: false,
    supportsModel: support.model,
    supportsPermissionMode,
    supportsPlanMode: support.plan,
    supportsReasoningEffort: support.reasoning,
    supportsSpeed: support.speed
  };
}
