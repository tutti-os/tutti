import type { TranslateFn } from "../../../i18n/index";
import type { AgentGUIConversationRailLabels } from "./AgentGUINodeView.types";

export type { AgentGUIConversationRailLabels } from "./AgentGUINodeView.types";

export function agentGUIConversationRailLabels(
  t: TranslateFn
): AgentGUIConversationRailLabels {
  return {
    batchDeleteConversations: t("agentHost.agentGui.batchDeleteConversations"),
    batchDeleteConversationsBody: (count: number) =>
      t("agentHost.agentGui.batchDeleteConversationsBody", { count }),
    batchDeleteConversationsConfirm: t(
      "agentHost.agentGui.batchDeleteConversationsConfirm"
    ),
    batchDeleteConversationsTitle: t(
      "agentHost.agentGui.batchDeleteConversationsTitle"
    ),
    batchDeleteProjectSessions: t(
      "agentHost.agentGui.batchDeleteProjectSessions"
    ),
    batchDeleteProjectSessionsBody: (count: number, project: string) =>
      t("agentHost.agentGui.batchDeleteProjectSessionsBody", {
        count,
        project
      }),
    batchDeleteProjectSessionsConfirm: t(
      "agentHost.agentGui.batchDeleteProjectSessionsConfirm"
    ),
    batchDeleteProjectSessionsTitle: t(
      "agentHost.agentGui.batchDeleteProjectSessionsTitle"
    ),
    cancel: t("common.cancel"),
    conversationUnavailable: t("agentHost.agentGui.conversationUnavailable"),
    conversationsSectionMoreActions: t(
      "agentHost.agentGui.conversationsSectionMoreActions"
    ),
    copiedToClipboard: t("agentHost.agentGui.copiedToClipboard"),
    copyAsMarkdown: t("agentHost.agentGui.copyAsMarkdown"),
    copyAsReference: t("agentHost.agentGui.copyAsReference"),
    copyFailed: t("agentHost.agentGui.copyFailed"),
    conversationCopyFile: t("agentHost.agentGui.conversationCopyFile"),
    conversationCopyImage: t("agentHost.agentGui.conversationCopyImage"),
    conversationCopyImagesOmitted: t(
      "agentHost.agentGui.conversationCopyImagesOmitted"
    ),
    conversationCopyInProgress: t(
      "agentHost.agentGui.conversationCopyInProgress"
    ),
    conversationCopyMentionPrefix: t(
      "agentHost.agentGui.conversationCopyMentionPrefix"
    ),
    conversationCopyPreviousMessages: t(
      "agentHost.agentGui.conversationCopyPreviousMessages"
    ),
    moreSessionActions: t("agentHost.agentGui.moreSessionActions"),
    deleteSession: t("agentHost.agentGui.deleteSession"),
    deleteSessionConfirm: t("agentHost.agentGui.deleteSessionConfirm"),
    emptyProjectConversations: t(
      "agentHost.agentGui.emptyProjectConversations"
    ),
    loadingConversations: t("agentHost.agentGui.loadingConversations"),
    markSessionUnread: t("agentHost.agentGui.markSessionUnread"),
    newConversation: t("agentHost.agentGui.newConversation"),
    noConversations: t("agentHost.agentGui.noConversations"),
    openConversationWindow: t("agentHost.agentGui.openConversationWindow"),
    pinProject: t("agentHost.agentGui.pinProject"),
    pinSession: t("agentHost.agentGui.pinSession"),
    pinnedProjectAccessibleName: (projectLabel: string) =>
      t("agentHost.agentGui.pinnedProjectAccessibleName", {
        project: projectLabel
      }),
    projectRailCreateProject: t("agentHost.agentGui.projectRailCreateProject"),
    projectRailLinkExistingProject: t(
      "agentHost.agentGui.projectRailLinkExistingProject"
    ),
    projectSectionEdit: t("agentHost.agentGui.projectSectionEdit"),
    projectSectionMoreActions: t(
      "agentHost.agentGui.projectSectionMoreActions"
    ),
    projectSectionViewFiles: t("agentHost.agentGui.projectSectionViewFiles"),
    relativeTimeDays: (count: number) =>
      t("agentHost.agentGui.relativeTimeDays", { count }),
    relativeTimeHours: (count: number) =>
      t("agentHost.agentGui.relativeTimeHours", { count }),
    relativeTimeJustNow: t("agentHost.agentGui.relativeTimeJustNow"),
    relativeTimeMinutes: (count: number) =>
      t("agentHost.agentGui.relativeTimeMinutes", { count }),
    relativeTimeMonths: (count: number) =>
      t("agentHost.agentGui.relativeTimeMonths", { count }),
    relativeTimeYears: (count: number) =>
      t("agentHost.agentGui.relativeTimeYears", { count }),
    removeProject: t("agentHost.agentGui.removeProject"),
    removeProjectConfirmDescription: (projectLabel: string) =>
      t("agentHost.agentGui.removeProjectConfirmDescription", {
        project: projectLabel
      }),
    removeProjectConfirmTitle: t(
      "agentHost.agentGui.removeProjectConfirmTitle"
    ),
    renameSession: t("agentHost.agentGui.renameSession"),
    retrySearch: t("agentHost.agentGui.retrySearch"),
    searchFailed: t("agentHost.agentGui.searchFailed"),
    searchNoConversations: t("agentHost.agentGui.searchNoConversations"),
    searchPlaceholder: t("agentHost.agentGui.searchPlaceholder"),
    sectionConversations: t("agentHost.agentGui.sectionConversations"),
    sectionPinned: t("agentHost.agentGui.sectionPinned"),
    selectConversation: t("agentHost.agentGui.selectConversation"),
    showLessConversations: t("agentHost.agentGui.showLessConversations"),
    showMoreConversations: t("agentHost.agentGui.showMoreConversations"),
    startConversation: t("agentHost.agentGui.startConversation"),
    unpinProject: t("agentHost.agentGui.unpinProject"),
    unpinSession: t("agentHost.agentGui.unpinSession"),
    untitledConversationTitle: t(
      "agentHost.workspaceAgentsUntitledConversation"
    )
  };
}
