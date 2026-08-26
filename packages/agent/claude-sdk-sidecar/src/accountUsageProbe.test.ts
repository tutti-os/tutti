import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeClaudeAccountUsage,
  probeClaudeAccountUsage
} from "./accountUsageProbe.ts";

test("probeClaudeAccountUsage initializes and reads usage without yielding a prompt", async () => {
  let initialized = false;
  let closed = false;
  let promptYielded = false;
  const result = await probeClaudeAccountUsage(
    { cwd: "/workspace", env: {} },
    ({ prompt, options }) => {
      void (async () => {
        for await (const _message of prompt) {
          promptYielded = true;
        }
      })();
      assert.equal(options.cwd, "/workspace");
      return {
        async initializationResult() {
          initialized = true;
          return {};
        },
        async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
          assert.equal(initialized, true);
          return {
            session: {
              total_cost_usd: 0,
              total_api_duration_ms: 0,
              total_duration_ms: 0,
              total_lines_added: 0,
              total_lines_removed: 0,
              model_usage: {}
            },
            subscription_type: "pro",
            rate_limits_available: true,
            rate_limits: {
              five_hour: { utilization: 25, resets_at: null }
            },
            local_usage_attribution: null
          };
        },
        close() {
          closed = true;
        },
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ done: true as const, value: undefined })
          };
        }
      };
    }
  );
  assert.equal(promptYielded, false);
  assert.equal(closed, true);
  assert.deepEqual(result, {
    subscriptionType: "pro",
    rateLimitsAvailable: true,
    rateLimits: {
      five_hour: { utilization: 25, resets_at: null }
    }
  });
});

test("normalizeClaudeAccountUsage keeps unavailable rate limits distinct from an error", () => {
  assert.deepEqual(
    normalizeClaudeAccountUsage({
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null
    }),
    {
      subscriptionType: null,
      rateLimitsAvailable: false,
      rateLimits: null
    }
  );
});

test("normalizeClaudeAccountUsage rejects malformed responses", () => {
  assert.throws(
    () => normalizeClaudeAccountUsage({ rate_limits_available: "yes" }),
    /omitted rate_limits_available/u
  );
  assert.throws(
    () =>
      normalizeClaudeAccountUsage({
        rate_limits_available: true,
        rate_limits: []
      }),
    /invalid rate_limits/u
  );
});
