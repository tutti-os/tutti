import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInitialPlanDecisionState,
  planDecisionReducer
} from "./planDecision.reducer.ts";

const context = { feedbackAccepted: false, planTurnValid: true };

test("pending plan decision is confirmed by its durable completed notice", () => {
  const requested = planDecisionReducer(
    createInitialPlanDecisionState(),
    {
      action: "implement",
      agentSessionId: "session-1",
      commandId: "command-1",
      idempotencyKey: "idempotency-1",
      promptKind: "plan-implementation",
      requestId: "request-1",
      turnId: "plan-turn-1",
      type: "plan/decisionRequested",
      workspaceId: "workspace-1"
    },
    context
  );
  const pending = planDecisionReducer(
    requested.state,
    {
      commandId: "command-1",
      commandType: "plan/submitDecision",
      correlationId: Object.keys(requested.state.byId)[0],
      outcome: "succeeded",
      type: "engine/commandResult",
      value: {
        operation: {
          agentSessionId: "session-1",
          idempotencyKey: "idempotency-1",
          operationId: "operation-1",
          requestId: "request-1",
          status: "leased",
          turnId: "plan-turn-1",
          workspaceId: "workspace-1"
        }
      }
    },
    context
  );
  assert.equal(Object.values(pending.state.byId)[0]?.status, "unknown");

  const stillPending = planDecisionReducer(
    pending.state,
    {
      messages: [
        {
          agentSessionId: "session-1",
          kind: "system",
          messageId: "notice-1",
          occurredAtUnixMs: 2,
          payload: {
            kind: "agent_system_notice",
            noticeKind: "plan_implementation_pending_confirmation",
            operationId: "operation-1",
            planTurnId: "plan-turn-1"
          },
          role: "system",
          status: "running",
          turnId: null,
          version: 1,
          workspaceId: "workspace-1"
        }
      ],
      type: "message/snapshotReceived",
      workspaceId: "workspace-1"
    },
    context
  );
  assert.equal(Object.values(stillPending.state.byId)[0]?.status, "unknown");

  const completed = planDecisionReducer(
    stillPending.state,
    {
      messages: [
        {
          agentSessionId: "session-1",
          kind: "system",
          messageId: "notice-1",
          occurredAtUnixMs: 3,
          payload: {
            kind: "agent_system_notice",
            noticeKind: "plan_implementation_completed",
            operationId: "operation-1",
            planTurnId: "plan-turn-1"
          },
          role: "system",
          status: "completed",
          turnId: null,
          version: 2,
          workspaceId: "workspace-1"
        }
      ],
      type: "message/snapshotReceived",
      workspaceId: "workspace-1"
    },
    context
  );
  assert.deepEqual(completed.state.byId, {});
  assert.equal(
    completed.state.dismissedByTurnKey["session-1\0plan-turn-1"],
    true
  );
});

test("unrelated completed plan notice cannot confirm an unknown decision", () => {
  let state = planDecisionReducer(
    createInitialPlanDecisionState(),
    {
      action: "implement",
      agentSessionId: "session-1",
      commandId: "command-1",
      idempotencyKey: "idempotency-1",
      promptKind: "plan-implementation",
      requestId: "request-1",
      turnId: "plan-turn-1",
      type: "plan/decisionRequested",
      workspaceId: "workspace-1"
    },
    context
  ).state;
  const key = Object.keys(state.byId)[0] ?? "";
  state = planDecisionReducer(
    state,
    {
      commandId: "command-1",
      commandType: "plan/submitDecision",
      correlationId: key,
      outcome: "succeeded",
      type: "engine/commandResult",
      value: {
        operation: {
          agentSessionId: "session-1",
          idempotencyKey: "idempotency-1",
          operationId: "operation-1",
          requestId: "request-1",
          status: "prepared",
          turnId: "plan-turn-1",
          workspaceId: "workspace-1"
        }
      }
    },
    context
  ).state;
  const unrelated = planDecisionReducer(
    state,
    {
      messages: [
        {
          agentSessionId: "session-1",
          kind: "system",
          messageId: "notice-2",
          occurredAtUnixMs: 3,
          payload: {
            kind: "agent_system_notice",
            noticeKind: "plan_implementation_completed",
            operationId: "operation-other",
            planTurnId: "plan-turn-1"
          },
          role: "system",
          turnId: null,
          version: 2,
          workspaceId: "workspace-1"
        }
      ],
      type: "message/snapshotReceived",
      workspaceId: "workspace-1"
    },
    context
  );
  assert.equal(unrelated.state.byId[key]?.status, "unknown");
});
