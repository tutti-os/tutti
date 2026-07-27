import {
  useCallback,
  useEffect,
  type CSSProperties,
  type ReactNode
} from "react";
import type { WorkbenchController } from "../store/types.ts";
import type {
  WorkbenchLayoutConstraintsInput,
  WorkbenchNode
} from "../core/types.ts";
import { WorkbenchDockFrame } from "./WorkbenchDockFrame.tsx";
import { WorkbenchLockedSlotLayer } from "./WorkbenchLockedSlotLayer.tsx";
import { WorkbenchNodeLayer } from "./WorkbenchNodeLayer.tsx";
import {
  WorkbenchProvider,
  useWorkbenchController
} from "./WorkbenchProvider.tsx";
import type { WorkbenchDebugDiagnostics } from "../store/types.ts";
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
  WorkbenchResolveFullscreenHeaderMode,
  WorkbenchResolveWindowSurfaceLayer,
  WorkbenchResolveWindowZIndex,
  WorkbenchResolveWindowChromeMode,
  WorkbenchResolveWindowHeaderPresentation,
  WorkbenchWindowChromeMode
} from "./types.ts";
import type {
  WorkbenchDockPreviewCache,
  WorkbenchDockPreviewCacheKeyResolver
} from "./dockPreviewCache.ts";
import type { WorkbenchWindowChromeI18nRuntime } from "./workbenchWindowI18n.ts";

export interface WorkbenchSurfaceProps<TData = unknown> {
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
  renderTopChrome?: () => ReactNode;
  renderWindowActions?: WorkbenchRenderWindowActions<TData>;
  renderWindowHeader?: WorkbenchRenderWindowHeader<TData>;
  shouldKeepMinimizedNodeMounted?: WorkbenchKeepMinimizedNodeMounted<TData>;
  resolveFullscreenHeaderMode?: WorkbenchResolveFullscreenHeaderMode<TData>;
  resolveWindowHeaderPresentation?: WorkbenchResolveWindowHeaderPresentation<TData>;
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
  resolveWindowHeaderPresentation,
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
        resolveWindowHeaderPresentation={resolveWindowHeaderPresentation}
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
  resolveWindowHeaderPresentation,
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
        <div className="workbench-surface__top-chrome">{renderTopChrome()}</div>
      ) : null}
      {renderBackdrop ? renderBackdrop() : null}
      {presentation?.mode === "mission-control" ? null : (
        <WorkbenchLockedSlotLayer />
      )}
      <WorkbenchNodeLayer
        genie={genie}
        interactive={interactive}
        presentation={presentation}
        renderNode={renderNode}
        edgeSnapEnabled={windowManagement?.edgeSnapEnabled === true}
        renderWindowActions={renderWindowActions}
        renderWindowHeader={renderWindowHeader}
        shouldKeepMinimizedNodeMounted={shouldKeepMinimizedNodeMounted}
        resolveFullscreenHeaderMode={resolveFullscreenHeaderMode}
        resolveWindowHeaderPresentation={resolveWindowHeaderPresentation}
        resolveWindowSurfaceLayer={resolveWindowSurfaceLayer}
        resolveWindowZIndex={resolveWindowZIndex}
        windowChromeMode={windowChromeMode}
        windowChromeI18n={windowChromeI18n}
      />
      <WorkbenchDockFrame
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
