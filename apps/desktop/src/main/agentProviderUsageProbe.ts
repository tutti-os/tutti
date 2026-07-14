import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentProviderProbeListInput,
  AgentProviderProbeListResult,
  AgentProbeProvider,
  AgentUsageQuota
} from "@tutti-os/agent-gui";
import {
  migratedAgentGUIProviderIdentityCatalog,
  resolveAgentGUIProviderCatalogIdentity
} from "@tutti-os/agent-gui/provider-catalog";

import { getDesktopLogger } from "./logging.ts";
import { outboundFetch } from "./net/outboundFetch.ts";
import { probeClaudeCodeProvider } from "./claudeProviderUsageProbe.ts";
export { setClaudeOAuthKeychainReaderForTesting } from "./claudeProviderUsageProbe.ts";

const CODEX_DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/";
const CODEX_CHATGPT_USAGE_PATH = "/wham/usage";
const CODEX_API_USAGE_PATH = "/api/codex/usage";
const CODEX_SESSION_USAGE_WINDOW_SECONDS = 5 * 60 * 60;
const CODEX_WEEKLY_USAGE_WINDOW_SECONDS = 7 * 24 * 60 * 60;

interface CodexCredentials {
  accessToken: string;
  accountId: string | null;
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
  const defaults = migratedAgentGUIProviderIdentityCatalog
    .filter((entry) => entry.desktop.usageProbeKind !== "")
    .map((entry) => entry.providerId);
  const normalized = (providers ?? defaults)
    .map(
      (provider) =>
        resolveAgentGUIProviderCatalogIdentity(provider)?.providerId ??
        provider.trim()
    )
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

// Coalesce rapid repeat usage probes so window mounts, menu opens, hover
// tooltips and manual refresh clicks don't each hit the vendor account API.
const USAGE_PROBE_CACHE_TTL_MS = 10_000;
// After a rate-limit (HTTP 429) response, stop calling the endpoint for this
// long so it can recover instead of being hammered by continued retries.
const USAGE_PROBE_RATE_LIMIT_COOLDOWN_MS = 60_000;

interface UsageProbeCacheEntry {
  result: AgentProbeProvider;
  fetchedAtMs: number;
  /** Do not re-fetch before this time (set after a 429). 0 when not cooling. */
  retryNotBeforeMs: number;
}

const usageProbeCacheByProvider = new Map<string, UsageProbeCacheEntry>();

/** Test hook: clears the per-provider usage probe cache between cases. */
export function resetUsageProbeCacheForTesting(): void {
  usageProbeCacheByProvider.clear();
}

function isRateLimitedProbeResult(result: AgentProbeProvider): boolean {
  const message = (result.lastError?.message ?? "").toLowerCase();
  return message.includes("rate limit") || message.includes("429");
}

async function probeDesktopAgentProvider(
  provider: string,
  input: AgentProviderProbeListInput,
  capturedAtUnixMs: number
): Promise<AgentProbeProvider> {
  // Availability-only probes are cheap, differently shaped, and not what
  // rate-limits the account API — never cache them.
  if (!input.includeUsage) {
    return resolveDesktopAgentProbe(provider, input, capturedAtUnixMs);
  }

  const cached = usageProbeCacheByProvider.get(provider);
  if (cached) {
    const freshEnough =
      capturedAtUnixMs - cached.fetchedAtMs < USAGE_PROBE_CACHE_TTL_MS;
    const coolingDown = capturedAtUnixMs < cached.retryNotBeforeMs;
    if (freshEnough || coolingDown) {
      // Reuse the previous probe rather than re-hitting an endpoint that itself
      // rate-limits. This is what stops a storm of "Claude OAuth usage API is
      // rate limited" (429) failures when the limits popover is opened/refreshed
      // repeatedly, and the 429 cooldown gives the endpoint time to recover.
      if (coolingDown && !freshEnough) {
        getDesktopLogger().debug("agent usage probe held during 429 cooldown", {
          event: "agent.usage_probe.cooldown",
          provider,
          workspaceId: input.workspaceId,
          retryInMs: cached.retryNotBeforeMs - capturedAtUnixMs
        });
      }
      return cached.result;
    }
  }

  const result = await resolveDesktopAgentProbe(
    provider,
    input,
    capturedAtUnixMs
  );
  logDesktopAgentUsageProbeOutcome(provider, input, result);
  usageProbeCacheByProvider.set(provider, {
    result,
    fetchedAtMs: capturedAtUnixMs,
    retryNotBeforeMs: isRateLimitedProbeResult(result)
      ? capturedAtUnixMs + USAGE_PROBE_RATE_LIMIT_COOLDOWN_MS
      : 0
  });
  return result;
}

async function resolveDesktopAgentProbe(
  provider: string,
  input: AgentProviderProbeListInput,
  capturedAtUnixMs: number
): Promise<AgentProbeProvider> {
  const probeKind =
    resolveAgentGUIProviderCatalogIdentity(provider)?.desktop.usageProbeKind ??
    "";
  const handler = desktopAgentUsageProbeHandlers.get(probeKind);
  if (handler) {
    return handler(input, capturedAtUnixMs);
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

type DesktopAgentUsageProbeHandler = (
  input: AgentProviderProbeListInput,
  capturedAtUnixMs: number
) => Promise<AgentProbeProvider>;

const desktopAgentUsageProbeHandlers = new Map<
  string,
  DesktopAgentUsageProbeHandler
>([
  ["codex", probeCodexProvider],
  ["claude_code", probeClaudeCodeProvider]
]);

// The usage probe runs in the Electron main process and hits the vendor account
// API directly, catching every failure into `lastError` so `.list()` always
// resolves. That kept the renderer quiet, but it also meant a failed or empty
// Claude/Codex usage fetch left no trace anywhere — a "usage disappeared" report
// had zero corresponding log lines. Emit one structured line per usage probe so
// the outcome (and the reason it produced no quotas) is diagnosable. No secrets
// are included: the provider result carries error codes/messages and strategy
// names only, never tokens.
function logDesktopAgentUsageProbeOutcome(
  provider: string,
  input: AgentProviderProbeListInput,
  result: AgentProbeProvider
): void {
  if (!input.includeUsage) {
    return;
  }
  const quotaCount = result.usage?.quotas?.length ?? 0;
  const usageErrorCode = result.lastError?.code ?? null;
  const level = desktopAgentUsageProbeLogLevel(quotaCount, usageErrorCode);
  const fields: Record<string, unknown> = {
    event: "agent.usage_probe.result",
    provider,
    workspaceId: input.workspaceId,
    availability: result.availability.status,
    quotaCount,
    usageErrorCode,
    usageErrorMessage: result.lastError?.message ?? null,
    attempts: (result.attempts ?? []).map((attempt) => ({
      strategy: attempt.strategy,
      success: attempt.success,
      errorCode: attempt.errorCode ?? null,
      errorMessage: attempt.errorMessage ?? null
    }))
  };
  const logger = getDesktopLogger();
  if (level === "warn") {
    logger.warn("agent usage probe failed", fields);
    return;
  }
  if (level === "info") {
    logger.info("agent usage probe returned no quotas", fields);
    return;
  }
  logger.debug("agent usage probe resolved", fields);
}

/**
 * Severity for a usage-probe outcome line:
 * - "warn": a real fetch failure (expired/invalid credentials, rate limiting,
 *   a non-2xx HTTP status, invalid JSON). Actionable.
 * - "info": resolved without error but produced no displayable quotas (a usage
 *   response with no rate-limit windows, or a custom-API account with no
 *   subscription limits). Explains an empty limits UI.
 * - "debug": usage present, or a provider that simply has no usage concept
 *   ("unsupported").
 */
export function desktopAgentUsageProbeLogLevel(
  quotaCount: number,
  usageErrorCode: string | null
): "warn" | "info" | "debug" {
  if (usageErrorCode === "unsupported") {
    return "debug";
  }
  if (usageErrorCode) {
    return "warn";
  }
  return quotaCount === 0 ? "info" : "debug";
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
  const primaryWindow = response.rate_limit?.primary_window;
  const primary = codexUsageWindowToQuota(
    primaryWindow,
    codexUsageQuotaType(primaryWindow, "session")
  );
  if (primary) {
    quotas.push(primary);
  }
  const secondaryWindow = response.rate_limit?.secondary_window;
  const secondary = codexUsageWindowToQuota(
    secondaryWindow,
    codexUsageQuotaType(secondaryWindow, "weekly")
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

// Keep duration semantics aligned with appServerRateLimitQuotaType in
// packages/agent/daemon/runtime/codex_appserver_event_state.go. Empty-session
// /status uses this desktop probe; active sessions use the daemon mapper.
function codexUsageQuotaType(
  window: CodexUsageWindow | null | undefined,
  fallback: AgentUsageQuota["quotaType"]
): AgentUsageQuota["quotaType"] {
  const durationSeconds = numberValue(window?.limit_window_seconds);
  switch (durationSeconds) {
    case CODEX_SESSION_USAGE_WINDOW_SECONDS:
      return "session";
    case CODEX_WEEKLY_USAGE_WINDOW_SECONDS:
      return "weekly";
    default:
      return fallback;
  }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
