import type { AgentContextMentionItem } from "./agentFileMentionContracts";
import { managedAgentRoundedIconUrl } from "../../../shared/managedAgentIcons";
import { agentSessionTargetIdFromHref } from "./agentMentionMarkdown";

export function resolveAgentSessionMentionIconUrl(input: {
  agentIconUrl?: string | null;
  agentTargetId?: string | null;
  href?: string | null;
}): string | undefined {
  const explicitIconUrl = input.agentIconUrl?.trim() ?? "";
  if (explicitIconUrl) {
    return explicitIconUrl;
  }
  const agentTargetId =
    input.agentTargetId?.trim() ||
    agentSessionTargetIdFromHref(input.href?.trim() ?? "") ||
    "";
  if (!agentTargetId.startsWith("local:")) {
    return undefined;
  }
  const provider = agentTargetId.slice("local:".length).trim();
  return provider ? managedAgentRoundedIconUrl(provider) : undefined;
}

export function mentionVisual(item: AgentContextMentionItem): {
  kindLabel: string;
  primary: string;
} {
  if (item.kind === "file") {
    return {
      kindLabel: "File",
      primary: item.name
    };
  }
  if (item.kind === "session") {
    return {
      kindLabel: "Session",
      primary: item.title.trim() || item.name.trim()
    };
  }
  if (item.kind === "workspace-app") {
    return {
      kindLabel: "App",
      primary: item.name
    };
  }
  if (item.kind === "agent-target") {
    return {
      kindLabel: "Agent",
      primary: item.name
    };
  }
  if (item.kind === "workspace-app-factory") {
    return {
      kindLabel: "App Factory",
      primary: item.name
    };
  }
  if (item.kind === "workspace-reference") {
    return {
      kindLabel: "Reference",
      primary: item.name
    };
  }
  if (item.kind === "custom") {
    return {
      kindLabel: "Reference",
      primary: item.name
    };
  }
  return {
    kindLabel: "Task",
    primary: item.name
  };
}
