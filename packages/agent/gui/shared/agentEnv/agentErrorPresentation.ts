import type { AgentEnvPanelFocus } from "./agentEnvPanelActions";

/**
 * Run-failure codes actually emitted by the daemon runtime classifier
 * (packages/agent/daemon/runtime/visible_error.go `visibleFailureCode`). These
 * are the codes the conversation error card really receives — unlike the
 * aspirational `CODEX_*` codes, which the run pipeline never produces.
 *
 * Keep this union aligned with the Go switch in `visibleFailureCode`.
 */
export type AgentRunErrorCode =
  | "auth_required"
  | "cli_not_found"
  | "cli_version_unsupported"
  | "network_error"
  | "runtime_unavailable"
  | "request_timed_out"
  | "provider_config_timeout"
  | "provider_stream_disconnected"
  | "provider_concurrency_limit"
  | "insufficient_credits"
  | "quota_or_rate_limit"
  | "process_exited"
  | "provider_error"
  | "unknown";

export interface AgentVisibleErrorOverride {
  message: string;
  /** Provider ids for which this product-owned override is valid. */
  providers: readonly string[];
  action?: {
    label: string;
    url: string;
  } | null;
}

/**
 * Product-owned structured errors whose copy may be supplied by a Host.
 * Environment/runtime errors remain canonical AgentGUI policy.
 */
export type AgentVisibleErrorOverrideCode = "insufficient_credits";

export type AgentVisibleErrorOverrides = Partial<
  Record<AgentVisibleErrorOverrideCode, AgentVisibleErrorOverride>
>;

export interface AgentErrorPresentation {
  /**
   * i18n key for the one human sentence shown in the card, or null to let the
   * caller fall back to its phase-aware generic title.
   */
  messageKey: string | null;
  /**
   * Env-panel section the remediation button deep-links to, or null when the
   * failure is transient/server-side and the wizard cannot fix it — in which
   * case no call-to-action is shown (showing one would misrepresent reality).
   */
  focus: AgentEnvPanelFocus | null;
  /** i18n key for the remediation button. */
  actionKey: string | null;
  /** External remediation destination, when the action is account-level. */
  externalUrl?: string | null;
}

const NO_CTA = { focus: null, actionKey: null } as const;

// The escape hatch for hard failures whose cause is ambiguous from the message
// alone (a non-zero exit, an unclassified provider error): send the user into
// the wizard to self-detect, but keep the generic message.
const SELF_DETECT = {
  messageKey: null,
  focus: "detect" as const,
  actionKey: "agentHost.agentGui.visibleErrorActionDetect"
};

const PRESENTATIONS: Record<AgentRunErrorCode, AgentErrorPresentation> = {
  // Environment problems the wizard can detect or repair → route to its step.
  auth_required: {
    messageKey: "agentHost.agentGui.visibleErrorAuthRequired",
    focus: "auth",
    actionKey: "agentHost.agentGui.visibleErrorActionRelogin"
  },
  cli_not_found: {
    messageKey: "agentHost.agentGui.visibleErrorCliNotFound",
    focus: "install",
    actionKey: "agentHost.agentGui.visibleErrorActionInstall"
  },
  cli_version_unsupported: {
    messageKey: "agentHost.agentGui.visibleErrorVersionUnsupported",
    focus: "upgrade",
    actionKey: "agentHost.agentGui.visibleErrorActionUpgrade"
  },
  network_error: {
    messageKey: "agentHost.agentGui.visibleErrorNetwork",
    focus: "network",
    actionKey: "agentHost.agentGui.visibleErrorActionCheckNetwork"
  },
  runtime_unavailable: {
    messageKey: "agentHost.agentGui.visibleErrorRuntimeUnavailable",
    focus: "detect",
    actionKey: "agentHost.agentGui.visibleErrorActionDetect"
  },
  // Transient / server-side failures: accurate copy, but no wizard CTA — it
  // cannot fix a rate limit or a dropped stream.
  request_timed_out: {
    messageKey: "agentHost.agentGui.visibleErrorRequestTimedOut",
    ...NO_CTA
  },
  provider_config_timeout: {
    messageKey: "agentHost.agentGui.visibleErrorConfigTimeout",
    ...NO_CTA
  },
  provider_stream_disconnected: {
    messageKey: "agentHost.agentGui.visibleErrorStreamDisconnected",
    ...NO_CTA
  },
  provider_concurrency_limit: {
    messageKey: "agentHost.agentGui.visibleErrorConcurrencyLimit",
    ...NO_CTA
  },
  insufficient_credits: {
    messageKey: "agentHost.agentGui.visibleErrorInsufficientCreditsUnknown",
    ...NO_CTA
  },
  quota_or_rate_limit: {
    messageKey: "agentHost.agentGui.visibleErrorQuotaOrRateLimit",
    ...NO_CTA
  },
  // Ambiguous hard failures → generic message + self-detect escape hatch.
  process_exited: SELF_DETECT,
  provider_error: SELF_DETECT,
  unknown: SELF_DETECT
};

/**
 * Resolves the card presentation for a run-failure code. Returns null for codes
 * outside the known vocabulary so the caller renders its plain generic card with
 * no call-to-action.
 */
export function resolveAgentErrorPresentation(
  code: string | null | undefined
): AgentErrorPresentation | null {
  if (!code) {
    return null;
  }
  return PRESENTATIONS[code as AgentRunErrorCode] ?? null;
}

const FAILED_MESSAGE_CODE_MARKERS: ReadonlyArray<
  readonly [AgentRunErrorCode, readonly string[]]
> = [
  [
    "auth_required",
    [
      "authentication_failed",
      "invalid authentication credentials",
      "401 invalid authentication",
      "unauthorized",
      "not logged in",
      "please run /login",
      "invalid api key"
    ]
  ],
  [
    "cli_version_unsupported",
    ["requires a newer version", "version is too old", "unsupported version"]
  ],
  [
    "cli_not_found",
    [
      "no such file or directory",
      "command not found",
      "enoent",
      "executable file not found"
    ]
  ],
  [
    "network_error",
    ["enotfound", "econnrefused", "econnreset", "getaddrinfo", "socket hang up"]
  ],
  [
    "quota_or_rate_limit",
    ["upgrade your plan to continue", "add a payment method to continue"]
  ]
];

/**
 * Some providers (notably Claude Code) report an environment failure — e.g. a
 * dropped login (401) — as a plain failed assistant message rather than a
 * structured visibleError, so it never gets the remediation card. This recovers
 * the env-fixable code from that message's text so the caller can still route the
 * user to the wizard. Returns null when the text isn't a recognized env failure
 * (so transient/unknown failures stay plain).
 */
export function classifyFailedAgentMessage(
  body: string | null | undefined
): AgentRunErrorCode | null {
  if (!body) {
    return null;
  }
  const lower = body.toLowerCase();
  for (const [code, markers] of FAILED_MESSAGE_CODE_MARKERS) {
    if (markers.some((marker) => lower.includes(marker))) {
      return code;
    }
  }
  return null;
}

const COMPLETED_AUTH_MESSAGE_MAX_LENGTH = 160;
const COMPLETED_AUTH_MESSAGE_PATTERN =
  /^not logged in\s*(?:[·•:—-]|\.)?\s*please run\s+\/login[.!]?$/i;

/**
 * Resolves a plain assistant message that should be recovered into a visible
 * error card. Failed messages keep the provider-agnostic fallback above.
 *
 * Claude Code demonstrates why completed messages need a narrow exception: its
 * SDK can return the standalone "Not logged in · Please run /login" notice
 * together with a successful result. Match the provider-owned output shape,
 * rather than branching on provider identity, and keep it short and
 * whole-message anchored so normal answers are not reclassified.
 */
export function classifyRecoverableAgentMessage(input: {
  body: string | null | undefined;
  statusKind: string | null | undefined;
}): AgentRunErrorCode | null {
  if (input.statusKind === "failed") {
    return classifyFailedAgentMessage(input.body);
  }
  if (
    input.statusKind !== "completed" ||
    !input.body ||
    input.body.length > COMPLETED_AUTH_MESSAGE_MAX_LENGTH
  ) {
    return null;
  }
  return COMPLETED_AUTH_MESSAGE_PATTERN.test(input.body.trim())
    ? "auth_required"
    : null;
}
