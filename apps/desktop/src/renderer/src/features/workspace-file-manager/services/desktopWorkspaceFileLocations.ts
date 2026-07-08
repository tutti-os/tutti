import { resolveWorkspaceUserProjectDisplayLabel } from "@tutti-os/workspace-user-project/core";
import type { WorkspaceUserProject } from "@tutti-os/workspace-user-project/contracts";
import type {
  WorkspaceFileLocation,
  WorkspaceFileLocationSection
} from "@tutti-os/workspace-file-manager/services";
import { translate } from "../../../i18n/appRuntime.ts";
import type { IWorkspaceUserProjectService } from "../../workspace-user-project/index.ts";

export const DESKTOP_WORKSPACE_FILE_PROJECT_SECTION_ID = "project";
export const DESKTOP_WORKSPACE_FILE_LOCAL_SECTION_ID = "local";
export const DESKTOP_WORKSPACE_FILE_RECENT_LOCATION_ID = "local:recent";
export const DESKTOP_WORKSPACE_FILE_HOME_LOCATION_ID = "local:home";

export function buildDesktopWorkspaceFileLocationSections(input: {
  homeDirectory: string;
  projects: readonly WorkspaceUserProject[];
}): WorkspaceFileLocationSection[] {
  return [
    {
      id: DESKTOP_WORKSPACE_FILE_PROJECT_SECTION_ID,
      label: translate("workspace.referenceSources.projectSourceLabel"),
      locations: input.projects.map(projectToLocation)
    },
    {
      id: DESKTOP_WORKSPACE_FILE_LOCAL_SECTION_ID,
      label: translate("workspace.referenceSources.localSourceLabel"),
      locations: buildLocalLocations(input.homeDirectory)
    }
  ];
}

export async function loadDesktopWorkspaceFileLocationSections(input: {
  homeDirectory: string;
  workspaceUserProjectService?: Pick<
    IWorkspaceUserProjectService,
    "ensureLoaded" | "getSnapshot"
  > | null;
}): Promise<WorkspaceFileLocationSection[]> {
  await input.workspaceUserProjectService?.ensureLoaded();
  return buildDesktopWorkspaceFileLocationSections({
    homeDirectory: input.homeDirectory,
    projects: input.workspaceUserProjectService?.getSnapshot().projects ?? []
  });
}

export function getCurrentDesktopWorkspaceFileLocationSections(input: {
  homeDirectory: string;
  workspaceUserProjectService?: Pick<
    IWorkspaceUserProjectService,
    "getSnapshot"
  > | null;
}): WorkspaceFileLocationSection[] {
  return buildDesktopWorkspaceFileLocationSections({
    homeDirectory: input.homeDirectory,
    projects: input.workspaceUserProjectService?.getSnapshot().projects ?? []
  });
}

export function resolveDesktopWorkspaceFileDefaultLocationId(input: {
  composerSelectedProjectPath?: string | null;
  preferredProject?: WorkspaceUserProject | null;
  projects: readonly WorkspaceUserProject[];
}): string {
  const project =
    input.preferredProject ??
    findWorkspaceUserProjectByPath(
      input.projects,
      input.composerSelectedProjectPath
    ) ??
    input.projects[0] ??
    null;
  return project
    ? desktopWorkspaceFileProjectLocationId(project)
    : DESKTOP_WORKSPACE_FILE_HOME_LOCATION_ID;
}

function desktopWorkspaceFileProjectLocationId(
  project: Pick<WorkspaceUserProject, "id">
): string {
  return `project:${project.id}`;
}

export function findDesktopWorkspaceFileLocationByProject(input: {
  locationSections: readonly WorkspaceFileLocationSection[];
  projectId?: string | null;
  projectPath?: string | null;
}): WorkspaceFileLocation | null {
  const normalizedProjectPath = normalizeDesktopWorkspaceFilePath(
    input.projectPath
  );
  for (const section of input.locationSections) {
    if (section.id !== DESKTOP_WORKSPACE_FILE_PROJECT_SECTION_ID) {
      continue;
    }
    for (const location of section.locations) {
      if (location.kind !== "directory") {
        continue;
      }
      if (input.projectId && location.id === `project:${input.projectId}`) {
        return location;
      }
      if (
        normalizedProjectPath &&
        normalizeDesktopWorkspaceFilePath(location.path) ===
          normalizedProjectPath
      ) {
        return location;
      }
    }
  }
  return null;
}

function projectToLocation(
  project: WorkspaceUserProject
): WorkspaceFileLocation {
  return {
    contextLabel: project.path,
    id: desktopWorkspaceFileProjectLocationId(project),
    kind: "directory",
    label: resolveWorkspaceUserProjectDisplayLabel(project),
    path: project.path,
    referenceNodeId: project.path
  };
}

function buildLocalLocations(homeDirectory: string): WorkspaceFileLocation[] {
  return [
    {
      id: DESKTOP_WORKSPACE_FILE_RECENT_LOCATION_ID,
      kind: "recent",
      label: translate("workspace.referenceSources.sidebarRecent")
    },
    localDirectoryLocation(
      "local:downloads",
      translate("workspace.referenceSources.sidebarDownloads"),
      homeDirectory,
      "Downloads"
    ),
    localDirectoryLocation(
      "local:documents",
      translate("workspace.referenceSources.sidebarDocuments"),
      homeDirectory,
      "Documents"
    ),
    localDirectoryLocation(
      "local:desktop",
      translate("workspace.referenceSources.sidebarDesktop"),
      homeDirectory,
      "Desktop"
    ),
    {
      id: DESKTOP_WORKSPACE_FILE_HOME_LOCATION_ID,
      kind: "directory",
      label: translate("workspace.referenceSources.sidebarPersonal"),
      path: normalizeDesktopWorkspaceFilePath(homeDirectory),
      referenceNodeId: normalizeDesktopWorkspaceFilePath(homeDirectory)
    }
  ];
}

function localDirectoryLocation(
  id: string,
  label: string,
  homeDirectory: string,
  relativePath: string
): WorkspaceFileLocation {
  return {
    id,
    kind: "directory",
    label,
    path: joinDesktopWorkspaceFilePath(homeDirectory, relativePath),
    referenceNodeId: relativePath
  };
}

function findWorkspaceUserProjectByPath(
  projects: readonly WorkspaceUserProject[],
  path: string | null | undefined
): WorkspaceUserProject | null {
  const normalizedPath = normalizeDesktopWorkspaceFilePath(path);
  if (!normalizedPath) {
    return null;
  }
  return (
    projects.find(
      (project) =>
        normalizeDesktopWorkspaceFilePath(project.path) === normalizedPath
    ) ?? null
  );
}

function joinDesktopWorkspaceFilePath(
  root: string,
  relativePath: string
): string {
  const normalizedRoot = normalizeDesktopWorkspaceFilePath(root).replace(
    /\/+$/u,
    ""
  );
  return `${normalizedRoot}/${relativePath.replace(/^\/+/u, "")}`;
}

function normalizeDesktopWorkspaceFilePath(
  path: string | null | undefined
): string {
  return path?.trim().replaceAll("\\", "/").replace(/\/+$/u, "") ?? "";
}
