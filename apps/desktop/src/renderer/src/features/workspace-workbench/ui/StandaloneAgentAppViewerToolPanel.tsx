import { useMemo, type ReactNode } from "react";
import {
  createWorkbenchHostLaunchedNodeId,
  type WorkbenchContribution,
  type WorkbenchHostNodeBodyContext,
  type WorkbenchHostNodeData,
  type WorkbenchNode
} from "@tutti-os/workbench-surface";
import {
  findWorkspaceApp,
  resolveWorkspaceAppDisplayName,
  useWorkspaceAppCenterService,
  workspaceAppCenterNodeID,
  workspaceAppDockEntryId,
  workspaceAppWebviewInstanceId,
  workspaceAppWebviewTypeID
} from "@renderer/features/workspace-app-center";
import { createStandaloneAgentDirectToolHost } from "./standaloneAgentToolWorkbench.ts";

export function StandaloneAgentAppViewerToolPanel({
  active,
  appId,
  contributions,
  unavailableLabel,
  workspaceId
}: {
  active: boolean;
  appId: string;
  contributions: readonly WorkbenchContribution[] | undefined;
  unavailableLabel: string;
  workspaceId: string;
}): ReactNode {
  const { service } = useWorkspaceAppCenterService();
  const resolved = resolveStandaloneAgentAppWebviewContribution(contributions);
  const directHost = useMemo(createStandaloneAgentDirectToolHost, []);
  const app = findWorkspaceApp(service, appId);

  if (!resolved) {
    return (
      <div
        className="flex h-full min-h-0 items-center justify-center text-sm text-[var(--text-secondary)]"
        role="status"
      >
        {unavailableLabel}
      </div>
    );
  }

  const instanceId = workspaceAppWebviewInstanceId(appId);
  const nodeId = createWorkbenchHostLaunchedNodeId({
    instanceId,
    typeId: workspaceAppWebviewTypeID
  });
  const title = app
    ? resolveWorkspaceAppDisplayName(app)
    : resolved.definition.title;
  const node: WorkbenchNode<WorkbenchHostNodeData> = {
    data: {
      dockEntryId: workspaceAppDockEntryId(appId),
      instanceId,
      instanceKey: instanceId,
      typeId: workspaceAppWebviewTypeID
    },
    displayMode: "fullscreen",
    frame: resolved.definition.frame,
    id: nodeId,
    isMinimized: !active,
    kind: "window",
    restoreFrame: null,
    title
  };
  const lookup = {
    instanceId,
    instanceKey: instanceId,
    nodeId,
    typeId: workspaceAppWebviewTypeID,
    workspaceId
  };
  const context: WorkbenchHostNodeBodyContext = {
    activation: null,
    displayMode: node.displayMode,
    externalNodeState:
      resolved.contribution.externalStateSource?.getNodeState(lookup) ?? null,
    externalWorkspaceState:
      resolved.contribution.externalStateSource?.getWorkspaceState({
        workspaceId
      }) ?? null,
    focus: () => undefined,
    host: directHost.host,
    instanceId,
    instanceKey: instanceId,
    isDragging: false,
    isFocused: active,
    isResizing: false,
    node,
    setNodeRuntimeState: () => undefined,
    setSnapshotNodeState: () => undefined
  };

  return (
    <div
      className="h-full min-h-0 w-full overflow-hidden"
      data-standalone-agent-app-viewer-surface="true"
    >
      {resolved.definition.renderBody(context)}
    </div>
  );
}

function resolveStandaloneAgentAppWebviewContribution(
  contributions: readonly WorkbenchContribution[] | undefined
) {
  const contribution = contributions?.find(
    (candidate) => candidate.id === workspaceAppCenterNodeID
  );
  const definition = contribution?.nodes?.find(
    (candidate) => candidate.typeId === workspaceAppWebviewTypeID
  );
  return contribution && definition ? { contribution, definition } : null;
}
