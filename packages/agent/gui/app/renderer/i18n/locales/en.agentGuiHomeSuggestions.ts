export const enAgentGuiHomeSuggestions = {
  homeSuggestionsClose: "Close suggestions",
  homeSuggestions: {
    about: {
      title: "Meet Tutti",
      prompt: "Tell me what Tutti can help me do"
    },
    cloneGithubRepository: {
      title: "Clone GitHub repository",
      prompt:
        "Help me clone the GitHub repository { repository URL }, then tell me its local directory"
    },
    breakdown: {
      title: "Task breakdown",
      taskCenterLabel: "Task management",
      prompt:
        "Use {{taskCenterMention}} to help me break down the task, topic { enter here }"
    },
    review: {
      title: "Quality review",
      prompt: "Have { @agent } review the output quality of { @agent session }"
    },
    interaction: {
      title: "Agent interaction",
      prompt:
        "Have { @agent } and { @agent } work together to { do something }, topic { enter here }"
    },
    import: {
      title: "Import session"
    }
  }
} as const;
