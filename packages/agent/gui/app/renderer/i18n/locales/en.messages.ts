export const enMessages = {
  agentLaunchFailed: "Agent launch failed: {{message}}",
  agentResumeFailed: "Agent resume failed: {{message}}",
  agentProviderSessionNotFound:
    "This session history is still available, but the underlying provider session can no longer be restored.",
  agentResumeSessionNotLocal:
    "This session cannot be resumed on this device. Start a new session and @this session to keep going.",
  agentSettingsRequireNewSession:
    "This model can only be used in a new session to preserve context.",
  agentPermissionModeAppliesNextTurn:
    "Permission mode will apply starting with your next message.",
  agentThisSessionMentionLabel: "this session",
  terminalLaunchFailed: "Terminal launch failed: {{message}}",
  fallbackTerminalFailed: "Fallback terminal launch also failed: {{message}}",
  agentPromptRequired: "Agent prompt cannot be empty.",
  resumeSessionMissing:
    "This agent does not have a verified resumeSessionId yet.",
  noTerminalSlotNearby:
    "No room nearby in the current view. Move or close some terminal windows first.",
  noWindowSlotOnRight:
    "No room to the right of the current agent. Move or close some windows first.",
  noWindowSlotNearby:
    "No room nearby in the current view. Move or close some windows first.",
  agentManageSyncSuccess: "Sync success",
  agentManageInstallSuccess: "Install success"
} as const;
