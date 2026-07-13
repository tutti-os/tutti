import {
  selectPlanDecisionForTurn,
  selectWorkspaceAgentConsumerSession,
  type AgentSessionEngine,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";
import {
  PLAN_IMPLEMENTATION_ACTION_FEEDBACK,
  PLAN_IMPLEMENTATION_ACTION_IMPLEMENT,
  PLAN_IMPLEMENTATION_ACTION_SKIP
} from "./planImplementationPresentation";

export type AgentPlanPromptAction =
  | typeof PLAN_IMPLEMENTATION_ACTION_IMPLEMENT
  | typeof PLAN_IMPLEMENTATION_ACTION_FEEDBACK
  | typeof PLAN_IMPLEMENTATION_ACTION_SKIP;

export function selectAgentPlanPromptTurn(
  state: AgentSessionEngineState,
  agentSessionId: string,
  requestId: string
) {
  const latestTurn = selectWorkspaceAgentConsumerSession(
    state,
    agentSessionId
  )?.latestTurn;
  return latestTurn?.turnId === requestId &&
    latestTurn.phase === "settled" &&
    latestTurn.outcome === "completed"
    ? latestTurn
    : null;
}

export function dispatchAgentPlanPromptAction(input: {
  action: AgentPlanPromptAction;
  agentSessionId: string;
  engine: AgentSessionEngine;
  feedbackText?: string;
  nowUnixMs?: () => number;
  requestId: string;
  workspaceId: string;
}): boolean {
  const turn = selectAgentPlanPromptTurn(
    input.engine.getSnapshot(),
    input.agentSessionId,
    input.requestId
  );
  if (!turn) return false;
  const scopeKey = [
    "plan-implementation",
    input.workspaceId,
    input.agentSessionId,
    turn.turnId
  ].join(":");
  if (input.action === PLAN_IMPLEMENTATION_ACTION_IMPLEMENT) {
    const existing = selectPlanDecisionForTurn(
      input.engine.getSnapshot(),
      input.agentSessionId,
      turn.turnId
    );
    input.engine.dispatch({
      type: "plan/decisionRequested",
      action: "implement",
      agentSessionId: input.agentSessionId,
      commandId: `plan-decision:${scopeKey}`,
      idempotencyKey: scopeKey,
      promptKind: "plan-implementation",
      requestId: input.requestId,
      turnId: turn.turnId,
      workspaceId: input.workspaceId,
      ...(existing?.status === "failed" || existing?.status === "unknown"
        ? { retry: true }
        : {}),
      timeoutMs: 30_000
    });
    return true;
  }
  if (input.action === PLAN_IMPLEMENTATION_ACTION_SKIP) {
    input.engine.dispatch({
      type: "plan/skipped",
      agentSessionId: input.agentSessionId,
      requestId: input.requestId,
      turnId: turn.turnId,
      workspaceId: input.workspaceId
    });
    return true;
  }
  const text = input.feedbackText?.trim() ?? "";
  if (!text) return false;
  const requestedAtUnixMs = (input.nowUnixMs ?? Date.now)();
  input.engine.dispatch({
    type: "plan/feedbackRequested",
    agentSessionId: input.agentSessionId,
    clientSubmitId: `${scopeKey}:feedback:${requestedAtUnixMs}`,
    content: [{ type: "text", text }],
    displayPrompt: text,
    expiresAtUnixMs: requestedAtUnixMs + 120_000,
    requestedAtUnixMs,
    requestId: input.requestId,
    runtimeContent: [{ type: "text", text }],
    turnId: turn.turnId,
    workspaceId: input.workspaceId
  });
  return true;
}
