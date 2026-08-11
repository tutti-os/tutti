import {
  normalizeWorkspaceUserProjectPath,
  resolveWorkspaceUserProjectDisplayLabel,
  workspaceUserProjectPathIdentityKey
} from "@tutti-os/workspace-user-project/core";
import type { AgentHostUserProject } from "../../../host/agentHostApi";

const AGENT_GUI_CONVERSATION_PROJECT_SUMMARY_CACHE_LIMIT = 512;
const agentGUIConversationProjectSummaryCache = new Map<
  string,
  AgentGUIConversationProjectSummary
>();

export interface AgentGUIConversationProjectSummary {
  id: string;
  path: string;
  label: string;
  sectionKey?: string;
  createdAtUnixMs?: number;
  updatedAtUnixMs?: number;
  lastUsedAtUnixMs?: number;
  pinnedAtUnixMs: number;
}

export type AgentGUIConversationUserProject = Pick<
  AgentHostUserProject,
  | "id"
  | "path"
  | "label"
  | "sectionKey"
  | "createdAtUnixMs"
  | "updatedAtUnixMs"
  | "lastUsedAtUnixMs"
  | "pinnedAtUnixMs"
>;

export interface AgentGUIConversationProjectResolver {
  resolveSectionKey: (
    railSectionKey: string | null | undefined
  ) => AgentGUIConversationProjectSummary | null;
}

export function createAgentGUIConversationProjectResolver(
  userProjects: readonly AgentGUIConversationUserProject[] = []
): AgentGUIConversationProjectResolver {
  const projectBySectionKey =
    buildAgentGUIConversationProjectIndex(userProjects);
  return {
    resolveSectionKey: (railSectionKey) => {
      const sectionKey = normalizeAgentGUIProjectSectionKey(railSectionKey);
      if (!sectionKey || sectionKey === "conversations") {
        return null;
      }
      const project = projectBySectionKey.get(sectionKey);
      return project
        ? agentGUIConversationProjectSummaryFromProject(project)
        : null;
    }
  };
}

export function resolveAgentGUIConversationProjectBySectionKey(
  railSectionKey: string | null | undefined,
  userProjects: readonly AgentGUIConversationUserProject[] = []
): AgentGUIConversationProjectSummary | null {
  return createAgentGUIConversationProjectResolver(
    userProjects
  ).resolveSectionKey(railSectionKey);
}

export function resolveAgentGUISelectedUserProject(
  selectedPath: string | null | undefined,
  userProjects: readonly AgentGUIConversationUserProject[] = []
): AgentGUIConversationProjectSummary | null {
  const normalizedSelectedPath =
    workspaceUserProjectPathIdentityKey(selectedPath);
  if (!normalizedSelectedPath) {
    return null;
  }
  const projectByNormalizedPath =
    buildAgentGUISelectedProjectPathIndex(userProjects);
  const project = lookupAgentGUISelectedProject(
    normalizedSelectedPath,
    projectByNormalizedPath
  );
  return project
    ? agentGUIConversationProjectSummaryFromProject(project)
    : null;
}

function buildAgentGUIConversationProjectIndex(
  userProjects: readonly AgentGUIConversationUserProject[]
): ReadonlyMap<string, AgentGUIConversationUserProject> {
  const projectBySectionKey = new Map<
    string,
    AgentGUIConversationUserProject
  >();
  for (const project of userProjects) {
    const sectionKey = normalizeAgentGUIProjectSectionKey(project.sectionKey);
    if (
      !sectionKey ||
      sectionKey === "conversations" ||
      projectBySectionKey.has(sectionKey)
    ) {
      continue;
    }
    projectBySectionKey.set(sectionKey, project);
  }
  return projectBySectionKey;
}

function normalizeAgentGUIProjectSectionKey(
  sectionKey: string | null | undefined
): string {
  return sectionKey?.trim() ?? "";
}

function agentGUIConversationProjectSummaryFromProject(
  matchedProject: AgentGUIConversationUserProject
): AgentGUIConversationProjectSummary {
  const sectionKey = normalizeAgentGUIProjectSectionKey(
    matchedProject.sectionKey
  );
  const summary: AgentGUIConversationProjectSummary = {
    id: matchedProject.id,
    path: matchedProject.path,
    label: resolveWorkspaceUserProjectDisplayLabel(matchedProject),
    pinnedAtUnixMs: matchedProject.pinnedAtUnixMs
  };
  if (sectionKey) {
    summary.sectionKey = sectionKey;
  }
  if (matchedProject.createdAtUnixMs !== undefined) {
    summary.createdAtUnixMs = matchedProject.createdAtUnixMs;
  }
  if (matchedProject.updatedAtUnixMs !== undefined) {
    summary.updatedAtUnixMs = matchedProject.updatedAtUnixMs;
  }
  if (matchedProject.lastUsedAtUnixMs !== undefined) {
    summary.lastUsedAtUnixMs = matchedProject.lastUsedAtUnixMs;
  }
  return cachedAgentGUIConversationProjectSummary(summary);
}

function buildAgentGUISelectedProjectPathIndex(
  userProjects: readonly AgentGUIConversationUserProject[]
): ReadonlyMap<string, AgentGUIConversationUserProject> {
  const projectByNormalizedPath = new Map<
    string,
    AgentGUIConversationUserProject
  >();
  for (const project of userProjects) {
    const projectPath = workspaceUserProjectPathIdentityKey(project.path);
    if (!projectPath || projectByNormalizedPath.has(projectPath)) {
      continue;
    }
    projectByNormalizedPath.set(projectPath, project);
  }
  return projectByNormalizedPath;
}

function lookupAgentGUISelectedProject(
  normalizedSelectedPath: string,
  projectByNormalizedPath: ReadonlyMap<string, AgentGUIConversationUserProject>
): AgentGUIConversationUserProject | null {
  let currentPath = normalizedSelectedPath;
  while (currentPath) {
    const project = projectByNormalizedPath.get(currentPath);
    if (project) {
      return project;
    }
    const slashIndex = currentPath.lastIndexOf("/");
    if (slashIndex <= 0) {
      break;
    }
    currentPath = currentPath.slice(0, slashIndex);
  }
  if (normalizedSelectedPath === "/") {
    return projectByNormalizedPath.get("/") ?? null;
  }
  return null;
}

export function normalizeAgentGUIProjectPath(
  path: string | null | undefined
): string {
  return normalizeWorkspaceUserProjectPath(path);
}

function cachedAgentGUIConversationProjectSummary(
  summary: AgentGUIConversationProjectSummary
): AgentGUIConversationProjectSummary {
  const key = [
    summary.id,
    summary.path,
    summary.label,
    summary.sectionKey ?? "",
    summary.createdAtUnixMs ?? "",
    summary.updatedAtUnixMs ?? "",
    summary.lastUsedAtUnixMs ?? "",
    summary.pinnedAtUnixMs ?? ""
  ].join("\u001f");
  const cached = agentGUIConversationProjectSummaryCache.get(key);
  if (cached) {
    return cached;
  }
  if (
    agentGUIConversationProjectSummaryCache.size >=
    AGENT_GUI_CONVERSATION_PROJECT_SUMMARY_CACHE_LIMIT
  ) {
    const oldestKey = agentGUIConversationProjectSummaryCache
      .keys()
      .next().value;
    if (oldestKey) {
      agentGUIConversationProjectSummaryCache.delete(oldestKey);
    }
  }
  agentGUIConversationProjectSummaryCache.set(key, summary);
  return summary;
}
