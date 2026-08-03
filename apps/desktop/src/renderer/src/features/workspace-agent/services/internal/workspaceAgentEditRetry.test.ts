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
      operationVersion: 4,
      automatic: false,
      nextAttemptAtUnixMs: 1234,
      attempt: 2,
      availableActions: ["reconcile", "retry_replacement", "abandon"],
      reasonCode: "provider_outcome_unknown"
    }),
    {
      impactScope: "session",
      supported: true,
      eligible: false,
      historyRevision: 7,
      recoveryState: "recovery_required",
      operationId: "operation-1",
      operationVersion: 4,
      automatic: false,
      nextAttemptAtUnixMs: 1234,
      attempt: 2,
      availableActions: ["reconcile", "retry_replacement", "abandon"],
      reasonCode: "provider_outcome_unknown"
    }
  );
  assert.deepEqual(
    editRetryResultFromTuttid({
      operationId: "operation-1",
      operationVersion: 5,
      state: "completed",
      retractedTurnId: "turn-old",
      replacementTurnId: "turn-new",
      historyRevision: 8,
      automatic: true,
      nextAttemptAtUnixMs: 2345,
      attempt: 3,
      availableActions: ["reconcile"]
    }),
    {
      impactScope: "session",
      operationId: "operation-1",
      operationVersion: 5,
      state: "completed",
      retractedTurnId: "turn-old",
      replacementTurnId: "turn-new",
      historyRevision: 8,
      automatic: true,
      nextAttemptAtUnixMs: 2345,
      attempt: 3,
      availableActions: ["reconcile"]
    }
  );
});

test("edit retry transport mapping accepts the deprecated retry timestamp alias", () => {
  assert.deepEqual(
    editRetryAvailabilityFromTuttid({
      supported: true,
      eligible: false,
      historyRevision: 7,
      recoveryState: "recovery_required",
      operationId: "operation-1",
      operationVersion: 4,
      nextAttemptAt: 1234,
      availableActions: ["reconcile"]
    }),
    {
      impactScope: "session",
      supported: true,
      eligible: false,
      historyRevision: 7,
      recoveryState: "recovery_required",
      operationId: "operation-1",
      operationVersion: 4,
      nextAttemptAtUnixMs: 1234,
      availableActions: ["reconcile"]
    }
  );
});

test("edit retry transport mapping keeps rollout admission distinct from provider support", () => {
  assert.deepEqual(
    editRetryAvailabilityFromTuttid({
      supported: false,
      eligible: false,
      historyRevision: 7,
      recoveryState: "prepared",
      availableActions: [],
      reasonCode: "rollout_disabled"
    }),
    {
      impactScope: "session",
      supported: false,
      eligible: false,
      historyRevision: 7,
      recoveryState: "prepared",
      availableActions: [],
      reasonCode: "rollout_disabled"
    }
  );
});
