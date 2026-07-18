import type { AgentGUIProps } from "@tutti-os/agent-gui";

export type DesktopAgentGUIHostProps = {
  identity: AgentGUIProps["identity"];
  workspace: Pick<
    AgentGUIProps["workspace"],
    | "path"
    | "fileReferenceAdapter"
    | "onRequestGitBranches"
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
    | "capabilityMenuState"
    | "accountMenuState"
    | "comingSoonProviders"
    | "providerReadinessGates"
    | "defaultAgentTargetId"
    | "providerAuthAccountLabels"
    | "contextMentionProviders"
    | "workspaceAppIcons"
  >;
  hostActions: Pick<
    AgentGUIProps["hostActions"],
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
    | "onEngagementEvent"
    | "onOpenConversationWindow"
  >;
  renderSlots: Pick<AgentGUIProps["renderSlots"], "sidebarFooter">;
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
      newConversationSequence: nextRuntimeRequests.newConversationSequence,
      openSession: nextRuntimeRequests.openSession,
      prefillPrompt: nextRuntimeRequests.prefillPrompt,
      agentProbes: nextRuntimeRequests.agentProbes,
      onProbeDemandChange: nextRuntimeRequests.onProbeDemandChange,
      onProbeRefreshRequest: nextRuntimeRequests.onProbeRefreshRequest
    },
    hostCapabilities: {
      referenceProvenanceFilterEnabled:
        nextHostCapabilities.referenceProvenanceFilterEnabled,
      capabilityMenuState: nextHostCapabilities.capabilityMenuState,
      accountMenuState: nextHostCapabilities.accountMenuState,
      comingSoonProviders: nextHostCapabilities.comingSoonProviders,
      providerReadinessGates: nextHostCapabilities.providerReadinessGates,
      defaultAgentTargetId: nextHostCapabilities.defaultAgentTargetId,
      providerAuthAccountLabels: nextHostCapabilities.providerAuthAccountLabels,
      contextMentionProviders: nextHostCapabilities.contextMentionProviders,
      workspaceAppIcons: nextHostCapabilities.workspaceAppIcons
    },
    hostActions: {
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
      onEngagementEvent: nextHostActions.onEngagementEvent,
      onOpenConversationWindow: nextHostActions.onOpenConversationWindow
    },
    renderSlots: {
      sidebarFooter: nextRenderSlots.sidebarFooter
    }
  };
}
