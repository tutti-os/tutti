import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  desktopAgentUsageProbeLogLevel,
  listDesktopWorkspaceAgentProbes,
  resetUsageProbeCacheForTesting
} from "./agentProviderUsageProbe.ts";

beforeEach(() => resetUsageProbeCacheForTesting());

test("listDesktopWorkspaceAgentProbes resolves provider aliases through the catalog", async () => {
  let usageProbeCalls = 0;
  const result = await listDesktopWorkspaceAgentProbes(
    {
      includeUsage: false,
      providers: ["open-code"],
      refresh: true,
      workspaceId: "workspace-1"
    },
    {
      probeAgentTargetAccountUsage: async () => {
        usageProbeCalls += 1;
        throw new Error("availability-only probes must not request usage");
      }
    }
  );
  assert.equal(result.providers.length, 1);
  assert.equal(result.providers[0]?.provider, "opencode");
  assert.equal(usageProbeCalls, 0);
});

test("availability-only probes fail closed on target and provider mismatch", async () => {
  const result = await listDesktopWorkspaceAgentProbes({
    includeUsage: false,
    agentTargetIds: ["local:codex"],
    providers: ["claude-code"],
    refresh: true,
    workspaceId: "workspace-1"
  });
  assert.equal(result.providers[0]?.lastError?.code, "parse_failed");
});

test("listDesktopWorkspaceAgentProbes uses daemon-owned Codex usage", async () => {
  const targetIDs: string[] = [];
  const result = await listDesktopWorkspaceAgentProbes(
    {
      includeUsage: true,
      providers: ["codex"],
      refresh: true,
      workspaceId: "workspace-1"
    },
    {
      probeAgentTargetAccountUsage: async (agentTargetId) => {
        targetIDs.push(agentTargetId);
        return {
          schemaVersion: "tutti.agent.account-usage.v2",
          agentTargetId,
          provider: "codex",
          outcome: "available",
          capturedAtUnixMs: 123,
          billingMode: "subscription",
          quotaState: "complete",
          quotas: [
            {
              quotaType: "weekly",
              percentRemaining: 94,
              resetsAtUnixMs: 456
            }
          ]
        };
      }
    }
  );
  assert.deepEqual(targetIDs, ["local:codex"]);
  assert.deepEqual(result.providers[0]?.usage, {
    billingMode: "subscription",
    quotaState: "complete",
    capturedAtUnixMs: 123,
    quotas: [
      {
        quotaType: "weekly",
        percentRemaining: 94,
        resetsAtUnixMs: 456
      }
    ]
  });
});

test("listDesktopWorkspaceAgentProbes keeps unavailable Claude quotas separate from login", async () => {
  const result = await listDesktopWorkspaceAgentProbes(
    {
      includeUsage: true,
      providers: ["claude-code"],
      refresh: true,
      workspaceId: "workspace-1"
    },
    {
      probeAgentTargetAccountUsage: async (agentTargetId) => ({
        schemaVersion: "tutti.agent.account-usage.v2",
        agentTargetId,
        provider: "claude-code",
        outcome: "available",
        capturedAtUnixMs: 123,
        billingMode: "provider_account",
        quotaState: "unavailable",
        quotas: []
      })
    }
  );
  assert.equal(result.providers[0]?.lastError, undefined);
  assert.equal(result.providers[0]?.usage?.quotaState, "unavailable");
  assert.equal(result.providers[0]?.availability.status, "unknown");
});

test("listDesktopWorkspaceAgentProbes consumes provider-owned API billing", async () => {
  const result = await listDesktopWorkspaceAgentProbes(
    {
      includeUsage: true,
      agentTargetIds: ["extension:usage-fixture"],
      providers: ["acp:usage-fixture"],
      refresh: true,
      workspaceId: "workspace-1"
    },
    {
      probeAgentTargetAccountUsage: async (agentTargetId) => ({
        schemaVersion: "tutti.agent.account-usage.v2",
        agentTargetId,
        provider: "acp:usage-fixture",
        outcome: "available",
        capturedAtUnixMs: 123,
        billingMode: "api",
        quotaState: "not_applicable",
        quotas: []
      })
    }
  );
  assert.equal(result.providers[0]?.usage?.billingMode, "api");
});

test("listDesktopWorkspaceAgentProbes fails closed on an unknown provider-owned payload", async () => {
  const result = await listDesktopWorkspaceAgentProbes(
    {
      includeUsage: true,
      agentTargetIds: ["extension:usage-fixture"],
      providers: ["acp:usage-fixture"],
      refresh: true,
      workspaceId: "workspace-1"
    },
    {
      probeAgentTargetAccountUsage: async () =>
        ({
          schemaVersion: "tutti.agent.account-usage.v3",
          agentTargetId: "extension:usage-fixture",
          provider: "acp:usage-fixture",
          outcome: "available",
          capturedAtUnixMs: 123,
          quotas: []
        }) as never
    }
  );
  assert.equal(result.providers[0]?.usage, undefined);
  assert.equal(result.providers[0]?.lastError?.code, "parse_failed");
});

test("listDesktopWorkspaceAgentProbes strips provider diagnostics from projection", async () => {
  const canary = "bearer-secret https://untrusted.invalid/private";
  const result = await listDesktopWorkspaceAgentProbes(
    {
      includeUsage: true,
      agentTargetIds: ["extension:usage-fixture"],
      providers: ["acp:usage-fixture"],
      workspaceId: "workspace-1"
    },
    {
      probeAgentTargetAccountUsage: async () =>
        ({
          schemaVersion: "tutti.agent.account-usage.v2",
          agentTargetId: "extension:usage-fixture",
          provider: "acp:usage-fixture",
          outcome: "error",
          capturedAtUnixMs: 123,
          errorCode: "execution_failed",
          message: canary
        }) as never
    }
  );
  assert.equal(result.providers[0]?.lastError?.code, "parse_failed");
  assert.equal(JSON.stringify(result).includes(canary), false);
});

test("listDesktopWorkspaceAgentProbes coalesces rapid daemon usage probes", async () => {
  let probeCount = 0;
  const started = deferred();
  const release = deferred();
  const dependency = async (agentTargetId: string) => {
    probeCount += 1;
    started.resolve();
    await release.promise;
    return {
      schemaVersion: "tutti.agent.account-usage.v2" as const,
      agentTargetId,
      provider: "claude-code" as const,
      outcome: "available" as const,
      capturedAtUnixMs: 123,
      billingMode: "subscription" as const,
      quotaState: "complete" as const,
      quotas: [{ quotaType: "session" as const, percentRemaining: 90 }]
    };
  };
  const input = {
    includeUsage: true,
    providers: ["claude-code"],
    refresh: true,
    workspaceId: "workspace-1"
  };
  const probes = [
    listDesktopWorkspaceAgentProbes(input, {
      probeAgentTargetAccountUsage: dependency
    }),
    listDesktopWorkspaceAgentProbes(input, {
      probeAgentTargetAccountUsage: dependency
    }),
    listDesktopWorkspaceAgentProbes(input, {
      probeAgentTargetAccountUsage: dependency
    })
  ];
  await started.promise;
  assert.equal(probeCount, 1);
  release.resolve();
  await Promise.all(probes);
  assert.equal(probeCount, 1);
});

test("listDesktopWorkspaceAgentProbes cools down daemon rate limits", async () => {
  let probeCount = 0;
  const dependency = async (agentTargetId: string) => {
    probeCount += 1;
    return {
      schemaVersion: "tutti.agent.account-usage.v2" as const,
      agentTargetId,
      provider: "claude-code" as const,
      outcome: "error" as const,
      capturedAtUnixMs: 123,
      errorCode: "rate_limited" as const
    };
  };
  const input = {
    includeUsage: true,
    providers: ["claude-code"],
    refresh: true,
    workspaceId: "workspace-1"
  };
  const first = await listDesktopWorkspaceAgentProbes(input, {
    probeAgentTargetAccountUsage: dependency
  });
  await listDesktopWorkspaceAgentProbes(input, {
    probeAgentTargetAccountUsage: dependency
  });
  assert.equal(probeCount, 1);
  assert.equal(first.providers[0]?.lastError?.code, "rate_limited");
});

test("desktopAgentUsageProbeLogLevel classifies bounded outcomes", () => {
  assert.equal(desktopAgentUsageProbeLogLevel(0, "execution_failed"), "warn");
  assert.equal(desktopAgentUsageProbeLogLevel(2, "parse_failed"), "warn");
  assert.equal(desktopAgentUsageProbeLogLevel(0, null), "info");
  assert.equal(desktopAgentUsageProbeLogLevel(2, null), "debug");
  assert.equal(desktopAgentUsageProbeLogLevel(0, "unsupported"), "debug");
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
