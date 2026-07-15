import type { TranslateFn } from "../../../i18n/index";
import type { AgentGUIViewLabels } from "./AgentGUINodeView.types";

type AgentGUIConversationRailLabels = Pick<
  AgentGUIViewLabels,
  | "conversationUnavailable"
  | "emptyProjectConversations"
  | "loadingConversations"
  | "noConversations"
  | "retrySearch"
  | "searchFailed"
  | "searchNoConversations"
  | "searchPlaceholder"
  | "sectionConversations"
  | "sectionPinned"
  | "selectConversation"
  | "startConversation"
>;

export function agentGUIConversationRailLabels(
  t: TranslateFn
): AgentGUIConversationRailLabels {
  return {
    conversationUnavailable: t("agentHost.agentGui.conversationUnavailable"),
    emptyProjectConversations: t(
      "agentHost.agentGui.emptyProjectConversations"
    ),
    loadingConversations: t("agentHost.agentGui.loadingConversations"),
    noConversations: t("agentHost.agentGui.noConversations"),
    retrySearch: t("agentHost.agentGui.retrySearch"),
    searchFailed: t("agentHost.agentGui.searchFailed"),
    searchNoConversations: t("agentHost.agentGui.searchNoConversations"),
    searchPlaceholder: t("agentHost.agentGui.searchPlaceholder"),
    sectionConversations: t("agentHost.agentGui.sectionConversations"),
    sectionPinned: t("agentHost.agentGui.sectionPinned"),
    selectConversation: t("agentHost.agentGui.selectConversation"),
    startConversation: t("agentHost.agentGui.startConversation")
  };
}
