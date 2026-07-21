import { selectFocusedWorkbenchNode } from "../core/selectors.ts";
import type {
  WorkbenchRenderNodeContext,
  WorkbenchRenderWindowHeader
} from "../react/types.ts";
import {
  readWorkbenchHostExternalState,
  type WorkbenchHostExternalState
} from "./externalState.ts";
import { createWorkbenchHostNodeHeaderWindowActions } from "./windowActions.ts";
import type {
  WorkbenchHostExternalStateSource,
  WorkbenchHostHandle,
  WorkbenchHostNodeBodyContext,
  WorkbenchHostNodeData,
  WorkbenchHostNodeDefinition,
  WorkbenchHostNodeHeaderContext
} from "./types.ts";

export function createWorkbenchHostNodeBodyContext<
  TExternalNodeState,
  TExternalWorkspaceState
>({
  context,
  externalState,
  externalStateSource,
  host,
  workspaceId
}: {
  context: WorkbenchRenderNodeContext<WorkbenchHostNodeData>;
  definition: WorkbenchHostNodeDefinition<
    TExternalNodeState,
    TExternalWorkspaceState
  >;
  externalState?: WorkbenchHostExternalState;
  externalStateSource?: WorkbenchHostExternalStateSource;
  host: WorkbenchHostHandle;
  workspaceId: string;
}): WorkbenchHostNodeBodyContext<TExternalNodeState, TExternalWorkspaceState> {
  const resolvedExternalState =
    externalState ??
    readWorkbenchHostExternalState({
      externalStateSource,
      node: context.node,
      workspaceId
    });
  return {
    activation: context.node.data.activation ?? null,
    displayMode: context.node.displayMode,
    externalNodeState:
      resolvedExternalState.externalNodeState as TExternalNodeState,
    externalWorkspaceState:
      resolvedExternalState.externalWorkspaceState as TExternalWorkspaceState,
    focus() {
      host.focusNode(context.node.id);
    },
    host,
    instanceId: context.node.data.instanceId,
    instanceKey: context.node.data.instanceKey ?? null,
    isDragging: context.isDragging,
    isFocused:
      selectFocusedWorkbenchNode(host.getSnapshot())?.id === context.node.id,
    isResizing: context.isResizing,
    presentationMode: context.layout.presentation?.mode ?? null,
    node: context.node,
    setNodeRuntimeState(state) {
      host.setNodeRuntimeState(context.node.id, state);
    },
    setSnapshotNodeState(state) {
      host.setSnapshotNodeState(context.node.id, state);
    }
  };
}

export function createWorkbenchHostNodeHeaderContext<
  TExternalNodeState,
  TExternalWorkspaceState
>({
  context,
  externalState,
  externalStateSource,
  host,
  workspaceId
}: {
  context: Parameters<WorkbenchRenderWindowHeader<WorkbenchHostNodeData>>[0];
  definition: WorkbenchHostNodeDefinition<
    TExternalNodeState,
    TExternalWorkspaceState
  >;
  externalState?: WorkbenchHostExternalState;
  externalStateSource?: WorkbenchHostExternalStateSource;
  host: WorkbenchHostHandle;
  workspaceId: string;
}): WorkbenchHostNodeHeaderContext<
  TExternalNodeState,
  TExternalWorkspaceState
> {
  const resolvedExternalState =
    externalState ??
    readWorkbenchHostExternalState({
      externalStateSource,
      node: context.node,
      workspaceId
    });

  return {
    activation: context.node.data.activation ?? null,
    defaultActions: context.defaultActions,
    displayMode: context.node.displayMode,
    dragHandleProps: context.dragHandleProps,
    externalNodeState:
      resolvedExternalState.externalNodeState as TExternalNodeState,
    externalWorkspaceState:
      resolvedExternalState.externalWorkspaceState as TExternalWorkspaceState,
    instanceId: context.node.data.instanceId,
    instanceKey: context.node.data.instanceKey ?? null,
    isDragging: context.isDragging,
    isFocused: context.isFocused,
    isResizing: context.isResizing,
    node: context.node,
    surfaceSize: context.surfaceSize,
    windowActions: createWorkbenchHostNodeHeaderWindowActions(context, {
      requestNodeClose: (nodeId) => host.requestNodeClose(nodeId)
    })
  };
}
