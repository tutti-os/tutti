import type { BrowserNodeRuntimeState } from "@tutti-os/browser-node";
import type {
  WorkbenchHostExternalStateLookupInput,
  WorkbenchHostExternalStateSource
} from "@tutti-os/workbench-surface";
import { workspaceBrowserNodeID } from "./workspaceWorkbenchComposition.ts";

const browserNodeSearchBaseUrl = "https://www.google.com/search";

export function resolveWorkspaceBrowserSearchUrl(query: string): string {
  const searchUrl = new URL(browserNodeSearchBaseUrl);
  searchUrl.searchParams.set("q", query);
  return searchUrl.toString();
}

export interface WorkspaceBrowserNodeExternalState {
  title: string | null;
  url: string | null;
}

export function createWorkspaceBrowserNodeExternalStateSource(input: {
  runtimeStore: {
    getSnapshot(): Record<string, BrowserNodeRuntimeState | undefined>;
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
        request.nodeId
      );
    },
    getSnapshotNodeState(request) {
      if (!isBrowserNodeExternalStateRequest(request)) {
        return null;
      }
      return readWorkspaceBrowserRuntimeNodeState(
        input.runtimeStore.getSnapshot(),
        request.nodeId
      );
    },
    getWorkspaceState() {
      return null;
    },
    subscribe(listener) {
      return input.runtimeStore.subscribe(listener);
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
