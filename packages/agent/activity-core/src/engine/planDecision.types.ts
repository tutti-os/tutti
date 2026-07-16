export type PlanDecisionStatus = "requested" | "failed" | "unknown";
export type PlanDecisionPromptKind = "plan-implementation";
export type PlanDecisionAction = "implement";

export interface PlanDecisionRecord {
  action: PlanDecisionAction;
  agentSessionId: string;
  commandId: string;
  errorCode: string | null;
  errorMessage: string | null;
  idempotencyKey: string;
  operationId: string | null;
  payload: Readonly<Record<string, unknown>> | null;
  promptKind: PlanDecisionPromptKind;
  requestId: string;
  status: PlanDecisionStatus;
  turnId: string;
  workspaceId: string;
}

export interface PlanDecisionState {
  byId: Readonly<Record<string, PlanDecisionRecord>>;
  dismissedByTurnKey: Readonly<Record<string, true>>;
}

export interface PlanDecisionRequestedIntent {
  type: "plan/decisionRequested";
  action: PlanDecisionAction;
  agentSessionId: string;
  commandId: string;
  idempotencyKey: string;
  payload?: Readonly<Record<string, unknown>>;
  promptKind: PlanDecisionPromptKind;
  requestId: string;
  retry?: boolean;
  timeoutMs?: number;
  turnId: string;
  workspaceId: string;
}

export interface PlanFeedbackRequestedIntent {
  type: "plan/feedbackRequested";
  agentSessionId: string;
  capabilityRefs?: readonly import("../types.ts").AgentActivityCapabilityReference[];
  clientSubmitId: string;
  content: readonly import("../types.ts").AgentPromptContentBlock[];
  displayPrompt?: string;
  expiresAtUnixMs: number;
  requestedAtUnixMs: number;
  requestId: string;
  runtimeContent?: readonly import("../types.ts").AgentPromptContentBlock[];
  turnId: string;
  workspaceId: string;
}

export interface PlanSkippedIntent {
  type: "plan/skipped";
  agentSessionId: string;
  requestId: string;
  turnId: string;
  workspaceId: string;
}

export type PlanDecisionIntent =
  | PlanDecisionRequestedIntent
  | PlanFeedbackRequestedIntent
  | PlanSkippedIntent;

export interface PlanSubmitDecisionCommand {
  type: "plan/submitDecision";
  action: PlanDecisionAction;
  agentSessionId: string;
  commandId: string;
  correlationId: string;
  idempotencyKey: string;
  payload?: Readonly<Record<string, unknown>>;
  promptKind: PlanDecisionPromptKind;
  requestId: string;
  timeoutMs?: number;
  turnId: string;
  workspaceId: string;
}
