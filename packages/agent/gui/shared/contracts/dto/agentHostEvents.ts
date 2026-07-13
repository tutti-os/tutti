import type { AgentHostAccountSnapshot } from "./agentHostAccount";
import type { AgentHostRoomTreeResult } from "./agentHostFiles";
import type { AgentHostManagedAgentsState } from "./agentHostProviderProbe";
import type { AgentHostRuntimeStatusResult } from "./agentHostRuntimePersistence";
import type { AgentHostTerminalSession } from "./agentHostTerminal";
import type {
  AgentHostRoomSnapshot,
  AgentHostRoomSummary,
  AgentHostRoomUserSnapshot,
  AgentHostSandboxClosingPayload,
  AgentHostTemplateCatalogProjection,
  AgentHostWorkspaceHistoryProjectionItem
} from "./agentHostWorkspace";

export interface AgentHostRoomSnapshotEvent extends AgentHostEventBase {
  scope: "room";
  type: "room-snapshot";
  roomId: string;
  snapshot: AgentHostRoomSnapshot;
}

export interface AgentHostRoomTreeUpdateEvent extends AgentHostEventBase {
  scope: "room";
  type: "room-tree-update";
  roomId: string;
  tree: AgentHostRoomTreeResult;
}

export interface AgentHostRoomTerminalUpdateEvent extends AgentHostEventBase {
  scope: "room";
  type: "room-terminal-update";
  roomId: string;
  terminals: AgentHostTerminalSession[];
}

export interface AgentHostRuntimeStatusEvent extends AgentHostEventBase {
  scope: "global";
  type: "runtime-status";
  runtimeStatus: AgentHostRuntimeStatusResult;
}

export interface AgentHostDirectoryUpdateEvent extends AgentHostEventBase {
  scope: "global";
  type: "directory-update";
  directory: AgentHostRoomSummary[];
  replace?: boolean;
  room?: AgentHostRoomSummary | null;
  deletedRoomId?: string | null;
  lastUsedUnix?: number;
}

export interface AgentHostRoomUserSnapshotUpdateEvent extends AgentHostEventBase {
  scope: "global";
  type: "room-user-snapshot-updated";
  roomId: string;
  userSnapshot: AgentHostRoomUserSnapshot;
}

export interface AgentHostTemplateCatalogEvent extends AgentHostEventBase {
  scope: "global";
  type: "template-catalog";
  templateCatalog: AgentHostTemplateCatalogProjection;
}

export interface AgentHostWorkspaceHistoryEvent extends AgentHostEventBase {
  scope: "global";
  type: "workspace-history";
  workspaceHistory: AgentHostWorkspaceHistoryProjectionItem[];
}

export interface AgentHostManagedAgentsStateEvent extends AgentHostEventBase {
  scope: "global";
  type: "managed-agents-state";
  managedAgentsState: AgentHostManagedAgentsState;
}

export type AgentHostManagedAgentActionProgressStage =
  | "cache_hit"
  | "download_start"
  | "downloading"
  | "retrying"
  | "validating"
  | "succeeded"
  | "failed";

export interface AgentHostManagedAgentActionProgress {
  agentId: string;
  packageName: string;
  stage: AgentHostManagedAgentActionProgressStage;
  attempt?: number;
  maxAttempts?: number;
  bytesDownloaded?: number;
  totalBytes?: number;
  resumable: boolean;
  errorCode?: string;
  message?: string;
}

export interface AgentHostManagedAgentActionProgressEvent extends AgentHostEventBase {
  scope: "global";
  type: "managed-agent-action-progress";
  progress: AgentHostManagedAgentActionProgress;
}

export interface AgentHostAgentModelCatalogInvalidatedEvent extends AgentHostEventBase {
  scope: "global";
  type: "agent-model-catalog-invalidated";
  providers: import("./agent").AgentProviderId[];
  occurredAtUnixMs: number;
}

export type AgentHostEventScope = "global" | "room" | "window";

interface AgentHostEventBase {
  scope: AgentHostEventScope;
  roomId?: string | null;
  room?: AgentHostRoomSummary | null;
  inviteCode?: string | null;
  issueId?: string | null;
  pendingIssueNavigationRequested?: boolean | null;
  sessionId?: string | null;
  sandboxClosing?: AgentHostSandboxClosingPayload;
  sourceNodeId?: string | null;
  progress?: unknown;
  roomWindowBindingStatus?: "pending" | "entered";
}

export interface AgentHostRoomCreatedEvent extends AgentHostEventBase {
  scope: "global";
  type: "room-created";
  roomId: string;
  room?: AgentHostRoomSummary | null;
}

export interface AgentHostRoomUpdatedEvent extends AgentHostEventBase {
  scope: "global";
  type: "room-updated";
  roomId: string;
  room: AgentHostRoomSummary;
}

export interface AgentHostRoomLeftEvent extends AgentHostEventBase {
  scope: "global";
  type: "room-left";
  roomId: string | null;
}

export interface AgentHostRuntimeResetEvent extends AgentHostEventBase {
  scope: "global";
  type: "runtime-reset";
  roomId?: string | null;
}

export interface AgentHostOpenShareModalEvent extends AgentHostEventBase {
  scope: "global";
  type: "open-share-modal";
}

export interface AgentHostAccountSnapshotChangedEvent extends AgentHostEventBase {
  scope: "global";
  type: "account-snapshot-changed";
  snapshot: AgentHostAccountSnapshot;
}

export interface AgentHostDiagnosticsExportEvent extends AgentHostEventBase {
  scope: "global";
  type: "diagnostics-export";
  phase: "running" | "completed" | "failed";
}

export interface AgentHostSandboxClosingEvent extends AgentHostEventBase {
  scope: "room";
  type: "sandbox-closing";
  roomId: string;
  sandboxClosing: AgentHostSandboxClosingPayload;
}

export interface AgentHostTerminalLifecycleEvent extends AgentHostEventBase {
  scope: "room";
  type: "terminal-created" | "terminal-closed" | "terminal-exited";
  roomId: string;
  sessionId?: string | null;
}

export interface AgentHostRoomEnterProgressEvent extends AgentHostEventBase {
  scope: "room";
  type: "room-enter-progress";
  roomId: string;
  progress: import("./workspaceEnterProgress").WorkspaceEnterProgressEvent;
}

export interface AgentHostRoomEnteredEvent extends AgentHostEventBase {
  scope: "room";
  type: "room-entered";
  roomId: string;
  room: AgentHostRoomSummary;
}

export interface AgentHostOpenAgentSessionEvent extends AgentHostEventBase {
  scope: "room";
  type: "open-agent-session";
  roomId: string;
  sessionId: string;
  sourceNodeId: string;
}

export interface AgentHostRoomWindowBoundEvent extends AgentHostEventBase {
  scope: "window";
  type: "room-window-bound";
  roomId: string;
  pendingIssueId?: string | null;
  pendingIssueNavigationRequested?: boolean;
  roomWindowBindingStatus?: "pending" | "entered";
  pendingRoomWindowRequestId?: string | null;
  waitForFinalBootstrap?: boolean;
}

export interface AgentHostRoomEnterRequestedEvent extends AgentHostEventBase {
  scope: "window";
  type: "room-enter-requested";
  roomId: string;
  pendingIssueId?: string | null;
  pendingRoomWindowRequestId?: string | null;
  waitForFinalBootstrap?: boolean;
}

export interface AgentHostRoomShareLinkOpenedEvent extends AgentHostEventBase {
  scope: "window";
  type: "room-share-link-opened";
  roomId: string;
  inviteCode?: string | null;
  issueId?: string | null;
}

export type AgentHostEvent =
  | AgentHostRoomCreatedEvent
  | AgentHostRoomUpdatedEvent
  | AgentHostRoomEnteredEvent
  | AgentHostRoomLeftEvent
  | AgentHostRuntimeResetEvent
  | AgentHostSandboxClosingEvent
  | AgentHostTerminalLifecycleEvent
  | AgentHostOpenShareModalEvent
  | AgentHostAccountSnapshotChangedEvent
  | AgentHostDiagnosticsExportEvent
  | AgentHostRoomShareLinkOpenedEvent
  | AgentHostRoomEnterProgressEvent
  | AgentHostRoomWindowBoundEvent
  | AgentHostRoomEnterRequestedEvent
  | AgentHostOpenAgentSessionEvent
  | AgentHostRoomSnapshotEvent
  | AgentHostRoomTreeUpdateEvent
  | AgentHostRoomTerminalUpdateEvent
  | AgentHostRuntimeStatusEvent
  | AgentHostDirectoryUpdateEvent
  | AgentHostRoomUserSnapshotUpdateEvent
  | AgentHostTemplateCatalogEvent
  | AgentHostWorkspaceHistoryEvent
  | AgentHostManagedAgentsStateEvent
  | AgentHostManagedAgentActionProgressEvent
  | AgentHostAgentModelCatalogInvalidatedEvent;
