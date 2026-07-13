export interface AgentSessionAvailableCommand {
  description?: string;
  inputHint?: string;
  name: string;
}

export interface SessionCommandsState {
  bySessionId: Readonly<
    Record<
      string,
      {
        commands: readonly AgentSessionAvailableCommand[];
        workspaceId: string;
      }
    >
  >;
}

export interface SessionAvailableCommandsReceivedIntent {
  type: "session/availableCommandsReceived";
  agentSessionId: string;
  commands: readonly unknown[];
  workspaceId: string;
}

export type SessionCommandsIntent = SessionAvailableCommandsReceivedIntent;
