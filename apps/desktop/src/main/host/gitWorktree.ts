import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options: { maxBuffer: number }
) => Promise<{ stderr: string; stdout: string }>;

export interface DesktopGitWorktreeInput {
  issueId: string;
  sourceDirectory: string;
  taskId: string;
}

export interface DesktopGitWorktree {
  branch: string;
  path: string;
}

/**
 * Creates a stable, task-specific linked worktree beside the source repository.
 * A non-Git source is intentionally not an error: those tasks continue using
 * their usual execution-directory behavior.
 */
export async function createDesktopGitWorktree(
  input: DesktopGitWorktreeInput,
  options: { execFile?: ExecFileAsync } = {}
): Promise<DesktopGitWorktree | null> {
  const sourceDirectory = input.sourceDirectory.trim();
  if (!sourceDirectory) return null;

  const exec = options.execFile ?? execFileAsync;
  const repositoryRoot = await resolveGitRepositoryRoot(sourceDirectory, exec);
  if (!repositoryRoot) return null;

  const taskKey = `${safeSegment(input.issueId)}-${safeSegment(input.taskId)}`;
  const branch = `tutti/issue-${taskKey}`;
  const worktreePath = path.join(
    path.dirname(repositoryRoot),
    `${path.basename(repositoryRoot)}-tutti-${taskKey}`
  );
  const existingWorktrees = await runGit(
    repositoryRoot,
    ["worktree", "list", "--porcelain"],
    exec
  );
  if (listWorktreePaths(existingWorktrees).has(worktreePath)) {
    return { branch, path: worktreePath };
  }

  try {
    await runGit(
      repositoryRoot,
      ["worktree", "add", "-b", branch, worktreePath, "HEAD"],
      exec
    );
  } catch (error) {
    // A retry can find a branch left by an interrupted previous attempt.
    // Reuse it only when Git confirms that the name, rather than the checkout,
    // is the collision.
    if (!gitErrorText(error).includes("already exists")) throw error;
    await runGit(
      repositoryRoot,
      ["worktree", "add", worktreePath, branch],
      exec
    );
  }
  return { branch, path: worktreePath };
}

async function resolveGitRepositoryRoot(
  sourceDirectory: string,
  exec: ExecFileAsync
): Promise<string | null> {
  try {
    const root = await runGit(
      sourceDirectory,
      ["rev-parse", "--show-toplevel"],
      exec
    );
    return root.trim() || null;
  } catch (error) {
    if (gitErrorText(error).toLowerCase().includes("not a git repository")) {
      return null;
    }
    throw error;
  }
}

function runGit(
  cwd: string,
  args: readonly string[],
  exec: ExecFileAsync
): Promise<string> {
  return exec("git", ["-C", cwd, ...args], { maxBuffer: 1024 * 1024 }).then(
    ({ stdout }) => stdout
  );
}

function listWorktreePaths(value: string): Set<string> {
  return new Set(
    value
      .split("\n")
      .flatMap((line) =>
        line.startsWith("worktree ") ? [line.slice("worktree ".length)] : []
      )
  );
}

function safeSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, "-") || "task";
}

function gitErrorText(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown; stderr?: unknown };
    return `${stringValue(candidate.message)}\n${stringValue(candidate.stderr)}`;
  }
  return stringValue(error);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
