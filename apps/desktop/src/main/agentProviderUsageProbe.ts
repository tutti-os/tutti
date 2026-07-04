import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentProviderProbeListInput,
  AgentProviderProbeListResult,
  AgentProbeProvider,
  AgentUsageQuota
} from "@tutti-os/agent-gui";

import { outboundFetch } from "./net/outboundFetch.ts";

const CODEX_DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/";
const CODEX_CHATGPT_USAGE_PATH = "/wham/usage";
const CODEX_API_USAGE_PATH = "/api/codex/usage";
const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const execFileAsync = promisify(execFile);

interface CodexCredentials {
  accessToken: string;
  accountId: string | null;
}

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

interface CodexUsageResponse {
  plan_type?: unknown;
  rate_limit?: {
    primary_window?: CodexUsageWindow | null;
    secondary_window?: CodexUsageWindow | null;
  } | null;
  additional_rate_limits?: CodexAdditionalRateLimit[] | null;
}

interface CodexAdditionalRateLimit {
  limit_name?: unknown;
  metered_feature?: unknown;
  rate_limit?: {
    primary_window?: CodexUsageWindow | null;
    secondary_window?: CodexUsageWindow | null;
  } | null;
}

interface CodexUsageWindow {
  used_percent?: unknown;
  reset_at?: unknown;
  limit_window_seconds?: unknown;
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
  currency?: unknown;
}

export async function listDesktopWorkspaceAgentProbes(
  input: AgentProviderProbeListInput
): Promise<AgentProviderProbeListResult> {
  const capturedAtUnixMs = Date.now();
  const providers = normalizeProbeProviders(input.providers);
  const results = await Promise.all(
    providers.map((provider) =>
      probeDesktopAgentProvider(provider, input, capturedAtUnixMs)
    )
  );
  return {
    capturedAtUnixMs,
    providers: results,
    roomId: input.roomId,
    workspaceId: input.workspaceId
  };
}

function normalizeProbeProviders(providers: readonly string[] | undefined) {
  const normalized = (providers ?? ["codex", "claude-code"])
    .map((provider) => provider.trim())
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

async function probeDesktopAgentProvider(
  provider: string,
  input: AgentProviderProbeListInput,
  capturedAtUnixMs: number
): Promise<AgentProbeProvider> {
  if (provider === "codex") {
    return probeCodexProvider(input, capturedAtUnixMs);
  }
  if (provider === "claude-code") {
    return probeClaudeCodeProvider(input, capturedAtUnixMs);
  }
  return {
    availability: {
      detailsVisible: false,
      status: "unknown"
    },
    lastError: input.includeUsage
      ? {
          code: "unsupported"
        }
      : undefined,
    provider
  };
}

async function probeClaudeCodeProvider(
  input: AgentProviderProbeListInput,
  capturedAtUnixMs: number
): Promise<AgentProbeProvider> {
  const attempts: AgentProbeProvider["attempts"] = [];
  const customSettings = await loadClaudeCustomAPISettings();
  if (customSettings) {
    const strategy = `claude-custom-api-${customSettings.source}`;
    if (!customSettings.authToken) {
      return {
        attempts: [
          {
            errorCode: "auth_required",
            strategy,
            success: false
          }
        ],
        availability: {
          checks: [{ name: "auth", passed: false }],
          detailsVisible: false,
          status: "unavailable"
        },
        lastError: {
          code: "auth_required"
        },
        provider: "claude-code"
      };
    }
    return {
      attempts: [
        {
          strategy,
          success: true
        }
      ],
      availability: {
        checks: [{ name: "auth", passed: true }],
        detailsVisible: false,
        status: "available"
      },
      provider: "claude-code",
      usage: input.includeUsage
        ? {
            accountTier: "custom API",
            capturedAtUnixMs,
            quotas: []
          }
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
    return {
      attempts: [
        {
          errorCode: "auth_required",
          errorMessage: errorMessage(error),
          strategy: "claude-oauth-credentials",
          success: false
        }
      ],
      availability: {
        checks: [
          {
            detail: errorMessage(error),
            name: "auth",
            passed: false
          }
        ],
        detailsVisible: true,
        status: "unavailable"
      },
      lastError: {
        code: "auth_required",
        message: errorMessage(error)
      },
      provider: "claude-code"
    };
  }

  if (!input.includeUsage) {
    return {
      attempts,
      availability: {
        checks: [{ name: "auth", passed: true }],
        detailsVisible: false,
        status: "available"
      },
      provider: "claude-code"
    };
  }

  try {
    const response = await fetchClaudeOAuthUsage(credentials);
    attempts.push({ strategy: "claude-oauth-usage", success: true });
    return {
      attempts,
      availability: {
        checks: [{ name: "auth", passed: true }],
        detailsVisible: false,
        status: "available"
      },
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
    attempts.push({
      errorCode: claudeProbeErrorCode(error),
      errorMessage: errorMessage(error),
      strategy: "claude-oauth-usage",
      success: false
    });
    return {
      attempts,
      availability: {
        checks: [{ name: "auth", passed: true }],
        detailsVisible: false,
        status: "available"
      },
      lastError: {
        code: claudeProbeErrorCode(error),
        message: errorMessage(error)
      },
      provider: "claude-code"
    };
  }
}

async function probeCodexProvider(
  input: AgentProviderProbeListInput,
  capturedAtUnixMs: number
): Promise<AgentProbeProvider> {
  const attempts: AgentProbeProvider["attempts"] = [];
  let credentials: CodexCredentials;
  try {
    credentials = await loadCodexCredentials();
  } catch (error) {
    return {
      attempts: [
        {
          errorCode: "auth_required",
          errorMessage: errorMessage(error),
          strategy: "codex-auth-json",
          success: false
        }
      ],
      availability: {
        checks: [
          {
            detail: errorMessage(error),
            name: "auth",
            passed: false
          }
        ],
        detailsVisible: true,
        status: "unavailable"
      },
      lastError: {
        code: "auth_required",
        message: errorMessage(error)
      },
      provider: "codex"
    };
  }

  if (!input.includeUsage) {
    return {
      availability: {
        checks: [{ name: "auth", passed: true }],
        detailsVisible: false,
        status: "available"
      },
      provider: "codex"
    };
  }

  try {
    const response = await fetchCodexUsage(credentials);
    attempts.push({ strategy: "codex-oauth-usage", success: true });
    return {
      attempts,
      availability: {
        checks: [{ name: "auth", passed: true }],
        detailsVisible: false,
        status: "available"
      },
      provider: "codex",
      usage: {
        accountTier: stringValue(response.plan_type) || undefined,
        capturedAtUnixMs,
        quotas: codexUsageQuotas(response)
      }
    };
  } catch (error) {
    attempts.push({
      errorCode: codexProbeErrorCode(error),
      errorMessage: errorMessage(error),
      strategy: "codex-oauth-usage",
      success: false
    });
    return {
      attempts,
      availability: {
        checks: [{ name: "auth", passed: true }],
        detailsVisible: false,
        status: "available"
      },
      lastError: {
        code: codexProbeErrorCode(error),
        message: errorMessage(error)
      },
      provider: "codex"
    };
  }
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
    const content = await readFile(
      join(
        process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
        "settings.json"
      ),
      "utf8"
    );
    const parsed = JSON.parse(content) as ClaudeSettingsFile;
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

async function loadCodexCredentials(): Promise<CodexCredentials> {
  const authPath = join(
    process.env.CODEX_HOME || join(homedir(), ".codex"),
    "auth.json"
  );
  const content = await readFile(authPath, "utf8");
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const tokens = objectValue(parsed.tokens);
  const accessToken =
    stringValue(parsed.OPENAI_API_KEY) ||
    stringValue(tokens?.access_token) ||
    stringValue(tokens?.accessToken);
  if (!accessToken) {
    throw new Error("Codex auth.json does not contain an access token.");
  }
  return {
    accessToken,
    accountId:
      stringValue(tokens?.account_id) || stringValue(tokens?.accountId) || null
  };
}

async function loadClaudeOAuthCredentials(): Promise<ClaudeOAuthCredentials> {
  const fileError: unknown[] = [];
  try {
    return parseClaudeOAuthCredentials(
      await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8"),
      "credentials-file"
    );
  } catch (error) {
    fileError.push(error);
  }

  if (process.platform === "darwin") {
    try {
      return parseClaudeOAuthCredentials(
        await readClaudeOAuthCredentialsFromKeychain(),
        "keychain"
      );
    } catch (error) {
      fileError.push(error);
    }
  }

  const expired = fileError.find((error) =>
    errorMessage(error).toLowerCase().includes("expired")
  );
  if (expired) {
    throw expired instanceof Error ? expired : new Error(errorMessage(expired));
  }
  throw new Error("Claude OAuth credentials were not found.");
}

function parseClaudeOAuthCredentials(
  content: string,
  source: ClaudeOAuthCredentials["source"]
): ClaudeOAuthCredentials {
  const parsed = JSON.parse(content) as ClaudeOAuthCredentialsFile;
  const oauth = parsed.claudeAiOauth;
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
    {
      timeout: 10_000,
      windowsHide: true
    }
  );
  const content = stdout.trim();
  if (!content) {
    throw new Error("Claude keychain credentials were empty.");
  }
  return content;
}

async function fetchCodexUsage(
  credentials: CodexCredentials
): Promise<CodexUsageResponse> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${credentials.accessToken}`,
    "User-Agent": "Tutti"
  };
  if (credentials.accountId) {
    headers["ChatGPT-Account-Id"] = credentials.accountId;
  }
  const response = await outboundFetch(await resolveCodexUsageUrl(), {
    headers
  });
  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new Error("Codex OAuth token is expired or unauthorized.");
  }
  if (!response.ok) {
    throw new Error(`Codex usage API returned HTTP ${response.status}.`);
  }
  try {
    return JSON.parse(text) as CodexUsageResponse;
  } catch {
    throw new Error("Codex usage API returned invalid JSON.");
  }
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

async function resolveCodexUsageUrl(): Promise<string> {
  const baseUrl = normalizeCodexChatGPTBaseUrl(
    (await readCodexChatGPTBaseUrlFromConfig()) ??
      CODEX_DEFAULT_CHATGPT_BASE_URL
  );
  const path = baseUrl.includes("/backend-api")
    ? CODEX_CHATGPT_USAGE_PATH
    : CODEX_API_USAGE_PATH;
  return `${baseUrl}${path}`;
}

async function readCodexChatGPTBaseUrlFromConfig(): Promise<string | null> {
  try {
    const configPath = join(
      process.env.CODEX_HOME || join(homedir(), ".codex"),
      "config.toml"
    );
    const content = await readFile(configPath, "utf8");
    for (const rawLine of content.split(/\r?\n/u)) {
      const line = rawLine.split("#", 1)[0]?.trim() ?? "";
      const match = /^chatgpt_base_url\s*=\s*(.+)$/u.exec(line);
      if (!match) {
        continue;
      }
      return match[1]?.trim().replace(/^["']|["']$/gu, "") || null;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeCodexChatGPTBaseUrl(value: string): string {
  let normalized = value.trim() || CODEX_DEFAULT_CHATGPT_BASE_URL;
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (
    (normalized.startsWith("https://chatgpt.com") ||
      normalized.startsWith("https://chat.openai.com")) &&
    !normalized.includes("/backend-api")
  ) {
    normalized += "/backend-api";
  }
  return normalized;
}

function codexUsageQuotas(response: CodexUsageResponse): AgentUsageQuota[] {
  const quotas: AgentUsageQuota[] = [];
  const primary = codexUsageWindowToQuota(
    response.rate_limit?.primary_window,
    "session"
  );
  if (primary) {
    quotas.push(primary);
  }
  const secondary = codexUsageWindowToQuota(
    response.rate_limit?.secondary_window,
    "weekly"
  );
  if (secondary) {
    quotas.push(secondary);
  }
  for (const extra of response.additional_rate_limits ?? []) {
    quotas.push(...codexAdditionalRateLimitQuotas(extra));
  }
  return quotas;
}

function codexAdditionalRateLimitQuotas(
  limit: CodexAdditionalRateLimit
): AgentUsageQuota[] {
  const modelName =
    stringValue(limit.limit_name) || stringValue(limit.metered_feature);
  const primary = codexUsageWindowToQuota(
    limit.rate_limit?.primary_window,
    "model",
    modelName
  );
  const secondary = codexUsageWindowToQuota(
    limit.rate_limit?.secondary_window,
    "model",
    modelName
  );
  return [primary, secondary].filter(
    (quota): quota is AgentUsageQuota => quota !== null
  );
}

function codexUsageWindowToQuota(
  window: CodexUsageWindow | null | undefined,
  quotaType: AgentUsageQuota["quotaType"],
  modelName?: string
): AgentUsageQuota | null {
  const usedPercent = numberValue(window?.used_percent);
  if (usedPercent === null) {
    return null;
  }
  const resetAt = numberValue(window?.reset_at);
  const quota: AgentUsageQuota = {
    percentRemaining: Math.max(0, Math.min(100, 100 - Math.round(usedPercent))),
    quotaType
  };
  if (resetAt !== null && resetAt > 0) {
    quota.resetsAtUnixMs = resetAt * 1000;
  }
  if (modelName) {
    quota.modelName = modelName;
  }
  return quota;
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
  if (primary) {
    quotas.push(primary);
  }
  const weekly = claudeOAuthUsageWindowToQuota(response.seven_day, "weekly");
  if (weekly && primary?.quotaType !== "weekly") {
    quotas.push(weekly);
  }
  const cost = claudeOAuthExtraUsageToQuota(response.extra_usage);
  if (cost) {
    quotas.push(cost);
  }
  return quotas;
}

function claudeOAuthUsageWindowToQuota(
  window: ClaudeOAuthUsageWindow | null | undefined,
  quotaType: AgentUsageQuota["quotaType"]
): AgentUsageQuota | null {
  const utilization = numberValue(window?.utilization);
  if (utilization === null) {
    return null;
  }
  const quota: AgentUsageQuota = {
    percentRemaining: Math.max(0, Math.min(100, 100 - Math.round(utilization))),
    quotaType
  };
  const reset = stringValue(window?.resets_at);
  if (reset) {
    const resetUnixMs = Date.parse(reset);
    if (Number.isFinite(resetUnixMs)) {
      quota.resetsAtUnixMs = resetUnixMs;
    } else {
      quota.resetText = reset;
    }
  }
  return quota;
}

function claudeOAuthExtraUsageToQuota(
  extra: ClaudeOAuthExtraUsage | null | undefined
): AgentUsageQuota | null {
  if (extra?.is_enabled !== true) {
    return null;
  }
  const monthlyLimit = numberValue(extra.monthly_limit);
  const usedCredits = numberValue(extra.used_credits);
  if (monthlyLimit === null || usedCredits === null || monthlyLimit <= 0) {
    return null;
  }
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
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function codexProbeErrorCode(error: unknown): string {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("unauthorized") || message.includes("expired")) {
    return "session_expired";
  }
  if (message.includes("json")) {
    return "parse_failed";
  }
  return "execution_failed";
}

function claudeProbeErrorCode(error: unknown): string {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("unauthorized") || message.includes("expired")) {
    return "session_expired";
  }
  if (message.includes("rate limited")) {
    return "execution_failed";
  }
  if (message.includes("json")) {
    return "parse_failed";
  }
  return "execution_failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
