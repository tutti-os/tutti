import type {
  AgentActivityComposerOptionsLoadStatus,
  AgentActivityComposerOptions,
  AgentActivitySession
} from "@tutti-os/agent-activity-core";
import { useMemo } from "react";
import { areWorkspaceUserProjectPathsEqual } from "@tutti-os/workspace-user-project/core";
import type { AgentGUIRuntime } from "../../../agentActivityRuntime";
import type {
  AgentSessionComposerSettings,
  AgentSessionReasoningEffort,
  AgentSessionSpeed,
  AgentSessionState
} from "../../../shared/agentSessionTypes";
import type { AgentGUINodeData, AgentGUIProvider } from "../../../types";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type { AgentGUIConversationUserProject } from "../model/agentGuiConversationProjectResolver";
import type { AgentGUIComposerSettingsVM } from "../model/agentGuiNodeTypes";
import { slashCommandPolicyFromComposerOptions } from "../model/agentSlashCommandProviderPolicy";
import { composerSettingsSupportFromOptions } from "../model/composerSettingsSupport";
import {
  cloneComposerSettings,
  modelSelectionFromComposerOptions,
  normalizePermissionModeId,
  permissionConfigFromComposerOptions,
  permissionModeOptions,
  readNodeDefaultDraftSettings,
  reasoningSelectionFromComposerOptions,
  speedSelectionFromComposerOptions
} from "./agentGuiController.composerHelpers";
import {
  composerModelChoiceHistoryTargetId,
  enforceComposerModelBindingForHomeDefaults,
  isForegroundModelOptionsLoading,
  resolveComposerSettingsPresentation,
  sanitizeComposerSettingsForTarget,
  type AgentGUIComposerTargetData
} from "./agentGuiController.composerPresentation";
import { normalizeOptionalText } from "./agentGuiController.promptHelpers";
import { overlayComposerDefaults } from "./agentGuiController.providerHelpers";
import {
  useStableComposerSettings,
  useStableComposerSettingsVM
} from "./agentGuiController.stableHelpers";

interface UseAgentGUIComposerPresentationInput {
  activeConversation: AgentGUIConversationSummary | null;
  activeConversationId: string | null;
  activeEngineSession: Pick<AgentActivitySession, "settings"> | null;
  activeSessionState: AgentSessionState | null;
  agentActivityRuntime: AgentGUIRuntime;
  composerSupport: ReturnType<typeof composerSettingsSupportFromOptions>;
  composerOptionsLoadStatus?: AgentActivityComposerOptionsLoadStatus;
  composerOptionsLoading: boolean;
  connectorOptionsLoading: boolean;
  composerTargetProvider: AgentGUIProvider;
  codexSaverModeEntryEnabled?: boolean;
  data: AgentGUINodeData;
  defaultReasoningEffort: AgentSessionReasoningEffort | null;
  draftSettingsBySessionId: Record<string, AgentSessionComposerSettings>;
  providerComposerOptions: AgentActivityComposerOptions | null;
  composerTargetData: AgentGUIComposerTargetData;
  selectedComposerTargetData: AgentGUIComposerTargetData;
  selectedProjectPath: string | null;
  shouldApplyPreparedProjectSelection: boolean;
  userProjects: readonly AgentGUIConversationUserProject[];
}

export function useAgentGUIComposerPresentation(
  input: UseAgentGUIComposerPresentationInput
) {
  const sessionSettings = useStableComposerSettings(
    cloneComposerSettings(input.activeSessionState?.settings ?? null)
  );
  const storedNodeDefaultSettings = useStableComposerSettings(
    readNodeDefaultDraftSettings({
      data:
        input.activeConversationId === null
          ? input.selectedComposerTargetData.data
          : input.data,
      defaultReasoningEffort: input.defaultReasoningEffort,
      drafts: input.draftSettingsBySessionId
    })
  );
  // Home defaults additionally refuse bare models the settled provider list
  // rejects (a plan model leaked bare into a provider bucket must fall back
  // to the provider default, not surface as the composer default). The
  // composer-options authority reconciliation persists the same correction,
  // which also stops the rejected model from riding along in later requests.
  const targetSafeNodeDefaultSettings = useStableComposerSettings(
    input.activeConversationId === null
      ? enforceComposerModelBindingForHomeDefaults(
          sanitizeComposerSettingsForTarget({
            settings: storedNodeDefaultSettings,
            target: input.selectedComposerTargetData,
            options: input.providerComposerOptions
          }),
          input.providerComposerOptions
        )
      : storedNodeDefaultSettings
  );
  const homeComposerSettings = useStableComposerSettings(
    resolveComposerSettingsPresentation({
      active: false,
      homeSettings: targetSafeNodeDefaultSettings,
      options: input.providerComposerOptions
    })
  );

  const activeConversationDraftSettings = input.activeConversationId
    ? (input.draftSettingsBySessionId[input.activeConversationId] ?? null)
    : null;
  const presentedDraftSettings = resolveComposerSettingsPresentation({
    active: input.activeConversationId !== null,
    homeSettings: homeComposerSettings,
    optimisticSettings: activeConversationDraftSettings,
    options: input.providerComposerOptions,
    permissionModeId: input.activeSessionState?.permissionModeId,
    sessionSettings
  });
  // Layer resolution can resurrect a rejected bare model from the preloaded
  // daemon effective settings (per-target prefs poisoned by the same leak),
  // so the home policy is enforced on the merged result, not just the node
  // defaults.
  const draftSettings = useStableComposerSettings(
    input.activeConversationId === null
      ? enforceComposerModelBindingForHomeDefaults(
          presentedDraftSettings,
          input.providerComposerOptions
        )
      : presentedDraftSettings
  );
  const persistedDraftModel = normalizeOptionalText(draftSettings.model);
  const usesPlaceholderDraftModel =
    persistedDraftModel === null || persistedDraftModel === "default";
  const liveConfigModel =
    input.activeConversationId !== null && usesPlaceholderDraftModel
      ? normalizeOptionalText(input.activeEngineSession?.settings?.model)
      : null;
  const draftModel = usesPlaceholderDraftModel
    ? (liveConfigModel ?? persistedDraftModel)
    : persistedDraftModel;
  const draftReasoningEffort = normalizeOptionalText(
    draftSettings.reasoningEffort
  ) as AgentSessionReasoningEffort | null;
  const draftSpeed = normalizeOptionalText(
    draftSettings.speed
  ) as AgentSessionSpeed | null;
  const activeSessionReasoningSelection = useMemo(
    () =>
      reasoningSelectionFromComposerOptions(
        input.providerComposerOptions,
        draftReasoningEffort,
        draftModel
      ),
    [draftModel, draftReasoningEffort, input.providerComposerOptions]
  );
  const optionsReasoningEffort = activeSessionReasoningSelection
    ? activeSessionReasoningSelection.currentValue
    : draftReasoningEffort;
  const activeSessionModelSelection = useMemo(
    () =>
      modelSelectionFromComposerOptions(
        input.providerComposerOptions,
        draftModel
      ),
    [draftModel, input.providerComposerOptions]
  );
  const activeSessionSpeedSelection = useMemo(
    () =>
      speedSelectionFromComposerOptions(
        input.providerComposerOptions,
        draftSpeed
      ),
    [draftSpeed, input.providerComposerOptions]
  );
  const composerSettings = useMemo<AgentGUIComposerSettingsVM>(() => {
    const permissionConfig = permissionConfigFromComposerOptions(
      input.providerComposerOptions
    );
    const supportsPermissionMode = Boolean(
      permissionConfig?.configurable && permissionConfig.modes.length > 0
    );
    const hasOptionsSource = input.providerComposerOptions !== null;
    const hasACPSettings =
      hasOptionsSource &&
      (!input.composerSupport.model || activeSessionModelSelection !== null) &&
      (!input.composerSupport.reasoning ||
        activeSessionReasoningSelection !== null);
    const composerOptionsError =
      input.composerOptionsLoadStatus === "error" && !hasOptionsSource;
    const selectedPermissionModeValue =
      normalizePermissionModeId(draftSettings.permissionModeId) ??
      normalizePermissionModeId(permissionConfig?.defaultValue);
    const protectedSettings = overlayComposerDefaults(
      {
        codexSaverMode:
          input.providerComposerOptions?.effectiveSettings?.codexSaverMode ===
          true,
        model: draftModel,
        permissionModeId: selectedPermissionModeValue,
        reasoningEffort: optionsReasoningEffort,
        speed: draftSpeed
      },
      input.activeConversationId === null
        ? input.selectedComposerTargetData.agentTargetId
          ? storedNodeDefaultSettings
          : null
        : sessionSettings
    );
    const presentedModel = normalizeOptionalText(protectedSettings.model);
    const presentedReasoningEffort = normalizeOptionalText(
      protectedSettings.reasoningEffort
    ) as AgentSessionReasoningEffort | null;
    const presentedSpeed = normalizeOptionalText(
      protectedSettings.speed
    ) as AgentSessionSpeed | null;
    const presentedPermissionMode = normalizePermissionModeId(
      protectedSettings.permissionModeId
    );
    return {
      sessionSettings,
      draftSettings: {
        codexSaverMode:
          input.codexSaverModeEntryEnabled === true &&
          input.providerComposerOptions?.codexSaverModeSupported === true &&
          protectedSettings.codexSaverMode === true,
        model: presentedModel,
        reasoningEffort: presentedReasoningEffort,
        speed: presentedSpeed,
        planMode: Boolean(draftSettings.planMode),
        browserUse: draftSettings.browserUse ?? true,
        computerUse: draftSettings.computerUse ?? true,
        permissionModeId: presentedPermissionMode
      },
      supportsModel: input.composerSupport.model,
      supportsCodexSaverMode:
        input.codexSaverModeEntryEnabled &&
        input.providerComposerOptions?.codexSaverModeSupported === true,
      supportsReasoningEffort: input.composerSupport.reasoning,
      supportsSpeed: input.composerSupport.speed,
      supportsBrowser: input.composerSupport.browser,
      supportsComputerUse: input.composerSupport.computer,
      permissionModeChangeDuringTurn:
        input.composerSupport.permissionModeChangeDuringTurn,
      slashCommandPolicy: slashCommandPolicyFromComposerOptions(
        input.providerComposerOptions
      ),
      supportsPermissionMode,
      supportsPlanMode: input.composerSupport.plan,
      planExclusiveWithPermissionMode:
        input.providerComposerOptions?.behavior
          ?.planModeExclusiveWithPermissionMode === true,
      composerOptionsError,
      composerOptionsLoadStatus: input.composerOptionsLoadStatus,
      isSettingsLoading: !hasACPSettings && !composerOptionsError,
      isCapabilityOptionsLoading: input.composerOptionsLoading,
      isConnectorOptionsLoading: input.connectorOptionsLoading,
      isModelOptionsLoading: isForegroundModelOptionsLoading({
        modelOptionsLoading: input.providerComposerOptions?.modelOptionsLoading,
        selection: activeSessionModelSelection,
        supportsModel: input.composerSupport.model
      }),
      modelChoiceHistory: {
        targetId: composerModelChoiceHistoryTargetId({
          activeConversationId: input.activeConversationId,
          target: input.composerTargetData
        }),
        catalog: input.providerComposerOptions
          ? {
              authoritative:
                input.providerComposerOptions.behavior
                  .modelOptionsAuthoritative === true,
              loading:
                input.providerComposerOptions.modelOptionsLoading === true,
              effectiveModel: normalizeOptionalText(
                input.providerComposerOptions.effectiveSettings?.model
              ),
              models: input.providerComposerOptions.models.map((option) => ({
                value: option.value,
                ...(option.requested === true ? { requested: true } : {})
              }))
            }
          : null
      },
      modelUnavailable:
        input.activeConversationId !== null &&
        sessionSettings === null &&
        input.composerSupport.model &&
        draftModel === null,
      reasoningUnavailable:
        input.activeConversationId !== null &&
        sessionSettings === null &&
        input.composerSupport.reasoning &&
        draftReasoningEffort === null,
      speedUnavailable:
        input.activeConversationId !== null &&
        sessionSettings === null &&
        input.composerSupport.speed &&
        draftSpeed === null,
      permissionModeUnavailable:
        input.activeConversationId !== null &&
        sessionSettings === null &&
        supportsPermissionMode &&
        selectedPermissionModeValue === null,
      selectedModelValue: presentedModel,
      effectiveModelValue:
        input.providerComposerOptions?.effectiveModel ?? null,
      selectedReasoningEffortValue: presentedReasoningEffort,
      selectedSpeedValue: presentedSpeed,
      selectedPermissionModeValue: presentedPermissionMode,
      permissionConfig,
      selectedProjectPath:
        input.activeConversationId !== null
          ? (input.activeConversation?.cwd ?? null)
          : input.selectedProjectPath,
      selectedProjectSectionKey:
        input.activeConversationId !== null
          ? (input.activeConversation?.railSectionKey ?? null)
          : resolveSelectedProjectSectionKey(
              input.selectedProjectPath,
              input.userProjects
            ),
      shouldApplyPreparedProjectSelection:
        input.activeConversationId === null &&
        input.shouldApplyPreparedProjectSelection,
      projectLocked: input.activeConversationId !== null,
      projectPathIsRemote: input.agentActivityRuntime.projectPathIsRemote,
      collapseModelOptionsToLatest:
        input.providerComposerOptions?.behavior.collapseModelOptionsToLatest ===
        true,
      modelPlan: input.providerComposerOptions?.modelPlan ?? null,
      modelSwitchTakesEffectNextTurn:
        input.activeConversationId !== null &&
        input.composerSupport.modelSwitch,
      availableModels:
        input.composerSupport.model &&
        hasOptionsSource &&
        activeSessionModelSelection !== null
          ? activeSessionModelSelection.options
          : [],
      availableReasoningEfforts:
        input.composerSupport.reasoning &&
        hasOptionsSource &&
        activeSessionReasoningSelection !== null
          ? activeSessionReasoningSelection.options
          : [],
      availableSpeeds:
        input.composerSupport.speed &&
        hasOptionsSource &&
        activeSessionSpeedSelection !== null
          ? activeSessionSpeedSelection.options
          : [],
      availablePermissionModes: supportsPermissionMode
        ? permissionModeOptions(input.composerTargetProvider, permissionConfig)
        : []
    };
  }, [
    activeSessionModelSelection,
    activeSessionReasoningSelection,
    activeSessionSpeedSelection,
    draftModel,
    draftReasoningEffort,
    draftSettings,
    draftSpeed,
    input.activeConversation?.cwd,
    input.activeConversation?.railSectionKey,
    input.activeConversationId,
    input.agentActivityRuntime.projectPathIsRemote,
    input.composerSupport,
    input.composerOptionsLoadStatus,
    input.composerOptionsLoading,
    input.connectorOptionsLoading,
    input.composerTargetData,
    input.composerTargetProvider,
    input.providerComposerOptions,
    input.selectedComposerTargetData.agentTargetId,
    input.selectedProjectPath,
    input.shouldApplyPreparedProjectSelection,
    input.userProjects,
    optionsReasoningEffort,
    sessionSettings,
    storedNodeDefaultSettings
  ]);

  return {
    draftModel,
    draftReasoningEffort,
    draftSettings,
    draftSpeed,
    sessionSettings,
    stableComposerSettings: useStableComposerSettingsVM(composerSettings)
  };
}

function resolveSelectedProjectSectionKey(
  selectedProjectPath: string | null,
  userProjects: readonly AgentGUIConversationUserProject[]
): string | null {
  const projectPath = selectedProjectPath?.trim() ?? "";
  if (!projectPath) {
    return "conversations";
  }
  return (
    userProjects
      .find((project) =>
        areWorkspaceUserProjectPathsEqual(project.path, projectPath)
      )
      ?.sectionKey?.trim() || null
  );
}
