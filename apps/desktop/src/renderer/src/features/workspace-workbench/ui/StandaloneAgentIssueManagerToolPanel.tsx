import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { IssueManagerNodeState } from "@tutti-os/workspace-issue-manager/contracts";
import {
  defaultIssueManagerWorkbenchTypeId,
  issueManagerTopicSelectorPlacementDataKey
} from "@tutti-os/workspace-issue-manager/workbench/constants";
import type {
  WorkbenchContribution,
  WorkbenchHostNodeBodyContext,
  WorkbenchHostNodeData,
  WorkbenchNode
} from "@tutti-os/workbench-surface";
import { getWorkspaceIssueManagerSurfaceRuntime } from "../services/workspaceIssueManagerSurfaceRuntime.ts";
import type { StandaloneAgentIssueManagerOpenRequest } from "../services/standaloneAgentIssueManagerLaunch.ts";
import { createStandaloneAgentDirectToolHost } from "./standaloneAgentToolWorkbench.ts";

const standaloneAgentIssueManagerNodeId = "issue-manager:standalone-agent-tool";

export function StandaloneAgentIssueManagerToolPanel({
  active,
  activation,
  contributions,
  unavailableLabel,
  workspaceId
}: {
  active: boolean;
  activation: StandaloneAgentIssueManagerOpenRequest["activation"];
  contributions: readonly WorkbenchContribution[] | undefined;
  unavailableLabel: string;
  workspaceId: string;
}): ReactNode {
  const resolved = useMemo(
    () => resolveStandaloneAgentIssueManagerContribution(contributions),
    [contributions]
  );
  const directHost = useMemo(createStandaloneAgentDirectToolHost, []);
  const [externalNodeState, setExternalNodeState] =
    useState<Partial<IssueManagerNodeState> | null>(null);

  useEffect(() => {
    const source = resolved?.contribution.externalStateSource;
    if (!source) {
      setExternalNodeState(null);
      return;
    }
    const updateState = () => {
      setExternalNodeState(
        (source.getNodeState({
          instanceId: standaloneAgentIssueManagerNodeId,
          instanceKey: standaloneAgentIssueManagerNodeId,
          nodeId: standaloneAgentIssueManagerNodeId,
          typeId: defaultIssueManagerWorkbenchTypeId,
          workspaceId
        }) as Partial<IssueManagerNodeState> | null) ?? null
      );
    };
    updateState();
    return source.subscribe?.(updateState);
  }, [resolved, workspaceId]);

  useEffect(() => {
    directHost.setNode(
      resolved
        ? {
            instanceId: standaloneAgentIssueManagerNodeId,
            nodeId: standaloneAgentIssueManagerNodeId,
            title: resolved.definition.title,
            typeId: defaultIssueManagerWorkbenchTypeId
          }
        : null
    );
    return () => directHost.setNode(null);
  }, [directHost, resolved]);

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

  const node: WorkbenchNode<WorkbenchHostNodeData> = {
    data: {
      dockEntryId: defaultIssueManagerWorkbenchTypeId,
      instanceId: standaloneAgentIssueManagerNodeId,
      instanceKey: standaloneAgentIssueManagerNodeId,
      launchSource: activation ? "agent_command" : null,
      typeId: defaultIssueManagerWorkbenchTypeId,
      [issueManagerTopicSelectorPlacementDataKey]: "sidebar"
    } as WorkbenchHostNodeData,
    displayMode: "fullscreen",
    frame: resolved.definition.frame,
    id: standaloneAgentIssueManagerNodeId,
    isMinimized: !active,
    kind: "window",
    restoreFrame: null,
    title: resolved.definition.title
  };
  const context: WorkbenchHostNodeBodyContext = {
    activation,
    displayMode: node.displayMode,
    externalNodeState,
    externalWorkspaceState:
      resolved.contribution.externalStateSource?.getWorkspaceState({
        workspaceId
      }) ?? { workspaceId },
    focus: () => undefined,
    host: directHost.host,
    instanceId: standaloneAgentIssueManagerNodeId,
    instanceKey: standaloneAgentIssueManagerNodeId,
    isDragging: false,
    isFocused: active,
    isResizing: false,
    node,
    setNodeRuntimeState: () => undefined,
    setSnapshotNodeState: () => undefined
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-standalone-agent-issue-manager-surface="true"
    >
      <div className="min-h-0 flex-1 overflow-hidden">
        {resolved.definition.renderBody(context)}
      </div>
    </div>
  );
}

export function resolveStandaloneAgentIssueManagerContribution(
  contributions: readonly WorkbenchContribution[] | undefined
) {
  const contribution = contributions?.find(
    (candidate) => candidate.id === "workspace-issue-manager"
  );
  const definition = contribution?.nodes?.find(
    (candidate) => candidate.typeId === defaultIssueManagerWorkbenchTypeId
  );
  const runtime = contribution
    ? getWorkspaceIssueManagerSurfaceRuntime(contribution)
    : null;
  return contribution && definition && runtime
    ? { contribution, definition, runtime }
    : null;
}
