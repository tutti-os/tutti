import {
  isPendingActivationViable,
  selectLatestActivationForSession,
  selectTuttiModeDraftIsActive,
  selectTuttiModeDraftOrchestrationIntensity
} from "@tutti-os/agent-activity-core";
import { useCallback } from "react";
import { translate } from "../../../i18n/index";
import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
import { deriveAgentGUIOptimisticConversationTitle } from "../../../shared/agentConversationTitleProjection";
import type { AgentSessionComposerSettings } from "../../../shared/agentSessionTypes";
import {
  agentPromptContentDisplayText,
  emptyAgentComposerDraft,
  normalizeAgentPromptContentBlocks,
  snapshotAgentComposerDraft,
  textPromptContent
} from "../model/agentComposerDraft";
import { readNodeDefaultDraftSettings } from "./agentGuiController.composerHelpers";
import {
  enforceComposerModelBindingForCreate,
  resolveComposerSettingsPresentation,
  sanitizeComposerSettingsForTarget
} from "./agentGuiController.composerPresentation";
import {
  resolveSameProviderActiveSessionModelBinding,
  toRuntimeSendContent
} from "./agentGuiController.draftMessageHelpers";
import {
  createAgentGUIConversationId,
  normalizeOptionalPrompt,
  normalizeOptionalText
} from "./agentGuiController.promptHelpers";
import {
  agentSubmitTraceDiagnostics,
  createAgentSubmitTraceState,
  reportAgentSubmitTraceDiagnostic
} from "./agentGuiController.reporting";
import { draftAgentSessionIdFromComposerOptions } from "./agentGuiController.stableHelpers";
import { resolveConversationSummaryById } from "./useAgentConversationSelection";
import {
  type AgentGUINewConversationActivationResult,
  type UseAgentGUINewConversationActivationInput
} from "./agentGuiNewConversationActivation.types";
import { resolveAgentComposerDraftScopeKey } from "../model/agentComposerDraftScope";
import type { AgentComposerSubmitOptions } from "../composer/AgentComposer.types";

export function useAgentGUINewConversationActivation(
  input: UseAgentGUINewConversationActivationInput
) {
  const {
    getCachedComposerOptions,
    selectedAgentTargetRef,
    selectedComposerTargetDataRef,
    agentTargetsProvidedRef,
    selectedAgentTargetIsExplicitRef,
    setDetailError,
    isCreatingConversationRef,
    onDataChangeRef,
    selectedProjectPathRef,
    draftByScopeKeyRef,
    submittedDraftSnapshotsRef,
    draftSettingsBySessionIdRef,
    agentActivityRuntime,
    workspaceId,
    activeConversationIdRef,
    isComposerHomeRef,
    conversationsRef,
    activeSessionState,
    lastActiveModelByProviderRef,
    sessionEngine,
    tuttiModeDraftKey,
    activation,
    currentUserId,
    data,
    defaultReasoningEffort,
    syncConversationListProjection,
    loadSelectedConversationMessages,
    loadSessionState,
    refreshMessagesFromSnapshot,
    persistActiveConversation,
    requestRailReveal,
    setActiveConversationId,
    setIntent,
    setIsComposerHome,
    setIsLoadingMessages,
    conversationListQuery,
    isCurrentConversation,
    isConversationStale
  } = input;
  const startConversation = useCallback(
    (
      initialContentInput?: unknown,
      displayPrompt?: string,
      submitOptions?: AgentComposerSubmitOptions,
      initialTurnExpectedOrSettings?: boolean | AgentSessionComposerSettings,
      sourceScopeKeyOverride?: string
    ): AgentGUINewConversationActivationResult | null => {
      const target = selectedAgentTargetRef.current;
      const targetData = selectedComposerTargetDataRef.current;
      if (target.disabled === true) {
        return null;
      }
      const agentTargetId = targetData.agentTargetId ?? "";
      if (
        !agentTargetId ||
        (agentTargetsProvidedRef.current &&
          !selectedAgentTargetIsExplicitRef.current)
      ) {
        setDetailError(translate("agentHost.agentGui.agentTargetRequired"));
        return null;
      }
      const normalizedInitialContent = Array.isArray(initialContentInput)
        ? normalizeAgentPromptContentBlocks(
            initialContentInput as AgentPromptContentBlock[]
          )
        : textPromptContent(normalizeOptionalPrompt(initialContentInput));
      const initialDisplayPrompt =
        displayPrompt && displayPrompt.trim() ? displayPrompt : undefined;
      // bundle 折叠时,标题/回显用 displayPrompt(单 chip),而非展开后的文件列表。
      const normalizedInitialPrompt =
        initialDisplayPrompt ??
        agentPromptContentDisplayText(normalizedInitialContent);
      isCreatingConversationRef.current = true;
      setDetailError(null);
      const provider = targetData.provider;
      onDataChangeRef.current((current) =>
        current.provider === provider &&
        (current.agentTargetId ?? null) === agentTargetId
          ? current
          : {
              ...current,
              provider,
              agentTargetId
            }
      );
      const selectedProjectPath = selectedProjectPathRef.current;
      const initialNodeSettings = readNodeDefaultDraftSettings({
        data: targetData.data,
        defaultReasoningEffort,
        drafts: draftSettingsBySessionIdRef.current
      });
      const snapshotComposerOptions = getCachedComposerOptions();
      // Only sparse, explicit home intent crosses Create. Target defaults and
      // final provider validation are resolved from the latest daemon state.
      const initialTurnExpected =
        typeof initialTurnExpectedOrSettings === "boolean"
          ? initialTurnExpectedOrSettings
          : undefined;
      const settingsOverride =
        typeof initialTurnExpectedOrSettings === "object"
          ? initialTurnExpectedOrSettings
          : undefined;
      const targetSafeInitialSettings = sanitizeComposerSettingsForTarget({
        settings: initialNodeSettings,
        target: targetData,
        options: snapshotComposerOptions
      });
      const initialSettings = resolveComposerSettingsPresentation({
        active: false,
        homeSettings: targetSafeInitialSettings,
        options: snapshotComposerOptions
      });
      const overriddenInitialSettings = settingsOverride
        ? { ...initialSettings, ...settingsOverride }
        : initialSettings;
      const currentActiveConversationId = activeConversationIdRef.current;
      const currentActiveConversation = currentActiveConversationId
        ? resolveConversationSummaryById(
            conversationsRef.current,
            currentActiveConversationId
          )
        : null;
      // Inherit the previous model only as a full {model, modelPlanId}
      // binding; a bare id stripped of its plan is exactly the cross-plan
      // leak that fails provider-native creates.
      const inheritedBinding =
        normalizeOptionalText(overriddenInitialSettings.model) === null
          ? (resolveSameProviderActiveSessionModelBinding({
              activeProvider: currentActiveConversation?.provider ?? null,
              agentSessionId: currentActiveConversationId,
              provider,
              runtime: agentActivityRuntime,
              sessionState: activeSessionState,
              workspaceId
            }) ??
            lastActiveModelByProviderRef.current[provider] ??
            null)
          : null;
      const settings = enforceComposerModelBindingForCreate(
        sanitizeComposerSettingsForTarget({
          settings:
            inheritedBinding === null
              ? {
                  ...overriddenInitialSettings,
                  ...submitOptions?.requiredSettingsPatch
                }
              : {
                  ...overriddenInitialSettings,
                  model: inheritedBinding.model,
                  modelPlanId: inheritedBinding.modelPlanId,
                  ...submitOptions?.requiredSettingsPatch
                },
          target: targetData,
          options: snapshotComposerOptions
        }),
        snapshotComposerOptions
      );
      const prewarmedSessionId =
        normalizedInitialContent.length > 0 &&
        snapshotComposerOptions?.behavior?.prewarmDraftSession === true
          ? draftAgentSessionIdFromComposerOptions(snapshotComposerOptions)
          : null;
      const agentSessionId =
        prewarmedSessionId &&
        activation.stateFor(prewarmedSessionId) === "inactive" &&
        isPendingActivationViable(
          selectLatestActivationForSession(
            sessionEngine.getSnapshot(),
            prewarmedSessionId
          )
        )
          ? prewarmedSessionId
          : createAgentGUIConversationId();
      const submitTrace = createAgentSubmitTraceState({
        agentSessionId,
        content: normalizedInitialContent,
        prompt: normalizedInitialPrompt,
        queued: false,
        startedAtUnixMs: Date.now()
      });
      const sourceScopeKey =
        sourceScopeKeyOverride ?? resolveAgentComposerDraftScopeKey({});
      const submittedDraft =
        draftByScopeKeyRef.current[sourceScopeKey] ?? emptyAgentComposerDraft();
      submittedDraftSnapshotsRef.current[submitTrace.clientSubmitId] = {
        sourceScopeKey,
        content: snapshotAgentComposerDraft(submittedDraft)
      };
      reportAgentSubmitTraceDiagnostic({
        event: "activation.requested",
        runtime: agentActivityRuntime,
        trace: submitTrace,
        workspaceId,
        fields: { mode: "new" }
      });
      const initialTuttiModeActive = selectTuttiModeDraftIsActive(
        sessionEngine.getSnapshot(),
        tuttiModeDraftKey
      );
      const initialTuttiModeOrchestrationIntensity =
        selectTuttiModeDraftOrchestrationIntensity(
          sessionEngine.getSnapshot(),
          tuttiModeDraftKey
        );
      const requestId = activation.activate({
        mode: "new",
        agentSessionId,
        agentTargetId,
        ...(submitOptions?.automationRuleOverride
          ? { automationRuleOverride: submitOptions.automationRuleOverride }
          : {}),
        ...(submitOptions?.capabilityRefs?.length
          ? { capabilityRefs: submitOptions.capabilityRefs }
          : {}),
        clientSubmitId: submitTrace.clientSubmitId,
        cwd: selectedProjectPath ?? "",
        initialContent: normalizedInitialContent,
        ...(initialTurnExpected !== undefined ? { initialTurnExpected } : {}),
        initialDisplayPrompt,
        ...(initialTuttiModeActive
          ? {
              initialTuttiModeActivation: {
                source: "slash_command" as const,
                status: "active" as const,
                ...(initialTuttiModeOrchestrationIntensity === null
                  ? {}
                  : {
                      orchestrationIntensity:
                        initialTuttiModeOrchestrationIntensity
                    })
              },
              tuttiModeDraftKey
            }
          : {}),
        runtimeContent: toRuntimeSendContent(normalizedInitialContent),
        submitDiagnostics: agentSubmitTraceDiagnostics(submitTrace),
        settings,
        optimisticTitle: deriveAgentGUIOptimisticConversationTitle(
          normalizedInitialPrompt
        )
      });
      if (requestId === null) return null;
      activeConversationIdRef.current = agentSessionId;
      setActiveConversationId(agentSessionId);
      requestRailReveal(agentSessionId, "created");
      isComposerHomeRef.current = false;
      setIsComposerHome(false);
      setIntent({ tag: "active", id: agentSessionId });
      setIsLoadingMessages(false);
      persistActiveConversation(agentSessionId, agentTargetId);
      return { agentSessionId, requestId };
    },
    [
      activeSessionState,
      currentUserId,
      data,
      defaultReasoningEffort,
      syncConversationListProjection,
      loadSelectedConversationMessages,
      loadSessionState,
      refreshMessagesFromSnapshot,
      persistActiveConversation,
      requestRailReveal,
      activation,
      conversationListQuery,
      isCurrentConversation,
      agentActivityRuntime,
      isConversationStale,
      sessionEngine,
      tuttiModeDraftKey,
      workspaceId
    ]
  );

  return startConversation;
}
