import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type CSSProperties,
  type ReactNode
} from "react";
import type { WorkbenchController } from "../store/types.ts";
import type {
  WorkbenchLayoutConstraintsInput,
  WorkbenchNode,
  WorkbenchSize
} from "../core/types.ts";
import { WorkbenchDockFrame } from "./WorkbenchDockFrame.tsx";
import {
  selectVisibleFullscreenNode,
  WorkbenchImmersiveChromeHeader
} from "./WorkbenchImmersiveChromeHeader.tsx";
import { WorkbenchLockedSlotLayer } from "./WorkbenchLockedSlotLayer.tsx";
import { WorkbenchNodeLayer } from "./WorkbenchNodeLayer.tsx";
import {
  WorkbenchProvider,
  useWorkbenchController
} from "./WorkbenchProvider.tsx";
import type { WorkbenchDebugDiagnostics } from "../store/types.ts";
import { useWorkbenchSelector } from "./hooks/useWorkbenchSelector.ts";
import { useWorkbenchShortcuts } from "./hooks/useWorkbenchShortcuts.ts";
import type { WorkbenchWindowManagementShortcutPreset } from "./hooks/workbenchShortcutIntent.ts";
import { useWorkbenchSurfaceSize } from "./hooks/useWorkbenchSurfaceSize.ts";
import { useWorkbenchGenieAnimation } from "./useWorkbenchGenieAnimation.tsx";
import type { WorkbenchNodeGeniePreviewRenderer } from "./useWorkbenchGenieAnimation.tsx";
import type {
  WorkbenchDockContext,
  WorkbenchDockPlacement,
  WorkbenchKeepMinimizedNodeMounted,
  WorkbenchMinimizeAnimation,
  WorkbenchRenderNode,
  WorkbenchSurfacePresentation,
  WorkbenchRenderWindowActions,
  WorkbenchRenderWindowHeader,
  WorkbenchTopChromeRenderContext,
  WorkbenchResolveFullscreenHeaderMode,
  WorkbenchResolveWindowSurfaceLayer,
  WorkbenchResolveWindowZIndex,
  WorkbenchResolveWindowChromeMode,
  WorkbenchWindowChromeMode
} from "./types.ts";
import type {
  WorkbenchDockPreviewCache,
  WorkbenchDockPreviewCacheKeyResolver
} from "./dockPreviewCache.ts";
import type { WorkbenchWindowChromeI18nRuntime } from "./workbenchWindowI18n.ts";

export interface WorkbenchSurfaceProps<TData = unknown> {
  autoHideChrome?: WorkbenchAutoHideChromeConfig;
  captureNodePreviewImage?: (
    node: WorkbenchNode<TData>
  ) => Promise<string | null> | string | null;
  className?: string;
  controller: WorkbenchController<TData>;
  debugDiagnostics?: WorkbenchDebugDiagnostics;
  dockPreviewCache?: WorkbenchDockPreviewCache;
  dockPlacement?: WorkbenchDockPlacement;
  interactive?: boolean;
  layoutConstraints?: WorkbenchLayoutConstraintsInput;
  missionControlPhase?: "closed" | "entering" | "open" | "closing";
  minimizeAnimation?: WorkbenchMinimizeAnimation;
  presentation?: WorkbenchSurfacePresentation | null;
  renderBackdrop?: () => ReactNode;
  renderBottomChrome?: () => ReactNode;
  renderDock?: (context: WorkbenchDockContext<TData>) => ReactNode;
  renderNode: WorkbenchRenderNode<TData>;
  renderNodeGeniePreview?: WorkbenchNodeGeniePreviewRenderer<TData>;
  renderOverlay?: () => ReactNode;
  renderTopChrome?: (context: WorkbenchTopChromeRenderContext) => ReactNode;
  renderWindowActions?: WorkbenchRenderWindowActions<TData>;
  renderWindowHeader?: WorkbenchRenderWindowHeader<TData>;
  shouldKeepMinimizedNodeMounted?: WorkbenchKeepMinimizedNodeMounted<TData>;
  resolveFullscreenHeaderMode?: WorkbenchResolveFullscreenHeaderMode<TData>;
  resolveWindowSurfaceLayer?: WorkbenchResolveWindowSurfaceLayer<TData>;
  resolveWindowZIndex?: WorkbenchResolveWindowZIndex<TData>;
  resolveDockAnchorKey?: (node: WorkbenchNode<TData>) => string;
  resolveDockPreviewCacheKey?: WorkbenchDockPreviewCacheKeyResolver<TData>;
  shortcutsEnabled?: boolean;
  shouldCaptureNodePreviewImage?: (node: WorkbenchNode<TData>) => boolean;
  wallpaper?: WorkbenchSurfaceWallpaper;
  windowManagement?: WorkbenchWindowManagementConfig;
  windowChromeMode?:
    | WorkbenchWindowChromeMode
    | WorkbenchResolveWindowChromeMode<TData>;
  windowChromeI18n?: WorkbenchWindowChromeI18nRuntime;
}

export interface WorkbenchAutoHideChromeConfig {
  collapseDelayMs?: number;
  dockHandleLabel: string;
  topHandleLabel: string;
}

export interface WorkbenchWindowManagementConfig {
  edgeSnapEnabled?: boolean;
  shortcutPreset?: WorkbenchWindowManagementShortcutPreset | null;
}

export type WorkbenchSurfaceWallpaperFit =
  | "contain"
  | "cover"
  | "stretch"
  | "center";

export interface WorkbenchSurfaceWallpaper {
  appearance?: "dark" | "light";
  fit?: WorkbenchSurfaceWallpaperFit;
  position?: string;
  url: string;
}

export function WorkbenchSurface<TData>({
  autoHideChrome,
  captureNodePreviewImage,
  className,
  controller,
  debugDiagnostics,
  dockPreviewCache,
  dockPlacement,
  interactive,
  layoutConstraints,
  missionControlPhase,
  minimizeAnimation,
  presentation,
  renderBackdrop,
  renderBottomChrome,
  renderDock,
  renderNode,
  renderNodeGeniePreview,
  renderOverlay,
  renderTopChrome,
  renderWindowActions,
  renderWindowHeader,
  shouldKeepMinimizedNodeMounted,
  resolveFullscreenHeaderMode,
  resolveWindowSurfaceLayer,
  resolveWindowZIndex,
  resolveDockAnchorKey,
  resolveDockPreviewCacheKey,
  shortcutsEnabled,
  shouldCaptureNodePreviewImage,
  wallpaper,
  windowManagement,
  windowChromeMode,
  windowChromeI18n
}: WorkbenchSurfaceProps<TData>) {
  return (
    <WorkbenchProvider controller={controller}>
      <WorkbenchSurfaceInner
        autoHideChrome={autoHideChrome}
        captureNodePreviewImage={captureNodePreviewImage}
        className={className}
        debugDiagnostics={debugDiagnostics}
        dockPreviewCache={dockPreviewCache}
        dockPlacement={dockPlacement}
        interactive={interactive}
        layoutConstraints={layoutConstraints}
        missionControlPhase={missionControlPhase}
        minimizeAnimation={minimizeAnimation}
        presentation={presentation}
        renderBackdrop={renderBackdrop}
        renderBottomChrome={renderBottomChrome}
        renderDock={renderDock}
        renderNode={renderNode}
        renderNodeGeniePreview={renderNodeGeniePreview}
        renderOverlay={renderOverlay}
        renderTopChrome={renderTopChrome}
        renderWindowActions={renderWindowActions}
        renderWindowHeader={renderWindowHeader}
        shouldKeepMinimizedNodeMounted={shouldKeepMinimizedNodeMounted}
        resolveFullscreenHeaderMode={resolveFullscreenHeaderMode}
        resolveWindowSurfaceLayer={resolveWindowSurfaceLayer}
        resolveWindowZIndex={resolveWindowZIndex}
        resolveDockAnchorKey={resolveDockAnchorKey}
        resolveDockPreviewCacheKey={resolveDockPreviewCacheKey}
        shortcutsEnabled={shortcutsEnabled}
        shouldCaptureNodePreviewImage={shouldCaptureNodePreviewImage}
        wallpaper={wallpaper}
        windowManagement={windowManagement}
        windowChromeMode={windowChromeMode}
        windowChromeI18n={windowChromeI18n}
      />
    </WorkbenchProvider>
  );
}

function WorkbenchSurfaceInner<TData>({
  autoHideChrome,
  captureNodePreviewImage,
  className,
  debugDiagnostics,
  dockPreviewCache,
  dockPlacement,
  interactive = true,
  layoutConstraints,
  missionControlPhase,
  minimizeAnimation,
  presentation,
  renderBackdrop,
  renderBottomChrome,
  renderDock,
  renderNode,
  renderNodeGeniePreview,
  renderOverlay,
  renderTopChrome,
  renderWindowActions,
  renderWindowHeader,
  shouldKeepMinimizedNodeMounted,
  resolveFullscreenHeaderMode,
  resolveWindowSurfaceLayer,
  resolveWindowZIndex,
  resolveDockAnchorKey,
  resolveDockPreviewCacheKey,
  shortcutsEnabled,
  shouldCaptureNodePreviewImage,
  wallpaper,
  windowManagement,
  windowChromeMode,
  windowChromeI18n
}: Omit<WorkbenchSurfaceProps<TData>, "controller">) {
  const controller = useWorkbenchController<TData>();
  const immersiveFullscreenNode = useWorkbenchSelector<
    TData,
    WorkbenchNode<TData> | null
  >(selectVisibleFullscreenNode);
  const surfaceSize = useWorkbenchSelector<TData, WorkbenchSize>(
    (state) => state.surfaceSize
  );
  const topChromeRegion = useWorkbenchAutoHideRegion({
    collapseDelayMs: autoHideChrome?.collapseDelayMs,
    enabled: autoHideChrome !== undefined
  });
  const dockRegion = useWorkbenchAutoHideRegion({
    collapseDelayMs: autoHideChrome?.collapseDelayMs,
    enabled: autoHideChrome !== undefined
  });
  const topChromeId = useId();
  const dockId = useId();
  const onSizeChange = useCallback(
    (size: { width: number; height: number }) => {
      controller.commands.setSurfaceSize(size);
    },
    [controller]
  );
  const ref = useWorkbenchSurfaceSize<HTMLDivElement>(onSizeChange);
  const genie = useWorkbenchGenieAnimation({
    captureNodePreviewImage,
    controller,
    debugDiagnostics,
    dockPreviewCache,
    minimizeAnimation,
    renderNodeGeniePreview,
    resolveDockAnchorKey,
    resolveDockPreviewCacheKey,
    shouldCaptureNodePreviewImage
  });
  useWorkbenchShortcuts<TData>({
    enabled: (shortcutsEnabled ?? true) && interactive,
    windowManagementShortcutPreset: windowManagement?.shortcutPreset ?? null
  });
  useEffect(() => {
    if (!layoutConstraints) {
      return;
    }
    controller.commands.setLayoutConstraints(layoutConstraints);
  }, [controller, layoutConstraints]);
  const wallpaperStyle: CSSProperties | undefined = wallpaper
    ? {
        backgroundImage: `url(${JSON.stringify(wallpaper.url)})`,
        backgroundPosition: wallpaper.position ?? "center",
        backgroundSize: resolveWorkbenchSurfaceWallpaperBackgroundSize(
          wallpaper.fit ?? "cover"
        )
      }
    : undefined;

  return (
    <div
      ref={ref}
      className={["workbench-surface", className].filter(Boolean).join(" ")}
      data-mission-control-phase={missionControlPhase ?? "closed"}
      data-presentation-mode={presentation?.mode ?? "default"}
      data-workbench-auto-hide-chrome={
        autoHideChrome === undefined ? "disabled" : "enabled"
      }
      data-workbench-top-chrome-state={topChromeRegion.state}
      data-workbench-interactive={interactive ? "true" : "false"}
    >
      {wallpaper ? (
        <div
          className="workbench-surface__wallpaper"
          style={wallpaperStyle}
          aria-hidden
        />
      ) : null}
      {renderTopChrome ? (
        <div
          id={topChromeId}
          className="workbench-surface__top-chrome"
          data-auto-hide-state={topChromeRegion.state}
          inert={topChromeRegion.state === "hidden" ? true : undefined}
          onBlurCapture={topChromeRegion.onBlurCapture}
          onFocusCapture={topChromeRegion.onFocusCapture}
          onPointerEnter={topChromeRegion.onPointerEnter}
          onPointerLeave={topChromeRegion.onPointerLeave}
        >
          {renderTopChrome({
            immersiveFullscreenHeader:
              autoHideChrome !== undefined &&
              immersiveFullscreenNode &&
              interactive &&
              presentation?.mode !== "mission-control" ? (
                <WorkbenchImmersiveChromeHeader
                  genie={genie}
                  node={immersiveFullscreenNode}
                  renderWindowHeader={renderWindowHeader}
                  surfaceSize={surfaceSize}
                  windowChromeI18n={windowChromeI18n}
                />
              ) : null
          })}
        </div>
      ) : null}
      {renderTopChrome && autoHideChrome !== undefined ? (
        <WorkbenchAutoHideHandle
          controls={topChromeId}
          edge="top"
          expanded={topChromeRegion.state === "expanded"}
          label={autoHideChrome.topHandleLabel}
          onReveal={topChromeRegion.reveal}
        />
      ) : null}
      {renderBackdrop ? renderBackdrop() : null}
      {presentation?.mode === "mission-control" ? null : (
        <WorkbenchLockedSlotLayer />
      )}
      <WorkbenchNodeLayer
        genie={genie}
        interactive={interactive}
        presentation={presentation}
        immersiveFullscreenChrome={
          autoHideChrome !== undefined && renderTopChrome !== undefined
        }
        renderNode={renderNode}
        edgeSnapEnabled={windowManagement?.edgeSnapEnabled === true}
        renderWindowActions={renderWindowActions}
        renderWindowHeader={renderWindowHeader}
        shouldKeepMinimizedNodeMounted={shouldKeepMinimizedNodeMounted}
        resolveFullscreenHeaderMode={resolveFullscreenHeaderMode}
        resolveWindowSurfaceLayer={resolveWindowSurfaceLayer}
        resolveWindowZIndex={resolveWindowZIndex}
        windowChromeMode={windowChromeMode}
        windowChromeI18n={windowChromeI18n}
      />
      <WorkbenchDockFrame
        autoHide={
          autoHideChrome === undefined
            ? undefined
            : {
                controls: dockId,
                expanded: dockRegion.state === "expanded",
                handleLabel: autoHideChrome.dockHandleLabel,
                onBlurCapture: dockRegion.onBlurCapture,
                onFocusCapture: dockRegion.onFocusCapture,
                onPointerEnter: dockRegion.onPointerEnter,
                onPointerLeave: dockRegion.onPointerLeave,
                onReveal: dockRegion.reveal,
                regionId: dockId
              }
        }
        dockPlacement={dockPlacement}
        genie={genie}
        interactive={interactive}
        renderDock={renderDock}
      />
      {renderBottomChrome ? (
        <div className="workbench-surface__bottom-chrome">
          {renderBottomChrome()}
        </div>
      ) : null}
      {renderOverlay ? renderOverlay() : null}
      {genie.genieLayer}
    </div>
  );
}

function WorkbenchAutoHideHandle({
  controls,
  edge,
  expanded,
  label,
  onReveal
}: {
  controls: string;
  edge: "bottom" | "left" | "top";
  expanded: boolean;
  label: string;
  onReveal: () => void;
}) {
  if (expanded) {
    return null;
  }

  return (
    <button
      aria-controls={controls}
      aria-expanded="false"
      aria-label={label}
      className="workbench-auto-hide-handle"
      data-edge={edge}
      title={label}
      type="button"
      onClick={onReveal}
    >
      <span className="workbench-auto-hide-handle__label">{label}</span>
    </button>
  );
}

function useWorkbenchAutoHideRegion(input: {
  collapseDelayMs?: number;
  enabled: boolean;
}) {
  const [expanded, setExpanded] = useState(!input.enabled);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collapseDelayMs = input.collapseDelayMs ?? 650;
  const revealGraceMs = Math.max(collapseDelayMs, 1_600);

  const cancelCollapse = useCallback(() => {
    if (collapseTimerRef.current === null) {
      return;
    }
    clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = null;
  }, []);
  const scheduleCollapseAfter = useCallback(
    (delayMs: number) => {
      cancelCollapse();
      if (!input.enabled) {
        return;
      }
      collapseTimerRef.current = setTimeout(() => {
        collapseTimerRef.current = null;
        setExpanded(false);
      }, delayMs);
    },
    [cancelCollapse, input.enabled]
  );
  const scheduleCollapse = useCallback(() => {
    scheduleCollapseAfter(collapseDelayMs);
  }, [collapseDelayMs, scheduleCollapseAfter]);

  useEffect(() => {
    cancelCollapse();
    setExpanded(!input.enabled);
  }, [cancelCollapse, input.enabled]);
  useEffect(() => cancelCollapse, [cancelCollapse]);

  return {
    state: expanded ? ("expanded" as const) : ("hidden" as const),
    reveal() {
      cancelCollapse();
      setExpanded(true);
      scheduleCollapseAfter(revealGraceMs);
    },
    onBlurCapture(event: FocusEvent<HTMLElement>) {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return;
      }
      scheduleCollapse();
    },
    onFocusCapture: cancelCollapse,
    onPointerEnter: cancelCollapse,
    onPointerLeave(_event: PointerEvent<HTMLElement>) {
      scheduleCollapse();
    }
  };
}

function resolveWorkbenchSurfaceWallpaperBackgroundSize(
  fit: WorkbenchSurfaceWallpaperFit
): string {
  switch (fit) {
    case "contain":
      return "contain";
    case "cover":
      return "cover";
    case "stretch":
      return "100% 100%";
    case "center":
      return "auto";
  }
}
