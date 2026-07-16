export const enAgentGuiCollaboration = {
  collaborationCancel: "Cancel",
  collaborationCancelFailed: "Failed to cancel the collaboration.",
  collaborationRetry: "Retry",
  collaborationRetryFailed: "Failed to retry the collaboration.",
  collaborationRevise: "Change model or Agent",
  collaborationReturnUser: "Return to user",
  automationSessionLabel: "Automation",
  automationSessionDefaults: "Workspace defaults",
  automationSessionOff: "Off for this session",
  automationSessionSelectedCount: "{{count}} rules selected",
  automationSessionSaveFailed: "Failed to update automation for this session.",
  collaborationComposerTitle: "Collaborate with {{name}}",
  collaborationComposerModeLabel: "Mode",
  collaborationComposerModePlaceholder: "Choose a required mode",
  collaborationComposerModeRequired:
    "Choose Fork, Delegate, or Handoff before sending.",
  collaborationComposerContextLabel: "Shared context",
  collaborationComposerContextNone: "None",
  collaborationComposerContextRecent: "Recent (up to 12 messages)",
  collaborationComposerContextFull: "Full (up to 48 messages)",
  collaborationComposerContextPreview: "Preview shared context ({{count}})",
  collaborationComposerContextLoading: "Loading context preview…",
  collaborationComposerContextEmpty: "No user or assistant messages selected.",
  collaborationComposerContextLoadFailed:
    "The context preview could not be loaded. Choose None or try again.",
  collaborationComposerContextSupplementLabel: "Additional context",
  collaborationComposerContextSupplementPlaceholder:
    "Optional instructions or context for the target Agent",
  collaborationComposerNoSession:
    "Open a source session before collaborating with an Agent.",
  collaborationComposerUnavailable:
    "This host cannot start Agent collaboration yet.",
  collaborationComposerPolicyDenied:
    "The Agent owner's policy does not allow delegation.",
  collaborationComposerSingleAgentOnly:
    "Use one Agent mention per message so each collaboration has an explicit mode and context.",
  collaborationComposerAttachmentsUnsupported:
    "Direct Agent collaboration cannot carry attachments yet. Insert them as @ references or remove them before sending.",
  collaborationComposerStartFailed: "Failed to start Agent collaboration.",
  collaborationComposerRetry: "Retry",
  collaborationComposerChooseAnotherMode: "Use another mode",
  collaborationComposerReturnToSession: "Return to original session"
} as const;
