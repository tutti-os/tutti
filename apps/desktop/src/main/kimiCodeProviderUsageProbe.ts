import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  utimes
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AgentProviderProbeListInput,
  AgentProbeProvider,
  AgentUsageQuota
} from "@tutti-os/agent-gui";

import {
  kimiTokenStorageName,
  projectKimiConfig
} from "./kimiCodeConfigProjection.ts";
import { outboundFetch } from "./net/outboundFetch.ts";

const KIMI_CODE_PROVIDER = "acp:kimi-code";
const KIMI_MANAGED_PROVIDER = "managed:kimi-code";
const KIMI_DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
const KIMI_DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const KIMI_OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_TOKEN_REFRESH_THRESHOLD_SECONDS = 5 * 60;
const KIMI_REFRESH_LOCK_WAIT_MS = 10_000;
const KIMI_HTTP_TIMEOUT_MS = 8_000;

interface KimiProviderMode {
  kind: "api-key" | "coding-plan";
  baseUrl: string;
  oauthHost: string;
  tokenStorageName: string;
}

interface KimiOAuthToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  expiresIn: number;
  scope: string;
  tokenType: string;
}

interface KimiUsageRow {
  detail: Record<string, unknown>;
  item: Record<string, unknown>;
  window: Record<string, unknown>;
}

class KimiProbeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "KimiProbeError";
    this.code = code;
  }
}

export async function probeKimiCodeProvider(
  input: AgentProviderProbeListInput,
  capturedAtUnixMs: number
): Promise<AgentProbeProvider> {
  const attempts: AgentProbeProvider["attempts"] = [];
  let mode: KimiProviderMode;
  try {
    mode = await resolveKimiProviderMode();
    attempts.push({
      strategy: `kimi-code-${mode.kind}-config`,
      success: true
    });
  } catch (error) {
    return failedKimiProbe(
      attempts,
      "kimi-code-config",
      kimiProbeErrorCode(error),
      errorMessage(error),
      false
    );
  }

  if (mode.kind === "api-key") {
    return {
      attempts,
      availability: availableKimiStatus(),
      provider: KIMI_CODE_PROVIDER,
      usage: input.includeUsage
        ? {
            accountTier: "API Usage Billing",
            capturedAtUnixMs,
            quotas: []
          }
        : undefined
    };
  }

  let accessToken: string;
  try {
    accessToken = await loadFreshKimiAccessToken(mode);
    attempts.push({ strategy: "kimi-code-oauth", success: true });
  } catch (error) {
    return failedKimiProbe(
      attempts,
      "kimi-code-oauth",
      kimiProbeErrorCode(error),
      errorMessage(error),
      false
    );
  }

  if (!input.includeUsage) {
    return {
      attempts,
      availability: availableKimiStatus(),
      provider: KIMI_CODE_PROVIDER
    };
  }

  try {
    const payload = await fetchKimiManagedUsage(mode.baseUrl, accessToken);
    attempts.push({ strategy: "kimi-code-managed-usage", success: true });
    return {
      attempts,
      availability: availableKimiStatus(),
      provider: KIMI_CODE_PROVIDER,
      usage: {
        accountTier: "Coding Plan",
        capturedAtUnixMs,
        quotas: kimiManagedUsageQuotas(payload, capturedAtUnixMs)
      }
    };
  } catch (error) {
    return failedKimiProbe(
      attempts,
      "kimi-code-managed-usage",
      kimiProbeErrorCode(error),
      errorMessage(error),
      true
    );
  }
}

function availableKimiStatus(): AgentProbeProvider["availability"] {
  return {
    checks: [{ name: "auth", passed: true }],
    detailsVisible: false,
    status: "available"
  };
}

function failedKimiProbe(
  attempts: NonNullable<AgentProbeProvider["attempts"]>,
  strategy: string,
  code: string,
  message: string,
  authWasResolved: boolean
): AgentProbeProvider {
  attempts.push({
    errorCode: code,
    errorMessage: message,
    strategy,
    success: false
  });
  return {
    attempts,
    availability: authWasResolved
      ? availableKimiStatus()
      : {
          checks: [{ detail: message, name: "auth", passed: false }],
          detailsVisible: true,
          status: "unavailable"
        },
    lastError: { code, message },
    provider: KIMI_CODE_PROVIDER
  };
}

async function resolveKimiProviderMode(): Promise<KimiProviderMode> {
  // Kimi's KIMI_MODEL_* overlay always synthesizes an API-key provider and
  // wins over config.toml. Never let a leftover OAuth file change that mode.
  if (stringValue(process.env.KIMI_MODEL_NAME)) {
    if (!stringValue(process.env.KIMI_MODEL_API_KEY)) {
      throw new KimiProbeError(
        "auth_required",
        "Kimi API-key mode is missing KIMI_MODEL_API_KEY."
      );
    }
    return apiKeyMode();
  }

  const home = kimiCodeHome();
  let content: string;
  try {
    content = await readFile(join(home, "config.toml"), "utf8");
  } catch {
    throw new KimiProbeError(
      "auth_required",
      "Kimi config.toml was not found."
    );
  }
  const config = projectKimiConfig(content);
  if (!config.defaultModel) {
    throw new KimiProbeError(
      "parse_failed",
      "Kimi config.toml has no default_model."
    );
  }
  const activeProvider = config.modelProviders.get(config.defaultModel);
  if (!activeProvider) {
    throw new KimiProbeError(
      "parse_failed",
      `Kimi default model "${config.defaultModel}" has no provider mapping.`
    );
  }
  if (activeProvider !== KIMI_MANAGED_PROVIDER) {
    return apiKeyMode();
  }

  const baseUrl =
    stringValue(process.env.KIMI_CODE_BASE_URL) ||
    config.providerBaseUrls.get(activeProvider) ||
    KIMI_DEFAULT_BASE_URL;
  const oauthHost =
    stringValue(process.env.KIMI_CODE_OAUTH_HOST) ||
    stringValue(process.env.KIMI_OAUTH_HOST) ||
    config.providerOAuthHosts.get(activeProvider) ||
    KIMI_DEFAULT_OAUTH_HOST;
  const oauthKey =
    config.providerOAuthKeys.get(activeProvider) || "oauth/kimi-code";
  const tokenStorageName = kimiTokenStorageName(oauthKey);
  if (!tokenStorageName) {
    throw new KimiProbeError(
      "parse_failed",
      "Kimi OAuth credential key is invalid."
    );
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/u, ""),
    kind: "coding-plan",
    oauthHost: oauthHost.replace(/\/+$/u, ""),
    tokenStorageName
  };
}

function apiKeyMode(): KimiProviderMode {
  return {
    baseUrl: "",
    kind: "api-key",
    oauthHost: "",
    tokenStorageName: ""
  };
}

async function loadFreshKimiAccessToken(
  mode: KimiProviderMode
): Promise<string> {
  const home = kimiCodeHome();
  const credentialPath = join(
    home,
    "credentials",
    `${mode.tokenStorageName}.json`
  );
  let token = await readKimiToken(credentialPath);
  if (!kimiTokenNeedsRefresh(token)) return token.accessToken;
  if (!token.refreshToken) {
    throw new KimiProbeError(
      "session_expired",
      "Kimi Coding Plan credentials are expired; sign in again."
    );
  }

  const release = await acquireKimiRefreshLock(home, mode.tokenStorageName);
  try {
    token = await readKimiToken(credentialPath);
    if (!kimiTokenNeedsRefresh(token)) return token.accessToken;
    const refreshed = await refreshKimiToken(mode.oauthHost, token);
    await writeKimiToken(credentialPath, refreshed);
    return refreshed.accessToken;
  } finally {
    await release();
  }
}

async function readKimiToken(path: string): Promise<KimiOAuthToken> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new KimiProbeError(
      "auth_required",
      "Kimi Coding Plan credentials were not found."
    );
  }
  const accessToken = stringValue(parsed.access_token);
  if (!accessToken) {
    throw new KimiProbeError(
      "session_expired",
      "Kimi Coding Plan credentials require sign-in."
    );
  }
  return {
    accessToken,
    expiresAt: numberValue(parsed.expires_at) ?? 0,
    expiresIn: numberValue(parsed.expires_in) ?? 0,
    refreshToken: stringValue(parsed.refresh_token),
    scope: stringValue(parsed.scope),
    tokenType: stringValue(parsed.token_type) || "Bearer"
  };
}

function kimiTokenNeedsRefresh(token: KimiOAuthToken): boolean {
  if (token.expiresAt === 0) return false;
  const threshold = Math.max(
    KIMI_TOKEN_REFRESH_THRESHOLD_SECONDS,
    token.expiresIn > 0 ? token.expiresIn * 0.5 : 0
  );
  return token.expiresAt - Math.floor(Date.now() / 1000) < threshold;
}

async function refreshKimiToken(
  oauthHost: string,
  current: KimiOAuthToken
): Promise<KimiOAuthToken> {
  const response = await outboundFetch(
    `${oauthHost.replace(/\/+$/u, "")}/api/oauth/token`,
    {
      body: new URLSearchParams({
        client_id: KIMI_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: current.refreshToken
      }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      method: "POST",
      signal: AbortSignal.timeout(KIMI_HTTP_TIMEOUT_MS)
    }
  );
  if (response.status === 401 || response.status === 403) {
    throw new KimiProbeError(
      "session_expired",
      "Kimi Coding Plan credentials are unauthorized; sign in again."
    );
  }
  if (!response.ok) {
    throw new KimiProbeError(
      "execution_failed",
      `Kimi OAuth token endpoint returned HTTP ${response.status}.`
    );
  }
  const payload = await responseJson(response, "Kimi OAuth token endpoint");
  const accessToken = stringValue(payload.access_token);
  const refreshToken =
    stringValue(payload.refresh_token) || current.refreshToken;
  const expiresIn = numberValue(payload.expires_in);
  if (!accessToken || !refreshToken || expiresIn === null || expiresIn <= 0) {
    throw new KimiProbeError(
      "parse_failed",
      "Kimi OAuth token endpoint returned an invalid token."
    );
  }
  return {
    accessToken,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    expiresIn,
    refreshToken,
    scope: stringValue(payload.scope) || current.scope,
    tokenType: stringValue(payload.token_type) || current.tokenType || "Bearer"
  };
}

async function acquireKimiRefreshLock(
  home: string,
  tokenStorageName: string
): Promise<() => Promise<void>> {
  const target = join(home, "oauth", tokenStorageName);
  const lockPath = `${target}.lock`;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const targetHandle = await open(target, "a", 0o600);
  await targetHandle.close();
  const deadline = Date.now() + KIMI_REFRESH_LOCK_WAIT_MS;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const heartbeat = setInterval(() => {
        const now = new Date();
        void utimes(lockPath, now, now).catch(() => {});
      }, 2_000);
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        await rm(lockPath, { force: true, recursive: true });
      };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      if (Date.now() >= deadline) {
        throw new KimiProbeError(
          "timeout",
          "Kimi OAuth credential refresh is busy; try again."
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function writeKimiToken(
  path: string,
  token: KimiOAuthToken
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify(
          {
            access_token: token.accessToken,
            expires_at: token.expiresAt,
            expires_in: token.expiresIn,
            refresh_token: token.refreshToken,
            scope: token.scope,
            token_type: token.tokenType
          },
          null,
          2
        )}\n`,
        "utf8"
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function fetchKimiManagedUsage(
  baseUrl: string,
  accessToken: string
): Promise<Record<string, unknown>> {
  const response = await outboundFetch(
    `${baseUrl.replace(/\/+$/u, "")}/usages`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "Tutti"
      },
      signal: AbortSignal.timeout(KIMI_HTTP_TIMEOUT_MS)
    }
  );
  if (response.status === 401 || response.status === 403) {
    throw new KimiProbeError(
      "session_expired",
      "Kimi Coding Plan credentials are expired or unauthorized."
    );
  }
  if (response.status === 402) {
    throw new KimiProbeError(
      "subscription_required",
      "Kimi Coding Plan subscription is required."
    );
  }
  if (response.status === 429) {
    throw new KimiProbeError(
      "execution_failed",
      "Kimi Coding Plan usage API is rate limited."
    );
  }
  if (!response.ok) {
    throw new KimiProbeError(
      "execution_failed",
      `Kimi Coding Plan usage API returned HTTP ${response.status}.`
    );
  }
  return responseJson(response, "Kimi Coding Plan usage API");
}

async function responseJson(
  response: Response,
  label: string
): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Project one stable parse error below.
  }
  throw new KimiProbeError("parse_failed", `${label} returned invalid JSON.`);
}

function kimiManagedUsageQuotas(
  payload: Record<string, unknown>,
  capturedAtUnixMs: number
): AgentUsageQuota[] {
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  const quotas = limits
    .map((value) => kimiUsageRow(value))
    .filter((row): row is KimiUsageRow => row !== null)
    .map((row) => kimiUsageRowToQuota(row, capturedAtUnixMs))
    .filter((quota): quota is AgentUsageQuota => quota !== null);
  if (quotas.length > 0) return quotas;
  const summary = objectValue(payload.usage);
  if (!summary) return [];
  const quota = kimiUsageRowToQuota(
    { detail: summary, item: summary, window: {} },
    capturedAtUnixMs,
    "weekly"
  );
  return quota ? [quota] : [];
}

function kimiUsageRow(value: unknown): KimiUsageRow | null {
  const item = objectValue(value);
  if (!item) return null;
  return {
    detail: objectValue(item.detail) ?? item,
    item,
    window: objectValue(item.window) ?? {}
  };
}

function kimiUsageRowToQuota(
  row: KimiUsageRow,
  capturedAtUnixMs: number,
  fallbackType?: AgentUsageQuota["quotaType"]
): AgentUsageQuota | null {
  const limit = firstNumber(row.detail.limit, row.item.limit);
  const remaining = firstNumber(row.detail.remaining, row.item.remaining);
  const used = firstNumber(row.detail.used, row.item.used);
  if (limit === null || limit <= 0 || (remaining === null && used === null)) {
    return null;
  }
  const remainingValue = remaining ?? limit - (used ?? 0);
  const quota: AgentUsageQuota = {
    percentRemaining: Math.max(
      0,
      Math.min(100, Math.round((remainingValue / limit) * 100))
    ),
    quotaType: fallbackType ?? kimiQuotaType(row)
  };
  const resetAt = firstValue(
    row.detail.reset_at,
    row.detail.resetAt,
    row.detail.reset_time,
    row.detail.resetTime,
    row.item.reset_at,
    row.item.resetAt,
    row.item.reset_time,
    row.item.resetTime
  );
  const resetUnixMs = unixMsValue(resetAt);
  if (resetUnixMs !== null) {
    quota.resetsAtUnixMs = resetUnixMs;
  } else {
    const resetIn = firstNumber(
      row.detail.reset_in,
      row.detail.resetIn,
      row.detail.ttl,
      row.item.reset_in,
      row.item.resetIn,
      row.item.ttl
    );
    if (resetIn !== null && resetIn > 0) {
      quota.resetsAtUnixMs = capturedAtUnixMs + resetIn * 1000;
    }
  }
  return quota;
}

function kimiQuotaType(row: KimiUsageRow): AgentUsageQuota["quotaType"] {
  const label = stringValue(
    firstValue(
      row.item.name,
      row.item.title,
      row.item.scope,
      row.detail.name,
      row.detail.title,
      row.detail.scope
    )
  ).toLowerCase();
  if (label.includes("month")) return "monthly";
  if (label.includes("week") || /\b7d\b/u.test(label)) return "weekly";
  if (label.includes("day") || /\b1d\b/u.test(label)) return "daily";
  if (label.includes("hour") || /\bh\b/u.test(label)) return "session";

  const duration = firstNumber(
    row.window.duration,
    row.item.duration,
    row.detail.duration
  );
  const unit = stringValue(
    firstValue(
      row.window.timeUnit,
      row.window.time_unit,
      row.item.timeUnit,
      row.item.time_unit,
      row.detail.timeUnit,
      row.detail.time_unit
    )
  ).toUpperCase();
  const seconds = durationSeconds(duration, unit);
  if (seconds !== null) {
    if (seconds >= 28 * 86_400) return "monthly";
    if (seconds >= 7 * 86_400) return "weekly";
    if (seconds >= 86_400) return "daily";
  }
  return "session";
}

function durationSeconds(duration: number | null, unit: string): number | null {
  if (duration === null || duration <= 0) return null;
  if (unit.includes("DAY")) return duration * 86_400;
  if (unit.includes("HOUR")) return duration * 3_600;
  if (unit.includes("MINUTE")) return duration * 60;
  return duration;
}

function unixMsValue(value: unknown): number | null {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    }
  }
  const numeric = numberValue(value);
  if (numeric === null) return null;
  return numeric > 10_000_000_000 ? numeric : numeric * 1000;
}

function kimiCodeHome(): string {
  return (
    stringValue(process.env.KIMI_CODE_HOME) || join(homedir(), ".kimi-code")
  );
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
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

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = numberValue(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function firstValue(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function kimiProbeErrorCode(error: unknown): string {
  if (error instanceof KimiProbeError) return error.code;
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return "timeout";
  }
  const message = errorMessage(error).toLowerCase();
  if (message.includes("unauthorized") || message.includes("expired")) {
    return "session_expired";
  }
  if (message.includes("json") || message.includes("config")) {
    return "parse_failed";
  }
  return "execution_failed";
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
