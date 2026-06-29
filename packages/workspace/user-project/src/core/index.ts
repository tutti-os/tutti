import type {
  WorkspaceUserProject,
  WorkspaceUserProjectApi,
  WorkspaceUserProjectCreationErrorCode,
  WorkspaceUserProjectSelectionPreparation,
  WorkspaceUserProjectSelectionPreparationInput
} from "../contracts/index.ts";

export function upsertWorkspaceUserProject(
  projects: readonly WorkspaceUserProject[],
  project: WorkspaceUserProject
): WorkspaceUserProject[] {
  const existingIndex = projects.findIndex(
    (item) => item.id === project.id || item.path === project.path
  );
  if (existingIndex < 0) {
    return [project, ...projects];
  }
  const next = [...projects];
  next[existingIndex] = project;
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
    !projects.some((project) => project.path === selectedPath)
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
  if (defaultPath && projects.some((project) => project.path === defaultPath)) {
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
