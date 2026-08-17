import {
  agentGuiWorkbenchOpenSessionActivationType,
  agentGuiWorkbenchSelectConnectorActivationType
} from "@tutti-os/agent-gui/workbench/types";
import {
  agentGuiWorkbenchProviderFromLaunchRequest,
  agentGuiWorkbenchTypeId,
  agentGuiWorkbenchUnifiedDockEntryId,
  createAgentGuiWorkbenchDraftLaunchRequest,
  createAgentGuiWorkbenchConnectorLaunchRequest,
  createAgentGuiWorkbenchInstanceId,
  createAgentGuiWorkbenchLaunchDescriptor,
  createAgentGuiWorkbenchSessionLaunchRequest
} from "@tutti-os/agent-gui/workbench/launch";

export {
  agentGuiWorkbenchOpenSessionActivationType,
  agentGuiWorkbenchSelectConnectorActivationType,
  agentGuiWorkbenchProviderFromLaunchRequest as workspaceAgentGuiProviderFromLaunchRequest,
  agentGuiWorkbenchTypeId as workspaceAgentGuiNodeID,
  agentGuiWorkbenchUnifiedDockEntryId as workspaceAgentGuiUnifiedDockEntryId,
  createAgentGuiWorkbenchDraftLaunchRequest as createWorkspaceAgentGuiDraftLaunchRequest,
  createAgentGuiWorkbenchConnectorLaunchRequest as createWorkspaceAgentGuiConnectorLaunchRequest,
  createAgentGuiWorkbenchInstanceId as createWorkspaceAgentGuiInstanceId,
  createAgentGuiWorkbenchLaunchDescriptor as createWorkspaceAgentGuiLaunchDescriptor,
  createAgentGuiWorkbenchSessionLaunchRequest as createWorkspaceAgentGuiSessionLaunchRequest
};

export { normalizeAgentGuiWorkbenchProvider as normalizeWorkspaceAgentGuiProvider } from "@tutti-os/agent-gui/workbench/providerCatalog";

export type { AgentGuiWorkbenchLaunchDescriptor as WorkspaceAgentGuiLaunchDescriptor } from "@tutti-os/agent-gui/workbench/launch";

export type { AgentGuiWorkbenchProvider as WorkspaceAgentGuiProvider } from "@tutti-os/agent-gui/workbench/types";
