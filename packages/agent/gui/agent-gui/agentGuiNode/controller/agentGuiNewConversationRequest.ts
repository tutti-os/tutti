import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type { AgentGUIConversationUserProject } from "../model/agentGuiConversationProjectResolver";
import { resolveConversationSummaryById } from "./useAgentConversationSelection";

export interface AgentGUINewConversationRequestOptions {
  projectPath?: string | null;
  source?: string;
}

export type AgentGUINewConversationProjectSelection =
  | { kind: "preserve_home" }
  | { kind: "replace"; projectPath: string | null }
  | { kind: "unresolved" };

export function requestAgentGUINewConversation(input: {
  createConversation(options: AgentGUINewConversationRequestOptions): void;
  activeConversationId: string | null;
  conversations: readonly AgentGUIConversationSummary[];
  transientConversation: AgentGUIConversationSummary | null;
  userProjects: readonly AgentGUIConversationUserProject[];
  options?: AgentGUINewConversationRequestOptions;
}): boolean {
  if (input.options && "projectPath" in input.options) {
    input.createConversation(input.options);
    return true;
  }
  const selection = resolveAgentGUINewConversationProjectSelection({
    activeConversationId: input.activeConversationId,
    conversations: input.conversations,
    transientConversation: input.transientConversation,
    userProjects: input.userProjects
  });
  if (selection.kind === "unresolved") {
    return false;
  }
  if (selection.kind === "preserve_home") {
    input.createConversation(input.options ?? {});
    return true;
  }
  input.createConversation({
    ...input.options,
    projectPath: selection.projectPath
  });
  return true;
}

export function resolveAgentGUINewConversationProjectSelection(input: {
  activeConversationId: string | null;
  conversations: readonly AgentGUIConversationSummary[];
  transientConversation: AgentGUIConversationSummary | null;
  userProjects: readonly AgentGUIConversationUserProject[];
}): AgentGUINewConversationProjectSelection {
  if (input.activeConversationId === null) {
    return { kind: "preserve_home" };
  }
  const activeConversation = resolveConversationSummaryById(
    input.conversations,
    input.activeConversationId,
    input.transientConversation
  );
  if (!activeConversation) {
    return { kind: "unresolved" };
  }
  const sectionKey = activeConversation.railSectionKey?.trim() ?? "";
  if (sectionKey === "conversations") {
    return { kind: "replace", projectPath: null };
  }
  if (!sectionKey) {
    return { kind: "unresolved" };
  }
  const projectPath =
    input.userProjects
      .find((project) => project.sectionKey?.trim() === sectionKey)
      ?.path.trim() ?? "";
  return projectPath
    ? { kind: "replace", projectPath }
    : { kind: "unresolved" };
}
