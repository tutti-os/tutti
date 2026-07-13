import type {
  AgentHostAgentModelCatalogInvalidatedEvent,
  AgentHostAgentSessionCommand,
  AgentHostAgentSessionComposerSettings,
  AgentHostAgentSessionEvent,
  AgentHostAgentSessionPermissionConfig,
  AgentHostAgentSessionPermissionMode,
  AgentHostAgentSessionPermissionModeOption,
  AgentHostAgentSessionProvider,
  AgentHostAgentSessionReasoningEffort,
  AgentHostAgentSessionSpeed,
  AgentHostAgentSessionState
} from "./contracts/dto";

export interface AgentActivityMessageUpdate {
  agentSessionId: string;
  callId?: string;
  completedAtUnixMs?: number;
  kind: string;
  messageId: string;
  occurredAtUnixMs: number;
  payload?: Record<string, unknown>;
  role: string;
  seq: number;
  startedAtUnixMs?: number;
  status?: string;
  title?: string;
  turnId: string | null;
  workspaceId?: string;
}
export type AgentModelCatalogInvalidatedEvent =
  AgentHostAgentModelCatalogInvalidatedEvent;
export type AgentSessionCommand = AgentHostAgentSessionCommand;
export type AgentSessionComposerSettings =
  AgentHostAgentSessionComposerSettings;
export type AgentSessionEvent = AgentHostAgentSessionEvent;
export type AgentSessionPermissionConfig =
  AgentHostAgentSessionPermissionConfig;
export type AgentSessionPermissionMode = AgentHostAgentSessionPermissionMode;
export type AgentSessionPermissionModeOption =
  AgentHostAgentSessionPermissionModeOption;
export type AgentSessionProvider = AgentHostAgentSessionProvider;
export type AgentSessionReasoningEffort = AgentHostAgentSessionReasoningEffort;
export type AgentSessionSpeed = AgentHostAgentSessionSpeed;
export type AgentSessionState = AgentHostAgentSessionState;
