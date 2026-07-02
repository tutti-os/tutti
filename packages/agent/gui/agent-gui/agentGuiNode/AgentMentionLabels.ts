import { translate } from "../../i18n/index";
import type {
  AgentMentionFilterId,
  AgentMentionGroupId
} from "./AgentMentionSearchController";

export function agentMentionGroupLabel(groupId: AgentMentionGroupId): string {
  switch (groupId) {
    case "apps":
      return translate("agentHost.agentGui.mentionGroupApps");
    case "agents":
      return translate("agentHost.agentGui.mentionGroupAgents");
    case "files":
      return translate("agentHost.agentGui.mentionGroupFiles");
    case "opened_files":
      return translate("agentHost.agentGui.mentionGroupOpenedFiles");
    case "agent_generated_files":
      return translate("agentHost.agentGui.mentionGroupAgentGeneratedFiles");
    case "my_sessions":
      return translate("agentHost.agentGui.mentionGroupMySessions");
    case "collab_sessions":
      return translate("agentHost.agentGui.mentionGroupCollabSessions");
    case "issues":
      return translate("agentHost.agentGui.mentionGroupIssues");
  }
}

export function agentMentionFilterLabel(filter: AgentMentionFilterId): string {
  switch (filter) {
    case "app":
      return translate("agentHost.agentGui.mentionFilterApp");
    case "agent":
      return translate("agentHost.agentGui.mentionFilterAgent");
    case "file":
      return translate("agentHost.agentGui.mentionFilterFile");
    case "session":
      return translate("agentHost.agentGui.mentionFilterSession");
    case "issue":
      return translate("agentHost.agentGui.mentionFilterIssue");
  }
}

export function agentMentionEmptyGroupLabel(
  groupId: AgentMentionGroupId,
  query: string
): string {
  if (groupId === "files" || groupId === "opened_files") {
    return query.trim()
      ? translate("agentHost.agentGui.mentionNoMatchingFiles")
      : translate("agentHost.agentGui.mentionEmptyDockFiles");
  }
  if (groupId === "agent_generated_files") {
    return query.trim()
      ? translate("agentHost.agentGui.mentionNoMatchingFiles")
      : translate("agentHost.agentGui.mentionEmptyAgentGeneratedFiles");
  }
  if (groupId === "apps") {
    return translate("agentHost.agentGui.mentionEmptyApps");
  }
  if (groupId === "agents") {
    return translate("agentHost.agentGui.mentionEmptyAgents");
  }
  if (groupId === "my_sessions") {
    return translate("agentHost.agentGui.mentionEmptyMySessions");
  }
  if (groupId === "collab_sessions") {
    return translate("agentHost.agentGui.mentionEmptyCollabSessions");
  }
  return translate("agentHost.agentGui.mentionEmptyIssues");
}
