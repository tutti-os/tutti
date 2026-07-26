import assert from "node:assert/strict";
import test from "node:test";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import {
  WorkspaceAgentEditRetryOperations,
  editRetryAvailabilityFromTuttid,
  editRetryResultFromTuttid
} from "./workspaceAgentEditRetry.ts";

test("edit retry transport mapping preserves recovery actions and stable identities", () => {
  assert.deepEqual(
    editRetryAvailabilityFromTuttid({
      supported: true,
      eligible: false,
      historyRevision: 7,
      recoveryState: "recovery_required",
      operationId: "operation-1",
      availableActions: ["reconcile", "retry_replacement"],
      reasonCode: "provider_outcome_unknown"
    }),
    {
      supported: true,
      eligible: false,
      historyRevision: 7,
      recoveryState: "recovery_required",
      operationId: "operation-1",
      availableActions: ["reconcile", "retry_replacement"],
      reasonCode: "provider_outcome_unknown"
    }
  );
  assert.deepEqual(
    editRetryResultFromTuttid({
      operationId: "operation-1",
      state: "completed",
      retractedTurnId: "turn-old",
      replacementTurnId: "turn-new",
      historyRevision: 8
    }),
    {
      operationId: "operation-1",
      state: "completed",
      retractedTurnId: "turn-old",
      replacementTurnId: "turn-new",
      historyRevision: 8
    }
  );
});

test("edit retry operations only translate the injected TuttidClient command", async () => {
  const calls: Array<{ kind: string; values: unknown[] }> = [];
  const signal = new AbortController().signal;
  const completed = {
    historyRevision: 8,
    operationId: "operation-1",
    replacementTurnId: "turn-new",
    retractedTurnId: "turn-old",
    state: "completed"
  } as const;
  const tuttidClient: Pick<TuttidClient, "editRetry" | "recoverEditRetry"> = {
    editRetry: async (...values) => {
      calls.push({ kind: "edit", values });
      return completed;
    },
    recoverEditRetry: async (...values) => {
      calls.push({ kind: "recover", values });
      return completed;
    }
  };
  const operations = new WorkspaceAgentEditRetryOperations({ tuttidClient });

  const editResult = await operations.editRetry({
    agentSessionId: " session-1 ",
    clientOperationId: "client-operation-1",
    editedText: "edited prompt",
    expectedHistoryRevision: 7,
    signal,
    turnId: "turn-old",
    workspaceId: " ws-1 "
  });
  const recoveryResult = await operations.recoverEditRetry({
    action: "reconcile",
    agentSessionId: " session-1 ",
    operationId: "operation-1",
    signal,
    workspaceId: " ws-1 "
  });
  assert.deepEqual(editResult, recoveryResult);
  assert.deepEqual(editResult.availability, {
    availableActions: [],
    eligible: false,
    historyRevision: 8,
    operationId: "operation-1",
    recoveryState: "completed",
    supported: true
  });

  assert.deepEqual(calls, [
    {
      kind: "edit",
      values: [
        "ws-1",
        "session-1",
        "turn-old",
        {
          clientOperationId: "client-operation-1",
          editedText: "edited prompt",
          expectedHistoryRevision: 7
        },
        { signal }
      ]
    },
    {
      kind: "recover",
      values: [
        "ws-1",
        "session-1",
        "operation-1",
        { action: "reconcile" },
        { signal }
      ]
    }
  ]);
});
