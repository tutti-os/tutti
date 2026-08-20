import type { AgentGUIProps } from "@tutti-os/agent-gui";

export type DesktopAgentGUIHostProps = {
  identity: AgentGUIProps["identity"];
  workspace: Pick<
    AgentGUIProps["workspace"],
    | "path"
    | "fileReferenceAdapter"
    | "onRequestGitBranches"
    | "selectProjectDirectory"
    | "resolveExternalPromptEntries"
    | "prepareExternalPromptFiles"
    | "promptAssetLimit"
    | "referenceSourceAggregator"
    | "resolveReferenceEntryIconUrl"
    | "resolveMentionReferenceTarget"
    | "resolveReferenceInitialTarget"
    | "onFileReferencesAdded"
    | "agentSettings"
  >;
  runtimeRequests: AgentGUIProps["runtimeRequests"];
  hostCapabilities: Pick<
    AgentGUIProps["hostCapabilities"],
    | "referenceProvenanceFilterEnabled"
    | "sideConversationEnabled"
    | "sideConversationPresentation"
    | "sessionInputHistoryEnabled"
    | "sessionWorktreeEnabled"
    | "sessionLaunchModesByProjectSectionKey"
    | "codexSaverModeEntryEnabled"
    | "capabilityMenuState"
    | "visibleErrorPresentationOverrides"
    | "comingSoonProviders"
    | "providerReadinessGates"
    | "defaultAgentTargetId"
    | "providerAuthAccountLabels"
    | "mentionService"
    | "workspaceAppIcons"
  >;
  hostActions: Pick<
    AgentGUIProps["hostActions"],
    | "onComposerAppendHandled"
    | "onAgentConfigMenuOpen"
    | "onAgentEnvPanelOpen"
    | "onAgentProviderLogin"
    | "onCapabilitySettingsRequest"
    | "onClose"
    | "onLinkAction"
    | "onHandoffConversation"
    | "onResize"
    | "onShowMessage"
    | "onUpdateNode"
    | "onRememberComposerDefaults"
    | "onSessionLaunchModePreferenceChange"
    | "onEngagementEvent"
    | "onConversationRailLayoutChange"
    | "onOpenConversationWindow"
  >;
  renderSlots: Pick<
    AgentGUIProps["renderSlots"],
    | "agentConfigAccount"
    | "agentConfigSystemActions"
    | "composerFooterAccessory"
    | "sidebarFooter"
  >;
};

export function useStableDesktopAgentGUIHostProps({
  identity: nextIdentity,
  workspace: nextWorkspace,
  runtimeRequests: nextRuntimeRequests,
  hostCapabilities: nextHostCapabilities,
  hostActions: nextHostActions,
  renderSlots: nextRenderSlots
}: DesktopAgentGUIHostProps): DesktopAgentGUIHostProps {
  "use memo";

  return {
    identity: {
      currentUserId: nextIdentity.currentUserId,
      nodeId: nextIdentity.nodeId,
      title: nextIdentity.title,
      workspaceId: nextIdentity.workspaceId
    },
    workspace: {
      path: nextWorkspace.path,
      fileReferenceAdapter: nextWorkspace.fileReferenceAdapter,
      onRequestGitBranches: nextWorkspace.onRequestGitBranches,
      selectProjectDirectory: nextWorkspace.selectProjectDirectory,
      resolveExternalPromptEntries: nextWorkspace.resolveExternalPromptEntries,
      prepareExternalPromptFiles: nextWorkspace.prepareExternalPromptFiles,
      promptAssetLimit: nextWorkspace.promptAssetLimit,
      referenceSourceAggregator: nextWorkspace.referenceSourceAggregator,
      resolveReferenceEntryIconUrl: nextWorkspace.resolveReferenceEntryIconUrl,
      resolveMentionReferenceTarget:
        nextWorkspace.resolveMentionReferenceTarget,
      resolveReferenceInitialTarget:
        nextWorkspace.resolveReferenceInitialTarget,
      onFileReferencesAdded: nextWorkspace.onFileReferencesAdded,
      agentSettings: nextWorkspace.agentSettings
    },
    runtimeRequests: {
      composerAppend: nextRuntimeRequests.composerAppend,
      composerFocusSequence: nextRuntimeRequests.composerFocusSequence,
      workbench: nextRuntimeRequests.workbench,
      openSession: nextRuntimeRequests.openSession,
      prefillPrompt: nextRuntimeRequests.prefillPrompt,
      agentStatusController: nextRuntimeRequests.agentStatusController
    },
    hostCapabilities: {
      referenceProvenanceFilterEnabled:
        nextHostCapabilities.referenceProvenanceFilterEnabled,
      sideConversationEnabled: nextHostCapabilities.sideConversationEnabled,
      sideConversationPresentation:
        nextHostCapabilities.sideConversationPresentation,
      sessionInputHistoryEnabled:
        nextHostCapabilities.sessionInputHistoryEnabled,
      sessionWorktreeEnabled: nextHostCapabilities.sessionWorktreeEnabled,
      sessionLaunchModesByProjectSectionKey:
        nextHostCapabilities.sessionLaunchModesByProjectSectionKey,
      codexSaverModeEntryEnabled:
        nextHostCapabilities.codexSaverModeEntryEnabled,
      capabilityMenuState: nextHostCapabilities.capabilityMenuState,
      visibleErrorPresentationOverrides:
        nextHostCapabilities.visibleErrorPresentationOverrides,
      comingSoonProviders: nextHostCapabilities.comingSoonProviders,
      providerReadinessGates: nextHostCapabilities.providerReadinessGates,
      defaultAgentTargetId: nextHostCapabilities.defaultAgentTargetId,
      providerAuthAccountLabels: nextHostCapabilities.providerAuthAccountLabels,
      mentionService: nextHostCapabilities.mentionService,
      workspaceAppIcons: nextHostCapabilities.workspaceAppIcons
    },
    hostActions: {
      onComposerAppendHandled: nextHostActions.onComposerAppendHandled,
      onAgentConfigMenuOpen: nextHostActions.onAgentConfigMenuOpen,
      onAgentEnvPanelOpen: nextHostActions.onAgentEnvPanelOpen,
      onAgentProviderLogin: nextHostActions.onAgentProviderLogin,
      onCapabilitySettingsRequest: nextHostActions.onCapabilitySettingsRequest,
      onClose: nextHostActions.onClose,
      onLinkAction: nextHostActions.onLinkAction,
      onHandoffConversation: nextHostActions.onHandoffConversation,
      onResize: nextHostActions.onResize,
      onShowMessage: nextHostActions.onShowMessage,
      onUpdateNode: nextHostActions.onUpdateNode,
      onRememberComposerDefaults: nextHostActions.onRememberComposerDefaults,
      onSessionLaunchModePreferenceChange:
        nextHostActions.onSessionLaunchModePreferenceChange,
      onEngagementEvent: nextHostActions.onEngagementEvent,
      onConversationRailLayoutChange:
        nextHostActions.onConversationRailLayoutChange,
      onOpenConversationWindow: nextHostActions.onOpenConversationWindow
    },
    renderSlots: {
      agentConfigAccount: nextRenderSlots.agentConfigAccount,
      agentConfigSystemActions: nextRenderSlots.agentConfigSystemActions,
      composerFooterAccessory: nextRenderSlots.composerFooterAccessory,
      sidebarFooter: nextRenderSlots.sidebarFooter
    }
  };
}
