// Model access plan and model choice history copy for the agent GUI. Split
// from zh-CN.agentGui.ts to keep that module under the 800-line budget.
// Chinese copy must not end with a Chinese full stop (。).
export const zhCNAgentGuiModelPlans = {
  composerModelPlanBadge: "方案：{{name}}",
  composerModelSearchPlaceholder: "搜索模型",
  composerModelSearchEmpty: "没有匹配的模型",
  composerModelFavoritesGroup: "收藏",
  composerModelRecentsGroup: "最近使用",
  composerModelSwitchNextTurnHint: "下一次调用生效",
  composerModelFavoriteAdd: "添加到收藏",
  composerModelFavoriteRemove: "取消收藏"
} as const;
