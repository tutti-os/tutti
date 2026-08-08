import type {
  AgentProviderProbeListInput,
  AgentProbeProvider,
  AgentUsageQuota
} from "@tutti-os/agent-gui";

import {
  type CodeBuddyAccountUsageCredential,
  resolveCodeBuddyBillingTarget
} from "./codeBuddyProviderAccount.ts";
import { outboundFetch } from "./net/outboundFetch.ts";

const CODEBUDDY_PROVIDER = "acp:codebuddy";
const CODEBUDDY_ACCOUNT_USAGE_PATH = "/billing/meter/get-user-resource";
const CODEBUDDY_PRODUCT_CODE = "p_tcaca";
const CODEBUDDY_PACKAGE_CODES = [
  "TCACA_code_001_PqouKr6QWV",
  "TCACA_code_002_AkiJS3ZHF5",
  "TCACA_code_006_DbXS0lrypC",
  "TCACA_code_007_nzdH5h4Nl0",
  "TCACA_code_003_FAnt7lcmRT",
  "TCACA_code_008_cfWoLwvjU4",
  "TCACA_code_009_0XmEQc2xOf"
] as const;

interface CodeBuddyAccountResourceResponse {
  code?: unknown;
  data?: {
    Response?: {
      Data?: {
        Accounts?: unknown;
      };
    };
  };
}

export async function probeCodeBuddyProvider(
  input: AgentProviderProbeListInput,
  capturedAtUnixMs: number,
  provider = CODEBUDDY_PROVIDER
): Promise<AgentProbeProvider> {
  try {
    const target = await resolveCodeBuddyBillingTarget();
    const attempts: NonNullable<AgentProbeProvider["attempts"]> = [
      { strategy: "codebuddy-account-config", success: true }
    ];
    if (
      !input.includeUsage ||
      target.billingMode !== "provider_account" ||
      !target.usageCredential
    ) {
      return {
        attempts,
        availability: availableCodeBuddyStatus(),
        provider,
        usage: input.includeUsage
          ? {
              billingMode: target.billingMode,
              capturedAtUnixMs,
              quotas: []
            }
          : undefined
      };
    }

    try {
      const quota = await fetchCodeBuddyAccountCredits(target.usageCredential);
      attempts.push({ strategy: "codebuddy-account-credits", success: true });
      return {
        attempts,
        availability: availableCodeBuddyStatus(),
        provider,
        usage: {
          billingMode: target.billingMode,
          capturedAtUnixMs,
          quotas: [quota]
        }
      };
    } catch (error) {
      const code = codeBuddyUsageErrorCode(error);
      const message = errorMessage(error);
      attempts.push({
        errorCode: code,
        errorMessage: message,
        strategy: "codebuddy-account-credits",
        success: false
      });
      return {
        attempts,
        availability: availableCodeBuddyStatus(),
        lastError: { code, message },
        provider,
        usage: {
          billingMode: target.billingMode,
          capturedAtUnixMs,
          quotas: []
        }
      };
    }
  } catch (error) {
    const message = errorMessage(error);
    const code = message.toLowerCase().includes("expired")
      ? "session_expired"
      : "auth_required";
    return {
      attempts: [
        {
          errorCode: code,
          errorMessage: message,
          strategy: "codebuddy-account-config",
          success: false
        }
      ],
      availability: {
        detailsVisible: false,
        status: "unavailable"
      },
      lastError: { code, message },
      provider
    };
  }
}

function availableCodeBuddyStatus(): AgentProbeProvider["availability"] {
  return {
    detailsVisible: false,
    status: "available"
  };
}

async function fetchCodeBuddyAccountCredits(
  credential: CodeBuddyAccountUsageCredential
): Promise<AgentUsageQuota> {
  const now = new Date();
  const end = new Date(now);
  end.setFullYear(end.getFullYear() + 101);
  const response = await outboundFetch(
    `${credential.baseUrl}${CODEBUDDY_ACCOUNT_USAGE_PATH}`,
    {
      body: JSON.stringify({
        PackageCodes: CODEBUDDY_PACKAGE_CODES,
        PackageEndTimeRangeBegin: formatLocalDateTime(now),
        PackageEndTimeRangeEnd: formatLocalDateTime(end),
        PageNumber: 1,
        PageSize: 200,
        ProductCode: CODEBUDDY_PRODUCT_CODE,
        Status: [0, 3]
      }),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credential.accessToken}`,
        "Content-Type": "application/json",
        "X-User-Id": credential.userId
      },
      method: "POST",
      signal: AbortSignal.timeout(15_000)
    }
  );
  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new Error("CodeBuddy account session is expired or unauthorized.");
  }
  if (!response.ok) {
    throw new Error(
      `CodeBuddy account usage API returned HTTP ${response.status}.`
    );
  }
  let payload: CodeBuddyAccountResourceResponse;
  try {
    payload = JSON.parse(text) as CodeBuddyAccountResourceResponse;
  } catch {
    throw new Error("CodeBuddy account usage API returned invalid JSON.");
  }
  if (numberValue(payload.code) !== 0) {
    throw new Error("CodeBuddy account usage API rejected the request.");
  }
  return codeBuddyCreditsQuota(payload);
}

function codeBuddyCreditsQuota(
  payload: CodeBuddyAccountResourceResponse
): AgentUsageQuota {
  const accounts = payload.data?.Response?.Data?.Accounts;
  if (!Array.isArray(accounts)) {
    throw new Error("CodeBuddy account usage API returned an invalid payload.");
  }
  const totals = accounts.reduce(
    (result, account) => {
      const value = objectValue(account);
      const status = numberValue(value?.Status);
      if (status !== null && status !== 0 && status !== 3) return result;
      const remaining = nonNegativeNumber(value?.CapacityRemainPrecise);
      const limit = nonNegativeNumber(value?.CapacitySizePrecise);
      if (remaining !== null) {
        result.remaining += remaining;
        result.hasAmount = true;
      }
      if (limit !== null) result.limit += limit;
      return result;
    },
    { hasAmount: false, limit: 0, remaining: 0 }
  );
  if (!totals.hasAmount) {
    throw new Error("CodeBuddy account usage API returned no credit balance.");
  }
  return {
    amountLimit: totals.limit,
    amountRemaining: totals.remaining,
    amountUnit: "credits",
    percentRemaining:
      totals.limit > 0
        ? Math.max(0, Math.min(100, (totals.remaining / totals.limit) * 100))
        : undefined,
    quotaType: "credits"
  };
}

function formatLocalDateTime(value: Date): string {
  const pad = (number: number): string => String(number).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(
    value.getDate()
  )} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(
    value.getSeconds()
  )}`;
}

function nonNegativeNumber(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function codeBuddyUsageErrorCode(error: unknown): string {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("unauthorized") || message.includes("expired")) {
    return "session_expired";
  }
  if (message.includes("json") || message.includes("payload")) {
    return "parse_failed";
  }
  if (message.includes("abort") || message.includes("timeout")) {
    return "timeout";
  }
  if (message.includes("no credit balance")) return "no_data";
  return "execution_failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
