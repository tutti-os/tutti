export const enTuttiModePlan = {
  mode: "Tutti mode plan",
  taskReview: "Plan review",
  pending: "Needs review",
  cancel: "Cancel plan",
  reviewHint: "Send to accept · type feedback to request changes",
  reviewHintReplan: "Intensity changed · send to re-plan at the new intensity",
  sendAccept: "Accept plan",
  sendRequestChanges: "Request changes",
  replanFeedback:
    "Intensity was adjusted from {{from}} to {{to}}. Re-plan at the new intensity: rescale the task decomposition granularity and each task's model/reasoning tier.",
  replanFeedbackSuffix:
    " (Intensity was adjusted to {{to}}; re-plan accordingly.)",
  tasks: "Tasks",
  priority: "Priority",
  priorityHigh: "High",
  priorityMedium: "Medium",
  priorityLow: "Low",
  agentTarget: "Agent",
  model: "Model",
  permissionMode: "Permission mode",
  reasoningEffort: "Reasoning effort",
  parallelizable: "Parallel",
  assignmentOptionsLoading: "Loading options...",
  notSpecified: "Not specified",
  loadFailed: "Tutti mode plans could not be loaded",
  retry: "Try again"
} as const;
