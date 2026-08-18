export const zhCNAgentGuiHomeSuggestions = {
  homeSuggestionsClose: "收起建议",
  homeSuggestions: {
    about: {
      title: "认识 Tutti",
      prompt: "介绍一下 Tutti 能帮我做些什么"
    },
    cloneGithubRepository: {
      title: "克隆 GitHub 仓库",
      prompt: "帮我克隆 GitHub 仓库 { 仓库地址 }，完成后告诉我仓库目录"
    },
    breakdown: {
      title: "任务拆解",
      taskCenterLabel: "任务管理",
      prompt: "使用 {{taskCenterMention}} 帮我拆解任务，任务主题 { 请输入 }"
    },
    review: {
      title: "质量审查",
      prompt: "让 { @agent } 审查 { @agent 会话 } 的产物质量"
    },
    interaction: {
      title: "Agent 互动",
      prompt: "让 { @agent } 和 { @agent } 一起 { 做些什么 }，主题 { 请输入 }"
    },
    import: {
      title: "导入会话"
    }
  }
} as const;
