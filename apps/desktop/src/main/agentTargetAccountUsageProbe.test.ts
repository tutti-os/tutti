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
    schemaVersion: "tutti.agent.account-usage.v1",
    agentTargetId: target.agentTargetId,
    provider: target.provider,
    outcome: "available",
    capturedAtUnixMs: 1,
    billingMode: "subscription",
    quotas: [{ quotaType: "model", percentRemaining: 50 }]
  });

  assert.equal(result.lastError?.code, "parse_failed");
  assert.equal(result.usage, undefined);
});
