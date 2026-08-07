import type {
  AgentProviderProbeListInput,
  AgentProbeProvider,
  AgentUsageQuota
} from "@tutti-os/agent-gui";

import {
  loadKimiOAuthAccessToken,
  resolveKimiBillingTarget
} from "./kimiProviderAccount.ts";
import { outboundFetch } from "./net/outboundFetch.ts";

const KIMI_PROVIDER = "acp:kimi-code";
const KIMI_USAGE_TIMEOUT_MS = 8_000;

export async function probeKimiCodeProvider(
  input: AgentProviderProbeListInput,
  capturedAtUnixMs: number,
  provider = KIMI_PROVIDER
): Promise<AgentProbeProvider> {
  const attempts: NonNullable<AgentProbeProvider["attempts"]> = [];
  let target: Awaited<ReturnType<typeof resolveKimiBillingTarget>>;
  try {
    target = await resolveKimiBillingTarget();
    attempts.push({ strategy: "kimi-account-config", success: true });
  } catch (error) {
    return unavailableKimiProbe(
      provider,
      "kimi-account-config",
      "auth_required",
      errorMessage(error)
    );
  }

  if (target.billingMode === "api") {
    attempts.push({ strategy: "kimi-api-billing", success: true });
    return {
      attempts,
      availability: availableKimiStatus(),
      provider,
      usage: input.includeUsage
        ? { billingMode: "api", capturedAtUnixMs, quotas: [] }
        : undefined
    };
  }

  let accessToken: string;
  try {
    accessToken = await loadKimiOAuthAccessToken(target);
    attempts.push({ strategy: "kimi-oauth-credentials", success: true });
  } catch (error) {
    const message = errorMessage(error);
    const code = message.toLowerCase().includes("expired")
      ? "session_expired"
      : "auth_required";
    return unavailableKimiProbe(
      provider,
      "kimi-oauth-credentials",
      code,
      message,
      attempts
    );
  }

  if (!input.includeUsage) {
    return { attempts, availability: availableKimiStatus(), provider };
  }

  try {
    const payload = await fetchKimiUsage(target.baseUrl, accessToken);
    attempts.push({ strategy: "kimi-coding-plan-usage", success: true });
    return {
      attempts,
      availability: availableKimiStatus(),
      provider,
      usage: {
        billingMode: "subscription",
        capturedAtUnixMs,
        quotas: kimiUsageQuotas(payload, capturedAtUnixMs)
      }
    };
  } catch (error) {
    const message = errorMessage(error);
    const code = kimiProbeErrorCode(error);
    attempts.push({
      errorCode: code,
      errorMessage: message,
      strategy: "kimi-coding-plan-usage",
      success: false
    });
    return {
      attempts,
      availability: availableKimiStatus(),
      lastError: { code, message },
      provider
    };
  }
}

async function fetchKimiUsage(
  baseUrl: string,
  accessToken: string
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KIMI_USAGE_TIMEOUT_MS);
  try {
    const response = await outboundFetch(`${baseUrl}/usages`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`
      },
      signal: controller.signal
    });
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new Error("Kimi OAuth token is expired or unauthorized.");
    }
    if (response.status === 429) {
      throw new Error("Kimi Coding Plan usage API is rate limited.");
    }
    if (!response.ok) {
      throw new Error(
        `Kimi Coding Plan usage API returned HTTP ${response.status}.`
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("Kimi Coding Plan usage API returned invalid JSON.");
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Kimi Coding Plan usage API request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function kimiUsageQuotas(
  payload: unknown,
  capturedAtUnixMs: number
): AgentUsageQuota[] {
  const root = objectValue(payload);
  if (!root) return [];
  const quotas: AgentUsageQuota[] = [];
  const summary = usageRowToQuota({
    capturedAtUnixMs,
    fallbackLabel: "Weekly limit",
    fallbackType: "weekly",
    row: objectValue(root.usage),
    window: null
  });
  if (summary) quotas.push(summary);

  if (Array.isArray(root.limits)) {
    root.limits.forEach((value, index) => {
      const item = objectValue(value);
      if (!item) return;
      const detail = objectValue(item.detail) ?? item;
      const window = objectValue(item.window);
      const quota = usageRowToQuota({
        capturedAtUnixMs,
        fallbackLabel: kimiLimitLabel(item, detail, window, index),
        fallbackType: "model",
        row: detail,
        window
      });
      if (quota) quotas.push(quota);
    });
  }
  return quotas;
}

function usageRowToQuota(input: {
  capturedAtUnixMs: number;
  fallbackLabel: string;
  fallbackType: AgentUsageQuota["quotaType"];
  row: Record<string, unknown> | null;
  window: Record<string, unknown> | null;
}): AgentUsageQuota | null {
  if (!input.row) return null;
  const limit = numberValue(input.row.limit);
  let used = numberValue(input.row.used);
  if (used === null && limit !== null) {
    const remaining = numberValue(input.row.remaining);
    if (remaining !== null) used = limit - remaining;
  }
  if (limit === null || used === null || limit <= 0) return null;

  const label =
    stringValue(input.row.name) ||
    stringValue(input.row.title) ||
    input.fallbackLabel;
  const quotaType = kimiQuotaType(label, input.window, input.fallbackType);
  const quota: AgentUsageQuota = {
    percentRemaining: Math.max(
      0,
      Math.min(100, Math.round(((limit - used) / limit) * 100))
    ),
    quotaType,
    ...(quotaType === "model" ? { modelName: label } : {})
  };
  const reset = kimiReset(input.row, input.capturedAtUnixMs);
  if (reset.resetsAtUnixMs !== undefined) {
    quota.resetsAtUnixMs = reset.resetsAtUnixMs;
  } else if (reset.resetText) {
    quota.resetText = reset.resetText;
  }
  return quota;
}

function kimiQuotaType(
  label: string,
  window: Record<string, unknown> | null,
  fallback: AgentUsageQuota["quotaType"]
): AgentUsageQuota["quotaType"] {
  const normalized = label.toLowerCase();
  if (/week|weekly|\u5468/.test(normalized)) return "weekly";
  if (/month|monthly|\u6708/.test(normalized)) return "monthly";
  if (/day|daily|\u65e5/.test(normalized)) return "daily";
  if (/session|hour|\d+h|\u5c0f\u65f6/.test(normalized)) return "session";

  const duration = numberValue(window?.duration);
  const unit = stringValue(window?.timeUnit).toUpperCase();
  if (duration !== null) {
    if (unit.includes("DAY")) return duration >= 7 ? "weekly" : "daily";
    if (unit.includes("HOUR")) return duration >= 24 ? "daily" : "session";
    if (unit.includes("MINUTE")) {
      if (duration >= 7 * 24 * 60) return "weekly";
      if (duration >= 24 * 60) return "daily";
      return "session";
    }
  }
  return fallback;
}

function kimiLimitLabel(
  item: Record<string, unknown>,
  detail: Record<string, unknown>,
  window: Record<string, unknown> | null,
  index: number
): string {
  const explicit =
    stringValue(item.name) ||
    stringValue(item.title) ||
    stringValue(item.scope) ||
    stringValue(detail.name) ||
    stringValue(detail.title);
  if (explicit) return explicit;
  const duration = numberValue(window?.duration);
  const unit = stringValue(window?.timeUnit).toUpperCase();
  if (duration !== null && unit.includes("MINUTE")) {
    return duration >= 60 && duration % 60 === 0
      ? `${duration / 60}h limit`
      : `${duration}m limit`;
  }
  if (duration !== null && unit.includes("HOUR")) return `${duration}h limit`;
  if (duration !== null && unit.includes("DAY")) return `${duration}d limit`;
  return `Limit ${index + 1}`;
}

function kimiReset(
  row: Record<string, unknown>,
  capturedAtUnixMs: number
): { resetsAtUnixMs?: number; resetText?: string } {
  for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"]) {
    const value = stringValue(row[key]);
    if (!value) continue;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed)
      ? { resetsAtUnixMs: parsed }
      : { resetText: value };
  }
  for (const key of ["reset_in", "resetIn", "ttl"]) {
    const seconds = numberValue(row[key]);
    if (seconds !== null && seconds > 0) {
      return { resetsAtUnixMs: capturedAtUnixMs + seconds * 1_000 };
    }
  }
  return {};
}

function availableKimiStatus(): AgentProbeProvider["availability"] {
  return {
    checks: [{ name: "auth", passed: true }],
    detailsVisible: false,
    status: "available"
  };
}

function unavailableKimiProbe(
  provider: string,
  strategy: string,
  code: string,
  message: string,
  previousAttempts: NonNullable<AgentProbeProvider["attempts"]> = []
): AgentProbeProvider {
  return {
    attempts: [
      ...previousAttempts,
      { errorCode: code, errorMessage: message, strategy, success: false }
    ],
    availability: {
      checks: [{ detail: message, name: "auth", passed: false }],
      detailsVisible: true,
      status: "unavailable"
    },
    lastError: { code, message },
    provider
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

function kimiProbeErrorCode(error: unknown): string {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("unauthorized") || message.includes("expired")) {
    return "session_expired";
  }
  if (message.includes("timed out")) return "timeout";
  if (message.includes("json")) return "parse_failed";
  return "execution_failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
