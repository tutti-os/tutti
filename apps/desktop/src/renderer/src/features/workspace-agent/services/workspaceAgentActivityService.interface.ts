import { createDecorator } from "@tutti-os/infra/di";
import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import type {
  AgentActivityCancelSessionInput,
  AgentActivityCancelSessionResult,
  AgentActivityCreateSessionInput,
  AgentActivityDeleteSessionInput,
  AgentActivityDeleteSessionResult,
  AgentActivityMessageOrder,
  AgentActivityMessagePage,
  AgentActivitySendInput,
  AgentActivitySession,
  AgentActivitySnapshot,
  AgentActivitySnapshotListener,
  AgentActivitySubmitInteractiveInput
} from "@tutti-os/agent-activity-core";
import type {
  AgentHostAgentSessionComposerSettings,
  AgentHostUpdateAgentSessionSettingsResult,
  AgentHostAgentSessionState
} from "@shared/contracts/dto";

export interface WorkspaceAgentActivityListMessagesInput {
  afterVersion?: number;
  beforeVersion?: number;
  agentSessionId: string;
  limit?: number;
  order?: AgentActivityMessageOrder;
  signal?: AbortSignal;
  workspaceId: string;
}

export interface WorkspaceAgentActivityEnsureSessionSynchronizedInput {
  afterVersion?: number;
  agentSessionId: string;
  onError?: (error: unknown) => void;
  workspaceId: string;
}

export type WorkspaceAgentActivityRetainSessionInput =
  WorkspaceAgentActivityEnsureSessionSynchronizedInput;

export interface WorkspaceAgentActivityAttachment {
  attachmentId: string;
  mimeType: string;
  name?: string;
  data: string;
}

export interface IWorkspaceAgentActivityService {
  readonly _serviceBrand: undefined;

  activateSession: AgentActivityRuntime["activateSession"];
  cancelSession(
    input: AgentActivityCancelSessionInput
  ): Promise<AgentActivityCancelSessionResult>;
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
    cwd?: string | null;
    force?: boolean;
    provider?: string;
    settings?: AgentHostAgentSessionComposerSettings | null;
    workspaceId: string;
  }): Promise<unknown>;
  updateSessionSettings(input: {
    agentSessionId: string;
    settings: AgentHostAgentSessionComposerSettings;
    workspaceId: string;
  }): Promise<AgentHostUpdateAgentSessionSettingsResult>;
  getSessionControlState(input: {
    agentSessionId: string;
    workspaceId: string;
  }): Promise<AgentHostAgentSessionState>;
  getSnapshot(workspaceId: string): AgentActivitySnapshot;
  listSessionMessages(
    input: WorkspaceAgentActivityListMessagesInput
  ): Promise<AgentActivityMessagePage>;
  load(
    workspaceId: string,
    signal?: AbortSignal
  ): Promise<AgentActivitySnapshot>;
  onSessionEvent(
    workspaceId: string,
    listener: (event: unknown) => void
  ): () => void;
  submitInteractive(
    input: AgentActivitySubmitInteractiveInput
  ): Promise<unknown>;
  submitPlanDecision(input: {
    workspaceId: string;
    agentSessionId: string;
    promptKind: string;
    requestId: string;
    action?: string;
    optionId?: string;
    payload?: Record<string, unknown>;
  }): Promise<void>;
  ensureSessionSynchronized(
    input: WorkspaceAgentActivityEnsureSessionSynchronizedInput
  ): () => void;
  /** @deprecated Use ensureSessionSynchronized. */
  retainSessionEvents(
    input: WorkspaceAgentActivityRetainSessionInput
  ): () => void;
  sendInput(input: AgentActivitySendInput): Promise<AgentActivitySession>;
  readSessionAttachment(input: {
    agentSessionId: string;
    attachmentId: string;
    workspaceId: string;
  }): Promise<WorkspaceAgentActivityAttachment>;
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
