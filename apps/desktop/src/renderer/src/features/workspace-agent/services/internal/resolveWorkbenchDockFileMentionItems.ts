import type { WorkspaceFilePreviewActivationTarget } from "@tutti-os/workspace-file-preview";
import {
  isWorkspaceFilePreviewActivationTarget,
  isWorkspaceFilePreviewNodeTypeID,
  workspaceFilePreviewActivationType
} from "../../../workspace-workbench/services/workspaceFilePreviewLaunch.ts";
import type {
  WorkbenchDockPreviewCacheKey,
  WorkbenchHostHandle,
  WorkbenchHostNodeData
} from "@tutti-os/workbench-surface";

export interface WorkbenchDockFileMentionItem {
  displayName: string;
  kind: "file";
  path: string;
  previewCacheKey: WorkbenchDockPreviewCacheKey;
}

export function resolveWorkbenchDockFileMentionItems(input: {
  host: Pick<WorkbenchHostHandle, "getSnapshot">;
  workspaceId: string;
}): WorkbenchDockFileMentionItem[] {
  const { host, workspaceId } = input;
  const snapshot = host.getSnapshot();
  const nodesById = new Map(
    snapshot.nodes.map((node) => [
      node.id,
      node as typeof node & { data: WorkbenchHostNodeData }
    ])
  );
  const orderedNodeIds = [
    ...snapshot.nodeStack,
    ...snapshot.nodes
      .map((node) => node.id)
      .filter((nodeId) => !snapshot.nodeStack.includes(nodeId))
  ];
  const seenPaths = new Set<string>();
  const items: WorkbenchDockFileMentionItem[] = [];

  for (const nodeId of orderedNodeIds) {
    const node = nodesById.get(nodeId);
    if (!node || !isWorkspaceFilePreviewNodeTypeID(node.data.typeId)) {
      continue;
    }

    const fileTarget = resolveWorkbenchDockFileTarget(node.data);
    if (!fileTarget) {
      continue;
    }

    const path = fileTarget.path.trim();
    if (!path || seenPaths.has(path)) {
      continue;
    }

    seenPaths.add(path);
    items.push({
      displayName:
        fileTarget.name.trim() ||
        path.split("/").filter(Boolean).at(-1) ||
        path,
      kind: "file",
      path,
      previewCacheKey: {
        instanceId: node.data.instanceId,
        instanceKey: node.data.instanceKey ?? null,
        nodeId: node.id,
        typeId: node.data.typeId,
        workspaceId
      }
    });
  }

  return items;
}

function resolveWorkbenchDockFileTarget(
  nodeData: WorkbenchHostNodeData
): WorkspaceFilePreviewActivationTarget | null {
  for (const value of [nodeData.runtimeNodeState, nodeData.snapshotNodeState]) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const candidate = value as { file?: unknown };
    if (isWorkspaceFilePreviewActivationTarget(candidate.file)) {
      return candidate.file;
    }
  }

  const activation = nodeData.activation;
  if (
    activation?.type === workspaceFilePreviewActivationType &&
    isWorkspaceFilePreviewActivationTarget(activation.payload)
  ) {
    return activation.payload;
  }

  return null;
}
