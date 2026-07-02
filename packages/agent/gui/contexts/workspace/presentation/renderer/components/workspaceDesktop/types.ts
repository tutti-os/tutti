import type { AgentSettings } from "../../../../../settings/domain/agentSettings";
import type {
  AgentProbeSnapshot,
  AgentHostAgentSessionPermissionMode
} from "../../../../../../shared/contracts/dto";
import type {
  TerminalNodeData,
  TemplateAppEntry,
  WorkspaceNode,
  WorkspaceNodeKind
} from "../../types";
import type {
  AgentHostManageAgentActionKind,
  AgentHostManagedAgentsState
} from "../../../../../../shared/contracts/dto";
import type { AgentProvider } from "../../../../../settings/domain/agentSettings";
import type {
  WorkspaceAgentActivitySession,
  WorkspaceAgentActivityTimelineItem
} from "../../../../../../shared/workspaceAgentActivityTypes";

export interface DesktopSize {
  width: number;
  height: number;
  bottomInset?: number;
}

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DesktopDockAnchorKey =
  | "issues"
  | "files"
  | "applications"
  | "website"
  | "terminal"
  | "debugTerminal"
  | "minimized-stack"
  | `minimized:${string}`
  | `agent:${string}`
  | `application:${string}`
  | `template:${string}`;

export type WindowSnapTarget = "top" | null;
export type WindowDisplayMode = "floating" | "fullscreen";
export type WindowQuickLayoutTarget = "left" | "right" | "top" | "bottom";

export interface WindowState {
  id: string;
  kind: WorkspaceNodeKind;
  title: string;
  rect: WindowRect;
  displayMode: WindowDisplayMode;
  restoreRect: WindowRect | null;
  isMinimized: boolean;
  minimizedAt?: number | null;
  isFocused: boolean;
  previewImageUrl?: string | null;
  data: TerminalNodeData;
}

export interface DesktopState {
  windows: WindowState[];
  windowStack: string[];
  activeDragWindowId: string | null;
  activeSnapTarget: WindowSnapTarget;
  /** When set, that window uses smooth CSS transitions for layout (maximize/restore). */
  layoutSmoothWindowId: string | null;
}

export interface OpenWindowParams {
  id: string;
  kind: WorkspaceNodeKind;
  title: string;
  data: TerminalNodeData;
  rect?: Partial<WindowRect>;
}

export interface DesktopActions {
  replaceWindows(windows: WindowState[]): void;
  openWindow(params: OpenWindowParams, desktopSize?: DesktopSize): WindowState;
  closeWindow(id: string): void;
  focusWindow(id: string): void;
  minimizeWindow(id: string): void;
  enterFullscreenWindow(id: string, desktopSize: DesktopSize): void;
  exitFullscreenWindow(id: string, desktopSize?: DesktopSize): void;
  toggleFullscreenWindow(id: string, desktopSize: DesktopSize): void;
  applyQuickLayout(
    id: string,
    target: WindowQuickLayoutTarget,
    desktopSize: DesktopSize
  ): void;
  restoreWindow(id: string): void;
  setWindowPreviewImage(id: string, previewImageUrl: string | null): void;
  beginLayoutSmoothTransition(id: string): void;
  clearLayoutSmoothTransition(): void;
  setDraggingWindow(id: string | null): void;
  setActiveSnapTarget(target: WindowSnapTarget): void;
  moveWindow(id: string, x: number, y: number): void;
  resizeWindow(id: string, rect: Partial<WindowRect>): void;
  updateWindowData(id: string, patch: Partial<TerminalNodeData>): void;
  updateWindowTitle(id: string, title: string): void;
}

export type DesktopStore = DesktopState & DesktopActions;

export type WorkspaceDesktopMessageTone = "info" | "warning" | "error";

export type WorkspaceDesktopShowMessageOptions = {
  /**
   * Auto-dismiss after N ms. Default 2400. `null` = keep until the next message or an empty `message` clears it.
   */
  durationMs?: number | null;
  /** When true, the toast shows an inline spinner (e.g. in-flight upload). */
  busy?: boolean;
};

export type ShowWorkspaceDesktopMessage = (
  message: string,
  tone?: WorkspaceDesktopMessageTone,
  options?: WorkspaceDesktopShowMessageOptions
) => void;

export interface WorkspaceShellRuntimePanelSnapshot {
  workspaceConnected: boolean;
  workspaceId?: string;
  workspaceName?: string;
  workspaceRoot?: string;
  linuxUser?: string;
  provider?: string;
  sandboxId?: string;
  terminalSessionCount: number;
  runtimeConnected: boolean;
  runtimeHealthState?: string | null;
  runtimeId?: string | null;
  runtimeState?: string | null;
  runtimeStatusMessage?: string | null;
  guestAgentRelaySocket?: string | null;
  sandboxSessionState?: "connected" | "reconnecting" | "disconnected" | null;
}

export interface WorkspaceDesktopPendingIssueAgentHandoff {
  requestId: string;
  workspaceId: string;
  provider:
    | "codex"
    | "claude-code"
    | "nexight"
    | "gemini"
    | "openclaw"
    | "hermes";
  taskId: string;
  issueId: string;
  taskTitle: string;
  issueTitle: string;
  title: string;
  prompt: string;
}

/** Workspace-scoped agent probes for currently visible Agent GUI windows. */
export interface WorkspaceDesktopAgentProbesState {
  snapshot: AgentProbeSnapshot | null;
  isLoadingAvailability: boolean;
  isLoadingUsage: boolean;
}

export type WorkspaceDesktopAgentProbeDemandChange = (
  provider: AgentProvider | null,
  sourceId?: string
) => void;

export type WorkspaceDesktopAgentProbeRefreshRequest = (
  provider: AgentProvider,
  sourceId?: string
) => void;

export interface WorkspaceDesktopProps {
  workspaceId: string;
  currentUserId?: string | null;
  workspaceMemberAvatarsByUserId?: Record<string, string>;
  workspaceMemberLabelsByUserId?: Record<string, string>;
  hideEmptyHint?: boolean;
  onShowMessage?: ShowWorkspaceDesktopMessage;
  onMaximizedNodeChange?: (hasMaximizedNode: boolean) => void;
  workspacePath: string;
  environmentVariables?: Record<string, string>;
  nodes: WorkspaceNode<TerminalNodeData>[];
  onNodesChange: (nodes: WorkspaceNode<TerminalNodeData>[]) => void;
  templateApps?: TemplateAppEntry[];
  onRequestPersistFlush?: () => void;
  shortcutsEnabled?: boolean;
  agentSettings: AgentSettings;
  workspacePermissionMode?: AgentHostAgentSessionPermissionMode;
  isFocusNodeTargetZoomPreviewing?: boolean;
  focusNodeId?: string | null;
  focusSequence?: number;
  workspaceShellRuntime?: WorkspaceShellRuntimePanelSnapshot | null;
  workspaceAgentSessions?: WorkspaceAgentActivitySession[];
  workspaceAgentSessionTimelineById?: Record<
    string,
    WorkspaceAgentActivityTimelineItem[]
  >;
  workspaceAgentProbes?: WorkspaceDesktopAgentProbesState | null;
  /** Registers which Agent GUI providers currently need workspace agent probe data. */
  onAgentProbeDemandChange?: WorkspaceDesktopAgentProbeDemandChange;
  /** Requests a fresh provider probe for an already visible Agent GUI surface. */
  onAgentProbeRefreshRequest?: WorkspaceDesktopAgentProbeRefreshRequest;
  onRefreshWorkspaceShellRuntime?: () => void | Promise<void>;
  canvasUserWallpaperUrl?: string | null;
  pendingWorkspaceIssueNavigation?: {
    workspaceId: string;
    issueId?: string | null;
  } | null;
  onConsumePendingWorkspaceIssueNavigation?: () => void;
  pendingIssueAgentHandoff?: WorkspaceDesktopPendingIssueAgentHandoff | null;
  onConsumePendingIssueAgentHandoff?: () => void;
  debugTerminalEnabled?: boolean;
  agentGuiEnabled?: boolean;
  terminalPreferLocalSSHKey?: boolean;
  managedAgentsState?: AgentHostManagedAgentsState | null;
  onAgentInstall?: (
    provider: AgentProvider,
    action: AgentHostManageAgentActionKind
  ) => void;
  pendingAgentActionId?: string | null;
  queuedAgentActionIds?: readonly string[];
  /** While true, bottom composer shows the agent "thinking" balloon (current user's running agent sessions). */
  agentSessionsWorking?: boolean;
}
