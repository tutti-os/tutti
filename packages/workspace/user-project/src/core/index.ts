import type {
  WorkspaceUserProject,
  WorkspaceUserProjectApi,
  WorkspaceUserProjectCreationErrorCode,
  WorkspaceUserProjectSelectionPreparation,
  WorkspaceUserProjectSelectionPreparationInput
} from "../contracts/index.ts";

const workspaceUserProjectNameMaxUtf8Bytes = 255;
const workspaceUserProjectInvalidNameCharacters = /[<>:"/\\|?*]/u;
const workspaceUserProjectWindowsReservedName =
  /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

export function isValidWorkspaceUserProjectName(name: string): boolean {
  const normalized = String(name).normalize("NFC");
  const trimmed = normalized.trim();
  return (
    normalized === trimmed &&
    trimmed.length > 0 &&
    trimmed !== "." &&
    trimmed !== ".." &&
    !workspaceUserProjectInvalidNameCharacters.test(trimmed) &&
    !Array.from(trimmed).some((character) => character.charCodeAt(0) <= 0x1f) &&
    !/[. ]$/u.test(trimmed) &&
    !workspaceUserProjectWindowsReservedName.test(trimmed) &&
    new TextEncoder().encode(trimmed).byteLength <=
      workspaceUserProjectNameMaxUtf8Bytes
  );
}

export function workspaceUserProjectNameIdentityKey(name: string): string {
  return String(name).normalize("NFC").trim().toLocaleLowerCase("en-US");
}

export function upsertWorkspaceUserProject(
  projects: readonly WorkspaceUserProject[],
  project: WorkspaceUserProject
): WorkspaceUserProject[] {
  const existingIndex = projects.findIndex(
    (item) =>
      item.id === project.id ||
      areWorkspaceUserProjectPathsEqual(item.path, project.path)
  );
  if (existingIndex < 0) {
    const insertionIndex =
      project.pinnedAtUnixMs > 0
        ? 0
        : projects.findIndex((candidate) => candidate.pinnedAtUnixMs <= 0);
    const next = [...projects];
    next.splice(insertionIndex < 0 ? next.length : insertionIndex, 0, project);
    return next;
  }
  const next = [...projects];
  next[existingIndex] = project;
  return next;
}

export function pinWorkspaceUserProjectOptimistically(
  projects: readonly WorkspaceUserProject[],
  input: {
    pinned: boolean;
    pinnedAtUnixMs: number;
    projectId: string;
    updatedAtUnixMs: number;
  }
): WorkspaceUserProject[] {
  const projectIndex = projects.findIndex(
    (project) => project.id === input.projectId
  );
  if (projectIndex < 0) {
    return [...projects];
  }
  const current = projects[projectIndex];
  if (!current || current.pinnedAtUnixMs > 0 === input.pinned) {
    return [...projects];
  }

  const next = [...projects];
  next.splice(projectIndex, 1);
  const project = {
    ...current,
    pinnedAtUnixMs: input.pinned ? Math.max(1, input.pinnedAtUnixMs) : 0,
    updatedAtUnixMs: input.updatedAtUnixMs
  };
  const insertionIndex = input.pinned
    ? 0
    : next.findIndex((candidate) => candidate.pinnedAtUnixMs <= 0);
  next.splice(insertionIndex < 0 ? next.length : insertionIndex, 0, project);
  return next;
}

export function resolveWorkspaceUserProjectDisplayLabel(
  project: Pick<WorkspaceUserProject, "id" | "label" | "path">
): string {
  const label = stripAbsolutePathFromWorkspaceUserProjectLabel(project.label);
  if (label) {
    return label;
  }
  return basenameWorkspaceUserProjectPath(project.path) || project.id;
}

export function stripAbsolutePathFromWorkspaceUserProjectLabel(
  label: string
): string {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    return "";
  }
  const pathStart = findAbsolutePathStart(trimmedLabel);
  if (pathStart < 0) {
    return trimmedLabel;
  }
  if (pathStart === 0) {
    return basenameWorkspaceUserProjectPath(trimmedLabel);
  }
  return trimmedLabel
    .slice(0, pathStart)
    .replace(/[\s/\\|:()[\]{}-]+$/u, "")
    .trim();
}

export function basenameWorkspaceUserProjectPath(path: string): string {
  const normalizedPath = path.trim().replace(/[\\/]+$/u, "");
  if (!normalizedPath) {
    return "";
  }
  const segments = normalizedPath.split(/[\\/]+/u);
  return segments[segments.length - 1] ?? "";
}

/**
 * Normalizes a project path for identity comparisons at the UI boundary.
 * Windows paths can arrive from different hosts with either slash style and
 * different casing even though they refer to the same directory. POSIX paths
 * remain case-sensitive, so case folding is limited to Windows-shaped paths.
 */
export function normalizeWorkspaceUserProjectPath(
  path: string | null | undefined
): string {
  const slashed = path?.trim().replaceAll("\\", "/") ?? "";
  if (!slashed) {
    return "";
  }
  if (/^\/+$/u.test(slashed)) {
    return "/";
  }
  if (/^[A-Za-z]:\/+$/u.test(slashed)) {
    return `${slashed.slice(0, 2)}/`;
  }
  return slashed.replace(/\/+$/u, "");
}

export function areWorkspaceUserProjectPathsEqual(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  return (
    workspaceUserProjectPathIdentityKey(left) ===
    workspaceUserProjectPathIdentityKey(right)
  );
}

export function workspaceUserProjectPathIdentityKey(
  path: string | null | undefined
): string {
  const normalized = normalizeWorkspaceUserProjectPath(path);
  if (/^[A-Za-z]:\//u.test(normalized) || normalized.startsWith("//")) {
    return normalized.toLowerCase();
  }
  return normalized;
}

export function getWorkspaceUserProjectErrorCode(
  error: unknown
): WorkspaceUserProjectCreationErrorCode | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    return code;
  }

  return getWorkspaceUserProjectErrorCode((error as { cause?: unknown }).cause);
}

export async function prepareWorkspaceUserProjectSelection(
  api: WorkspaceUserProjectApi,
  input: WorkspaceUserProjectSelectionPreparationInput
): Promise<WorkspaceUserProjectSelectionPreparation> {
  if (api.prepareSelection) {
    return api.prepareSelection(input);
  }
  const response = await api.list();
  const projects = response.projects;
  const selectedPath = input.selectedPath?.trim() ?? "";
  const isSelectedPathNoProject =
    selectedPath && api.isNoProjectPath?.({ path: selectedPath }) === true;
  const isSelectedPathMissing =
    input.projectLocked && selectedPath && !isSelectedPathNoProject
      ? await checkWorkspaceUserProjectPathMissing(api, selectedPath)
      : false;

  if (
    !input.projectLocked &&
    selectedPath &&
    !isSelectedPathNoProject &&
    !projects.some((project) =>
      areWorkspaceUserProjectPathsEqual(project.path, selectedPath)
    )
  ) {
    await api.rememberDefaultSelection?.({ path: null });
    return {
      isSelectedPathMissing,
      projects,
      selection: {
        kind: "clear",
        suppressedPath: selectedPath
      }
    };
  }

  if (input.projectLocked || selectedPath) {
    return {
      isSelectedPathMissing,
      projects,
      selection: { kind: "none" }
    };
  }

  const defaultSelection = await api.getDefaultSelection?.();
  const defaultPath = defaultSelection?.path?.trim() ?? "";
  if (
    defaultPath &&
    projects.some((project) =>
      areWorkspaceUserProjectPathsEqual(project.path, defaultPath)
    )
  ) {
    return {
      isSelectedPathMissing,
      projects,
      selection: {
        kind: "select",
        path: defaultPath
      }
    };
  }
  return {
    isSelectedPathMissing,
    projects,
    selection: { kind: "none" }
  };
}

export async function checkWorkspaceUserProjectPathMissing(
  api: Pick<WorkspaceUserProjectApi, "checkPath">,
  path: string
): Promise<boolean> {
  try {
    const result = await api.checkPath?.({ path });
    return result ? !result.exists || !result.isDirectory : false;
  } catch {
    return false;
  }
}

function findAbsolutePathStart(value: string): number {
  const indexes = [
    value.search(/\/[^\s/]/u),
    value.search(/[A-Za-z]:[\\/]/u),
    value.search(/\\\\[^\s\\]/u),
    value.search(/~[\\/]/u)
  ].filter((index) => index >= 0);
  return indexes.length > 0 ? Math.min(...indexes) : -1;
}
