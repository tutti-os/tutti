import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceAgentMessageCenterItem } from "@tutti-os/agent-gui/agent-message-center";
import { submitWorkspaceAgentDecision } from "./workspaceAgentDecisionSubmission.ts";

test("plan implementation toast actions use the plan decision dispatcher", () => {
  const planActions: unknown[] = [];
  const interactionResponses: unknown[] = [];

  submitWorkspaceAgentDecision({
    item: planItem(),
    submitInput: { action: "implement", requestId: "turn-plan" },
    dispatchPlanAction: (submission) => {
      planActions.push(submission);
      return true;
    },
    submitInteractionResponse: (submission) => {
      interactionResponses.push(submission);
      return true;
    }
  });

  assert.deepEqual(planActions, [
    {
      action: "implement",
      agentSessionId: "session-1",
      requestId: "turn-plan"
    }
  ]);
  assert.deepEqual(interactionResponses, []);
});

test("plan feedback preserves exact identity and text without submitting an interaction", () => {
  const planActions: unknown[] = [];
  const interactionResponses: unknown[] = [];

  submitWorkspaceAgentDecision({
    item: planItem(),
    submitInput: {
      action: "feedback",
      requestId: "turn-plan",
      payload: { text: "Revise the rollout order" }
    },
    dispatchPlanAction: (submission) => {
      planActions.push(submission);
      return true;
    },
    submitInteractionResponse: (submission) => {
      interactionResponses.push(submission);
      return true;
    }
  });

  assert.deepEqual(planActions, [
    {
      action: "feedback",
      agentSessionId: "session-1",
      feedbackText: "Revise the rollout order",
      requestId: "turn-plan"
    }
  ]);
  assert.deepEqual(interactionResponses, []);
});

test("plan skip uses the plan dispatcher without submitting an interaction", () => {
  const planActions: unknown[] = [];
  let interactionResponseCount = 0;

  submitWorkspaceAgentDecision({
    item: planItem(),
    submitInput: { action: "skip", requestId: "turn-plan" },
    dispatchPlanAction: (submission) => {
      planActions.push(submission);
      return true;
    },
    submitInteractionResponse: () => {
      interactionResponseCount += 1;
      return true;
    }
  });

  assert.deepEqual(planActions, [
    {
      action: "skip",
      agentSessionId: "session-1",
      requestId: "turn-plan"
    }
  ]);
  assert.equal(interactionResponseCount, 0);
});

test("plan submission rejects mismatched identity and invalid actions without dispatch", () => {
  for (const submitInput of [
    { action: "implement", requestId: "turn-other" },
    { action: "allow", requestId: "turn-plan" }
  ]) {
    let planActionCount = 0;
    let interactionResponseCount = 0;

    assert.throws(
      () =>
        submitWorkspaceAgentDecision({
          item: planItem(),
          submitInput,
          dispatchPlanAction: () => {
            planActionCount += 1;
            return true;
          },
          submitInteractionResponse: () => {
            interactionResponseCount += 1;
            return true;
          }
        }),
      /plan_response_target_mismatch/u
    );
    assert.equal(planActionCount, 0);
    assert.equal(interactionResponseCount, 0);
  }
});

test("plan submission keeps the toast pending when the dispatcher rejects it", () => {
  let interactionResponseCount = 0;

  assert.throws(
    () =>
      submitWorkspaceAgentDecision({
        item: planItem(),
        submitInput: { action: "implement", requestId: "turn-plan" },
        dispatchPlanAction: () => false,
        submitInteractionResponse: () => {
          interactionResponseCount += 1;
          return true;
        }
      }),
    /plan_response_not_accepted/u
  );
  assert.equal(interactionResponseCount, 0);
});

test("ordinary interaction toast actions keep using interaction response submission", () => {
  const planActions: unknown[] = [];
  const interactionResponses: unknown[] = [];

  submitWorkspaceAgentDecision({
    item: interactionItem(),
    submitInput: {
      action: "allow",
      optionId: "acceptEdits",
      requestId: "request-approval"
    },
    dispatchPlanAction: (submission) => {
      planActions.push(submission);
      return true;
    },
    submitInteractionResponse: (submission) => {
      interactionResponses.push(submission);
      return true;
    }
  });

  assert.deepEqual(planActions, []);
  assert.deepEqual(interactionResponses, [
    {
      action: "allow",
      agentSessionId: "session-1",
      optionId: "acceptEdits",
      requestId: "request-approval",
      turnId: "turn-plan"
    }
  ]);
});

function planItem(): WorkspaceAgentMessageCenterItem {
  return {
    id: "message-center-session-1",
    agentSessionId: "session-1",
    provider: "codex",
    userId: null,
    title: "Canonical session",
    identity: null,
    cwd: "/workspace",
    status: "waiting",
    digest: {
      primary: {
        kind: "input-required",
        summary: "Implement plan?",
        occurredAtUnixMs: 20
      }
    },
    lastAgentMessageSummary: "Implement plan?",
    lastAgentMessageAtUnixMs: 20,
    pendingInteractionTarget: null,
    pendingPrompt: {
      kind: "plan-implementation",
      requestId: "turn-plan",
      title: "Implement plan?"
    },
    needsAttentionKind: "constraint",
    needsAttentionSummary: "Implement plan?",
    latestTurnOutcome: null,
    sortTimeUnixMs: 20
  };
}

function interactionItem(): WorkspaceAgentMessageCenterItem {
  return {
    ...planItem(),
    pendingInteractionTarget: {
      agentSessionId: "session-1",
      requestId: "request-approval",
      turnId: "turn-plan"
    },
    pendingPrompt: {
      kind: "approval",
      id: "approval-request-approval",
      turnId: "turn-plan",
      requestId: "request-approval",
      callId: "call-approval",
      title: "Allow Bash?",
      toolName: "Bash",
      status: "pending",
      input: { command: "pnpm test" },
      options: [
        {
          id: "acceptEdits",
          kind: "allow",
          label: "Allow"
        }
      ],
      output: null,
      occurredAtUnixMs: 20
    }
  };
}
