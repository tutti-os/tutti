import type {
  AgentActivityComposerOptions,
  AgentActivityModelPlanSummary,
  AgentActivitySession
} from "@tutti-os/agent-activity-core";
import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction
} from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type {
  AgentSessionComposerSettings,
  AgentSessionReasoningEffort,
  AgentSessionSpeed,
  AgentSessionState
} from "../../../shared/agentSessionTypes";
import type {
  AgentGUINodeData,
  AgentGUIProvider,
  AgentGUIAgentTarget,
  AgentGUISharedAgentAccess
} from "../../../types";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type { AgentGUIConversationUserProject } from "../model/agentGuiConversationProjectResolver";
import type { AgentGUIComposerSettingsVM } from "../model/agentGuiNodeTypes";
import {
  aggregateCompatibleModelPlanOptions,
  modelPlanSelectionValue
} from "../model/composerAggregatedModelPlans";
import { resolveAgentGUIProviderCatalogIdentity } from "../../../providerIdentityCatalog";
import { translate } from "../../../i18n/index";
import { defaultPlanIssueBudgetPreset } from "../../../shared/agentConversation/planImplementationPresentation";
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
  isForegroundModelOptionsLoading,
  resolveComposerSettingsPresentation,
  type AgentGUIComposerTargetData
} from "./agentGuiController.composerPresentation";
import { normalizeOptionalText } from "./agentGuiController.promptHelpers";
import { overlayComposerDefaults } from "./agentGuiController.providerHelpers";
import { normalizeAgentGUISharedAgentAccess } from "../../../sharedAgentAccess";
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
  normalizedProviderTargets: readonly AgentGUIAgentTarget[];
  selectedComposerTargetData: AgentGUIComposerTargetData;
  selectedProjectPath: string | null;
  userProjects: readonly AgentGUIConversationUserProject[];
  setDraftSettingsBySessionId: Dispatch<
    SetStateAction<Record<string, AgentSessionComposerSettings>>
  >;
  workspaceId?: string;
}

export function useAgentGUIComposerPresentation(
  input: UseAgentGUIComposerPresentationInput
) {
  const [modelPlans, setModelPlans] = useState<
    readonly AgentActivityModelPlanSummary[]
  >([]);
  useEffect(() => {
    const listModelPlans = input.agentActivityRuntime.listModelPlans;
    const workspaceId = input.workspaceId?.trim() ?? "";
    if (!listModelPlans || !workspaceId) {
      return;
    }
    const abort = new AbortController();
    void listModelPlans({ workspaceId, signal: abort.signal })
      .then((result) => {
        if (!abort.signal.aborted) setModelPlans(result.plans);
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setModelPlans((current) => (current.length === 0 ? current : []));
        }
      });
    return () => abort.abort();
  }, [input.agentActivityRuntime, input.workspaceId]);
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
  const targetSafeNodeDefaultSettings = storedNodeDefaultSettings;
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
  const draftModelPlanId = normalizeOptionalText(draftSettings.modelPlanId);
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
    const target = input.normalizedProviderTargets.find(
      (candidate) =>
        candidate.targetId === input.selectedComposerTargetData.targetId ||
        candidate.agentTargetId ===
          input.selectedComposerTargetData.agentTargetId
    );
    const sharedAccess = normalizeAgentGUISharedAgentAccess(
      target?.ref.sharedAccess as AgentGUISharedAgentAccess | null | undefined
    );
    const protocol =
      resolveAgentGUIProviderCatalogIdentity(input.composerTargetProvider)
        ?.modelPlanProtocol ?? "";
    const aggregateModelOptions = aggregateCompatibleModelPlanOptions({
      activeSession: input.activeConversationId !== null,
      copy: {
        billingApiMetered: translate(
          "agentHost.agentGui.composerModelBillingApiMetered"
        ),
        billingSubscriptionQuota: translate(
          "agentHost.agentGui.composerModelBillingSubscriptionQuota"
        ),
        capabilities: (value) =>
          translate("agentHost.agentGui.composerModelCapabilitiesMetadata", {
            value
          }),
        effectNewSession: translate(
          "agentHost.agentGui.composerModelSwitchNewSessionHint"
        ),
        effectNextCall: translate(
          "agentHost.agentGui.composerModelSwitchNextTurnHint"
        ),
        pricing: (inputPrice, outputPrice) =>
          translate("agentHost.agentGui.composerModelPricingMetadata", {
            input: inputPrice,
            output: outputPrice
          }),
        tier: (value) =>
          translate(
            value === "flagship"
              ? "agentHost.agentGui.composerModelTierFlagship"
              : value === "economy"
                ? "agentHost.agentGui.composerModelTierEconomy"
                : "agentHost.agentGui.composerModelTierStandard"
          )
      },
      currentModelPlanId:
        normalizeOptionalText(sessionSettings?.modelPlanId) ??
        input.providerComposerOptions?.modelPlan?.id ??
        null,
      currentModel:
        normalizeOptionalText(sessionSettings?.model) ??
        activeSessionModelSelection?.currentValue ??
        draftModel,
      plans: modelPlans,
      protocol,
      sharedAccess
    });
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
    const protectedSettings = overlayComposerDefaults(
      {
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
        model: presentedModel,
        modelPlanId: draftModelPlanId,
        reasoningEffort: presentedReasoningEffort,
        speed: presentedSpeed,
        planMode: Boolean(draftSettings.planMode),
        browserUse: draftSettings.browserUse ?? true,
        computerUse: draftSettings.computerUse ?? true,
        permissionModeId: presentedPermissionMode
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
      planIssueBudgetPreset:
        input.data.planIssueBudgetPreset ?? defaultPlanIssueBudgetPreset(),
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
      selectedModelValue:
        presentedModel && draftModelPlanId
          ? modelPlanSelectionValue(draftModelPlanId, presentedModel)
          : presentedModel,
      aggregatedModelPlans: aggregateModelOptions.length > 0,
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
        input.composerSupport.model && aggregateModelOptions.length > 0
          ? aggregateModelOptions
          : input.composerSupport.model &&
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
    draftModelPlanId,
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
    input.normalizedProviderTargets,
    input.providerComposerOptions,
    input.selectedComposerTargetData.agentTargetId,
    input.selectedProjectPath,
    input.userProjects,
    optionsReasoningEffort,
    modelPlans,
    sessionSettings,
    storedNodeDefaultSettings
  ]);

  return {
    draftModel,
    draftReasoningEffort,
    draftSettings,
    draftSpeed,
    sessionSettings,
    modelPlans,
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
