import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentProviderProbeListInput,
  AgentProbeProvider,
  AgentUsageQuota
} from "@tutti-os/agent-gui";

import { outboundFetch } from "./net/outboundFetch.ts";

const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const execFileAsync = promisify(execFile);

interface ClaudeOAuthCredentials {
  accessToken: string;
  source: "credentials-file" | "keychain";
  rateLimitTier?: string;
  subscriptionType?: string;
}

interface ClaudeCustomAPISettings {
  authToken: string;
  source: "env" | "settings";
}

interface ClaudeOAuthCredentialsFile {
  claudeAiOauth?: {
    accessToken?: unknown;
    expiresAt?: unknown;
    rateLimitTier?: unknown;
    subscriptionType?: unknown;
  } | null;
}

interface ClaudeSettingsFile {
  env?: Record<string, unknown> | null;
}

interface ClaudeOAuthUsageResponse {
  five_hour?: ClaudeOAuthUsageWindow | null;
  seven_day?: ClaudeOAuthUsageWindow | null;
  seven_day_oauth_apps?: ClaudeOAuthUsageWindow | null;
  seven_day_sonnet?: ClaudeOAuthUsageWindow | null;
  seven_day_opus?: ClaudeOAuthUsageWindow | null;
  extra_usage?: ClaudeOAuthExtraUsage | null;
}

interface ClaudeOAuthUsageWindow {
  utilization?: unknown;
  resets_at?: unknown;
}

interface ClaudeOAuthExtraUsage {
  is_enabled?: unknown;
  monthly_limit?: unknown;
  used_credits?: unknown;
  utilization?: unknown;
}

export async function probeClaudeCodeProvider(
  input: AgentProviderProbeListInput,
  capturedAtUnixMs: number
): Promise<AgentProbeProvider> {
  const attempts: AgentProbeProvider["attempts"] = [];
  const customSettings = await loadClaudeCustomAPISettings();
  if (customSettings) {
    const strategy = `claude-custom-api-${customSettings.source}`;
    if (!customSettings.authToken) {
      return unavailableClaudeProbe(strategy);
    }
    return {
      attempts: [{ strategy, success: true }],
      availability: availableClaudeStatus(),
      provider: "claude-code",
      usage: input.includeUsage
        ? { accountTier: "custom API", capturedAtUnixMs, quotas: [] }
        : undefined
    };
  }

  let credentials: ClaudeOAuthCredentials;
  try {
    credentials = await loadClaudeOAuthCredentials();
    attempts.push({
      strategy: `claude-oauth-${credentials.source}`,
      success: true
    });
  } catch (error) {
    const message = errorMessage(error);
    return {
      attempts: [
        {
          errorCode: "auth_required",
          errorMessage: message,
          strategy: "claude-oauth-credentials",
          success: false
        }
      ],
      availability: {
        checks: [{ detail: message, name: "auth", passed: false }],
        detailsVisible: true,
        status: "unavailable"
      },
      lastError: { code: "auth_required", message },
      provider: "claude-code"
    };
  }

  if (!input.includeUsage) {
    return {
      attempts,
      availability: availableClaudeStatus(),
      provider: "claude-code"
    };
  }

  try {
    const response = await fetchClaudeOAuthUsage(credentials);
    attempts.push({ strategy: "claude-oauth-usage", success: true });
    return {
      attempts,
      availability: availableClaudeStatus(),
      provider: "claude-code",
      usage: {
        accountTier:
          credentials.subscriptionType ||
          credentials.rateLimitTier ||
          undefined,
        capturedAtUnixMs,
        quotas: claudeOAuthUsageQuotas(response)
      }
    };
  } catch (error) {
    const code = claudeProbeErrorCode(error);
    const message = errorMessage(error);
    attempts.push({
      errorCode: code,
      errorMessage: message,
      strategy: "claude-oauth-usage",
      success: false
    });
    return {
      attempts,
      availability: availableClaudeStatus(),
      lastError: { code, message },
      provider: "claude-code"
    };
  }
}

function availableClaudeStatus(): AgentProbeProvider["availability"] {
  return {
    checks: [{ name: "auth", passed: true }],
    detailsVisible: false,
    status: "available"
  };
}

function unavailableClaudeProbe(strategy: string): AgentProbeProvider {
  return {
    attempts: [{ errorCode: "auth_required", strategy, success: false }],
    availability: {
      checks: [{ name: "auth", passed: false }],
      detailsVisible: false,
      status: "unavailable"
    },
    lastError: { code: "auth_required" },
    provider: "claude-code"
  };
}

async function loadClaudeCustomAPISettings(): Promise<ClaudeCustomAPISettings | null> {
  const envBaseUrl =
    stringValue(process.env.ANTHROPIC_BASE_URL) ||
    stringValue(process.env.ANTHROPIC_API_BASE_URL);
  if (envBaseUrl) {
    return {
      authToken:
        stringValue(process.env.ANTHROPIC_AUTH_TOKEN) ||
        stringValue(process.env.ANTHROPIC_API_KEY),
      source: "env"
    };
  }

  try {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    const parsed = JSON.parse(
      await readFile(join(configDir, "settings.json"), "utf8")
    ) as ClaudeSettingsFile;
    const settingsEnv = objectValue(parsed.env);
    const baseUrl =
      stringValue(settingsEnv?.ANTHROPIC_BASE_URL) ||
      stringValue(settingsEnv?.ANTHROPIC_API_BASE_URL);
    if (!baseUrl) {
      return null;
    }
    return {
      authToken:
        stringValue(settingsEnv?.ANTHROPIC_AUTH_TOKEN) ||
        stringValue(settingsEnv?.ANTHROPIC_API_KEY),
      source: "settings"
    };
  } catch {
    return null;
  }
}

async function loadClaudeOAuthCredentials(): Promise<ClaudeOAuthCredentials> {
  const errors: unknown[] = [];
  if (process.platform === "darwin") {
    try {
      return parseClaudeOAuthCredentials(
        await claudeOAuthKeychainReader(),
        "keychain"
      );
    } catch (error) {
      errors.push(error);
    }
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  try {
    return parseClaudeOAuthCredentials(
      await readFile(join(configDir, ".credentials.json"), "utf8"),
      "credentials-file"
    );
  } catch (error) {
    errors.push(error);
  }
  const expired = errors.find((error) =>
    errorMessage(error).toLowerCase().includes("expired")
  );
  if (expired) {
    throw expired instanceof Error ? expired : new Error(errorMessage(expired));
  }
  throw new Error("Claude OAuth credentials were not found.");
}

let claudeOAuthKeychainReader = readClaudeOAuthCredentialsFromKeychain;

export function setClaudeOAuthKeychainReaderForTesting(
  reader: (() => Promise<string>) | null
): void {
  claudeOAuthKeychainReader = reader ?? readClaudeOAuthCredentialsFromKeychain;
}

function parseClaudeOAuthCredentials(
  content: string,
  source: ClaudeOAuthCredentials["source"]
): ClaudeOAuthCredentials {
  const oauth = (JSON.parse(content) as ClaudeOAuthCredentialsFile)
    .claudeAiOauth;
  const accessToken = stringValue(oauth?.accessToken);
  if (!accessToken) {
    throw new Error("Claude OAuth credentials do not contain an access token.");
  }
  const expiresAt = numberValue(oauth?.expiresAt);
  if (expiresAt !== null && expiresAt > 0 && expiresAt <= Date.now()) {
    throw new Error("Claude OAuth access token is expired.");
  }
  return {
    accessToken,
    rateLimitTier: stringValue(oauth?.rateLimitTier) || undefined,
    source,
    subscriptionType: stringValue(oauth?.subscriptionType) || undefined
  };
}

async function readClaudeOAuthCredentialsFromKeychain(): Promise<string> {
  const { stdout } = await execFileAsync(
    "/usr/bin/security",
    ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
    { timeout: 10_000, windowsHide: true }
  );
  const content = stdout.trim();
  if (!content) {
    throw new Error("Claude keychain credentials were empty.");
  }
  return content;
}

async function fetchClaudeOAuthUsage(
  credentials: ClaudeOAuthCredentials
): Promise<ClaudeOAuthUsageResponse> {
  const response = await outboundFetch(CLAUDE_OAUTH_USAGE_URL, {
    headers: {
      Accept: "application/json",
      "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
      Authorization: `Bearer ${credentials.accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "claude-code/2.1.0"
    }
  });
  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new Error("Claude OAuth token is expired or unauthorized.");
  }
  if (response.status === 429) {
    throw new Error("Claude OAuth usage API is rate limited.");
  }
  if (!response.ok) {
    throw new Error(`Claude OAuth usage API returned HTTP ${response.status}.`);
  }
  try {
    return JSON.parse(text) as ClaudeOAuthUsageResponse;
  } catch {
    throw new Error("Claude OAuth usage API returned invalid JSON.");
  }
}

function claudeOAuthUsageQuotas(
  response: ClaudeOAuthUsageResponse
): AgentUsageQuota[] {
  const quotas: AgentUsageQuota[] = [];
  const primary =
    claudeOAuthUsageWindowToQuota(response.five_hour, "session") ??
    claudeOAuthUsageWindowToQuota(response.seven_day, "weekly") ??
    claudeOAuthUsageWindowToQuota(response.seven_day_oauth_apps, "weekly") ??
    claudeOAuthUsageWindowToQuota(response.seven_day_sonnet, "weekly") ??
    claudeOAuthUsageWindowToQuota(response.seven_day_opus, "weekly");
  if (primary) quotas.push(primary);
  const weekly = claudeOAuthUsageWindowToQuota(response.seven_day, "weekly");
  if (weekly && primary?.quotaType !== "weekly") quotas.push(weekly);
  const cost = claudeOAuthExtraUsageToQuota(response.extra_usage);
  if (cost) quotas.push(cost);
  return quotas;
}

function claudeOAuthUsageWindowToQuota(
  window: ClaudeOAuthUsageWindow | null | undefined,
  quotaType: AgentUsageQuota["quotaType"]
): AgentUsageQuota | null {
  const utilization = numberValue(window?.utilization);
  if (utilization === null) return null;
  const quota: AgentUsageQuota = {
    percentRemaining: Math.max(0, Math.min(100, 100 - Math.round(utilization))),
    quotaType
  };
  const reset = stringValue(window?.resets_at);
  if (reset) {
    const resetUnixMs = Date.parse(reset);
    if (Number.isFinite(resetUnixMs)) quota.resetsAtUnixMs = resetUnixMs;
    else quota.resetText = reset;
  }
  return quota;
}

function claudeOAuthExtraUsageToQuota(
  extra: ClaudeOAuthExtraUsage | null | undefined
): AgentUsageQuota | null {
  if (extra?.is_enabled !== true) return null;
  const monthlyLimit = numberValue(extra.monthly_limit);
  const usedCredits = numberValue(extra.used_credits);
  if (monthlyLimit === null || usedCredits === null || monthlyLimit <= 0)
    return null;
  const utilization =
    numberValue(extra.utilization) ?? (usedCredits / monthlyLimit) * 100;
  return {
    dollarRemaining: Math.max(0, (monthlyLimit - usedCredits) / 100),
    percentRemaining: Math.max(0, Math.min(100, 100 - Math.round(utilization))),
    quotaType: "cost"
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function claudeProbeErrorCode(error: unknown): string {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("unauthorized") || message.includes("expired")) {
    return "session_expired";
  }
  if (message.includes("json")) return "parse_failed";
  return "execution_failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
