// Model access plan and model choice history copy for the agent GUI. Split
// from en.agentGui.ts to keep that module under the 800-line budget.
export const enAgentGuiModelPlans = {
  composerModelPlanBadge: "Plan: {{name}}",
  composerModelSearchPlaceholder: "Search models",
  composerModelSearchEmpty: "No matching models",
  composerModelFavoritesGroup: "Favorites",
  composerModelRecentsGroup: "Recently used",
  composerModelSwitchNextTurnHint: "Applies from the next request",
  composerModelFavoriteAdd: "Add to favorites",
  composerModelFavoriteRemove: "Remove from favorites"
} as const;
