import {
  type AgentActivityInitialGoalControl,
  isPendingActivationViable,
  selectLatestActivationForSession,
  selectTuttiModeDraftIsActive
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
import { toRuntimeSendContent } from "./agentGuiController.draftMessageHelpers";
import {
  createAgentGUIConversationId,
  normalizeOptionalPrompt
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
import { resolveAgentComposerDraftScopeKey } from "../model/agentComposerDraftScope";
import { resolveAgentGUIConversationProject } from "../model/agentGuiConversationProjectResolver";
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
    userProjectsRef,
    draftByScopeKeyRef,
    submittedDraftSnapshotsRef,
    draftSettingsBySessionIdRef,
    agentActivityRuntime,
    workspaceId,
    activeConversationIdRef,
    isComposerHomeRef,
    activeSessionState,
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
      initialTurnExpected?: boolean,
      initialGoalControl?: AgentActivityInitialGoalControl
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
      const selectedProject = resolveAgentGUIConversationProject(
        selectedProjectPath,
        userProjectsRef.current
      );
      const railSectionKey = !selectedProjectPath?.trim()
        ? "conversations"
        : selectedProject?.sectionKey?.trim() || undefined;
      const initialNodeSettings = readNodeDefaultDraftSettings({
        data: targetData.data,
        defaultReasoningEffort,
        drafts: draftSettingsBySessionIdRef.current
      });
      const snapshotComposerOptions = getCachedComposerOptions();
      // Only sparse, explicit home intent crosses Create. Target defaults and
      // final provider validation are resolved from the latest daemon state.
      const settings = {
        ...initialNodeSettings,
        ...submitOptions?.requiredSettingsPatch
      };
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
      const initialTuttiModeActive = selectTuttiModeDraftIsActive(
        sessionEngine.getSnapshot(),
        tuttiModeDraftKey
      );
      const requestId = activation.activate({
        mode: "new",
        agentSessionId,
        agentTargetId,
        ...(submitOptions?.capabilityRefs?.length
          ? { capabilityRefs: submitOptions.capabilityRefs }
          : {}),
        clientSubmitId: submitTrace.clientSubmitId,
        cwd: selectedProjectPath ?? "",
        ...(railSectionKey ? { railSectionKey } : {}),
        initialContent: normalizedInitialContent,
        ...(initialTurnExpected !== undefined ? { initialTurnExpected } : {}),
        ...(initialGoalControl ? { initialGoalControl } : {}),
        initialDisplayPrompt,
        ...(initialTuttiModeActive
          ? {
              initialTuttiModeActivation: {
                source: "slash_command" as const,
                status: "active" as const
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
