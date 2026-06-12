import { useCallback, useMemo } from "react";
import type { WorkbenchNode } from "../core/types.ts";
import type {
  WorkbenchRenderNodeContext,
  WorkbenchRenderWindowHeader,
  WorkbenchResolveWindowChromeMode,
  WorkbenchWindowActionContext
} from "../react/types.ts";
import type {
  WorkbenchDockPreviewCache,
  WorkbenchDockPreviewCacheKey
} from "../react/dockPreviewCache.ts";
import { WorkbenchHostDock } from "./WorkbenchHostDock.tsx";
import {
  createWorkbenchHostNodeBodyContext,
  createWorkbenchHostNodeHeaderContext
} from "./hostNodeContext.ts";
import { WorkbenchHostWindowActions } from "./WorkbenchHostWindowActions.tsx";
import { readWorkbenchHostExternalState } from "./externalState.ts";
import {
  isWorkbenchMinimizedDockEligibleNode,
  resolveWorkbenchMinimizedDockAnchorKeyForNode,
  resolveWorkbenchMinimizedDockSlots
} from "./minimizedDockSlots.ts";
import type {
  WorkbenchHostChromeRenderContext,
  WorkbenchHostDockEntry,
  WorkbenchHostExternalStateSource,
  WorkbenchHostNodeData,
  WorkbenchHostNodeDefinition,
  WorkbenchHostProps,
  WorkbenchHostRuntimeHandle
} from "./types.ts";
import type { WorkbenchHostI18nRuntime } from "./workbenchHostI18n.ts";

export function useWorkbenchHostSurfaceRenderers(input: {
  captureNodePreviewImage?: WorkbenchHostProps["captureNodePreviewImage"];
  chromeContext: WorkbenchHostChromeRenderContext;
  debugDiagnostics?: WorkbenchHostProps["debugDiagnostics"];
  dockPreviewCache?: WorkbenchDockPreviewCache;
  dockPlacement?: WorkbenchHostProps["dockPlacement"];
  dockEntries: readonly WorkbenchHostDockEntry[];
  dockStateSource?: WorkbenchHostProps["dockStateSource"];
  externalStateSource?: WorkbenchHostExternalStateSource;
  hostI18n: WorkbenchHostI18nRuntime;
  hostSession: WorkbenchHostRuntimeHandle;
  nodeDefinitionByType: Map<string, WorkbenchHostNodeDefinition>;
  onDockEntryAction?: WorkbenchHostProps["onDockEntryAction"];
  onDockEntryClick?: WorkbenchHostProps["onDockEntryClick"];
  renderBottomChrome?: WorkbenchHostProps["renderBottomChrome"];
  renderTopChrome?: WorkbenchHostProps["renderTopChrome"];
  workspaceId: string;
}) {
  const renderBottomChrome = useMemo(
    () =>
      input.renderBottomChrome
        ? () => input.renderBottomChrome?.(input.chromeContext)
        : undefined,
    [input.chromeContext, input.renderBottomChrome]
  );
  const renderTopChrome = useMemo(
    () =>
      input.renderTopChrome
        ? () => input.renderTopChrome?.(input.chromeContext)
        : undefined,
    [input.chromeContext, input.renderTopChrome]
  );

  const captureNodePreviewImage = useCallback(
    async (node: WorkbenchNode<WorkbenchHostNodeData>) => {
      const definition = input.nodeDefinitionByType.get(node.data.typeId);
      const capturePreview = definition?.window?.minimizedDock?.capturePreview;
      const snapshot = input.hostSession.getSnapshot();
      const externalState = readWorkbenchHostExternalState({
        externalStateSource: input.externalStateSource,
        node,
        workspaceId: input.workspaceId
      });
      const nodePreview =
        (await Promise.resolve(
          capturePreview?.({
            externalNodeState: externalState.externalNodeState,
            externalWorkspaceState: externalState.externalWorkspaceState,
            host: input.hostSession,
            isFocused: snapshot.nodeStack.at(-1) === node.id,
            isMinimized: node.isMinimized,
            node
          }) ?? null
        ).catch(() => null)) ??
        (await Promise.resolve(
          input.captureNodePreviewImage?.(node) ?? null
        ).catch(() => null));
      return nodePreview;
    },
    [
      input.captureNodePreviewImage,
      input.externalStateSource,
      input.hostSession,
      input.nodeDefinitionByType,
      input.workspaceId
    ]
  );

  const renderDock = useCallback(
    (context: Parameters<typeof WorkbenchHostDock>[0]["context"]) => (
      <WorkbenchHostDock
        captureNodePreviewImage={captureNodePreviewImage}
        context={context}
        debugDiagnostics={input.debugDiagnostics}
        dockEntries={input.dockEntries}
        dockPlacement={input.dockPlacement}
        dockPreviewCache={input.dockPreviewCache}
        dockStateSource={input.dockStateSource}
        externalStateSource={input.externalStateSource}
        host={input.hostSession}
        i18n={input.hostI18n}
        nodeDefinitions={input.nodeDefinitionByType}
        onDockEntryAction={input.onDockEntryAction}
        onDockEntryClick={input.onDockEntryClick}
        workspaceId={input.workspaceId}
      />
    ),
    [
      captureNodePreviewImage,
      input.debugDiagnostics,
      input.dockEntries,
      input.dockPlacement,
      input.dockPreviewCache,
      input.dockStateSource,
      input.externalStateSource,
      input.hostI18n,
      input.hostSession,
      input.nodeDefinitionByType,
      input.onDockEntryAction,
      input.onDockEntryClick,
      input.workspaceId
    ]
  );

  const renderNode = useCallback(
    (context: WorkbenchRenderNodeContext<WorkbenchHostNodeData>) => {
      const definition = input.nodeDefinitionByType.get(
        context.node.data.typeId
      );
      if (!definition) {
        return null;
      }

      return definition.renderBody(
        createWorkbenchHostNodeBodyContext({
          context,
          definition,
          externalStateSource: input.externalStateSource,
          host: input.hostSession,
          workspaceId: input.workspaceId
        })
      );
    },
    [
      input.externalStateSource,
      input.hostSession,
      input.nodeDefinitionByType,
      input.workspaceId
    ]
  );

  const renderWindowActions = useCallback(
    (context: WorkbenchWindowActionContext<WorkbenchHostNodeData>) => (
      <WorkbenchHostWindowActions
        context={context}
        host={input.hostSession}
        i18n={input.hostI18n}
        nodeDefinitions={input.nodeDefinitionByType}
      />
    ),
    [input.hostI18n, input.hostSession, input.nodeDefinitionByType]
  );

  const renderWindowHeader = useCallback(
    (
      context: Parameters<WorkbenchRenderWindowHeader<WorkbenchHostNodeData>>[0]
    ) => {
      const definition = input.nodeDefinitionByType.get(
        context.node.data.typeId
      );
      if (!definition?.renderHeader) {
        return null;
      }

      return definition.renderHeader(
        createWorkbenchHostNodeHeaderContext({
          context,
          definition,
          externalStateSource: input.externalStateSource,
          host: input.hostSession,
          workspaceId: input.workspaceId
        })
      );
    },
    [
      input.externalStateSource,
      input.hostSession,
      input.nodeDefinitionByType,
      input.workspaceId
    ]
  );

  const shouldKeepMinimizedNodeMounted = useCallback(
    (node: WorkbenchNode<WorkbenchHostNodeData>) => {
      const capability = input.nodeDefinitionByType.get(node.data.typeId)
        ?.window?.keepMountedWhenMinimized;
      return typeof capability === "function"
        ? capability(node)
        : capability === true;
    },
    [input.nodeDefinitionByType]
  );

  const resolveDockAnchorKey = useCallback(
    (node: WorkbenchNode<WorkbenchHostNodeData>) => {
      if (
        node.isMinimized &&
        isWorkbenchMinimizedDockEligibleNode({
          node,
          nodeDefinitions: input.nodeDefinitionByType
        })
      ) {
        const minimizedAnchorKey =
          resolveWorkbenchMinimizedDockAnchorKeyForNode({
            nodeId: node.id,
            slots: resolveWorkbenchMinimizedDockSlots({
              nodeDefinitions: input.nodeDefinitionByType,
              nodes: input.hostSession.getSnapshot().nodes
            })
          });
        if (minimizedAnchorKey) {
          return minimizedAnchorKey;
        }
      }

      if (typeof node.data.dockEntryId === "string") {
        const dockEntry = input.dockEntries.find(
          (entry) => entry.id === node.data.dockEntryId
        );
        return dockEntry?.anchorKey ?? node.data.dockEntryId;
      }

      return node.data.typeId;
    },
    [input.dockEntries, input.hostSession, input.nodeDefinitionByType]
  );

  const resolveDockPreviewCacheKey = useCallback(
    (
      node: WorkbenchNode<WorkbenchHostNodeData>
    ): WorkbenchDockPreviewCacheKey | null => ({
      instanceId: node.data.instanceId,
      instanceKey: node.data.instanceKey ?? null,
      nodeId: node.id,
      typeId: node.data.typeId,
      workspaceId: input.workspaceId
    }),
    [input.workspaceId]
  );

  const windowChromeMode = useCallback<
    WorkbenchResolveWindowChromeMode<WorkbenchHostNodeData>
  >(
    ({ node }) =>
      input.nodeDefinitionByType.get(node.data.typeId)?.renderHeader
        ? "custom-header"
        : "system",
    [input.nodeDefinitionByType]
  );

  const resolveFullscreenHeaderMode = useCallback(
    ({ node }: { node: WorkbenchNode<WorkbenchHostNodeData> }) =>
      input.nodeDefinitionByType.get(node.data.typeId)?.window
        ?.fullscreenHeaderMode,
    [input.nodeDefinitionByType]
  );

  return {
    captureNodePreviewImage,
    renderBottomChrome,
    renderDock,
    renderNode,
    renderTopChrome,
    renderWindowActions,
    renderWindowHeader,
    shouldKeepMinimizedNodeMounted,
    resolveDockAnchorKey,
    resolveDockPreviewCacheKey,
    resolveFullscreenHeaderMode,
    windowChromeMode
  };
}
