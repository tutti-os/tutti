import { selectLatestActivationForSession } from "@tutti-os/agent-activity-core";
import { useCallback } from "react";
import { AGENT_PROVIDER_LABEL } from "../../../contexts/settings/domain/agentSettings";
import { translate } from "../../../i18n/index";
import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
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
import { type UseAgentGUINewConversationActivationInput } from "./agentGuiNewConversationActivation.types";
import { resolveConversationSummaryById } from "./useAgentConversationSelection";
import { resolveAgentComposerDraftScopeKey } from "../model/agentComposerDraftScope";

export function useAgentGUINewConversationActivation(
  input: UseAgentGUINewConversationActivationInput
) {
  const {
    getCachedComposerOptions,
    selectedAgentTargetRef,
    selectedComposerTargetDataRef,
    latestPendingNewActivation,
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
    conversationListQuery,
    isCurrentConversation,
    isConversationStale
  } = input;
  const startConversation = useCallback(
    (initialContentInput?: unknown, displayPrompt?: string) => {
      const target = selectedAgentTargetRef.current;
      const targetData = selectedComposerTargetDataRef.current;
      if (latestPendingNewActivation !== null || target.disabled === true) {
        return;
      }
      const agentTargetId = targetData.agentTargetId ?? "";
      if (
        !agentTargetId ||
        (agentTargetsProvidedRef.current &&
          !selectedAgentTargetIsExplicitRef.current)
      ) {
        setDetailError(translate("agentHost.agentGui.agentTargetRequired"));
        return;
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
      const initialConversationTitle =
        normalizedInitialPrompt || AGENT_PROVIDER_LABEL[targetData.provider];
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
            ? initialSettings
            : { ...initialSettings, model: inheritedModel },
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
        activation.stateFor(prewarmedSessionId) !== "active" &&
        selectLatestActivationForSession(
          sessionEngine.getSnapshot(),
          prewarmedSessionId
        )?.status !== "failed"
          ? prewarmedSessionId
          : createAgentGUIConversationId();
      const submitTrace = createAgentSubmitTraceState({
        agentSessionId,
        content: normalizedInitialContent,
        prompt: normalizedInitialPrompt,
        queued: false,
        startedAtUnixMs: Date.now()
      });
      const sourceScopeKey = resolveAgentComposerDraftScopeKey({
        projectPath: selectedProjectPath
      });
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
      activation.activate({
        mode: "new",
        agentSessionId,
        agentTargetId,
        clientSubmitId: submitTrace.clientSubmitId,
        cwd: selectedProjectPath ?? "",
        initialContent: toRuntimeSendContent(normalizedInitialContent),
        initialDisplayPrompt,
        submitDiagnostics: agentSubmitTraceDiagnostics(submitTrace),
        title: initialConversationTitle,
        settings
      });
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
      latestPendingNewActivation,
      workspaceId
    ]
  );

  return startConversation;
}
