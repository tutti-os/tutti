import type { BrowserNodeRuntimeState } from "@tutti-os/browser-node";
import type {
  WorkbenchHostExternalStateLookupInput,
  WorkbenchHostExternalStateSource
} from "@tutti-os/workbench-surface";
import type { WorkspaceAppCenterViewState } from "@tutti-os/workspace-app-center";
import type { IWorkspaceAppCenterService } from "../workspaceAppCenterService.interface.ts";
import {
  findWorkspaceApp,
  readWorkspaceAppIdFromInstanceId,
  readWorkspaceAppIdFromNodeId,
  resolveWorkspaceAppDisplayName,
  workspaceAppCenterNodeID,
  workspaceAppWebviewTypeID
} from "./workspaceAppCenterLaunchRequest.ts";
import type { WorkspaceAppWebviewExternalState } from "./workspaceAppCenterWebviewUrl.ts";

type WorkspaceAppCenterExternalNodeState =
  | WorkspaceAppCenterViewState
  | WorkspaceAppWebviewExternalState
  | null;

export function createWorkspaceAppWebviewExternalStateSource(input: {
  appCenterService: IWorkspaceAppCenterService;
  runtimeStore: {
    getSnapshot(): Record<string, BrowserNodeRuntimeState | undefined>;
    subscribe(listener: () => void): () => void;
  };
}): WorkbenchHostExternalStateSource<
  WorkspaceAppCenterExternalNodeState,
  null
> {
  const appCenterViewStateByWorkspaceId = new Map<
    string,
    WorkspaceAppCenterViewState
  >();
  const appWebviewStateByNodeId = new Map<
    string,
    WorkspaceAppWebviewExternalState
  >();

  return {
    getNodeState(request) {
      if (request.typeId === workspaceAppCenterNodeID) {
        return reuseWorkspaceAppCenterViewState(
          appCenterViewStateByWorkspaceId,
          request.workspaceId,
          input.appCenterService.getViewState(request.workspaceId)
        );
      }
      return reuseWorkspaceAppWebviewExternalState(
        appWebviewStateByNodeId,
        request.nodeId,
        readWorkspaceAppExternalState(input, request)
      );
    },
    getSnapshotNodeState(request) {
      if (request.typeId === workspaceAppCenterNodeID) {
        return reuseWorkspaceAppCenterViewState(
          appCenterViewStateByWorkspaceId,
          request.workspaceId,
          input.appCenterService.getViewState(request.workspaceId)
        );
      }
      return reuseWorkspaceAppWebviewExternalState(
        appWebviewStateByNodeId,
        request.nodeId,
        readWorkspaceAppExternalState(input, request)
      );
    },
    getWorkspaceState() {
      return null;
    },
    subscribeNodeState(request, listener) {
      if (
        request.typeId !== workspaceAppCenterNodeID &&
        request.typeId !== workspaceAppWebviewTypeID
      ) {
        return () => {};
      }
      const unsubscribeRuntime = input.runtimeStore.subscribe(listener);
      const unsubscribeAppCenter = input.appCenterService.subscribe(listener);
      return () => {
        unsubscribeRuntime();
        unsubscribeAppCenter();
      };
    }
  };
}

function reuseWorkspaceAppCenterViewState(
  stateByWorkspaceId: Map<string, WorkspaceAppCenterViewState>,
  workspaceId: string,
  next: WorkspaceAppCenterViewState
): WorkspaceAppCenterViewState {
  const previous = stateByWorkspaceId.get(workspaceId);
  if (
    previous?.activeAppTab === next.activeAppTab &&
    previous.openAppId === next.openAppId &&
    previous.openAppIds?.length === next.openAppIds?.length &&
    previous.openAppIds?.every(
      (appId, index) => appId === next.openAppIds?.[index]
    )
  ) {
    return previous;
  }
  stateByWorkspaceId.set(workspaceId, next);
  return next;
}

function reuseWorkspaceAppWebviewExternalState(
  stateByNodeId: Map<string, WorkspaceAppWebviewExternalState>,
  nodeId: string,
  next: WorkspaceAppWebviewExternalState | null
): WorkspaceAppWebviewExternalState | null {
  const previous = stateByNodeId.get(nodeId) ?? null;
  if (!next) {
    stateByNodeId.delete(nodeId);
    return null;
  }
  if (previous?.title === next.title && previous.url === next.url) {
    return previous;
  }
  stateByNodeId.set(nodeId, next);
  return next;
}

function readWorkspaceAppExternalState(
  input: {
    appCenterService: IWorkspaceAppCenterService;
    runtimeStore: {
      getSnapshot(): Record<string, BrowserNodeRuntimeState | undefined>;
    };
  },
  request: WorkbenchHostExternalStateLookupInput
): WorkspaceAppWebviewExternalState | null {
  if (request.typeId !== workspaceAppWebviewTypeID) {
    return null;
  }
  const runtime = input.runtimeStore.getSnapshot()[request.nodeId];
  const runtimeUrl = runtime?.url?.trim();
  if (runtimeUrl) {
    return {
      title: runtime?.title?.trim() || null,
      url: runtimeUrl
    };
  }

  const appId =
    readWorkspaceAppIdFromNodeId(request.nodeId) ??
    readWorkspaceAppIdFromInstanceId(request.instanceId);
  const app = appId ? findWorkspaceApp(input.appCenterService, appId) : null;
  return app?.launchUrl
    ? {
        title: resolveWorkspaceAppDisplayName(app),
        url: app.launchUrl
      }
    : null;
}
