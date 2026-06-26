import type { AgentEnvPanelFocus } from "./agentEnvPanelStore";

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
  | "quota_or_rate_limit"
  | "process_exited"
  | "provider_error"
  | "unknown";

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
  /** i18n key for the remediation button. Only meaningful when `focus` is set. */
  actionKey: string | null;
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
