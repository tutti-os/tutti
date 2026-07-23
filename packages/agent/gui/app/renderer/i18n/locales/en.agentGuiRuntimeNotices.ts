export const enAgentGuiRuntimeNotices = {
  visibleErrorStartFailed: "{{provider}} failed to start",
  visibleErrorRequestFailed: "{{provider}} request failed",
  visibleErrorAuthRequired:
    "{{provider}} needs authentication or configuration",
  visibleErrorAuthRequiredLocalAgentHint:
    "Please sign in to local {{provider}}, then retry.",
  visibleErrorRequestTimedOut: "{{provider}} request timed out",
  visibleErrorRuntimeUnavailable:
    "{{provider}} could not start because the runtime is unavailable",
  visibleErrorQuotaOrRateLimit:
    "{{provider}} request failed because a quota or rate limit was reached",
  visibleErrorDetails: "View details",
  visibleErrorRawDetails: "Raw error",
  visibleErrorCliNotFound:
    "{{provider}} CLI wasn't found, so it couldn't run. Set it up to continue.",
  visibleErrorVersionUnsupported:
    "{{provider}}'s installed version is unsupported for this request. Upgrade to continue.",
  visibleErrorNetwork:
    "{{provider}} couldn't reach the network to complete this request.",
  visibleErrorConfigTimeout:
    "{{provider}} couldn't apply session settings before the request timed out. Try again in a moment.",
  visibleErrorStreamDisconnected:
    "{{provider}}'s response was interrupted before it completed. Try again in a moment.",
  visibleErrorConcurrencyLimit:
    "{{provider}} is handling too many requests right now. Try again after another task finishes.",
  visibleErrorInsufficientCreditsFree:
    "Your available credits are exhausted. Upgrade your membership for more credits",
  visibleErrorInsufficientCreditsActive:
    "Your Tutti credits are insufficient. Recharge credits to continue",
  visibleErrorInsufficientCreditsUnknown:
    "Your Tutti credits are insufficient. Review credit options to continue",
  visibleErrorActionInstall: "Connect",
  visibleErrorActionUpgrade: "Upgrade",
  visibleErrorActionRelogin: "Sign in",
  visibleErrorActionCheckNetwork: "Check network",
  visibleErrorActionDetect: "Open setup",
  visibleErrorActionUpgradeMembership: "Upgrade membership",
  visibleErrorActionRechargeCredits: "Recharge credits",
  visibleErrorActionViewCreditPlans: "View credit options",
  systemNoticeTransportRetry: "Agent connection interrupted. Reconnecting...",
  systemNoticeTransportFallback: "Agent switched to HTTPS transport",
  systemNoticePlanImplementationPendingConfirmation:
    "Plan implementation is awaiting confirmation",
  systemNoticePlanImplementationCompleted: "Plan implementation started",
  systemNoticeWarning: "Agent warning",
  systemNoticeDefault: "Agent notice",
  sharedDeviceLabel: "shared device",
  runtimeConnecting: "Connecting to {{device}}…",
  runtimeReconnectingAttempt: "Reconnecting to {{device}} · Retry {{attempt}}…",
  runtimeUnavailable:
    "Connection to {{device}} was lost. The system will retry automatically.",
  runtimeUnavailableActive:
    "Connection to {{device}} was lost. Sending and stopping are temporarily unavailable; the task may still be running on the device."
} as const;
