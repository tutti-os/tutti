import type { IssueManagerNodeState } from "@tutti-os/workspace-issue-manager/contracts";
import type { IssueManagerExternalWorkspaceState } from "@tutti-os/workspace-issue-manager/workbench";
import type {
  WorkbenchHostExternalStateLookupInput,
  WorkbenchHostExternalStateSource
} from "@tutti-os/workbench-surface";

export interface DesktopIssueManagerWorkspaceState extends IssueManagerExternalWorkspaceState {
  workspaceId: string;
}

type DesktopIssueManagerRestorableNodeState = Pick<
  IssueManagerNodeState,
  | "issueSearchQuery"
  | "issueStatusFilter"
  | "selectedAgentTargetId"
  | "selectedExecutionDirectory"
  | "selectedIssueId"
  | "taskListCollapsed"
>;

type DesktopIssueManagerLiveNodeState = DesktopIssueManagerRestorableNodeState &
  Pick<IssueManagerNodeState, "selectedTaskId">;

export function createDesktopIssueManagerNodeStateSource(input: {
  defaultAgentProvider?: string | null;
  workspaceId: string;
}): {
  externalStateSource: WorkbenchHostExternalStateSource<
    Partial<IssueManagerNodeState> | null,
    DesktopIssueManagerWorkspaceState
  >;
  writeNodeState: (
    request: Pick<
      WorkbenchHostExternalStateLookupInput,
      "instanceId" | "typeId"
    > & { state: IssueManagerNodeState }
  ) => void;
} {
  const nodeStateByInstanceId = new Map<
    string,
    DesktopIssueManagerLiveNodeState
  >();
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    externalStateSource: {
      getNodeState(request) {
        if (request.typeId !== "issue-manager") {
          return null;
        }
        const state = nodeStateByInstanceId.get(request.instanceId);
        return state
          ? { ...state }
          : defaultIssueManagerNodeState(input.defaultAgentProvider);
      },
      getSnapshotNodeState(request) {
        if (request.typeId !== "issue-manager") {
          return null;
        }
        const state = nodeStateByInstanceId.get(request.instanceId);
        return state ? restorableIssueManagerNodeState(state) : null;
      },
      getWorkspaceState() {
        return {
          workspaceId: input.workspaceId
        };
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }
    },
    writeNodeState(request) {
      if (request.typeId !== "issue-manager") {
        return;
      }
      const previous = nodeStateByInstanceId.get(request.instanceId);
      const next = liveIssueManagerNodeState(request.state);
      nodeStateByInstanceId.set(request.instanceId, next);
      if (previous && areIssueManagerLiveNodeStatesEqual(previous, next)) {
        return;
      }
      notify();
    }
  };
}

function defaultIssueManagerNodeState(
  defaultAgentProvider: string | null | undefined
): Partial<IssueManagerNodeState> | null {
  const provider = defaultAgentProvider?.trim() ?? "";
  return provider ? { selectedAgentTargetId: `local:${provider}` } : null;
}

function liveIssueManagerNodeState(
  state: IssueManagerNodeState
): DesktopIssueManagerLiveNodeState {
  return {
    issueSearchQuery: state.issueSearchQuery,
    issueStatusFilter: state.issueStatusFilter,
    selectedAgentTargetId: state.selectedAgentTargetId,
    selectedExecutionDirectory: state.selectedExecutionDirectory ?? null,
    selectedIssueId: state.selectedIssueId,
    selectedTaskId: state.selectedTaskId,
    taskListCollapsed: state.taskListCollapsed === true
  };
}

function areIssueManagerLiveNodeStatesEqual(
  previous: DesktopIssueManagerLiveNodeState,
  next: DesktopIssueManagerLiveNodeState
): boolean {
  return (
    previous.issueSearchQuery === next.issueSearchQuery &&
    previous.issueStatusFilter === next.issueStatusFilter &&
    previous.selectedAgentTargetId === next.selectedAgentTargetId &&
    previous.selectedExecutionDirectory === next.selectedExecutionDirectory &&
    previous.selectedIssueId === next.selectedIssueId &&
    previous.selectedTaskId === next.selectedTaskId &&
    previous.taskListCollapsed === next.taskListCollapsed
  );
}

function restorableIssueManagerNodeState(
  state: DesktopIssueManagerLiveNodeState
): DesktopIssueManagerRestorableNodeState {
  return {
    issueSearchQuery: state.issueSearchQuery,
    issueStatusFilter: state.issueStatusFilter,
    selectedAgentTargetId: state.selectedAgentTargetId,
    selectedExecutionDirectory: state.selectedExecutionDirectory ?? null,
    selectedIssueId: state.selectedIssueId,
    taskListCollapsed: state.taskListCollapsed === true
  };
}
