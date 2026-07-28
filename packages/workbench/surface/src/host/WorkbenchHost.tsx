import { useMemo } from "react";
import {
  WorkbenchMissionControlBackdrop,
  WorkbenchMissionControlOverlay
} from "../mission-control/WorkbenchMissionControlOverlay.tsx";
import { useWorkbenchMissionControlPresence } from "../mission-control/useWorkbenchMissionControlPresence.ts";
import { useWorkbenchMissionControlState } from "../mission-control/useWorkbenchMissionControlState.ts";
import { WorkbenchSurface } from "../react/WorkbenchSurface.tsx";
import {
  resolveWorkbenchHostDockEntries,
  resolveWorkbenchHostRuntimeConfig
} from "./hostConfig.ts";
import type { WorkbenchHostNodeData, WorkbenchHostProps } from "./types.ts";
import { useWorkbenchHostRuntime } from "./useWorkbenchHostRuntime.ts";
import { useWorkbenchHostSurfaceRenderers } from "./useWorkbenchHostSurfaceRenderers.tsx";

const noop = () => {};

export function WorkbenchHost({
  captureNodePreviewImage,
  captureNodePreviewImages,
  className,
  contributions,
  debugDiagnostics,
  dockPreviewCache,
  dockPlacement,
  dockEntryPresentationOverrides,
  dockEntries,
  dockStateSource,
  externalStateSource,
  i18n,
  layoutConstraints,
  missionControl,
  minimizeAnimation,
  nodes,
  onDockEntryAction,
  onDockEntryClick,
  onHandleReady,
  onLaunchRequest,
  onMissionControlAdapterReady,
  onMissionControlRequestOpen,
  onNodeCloseRequest,
  projectedNodes,
  renderBottomChrome,
  renderTopChrome,
  snapshotRepository,
  shortcutsEnabled,
  wallpaper,
  windowManagement,
  workspaceId
}: WorkbenchHostProps) {
  const hostRuntimeConfig = useMemo(
    () =>
      resolveWorkbenchHostRuntimeConfig({
        contributions,
        externalStateSource,
        nodes,
        onLaunchRequest,
        onNodeCloseRequest
      }),
    [
      contributions,
      externalStateSource,
      nodes,
      onLaunchRequest,
      onNodeCloseRequest
    ]
  );
  const hostDockEntries = useMemo(
    () =>
      resolveWorkbenchHostDockEntries({
        contributions,
        dockEntryPresentationOverrides,
        dockEntries
      }),
    [contributions, dockEntries, dockEntryPresentationOverrides]
  );
  const missionControlActive = missionControl?.active ?? false;
  const missionControlNodeIds = missionControl?.nodeIds;
  const missionControlClose = missionControl?.onRequestClose ?? noop;
  const missionControlEnabled =
    missionControlActive || onMissionControlAdapterReady !== undefined;
  const {
    chromeContext,
    hostI18n,
    hostSession,
    isHydrating,
    missionControlI18n,
    missionControlAdapter,
    nodeDefinitionByType,
    windowChromeI18n
  } = useWorkbenchHostRuntime({
    debugDiagnostics,
    externalStateSource: hostRuntimeConfig.externalStateSource,
    i18n,
    missionControlEnabled,
    nodes: hostRuntimeConfig.nodes,
    onHandleReady,
    onLaunchRequest: hostRuntimeConfig.onLaunchRequest,
    onMissionControlAdapterReady,
    onNodeCloseRequest: hostRuntimeConfig.onNodeCloseRequest,
    projectedNodes,
    snapshotRepository,
    workspaceId
  });
  const surfaceRenderers = useWorkbenchHostSurfaceRenderers({
    captureNodePreviewImage,
    captureNodePreviewImages,
    chromeContext,
    debugDiagnostics,
    dockPreviewCache,
    dockPlacement,
    dockStateSource,
    dockEntries: hostDockEntries,
    externalStateSource: hostRuntimeConfig.externalStateSource,
    hostI18n,
    hostSession,
    nodeDefinitionByType,
    onDockEntryAction,
    onDockEntryClick,
    onMissionControlRequestOpen,
    renderBottomChrome,
    renderTopChrome,
    workspaceId
  });
  const missionControlState = useWorkbenchMissionControlState({
    active: missionControlActive,
    adapter: missionControlAdapter,
    nodeIds: missionControlNodeIds,
    onRequestClose: missionControlClose
  });
  const missionControlPresence =
    useWorkbenchMissionControlPresence(missionControlState);
  const missionControlRenderedState = missionControlPresence.state;

  return (
    <WorkbenchSurface<WorkbenchHostNodeData>
      className={className}
      captureNodePreviewImage={surfaceRenderers.captureNodePreviewImage}
      captureNodePreviewImages={surfaceRenderers.captureNodePreviewImages}
      controller={hostSession.controller}
      debugDiagnostics={debugDiagnostics}
      dockPreviewCache={dockPreviewCache}
      dockPlacement={dockPlacement}
      interactive={!isHydrating}
      layoutConstraints={layoutConstraints}
      missionControlPhase={missionControlPresence.phase}
      minimizeAnimation={minimizeAnimation}
      presentation={missionControlState?.presentation ?? null}
      renderBackdrop={
        missionControlRenderedState
          ? () => (
              <WorkbenchMissionControlBackdrop
                onExitTransitionComplete={() =>
                  missionControlPresence.completeExitTransition()
                }
                phase={missionControlPresence.phase}
              />
            )
          : undefined
      }
      renderBottomChrome={surfaceRenderers.renderBottomChrome}
      renderDock={surfaceRenderers.renderDock}
      renderNode={surfaceRenderers.renderNode}
      renderNodeGeniePreview={surfaceRenderers.renderNodeGeniePreview}
      renderOverlay={
        missionControlRenderedState
          ? () => (
              <WorkbenchMissionControlOverlay
                i18n={missionControlI18n}
                phase={missionControlPresence.phase}
                state={missionControlRenderedState}
              />
            )
          : undefined
      }
      renderTopChrome={surfaceRenderers.renderTopChrome}
      renderWindowActions={surfaceRenderers.renderWindowActions}
      renderWindowHeader={surfaceRenderers.renderWindowHeader}
      shouldKeepMinimizedNodeMounted={
        surfaceRenderers.shouldKeepMinimizedNodeMounted
      }
      resolveDockPreviewCacheKey={surfaceRenderers.resolveDockPreviewCacheKey}
      resolveFullscreenHeaderMode={surfaceRenderers.resolveFullscreenHeaderMode}
      resolveWindowHeaderPresentation={
        surfaceRenderers.resolveWindowHeaderPresentation
      }
      resolveWindowSurfaceLayer={surfaceRenderers.resolveWindowSurfaceLayer}
      resolveWindowZIndex={surfaceRenderers.resolveWindowZIndex}
      resolveDockAnchorKey={surfaceRenderers.resolveDockAnchorKey}
      shortcutsEnabled={shortcutsEnabled}
      shouldCaptureNodePreviewImage={
        surfaceRenderers.shouldCaptureNodePreviewImage
      }
      wallpaper={wallpaper}
      windowManagement={windowManagement}
      windowChromeI18n={windowChromeI18n}
      windowChromeMode={surfaceRenderers.windowChromeMode}
    />
  );
}
