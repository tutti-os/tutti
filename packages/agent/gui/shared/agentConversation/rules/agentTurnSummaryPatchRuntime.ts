import { formatWorkspaceFilePathForDisplay } from "@tutti-os/workspace-file-manager/services";
import type {
  AgentTurnSummaryFileVM,
  AgentTurnSummaryPatchChangeVM
} from "../contracts/agentTurnSummaryRowVM";
import { normalizeWorkspaceFilePath } from "../../../actions/workspaceFilePathCandidate";

export function fileCanBuildPatch(file: AgentTurnSummaryFileVM): boolean {
  return (
    file.unifiedDiff != null ||
    file.content != null ||
    file.oldString != null ||
    file.newString != null
  );
}

export function patchBatchDirectoryCwd(
  cwd: string | null,
  changes: readonly Pick<AgentTurnSummaryPatchChangeVM, "path">[],
  workspaceRoot?: string | null
): string | null {
  const normalizedCwd = normalizePatchHostPath(cwd ?? "", workspaceRoot);
  if (!normalizedCwd) {
    return null;
  }
  const cwdIsChangedFilePath = changes.some(
    (change) =>
      normalizePatchHostPath(change.path, workspaceRoot) === normalizedCwd
  );
  return cwdIsChangedFilePath
    ? dirnameForPatchHostPath(normalizedCwd)
    : normalizedCwd;
}

export function resolvePatchExecutionCwd(
  cwd: string | null,
  workspaceRoot?: string | null
): string | null {
  const normalizedRoot = normalizePatchHostPath(
    workspaceRoot ?? "",
    workspaceRoot
  );
  const normalizedCwd = normalizePatchHostPath(cwd ?? "", normalizedRoot);
  if (!normalizedCwd) {
    return normalizedRoot || null;
  }
  if (!normalizedRoot) {
    return normalizedCwd;
  }
  if (isSyntheticWorkspacePath(normalizedRoot)) {
    return normalizedCwd;
  }
  if (normalizedCwd === "/workspace") {
    return normalizedRoot;
  }
  if (normalizedCwd.startsWith("/workspace/")) {
    return `${normalizedRoot}/${normalizedCwd.slice("/workspace/".length)}`;
  }
  return normalizedCwd;
}

export function resolvePatchDiffCwd({
  sourceCwd,
  executionCwd,
  changes
}: {
  sourceCwd: string | null;
  executionCwd: string | null;
  changes: readonly Pick<AgentTurnSummaryPatchChangeVM, "path">[];
}): string | null {
  const normalizedSourceCwd = normalizePatchHostPath(sourceCwd ?? "");
  const normalizedExecutionCwd = normalizePatchHostPath(executionCwd ?? "");
  if (
    !isSyntheticWorkspacePath(normalizedSourceCwd) ||
    !normalizedExecutionCwd
  ) {
    return sourceCwd;
  }
  const hasSyntheticChangePath = changes.some((change) =>
    isInsideOrEqualPatchPath(
      normalizePatchHostPath(change.path),
      normalizedSourceCwd
    )
  );
  const hasHostChangePath = changes.some((change) =>
    isInsideOrEqualPatchPath(
      normalizePatchHostPath(change.path),
      normalizedExecutionCwd
    )
  );
  return hasHostChangePath && !hasSyntheticChangePath
    ? normalizedExecutionCwd
    : sourceCwd;
}

function normalizePatchHostPath(
  path: string,
  workspaceRoot?: string | null
): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "";
  }
  const normalized = normalizeWorkspaceFilePath(trimmed, workspaceRoot);
  if (/^\/?[A-Za-z]:\//.test(normalized)) {
    return formatWorkspaceFilePathForDisplay(normalized, "win32")
      .replaceAll("\\", "/")
      .replace(/\/+$/, "");
  }
  return normalized.replace(/\/+$/, "");
}

function dirnameForPatchHostPath(path: string): string {
  const normalized = normalizePatchHostPath(path);
  const index = normalized.lastIndexOf("/");
  if (index < 0) {
    return "";
  }
  if (index === 0) {
    return "/";
  }
  return normalized.slice(0, index);
}

function isSyntheticWorkspacePath(path: string): boolean {
  return path === "/workspace" || path.startsWith("/workspace/");
}

function isInsideOrEqualPatchPath(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}
