import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import {
  desktopAgentUsageProbeLogLevel,
  listDesktopWorkspaceAgentProbes,
  resetUsageProbeCacheForTesting,
  setClaudeOAuthKeychainReaderForTesting
} from "./agentProviderUsageProbe.ts";
import { setOutboundFetcherForTesting } from "./net/outboundFetch.ts";

// The probe caches usage results per exact Agent Target in module state; clear it so one
// case's result never leaks into the next.
beforeEach(() => {
  resetUsageProbeCacheForTesting();
  setClaudeOAuthKeychainReaderForTesting(async () => {
    throw new Error("test keychain credential not found");
  });
  // Isolate from a developer's real Claude environment so custom-API settings
  // (ANTHROPIC_BASE_URL / auth token) cannot shadow the OAuth/custom-API
  // fixtures under test.
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_API_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
});

test("listDesktopWorkspaceAgentProbes resolves provider aliases through the catalog", async () => {
  const result = await listDesktopWorkspaceAgentProbes({
    includeUsage: false,
    providers: ["open-code"],
    refresh: true,
    workspaceId: "workspace-1"
  });

  assert.equal(result.providers.length, 1);
  assert.equal(result.providers[0]?.provider, "opencode");
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

  assert.equal(result.providers.length, 1);
  assert.equal(result.providers[0]?.agentTargetId, "extension:usage-fixture");
  assert.equal(result.providers[0]?.provider, "acp:usage-fixture");
  assert.equal(result.providers[0]?.availability.status, "unknown");
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
  const canaries = [
    "bearer-secret",
    "https://untrusted.invalid/private",
    "/private/kimi/credentials/kimi-code.json",
    "raw-provider-body"
  ];
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
          message: canaries.join(" ")
        }) as never
    }
  );

  assert.equal(result.providers[0]?.lastError?.code, "parse_failed");
  const serialized = JSON.stringify(result);
  for (const canary of canaries)
    assert.equal(serialized.includes(canary), false);
});

test("listDesktopWorkspaceAgentProbes maps Codex OAuth usage windows", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const directory = await mkdtemp(join(tmpdir(), "tutti-codex-usage-"));
  try {
    process.env.CODEX_HOME = directory;
    await writeFile(
      join(directory, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "access-token-1",
          account_id: "account-1"
        }
      })
    );
    setOutboundFetcherForTesting(async (url, init) => {
      assert.equal(
        fetchInputUrl(url),
        "https://chatgpt.com/backend-api/wham/usage"
      );
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer access-token-1");
      assert.equal(headers.get("chatgpt-account-id"), "account-1");
      return new Response(
        JSON.stringify({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 7,
              limit_window_seconds: 604800,
              reset_at: 1781182502
            },
            secondary_window: {
              used_percent: 12,
              limit_window_seconds: 18000,
              reset_at: 1781750585
            }
          },
          additional_rate_limits: [
            {
              limit_name: "GPT-5.3-Codex-Spark",
              rate_limit: {
                primary_window: {
                  used_percent: 0,
                  limit_window_seconds: 18000,
                  reset_at: 1781184861
                },
                secondary_window: {
                  used_percent: 2,
                  limit_window_seconds: 604800,
                  reset_at: 1781771661
                }
              }
            }
          ]
        }),
        { status: 200 }
      );
    });

    const result = await listDesktopWorkspaceAgentProbes({
      includeUsage: true,
      providers: ["codex"],
      refresh: true,
      workspaceId: "workspace-1"
    });

    assert.equal(result.workspaceId, "workspace-1");
    assert.equal(result.providers.length, 1);
    const provider = result.providers[0];
    assert.equal(provider?.provider, "codex");
    assert.equal(provider?.availability.status, "available");
    assert.equal(provider?.usage?.accountTier, "pro");
    assert.deepEqual(provider?.usage?.quotas, [
      {
        percentRemaining: 93,
        quotaType: "weekly",
        resetsAtUnixMs: 1781182502000
      },
      {
        percentRemaining: 88,
        quotaType: "session",
        resetsAtUnixMs: 1781750585000
      },
      {
        modelName: "GPT-5.3-Codex-Spark",
        percentRemaining: 100,
        quotaType: "model",
        resetsAtUnixMs: 1781184861000
      },
      {
        modelName: "GPT-5.3-Codex-Spark",
        percentRemaining: 98,
        quotaType: "model",
        resetsAtUnixMs: 1781771661000
      }
    ]);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    setOutboundFetcherForTesting(null);
    await rm(directory, { force: true, recursive: true });
  }
});

test("listDesktopWorkspaceAgentProbes lets the server judge Claude OAuth expiry metadata", async () => {
  const previousHome = process.env.HOME;
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const directory = await mkdtemp(join(tmpdir(), "tutti-claude-usage-"));
  try {
    process.env.HOME = directory;
    process.env.CLAUDE_CONFIG_DIR = join(directory, "custom-claude-config");
    await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
    await writeFile(
      join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "claude-access-token-1",
          expiresAt: 1,
          rateLimitTier: "claude_pro",
          subscriptionType: "pro"
        }
      })
    );
    setOutboundFetcherForTesting(async (url, init) => {
      assert.equal(
        fetchInputUrl(url),
        "https://api.anthropic.com/api/oauth/usage"
      );
      const headers = new Headers(init?.headers);
      assert.equal(
        headers.get("authorization"),
        "Bearer claude-access-token-1"
      );
      assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
      assert.equal(headers.get("user-agent"), "claude-code/2.1.0");
      return new Response(
        JSON.stringify({
          five_hour: {
            utilization: 12.5,
            resets_at: "2026-06-11T12:00:00.000Z"
          },
          seven_day: {
            utilization: 30,
            resets_at: "2026-06-18T00:00:00.000Z"
          },
          extra_usage: {
            is_enabled: true,
            monthly_limit: 2050,
            used_credits: 325
          }
        }),
        { status: 200 }
      );
    });

    const result = await listDesktopWorkspaceAgentProbes({
      includeUsage: true,
      providers: ["claude-code"],
      refresh: true,
      workspaceId: "workspace-1"
    });

    assert.equal(result.providers.length, 1);
    const provider = result.providers[0];
    assert.equal(provider?.provider, "claude-code");
    assert.equal(provider?.availability.status, "available");
    assert.equal(provider?.usage?.accountTier, "pro");
    assert.deepEqual(provider?.usage?.quotas, [
      {
        percentRemaining: 87,
        quotaType: "session",
        resetsAtUnixMs: 1781179200000
      },
      {
        percentRemaining: 70,
        quotaType: "weekly",
        resetsAtUnixMs: 1781740800000
      },
      {
        dollarRemaining: 17.25,
        percentRemaining: 84,
        quotaType: "cost"
      }
    ]);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    }
    setOutboundFetcherForTesting(null);
    await rm(directory, { force: true, recursive: true });
  }
});

test("listDesktopWorkspaceAgentProbes prefers Claude macOS Keychain credentials", async () => {
  if (process.platform !== "darwin") return;
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const directory = await mkdtemp(join(tmpdir(), "tutti-claude-keychain-"));
  const keychainServices: string[] = [];
  try {
    process.env.CLAUDE_CONFIG_DIR = directory;
    await writeFile(
      join(directory, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "stale-file-token",
          expiresAt: 4102444800000
        }
      })
    );
    setClaudeOAuthKeychainReaderForTesting(async (service) => {
      keychainServices.push(service);
      return JSON.stringify({
        claudeAiOauth: {
          accessToken: "fresh-keychain-token",
          expiresAt: 4102444800000
        }
      });
    });
    setOutboundFetcherForTesting(async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer fresh-keychain-token");
      return new Response(JSON.stringify({ five_hour: { utilization: 1 } }), {
        status: 200
      });
    });

    const result = await listDesktopWorkspaceAgentProbes({
      includeUsage: true,
      providers: ["claude-code"],
      refresh: true,
      workspaceId: "workspace-1"
    });
    assert.equal(
      result.providers[0]?.attempts?.[0]?.strategy,
      "claude-oauth-keychain"
    );
    assert.match(
      keychainServices[0] ?? "",
      /^Claude Code-credentials-[0-9a-f]{8}$/
    );
  } finally {
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    }
    setClaudeOAuthKeychainReaderForTesting(null);
    setOutboundFetcherForTesting(null);
    await rm(directory, { force: true, recursive: true });
  }
});

test("listDesktopWorkspaceAgentProbes treats a Claude settings API credential as available", async () => {
  const previousHome = process.env.HOME;
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const previousAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const previousAnthropicAPIBaseUrl = process.env.ANTHROPIC_API_BASE_URL;
  const previousAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const previousAnthropicAPIKey = process.env.ANTHROPIC_API_KEY;
  const directory = await mkdtemp(join(tmpdir(), "tutti-claude-custom-api-"));
  try {
    process.env.HOME = directory;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_API_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    await mkdir(join(directory, ".claude"), { recursive: true });
    await writeFile(
      join(directory, ".claude", "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: "custom-token-1",
          ANTHROPIC_MODEL: "claude-sonnet-4-6"
        }
      })
    );
    setOutboundFetcherForTesting(async () => {
      throw new Error("custom API probe must not call Claude OAuth usage");
    });

    const result = await listDesktopWorkspaceAgentProbes({
      includeUsage: true,
      providers: ["claude-code"],
      refresh: true,
      workspaceId: "workspace-1"
    });

    const provider = result.providers[0];
    assert.equal(provider?.provider, "claude-code");
    assert.equal(provider?.availability.status, "available");
    assert.deepEqual(provider?.attempts, [
      {
        strategy: "claude-custom-api-settings",
        success: true
      }
    ]);
    assert.equal(provider?.usage?.accountTier, "custom API");
    assert.deepEqual(provider?.usage?.quotas, []);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    restoreOptionalEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
    restoreOptionalEnv("ANTHROPIC_BASE_URL", previousAnthropicBaseUrl);
    restoreOptionalEnv("ANTHROPIC_API_BASE_URL", previousAnthropicAPIBaseUrl);
    restoreOptionalEnv("ANTHROPIC_AUTH_TOKEN", previousAnthropicAuthToken);
    restoreOptionalEnv("ANTHROPIC_API_KEY", previousAnthropicAPIKey);
    setOutboundFetcherForTesting(null);
    await rm(directory, { force: true, recursive: true });
  }
});

test("listDesktopWorkspaceAgentProbes requires a Claude custom API token", async () => {
  const previousHome = process.env.HOME;
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const previousAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const previousAnthropicAPIBaseUrl = process.env.ANTHROPIC_API_BASE_URL;
  const previousAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const previousAnthropicAPIKey = process.env.ANTHROPIC_API_KEY;
  const directory = await mkdtemp(join(tmpdir(), "tutti-claude-custom-api-"));
  try {
    process.env.HOME = directory;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_API_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    await mkdir(join(directory, ".claude"), { recursive: true });
    await writeFile(
      join(directory, ".claude", "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://jp.icodeeasy.cc",
          ANTHROPIC_MODEL: "claude-sonnet-4-6"
        }
      })
    );

    const result = await listDesktopWorkspaceAgentProbes({
      includeUsage: true,
      providers: ["claude-code"],
      refresh: true,
      workspaceId: "workspace-1"
    });

    const provider = result.providers[0];
    assert.equal(provider?.provider, "claude-code");
    assert.equal(provider?.availability.status, "unavailable");
    assert.equal(provider?.lastError?.code, "auth_required");
    assert.deepEqual(provider?.attempts, [
      {
        errorCode: "auth_required",
        strategy: "claude-custom-api-settings",
        success: false
      }
    ]);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    restoreOptionalEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
    restoreOptionalEnv("ANTHROPIC_BASE_URL", previousAnthropicBaseUrl);
    restoreOptionalEnv("ANTHROPIC_API_BASE_URL", previousAnthropicAPIBaseUrl);
    restoreOptionalEnv("ANTHROPIC_AUTH_TOKEN", previousAnthropicAuthToken);
    restoreOptionalEnv("ANTHROPIC_API_KEY", previousAnthropicAPIKey);
    await rm(directory, { force: true, recursive: true });
  }
});

test("listDesktopWorkspaceAgentProbes coalesces rapid repeat usage probes", async () => {
  const previousHome = process.env.HOME;
  const directory = await mkdtemp(join(tmpdir(), "tutti-claude-throttle-"));
  let fetchCount = 0;
  const fetchStarted = deferred();
  const releaseFetch = deferred();
  try {
    process.env.HOME = directory;
    await mkdir(join(directory, ".claude"), { recursive: true });
    await writeFile(
      join(directory, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "claude-access-token-1",
          expiresAt: 4102444800000,
          subscriptionType: "pro"
        }
      })
    );
    setOutboundFetcherForTesting(async () => {
      fetchCount += 1;
      fetchStarted.resolve();
      await releaseFetch.promise;
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 10, resets_at: "2026-06-11T12:00:00.000Z" }
        }),
        { status: 200 }
      );
    });

    const input = {
      includeUsage: true,
      providers: ["claude-code"],
      refresh: true,
      workspaceId: "workspace-1"
    };
    const probes = [
      listDesktopWorkspaceAgentProbes(input),
      listDesktopWorkspaceAgentProbes(input),
      listDesktopWorkspaceAgentProbes(input)
    ] as const;
    await fetchStarted.promise;
    assert.equal(fetchCount, 1);
    releaseFetch.resolve();
    const [first, second, third] = await Promise.all(probes);

    // Three back-to-back probes must hit the vendor API only once; the rest are
    // served from the short-lived cache.
    assert.equal(fetchCount, 1);
    assert.deepEqual(
      second.providers[0]?.usage?.quotas,
      first.providers[0]?.usage?.quotas
    );
    assert.deepEqual(
      third.providers[0]?.usage?.quotas,
      first.providers[0]?.usage?.quotas
    );
  } finally {
    restoreOptionalEnv("HOME", previousHome);
    setOutboundFetcherForTesting(null);
    await rm(directory, { force: true, recursive: true });
  }
});

test("listDesktopWorkspaceAgentProbes stops re-hitting a rate-limited usage endpoint", async () => {
  const previousHome = process.env.HOME;
  const directory = await mkdtemp(join(tmpdir(), "tutti-claude-429-"));
  let fetchCount = 0;
  try {
    process.env.HOME = directory;
    await mkdir(join(directory, ".claude"), { recursive: true });
    await writeFile(
      join(directory, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "claude-access-token-1",
          expiresAt: 4102444800000,
          subscriptionType: "pro"
        }
      })
    );
    setOutboundFetcherForTesting(async () => {
      fetchCount += 1;
      return new Response("", { status: 429 });
    });

    const input = {
      includeUsage: true,
      providers: ["claude-code"],
      refresh: true,
      workspaceId: "workspace-1"
    };
    const first = await listDesktopWorkspaceAgentProbes(input);
    await listDesktopWorkspaceAgentProbes(input);
    await listDesktopWorkspaceAgentProbes(input);

    // The 429 is surfaced once, then the cooldown suppresses further calls to
    // the already-limited endpoint.
    assert.equal(fetchCount, 1);
    assert.equal(first.providers[0]?.lastError?.code, "rate_limited");
  } finally {
    restoreOptionalEnv("HOME", previousHome);
    setOutboundFetcherForTesting(null);
    await rm(directory, { force: true, recursive: true });
  }
});

test("desktopAgentUsageProbeLogLevel warns on a real usage fetch failure", () => {
  assert.equal(desktopAgentUsageProbeLogLevel(0, "session_expired"), "warn");
  assert.equal(desktopAgentUsageProbeLogLevel(0, "execution_failed"), "warn");
  // Even if a stale quota lingered, an error code still means the fetch failed.
  assert.equal(desktopAgentUsageProbeLogLevel(2, "parse_failed"), "warn");
});

test("desktopAgentUsageProbeLogLevel flags an empty-but-not-errored result", () => {
  assert.equal(desktopAgentUsageProbeLogLevel(0, null), "info");
});

test("desktopAgentUsageProbeLogLevel stays quiet for normal or unsupported results", () => {
  assert.equal(desktopAgentUsageProbeLogLevel(2, null), "debug");
  assert.equal(desktopAgentUsageProbeLogLevel(0, "unsupported"), "debug");
});

function restoreOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
