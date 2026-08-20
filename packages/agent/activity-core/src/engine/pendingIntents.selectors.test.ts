import assert from "node:assert/strict";
import test from "node:test";
import { createInitialAgentSessionEngineState } from "./rootReducer.ts";
import {
  selectPendingActivations,
  selectPendingSubmits
} from "./pendingIntents.selectors.ts";

test("pending-intent collection selectors reuse results for unchanged record maps", () => {
  const initial = createInitialAgentSessionEngineState();

  assert.strictEqual(
    selectPendingActivations(initial),
    selectPendingActivations(initial)
  );
  assert.strictEqual(
    selectPendingSubmits(initial),
    selectPendingSubmits(initial)
  );

  const copied = {
    ...initial,
    pendingIntents: {
      ...initial.pendingIntents,
      activationsByRequestId: {
        ...initial.pendingIntents.activationsByRequestId
      },
      submitsByClientSubmitId: {
        ...initial.pendingIntents.submitsByClientSubmitId
      }
    }
  };
  assert.notStrictEqual(
    selectPendingActivations(initial),
    selectPendingActivations(copied)
  );
  assert.notStrictEqual(
    selectPendingSubmits(initial),
    selectPendingSubmits(copied)
  );
});
