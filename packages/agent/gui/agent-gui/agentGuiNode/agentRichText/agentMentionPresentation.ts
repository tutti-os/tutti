import type { AgentContextMentionItem } from "./agentFileMentionContracts";
import { normalizeAgentSessionMentionTitle } from "./agentMentionMarkdown";

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
    const visual = sessionMentionVisual(item);
    return {
      kindLabel: "Session",
      primary: `${visual.participant} ${visual.summary}`.trim()
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

export function sessionMentionVisual(
  item: Extract<AgentContextMentionItem, { kind: "session" }>
): {
  participant: string;
  summary: string;
} {
  const initiatorName = item.initiatorName.trim();
  const agentName = item.agentName.trim();
  const title = normalizeAgentSessionMentionTitle(item.title);
  if (initiatorName && agentName) {
    const dottedTitle = parseDottedSessionMentionText(title);
    return {
      participant: `${initiatorName} & ${agentName}`,
      summary:
        dottedTitle?.summary ||
        (title && title !== item.name.trim()
          ? title
          : item.inputPreview?.trim() || "")
    };
  }

  const dottedName = parseDottedSessionMentionText(item.name);
  if (dottedName) {
    return {
      participant: dottedName.participant,
      summary: dottedName.summary
    };
  }

  return {
    participant: item.name.trim(),
    summary:
      title && title !== item.name.trim()
        ? title
        : item.inputPreview?.trim() || ""
  };
}

export function parseDottedSessionMentionText(
  value: string
): { participant: string; summary: string } | null {
  const parts = value
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  return {
    participant: `${parts[0]} & ${parts[1]}`,
    summary: normalizeAgentSessionMentionTitle(parts.slice(2).join(" "))
  };
}
