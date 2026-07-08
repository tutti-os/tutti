import type { AgentRuntimeStatus } from "./contexts/agent/domain/types";
import type {
  AgentSettings,
  AgentProvider
} from "./contexts/settings/domain/agentSettings";
import type { NodeLabelColorOverride } from "./shared/types/labelColor";
import type {
  AgentHostTemplateBootstrapAction,
  AgentHostAgentSessionComposerSettings,
  TerminalRuntimeKind,
  WebsiteWindowSessionMode
} from "./shared/contracts/dto";

export type { AgentRuntimeStatus } from "./contexts/agent/domain/types";

export type WorkspaceNodeKind =
  | "terminal"
  | "agent"
  | "agentGui"
  | "workspaceFile"
  | "roomIssue"
  | "roomApplications"
  | "roomApplication"
  | "website";

export type AgentLaunchMode = "new" | "resume";

export type ExecutionDirectoryMode = "workspace" | "custom";

export interface AgentNodeData {
  provider: AgentProvider;
  prompt: string;
  model: string | null;
  effectiveModel: string | null;
  launchMode: AgentLaunchMode;
  resumeSessionId: string | null;
  resumeSessionIdVerified?: boolean;
  executionDirectory: string;
  expectedDirectory: string | null;
  directoryMode: ExecutionDirectoryMode;
  customDirectory: string | null;
  shouldCreateDirectory: boolean;
}

export interface AgentGUINodeData {
  provider: AgentGUIProvider;
  agentTargetId?: string | null;
  /** @deprecated Use agentTargetId for selection restore. */
  providerTargetId?: string | null;
  /** @deprecated Provider target refs are resolved from the current target list. */
  providerTargetRef?: AgentGUIProviderTargetRef | null;
  lastActiveAgentSessionId: string | null;
  lastActiveConversationTitle?: string | null;
  conversationCount?: number | null;
  conversationRailWidthPx?: number | null;
  conversationRailCollapsed?: boolean | null;
  composerOverrides?: AgentHostAgentSessionComposerSettings | null;
  composerOverridesByAgentTargetId?: Record<
    string,
    AgentHostAgentSessionComposerSettings | null
  > | null;
  composerOverridesByProvider?: Partial<
    Record<AgentGUIProvider, AgentHostAgentSessionComposerSettings | null>
  > | null;
}

export type AgentGUIProvider = Extract<
  AgentProvider,
  | "claude-code"
  | "codex"
  | "tutti-agent"
  | "cursor"
  | "nexight"
  | "gemini"
  | "hermes"
  | "openclaw"
  | "opencode"
>;

export interface AgentGUIProviderTargetRef {
  kind: string;
  provider: AgentGUIProvider;
  [key: string]: unknown;
}

export interface AgentGUIProviderTargetBadge {
  iconUrl: string;
  label?: string;
}

export interface AgentGUIProviderTarget {
  targetId: string;
  agentTargetId?: string | null;
  provider: AgentGUIProvider;
  ref: AgentGUIProviderTargetRef;
  label: string;
  description?: string;
  iconUrl?: string | null;
  badge?: AgentGUIProviderTargetBadge | null;
  ownerLabel?: string;
  disabled?: boolean;
  unavailableReason?: string;
}

/**
 * How the provider rail composes the target list.
 * - "catalog" (default): host-provided targets are augmented with the static
 *   local provider catalog, disabled placeholders (nexight/hermes/openclaw),
 *   and coming-soon markers. When no targets are provided, the full local
 *   catalog is shown.
 * - "exact": the rail renders exactly the provided targets — no static catalog
 *   fallback, no disabled placeholders, no coming-soon injection. When the list
 *   is empty (and not loading) the host-provided empty renderer is shown. Use
 *   this when the list is fully orchestrated externally (e.g. shared agents,
 *   custom /agents).
 */
export type AgentGUIProviderRailMode = "catalog" | "exact";

export type AgentGUIProviderReadinessGateStatus =
  | "checking"
  | "coming_soon"
  | "not_installed"
  | "auth_required"
  | "unavailable";

export type AgentGUIProviderReadinessGateAction =
  | "install"
  | "login"
  | "refresh";

export interface AgentGUIProviderReadinessGate {
  status: AgentGUIProviderReadinessGateStatus;
  pendingAction?: AgentGUIProviderReadinessGateAction | null;
  onAction?: (
    provider: AgentGUIProvider,
    action: AgentGUIProviderReadinessGateAction
  ) => void;
}

export interface WebsiteNodeData {
  url: string;
  sessionMode: WebsiteWindowSessionMode;
  profileId: string | null;
  presentation?: "browser" | "template-app";
  appId?: string | null;
  templateId?: string | null;
}

export interface TemplateAppEntry {
  appId: string;
  templateId: string;
  title: string;
  iconUrl: string | null;
  heroImageUrl: string | null;
  launchUrl: string;
  windowNodeId: string | null;
  isWindowOpen: boolean;
  lastOpenedAt: string | null;
}

export interface WorkspaceFileNodeData {
  path: string;
  name: string;
  fileKind: "image" | "text";
  sizeBytes: number | null;
  mtimeMs: number | null;
}

export type RoomApplicationMockKind =
  | "design"
  | "video"
  | "editor"
  | "presentation"
  | "sheet"
  | "calendar"
  | "monitor"
  | "code"
  | "chat"
  | "image-generation";

export interface RoomApplicationsNodeData {
  lastOpenedAt?: string | null;
  installedApplicationIds?: string[];
}

export interface RoomApplicationNodeData {
  appId: string;
  title: string;
  description: string;
  category: string;
  mockKind: RoomApplicationMockKind;
}

export type RoomIssueNodeSizeMode = "compact" | "standard";

export interface RoomTaskDraft {
  taskId: string | null;
  title: string;
  content: string;
}

export interface RoomIssueDraft {
  issueId: string | null;
  title: string;
  content: string;
  status:
    | "not_started"
    | "running"
    | "pending_acceptance"
    | "completed"
    | "failed"
    | "canceled";
}

export interface RoomIssueNodeData {
  sizeMode: RoomIssueNodeSizeMode;
  taskListCollapsed?: boolean | null;
  selectedTaskId: string | null;
  selectedIssueId: string | null;
  taskStatusFilter:
    | "all"
    | "not_started"
    | "running"
    | "pending_acceptance"
    | "completed"
    | "failed"
    | "canceled";
  taskSearchQuery: string;
  taskListNextPageToken: string | null;
  issueListNextPageToken: string | null;
  selectedProvider:
    | "codex"
    | "claude-code"
    | "tutti-agent"
    | "cursor"
    | "nexight"
    | "gemini"
    | "openclaw"
    | "opencode"
    | "hermes";
  taskEditing: boolean;
  issueEditing: boolean;
  taskDraft: RoomTaskDraft;
  issueDraft: RoomIssueDraft;
}

export interface WorkspaceTemplateRuntime {
  templateId: string;
  status: "succeeded" | "failed";
  runtime: {
    port: number;
    url: string;
    workspaceAppDir?: string;
    helperScriptPath?: string;
  } | null;
  actions: AgentHostTemplateBootstrapAction[];
  error?: string;
}

export interface TerminalNodeData {
  [key: string]: unknown;
  sessionId: string;
  isLiveSessionReattach?: boolean;
  profileId?: string | null;
  runtimeKind?: TerminalRuntimeKind;
  terminalProviderHint?: AgentProvider | null;
  labelColorOverride?: NodeLabelColorOverride;
  title: string;
  titlePinnedByUser?: boolean;
  width: number;
  height: number;
  kind: WorkspaceNodeKind;
  status: AgentRuntimeStatus | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  lastError: string | null;
  scrollback: string | null;
  executionDirectory?: string | null;
  expectedDirectory?: string | null;
  agent: AgentNodeData | null;
  agentGui?: AgentGUINodeData | null;
  workspaceFile: WorkspaceFileNodeData | null;
  roomIssue?: RoomIssueNodeData | null;
  roomApplications?: RoomApplicationsNodeData | null;
  roomApplication?: RoomApplicationNodeData | null;
  website: WebsiteNodeData | null;
}

export interface WorkspaceNode<TData = TerminalNodeData> {
  id: string;
  type?: string;
  position: Point;
  width?: number;
  height?: number;
  initialWidth?: number;
  initialHeight?: number;
  measured?: Partial<Size>;
  data: TData;
  dragHandle?: string;
  zIndex?: number;
  draggable?: boolean;
  selectable?: boolean;
  selected?: boolean;
  dragging?: boolean;
  deletable?: boolean;
}

export interface WorkspaceState {
  id: string;
  name: string;
  path: string;
  environmentVariables?: Record<string, string>;
  nodes: WorkspaceNode<TerminalNodeData>[];
  /** Legacy canvas view state kept for storage compatibility; desktop rendering ignores it. */
  viewport: WorkspaceViewport;
  /** Legacy canvas view state kept for storage compatibility; desktop rendering ignores it. */
  isMinimapVisible: boolean;
  templateRuntime?: WorkspaceTemplateRuntime | null;
  templateApps?: TemplateAppEntry[];
}

export interface PersistedWorkspaceState {
  id: string;
  name: string;
  path: string;
  environmentVariables?: Record<string, string>;
  nodes: PersistedTerminalNode[];
  /** Legacy canvas view state kept for storage compatibility; desktop rendering ignores it. */
  viewport: WorkspaceViewport;
  /** Legacy canvas view state kept for storage compatibility; desktop rendering ignores it. */
  isMinimapVisible: boolean;
  templateRuntime?: WorkspaceTemplateRuntime | null;
  templateApps?: TemplateAppEntry[];
}

export interface PersistedTerminalNode {
  id: string;
  sessionId?: string | null;
  title: string;
  titlePinnedByUser?: boolean;
  position?: Point;
  width: number;
  height: number;
  isMinimized?: boolean;
  isMaximized?: boolean;
  kind: WorkspaceNodeKind;
  profileId?: string | null;
  runtimeKind?: TerminalRuntimeKind;
  terminalProviderHint?: AgentProvider | null;
  labelColorOverride?: NodeLabelColorOverride;
  status: AgentRuntimeStatus | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  lastError: string | null;
  scrollback: string | null;
  executionDirectory?: string | null;
  expectedDirectory?: string | null;
  agent: AgentNodeData | null;
  task:
    | WorkspaceFileNodeData
    | RoomIssueNodeData
    | RoomApplicationsNodeData
    | RoomApplicationNodeData
    | WebsiteNodeData
    | AgentGUINodeData
    | null;
}

export interface PersistedAppState {
  formatVersion: number;
  activeWorkspaceId: string | null;
  workspaces: PersistedWorkspaceState[];
  settings: AgentSettings;
}

export interface Size {
  width: number;
  height: number;
}

export interface WorkspaceViewport {
  x: number;
  y: number;
  zoom: number;
}

export const DEFAULT_WORKSPACE_VIEWPORT: WorkspaceViewport = {
  x: 0,
  y: 0,
  zoom: 1
};

export interface Point {
  x: number;
  y: number;
}

export interface NodeFrame {
  position: Point;
  size: Size;
}
