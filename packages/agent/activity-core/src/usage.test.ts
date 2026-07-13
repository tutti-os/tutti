import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAgentActivityUsage } from "./usage.ts";

test("resolves context window usage with percent", () => {
  const usage = resolveAgentActivityUsage({
    sessionUsage: {
      contextWindow: { usedTokens: 50_000, totalTokens: 200_000 },
      quotas: [
        { quotaType: "session", percentRemaining: 75, resetsAtUnixMs: null }
      ]
    }
  });
  assert.deepEqual(usage, {
    usedTokens: 50_000,
    totalTokens: 200_000,
    percentUsed: 25,
    quotas: [
      { quotaType: "session", percentRemaining: 75, resetsAtUnixMs: null }
    ]
  });
});

test("returns null without usable context window", () => {
  assert.equal(resolveAgentActivityUsage({}), null);
  assert.equal(
    resolveAgentActivityUsage({
      sessionUsage: {
        contextWindow: { usedTokens: 1, totalTokens: 0 },
        quotas: []
      }
    }),
    null
  );
});

test("quotas-only usage still resolves with null percent", () => {
  const usage = resolveAgentActivityUsage({
    sessionUsage: {
      contextWindow: null,
      quotas: [
        { quotaType: "weekly", percentRemaining: 90, resetsAtUnixMs: null }
      ]
    }
  });
  assert.equal(usage?.percentUsed, null);
  assert.equal(usage?.quotas.length, 1);
});
