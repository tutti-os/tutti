export const enAgentGuiRuntimeNotices = {
  visibleErrorStartFailed: "{{provider}} failed to start",
  visibleErrorRequestFailed: "{{provider}} request failed",
  visibleErrorAuthRequired:
    "{{provider}} needs authentication or configuration",
  visibleErrorAuthRequiredLocalAgentHint:
    "Please sign in to local {{provider}}, then retry.",
  visibleErrorSharedCallerHint:
    "Contact the person who shared this Agent, then try again.",
  visibleErrorRequestTimedOut: "{{provider}} request timed out",
  visibleErrorRuntimeUnavailable:
    "{{provider}} could not start because the runtime is unavailable",
  visibleErrorQuotaOrRateLimit:
    "{{provider}} request failed because a quota or rate limit was reached",
  visibleErrorSubscriptionRequired:
    "{{provider}} requires an active subscription or an eligible plan for this request",
  visibleErrorModelNotAllowed:
    "{{provider}} cannot use the selected model with the current account",
  visibleErrorPluginUnavailable:
    "{{provider}} could not use an optional integration that is currently unavailable",
  visibleErrorSessionInterrupted:
    "{{provider}} stopped unexpectedly before it finished. Try again.",
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
  visibleErrorEmptyResponse:
    "{{provider}} returned no response. Check the provider settings or try again.",
  visibleErrorConcurrencyLimit:
    "{{provider}} is handling too many requests right now. Try again after another task finishes.",
  visibleErrorInsufficientCreditsUnknown:
    "{{provider}} has insufficient credits or account balance to continue",
  visibleErrorActionInstall: "Connect",
  visibleErrorActionUpgrade: "Upgrade",
  visibleErrorActionRelogin: "Sign in",
  visibleErrorActionCheckNetwork: "Check network",
  visibleErrorActionDetect: "Open setup",
  systemNoticeTransportRetry: "Agent connection interrupted. Reconnecting...",
  systemNoticeTransportFallback: "Agent switched to HTTPS transport",
  systemNoticePlanImplementationPendingConfirmation:
    "Plan implementation is awaiting confirmation",
  systemNoticePlanImplementationCompleted: "Plan implementation started",
  systemNoticeWarning: "Agent warning",
  systemNoticeDefault: "Agent notice",
  contextCompactionInProgress: "Compacting context",
  contextCompactionCompleted: "Context compacted.",
  contextCompactionInterrupted: "Context compaction interrupted.",
  contextHandoffRequired: "This conversation has reached its context limit",
  contextHandoffRequiredDetail:
    "This conversation can't continue. Start a new conversation and @mention this conversation to hand off its context.",
  sharedDeviceLabel: "shared device",
  agentSharingRevoked: "{{owner}} stopped sharing this agent",
  runtimeConnecting: "Connecting to {{device}}…",
  runtimeReconnectingAttempt: "Reconnecting to {{device}} · Retry {{attempt}}…",
  runtimeUnavailable:
    "Connection to {{device}} was lost. The system will retry automatically.",
  runtimeUnavailableActive:
    "Connection to {{device}} was lost. Sending and stopping are temporarily unavailable; the task may still be running on the device.",
  runtimeSynchronizingProgress: "Synchronizing the latest task progress…",
  interactionSynchronizing:
    "The shared Agent state is synchronizing. Try again in a moment.",
  interactionOwnerOffline: "The shared Agent owner is offline",
  interactionBindingRevoked: "The shared Agent is no longer available"
} as const;
