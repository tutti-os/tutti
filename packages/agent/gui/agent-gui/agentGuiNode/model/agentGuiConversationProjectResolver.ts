import { resolveWorkspaceUserProjectDisplayLabel } from "@tutti-os/workspace-user-project/core";
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
  createdAtUnixMs?: number;
  updatedAtUnixMs?: number;
  lastUsedAtUnixMs?: number;
}

export type AgentGUIConversationUserProject = Pick<
  AgentHostUserProject,
  | "id"
  | "path"
  | "label"
  | "createdAtUnixMs"
  | "updatedAtUnixMs"
  | "lastUsedAtUnixMs"
>;

export type AgentGUIConversationNoProjectPathResolver = (input: {
  path: string;
}) => boolean;

export interface AgentGUIConversationProjectResolutionOptions {
  isNoProjectPath?: AgentGUIConversationNoProjectPathResolver;
}

export interface AgentGUIConversationProjectResolver {
  resolve: (
    cwd: string | null | undefined
  ) => AgentGUIConversationProjectSummary | null;
}

export function createAgentGUIConversationProjectResolver(
  userProjects: readonly AgentGUIConversationUserProject[] = [],
  options: AgentGUIConversationProjectResolutionOptions = {}
): AgentGUIConversationProjectResolver {
  const projectByNormalizedPath =
    buildAgentGUIConversationProjectIndex(userProjects);
  const resolvedByNormalizedCwd = new Map<
    string,
    AgentGUIConversationProjectSummary | null
  >();
  return {
    resolve: (cwd) => {
      const normalizedCwd = normalizeAgentGUIProjectPath(cwd);
      if (!normalizedCwd) {
        return null;
      }
      const cached = resolvedByNormalizedCwd.get(normalizedCwd);
      if (cached !== undefined) {
        return cached;
      }
      const resolved = resolveAgentGUIConversationProjectFromIndex(
        normalizedCwd,
        projectByNormalizedPath,
        options
      );
      resolvedByNormalizedCwd.set(normalizedCwd, resolved);
      return resolved;
    }
  };
}

export function resolveAgentGUIConversationProject(
  cwd: string | null | undefined,
  userProjects: readonly AgentGUIConversationUserProject[] = [],
  options: AgentGUIConversationProjectResolutionOptions = {}
): AgentGUIConversationProjectSummary | null {
  return createAgentGUIConversationProjectResolver(
    userProjects,
    options
  ).resolve(cwd);
}

function buildAgentGUIConversationProjectIndex(
  userProjects: readonly AgentGUIConversationUserProject[]
): ReadonlyMap<string, AgentGUIConversationUserProject> {
  const projectByNormalizedPath = new Map<
    string,
    AgentGUIConversationUserProject
  >();
  for (const project of userProjects) {
    const projectPath = normalizeAgentGUIProjectPath(project.path);
    if (!projectPath || projectByNormalizedPath.has(projectPath)) {
      continue;
    }
    projectByNormalizedPath.set(projectPath, project);
  }
  return projectByNormalizedPath;
}

function resolveAgentGUIConversationProjectFromIndex(
  normalizedCwd: string,
  projectByNormalizedPath: ReadonlyMap<string, AgentGUIConversationUserProject>,
  options: AgentGUIConversationProjectResolutionOptions
): AgentGUIConversationProjectSummary | null {
  const exactProject = projectByNormalizedPath.get(normalizedCwd);
  if (exactProject) {
    return agentGUIConversationProjectSummaryFromProject(exactProject);
  }
  if (options.isNoProjectPath?.({ path: normalizedCwd })) {
    return null;
  }
  const matchedProject = lookupAgentGUIConversationProject(
    normalizedCwd,
    projectByNormalizedPath
  );
  if (!matchedProject) {
    return null;
  }
  return agentGUIConversationProjectSummaryFromProject(matchedProject);
}

function agentGUIConversationProjectSummaryFromProject(
  matchedProject: AgentGUIConversationUserProject
): AgentGUIConversationProjectSummary {
  const summary: AgentGUIConversationProjectSummary = {
    id: matchedProject.id,
    path: matchedProject.path,
    label: resolveWorkspaceUserProjectDisplayLabel(matchedProject)
  };
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

function lookupAgentGUIConversationProject(
  normalizedCwd: string,
  projectByNormalizedPath: ReadonlyMap<string, AgentGUIConversationUserProject>
): AgentGUIConversationUserProject | null {
  let currentPath = normalizedCwd;
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
  if (normalizedCwd === "/") {
    return projectByNormalizedPath.get("/") ?? null;
  }
  return null;
}

function normalizeAgentGUIProjectPath(path: string | null | undefined): string {
  const normalized = path?.trim().replaceAll("\\", "/") ?? "";
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\/+$/, "") || "/";
}

function cachedAgentGUIConversationProjectSummary(
  summary: AgentGUIConversationProjectSummary
): AgentGUIConversationProjectSummary {
  const key = [
    summary.id,
    summary.path,
    summary.label,
    summary.createdAtUnixMs ?? "",
    summary.updatedAtUnixMs ?? "",
    summary.lastUsedAtUnixMs ?? ""
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
