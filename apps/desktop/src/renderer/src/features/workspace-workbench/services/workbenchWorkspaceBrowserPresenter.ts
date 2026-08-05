import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import {
  type WorkspaceBrowserLaunchHandler,
  type WorkspaceBrowserLaunchRequest
} from "./workspaceBrowserLaunchCoordinator.ts";
import type {
  WorkspaceBrowserPageOpenInput,
  WorkspaceBrowserPageOpenResult
} from "./workspaceWorkbenchHostService.interface.ts";
import { workspaceBrowserNodeID } from "./workspaceWorkbenchNodeIds.ts";

export function createWorkbenchWorkspaceBrowserPresenter(input: {
  browserPages: {
    openPage(
      request: WorkspaceBrowserPageOpenInput
    ): WorkspaceBrowserPageOpenResult | null;
  };
  host: WorkbenchHostHandle;
}): WorkspaceBrowserLaunchHandler {
  const workspaceAppNodeByOpenRequest = new Map<string, string>();
  const workspaceAppOpenRequestInFlight = new Map<
    string,
    Promise<string | null>
  >();

  return (request) => {
    const requestKey = workspaceAppOpenRequestKey(request);
    if (!requestKey) {
      return presentWorkspaceBrowser(input, request);
    }

    pruneClosedWorkspaceAppBrowserNodes(
      input.host,
      workspaceAppNodeByOpenRequest
    );
    const rememberedNodeId = workspaceAppNodeByOpenRequest.get(requestKey);
    if (rememberedNodeId) {
      input.host.focusNode(rememberedNodeId);
      return rememberedNodeId;
    }

    const inFlight = workspaceAppOpenRequestInFlight.get(requestKey);
    if (inFlight) {
      return inFlight;
    }

    let openRequest!: Promise<string | null>;
    openRequest = presentWorkspaceBrowser(input, request)
      .then((nodeId) => {
        if (nodeId) {
          workspaceAppNodeByOpenRequest.set(requestKey, nodeId);
        }
        return nodeId;
      })
      .finally(() => {
        if (workspaceAppOpenRequestInFlight.get(requestKey) === openRequest) {
          workspaceAppOpenRequestInFlight.delete(requestKey);
        }
      });
    workspaceAppOpenRequestInFlight.set(requestKey, openRequest);
    return openRequest;
  };
}

function workspaceAppOpenRequestKey(
  request: WorkspaceBrowserLaunchRequest
): string | null {
  if (
    request.kind !== "open" ||
    request.source !== "workspace_app" ||
    request.reuseIfOpen !== false
  ) {
    return null;
  }
  const sourceNodeId = request.sourceNodeId?.trim() ?? "";
  return sourceNodeId
    ? JSON.stringify([request.workspaceId, sourceNodeId, request.url])
    : null;
}

function pruneClosedWorkspaceAppBrowserNodes(
  host: WorkbenchHostHandle,
  nodeByOpenRequest: Map<string, string>
): void {
  const liveBrowserNodeIds = new Set(
    host
      .getSnapshot()
      .nodes.filter((node) => node.data.typeId === workspaceBrowserNodeID)
      .map((node) => node.id)
  );
  for (const [requestKey, nodeId] of nodeByOpenRequest) {
    if (!liveBrowserNodeIds.has(nodeId)) {
      nodeByOpenRequest.delete(requestKey);
    }
  }
}

async function presentWorkspaceBrowser(
  input: {
    browserPages: {
      openPage(
        request: WorkspaceBrowserPageOpenInput
      ): WorkspaceBrowserPageOpenResult | null;
    };
    host: WorkbenchHostHandle;
  },
  request: WorkspaceBrowserLaunchRequest
): Promise<string | null> {
  const { host } = input;
  const browserNodeIds = resolveWorkspaceBrowserNodeIds(host);
  const preferredNodeId =
    request.kind === "focus"
      ? resolveWorkspaceBrowserNodeId(host, request.preferredNodeId)
      : null;
  const existingNodeId =
    request.kind === "focus"
      ? (preferredNodeId ?? browserNodeIds[0] ?? null)
      : null;

  if (
    request.kind === "open" &&
    request.reuseIfOpen !== false &&
    browserNodeIds.length > 0
  ) {
    const openedPage = input.browserPages.openPage({
      surfaceNodeIds: browserNodeIds,
      url: request.url,
      workspaceId: request.workspaceId
    });
    if (openedPage) {
      host.focusNode(openedPage.surfaceNodeId);
      return openedPage.surfaceNodeId;
    }
  }

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

function resolveWorkspaceBrowserNodeIds(host: WorkbenchHostHandle): string[] {
  const snapshot = host.getSnapshot();
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const browserNodeIds: string[] = [];
  for (const nodeId of [...snapshot.nodeStack].reverse()) {
    const node = nodesById.get(nodeId);
    if (node?.data.typeId === workspaceBrowserNodeID) {
      browserNodeIds.push(node.id);
    }
  }

  for (const node of snapshot.nodes) {
    if (
      node.data.typeId === workspaceBrowserNodeID &&
      !browserNodeIds.includes(node.id)
    ) {
      browserNodeIds.push(node.id);
    }
  }
  return browserNodeIds;
}
