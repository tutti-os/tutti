export const enAgentGuiQuickPrompts = {
  add: "New prompt",
  conflict:
    "This prompt changed in another window. Refresh it and review your draft before saving again.",
  contentLabel: "Prompt",
  contentPlaceholder: "Write the reusable prompt text",
  contentTooLarge: "Prompt text must be 32 KiB or less",
  createTitle: "New quick prompt",
  createFromTemplate: "Create from a recommended template",
  delete: "Delete",
  deleteConfirm: "Delete prompt",
  deleteDescription: 'Delete "{{title}}"? This cannot be undone.',
  deleteTitle: "Delete quick prompt?",
  deleting: "Deleting…",
  dragCancel:
    'Sorting canceled. "{{title}}" returned to position {{position}} of {{total}}.',
  dragDrop: '"{{title}}" was placed at position {{position}} of {{total}}.',
  dragHandle: 'Reorder "{{title}}"',
  dragInstructions:
    "Press Space or Enter to pick up, use arrow keys to move, then press Space or Enter to drop. Press Escape to cancel.",
  dragMove: '"{{title}}" is moving to position {{position}} of {{total}}.',
  dragStart: 'Picked up "{{title}}", position {{position}} of {{total}}.',
  edit: "Edit",
  editTitle: "Edit quick prompt",
  empty: "No quick prompts yet",
  loadError: "Quick prompts could not be loaded",
  loading: "Loading quick prompts…",
  moreActions: "More prompt actions",
  mutationError: "The prompt could not be saved. Try again.",
  noResults: "No matching quick prompts",
  required: "Title and prompt text are required",
  reorderConflict:
    "The prompt order changed in another window. Refresh and drag again.",
  reorderError: "The prompt order could not be saved. Try dragging again.",
  retry: "Try again",
  recommendedTemplates: {
    understandContext: {
      title: "Understand the situation",
      description: "Summarize context, constraints, risks, and next steps",
      content:
        "First summarize the current context, confirmed facts, constraints, risks, and open questions. Separate facts from assumptions, then recommend the smallest useful next step."
    },
    createActionPlan: {
      title: "Create an action plan",
      description: "Break a goal into prioritized, verifiable steps",
      content:
        "Break this goal into prioritized, verifiable steps. Identify dependencies, risks, and acceptance criteria for each step, then recommend the best place to begin."
    },
    reviewAndImprove: {
      title: "Review and improve",
      description: "Find gaps, risks, and practical improvements",
      content:
        "Review the following work. Identify what is good, what is missing, the important risks, and practical improvements. Prioritize the recommendations by impact and effort."
    },
    draftClearUpdate: {
      title: "Draft a clear update",
      description: "Write a concise explanation for the intended audience",
      content:
        "Draft a concise update for the intended audience. State the key message first, include only the necessary context, make the requested decision or next action explicit, and use clear language."
    }
  },
  recommendedTemplatesDescription:
    "Choose one to prefill the editor. It will not be saved or sent until you choose Save.",
  recommendedTemplatesTitle: "Recommended templates",
  returnToPrompts: "My prompts",
  save: "Save",
  saving: "Saving…",
  searchPlaceholder: "Search quick prompts",
  title: "Quick prompts",
  titleLabel: "Title",
  titlePlaceholder: "Give this prompt a short name",
  titleTooLong: "Title must be 80 characters or less",
  trigger: "Prompts",
  triggerTooltip: "Choose a quick prompt",
  useTemplate: "Use template"
} as const;
