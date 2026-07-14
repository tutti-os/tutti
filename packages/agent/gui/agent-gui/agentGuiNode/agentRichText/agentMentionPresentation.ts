import type { AgentContextMentionItem } from "./agentFileMentionContracts";

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
