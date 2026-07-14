import {
  createBrowserNodeFeature,
  isBrowserNodeSurfaceEvent,
  type BrowserNodeFeature,
  type BrowserNodeHostApi
} from "@tutti-os/browser-node";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type {
  WorkbenchContribution,
  WorkbenchHostHandle,
  WorkbenchHostLaunchInput,
  WorkbenchHostNodeData,
  WorkbenchHostSnapshotRepository,
  WorkbenchState
} from "@tutti-os/workbench-surface";
import { resolveWorkspaceBrowserSearchUrl } from "../services/workspaceBrowserSearch.ts";
import type { StandaloneAgentSharedToolPanelId } from "./standaloneAgentToolSidebarModel.ts";

export const standaloneAgentBrowserDefaultUrl = "https://www.google.com/";

const contributionIdByPanel: Record<StandaloneAgentSharedToolPanelId, string> =
  {
    terminal: "workspace-terminal"
  };

const typeIdByPanel: Record<StandaloneAgentSharedToolPanelId, string> = {
  terminal: "workspace-terminal"
};

export function resolveStandaloneAgentToolContribution(
  contributions: readonly WorkbenchContribution[] | undefined,
  panel: StandaloneAgentSharedToolPanelId
): WorkbenchContribution | null {
  const contribution = contributions?.find(
    (candidate) => candidate.id === contributionIdByPanel[panel]
  );
  if (!contribution) {
    return null;
  }
  return {
    ...contribution,
    dockEntries: [],
    nodes: contribution.nodes?.map((node) => ({
      ...node,
      window: {
        ...node.window,
        closable: false,
        minimizable: false
      }
    })),
    onLaunchRequest: contribution.onLaunchRequest
      ? async (request) => {
          const result = await contribution.onLaunchRequest?.(request);
          return result
            ? {
                ...result,
                displayMode: "fullscreen" as const,
                framePolicy: "absolute" as const
              }
            : result;
        }
      : undefined
  };
}

export function createStandaloneAgentToolSnapshotRepository(): WorkbenchHostSnapshotRepository {
  return {
    load: async () => null,
    save: (_workspaceId, snapshot) => snapshot
  };
}

export function createStandaloneAgentBrowserToolFeature(input: {
  browserApi: BrowserNodeHostApi;
  i18n: I18nRuntime<string>;
  nodeId: string;
}): BrowserNodeFeature {
  return createBrowserNodeFeature({
    hostApi: createStandaloneAgentBrowserHostApi(
      input.browserApi,
      input.nodeId
    ),
    i18n: input.i18n,
    resolveSearchUrl: resolveWorkspaceBrowserSearchUrl
  });
}

function createStandaloneAgentBrowserHostApi(
  browserApi: BrowserNodeHostApi,
  nodeId: string
): BrowserNodeHostApi {
  return {
    ...browserApi,
    onEvent(listener) {
      return browserApi.onEvent((event) => {
        if (isBrowserNodeSurfaceEvent(nodeId, event)) {
          listener(event);
        }
      });
    }
  };
}

export interface StandaloneAgentToolHostGroup {
  readonly host: WorkbenchHostHandle;
  setHost(
    panel: StandaloneAgentSharedToolPanelId,
    host: WorkbenchHostHandle | null
  ): void;
}

export interface StandaloneAgentDirectToolHost {
  readonly host: WorkbenchHostHandle;
  setNode(
    input: {
      instanceId: string;
      nodeId: string;
      resolveCloseEffect?: () => Promise<{
        description?: string | null;
        nodeId: string;
        title: string;
        typeId: string;
      } | null>;
      title: string;
      typeId: string;
    } | null
  ): void;
}

export function createStandaloneAgentDirectToolHost(): StandaloneAgentDirectToolHost {
  let node: WorkbenchState<WorkbenchHostNodeData>["nodes"][number] | null =
    null;
  let resolveCloseEffect:
    | (() => Promise<{
        description?: string | null;
        nodeId: string;
        title: string;
        typeId: string;
      } | null>)
    | null = null;
  const emptySnapshot = (): WorkbenchState<WorkbenchHostNodeData> => ({
    activeDragNodeId: null,
    activeResizeNodeId: null,
    activeSnapTarget: null,
    layoutConstraints: {
      minHeight: 0,
      minWidth: 0,
      safeArea: { bottom: 0, left: 0, right: 0, top: 0 },
      surfacePadding: 0
    },
    lockedLayout: null,
    nodes: node ? [node] : [],
    nodeStack: node ? [node.id] : [],
    surfaceSize: { height: 1, width: 1 }
  });
  const host: WorkbenchHostHandle = {
    activateNode() {},
    async collectWindowCloseEffects() {
      const effect = await resolveCloseEffect?.();
      return effect ? [effect] : [];
    },
    closeNode(nodeId) {
      if (node?.id === nodeId) {
        node = null;
      }
    },
    dispose() {
      node = null;
      resolveCloseEffect = null;
    },
    exitFullscreenNode() {},
    focusNode() {},
    getSnapshot: emptySnapshot,
    async launchNode() {
      return null;
    },
    async load() {},
    minimizeNode() {},
    reconcileProjectedNodes() {},
    requestNodeClose() {},
    setNodeRuntimeState() {},
    setNodeSizeConstraints() {},
    setNodeTitle() {},
    setSnapshotNodeState() {}
  };

  return {
    host,
    setNode(input) {
      resolveCloseEffect = input?.resolveCloseEffect ?? null;
      node = input
        ? {
            data: {
              instanceId: input.instanceId,
              instanceKey: input.instanceId,
              typeId: input.typeId
            },
            displayMode: "floating",
            frame: { height: 1, width: 1, x: 0, y: 0 },
            id: input.nodeId,
            isMinimized: false,
            kind: "window",
            restoreFrame: null,
            title: input.title
          }
        : null;
    }
  };
}

export function createStandaloneAgentToolHostGroup(): StandaloneAgentToolHostGroup {
  const hosts = new Map<
    StandaloneAgentSharedToolPanelId,
    WorkbenchHostHandle
  >();

  const allHosts = (): WorkbenchHostHandle[] => [...hosts.values()];
  const findHostByNodeId = (nodeId: string): WorkbenchHostHandle | null =>
    allHosts().find((host) =>
      host.getSnapshot().nodes.some((node) => node.id === nodeId)
    ) ?? null;
  const findHostByLaunch = (
    input: Pick<WorkbenchHostLaunchInput, "typeId">
  ): WorkbenchHostHandle | null => {
    const panel = (
      Object.entries(typeIdByPanel) as Array<
        [StandaloneAgentSharedToolPanelId, string]
      >
    ).find(([, typeId]) => typeId === input.typeId)?.[0];
    return panel ? (hosts.get(panel) ?? null) : null;
  };
  const emptySnapshot = (): WorkbenchState<WorkbenchHostNodeData> => ({
    activeDragNodeId: null,
    activeResizeNodeId: null,
    activeSnapTarget: null,
    layoutConstraints: {
      minHeight: 0,
      minWidth: 0,
      safeArea: { bottom: 0, left: 0, right: 0, top: 0 },
      surfacePadding: 0
    },
    lockedLayout: null,
    nodes: [],
    nodeStack: [],
    surfaceSize: { height: 1, width: 1 }
  });

  const host: WorkbenchHostHandle = {
    activateNode(target, activation) {
      if ("nodeId" in target) {
        findHostByNodeId(target.nodeId)?.activateNode(target, activation);
        return;
      }
      for (const candidate of allHosts()) {
        candidate.activateNode(target, activation);
      }
    },
    clearNodeActivation(nodeId, sequence) {
      findHostByNodeId(nodeId)?.clearNodeActivation?.(nodeId, sequence);
    },
    closeNode(nodeId) {
      findHostByNodeId(nodeId)?.closeNode(nodeId);
    },
    async collectWindowCloseEffects() {
      const effects = await Promise.all(
        allHosts().map((candidate) => candidate.collectWindowCloseEffects())
      );
      return effects.flat();
    },
    dispose() {
      for (const candidate of allHosts()) {
        candidate.dispose();
      }
      hosts.clear();
    },
    exitFullscreenNode(nodeId) {
      findHostByNodeId(nodeId)?.exitFullscreenNode(nodeId);
    },
    focusNode(nodeId) {
      findHostByNodeId(nodeId)?.focusNode(nodeId);
    },
    getSnapshot() {
      const snapshots = allHosts().map((candidate) => candidate.getSnapshot());
      if (snapshots.length === 0) {
        return emptySnapshot();
      }
      const first = snapshots[0];
      if (!first) {
        return emptySnapshot();
      }
      return {
        ...first,
        nodes: snapshots.flatMap((snapshot) => snapshot.nodes),
        nodeStack: snapshots.flatMap((snapshot) => snapshot.nodeStack),
        surfaceSize: snapshots.slice(1).reduce(
          (size, snapshot) => ({
            height: Math.max(size.height, snapshot.surfaceSize.height),
            width: Math.max(size.width, snapshot.surfaceSize.width)
          }),
          first.surfaceSize
        )
      };
    },
    isHydrating() {
      return allHosts().some((candidate) => candidate.isHydrating?.() === true);
    },
    async launchNode(input) {
      return (await findHostByLaunch(input)?.launchNode(input)) ?? null;
    },
    async load() {
      await Promise.all(allHosts().map((candidate) => candidate.load()));
    },
    minimizeNode(nodeId) {
      findHostByNodeId(nodeId)?.minimizeNode(nodeId);
    },
    reconcileProjectedNodes(projectedNodes) {
      for (const candidate of allHosts()) {
        candidate.reconcileProjectedNodes(projectedNodes);
      }
    },
    requestNodeClose(nodeId) {
      findHostByNodeId(nodeId)?.requestNodeClose(nodeId);
    },
    setNodeRuntimeState(nodeId, state) {
      findHostByNodeId(nodeId)?.setNodeRuntimeState(nodeId, state);
    },
    setNodeSizeConstraints(nodeId, sizeConstraints) {
      findHostByNodeId(nodeId)?.setNodeSizeConstraints(nodeId, sizeConstraints);
    },
    setNodeTitle(nodeId, title) {
      findHostByNodeId(nodeId)?.setNodeTitle(nodeId, title);
    },
    setSnapshotNodeState(nodeId, state) {
      findHostByNodeId(nodeId)?.setSnapshotNodeState(nodeId, state);
    }
  };

  return {
    host,
    setHost(panel, nextHost) {
      if (nextHost) {
        hosts.set(panel, nextHost);
      } else {
        hosts.delete(panel);
      }
    }
  };
}
