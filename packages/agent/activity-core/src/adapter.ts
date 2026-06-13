import type {
  AgentActivityCancelSessionInput,
  AgentActivityCancelSessionResult,
  AgentActivityCreateSessionInput,
  AgentActivityDeleteSessionInput,
  AgentActivityDeleteSessionResult,
  AgentActivityComposerOptions,
  AgentActivityLoadComposerOptionsInput,
  AgentActivityMessageOrder,
  AgentActivityMessagePage,
  AgentActivitySendInput,
  AgentActivitySession,
  AgentActivitySessionEventEnvelope,
  AgentActivitySessionList,
  AgentActivitySubmitInteractiveInput
} from "./types.ts";

export interface AgentActivityAdapter {
  listSessions(input: {
    workspaceId: string;
    signal?: AbortSignal;
  }): Promise<AgentActivitySessionList>;

  listSessionMessages(input: {
    workspaceId: string;
    agentSessionId: string;
    afterVersion?: number;
    beforeVersion?: number;
    limit?: number;
    order?: AgentActivityMessageOrder;
    signal?: AbortSignal;
  }): Promise<AgentActivityMessagePage>;

  loadComposerOptions(
    input: AgentActivityLoadComposerOptionsInput
  ): Promise<AgentActivityComposerOptions>;

  subscribeSessionEvents(input: {
    workspaceId: string;
    agentSessionId: string;
    afterVersion?: number;
    signal: AbortSignal;
    onEvent(event: AgentActivitySessionEventEnvelope): void;
    onError?(error: unknown): void;
  }): Promise<() => void>;

  createSession(
    input: AgentActivityCreateSessionInput
  ): Promise<AgentActivitySession>;
  sendInput(input: AgentActivitySendInput): Promise<AgentActivitySession>;
  cancelSession(
    input: AgentActivityCancelSessionInput
  ): Promise<AgentActivityCancelSessionResult>;
  submitInteractive(
    input: AgentActivitySubmitInteractiveInput
  ): Promise<unknown>;
  deleteSession(
    input: AgentActivityDeleteSessionInput
  ): Promise<AgentActivityDeleteSessionResult>;
}
