import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listDesktopWorkspaceAgentProbes } from "./agentProviderUsageProbe.ts";
import { setOutboundFetcherForTesting } from "./net/outboundFetch.ts";

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
              limit_window_seconds: 18000,
              reset_at: 1781182502
            },
            secondary_window: {
              used_percent: 12,
              limit_window_seconds: 604800,
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
        quotaType: "session",
        resetsAtUnixMs: 1781182502000
      },
      {
        percentRemaining: 88,
        quotaType: "weekly",
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

test("listDesktopWorkspaceAgentProbes maps Claude Code OAuth usage windows", async () => {
  const previousHome = process.env.HOME;
  const directory = await mkdtemp(join(tmpdir(), "tutti-claude-usage-"));
  try {
    process.env.HOME = directory;
    await mkdir(join(directory, ".claude"), { recursive: true });
    await writeFile(
      join(directory, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "claude-access-token-1",
          expiresAt: 4102444800000,
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
    setOutboundFetcherForTesting(null);
    await rm(directory, { force: true, recursive: true });
  }
});

test("listDesktopWorkspaceAgentProbes treats Claude custom API settings as available", async () => {
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
          ANTHROPIC_BASE_URL: "https://jp.icodeeasy.cc",
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
