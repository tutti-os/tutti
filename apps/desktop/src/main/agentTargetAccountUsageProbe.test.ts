import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mapProviderOwnedAccountUsageResult } from "./agentTargetAccountUsageProbe.ts";

const target = {
  agentTargetId: "extension:kimi-code",
  provider: "kimi-code"
};

test("mapProviderOwnedAccountUsageResult keeps the Kimi 0.34.0 weekly and five-hour windows", async () => {
  const helperPayload = JSON.parse(
    await readFile(
      new URL(
        "../../../../services/tuttid/service/agentextension/testdata/kimi-account-usage-available.json",
        import.meta.url
      ),
      "utf8"
    )
  );
  const result = mapProviderOwnedAccountUsageResult(target, {
    ...helperPayload,
    schemaVersion: "tutti.agent.account-usage.v2",
    quotaState: "complete",
    agentTargetId: target.agentTargetId,
    provider: target.provider
  });

  assert.deepEqual(result.usage?.quotas, [
    {
      quotaType: "weekly",
      percentRemaining: 72,
      resetsAtUnixMs: 1_787_270_400_000
    },
    {
      quotaType: "session",
      percentRemaining: 25,
      resetsAtUnixMs: 1_770_000_060_000
    }
  ]);
});

test("mapProviderOwnedAccountUsageResult rejects model quotas without a stable model name", () => {
  const result = mapProviderOwnedAccountUsageResult(target, {
    schemaVersion: "tutti.agent.account-usage.v2",
    agentTargetId: target.agentTargetId,
    provider: target.provider,
    outcome: "available",
    capturedAtUnixMs: 1,
    billingMode: "subscription",
    quotaState: "complete",
    quotas: [{ quotaType: "model", percentRemaining: 50 }]
  });

  assert.equal(result.lastError?.code, "parse_failed");
  assert.equal(result.usage, undefined);
});

test("mapProviderOwnedAccountUsageResult preserves exact complete credits", () => {
  const result = mapProviderOwnedAccountUsageResult(
    { agentTargetId: "extension:codebuddy", provider: "acp:codebuddy" },
    {
      schemaVersion: "tutti.agent.account-usage.v2",
      agentTargetId: "extension:codebuddy",
      provider: "acp:codebuddy",
      outcome: "available",
      capturedAtUnixMs: 1,
      billingMode: "provider_account",
      quotaState: "complete",
      quotas: [
        {
          quotaType: "credits",
          percentRemaining: 50,
          amountRemaining: 1050.5,
          amountLimit: 2101,
          amountUnit: "credits"
        }
      ]
    }
  );

  assert.deepEqual(result.usage, {
    billingMode: "provider_account",
    quotaState: "complete",
    capturedAtUnixMs: 1,
    quotas: [
      {
        quotaType: "credits",
        percentRemaining: 50,
        amountRemaining: 1050.5,
        amountLimit: 2101,
        amountUnit: "credits"
      }
    ]
  });
});

test("mapProviderOwnedAccountUsageResult keeps unproven account balance unavailable", () => {
  const result = mapProviderOwnedAccountUsageResult(
    { agentTargetId: "extension:codebuddy", provider: "acp:codebuddy" },
    {
      schemaVersion: "tutti.agent.account-usage.v2",
      agentTargetId: "extension:codebuddy",
      provider: "acp:codebuddy",
      outcome: "available",
      capturedAtUnixMs: 1,
      billingMode: "provider_account",
      quotaState: "unavailable",
      quotas: []
    }
  );

  assert.equal(result.lastError, undefined);
  assert.deepEqual(result.usage, {
    billingMode: "provider_account",
    quotaState: "unavailable",
    capturedAtUnixMs: 1,
    quotas: []
  });
});
