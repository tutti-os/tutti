import type { ReactNode } from "react";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { WorkbenchSnapshot } from "@tutti-os/workbench-snapshot";
import type {
  WorkbenchDisplayMode,
  WorkbenchFrame,
  WorkbenchLayoutConstraints,
  WorkbenchLayoutConstraintsInput,
  WorkbenchNode,
  WorkbenchNodeSizeConstraints,
  WorkbenchQuickLayoutTarget,
  WorkbenchSize,
  WorkbenchState
} from "../core/types.ts";
import type {
  WorkbenchMissionControlAdapter,
  WorkbenchMissionControlMode
} from "../mission-control/types.ts";
import type {
  WorkbenchController,
  WorkbenchDebugDiagnostics
} from "../store/types.ts";
import type { WorkbenchSurfaceWallpaper } from "../react/WorkbenchSurface.tsx";
import type {
  WorkbenchDockPlacement,
  WorkbenchWindowHeaderDragHandleProps
} from "../react/types.ts";
import type { WorkbenchDockPreviewCache } from "../react/dockPreviewCache.ts";

export interface WorkbenchHostActivation<TPayload = unknown> {
  payload?: TPayload;
  sequence: number;
  type: string;
}

export interface WorkbenchHostNodeData {
  activation?: WorkbenchHostActivation | null;
  dockEntryId?: string | null;
  instanceId: string;
  instanceKey?: string | null;
  isProjected?: boolean;
  launchSource?: string | null;
  projectionSubject?: WorkbenchHostProjectedNodeSubject | null;
  runtimeNodeState?: unknown;
  snapshotNodeState?: unknown;
  typeId: string;
}

export interface WorkbenchHostProjectedNodeSubject {
  id: string;
  type: string;
}

export interface WorkbenchHostProjectedNode {
  dockEntryId?: string | null;
  defaultFrame?: WorkbenchFrame;
  instanceId: string;
  instanceKey?: string | null;
  sizeConstraints?: WorkbenchNodeSizeConstraints | null;
  subject?: WorkbenchHostProjectedNodeSubject | null;
  title: string;
  typeId: string;
}

export interface WorkbenchHostExternalStateLookupInput {
  instanceId: string;
  instanceKey?: string | null;
  nodeId: string;
  subject?: WorkbenchHostProjectedNodeSubject | null;
  typeId: string;
  workspaceId: string;
}

export interface WorkbenchHostExternalStateSource<
  TNodeState = unknown,
  TWorkspaceState = unknown
> {
  getNodeState(input: WorkbenchHostExternalStateLookupInput): TNodeState;
  getSnapshotNodeState?(input: WorkbenchHostExternalStateLookupInput): unknown;
  getWorkspaceState(input: { workspaceId: string }): TWorkspaceState;
  subscribe?(listener: () => void): () => void;
}

export type WorkbenchHostNodeCloseDecision = "close" | "keep-open";

export type WorkbenchHostCloseDialogScope = "node" | "window";

export type WorkbenchHostCloseDialogVariant = "default" | "destructive";

export interface WorkbenchHostCloseDialogRequest {
  cancelLabel: string;
  confirmLabel: string;
  description: string;
  details?: string | null;
  scope: WorkbenchHostCloseDialogScope;
  title: string;
  variant?: WorkbenchHostCloseDialogVariant;
}

export interface WorkbenchHostCloseEffect {
  description?: string | null;
  nodeId: string;
  title: string;
  typeId: string;
}

export interface WorkbenchHostNodeCloseRequest {
  instanceId: string;
  instanceKey?: string | null;
  isProjected: boolean;
  nodeId: string;
  subject?: WorkbenchHostProjectedNodeSubject | null;
  typeId: string;
  workspaceId: string;
}

export type WorkbenchHostLaunchReason =
  | "command"
  | "dock"
  | "host"
  | "launchpad"
  | "shortcut";

export interface WorkbenchHostLaunchInput {
  dockEntryId?: string;
  launchSource?: string;
  payload?: unknown;
  reason: WorkbenchHostLaunchReason;
  typeId: string;
}

export interface WorkbenchHostLaunchRequest extends WorkbenchHostLaunchInput {
  layoutConstraints: WorkbenchLayoutConstraints;
  surfaceSize: WorkbenchSize;
  workspaceId: string;
}

export type WorkbenchHostLaunchFramePolicy =
  | "absolute"
  | "cascade"
  | "cascade-same-type-centered";

export interface WorkbenchHostLaunchResult {
  activation?: {
    payload?: unknown;
    type: string;
  } | null;
  defaultFrame?: WorkbenchFrame;
  displayMode?: WorkbenchDisplayMode;
  dockEntryId?: string;
  framePolicy: WorkbenchHostLaunchFramePolicy;
  instanceId: string;
  instanceKey?: string | null;
  launchSource?: string | null;
  reuseDockEntryNode?: boolean;
  sizeConstraints?: WorkbenchNodeSizeConstraints | null;
  title?: string;
  typeId: string;
}

export type WorkbenchHostDockEntryVisibility = "always" | "when-open" | "never";

export type WorkbenchHostDockEntryLaunchBehavior = "enabled" | "disabled";

export type WorkbenchHostDockEntryStateKind =
  | "enabled"
  | "disabled"
  | "loading"
  | "unavailable";

export interface WorkbenchHostDockEntryState {
  kind: WorkbenchHostDockEntryStateKind;
  reason?: string;
}

export type WorkbenchHostDockEntryBadge =
  | { kind: "count"; value: number }
  | {
      kind: "status";
      status: "running" | "completed" | "failed" | "warning";
    }
  | { content: ReactNode; kind: "custom" };

export interface WorkbenchHostDockEntryAction {
  disabled?: boolean;
  id: string;
  label: string;
  pendingLabel?: string;
}

export interface WorkbenchHostDockPopupItemInput {
  externalNodeState?: unknown;
  externalWorkspaceState?: unknown;
  host: WorkbenchHostHandle;
  isFocused: boolean;
  isMinimized: boolean;
  node: WorkbenchNode<WorkbenchHostNodeData>;
}

export type WorkbenchHostNodePreviewCapture = (
  input: WorkbenchHostDockPopupItemInput
) => Promise<string | null> | string | null;

export type WorkbenchDockPreviewContent =
  | {
      element: ReactNode;
      kind: "component";
      revision?: string | null;
    }
  | {
      kind: "image";
      revision?: string | null;
      src: string;
    };

export type WorkbenchHostDockPopupPreviewProvider = (
  input: WorkbenchHostDockPopupItemInput
) => WorkbenchDockPreviewContent | null;

export interface WorkbenchHostDockPopupItemDescriptor {
  /**
   * @deprecated Use preview with kind: "image".
   */
  previewImageUrl?: string | null;
  preview?: WorkbenchDockPreviewContent | null;
  revision?: string | null;
  subtitle?: string | null;
  title?: string | null;
}

export type WorkbenchHostDockPopupCardLabelMode = "hidden" | "hover-overlay";

export interface WorkbenchHostDockEntry {
  anchorKey?: string;
  attentionToken?: number | string | null;
  badge?: WorkbenchHostDockEntryBadge;
  capturePopupItemPreview?: WorkbenchHostNodePreviewCapture;
  clickActionId?: string;
  hoverActions?: readonly WorkbenchHostDockEntryAction[];
  icon: ReactNode;
  iconSize?: "default" | "large";
  id: string;
  label: string;
  instanceMode?: WorkbenchHostNodeInstanceStrategy["mode"];
  launchBehavior?: WorkbenchHostDockEntryLaunchBehavior;
  launchPayload?: unknown;
  matchNode?: (node: WorkbenchNode<WorkbenchHostNodeData>) => boolean;
  order?: number;
  popupCardLabelMode?: WorkbenchHostDockPopupCardLabelMode;
  providePopupItemPreview?: WorkbenchHostDockPopupPreviewProvider;
  resolvePopupItem?: (
    input: WorkbenchHostDockPopupItemInput
  ) => WorkbenchHostDockPopupItemDescriptor;
  separatorAfter?: boolean;
  sectionId?: string;
  state?: WorkbenchHostDockEntryState;
  typeId: string;
  visibility?: WorkbenchHostDockEntryVisibility;
}

export type WorkbenchHostDockEntryDynamicState = Partial<
  Pick<
    WorkbenchHostDockEntry,
    | "attentionToken"
    | "badge"
    | "hoverActions"
    | "launchBehavior"
    | "order"
    | "state"
    | "visibility"
  >
>;

export interface WorkbenchHostDockEntryStateSource {
  getEntryState(
    entryId: string
  ): WorkbenchHostDockEntryDynamicState | null | undefined;
  subscribe(listener: () => void): () => void;
}

export interface WorkbenchHostNodeWindowCapabilities {
  closable?: boolean;
  defaultOpen?: boolean;
  fullscreenHeaderMode?: "persistent" | "reveal";
  fullscreenable?: boolean;
  keepMountedWhenMinimized?:
    | boolean
    | ((node: WorkbenchNode<WorkbenchHostNodeData>) => boolean);
  minimizable?: boolean;
  minimizedDock?: WorkbenchHostNodeMinimizedDockCapability;
  persists?: boolean;
  restoreOnLoad?: boolean;
}

export interface WorkbenchHostNodeMinimizedDockCapability {
  capturePreview?: WorkbenchHostNodePreviewCapture;
  kind: "snapshot";
}

export interface WorkbenchHostSingleInstanceStrategy {
  mode?: "single";
}

export interface WorkbenchHostMultiInstanceStrategy {
  mode: "multi";
}

export type WorkbenchHostNodeInstanceStrategy =
  | WorkbenchHostSingleInstanceStrategy
  | WorkbenchHostMultiInstanceStrategy;

export interface WorkbenchHostNodeBodyContext<
  TExternalNodeState = unknown,
  TExternalWorkspaceState = unknown
> {
  activation: WorkbenchHostActivation | null;
  displayMode: WorkbenchNode<WorkbenchHostNodeData>["displayMode"];
  externalNodeState: TExternalNodeState;
  externalWorkspaceState: TExternalWorkspaceState;
  focus(): void;
  host: WorkbenchHostHandle;
  instanceId: string;
  instanceKey?: string | null;
  isFocused: boolean;
  node: WorkbenchNode<WorkbenchHostNodeData>;
  setNodeRuntimeState(state: unknown): void;
  setSnapshotNodeState(state: unknown): void;
}

export interface WorkbenchHostWindowCloseEffectContext<
  TExternalNodeState = unknown,
  TExternalWorkspaceState = unknown
> {
  externalNodeState: TExternalNodeState;
  externalWorkspaceState: TExternalWorkspaceState;
  instanceId: string;
  instanceKey?: string | null;
  node: WorkbenchNode<WorkbenchHostNodeData>;
  workspaceId: string;
}

export interface WorkbenchHostNodeLeaseHandle {
  release(): void;
}

export interface WorkbenchHostNodeLeaseContext {
  node: WorkbenchNode<WorkbenchHostNodeData>;
  workspaceId: string;
}

export interface WorkbenchHostNodeHeaderWindowActions {
  applyQuickLayout(target: WorkbenchQuickLayoutTarget): void;
  close(): void;
  focus(): void;
  minimize(): void;
  resize(frame: WorkbenchFrame): void;
  toggleDisplayMode(): void;
}

export interface WorkbenchHostNodeHeaderContext<
  TExternalNodeState = unknown,
  TExternalWorkspaceState = unknown
> {
  activation: WorkbenchHostActivation | null;
  defaultActions: ReactNode;
  displayMode: WorkbenchNode<WorkbenchHostNodeData>["displayMode"];
  dragHandleProps: WorkbenchWindowHeaderDragHandleProps;
  externalNodeState: TExternalNodeState;
  externalWorkspaceState: TExternalWorkspaceState;
  instanceId: string;
  instanceKey?: string | null;
  isFocused: boolean;
  node: WorkbenchNode<WorkbenchHostNodeData>;
  surfaceSize: WorkbenchSize;
  windowActions: WorkbenchHostNodeHeaderWindowActions;
}

export type WorkbenchHostMissionControlMode = WorkbenchMissionControlMode;

type WorkbenchHostBodyRenderer<
  TExternalNodeState = unknown,
  TExternalWorkspaceState = unknown
> = {
  bivarianceHack(
    context: WorkbenchHostNodeBodyContext<
      TExternalNodeState,
      TExternalWorkspaceState
    >
  ): ReactNode;
}["bivarianceHack"];

type WorkbenchHostHeaderRenderer<
  TExternalNodeState = unknown,
  TExternalWorkspaceState = unknown
> = {
  bivarianceHack(
    context: WorkbenchHostNodeHeaderContext<
      TExternalNodeState,
      TExternalWorkspaceState
    >
  ): ReactNode;
}["bivarianceHack"];

type WorkbenchHostWindowCloseEffectResolver<
  TExternalNodeState = unknown,
  TExternalWorkspaceState = unknown
> = {
  bivarianceHack(
    context: WorkbenchHostWindowCloseEffectContext<
      TExternalNodeState,
      TExternalWorkspaceState
    >
  ):
    | Promise<WorkbenchHostCloseEffect | null | void>
    | WorkbenchHostCloseEffect
    | null
    | void;
}["bivarianceHack"];

export interface WorkbenchHostNodeDefinition<
  TExternalNodeState = unknown,
  TExternalWorkspaceState = unknown
> {
  createLease?: (
    context: WorkbenchHostNodeLeaseContext
  ) => WorkbenchHostNodeLeaseHandle | null | void;
  description?: string;
  frame: WorkbenchFrame;
  getWindowCloseEffect?: WorkbenchHostWindowCloseEffectResolver<
    TExternalNodeState,
    TExternalWorkspaceState
  >;
  instance?: WorkbenchHostNodeInstanceStrategy;
  renderBody: WorkbenchHostBodyRenderer<
    TExternalNodeState,
    TExternalWorkspaceState
  >;
  renderHeader?: WorkbenchHostHeaderRenderer<
    TExternalNodeState,
    TExternalWorkspaceState
  >;
  sizeConstraints?: WorkbenchNodeSizeConstraints | null;
  title: string;
  typeId: string;
  window?: WorkbenchHostNodeWindowCapabilities;
}

export interface WorkbenchHostSnapshotRepository {
  hasLoaded?(workspaceId: string): boolean;
  load(workspaceId: string): Promise<WorkbenchSnapshot | null>;
  readCached?(workspaceId: string): WorkbenchSnapshot | null;
  save(
    workspaceId: string,
    snapshot: WorkbenchSnapshot
  ): Promise<WorkbenchSnapshot> | WorkbenchSnapshot;
}

export type WorkbenchHostActivationTarget =
  | { nodeId: string }
  | { instanceId?: string; typeId: string };

export interface WorkbenchHostHandle {
  activateNode(
    target: WorkbenchHostActivationTarget,
    activation: {
      payload?: unknown;
      type: string;
    }
  ): void;
  clearNodeActivation?(nodeId: string, sequence: number): void;
  closeNode(nodeId: string): void;
  collectWindowCloseEffects(): Promise<readonly WorkbenchHostCloseEffect[]>;
  dispose(): void;
  exitFullscreenNode(nodeId: string): void;
  focusNode(nodeId: string): void;
  getSnapshot(): WorkbenchState<WorkbenchHostNodeData>;
  isHydrating?(): boolean;
  launchNode(input: WorkbenchHostLaunchInput): Promise<string | null>;
  load(): Promise<void>;
  requestNodeClose(nodeId: string): void;
  reconcileProjectedNodes(
    projectedNodes: readonly WorkbenchHostProjectedNode[]
  ): void;
  setNodeRuntimeState(nodeId: string, state: unknown): void;
  setNodeSizeConstraints(
    nodeId: string,
    sizeConstraints: WorkbenchNodeSizeConstraints | null
  ): void;
  setSnapshotNodeState(nodeId: string, state: unknown): void;
  setNodeTitle(nodeId: string, title: string): void;
}

export interface WorkbenchHostRuntimeHandle extends WorkbenchHostHandle {
  readonly controller: WorkbenchController<WorkbenchHostNodeData>;
}

export interface WorkbenchHostChromeRenderContext {
  controller: WorkbenchController<WorkbenchHostNodeData>;
  activateNode: WorkbenchHostHandle["activateNode"];
  focusNode: WorkbenchHostHandle["focusNode"];
  launchNode: WorkbenchHostHandle["launchNode"];
}

export interface WorkbenchHostMissionControlProps {
  mode: WorkbenchMissionControlMode | null;
  onRequestClose: () => void;
}

export interface WorkbenchHostClosePreparationContext {
  host: WorkbenchHostHandle;
  workspaceId: string;
}

export type WorkbenchHostClosePreparer = (
  context: WorkbenchHostClosePreparationContext
) => Promise<boolean> | boolean;

export interface WorkbenchContribution {
  dockEntries?: readonly WorkbenchHostDockEntry[];
  externalStateSource?: WorkbenchHostExternalStateSource;
  id: string;
  nodes?: readonly WorkbenchHostNodeDefinition[];
  onLaunchRequest?: (
    request: WorkbenchHostLaunchRequest
  ) =>
    | Promise<WorkbenchHostLaunchResult | null | void>
    | WorkbenchHostLaunchResult
    | null
    | void;
  onNodeCloseRequest?: (
    request: WorkbenchHostNodeCloseRequest
  ) =>
    | Promise<WorkbenchHostNodeCloseDecision | void>
    | WorkbenchHostNodeCloseDecision
    | void;
  prepareHostClose?: WorkbenchHostClosePreparer;
}

export interface WorkbenchHostProps {
  captureNodePreviewImage?: (
    node: WorkbenchNode<WorkbenchHostNodeData>
  ) => Promise<string | null> | string | null;
  className?: string;
  contributions?: readonly WorkbenchContribution[];
  debugDiagnostics?: WorkbenchDebugDiagnostics;
  dockPreviewCache?: WorkbenchDockPreviewCache;
  dockPlacement?: WorkbenchDockPlacement;
  dockEntries?: readonly WorkbenchHostDockEntry[];
  dockStateSource?: WorkbenchHostDockEntryStateSource;
  externalStateSource?: WorkbenchHostExternalStateSource;
  i18n?: I18nRuntime<string>;
  layoutConstraints?: WorkbenchLayoutConstraintsInput;
  missionControl?: WorkbenchHostMissionControlProps;
  nodes?: readonly WorkbenchHostNodeDefinition[];
  onDockEntryAction?: (input: {
    actionId: string;
    entryId: string;
    host: WorkbenchHostHandle;
  }) => Promise<void> | void;
  onDockEntryClick?: (input: {
    entryId: string;
    host: WorkbenchHostHandle;
    nodeId?: string;
  }) => Promise<void> | void;
  onLaunchRequest?: (
    request: WorkbenchHostLaunchRequest
  ) =>
    | Promise<WorkbenchHostLaunchResult | null | void>
    | WorkbenchHostLaunchResult
    | null
    | void;
  onMissionControlAdapterReady?: (
    adapter: WorkbenchMissionControlAdapter<WorkbenchHostNodeData> | null
  ) => void;
  onNodeCloseRequest?: (
    request: WorkbenchHostNodeCloseRequest
  ) =>
    | Promise<WorkbenchHostNodeCloseDecision | void>
    | WorkbenchHostNodeCloseDecision
    | void;
  onHandleReady?: (handle: WorkbenchHostHandle | null) => void;
  projectedNodes?: readonly WorkbenchHostProjectedNode[];
  renderBottomChrome?: (context: WorkbenchHostChromeRenderContext) => ReactNode;
  renderTopChrome?: (context: WorkbenchHostChromeRenderContext) => ReactNode;
  snapshotRepository: WorkbenchHostSnapshotRepository;
  shortcutsEnabled?: boolean;
  wallpaper?: WorkbenchSurfaceWallpaper;
  workspaceId: string;
}
