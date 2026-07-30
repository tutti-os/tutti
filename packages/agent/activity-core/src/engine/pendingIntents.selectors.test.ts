import assert from "node:assert/strict";
import test from "node:test";
import { createInitialAgentSessionEngineState } from "./rootReducer.ts";
import { selectPendingSubmitsForSession } from "./pendingIntents.selectors.ts";

test("does not reproject a confirmed submit from the retracted edit-retry tail", () => {
  const state = createInitialAgentSessionEngineState();
  state.editRetry = {
    ...state.editRetry,
    tailBySessionId: {
      "session-1": {
        clientOperationId: "client-operation-1",
        editedText: "replacement",
        operationId: null,
        replacementTurnId: null,
        retractedTurnId: "turn-retracted",
        workspaceId: "workspace-1"
      }
    }
  };
  state.pendingIntents = {
    ...state.pendingIntents,
    submitsByClientSubmitId: {
      "submit-retracted": submit("submit-retracted", "turn-retracted"),
      "submit-before": submit("submit-before", "turn-before")
    }
  };

  assert.deepEqual(
    selectPendingSubmitsForSession(state, "session-1").map(
      (record) => record.clientSubmitId
    ),
    ["submit-before"]
  );
});

test("keeps a turnless pending submit when no edit-retry tail is active", () => {
  const state = createInitialAgentSessionEngineState();
  state.pendingIntents = {
    ...state.pendingIntents,
    submitsByClientSubmitId: {
      "submit-turnless": submit("submit-turnless", " ")
    }
  };

  assert.deepEqual(
    selectPendingSubmitsForSession(state, "session-1").map(
      (record) => record.clientSubmitId
    ),
    ["submit-turnless"]
  );
});

function submit(clientSubmitId: string, turnId: string) {
  return {
    acceptedSessionVersion: 1,
    agentSessionId: "session-1",
    clientSubmitId,
    content: [{ type: "text" as const, text: clientSubmitId }],
    errorCode: null,
    errorMessage: null,
    expiresAtUnixMs: 2,
    requestedAtUnixMs: 1,
    status: "confirmed" as const,
    turnId,
    workspaceId: "workspace-1"
  };
}
