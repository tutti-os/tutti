import type {
  AgentActivityComposerOptions,
  AgentActivitySession
} from "@tutti-os/agent-activity-core";
import { useEffect, useMemo, type Dispatch, type SetStateAction } from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
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
  nodeDataFromComposerSettings,
  nodeDefaultDraftKey,
  normalizePermissionModeId,
  permissionConfigFromComposerOptions,
  permissionModeOptions,
  readNodeDefaultDraftSettings,
  reasoningSelectionFromComposerOptions,
  sameComposerSettings,
  speedSelectionFromComposerOptions
} from "./agentGuiController.composerHelpers";
import {
  isForegroundModelOptionsLoading,
  resolveComposerSettingsPresentation,
  sanitizeComposerSettingsForTarget,
  type AgentGUIComposerTargetData
} from "./agentGuiController.composerPresentation";
import { normalizeOptionalText } from "./agentGuiController.promptHelpers";
import {
  useStableComposerSettings,
  useStableComposerSettingsVM
} from "./agentGuiController.stableHelpers";

interface CurrentValue<T> {
  current: T;
}

interface UseAgentGUIComposerPresentationInput {
  activeConversation: AgentGUIConversationSummary | null;
  activeConversationId: string | null;
  activeEngineSession: Pick<AgentActivitySession, "settings"> | null;
  activeSessionState: AgentSessionState | null;
  agentActivityRuntime: AgentActivityRuntime;
  composerSupport: ReturnType<typeof composerSettingsSupportFromOptions>;
  composerOptionsLoading: boolean;
  composerTargetProvider: AgentGUIProvider;
  data: AgentGUINodeData;
  defaultReasoningEffort: AgentSessionReasoningEffort | null;
  draftSettingsBySessionId: Record<string, AgentSessionComposerSettings>;
  draftSettingsBySessionIdRef: CurrentValue<
    Record<string, AgentSessionComposerSettings>
  >;
  onDataChangeRef: CurrentValue<
    (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
  >;
  providerComposerOptions: AgentActivityComposerOptions | null;
  selectedComposerTargetData: AgentGUIComposerTargetData;
  selectedProjectPath: string | null;
  userProjects: readonly AgentGUIConversationUserProject[];
  setDraftSettingsBySessionId: Dispatch<
    SetStateAction<Record<string, AgentSessionComposerSettings>>
  >;
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
  const targetSafeNodeDefaultSettings = useStableComposerSettings(
    input.activeConversationId === null
      ? sanitizeComposerSettingsForTarget({
          settings: storedNodeDefaultSettings,
          target: input.selectedComposerTargetData,
          options: input.providerComposerOptions
        })
      : storedNodeDefaultSettings
  );
  const homeComposerSettings = useStableComposerSettings(
    resolveComposerSettingsPresentation({
      active: false,
      homeSettings: targetSafeNodeDefaultSettings,
      options: input.providerComposerOptions
    })
  );

  useEffect(() => {
    if (
      input.activeConversationId !== null ||
      !input.selectedComposerTargetData.agentTargetId ||
      !input.providerComposerOptions ||
      sameComposerSettings(
        storedNodeDefaultSettings,
        targetSafeNodeDefaultSettings
      )
    ) {
      return;
    }
    const targetDefaultDraftKey = nodeDefaultDraftKey(
      input.selectedComposerTargetData.provider,
      input.selectedComposerTargetData.agentTargetId
    );
    input.draftSettingsBySessionIdRef.current = {
      ...input.draftSettingsBySessionIdRef.current,
      [targetDefaultDraftKey]: targetSafeNodeDefaultSettings
    };
    input.setDraftSettingsBySessionId((current) => ({
      ...current,
      [targetDefaultDraftKey]: targetSafeNodeDefaultSettings
    }));
    input.onDataChangeRef.current((current) =>
      nodeDataFromComposerSettings(
        {
          ...current,
          provider: input.selectedComposerTargetData.provider,
          agentTargetId: input.selectedComposerTargetData.agentTargetId
        },
        targetSafeNodeDefaultSettings
      )
    );
  }, [
    input.activeConversationId,
    input.draftSettingsBySessionIdRef,
    input.onDataChangeRef,
    input.providerComposerOptions,
    input.selectedComposerTargetData,
    input.setDraftSettingsBySessionId,
    storedNodeDefaultSettings,
    targetSafeNodeDefaultSettings
  ]);

  const activeConversationDraftSettings = input.activeConversationId
    ? (input.draftSettingsBySessionId[input.activeConversationId] ?? null)
    : null;
  const draftSettings = useStableComposerSettings(
    resolveComposerSettingsPresentation({
      active: input.activeConversationId !== null,
      homeSettings: homeComposerSettings,
      optimisticSettings: activeConversationDraftSettings,
      options: input.providerComposerOptions,
      permissionModeId: input.activeSessionState?.permissionModeId,
      sessionSettings
    })
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
  const draftReasoningEffort = (
    input.composerSupport.reasoning
      ? normalizeOptionalText(draftSettings.reasoningEffort)
      : null
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
  const presentedReasoningEffort = activeSessionReasoningSelection
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
    const selectedPermissionModeValue =
      normalizePermissionModeId(draftSettings.permissionModeId) ??
      normalizePermissionModeId(permissionConfig?.defaultValue);
    return {
      sessionSettings,
      draftSettings: {
        model: draftModel,
        reasoningEffort: presentedReasoningEffort,
        speed: draftSpeed,
        planMode: Boolean(draftSettings.planMode),
        browserUse: draftSettings.browserUse ?? true,
        computerUse: draftSettings.computerUse ?? true,
        permissionModeId: normalizePermissionModeId(
          draftSettings.permissionModeId
        )
      },
      supportsModel: input.composerSupport.model,
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
      isSettingsLoading: !hasACPSettings,
      isCapabilityOptionsLoading: input.composerOptionsLoading,
      isModelOptionsLoading: isForegroundModelOptionsLoading({
        modelOptionsLoading: input.providerComposerOptions?.modelOptionsLoading,
        selection: activeSessionModelSelection,
        supportsModel: input.composerSupport.model
      }),
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
      selectedModelValue: draftModel,
      selectedReasoningEffortValue: presentedReasoningEffort,
      selectedSpeedValue: draftSpeed,
      selectedPermissionModeValue,
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
      projectLocked: input.activeConversationId !== null,
      projectPathIsRemote: input.agentActivityRuntime.projectPathIsRemote,
      collapseModelOptionsToLatest:
        input.providerComposerOptions?.behavior.collapseModelOptionsToLatest ===
        true,
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
    input.composerOptionsLoading,
    input.composerTargetProvider,
    input.providerComposerOptions,
    input.selectedProjectPath,
    input.userProjects,
    presentedReasoningEffort,
    sessionSettings
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
      .find((project) => project.path.trim() === projectPath)
      ?.sectionKey?.trim() || null
  );
}
