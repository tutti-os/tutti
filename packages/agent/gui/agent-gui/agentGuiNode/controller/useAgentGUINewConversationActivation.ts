import {
  isPendingActivationViable,
  selectLatestActivationForSession
} from "@tutti-os/agent-activity-core";
import { useCallback } from "react";
import { translate } from "../../../i18n/index";
import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
import { deriveAgentGUIOptimisticConversationTitle } from "../../../shared/agentConversationTitleProjection";
import {
  agentPromptContentDisplayText,
  emptyAgentComposerDraft,
  normalizeAgentPromptContentBlocks,
  snapshotAgentComposerDraft,
  textPromptContent
} from "../model/agentComposerDraft";
import { readNodeDefaultDraftSettings } from "./agentGuiController.composerHelpers";
import {
  resolveComposerSettingsPresentation,
  sanitizeComposerSettingsForTarget
} from "./agentGuiController.composerPresentation";
import {
  resolveSameProviderActiveSessionModel,
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
import {
  type AgentGUINewConversationActivationResult,
  type UseAgentGUINewConversationActivationInput
} from "./agentGuiNewConversationActivation.types";
import { resolveConversationSummaryById } from "./useAgentConversationSelection";
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
    activation,
    currentUserId,
    data,
    defaultReasoningEffort,
    syncConversationListProjection,
    loadSelectedConversationMessages,
    loadSessionState,
    refreshMessagesFromSnapshot,
    persistActiveConversation,
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
      initialTurnExpected?: boolean
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
      const currentActiveConversationId = activeConversationIdRef.current;
      const currentActiveConversation = currentActiveConversationId
        ? resolveConversationSummaryById(
            conversationsRef.current,
            currentActiveConversationId
          )
        : null;
      const inheritedModel =
        normalizeOptionalText(targetSafeInitialSettings.model) === null
          ? (resolveSameProviderActiveSessionModel({
              activeProvider: currentActiveConversation?.provider ?? null,
              agentSessionId: currentActiveConversationId,
              provider,
              runtime: agentActivityRuntime,
              sessionState: activeSessionState,
              workspaceId
            }) ??
            normalizeOptionalText(
              lastActiveModelByProviderRef.current[provider]
            ))
          : null;
      const settings = sanitizeComposerSettingsForTarget({
        settings:
          inheritedModel === null
            ? {
                ...initialSettings,
                ...submitOptions?.requiredSettingsPatch
              }
            : {
                ...initialSettings,
                model: inheritedModel,
                ...submitOptions?.requiredSettingsPatch
              },
        target: targetData,
        options: snapshotComposerOptions
      });
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
      const sourceScopeKey = resolveAgentComposerDraftScopeKey({});
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
      const requestId = activation.activate({
        mode: "new",
        agentSessionId,
        agentTargetId,
        clientSubmitId: submitTrace.clientSubmitId,
        cwd: selectedProjectPath ?? "",
        initialContent: normalizedInitialContent,
        ...(initialTurnExpected !== undefined ? { initialTurnExpected } : {}),
        initialDisplayPrompt,
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
      isComposerHomeRef.current = false;
      setIsComposerHome(false);
      setIntent({ tag: "active", id: agentSessionId });
      setIsLoadingMessages(false);
      persistActiveConversation(agentSessionId);
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
      activation,
      conversationListQuery,
      isCurrentConversation,
      agentActivityRuntime,
      isConversationStale,
      workspaceId
    ]
  );

  return startConversation;
}
