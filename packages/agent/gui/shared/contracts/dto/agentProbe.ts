// AgentProbe DTOs — mirrors core/agentprobe Go types.
// Two independent call modes:
//   includeUsage=false (default) → availability only, lightweight
//   includeUsage=true            → full usage probe, heavier

export type AgentAvailabilityStatus = "available" | "unavailable" | "unknown";

export type AgentQuotaType =
  | "session"
  | "weekly"
  | "monthly"
  | "daily"
  | "model"
  | "cost";

export interface AgentAvailabilityCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface AgentAvailability {
  status: AgentAvailabilityStatus;
  detailsVisible: boolean;
  checks?: AgentAvailabilityCheck[];
}

export interface AgentUsageQuota {
  quotaType: AgentQuotaType;
  percentRemaining?: number;
  resetsAtUnixMs?: number;
  resetText?: string;
  dollarRemaining?: number;
  modelName?: string;
}

export interface AgentCostUsage {
  dollarUsed: number;
  dollarLimit?: number;
}

export interface AgentUsageSnapshot {
  quotas?: AgentUsageQuota[];
  accountTier?: string;
  /** Provider-neutral billing mode used when an account has no quota rows. */
  billingMode?: "subscription" | "api";
  costUsage?: AgentCostUsage;
  capturedAtUnixMs: number;
}

export interface AgentProbeAttempt {
  strategy: string;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface AgentProbeError {
  code: string;
  message?: string;
}

export interface AgentProbeProvider {
  /** Exact Agent Target identity that produced this result. */
  agentTargetId?: string;
  provider: string;
  availability: AgentAvailability;
  usage?: AgentUsageSnapshot;
  attempts?: AgentProbeAttempt[];
  lastError?: AgentProbeError;
}

export interface AgentProbeSnapshot {
  workspaceId: string;
  roomId?: string;
  capturedAtUnixMs: number;
  providers: AgentProbeProvider[];
}

// Probe error codes — match core/agentprobe/errors.go ProbeErrorCode values.
export const AGENT_PROBE_ERROR_CODES = {
  cliNotFound: "cli_not_found",
  authRequired: "auth_required",
  sessionExpired: "session_expired",
  parseFailed: "parse_failed",
  timeout: "timeout",
  noData: "no_data",
  updateRequired: "update_required",
  folderTrustRequired: "folder_trust_required",
  subscriptionRequired: "subscription_required",
  quotaExhausted: "quota_exhausted",
  executionFailed: "execution_failed",
  configInvalid: "config_invalid",
  rateLimited: "rate_limited",
  unsupported: "unsupported",
  runtimeUnavailable: "runtime_unavailable"
} as const;

export type AgentProbeErrorCode =
  (typeof AGENT_PROBE_ERROR_CODES)[keyof typeof AGENT_PROBE_ERROR_CODES];

export interface AgentHostListWorkspaceAgentProbesInput {
  workspaceId: string;
  /** Compatibility input while carried call sites finish migrating from TSH room naming. */
  roomId?: string;
  /** Preferred exact identity. Provider-only requests remain compatibility input. */
  agentTargetIds?: string[];
  providers?: string[];
  includeUsage?: boolean;
  refresh?: boolean;
}

export type AgentHostWorkspaceAgentProbesResult = AgentProbeSnapshot;
