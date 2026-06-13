export {
  agentGuiWorkbenchOpenSessionActivationType as desktopAgentGUIOpenSessionActivationType,
  type AgentGuiWorkbenchComposerOverridesByProvider as DesktopAgentGUIComposerOverridesByProvider,
  type AgentGuiWorkbenchComposerOverrides as DesktopAgentGUIComposerOverrides,
  type AgentGuiWorkbenchNodeState as DesktopAgentGUINodeState,
  type AgentGuiWorkbenchProvider as DesktopAgentGUIProvider,
  type AgentGuiWorkbenchState as DesktopAgentGUIWorkbenchState,
  type AgentGuiWorkbenchWorkspaceState as DesktopAgentGUIWorkspaceState
} from "@tutti-os/agent-gui/workbench/types";

export {
  isAgentGuiWorkbenchProvider as isDesktopAgentGUIProvider,
  normalizeAgentGuiWorkbenchProvider as normalizeDesktopAgentGUIProvider
} from "@tutti-os/agent-gui/workbench/providerCatalog";

export {
  agentGuiWorkbenchProviderFromInstanceId as desktopAgentGUIProviderFromInstanceId,
  areAgentGuiWorkbenchNodeStatesEqual as areDesktopAgentGUINodeStatesEqual,
  areAgentGuiWorkbenchStatesEqual as areDesktopAgentGUIWorkbenchStatesEqual,
  createAgentGuiWorkbenchNodeStateSource as createDesktopAgentGUINodeStateSource,
  createDefaultAgentGuiWorkbenchNodeState as createDefaultDesktopAgentGUINodeState,
  normalizeAgentGuiWorkbenchNodeState as normalizeDesktopAgentGUINodeState,
  normalizeAgentGuiWorkbenchState as normalizeDesktopAgentGUIWorkbenchState,
  projectAgentGuiWorkbenchState as projectDesktopAgentGUIWorkbenchState
} from "@tutti-os/agent-gui/workbench/state";
