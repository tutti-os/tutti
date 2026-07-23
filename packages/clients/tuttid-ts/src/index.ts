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
  AgentQuickpromptUpdatedPayloadV1,
  AgentQuickpromptUpdatedEventV1,
  WorkspaceWorkbenchNodeLaunchRequestedEventV1,
  WorkspaceIssueUpdatedEventV1,
  WorkspaceTuttimodeUpdatedEventV1,
  WorkspaceTuttimodeUpdatedPayloadV1,
  WorkspaceWorkflowUpdatedEventV1
} from "@tutti-os/event-protocol";
export {
  createTuttidClient,
  type CreateTuttidClientInput,
  type MobileRemoteAccessClient,
  type TuttidClient
} from "./tuttidClient.ts";
export {
  createWorkspaceAgentConfigurationClient,
  type ModelPlanBillingMode,
  type ModelPlanPricing,
  type WorkspaceAgentConfigurationClient,
  type WorkspaceModelRecommendation
} from "./workspaceAgentConfigurationClient.ts";
export {
  createWorkspaceIssueOrchestrationClient,
  type WorkspaceIssueOrchestrationClient
} from "./workspaceIssueOrchestrationClient.ts";
export type {
  AgentSessionAutomationRuleOverride,
  AutomationRule,
  AutomationRuleBudget,
  AutomationRulePermissions,
  AutomationRuleTarget,
  AutomationRuleTargetKind,
  AutomationRuleTrigger,
  ModelPlan,
  ModelPlanDetection,
  ModelPlanDetectionStage,
  ModelPlanFirstUse,
  ModelPlanModel,
  ModelPlanProtocol,
  ModelPlanReference,
  ModelPlanStageResult,
  ModelPlanStageStatus,
  ModelPlanStatus,
  ModelPlanTemplateKind,
  PutAutomationRuleRequest,
  SetAgentSessionAutomationRuleOverrideRequest
} from "./generated/index.ts";
export {
  WORKSPACE_AGENT_INTERACTION_KINDS,
  WORKSPACE_AGENT_INTERACTION_STATUSES,
  WORKSPACE_AGENT_TURN_OUTCOMES,
  WORKSPACE_AGENT_TURN_PHASES
} from "./agentProtocolGuards.ts";
export type { WorkspaceAgentSessionAuditEvent } from "./agentProtocolGuards.ts";
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
