import {
  agentGuiWorkbenchInstanceId,
  agentGuiWorkbenchProviderFromIdentifier,
  agentGuiWorkbenchProviderFromLaunchRequest,
  agentGuiWorkbenchTypeId,
  agentGuiWorkbenchUnifiedDockEntryId,
  createAgentGuiWorkbenchDraftLaunchRequest,
  createAgentGuiWorkbenchInstanceId,
  createAgentGuiWorkbenchLaunchDescriptor,
  createAgentGuiWorkbenchSessionLaunchRequest
} from "@tutti-os/agent-gui/workbench/launch";

export {
  agentGuiWorkbenchInstanceId as workspaceAgentGuiInstanceId,
  agentGuiWorkbenchProviderFromIdentifier as workspaceAgentGuiProviderFromIdentifier,
  agentGuiWorkbenchProviderFromLaunchRequest as workspaceAgentGuiProviderFromLaunchRequest,
  agentGuiWorkbenchTypeId as workspaceAgentGuiNodeID,
  agentGuiWorkbenchUnifiedDockEntryId as workspaceAgentGuiUnifiedDockEntryId,
  createAgentGuiWorkbenchDraftLaunchRequest as createWorkspaceAgentGuiDraftLaunchRequest,
  createAgentGuiWorkbenchInstanceId as createWorkspaceAgentGuiInstanceId,
  createAgentGuiWorkbenchLaunchDescriptor as createWorkspaceAgentGuiLaunchDescriptor,
  createAgentGuiWorkbenchSessionLaunchRequest as createWorkspaceAgentGuiSessionLaunchRequest
};

export { normalizeAgentGuiWorkbenchProvider as normalizeWorkspaceAgentGuiProvider } from "@tutti-os/agent-gui/workbench/providerCatalog";

export type { AgentGuiWorkbenchLaunchDescriptor as WorkspaceAgentGuiLaunchDescriptor } from "@tutti-os/agent-gui/workbench/launch";

export type { AgentGuiWorkbenchProvider as WorkspaceAgentGuiProvider } from "@tutti-os/agent-gui/workbench/types";
