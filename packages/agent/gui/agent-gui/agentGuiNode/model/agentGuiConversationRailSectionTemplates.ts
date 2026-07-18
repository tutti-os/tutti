import type { ConversationSection } from "../agentGuiNodeViewConversation";
import {
  partitionConversationRailUserProjects,
  type ConversationRailLabels
} from "./agentGuiConversationRail";
import type { AgentGUINodeViewModel } from "./agentGuiNodeTypes";

export function preserveConversationRailSectionTemplates(input: {
  labels: ConversationRailLabels;
  sections: readonly ConversationSection[];
  userProjects: AgentGUINodeViewModel["rail"]["userProjects"];
}): ConversationSection[] {
  const existingById = new Map(
    input.sections.map((section) => [section.id, section] as const)
  );
  const result: ConversationSection[] = [];
  const pinned = existingById.get("pinned");
  if (pinned && pinned.items.length > 0) {
    result.push(pinned);
  }
  existingById.delete("pinned");

  const projectSectionKeys = new Set<string>();
  for (const project of partitionConversationRailUserProjects(
    input.userProjects
  )) {
    const sectionKey = project.sectionKey?.trim() ?? "";
    if (!sectionKey || projectSectionKeys.has(sectionKey)) continue;
    projectSectionKeys.add(sectionKey);
    const existing = existingById.get(sectionKey);
    result.push({
      id: sectionKey,
      kind: "project",
      label: project.label,
      project,
      items: existing?.items ?? []
    });
    existingById.delete(sectionKey);
  }

  const conversations = existingById.get("conversations");
  result.push(
    conversations ?? {
      id: "conversations",
      kind: "conversations",
      label: input.labels.sectionConversations,
      project: null,
      items: []
    }
  );
  return result;
}
