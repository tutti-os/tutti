import type {
  AgentActivityGoalControlInput,
  AgentActivityGoalControlResult,
  AgentActivityCreateSessionInput,
  AgentActivityDeleteSessionInput,
  AgentActivityDeleteSessionResult,
  AgentActivityComposerOptions,
  AgentActivityLoadComposerOptionsInput,
  AgentActivityMessageOrder,
  AgentActivityMessagePage,
  AgentActivityRenameSessionInput,
  AgentActivitySendInput,
  AgentActivitySendInputResult,
  AgentActivitySession,
  AgentActivitySessionList,
  AgentActivitySubmitInteractiveInput,
  AgentActivitySubmitInteractiveResult
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

  createSession(
    input: AgentActivityCreateSessionInput
  ): Promise<AgentActivitySession>;
  sendInput(
    input: AgentActivitySendInput
  ): Promise<AgentActivitySendInputResult>;
  goalControl(
    input: AgentActivityGoalControlInput
  ): Promise<AgentActivityGoalControlResult>;
  submitInteractive(
    input: AgentActivitySubmitInteractiveInput
  ): Promise<AgentActivitySubmitInteractiveResult>;
  deleteSession(
    input: AgentActivityDeleteSessionInput
  ): Promise<AgentActivityDeleteSessionResult>;
  renameSession(
    input: AgentActivityRenameSessionInput
  ): Promise<AgentActivitySession>;
}
