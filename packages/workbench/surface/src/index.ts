export { createWorkbenchController } from "./store/createWorkbenchController.ts";
export { WorkbenchHost } from "./host/WorkbenchHost.tsx";
export {
  createWorkbenchHostI18nRuntime,
  workbenchHostI18nResources
} from "./host/workbenchHostI18n.ts";
export { resolveWorkbenchHostPrepareClose } from "./host/hostConfig.ts";
export { workbenchFocusInputActivationType } from "./host/activations.ts";
export type {
  WorkbenchDockPreviewCache,
  WorkbenchDockPreviewCacheKey,
  WorkbenchDockPreviewCacheKeyResolver
} from "./react/dockPreviewCache.ts";
export type {
  WorkbenchMissionControlAdapter,
  WorkbenchMissionControlMode,
  WorkbenchMissionControlSnapshot
} from "./mission-control/types.ts";
export {
  createWorkbenchNode,
  createWorkbenchNodeFromSnapshot,
  createWorkbenchSnapshotFromState,
  createWorkbenchStateFromSnapshot,
  type CreateWorkbenchNodeInput,
  type CreateWorkbenchSnapshotFromStateOptions
} from "./core/snapshot.ts";
export {
  createWorkbenchHostLaunchedNodeId,
  createWorkbenchHostProjectedNodeId,
  type WorkbenchHostNodeIdentityInput
} from "./host/nodeIdentity.ts";
export type {
  WorkbenchController,
  WorkbenchDebugDiagnostics
} from "./store/types.ts";
export type {
  WorkbenchContribution,
  WorkbenchDockPreviewContent,
  WorkbenchHostActivation,
  WorkbenchHostActivationTarget,
  WorkbenchHostChromeRenderContext,
  WorkbenchHostDockEntry,
  WorkbenchHostDockEntryAction,
  WorkbenchHostDockEntryBadge,
  WorkbenchHostDockEntryDynamicState,
  WorkbenchHostDockEntryLaunchBehavior,
  WorkbenchHostDockEntryStateSource,
  WorkbenchHostDockPopupItemDescriptor,
  WorkbenchHostDockPopupItemInput,
  WorkbenchHostDockEntryState,
  WorkbenchHostDockEntryStateKind,
  WorkbenchHostDockEntryVisibility,
  WorkbenchHostCloseDialogRequest,
  WorkbenchHostCloseEffect,
  WorkbenchHostCloseDialogScope,
  WorkbenchHostCloseDialogVariant,
  WorkbenchHostClosePreparationContext,
  WorkbenchHostClosePreparer,
  WorkbenchHostExternalStateLookupInput,
  WorkbenchHostExternalStateSource,
  WorkbenchHostHandle,
  WorkbenchHostLaunchInput,
  WorkbenchHostLaunchFramePolicy,
  WorkbenchHostLaunchReason,
  WorkbenchHostLaunchRequest,
  WorkbenchHostLaunchResult,
  WorkbenchHostMissionControlProps,
  WorkbenchHostMissionControlMode,
  WorkbenchHostMultiInstanceStrategy,
  WorkbenchHostNodeCloseDecision,
  WorkbenchHostNodeCloseRequest,
  WorkbenchHostNodeBodyContext,
  WorkbenchHostNodeData,
  WorkbenchHostNodeDefinition,
  WorkbenchHostNodeHeaderContext,
  WorkbenchHostNodeHeaderWindowActions,
  WorkbenchHostNodeInstanceStrategy,
  WorkbenchHostNodeMinimizedDockCapability,
  WorkbenchHostNodeWindowCapabilities,
  WorkbenchHostProps,
  WorkbenchHostProjectedNode,
  WorkbenchHostProjectedNodeSubject,
  WorkbenchHostSingleInstanceStrategy,
  WorkbenchHostSnapshotRepository,
  WorkbenchHostWindowCloseEffectContext
} from "./host/types.ts";
export {
  WorkbenchSurface,
  type WorkbenchSurfaceProps,
  type WorkbenchSurfaceWallpaper,
  type WorkbenchSurfaceWallpaperFit
} from "./react/WorkbenchSurface.tsx";
export { useWorkbenchSelector } from "./react/hooks/useWorkbenchSelector.ts";
export { getWorkbenchLayoutFrame } from "./core/geometry.ts";
export {
  createWorkbenchWindowChromeI18nRuntime,
  workbenchWindowChromeI18nNamespace,
  workbenchWindowChromeI18nResources,
  type WorkbenchWindowChromeI18nKey,
  type WorkbenchWindowChromeI18nRuntime
} from "./react/workbenchWindowI18n.ts";
export type {
  WorkbenchDisplayMode,
  WorkbenchFrame,
  WorkbenchLayoutPreset,
  WorkbenchLayoutConstraints,
  WorkbenchLayoutConstraintsInput,
  WorkbenchNode,
  WorkbenchNodeSizeConstraints,
  WorkbenchQuickLayoutTarget,
  WorkbenchSafeArea,
  WorkbenchSize,
  WorkbenchState
} from "./core/types.ts";
export type {
  WorkbenchDockContext,
  WorkbenchDockPlacement,
  WorkbenchNodeRenderFrame,
  WorkbenchRenderNode,
  WorkbenchRenderNodeContext,
  WorkbenchRenderWindowActions,
  WorkbenchRenderWindowHeader,
  WorkbenchResolveFullscreenHeaderMode,
  WorkbenchResolveWindowChromeMode,
  WorkbenchResolveWindowChromeModeContext,
  WorkbenchSurfacePresentation,
  WorkbenchFullscreenHeaderMode,
  WorkbenchWindowActionContext,
  WorkbenchWindowChromeMode,
  WorkbenchWindowHeaderContext
} from "./react/types.ts";
