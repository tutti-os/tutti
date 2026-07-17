package workspace

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const issueTaskWorktreeTimeout = 30 * time.Second

// issueTaskIsolation describes how a concurrently dispatched task is kept from
// trampling siblings. An empty value means the task runs directly in its
// resolved execution directory (exclusive task, or a directory it does not
// share with any sibling).
type issueTaskIsolation struct {
	// worktreeBase is the shared git checkout to isolate from; when set the
	// launcher creates a per-run worktree and runs the session inside it.
	worktreeBase string
}

func (s IssueManagerService) taskWorktreeRoot() string {
	if root := strings.TrimSpace(s.TaskWorktreeRoot); root != "" {
		return root
	}
	return filepath.Join(tuttitypes.DefaultStateDir(), "task-worktrees")
}

// resolveIssueTaskBaseDirectory mirrors the launch-time execution directory
// resolution: the task's explicit directory wins, otherwise the planning
// session's working directory is inherited.
func (s IssueManagerService) resolveIssueTaskBaseDirectory(issue workspaceissues.Issue, task workspaceissues.Task) string {
	if explicit := strings.TrimSpace(task.ExecutionDirectory); explicit != "" {
		return explicit
	}
	if s.AgentSessionReader != nil && strings.TrimSpace(issue.SourceSessionID) != "" {
		if source, ok := s.AgentSessionReader.GetSession(issue.WorkspaceID, issue.SourceSessionID); ok {
			return strings.TrimSpace(source.Cwd)
		}
	}
	return ""
}

// sequentialTaskIsolation decides whether a parallelizable task may actually
// run alongside siblings and how. A task with an execution directory no
// sibling uses needs no isolation; a shared git checkout gets a per-run
// worktree; anything else (shared non-git directory, unresolvable base)
// degrades to exclusive dispatch so concurrent sessions can never trample
// each other.
func (s IssueManagerService) sequentialTaskIsolation(
	issue workspaceissues.Issue,
	tasks []workspaceissues.Task,
	task workspaceissues.Task,
) (issueTaskIsolation, bool) {
	explicit := strings.TrimSpace(task.ExecutionDirectory)
	if explicit != "" && filepath.IsAbs(explicit) {
		shared := false
		for _, sibling := range tasks {
			if sibling.TaskID == task.TaskID {
				continue
			}
			if filepath.Clean(strings.TrimSpace(sibling.ExecutionDirectory)) == filepath.Clean(explicit) {
				shared = true
				break
			}
		}
		if !shared {
			return issueTaskIsolation{}, true
		}
	}
	base := s.resolveIssueTaskBaseDirectory(issue, task)
	if base == "" || !directoryIsGitRepo(base) {
		return issueTaskIsolation{}, false
	}
	return issueTaskIsolation{worktreeBase: base}, true
}

func directoryIsGitRepo(dir string) bool {
	if strings.TrimSpace(dir) == "" {
		return false
	}
	// The repo-root marker is enough: linked worktrees keep .git as a file.
	if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
		return false
	}
	return true
}

// createIssueTaskRunWorktree adds a per-run git worktree (own branch, from the
// base checkout's current HEAD) under the daemon state directory. The worktree
// is left in place after the run so the user can inspect and merge the work.
func (s IssueManagerService) createIssueTaskRunWorktree(
	ctx context.Context,
	baseDir string,
	issueID string,
	taskID string,
	runID string,
) (string, string, error) {
	suffix := strings.NewReplacer("-", "", ":", "").Replace(runID)
	if len(suffix) > 8 {
		suffix = suffix[:8]
	}
	name := taskID + "-" + suffix
	root := filepath.Join(s.taskWorktreeRoot(), issueID)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", "", fmt.Errorf("create task worktree root: %w", err)
	}
	path := filepath.Join(root, name)
	branch := "tutti/task/" + name
	worktreeCtx, cancel := context.WithTimeout(ctx, issueTaskWorktreeTimeout)
	defer cancel()
	command := exec.CommandContext(worktreeCtx, "git", "-C", baseDir, "worktree", "add", "-b", branch, path, "HEAD")
	if output, err := command.CombinedOutput(); err != nil {
		return "", "", fmt.Errorf("create task worktree: %v: %s", err, strings.TrimSpace(string(output)))
	}
	return path, branch, nil
}
