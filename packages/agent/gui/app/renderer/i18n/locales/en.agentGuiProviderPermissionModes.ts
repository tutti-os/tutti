export const enAgentGuiProviderPermissionModes = {
  nexight: {
    "read-only": {
      label: "Ask for approval",
      description: "Always ask to edit external files and use the internet"
    },
    auto: {
      label: "Approve for me",
      description: "Only ask for actions detected as potentially unsafe"
    },
    "full-access": {
      label: "Full access",
      description:
        "Unrestricted access to the internet and any file on your computer"
    }
  },
  "acp:codebuddy": {
    dontAsk: {
      label: "Don't ask",
      description:
        "Won't prompt for approval. Actions not already allowed are rejected."
    },
    bypassPermissions: {
      label: "Skip permission prompts",
      description: "Skips permission prompts while keeping safety checks."
    },
    fullAccess: {
      label: "Full access",
      description:
        "Skips all permission checks, including dangerous commands, for every agent."
    },
    plan: {
      label: "Plan mode",
      description:
        "Analyzes and plans without modifying files or running commands."
    }
  }
};
