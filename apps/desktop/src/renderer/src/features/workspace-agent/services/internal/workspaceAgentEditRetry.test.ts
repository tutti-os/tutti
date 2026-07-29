import assert from "node:assert/strict";
import test from "node:test";
import {
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
