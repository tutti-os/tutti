import { Component, memo, useCallback, useMemo } from "react";
import type { ErrorInfo, ReactNode } from "react";
import type { WorkbenchNode } from "../core/types.ts";
import type {
  WorkbenchRenderNodeContext,
  WorkbenchRenderWindowHeader,
  WorkbenchResolveWindowSurfaceLayer,
  WorkbenchResolveWindowZIndex,
  WorkbenchResolveWindowChromeMode,
  WorkbenchWindowActionContext
} from "../react/types.ts";
import type {
  WorkbenchDockPreviewCache,
  WorkbenchDockPreviewCacheKey
} from "../react/dockPreviewCache.ts";
import {
  renderMinimizedDockPreviewContent,
  WorkbenchHostDock
} from "./WorkbenchHostDock.tsx";
import {
  createWorkbenchHostNodeBodyContext,
  createWorkbenchHostNodeHeaderContext
} from "./hostNodeContext.ts";
import { WorkbenchHostWindowActions } from "./WorkbenchHostWindowActions.tsx";
import {
  readWorkbenchHostExternalState,
  useWorkbenchHostExternalState
} from "./externalState.ts";
import {
  isWorkbenchMinimizedDockEligibleNode,
  resolveWorkbenchMinimizedDockAnchorKeyForNode,
  resolveWorkbenchMinimizedDockSlots
} from "./minimizedDockSlots.ts";
import type {
  WorkbenchHostChromeRenderContext,
  WorkbenchHostDockEntry,
  WorkbenchHostExternalStateSource,
  WorkbenchHostNodeBodyContext,
  WorkbenchHostNodeData,
  WorkbenchHostNodeDefinition,
  WorkbenchHostNodeHeaderContext,
  WorkbenchHostNodeHeaderFrameRenderKey,
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
  onMissionControlRequestOpen?: WorkbenchHostProps["onMissionControlRequestOpen"];
  renderBottomChrome?: WorkbenchHostProps["renderBottomChrome"];
  renderTopChrome?: WorkbenchHostProps["renderTopChrome"];
  workspaceId: string;
}) {
  const renderBottomChrome = useMemo(() => {
    const renderChrome = input.renderBottomChrome;
    return renderChrome
      ? () => (
          <WorkbenchHostSurfaceRenderErrorBoundary
            debugDiagnostics={input.debugDiagnostics}
            details={{
              chromeSlot: "bottom"
            }}
            event="workbench.chrome.render_error"
            fallbackKind="bottom-chrome"
            resetKey={`${input.workspaceId}:bottom-chrome`}
            workspaceId={input.workspaceId}
          >
            <WorkbenchHostChromeRenderer
              context={input.chromeContext}
              renderChrome={renderChrome}
            />
          </WorkbenchHostSurfaceRenderErrorBoundary>
        )
      : undefined;
  }, [
    input.chromeContext,
    input.debugDiagnostics,
    input.renderBottomChrome,
    input.workspaceId
  ]);
  const renderTopChrome = useMemo(() => {
    const renderChrome = input.renderTopChrome;
    return renderChrome
      ? () => (
          <WorkbenchHostSurfaceRenderErrorBoundary
            debugDiagnostics={input.debugDiagnostics}
            details={{
              chromeSlot: "top"
            }}
            event="workbench.chrome.render_error"
            fallbackKind="top-chrome"
            resetKey={`${input.workspaceId}:top-chrome`}
            workspaceId={input.workspaceId}
          >
            <WorkbenchHostChromeRenderer
              context={input.chromeContext}
              renderChrome={renderChrome}
            />
          </WorkbenchHostSurfaceRenderErrorBoundary>
        )
      : undefined;
  }, [
    input.chromeContext,
    input.debugDiagnostics,
    input.renderTopChrome,
    input.workspaceId
  ]);

  const captureNodePreviewImage = useCallback(
    async (node: WorkbenchNode<WorkbenchHostNodeData>) => {
      const definition = input.nodeDefinitionByType.get(node.data.typeId);
      const minimizedDock = definition?.window?.minimizedDock;
      const capturePreview =
        minimizedDock?.kind === "snapshot"
          ? minimizedDock.capturePreview
          : undefined;
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
      <WorkbenchHostSurfaceRenderErrorBoundary
        debugDiagnostics={input.debugDiagnostics}
        details={{
          dockEntryCount: input.dockEntries.length,
          dockPlacement: input.dockPlacement ?? null
        }}
        event="workbench.dock.render_error"
        fallbackKind="dock"
        resetKey={`${input.workspaceId}:dock`}
        workspaceId={input.workspaceId}
      >
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
          onMissionControlRequestOpen={input.onMissionControlRequestOpen}
          workspaceId={input.workspaceId}
        />
      </WorkbenchHostSurfaceRenderErrorBoundary>
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
      input.onMissionControlRequestOpen,
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

      return (
        <WorkbenchHostNodeRenderer
          debugDiagnostics={input.debugDiagnostics}
          context={context}
          definition={definition}
          externalStateSource={input.externalStateSource}
          host={input.hostSession}
          workspaceId={input.workspaceId}
        />
      );
    },
    [
      input.debugDiagnostics,
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

      return (
        <MemoizedWorkbenchHostNodeHeaderStateBridge
          context={context}
          definition={definition}
          externalStateSource={input.externalStateSource}
          host={input.hostSession}
          workspaceId={input.workspaceId}
        />
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

  const shouldCaptureNodePreviewImage = useCallback(
    (node: WorkbenchNode<WorkbenchHostNodeData>) => {
      const minimizedDock = input.nodeDefinitionByType.get(node.data.typeId)
        ?.window?.minimizedDock;
      return minimizedDock?.kind !== "component";
    },
    [input.nodeDefinitionByType]
  );

  const renderNodeGeniePreview = useCallback(
    (
      node: WorkbenchNode<WorkbenchHostNodeData>,
      {
        previewViewport
      }: { previewViewport: { height: number; width: number } }
    ) => {
      const minimizedDock = input.nodeDefinitionByType.get(node.data.typeId)
        ?.window?.minimizedDock;
      if (minimizedDock?.kind !== "component") {
        return null;
      }

      const externalState = readWorkbenchHostExternalState({
        externalStateSource: input.externalStateSource,
        node,
        workspaceId: input.workspaceId
      });
      const preview = minimizedDock.providePreview({
        externalNodeState: externalState.externalNodeState,
        externalWorkspaceState: externalState.externalWorkspaceState,
        host: input.hostSession,
        isFocused: input.hostSession.getSnapshot().nodeStack.at(-1) === node.id,
        isMinimized: node.isMinimized,
        node,
        previewViewport
      });
      return preview
        ? renderMinimizedDockPreviewContent(
            preview,
            "workbench-genie-preview-capture__preview"
          )
        : null;
    },
    [
      input.externalStateSource,
      input.hostSession,
      input.nodeDefinitionByType,
      input.workspaceId
    ]
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
        const snapshotNodes = input.hostSession.getSnapshot().nodes;
        const slotNodes = snapshotNodes.some(
          (snapshotNode) => snapshotNode.id === node.id
        )
          ? snapshotNodes.map((snapshotNode) =>
              snapshotNode.id === node.id ? node : snapshotNode
            )
          : [...snapshotNodes, node];
        const minimizedAnchorKey =
          resolveWorkbenchMinimizedDockAnchorKeyForNode({
            nodeId: node.id,
            slots: resolveWorkbenchMinimizedDockSlots({
              nodeDefinitions: input.nodeDefinitionByType,
              nodes: slotNodes
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

  const resolveWindowZIndex = useCallback<
    WorkbenchResolveWindowZIndex<WorkbenchHostNodeData>
  >(({ baseZIndex }) => baseZIndex, []);

  const resolveWindowSurfaceLayer = useCallback<
    WorkbenchResolveWindowSurfaceLayer<WorkbenchHostNodeData>
  >(
    ({ node }) =>
      input.nodeDefinitionByType.get(node.data.typeId)?.window?.surfaceLayer ??
      "default",
    [input.nodeDefinitionByType]
  );

  const resolveFullscreenHeaderMode = useCallback(
    ({ node }: { node: WorkbenchNode<WorkbenchHostNodeData> }) =>
      input.nodeDefinitionByType.get(node.data.typeId)?.window
        ?.fullscreenHeaderMode,
    [input.nodeDefinitionByType]
  );

  const resolveWindowHeaderPresentation = useCallback(
    ({ node }: { node: WorkbenchNode<WorkbenchHostNodeData> }) =>
      input.nodeDefinitionByType.get(node.data.typeId)?.window?.header,
    [input.nodeDefinitionByType]
  );

  return {
    captureNodePreviewImage,
    renderBottomChrome,
    renderDock,
    renderNode,
    renderNodeGeniePreview,
    renderTopChrome,
    renderWindowActions,
    renderWindowHeader,
    shouldCaptureNodePreviewImage,
    shouldKeepMinimizedNodeMounted,
    resolveDockAnchorKey,
    resolveDockPreviewCacheKey,
    resolveFullscreenHeaderMode,
    resolveWindowHeaderPresentation,
    resolveWindowSurfaceLayer,
    resolveWindowZIndex,
    windowChromeMode
  };
}

interface WorkbenchHostNodeRenderErrorBoundaryProps {
  children: ReactNode;
  debugDiagnostics?: WorkbenchHostProps["debugDiagnostics"];
  node: WorkbenchNode<WorkbenchHostNodeData>;
  onErrorChange?: (hasError: boolean) => void;
  resetKey: unknown;
  workspaceId: string;
}

function WorkbenchHostNodeRenderer(input: {
  context: WorkbenchRenderNodeContext<WorkbenchHostNodeData>;
  debugDiagnostics?: WorkbenchHostProps["debugDiagnostics"];
  definition: WorkbenchHostNodeDefinition;
  externalStateSource?: WorkbenchHostExternalStateSource;
  host: WorkbenchHostRuntimeHandle;
  workspaceId: string;
}): ReactNode {
  const externalState = useWorkbenchHostExternalState({
    externalStateSource: input.externalStateSource,
    node: input.context.node,
    workspaceId: input.workspaceId
  });
  const bodyContext = createWorkbenchHostNodeBodyContext({
    context: input.context,
    definition: input.definition,
    externalState,
    externalStateSource: input.externalStateSource,
    host: input.host,
    workspaceId: input.workspaceId
  });
  const resetKey = useMemo(
    () => [
      input.context.node.id,
      input.context.node.data.typeId,
      externalState.externalNodeState,
      externalState.externalWorkspaceState
    ],
    [
      externalState.externalNodeState,
      externalState.externalWorkspaceState,
      input.context.node.data.typeId,
      input.context.node.id
    ]
  );

  return (
    <WorkbenchHostNodeRenderErrorBoundary
      debugDiagnostics={input.debugDiagnostics}
      node={input.context.node}
      onErrorChange={(hasError) =>
        input.definition.onBodyRenderErrorChange?.({
          hasError,
          node: input.context.node
        })
      }
      resetKey={resetKey}
      workspaceId={input.workspaceId}
    >
      <WorkbenchHostNodeBodyRenderer
        context={bodyContext}
        definition={input.definition}
      />
    </WorkbenchHostNodeRenderErrorBoundary>
  );
}

interface WorkbenchHostNodeHeaderStateBridgeProps {
  context: Parameters<WorkbenchRenderWindowHeader<WorkbenchHostNodeData>>[0];
  definition: WorkbenchHostNodeDefinition;
  externalStateSource?: WorkbenchHostExternalStateSource;
  host: WorkbenchHostRuntimeHandle;
  workspaceId: string;
}

function WorkbenchHostNodeHeaderStateBridge(
  input: WorkbenchHostNodeHeaderStateBridgeProps
): ReactNode {
  const externalState = useWorkbenchHostExternalState({
    externalStateSource: input.externalStateSource,
    node: input.context.node,
    workspaceId: input.workspaceId
  });
  const context = createWorkbenchHostNodeHeaderContext({
    context: input.context,
    definition: input.definition,
    externalState,
    externalStateSource: input.externalStateSource,
    host: input.host,
    workspaceId: input.workspaceId
  });
  const getFrameRenderKey = input.definition.getHeaderFrameRenderKey;

  return (
    <MemoizedWorkbenchHostNodeHeaderRenderer
      context={context}
      definition={input.definition}
      frameRenderKey={getFrameRenderKey?.(context) ?? null}
      hasFrameRenderKey={getFrameRenderKey !== undefined}
      host={input.host}
      renderRevision={input.context.renderRevision}
    />
  );
}

function areWorkbenchHostNodeHeaderStateBridgePropsEqual(
  previous: WorkbenchHostNodeHeaderStateBridgeProps,
  next: WorkbenchHostNodeHeaderStateBridgeProps
): boolean {
  return (
    previous.definition === next.definition &&
    previous.externalStateSource === next.externalStateSource &&
    previous.host === next.host &&
    previous.workspaceId === next.workspaceId &&
    previous.context.controller === next.context.controller &&
    previous.context.isDragging === next.context.isDragging &&
    previous.context.isFocused === next.context.isFocused &&
    previous.context.isResizing === next.context.isResizing &&
    previous.context.node === next.context.node &&
    previous.context.renderRevision === next.context.renderRevision &&
    previous.context.surfaceSize.width === next.context.surfaceSize.width &&
    previous.context.surfaceSize.height === next.context.surfaceSize.height
  );
}

const MemoizedWorkbenchHostNodeHeaderStateBridge = memo(
  WorkbenchHostNodeHeaderStateBridge,
  areWorkbenchHostNodeHeaderStateBridgePropsEqual
);

interface WorkbenchHostNodeHeaderRendererProps {
  context: WorkbenchHostNodeHeaderContext;
  definition: WorkbenchHostNodeDefinition;
  frameRenderKey: WorkbenchHostNodeHeaderFrameRenderKey;
  hasFrameRenderKey: boolean;
  host: WorkbenchHostRuntimeHandle;
  renderRevision: object;
}

function WorkbenchHostNodeHeaderRenderer(
  input: WorkbenchHostNodeHeaderRendererProps
): ReactNode {
  return input.definition.renderHeader?.(input.context);
}

function areWorkbenchHostNodeHeaderRendererPropsEqual(
  previous: WorkbenchHostNodeHeaderRendererProps,
  next: WorkbenchHostNodeHeaderRendererProps
): boolean {
  if (
    previous.definition !== next.definition ||
    previous.host !== next.host ||
    previous.renderRevision !== next.renderRevision ||
    previous.context.activation !== next.context.activation ||
    previous.context.externalNodeState !== next.context.externalNodeState ||
    previous.context.externalWorkspaceState !==
      next.context.externalWorkspaceState ||
    previous.context.isDragging !== next.context.isDragging ||
    previous.context.isFocused !== next.context.isFocused ||
    previous.context.isResizing !== next.context.isResizing
  ) {
    return false;
  }

  const previousNode = previous.context.node;
  const nextNode = next.context.node;
  const nonFrameInputsEqual =
    previous.context.surfaceSize.width === next.context.surfaceSize.width &&
    previous.context.surfaceSize.height === next.context.surfaceSize.height &&
    previousNode.id === nextNode.id &&
    previousNode.kind === nextNode.kind &&
    previousNode.title === nextNode.title &&
    previousNode.displayMode === nextNode.displayMode &&
    previousNode.restoreFrame === nextNode.restoreFrame &&
    previousNode.isMinimized === nextNode.isMinimized &&
    previousNode.minimizedAtUnixMs === nextNode.minimizedAtUnixMs &&
    previousNode.sizeConstraints === nextNode.sizeConstraints &&
    previousNode.data === nextNode.data;
  if (!nonFrameInputsEqual) {
    return false;
  }

  if (
    (next.context.isDragging || next.context.isResizing) &&
    next.hasFrameRenderKey
  ) {
    return Object.is(previous.frameRenderKey, next.frameRenderKey);
  }

  return areWorkbenchFramesEqual(previousNode.frame, nextNode.frame);
}

function areWorkbenchFramesEqual(
  previous: WorkbenchNode["frame"],
  next: WorkbenchNode["frame"]
): boolean {
  return (
    previous.x === next.x &&
    previous.y === next.y &&
    previous.width === next.width &&
    previous.height === next.height
  );
}

const MemoizedWorkbenchHostNodeHeaderRenderer = memo(
  WorkbenchHostNodeHeaderRenderer,
  areWorkbenchHostNodeHeaderRendererPropsEqual
);

interface WorkbenchHostSurfaceRenderErrorBoundaryProps {
  children: ReactNode;
  debugDiagnostics?: WorkbenchHostProps["debugDiagnostics"];
  details?: Record<string, unknown>;
  event: string;
  fallbackKind: string;
  resetKey: string;
  workspaceId: string;
}

interface WorkbenchHostNodeRenderErrorBoundaryState {
  hasError: boolean;
}

interface WorkbenchHostSurfaceRenderErrorBoundaryState {
  hasError: boolean;
}

class WorkbenchHostSurfaceRenderErrorBoundary extends Component<
  WorkbenchHostSurfaceRenderErrorBoundaryProps,
  WorkbenchHostSurfaceRenderErrorBoundaryState
> {
  override state: WorkbenchHostSurfaceRenderErrorBoundaryState = {
    hasError: false
  };

  static getDerivedStateFromError(): WorkbenchHostSurfaceRenderErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidUpdate(
    previousProps: WorkbenchHostSurfaceRenderErrorBoundaryProps
  ): void {
    if (this.state.hasError && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    try {
      const result = this.props.debugDiagnostics?.log?.({
        details: {
          ...(this.props.details ?? {}),
          componentStack: info.componentStack ?? null,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : typeof error,
          errorStack: error instanceof Error ? (error.stack ?? null) : null
        },
        event: this.props.event,
        level: "error",
        source: "workbench-host",
        workspaceId: this.props.workspaceId
      });
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Rendering recovery must not depend on diagnostics transport.
    }
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          data-workbench-surface-render-error={this.props.fallbackKind}
          style={{ height: "100%", width: "100%" }}
        />
      );
    }

    return this.props.children;
  }
}

class WorkbenchHostNodeRenderErrorBoundary extends Component<
  WorkbenchHostNodeRenderErrorBoundaryProps,
  WorkbenchHostNodeRenderErrorBoundaryState
> {
  override state: WorkbenchHostNodeRenderErrorBoundaryState = {
    hasError: false
  };

  static getDerivedStateFromError(): WorkbenchHostNodeRenderErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidUpdate(
    previousProps: WorkbenchHostNodeRenderErrorBoundaryProps
  ): void {
    if (
      this.state.hasError &&
      !Object.is(previousProps.resetKey, this.props.resetKey)
    ) {
      this.setState({ hasError: false });
      this.props.onErrorChange?.(false);
    }
  }

  override componentWillUnmount(): void {
    if (this.state.hasError) {
      this.props.onErrorChange?.(false);
    }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onErrorChange?.(true);
    try {
      const result = this.props.debugDiagnostics?.log?.({
        details: {
          componentStack: info.componentStack ?? null,
          dockEntryId: this.props.node.data.dockEntryId ?? null,
          displayMode: this.props.node.displayMode,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : typeof error,
          errorStack: error instanceof Error ? (error.stack ?? null) : null,
          frame: this.props.node.frame,
          instanceId: this.props.node.data.instanceId,
          instanceKey: this.props.node.data.instanceKey ?? null,
          isMinimized: this.props.node.isMinimized,
          launchSource: this.props.node.data.launchSource ?? null,
          nodeId: this.props.node.id,
          typeId: this.props.node.data.typeId
        },
        event: "workbench.node.render_error",
        level: "error",
        source: "workbench-host",
        workspaceId: this.props.workspaceId
      });
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Rendering recovery must not depend on diagnostics transport.
    }
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          data-workbench-node-render-error="true"
          style={{
            alignItems: "center",
            boxSizing: "border-box",
            color: "var(--text-secondary, #6b7280)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            height: "100%",
            justifyContent: "center",
            padding: 24,
            textAlign: "center",
            width: "100%"
          }}
        >
          <div
            data-workbench-node-render-error-message="true"
            style={{
              color: "var(--text-primary, #111827)",
              fontSize: 14,
              fontWeight: 600
            }}
          >
            This workspace view failed to render.
          </div>
          <div style={{ fontSize: 12 }}>
            Try selecting another conversation or reopen the window.
          </div>
          <button
            type="button"
            onClick={() => {
              this.setState({ hasError: false });
              this.props.onErrorChange?.(false);
            }}
            style={{
              border: "1px solid var(--line-2, #d1d5db)",
              borderRadius: 6,
              background: "var(--background-fronted, #ffffff)",
              color: "var(--text-primary, #111827)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              marginTop: 4,
              padding: "6px 10px"
            }}
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

function WorkbenchHostNodeBodyRenderer({
  context,
  definition
}: {
  context: WorkbenchHostNodeBodyContext;
  definition: WorkbenchHostNodeDefinition;
}): ReactNode {
  return definition.renderBody(context);
}

function WorkbenchHostChromeRenderer({
  context,
  renderChrome
}: {
  context: WorkbenchHostChromeRenderContext;
  renderChrome: NonNullable<WorkbenchHostProps["renderTopChrome"]>;
}): ReactNode {
  return renderChrome(context);
}
