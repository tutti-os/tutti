import type {
  AgentHostUserProject,
  AgentHostUserProjectsApi
} from "../../../host/agentHostApi";
import { areWorkspaceUserProjectPathsEqual } from "@tutti-os/workspace-user-project/core";
export {
  projectAgentApprovalPromptFromInteraction as interactiveApprovalFromInteraction,
  projectAgentInteractivePromptFromInteraction as interactivePromptFromInteraction
} from "../../../shared/agentConversation/projection/agentInteractionPromptProjection";
export function normalizeProjectConversationPath(
  path: string | null | undefined
): string {
  const normalized = path?.trim().replaceAll("\\", "/") ?? "";
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\/+$/, "") || "/";
}

export function omitConversationLocalState<T>(
  current: Record<string, T>,
  conversationIds: ReadonlySet<string>
): Record<string, T> {
  let changed = false;
  const next = { ...current };
  for (const conversationId of conversationIds) {
    if (conversationId in next) {
      delete next[conversationId];
      changed = true;
    }
  }
  return changed ? next : current;
}

export function areAgentGUIUserProjectsEqual(
  left: readonly AgentHostUserProject[],
  right: readonly AgentHostUserProject[]
): boolean {
  return (
    left.length === right.length &&
    left.every((project, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        project.id === candidate.id &&
        areWorkspaceUserProjectPathsEqual(project.path, candidate.path) &&
        project.label === candidate.label &&
        project.sectionKey === candidate.sectionKey &&
        project.pinnedAtUnixMs === candidate.pinnedAtUnixMs &&
        project.createdAtUnixMs === candidate.createdAtUnixMs &&
        project.updatedAtUnixMs === candidate.updatedAtUnixMs &&
        project.lastUsedAtUnixMs === candidate.lastUsedAtUnixMs
      );
    })
  );
}

export function upsertAgentGUIUserProject(
  projects: readonly AgentHostUserProject[],
  project: {
    id: string;
    path: string;
    label: string;
    sectionKey?: string;
    createdAtUnixMs?: number;
    updatedAtUnixMs?: number;
    lastUsedAtUnixMs?: number | null;
    pinnedAtUnixMs: number;
  }
): AgentHostUserProject[] {
  const normalizedProject: AgentHostUserProject = {
    ...(project.createdAtUnixMs === undefined
      ? {}
      : { createdAtUnixMs: project.createdAtUnixMs }),
    id: project.id,
    ...(project.lastUsedAtUnixMs === undefined ||
    project.lastUsedAtUnixMs === null
      ? {}
      : { lastUsedAtUnixMs: project.lastUsedAtUnixMs }),
    label: project.label,
    path: project.path,
    pinnedAtUnixMs: project.pinnedAtUnixMs,
    ...(project.sectionKey === undefined
      ? {}
      : { sectionKey: project.sectionKey }),
    ...(project.updatedAtUnixMs === undefined
      ? {}
      : { updatedAtUnixMs: project.updatedAtUnixMs })
  };
  const index = projects.findIndex(
    (candidate) =>
      candidate.id === normalizedProject.id ||
      areWorkspaceUserProjectPathsEqual(candidate.path, normalizedProject.path)
  );
  if (index === -1) {
    return [...projects, normalizedProject];
  }
  const next = [...projects];
  next[index] = normalizedProject;
  return next;
}

export function readAgentGUIUserProjectSnapshot(
  api: AgentHostUserProjectsApi | undefined
): AgentHostUserProject[] {
  const projects = api?.service?.getSnapshot?.().projects ?? [];
  return projects.map((project) => ({
    ...(project.createdAtUnixMs === undefined
      ? {}
      : { createdAtUnixMs: project.createdAtUnixMs }),
    id: project.id,
    ...(project.lastUsedAtUnixMs === undefined ||
    project.lastUsedAtUnixMs === null
      ? {}
      : { lastUsedAtUnixMs: project.lastUsedAtUnixMs }),
    label: project.label,
    path: project.path,
    pinnedAtUnixMs: project.pinnedAtUnixMs,
    ...(project.sectionKey === undefined
      ? {}
      : { sectionKey: project.sectionKey }),
    ...(project.updatedAtUnixMs === undefined
      ? {}
      : { updatedAtUnixMs: project.updatedAtUnixMs })
  }));
}

export function readAgentGUIUserProjectMutationPending(
  api: AgentHostUserProjectsApi | undefined
): boolean {
  return api?.service?.getSnapshot?.().isMutationPending === true;
}
