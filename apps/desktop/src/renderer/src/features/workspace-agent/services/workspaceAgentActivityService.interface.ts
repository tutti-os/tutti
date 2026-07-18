import { createDecorator } from "@tutti-os/infra/di";
import type {
  AgentActivityRuntime,
  AgentActivityRuntimeUpdateSessionSettingsResult
} from "@tutti-os/agent-gui";
import type {
  AgentActivityCancelTurnInput,
  AgentActivityGoalControlInput,
  AgentActivityGoalControlResult,
  AgentActivityCreateSessionInput,
  AgentActivityDeleteSessionInput,
  AgentActivityDeleteSessionResult,
  AgentActivityMessageOrder,
  AgentActivityMessagePage,
  AgentActivityRenameSessionInput,
  AgentActivitySendInput,
  AgentActivitySendInputResult,
  AgentActivitySession,
  AgentActivitySnapshot,
  AgentActivitySnapshotListener,
  AgentSessionEngine,
  AgentActivitySubmitInteractiveInput,
  AgentActivitySubmitInteractiveResult
} from "@tutti-os/agent-activity-core";
import type { AgentHostAgentSessionComposerSettings } from "@shared/contracts/dto";
import type {
  ExternalAgentImportResultResponse,
  ExternalAgentImportScanRequest,
  ExternalAgentImportScanResponse,
  ImportExternalAgentSessionsRequest,
  WorkspaceAgentPlanDecisionResponse,
  WorkspaceAgentGeneratedFileListResponse
} from "@tutti-os/client-tuttid-ts";

export interface WorkspaceAgentActivityListMessagesInput {
  afterVersion?: number;
  beforeVersion?: number;
  cache?: boolean;
  agentSessionId: string;
  limit?: number;
  order?: AgentActivityMessageOrder;
  signal?: AbortSignal;
  workspaceId: string;
}

export interface WorkspaceAgentActivityListGeneratedFilesInput {
  agentTargetIds?: readonly string[];
  cursor?: string;
  limit?: number;
  query?: string;
  sectionKey: string;
  signal?: AbortSignal;
  workspaceId: string;
}

export interface WorkspaceAgentActivityListSessionsPageInput {
  agentTargetId?: string | null;
  cursor?: string;
  limit?: number;
  searchQuery?: string;
  signal?: AbortSignal;
  workspaceId: string;
}

export interface WorkspaceAgentActivitySessionPageResult {
  hasMore: boolean;
  nextCursor?: string;
  sessions: AgentActivitySession[];
  workspaceId: string;
}

export type WorkspaceAgentActivityListSessionSectionsInput = Parameters<
  NonNullable<AgentActivityRuntime["listSessionSections"]>
>[0];

export type WorkspaceAgentActivitySessionSectionsResult = Awaited<
  ReturnType<NonNullable<AgentActivityRuntime["listSessionSections"]>>
>;

export type WorkspaceAgentActivityListSessionSectionPageInput = Parameters<
  NonNullable<AgentActivityRuntime["listSessionSectionPage"]>
>[0];

export type WorkspaceAgentActivitySessionSectionResult = Awaited<
  ReturnType<NonNullable<AgentActivityRuntime["listSessionSectionPage"]>>
>;

export type WorkspaceAgentActivitySessionSectionScopeInput = Parameters<
  NonNullable<AgentActivityRuntime["listSessionSectionDeletionCandidates"]>
>[0];

export type WorkspaceAgentActivitySessionSectionDeletionCandidates = Awaited<
  ReturnType<
    NonNullable<AgentActivityRuntime["listSessionSectionDeletionCandidates"]>
  >
>;

export type WorkspaceAgentActivityDeleteSessionsBatchInput = Parameters<
  NonNullable<AgentActivityRuntime["deleteSessionsBatch"]>
>[0];

export type WorkspaceAgentActivityDeleteSessionsBatchResult = Awaited<
  ReturnType<NonNullable<AgentActivityRuntime["deleteSessionsBatch"]>>
>;

export type WorkspaceAgentActivityListPinnedSessionsPageInput = Parameters<
  NonNullable<AgentActivityRuntime["listPinnedSessionsPage"]>
>[0];

export type WorkspaceAgentActivityPinnedSessionsPageResult = Awaited<
  ReturnType<NonNullable<AgentActivityRuntime["listPinnedSessionsPage"]>>
>;

export interface WorkspaceAgentActivityEnsureSessionSynchronizedInput {
  afterVersion?: number;
  agentSessionId: string;
  onError?: (error: unknown) => void;
  workspaceId: string;
}

export interface WorkspaceAgentActivityAttachment {
  attachmentId: string;
  mimeType: string;
  name?: string;
  data: string;
}

export interface WorkspaceAgentModelCatalogInvalidatedEvent {
  providers: string[];
  occurredAtUnixMs: number;
}

export interface WorkspaceAgentComposerDefaultsInvalidatedEvent {
  agentTargetId: string;
}

export interface IWorkspaceAgentActivityService {
  readonly _serviceBrand: undefined;

  activateSession: AgentActivityRuntime["activateSession"];
  cancelTurn?(
    input: AgentActivityCancelTurnInput
  ): Promise<
    import("@tutti-os/agent-activity-core").AgentActivityTurnCancelResponse
  >;
  goalControl(
    input: AgentActivityGoalControlInput
  ): Promise<AgentActivityGoalControlResult>;
  createSession(
    input: AgentActivityCreateSessionInput
  ): Promise<AgentActivitySession>;
  deleteSession(
    input: AgentActivityDeleteSessionInput
  ): Promise<AgentActivityDeleteSessionResult>;
  getSession(
    workspaceId: string,
    agentSessionId: string
  ): Promise<AgentActivitySession>;
  getComposerOptions(input: {
    agentTargetId: string;
    cwd?: string | null;
    force?: boolean;
    provider?: string;
    signal?: AbortSignal;
    settings?: AgentHostAgentSessionComposerSettings | null;
    workspaceId: string;
  }): Promise<unknown>;
  updateSessionSettings(input: {
    agentSessionId: string;
    settings: AgentHostAgentSessionComposerSettings;
    workspaceId: string;
  }): Promise<AgentActivityRuntimeUpdateSessionSettingsResult>;
  getSnapshot(workspaceId: string): AgentActivitySnapshot;
  getSessionEngine(workspaceId: string): AgentSessionEngine;
  listSessionMessages(
    input: WorkspaceAgentActivityListMessagesInput
  ): Promise<AgentActivityMessagePage>;
  listAgentGeneratedFiles(
    input: WorkspaceAgentActivityListGeneratedFilesInput
  ): Promise<WorkspaceAgentGeneratedFileListResponse>;
  listSessionsPage(
    input: WorkspaceAgentActivityListSessionsPageInput
  ): Promise<WorkspaceAgentActivitySessionPageResult>;
  listSessionSections(
    input: WorkspaceAgentActivityListSessionSectionsInput
  ): Promise<WorkspaceAgentActivitySessionSectionsResult>;
  listSessionSectionPage(
    input: WorkspaceAgentActivityListSessionSectionPageInput
  ): Promise<WorkspaceAgentActivitySessionSectionResult>;
  listSessionSectionDeletionCandidates(
    input: WorkspaceAgentActivitySessionSectionScopeInput
  ): Promise<WorkspaceAgentActivitySessionSectionDeletionCandidates>;
  deleteSessionsBatch(
    input: WorkspaceAgentActivityDeleteSessionsBatchInput
  ): Promise<WorkspaceAgentActivityDeleteSessionsBatchResult>;
  listPinnedSessionsPage(
    input: WorkspaceAgentActivityListPinnedSessionsPageInput
  ): Promise<WorkspaceAgentActivityPinnedSessionsPageResult>;
  scanExternalSessionImports(
    workspaceId: string,
    request?: ExternalAgentImportScanRequest
  ): Promise<ExternalAgentImportScanResponse>;
  importExternalSessions(
    workspaceId: string,
    request: ImportExternalAgentSessionsRequest
  ): Promise<ExternalAgentImportResultResponse>;
  selectExternalSessionImportArchive(): Promise<string | null>;
  load(
    workspaceId: string,
    signal?: AbortSignal
  ): Promise<AgentActivitySnapshot>;
  onSessionEvent(
    workspaceId: string,
    listener: (event: unknown) => void
  ): () => void;
  onModelCatalogInvalidated(
    listener: (event: WorkspaceAgentModelCatalogInvalidatedEvent) => void
  ): () => void;
  onComposerDefaultsInvalidated(
    listener: (event: WorkspaceAgentComposerDefaultsInvalidatedEvent) => void
  ): () => void;
  submitInteractive(
    input: AgentActivitySubmitInteractiveInput
  ): Promise<AgentActivitySubmitInteractiveResult>;
  submitPlanDecision(input: {
    workspaceId: string;
    agentSessionId: string;
    turnId: string;
    promptKind: "plan-implementation";
    requestId: string;
    action: "implement";
    idempotencyKey: string;
  }): Promise<WorkspaceAgentPlanDecisionResponse>;
  ensureSessionSynchronized(
    input: WorkspaceAgentActivityEnsureSessionSynchronizedInput
  ): () => void;
  sendInput(
    input: AgentActivitySendInput
  ): Promise<AgentActivitySendInputResult>;
  readSessionAttachment(input: {
    agentSessionId: string;
    attachmentId: string;
    workspaceId: string;
  }): Promise<WorkspaceAgentActivityAttachment>;
  renameSession(
    input: AgentActivityRenameSessionInput
  ): Promise<AgentActivitySession>;
  setSessionPinned(input: {
    agentSessionId: string;
    pinned: boolean;
    workspaceId: string;
  }): Promise<AgentActivitySession>;
  subscribe(
    workspaceId: string,
    listener: AgentActivitySnapshotListener
  ): () => void;
  unactivateSession: AgentActivityRuntime["unactivateSession"];
}

export const IWorkspaceAgentActivityService =
  createDecorator<IWorkspaceAgentActivityService>(
    "workspace-agent-activity-service"
  );
