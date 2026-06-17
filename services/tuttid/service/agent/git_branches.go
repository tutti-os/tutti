package agent

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"time"
)

// gitBranchListTimeout bounds the git subprocesses backing the review picker so
// a hung working directory (e.g. a stalled network mount) degrades to an empty
// result instead of blocking the request, mirroring the timeout the app
// factory applies to its own exec calls.
const gitBranchListTimeout = 5 * time.Second

// GitBranches describes the local branches of a working directory plus the
// currently checked-out branch (empty when detached or unknown).
type GitBranches struct {
	Branches      []string
	CurrentBranch string
}

// listGitBranches lists local git branches for a working directory. A missing
// directory, a non-git directory, or an unavailable git binary degrades
// gracefully to an empty result rather than an error: the review picker simply
// offers no branches instead of surfacing a failure.
func listGitBranches(ctx context.Context, cwd string) (GitBranches, error) {
	cwd = strings.TrimSpace(cwd)
	if cwd == "" {
		return GitBranches{}, nil
	}
	ctx, cancel := context.WithTimeout(ctx, gitBranchListTimeout)
	defer cancel()
	out, err := runGit(ctx, cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads")
	if err != nil {
		return GitBranches{}, nil
	}
	var branches []string
	for _, line := range strings.Split(out, "\n") {
		if name := strings.TrimSpace(line); name != "" {
			branches = append(branches, name)
		}
	}
	currentBranch := gitCurrentBranch(ctx, cwd)
	return GitBranches{
		Branches:      branches,
		CurrentBranch: currentBranch,
	}, nil
}

// gitCurrentBranch returns the checked-out branch name, or "" when the working
// directory is in a detached-HEAD state or the lookup fails.
func gitCurrentBranch(ctx context.Context, cwd string) string {
	out, err := runGit(ctx, cwd, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return ""
	}
	branch := strings.TrimSpace(out)
	if branch == "HEAD" {
		return ""
	}
	return branch
}

func runGit(ctx context.Context, cwd string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = cwd
	// Resolve the repository from cwd, never from an ambient GIT_DIR/GIT_WORK_TREE
	// in the daemon's environment, so the picker always reflects the session's
	// working directory.
	cmd.Env = gitEnvScopedToDir()
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// gitEnvScopedToDir returns the process environment with the repository-pointing
// overrides stripped, so git discovers the repo from the command's working
// directory instead of an inherited GIT_DIR/GIT_WORK_TREE.
func gitEnvScopedToDir() []string {
	env := os.Environ()
	scoped := make([]string, 0, len(env))
	for _, kv := range env {
		if strings.HasPrefix(kv, "GIT_DIR=") || strings.HasPrefix(kv, "GIT_WORK_TREE=") {
			continue
		}
		scoped = append(scoped, kv)
	}
	return scoped
}
