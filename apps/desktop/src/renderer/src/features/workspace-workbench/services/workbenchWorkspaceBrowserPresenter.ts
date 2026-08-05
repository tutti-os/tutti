import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import {
  type WorkspaceBrowserLaunchHandler,
  type WorkspaceBrowserLaunchRequest
} from "./workspaceBrowserLaunchCoordinator.ts";
import { workspaceBrowserNodeID } from "./workspaceWorkbenchNodeIds.ts";

export function createWorkbenchWorkspaceBrowserPresenter(input: {
  host: WorkbenchHostHandle;
}): WorkspaceBrowserLaunchHandler {
  return (request) => presentWorkspaceBrowser(input.host, request);
}

async function presentWorkspaceBrowser(
  host: WorkbenchHostHandle,
  request: WorkspaceBrowserLaunchRequest
): Promise<string | null> {
  const preferredNodeId =
    request.kind === "focus"
      ? resolveWorkspaceBrowserNodeId(host, request.preferredNodeId)
      : null;
  if (
    request.kind === "focus" &&
    request.fallbackToCurrent === false &&
    !preferredNodeId
  ) {
    return null;
  }
  const existingNodeId =
    request.kind === "open" && request.reuseIfOpen === false
      ? null
      : (preferredNodeId ?? resolveCurrentWorkspaceBrowserNodeId(host));
  const nodeId =
    existingNodeId ??
    (await host.launchNode({
      launchSource: request.kind === "open" ? request.source : "agent_command",
      reason: "host",
      typeId: workspaceBrowserNodeID
    }));
  if (!nodeId) {
    return null;
  }

  if (request.kind === "focus") {
    host.focusNode(nodeId);
    return nodeId;
  }

  host.activateNode(
    { nodeId },
    {
      payload: {
        url: request.url
      },
      type: "open-url"
    }
  );
  return nodeId;
}

function resolveWorkspaceBrowserNodeId(
  host: WorkbenchHostHandle,
  nodeId: string | null | undefined
): string | null {
  const normalizedNodeId = nodeId?.trim() ?? "";
  if (!normalizedNodeId) {
    return null;
  }
  const node = host
    .getSnapshot()
    .nodes.find((candidate) => candidate.id === normalizedNodeId);
  return node?.data.typeId === workspaceBrowserNodeID ? node.id : null;
}

function resolveCurrentWorkspaceBrowserNodeId(
  host: WorkbenchHostHandle
): string | null {
  const snapshot = host.getSnapshot();
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  for (const nodeId of [...snapshot.nodeStack].reverse()) {
    const node = nodesById.get(nodeId);
    if (node?.data.typeId === workspaceBrowserNodeID) {
      return node.id;
    }
  }

  return (
    snapshot.nodes.find((node) => node.data.typeId === workspaceBrowserNodeID)
      ?.id ?? null
  );
}
