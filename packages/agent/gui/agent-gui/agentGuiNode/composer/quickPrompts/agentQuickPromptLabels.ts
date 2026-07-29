import type { TranslateFn } from "../../../../i18n";

export interface AgentQuickPromptTemplate {
  content: string;
  description: string;
  id:
    | "summary-common-prompts"
    | "understand-context"
    | "create-action-plan"
    | "review-and-improve"
    | "draft-clear-update";
  title: string;
}

export interface AgentQuickPromptLabels {
  add: string;
  cancel: string;
  conflict: string;
  contentLabel: string;
  contentPlaceholder: string;
  createTitle: string;
  createFromTemplate: string;
  delete: string;
  deleteConfirm: string;
  deleteDescription: (title: string) => string;
  deleteTitle: string;
  deleting: string;
  dragCancel: (title: string, position: number, total: number) => string;
  dragDrop: (title: string, position: number, total: number) => string;
  dragHandle: (title: string) => string;
  dragInstructions: string;
  dragMove: (title: string, position: number, total: number) => string;
  dragStart: (title: string, position: number, total: number) => string;
  edit: string;
  editTitle: string;
  empty: string;
  finishSorting: string;
  loadError: string;
  loading: string;
  moreActions: string;
  mutationError: string;
  noResults: string;
  required: string;
  reorderConflict: string;
  reorderError: string;
  retry: string;
  save: string;
  saving: string;
  searchPlaceholder: string;
  startSorting: string;
  recommendedTemplates: readonly AgentQuickPromptTemplate[];
  recommendedTemplatesDescription: string;
  recommendedTemplatesTitle: string;
  returnToPrompts: string;
  title: string;
  titleLabel: string;
  titlePlaceholder: string;
  titleTooLong: string;
  contentTooLarge: string;
  trigger: string;
  triggerTooltip: string;
  useTemplate: string;
}

export function agentQuickPromptLabels(t: TranslateFn): AgentQuickPromptLabels {
  return {
    add: t("agentHost.agentGui.quickPrompts.add"),
    cancel: t("common.cancel"),
    conflict: t("agentHost.agentGui.quickPrompts.conflict"),
    contentLabel: t("agentHost.agentGui.quickPrompts.contentLabel"),
    contentPlaceholder: t("agentHost.agentGui.quickPrompts.contentPlaceholder"),
    contentTooLarge: t("agentHost.agentGui.quickPrompts.contentTooLarge"),
    createTitle: t("agentHost.agentGui.quickPrompts.createTitle"),
    createFromTemplate: t("agentHost.agentGui.quickPrompts.createFromTemplate"),
    delete: t("agentHost.agentGui.quickPrompts.delete"),
    deleteConfirm: t("agentHost.agentGui.quickPrompts.deleteConfirm"),
    deleteDescription: (title) =>
      t("agentHost.agentGui.quickPrompts.deleteDescription", { title }),
    deleteTitle: t("agentHost.agentGui.quickPrompts.deleteTitle"),
    deleting: t("agentHost.agentGui.quickPrompts.deleting"),
    dragCancel: (title, position, total) =>
      t("agentHost.agentGui.quickPrompts.dragCancel", {
        title,
        position,
        total
      }),
    dragDrop: (title, position, total) =>
      t("agentHost.agentGui.quickPrompts.dragDrop", {
        title,
        position,
        total
      }),
    dragHandle: (title) =>
      t("agentHost.agentGui.quickPrompts.dragHandle", { title }),
    dragInstructions: t("agentHost.agentGui.quickPrompts.dragInstructions"),
    dragMove: (title, position, total) =>
      t("agentHost.agentGui.quickPrompts.dragMove", {
        title,
        position,
        total
      }),
    dragStart: (title, position, total) =>
      t("agentHost.agentGui.quickPrompts.dragStart", {
        title,
        position,
        total
      }),
    edit: t("agentHost.agentGui.quickPrompts.edit"),
    editTitle: t("agentHost.agentGui.quickPrompts.editTitle"),
    empty: t("agentHost.agentGui.quickPrompts.empty"),
    finishSorting: t("agentHost.agentGui.quickPrompts.finishSorting"),
    loadError: t("agentHost.agentGui.quickPrompts.loadError"),
    loading: t("agentHost.agentGui.quickPrompts.loading"),
    moreActions: t("agentHost.agentGui.quickPrompts.moreActions"),
    mutationError: t("agentHost.agentGui.quickPrompts.mutationError"),
    noResults: t("agentHost.agentGui.quickPrompts.noResults"),
    required: t("agentHost.agentGui.quickPrompts.required"),
    reorderConflict: t("agentHost.agentGui.quickPrompts.reorderConflict"),
    reorderError: t("agentHost.agentGui.quickPrompts.reorderError"),
    retry: t("agentHost.agentGui.quickPrompts.retry"),
    save: t("agentHost.agentGui.quickPrompts.save"),
    saving: t("agentHost.agentGui.quickPrompts.saving"),
    searchPlaceholder: t("agentHost.agentGui.quickPrompts.searchPlaceholder"),
    startSorting: t("agentHost.agentGui.quickPrompts.startSorting"),
    recommendedTemplates: [
      {
        id: "summary-common-prompts",
        title: t(
          "agentHost.agentGui.quickPrompts.recommendedTemplates.summaryCommonPrompts.title"
        ),
        description: t(
          "agentHost.agentGui.quickPrompts.recommendedTemplates.summaryCommonPrompts.description"
        ),
        content: t(
          "agentHost.agentGui.quickPrompts.recommendedTemplates.summaryCommonPrompts.content"
        )
      },
      {
        id: "understand-context",
        title: t(
          "agentHost.agentGui.quickPrompts.recommendedTemplates.understandContext.title"
        ),
        description: t(
          "agentHost.agentGui.quickPrompts.recommendedTemplates.understandContext.description"
        ),
        content: t(
          "agentHost.agentGui.quickPrompts.recommendedTemplates.understandContext.content"
        )
      },
      {
        id: "create-action-plan",
        title: t(
          "agentHost.agentGui.quickPrompts.recommendedTemplates.createActionPlan.title"
        ),
        description: t(
          "agentHost.agentGui.quickPrompts.recommendedTemplates.createActionPlan.description"
        ),
        content: t(
          "agentHost.agentGui.quickPrompts.recommendedTemplates.createActionPlan.content"
        )
      },
      {
        id: "review-and-improve",
        title: t(
          "agentHost.agentGui.quickPrompts.recommendedTemplates.reviewAndImprove.title"
        ),
        description: t(
          "agentHost.agentGui.quickPrompts.recommendedTemplates.reviewAndImprove.description"
        ),
        content: t(
          "agentHost.agentGui.quickPrompts.recommendedTemplates.reviewAndImprove.content"
        )
      },
      {
        id: "draft-clear-update",
        title: t(
          "agentHost.agentGui.quickPrompts.recommendedTemplates.draftClearUpdate.title"
        ),
        description: t(
          "agentHost.agentGui.quickPrompts.recommendedTemplates.draftClearUpdate.description"
        ),
        content: t(
          "agentHost.agentGui.quickPrompts.recommendedTemplates.draftClearUpdate.content"
        )
      }
    ],
    recommendedTemplatesDescription: t(
      "agentHost.agentGui.quickPrompts.recommendedTemplatesDescription"
    ),
    recommendedTemplatesTitle: t(
      "agentHost.agentGui.quickPrompts.recommendedTemplatesTitle"
    ),
    returnToPrompts: t("agentHost.agentGui.quickPrompts.returnToPrompts"),
    title: t("agentHost.agentGui.quickPrompts.title"),
    titleLabel: t("agentHost.agentGui.quickPrompts.titleLabel"),
    titlePlaceholder: t("agentHost.agentGui.quickPrompts.titlePlaceholder"),
    titleTooLong: t("agentHost.agentGui.quickPrompts.titleTooLong"),
    trigger: t("agentHost.agentGui.quickPrompts.trigger"),
    triggerTooltip: t("agentHost.agentGui.quickPrompts.triggerTooltip"),
    useTemplate: t("agentHost.agentGui.quickPrompts.useTemplate")
  };
}
