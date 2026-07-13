export * from "./generated/index.ts";
export {
  createClient,
  createConfig,
  type Client,
  type ClientOptions,
  type Config
} from "./generated/client/index.ts";
export {
  createTuttidEventStreamClient,
  type CreateTuttidEventStreamClientInput,
  type TuttidEventStreamClient,
  type TuttidEventStreamConnectionState,
  type TuttidEventStreamSubscribeOptions
} from "./eventStreamClient.ts";
export type {
  AgentActivityUpdatedPayloadV1,
  AgentActivityUpdatedEventV1,
  WorkspaceWorkbenchNodeLaunchRequestedEventV1,
  WorkspaceIssueUpdatedEventV1
} from "@tutti-os/event-protocol";
export {
  createTuttidClient,
  type CreateTuttidClientInput,
  type TuttidClient
} from "./tuttidClient.ts";
export {
  WORKSPACE_AGENT_INTERACTION_KINDS,
  WORKSPACE_AGENT_INTERACTION_STATUSES,
  WORKSPACE_AGENT_TURN_OUTCOMES,
  WORKSPACE_AGENT_TURN_PHASES
} from "./agentProtocolGuards.ts";
export {
  getTuttidErrorI18nCandidates,
  getTuttidProtocolErrorCode,
  isTuttidProtocolError,
  TuttidProtocolError,
  normalizeTuttidError,
  type TuttidProtocolErrorCode,
  type TuttidProtocolErrorOptions,
  type TuttidProtocolErrorParams
} from "./errors.ts";

export const runtimeProtocolErrorCodes = {
  invalidRequest: "invalid_request",
  methodNotAllowed: "method_not_allowed",
  serviceUnavailable: "service_unavailable"
} as const;

export type RuntimeProtocolErrorCode =
  (typeof runtimeProtocolErrorCodes)[keyof typeof runtimeProtocolErrorCodes];

export const workspaceProtocolErrorCodes = {
  preferencesOperationFailed: "preferences_operation_failed",
  workspaceAppNotFound: "workspace_app_not_found",
  workspaceFileNotFound: "workspace_file_not_found",
  workspaceIssueResourceExists: "workspace_issue_resource_exists",
  workspaceIssueResourceNotFound: "workspace_issue_resource_not_found",
  workspaceNotFound: "workspace_not_found",
  workspaceOperationFailed: "workspace_operation_failed"
} as const;

export type WorkspaceProtocolErrorCode =
  (typeof workspaceProtocolErrorCodes)[keyof typeof workspaceProtocolErrorCodes];
