import {
  basenameWorkspaceUserProjectPath,
  resolveWorkspaceUserProjectDisplayLabel
} from "@tutti-os/workspace-user-project/core";
import type { WorkspaceUserProject } from "@tutti-os/workspace-user-project/contracts";

export interface DesktopWorkspaceFileMentionEntry {
  displayName?: string | null;
  kind?: "directory" | "file" | (string & {});
  name?: string | null;
  path: string;
  contextLabel?: string;
}

export function presentDesktopWorkspaceFileMentionEntries(input: {
  currentWorkspacePath?: string | null;
  entries: readonly DesktopWorkspaceFileMentionEntry[];
  projects: readonly WorkspaceUserProject[];
  searchRoot: string;
}): DesktopWorkspaceFileMentionEntry[] {
  const currentWorkspacePath = resolveCurrentWorkspacePath(
    input.currentWorkspacePath,
    input.projects
  );
  const presented = input.entries.map((entry) => ({
    entry: {
      ...entry,
      contextLabel: workspaceFileMentionContextLabel({
        currentWorkspacePath,
        entryPath: entry.path,
        projects: input.projects,
        searchRoot: input.searchRoot
      })
    },
    isCurrentWorkspace:
      currentWorkspacePath.length > 0 &&
      isPathWithin(entry.path, currentWorkspacePath)
  }));

  return [
    ...presented.filter((item) => item.isCurrentWorkspace),
    ...presented.filter((item) => !item.isCurrentWorkspace)
  ].map((item) => item.entry);
}

function workspaceFileMentionContextLabel(input: {
  currentWorkspacePath: string;
  entryPath: string;
  projects: readonly WorkspaceUserProject[];
  searchRoot: string;
}): string {
  const relativeDirectory = relativeDirectoryFromSearchRoot(
    input.entryPath,
    input.searchRoot
  );
  const workspaceLabel = resolveOwningWorkspaceLabel(input);
  return [relativeDirectory, workspaceLabel].filter(Boolean).join(" · ");
}

function relativeDirectoryFromSearchRoot(path: string, root: string): string {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  const directoryPath = dirname(normalizedPath);
  if (!normalizedRoot || !isPathWithin(directoryPath, normalizedRoot)) {
    return directoryPath || ".";
  }
  if (samePath(directoryPath, normalizedRoot)) {
    return ".";
  }
  return directoryPath.slice(normalizedRoot.length).replace(/^\/+/, "") || ".";
}

function resolveOwningWorkspaceLabel(input: {
  currentWorkspacePath: string;
  entryPath: string;
  projects: readonly WorkspaceUserProject[];
  searchRoot: string;
}): string {
  if (
    input.currentWorkspacePath &&
    isPathWithin(input.entryPath, input.currentWorkspacePath)
  ) {
    const currentProject = input.projects.find((project) =>
      samePath(project.path, input.currentWorkspacePath)
    );
    return currentProject
      ? resolveWorkspaceUserProjectDisplayLabel(currentProject)
      : basenameWorkspaceUserProjectPath(input.currentWorkspacePath);
  }

  const owningProject = findOwningProject(input.entryPath, input.projects);
  if (owningProject) {
    return resolveWorkspaceUserProjectDisplayLabel(owningProject);
  }
  return basenameWorkspaceUserProjectPath(input.searchRoot) || input.searchRoot;
}

function resolveCurrentWorkspacePath(
  currentWorkspacePath: string | null | undefined,
  projects: readonly WorkspaceUserProject[]
): string {
  const normalizedPath = normalizePath(currentWorkspacePath);
  if (!normalizedPath) {
    return "";
  }
  return (
    normalizePath(findOwningProject(normalizedPath, projects)?.path) ||
    normalizedPath
  );
}

function findOwningProject(
  path: string,
  projects: readonly WorkspaceUserProject[]
): WorkspaceUserProject | undefined {
  return projects
    .filter((project) => isPathWithin(path, project.path))
    .sort(
      (left, right) =>
        normalizePath(right.path).length - normalizePath(left.path).length
    )[0];
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const separatorIndex = normalized.lastIndexOf("/");
  if (separatorIndex < 0) {
    return "";
  }
  if (separatorIndex === 0) {
    return "/";
  }
  return normalized.slice(0, separatorIndex);
}

function isPathWithin(path: string, root: string): boolean {
  const normalizedPath = comparablePath(path);
  const normalizedRoot = comparablePath(root);
  return (
    normalizedRoot.length > 0 &&
    (normalizedPath === normalizedRoot ||
      normalizedPath.startsWith(`${normalizedRoot}/`))
  );
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function comparablePath(path: string): string {
  const normalized = normalizePath(path);
  return /^[A-Za-z]:\//u.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

function normalizePath(path: string | null | undefined): string {
  const normalized = path?.trim().replaceAll("\\", "/") ?? "";
  if (normalized === "/" || /^[A-Za-z]:\/$/u.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/u, "");
}
