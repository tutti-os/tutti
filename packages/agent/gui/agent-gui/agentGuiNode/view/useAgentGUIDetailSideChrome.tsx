import { useMemo, type ReactNode } from "react";
import type { AgentComposerProps } from "../AgentComposer";
import type { AgentGUIDetailPaneProps } from "./AgentGUINodeView.types";
import type { useAgentGUIDetailSideConversation } from "./useAgentGUIDetailSideConversation";
import {
  projectAgentSideComposerGate,
  projectAgentSideComposerSettings
} from "../model/agentGuiSideComposerPolicy";
import { useTranslation } from "../../../i18n/index";
import {
  AgentGUISideConversationPane,
  type AgentGUISideConversationPaneProps
} from "./AgentGUISideConversationPane";

const EMPTY_WORKSPACE_APP_ICONS: NonNullable<
  AgentComposerProps["workspaceAppIcons"]
> = [];

interface UseAgentGUIDetailSideChromeInput {
  availableSkills: AgentGUISideConversationPaneProps["availableSkills"];
  baseComposerProps: AgentComposerProps;
  controller: ReturnType<typeof useAgentGUIDetailSideConversation>;
  conversationFlowLabels: AgentGUISideConversationPaneProps["conversationFlowLabels"];
  isVisible: boolean;
  loadingLabel: string;
  renderComposerFooterAccessory: AgentGUIDetailPaneProps["renderComposerFooterAccessory"];
}

export function useAgentGUIDetailSideChrome({
  availableSkills,
  baseComposerProps,
  controller,
  conversationFlowLabels,
  isVisible,
  loadingLabel,
  renderComposerFooterAccessory
}: UseAgentGUIDetailSideChromeInput): {
  bottomDockComposerProps: AgentComposerProps;
  sidePane: ReactNode;
} {
  const { t } = useTranslation();
  const {
    active,
    close,
    draftContent,
    entryError,
    focused,
    interactionSubmitting,
    interactivePrompt,
    interrupt,
    setDraftContent,
    setFocused,
    sourceAgentSessionId,
    submitInteraction,
    submitSide
  } = controller;
  const hostFooterAccessory = useMemo(
    () =>
      renderComposerFooterAccessory?.({
        agentSessionId: baseComposerProps.agentSessionId,
        isActive: baseComposerProps.isActive,
        isSendingTurn: baseComposerProps.isSendingTurn,
        isSubmittingPrompt: baseComposerProps.isSubmittingPrompt,
        composerSettings: baseComposerProps.composerSettings,
        selectedAgentTarget: baseComposerProps.selectedAgentTarget
      }) ?? null,
    [
      baseComposerProps.agentSessionId,
      baseComposerProps.composerSettings,
      baseComposerProps.isActive,
      baseComposerProps.isSendingTurn,
      baseComposerProps.isSubmittingPrompt,
      baseComposerProps.selectedAgentTarget,
      renderComposerFooterAccessory
    ]
  );
  const footerAccessory = useMemo(() => {
    if (!entryError && hostFooterAccessory === null) return null;
    return (
      <>
        {entryError ? (
          <span className="text-xs text-destructive">
            {entryError === "content_unsupported"
              ? t("agentHost.agentGui.sideContentUnsupported")
              : t("agentHost.agentGui.sideOperationFailed")}
          </span>
        ) : null}
        {hostFooterAccessory}
      </>
    );
  }, [entryError, hostFooterAccessory, t]);
  const bottomDockComposerProps = useMemo<AgentComposerProps>(
    () => ({ ...baseComposerProps, footerAccessory }),
    [baseComposerProps, footerAccessory]
  );
  const sideComposerProps = useMemo<AgentComposerProps | null>(() => {
    if (!active) return null;
    return {
      workspaceId: baseComposerProps.workspaceId,
      agentSessionId: active.sideAgentSessionId,
      workspacePath: baseComposerProps.workspacePath,
      currentUserId: baseComposerProps.currentUserId,
      provider: baseComposerProps.provider,
      draftContent,
      draftScopeKey: `side:${active.sideAgentSessionId}`,
      inputHistory: [],
      availableCommands: [],
      hasCompactableContext: false,
      compactSupported: false,
      availableSkills: [],
      gate: projectAgentSideComposerGate(active),
      presentationEditorDisabled: false,
      presentationSubmitDisabled: false,
      placeholder: t("agentHost.agentGui.sideInputPlaceholder"),
      composerSettings: projectAgentSideComposerSettings(
        baseComposerProps.composerSettings
      ),
      queuedPrompts: [],
      drainingQueuedPromptId: null,
      workspaceAppIcons: baseComposerProps.workspaceAppIcons,
      selectedAgentTarget: baseComposerProps.selectedAgentTarget,
      agentTargets: [],
      handoffAgentTargets: [],
      providerSelectReadonly: true,
      showStopButton: Boolean(active.activeTurnId),
      stopDisabled: false,
      activePrompt: interactivePrompt,
      activePromptKeyboardShortcutsEnabled:
        baseComposerProps.isActive && focused,
      promptTips: [],
      isInterrupting: false,
      isSendingTurn: Boolean(active.activeTurnId),
      isSubmittingPrompt: interactionSubmitting,
      projectMissingProbeEnabled: false,
      uiLanguage: baseComposerProps.uiLanguage,
      isActive: baseComposerProps.isActive && focused,
      workspaceReferencePickerOpen: false,
      promptImagesSupported: false,
      canGoalControl: false,
      canUploadAttachment: false,
      labels: baseComposerProps.labels,
      workspaceUserProjectI18n: baseComposerProps.workspaceUserProjectI18n,
      capabilityControlsReadOnly: true,
      onDraftContentChange: setDraftContent,
      onSettingsChange: () => {},
      onSubmit: submitSide,
      onSendQueuedPromptNext: () => {},
      onRemoveQueuedPrompt: () => {},
      onEditQueuedPrompt: () => {},
      onInterruptCurrentTurn: interrupt,
      onSubmitInteractivePrompt: submitInteraction,
      onLinkAction: baseComposerProps.onLinkAction
    };
  }, [
    active,
    baseComposerProps,
    draftContent,
    focused,
    interactionSubmitting,
    interactivePrompt,
    interrupt,
    setDraftContent,
    submitInteraction,
    submitSide,
    t
  ]);
  const sidePane =
    active &&
    sideComposerProps &&
    active.sourceAgentSessionId === sourceAgentSessionId ? (
      <AgentGUISideConversationPane
        active={active}
        availableSkills={availableSkills}
        composerProps={sideComposerProps}
        conversationFlowLabels={conversationFlowLabels}
        isVisible={isVisible}
        loadingLabel={loadingLabel}
        workspaceAppIcons={
          baseComposerProps.workspaceAppIcons ?? EMPTY_WORKSPACE_APP_ICONS
        }
        onClose={close}
        onFocusChange={setFocused}
        onLinkAction={baseComposerProps.onLinkAction}
      />
    ) : null;
  return { bottomDockComposerProps, sidePane };
}
