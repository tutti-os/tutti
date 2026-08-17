import type {
  WorkbenchController,
  WorkbenchHostChromeRenderContext,
  WorkbenchHostNodeData
} from "@tutti-os/workbench-surface";
import {
  agentGuiWorkbenchSelectConnectorActivationType,
  createWorkspaceAgentGuiConnectorLaunchRequest,
  workspaceAgentGuiNodeID
} from "./workspaceAgentGuiLaunch.ts";

interface SelectWorkspaceAgentGuiConnectorInput {
  activateNode: WorkbenchHostChromeRenderContext["activateNode"];
  connectorKey: string;
  controller: WorkbenchController<WorkbenchHostNodeData>;
  focusNode: WorkbenchHostChromeRenderContext["focusNode"];
  launchNode: WorkbenchHostChromeRenderContext["launchNode"];
}

export async function selectWorkspaceAgentGuiConnector(
  input: SelectWorkspaceAgentGuiConnectorInput
): Promise<boolean> {
  const connectorKey = input.connectorKey.trim();
  if (!connectorKey) {
    return false;
  }
  const snapshot = input.controller.getSnapshot();
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const targetNode = [...snapshot.nodeStack]
    .reverse()
    .map((nodeId) => nodeById.get(nodeId))
    .find((node) => node?.data.typeId === workspaceAgentGuiNodeID);
  if (targetNode) {
    input.focusNode(targetNode.id);
    input.activateNode(
      { nodeId: targetNode.id },
      {
        payload: { connectorKey },
        type: agentGuiWorkbenchSelectConnectorActivationType
      }
    );
    return true;
  }
  return (
    (await input.launchNode(
      createWorkspaceAgentGuiConnectorLaunchRequest({ connectorKey })
    )) !== null
  );
}
