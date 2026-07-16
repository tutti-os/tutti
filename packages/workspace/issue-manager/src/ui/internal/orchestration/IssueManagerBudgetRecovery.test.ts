import assert from "node:assert/strict";
import test from "node:test";
import { createLowerIntensityBudgetRecoveryPatch } from "./IssueManagerBudgetRecovery.ts";

test("lower-intensity recovery pauses dispatch while remaining tasks are rearranged", () => {
  assert.deepEqual(
    createLowerIntensityBudgetRecoveryPatch({
      budget: {
        consumedTokens: 30_000,
        mode: "fixed",
        quotaWaterlinePercent: 10,
        status: "soft_limited",
        tokenLimit: 60_000
      },
      executionProfile: {
        orchestrationIntensity: 10,
        reasoningIntensity: 50
      }
    }),
    {
      budget: {
        consumedTokens: 30_000,
        mode: "fixed",
        quotaWaterlinePercent: 10,
        status: "active",
        tokenLimit: 60_000
      },
      dispatchPaused: true,
      executionProfile: {
        orchestrationIntensity: 0,
        reasoningIntensity: 30
      }
    }
  );
});
