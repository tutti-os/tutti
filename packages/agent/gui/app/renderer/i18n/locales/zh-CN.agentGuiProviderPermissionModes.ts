export const zhCNAgentGuiProviderPermissionModes = {
  nexight: {
    "read-only": {
      label: "请求批准",
      description: "编辑外部文件或使用互联网前始终询问你"
    },
    auto: {
      label: "替我审批",
      description: "仅在检测到可能不安全的操作时询问你"
    },
    "full-access": {
      label: "完全访问",
      description: "可不受限制地访问互联网和你电脑上的任何文件"
    }
  },
  "acp:codebuddy": {
    dontAsk: {
      label: "不再询问",
      description: "不会弹出确认；未预先允许的操作会被直接拒绝"
    },
    bypassPermissions: {
      label: "跳过权限提示",
      description: "跳过权限提示，但仍保留安全检查"
    },
    fullAccess: {
      label: "完全访问权限",
      description: "跳过所有权限检查，包括所有 Agent 的危险命令"
    },
    plan: {
      label: "计划模式",
      description: "只分析和规划，不修改文件或执行命令"
    }
  }
};
