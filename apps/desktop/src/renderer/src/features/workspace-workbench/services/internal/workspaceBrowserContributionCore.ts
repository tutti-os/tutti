import type { BrowserNodeRuntimeState } from "@tutti-os/browser-node";
import type {
  WorkbenchHostExternalStateLookupInput,
  WorkbenchHostExternalStateSource
} from "@tutti-os/workbench-surface";
export { resolveWorkspaceBrowserSearchUrl } from "../workspaceBrowserSearch.ts";
import { workspaceBrowserNodeID } from "./workspaceWorkbenchComposition.ts";

export interface WorkspaceBrowserNodeExternalState {
  title: string | null;
  url: string | null;
}

export function createWorkspaceBrowserNodeExternalStateSource(input: {
  runtimeStore: {
    getSnapshot(): Record<string, BrowserNodeRuntimeState | undefined>;
    subscribe(listener: () => void): () => void;
  };
  tabsStore: {
    getActiveNodeId(surfaceNodeId: string): string;
    subscribe(listener: () => void): () => void;
  };
}): WorkbenchHostExternalStateSource<
  WorkspaceBrowserNodeExternalState | null,
  null
> {
  return {
    getNodeState(request) {
      if (!isBrowserNodeExternalStateRequest(request)) {
        return null;
      }
      return readWorkspaceBrowserRuntimeNodeState(
        input.runtimeStore.getSnapshot(),
        input.tabsStore.getActiveNodeId(request.nodeId)
      );
    },
    getSnapshotNodeState(request) {
      if (!isBrowserNodeExternalStateRequest(request)) {
        return null;
      }
      return readWorkspaceBrowserRuntimeNodeState(
        input.runtimeStore.getSnapshot(),
        input.tabsStore.getActiveNodeId(request.nodeId)
      );
    },
    getWorkspaceState() {
      return null;
    },
    subscribe(listener) {
      const unsubscribeRuntime = input.runtimeStore.subscribe(listener);
      const unsubscribeTabs = input.tabsStore.subscribe(listener);
      return () => {
        unsubscribeRuntime();
        unsubscribeTabs();
      };
    }
  };
}

function isBrowserNodeExternalStateRequest(
  request: WorkbenchHostExternalStateLookupInput
): boolean {
  return request.typeId === workspaceBrowserNodeID;
}

function readWorkspaceBrowserRuntimeNodeState(
  runtimeSnapshot: Record<string, BrowserNodeRuntimeState | undefined>,
  nodeId: string
): WorkspaceBrowserNodeExternalState | null {
  const state = runtimeSnapshot[nodeId];
  const url = state?.url?.trim() ?? "";
  if (url.length === 0) {
    return null;
  }

  return {
    title: state?.title?.trim() || null,
    url
  };
}
