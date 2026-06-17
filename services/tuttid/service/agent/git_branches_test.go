package agent

import (
	"context"
	"os/exec"
	"testing"
)

func runGitForTest(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	// Scope git strictly to dir: drop any ambient GIT_DIR/GIT_WORK_TREE (reusing
	// the production scoping) and stop upward repo discovery, so the helper can
	// never reach or mutate an outer repository even when run inside one.
	cmd.Env = append(gitEnvScopedToDir(),
		"GIT_CEILING_DIRECTORIES="+dir,
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func TestListGitBranches(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	runGitForTest(t, dir, "init", "-q", "-b", "main")
	runGitForTest(t, dir, "commit", "-q", "--allow-empty", "-m", "init")
	runGitForTest(t, dir, "branch", "feature/x")

	got, err := listGitBranches(context.Background(), dir)
	if err != nil {
		t.Fatalf("listGitBranches: %v", err)
	}
	if got.CurrentBranch != "main" {
		t.Fatalf("currentBranch = %q, want main", got.CurrentBranch)
	}
	want := map[string]bool{"main": true, "feature/x": true}
	if len(got.Branches) != len(want) {
		t.Fatalf("branches = %#v, want %v", got.Branches, want)
	}
	for _, b := range got.Branches {
		if !want[b] {
			t.Fatalf("unexpected branch %q in %#v", b, got.Branches)
		}
	}
}

func TestListGitBranchesNonRepoDegradesToEmpty(t *testing.T) {
	t.Parallel()
	got, err := listGitBranches(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("listGitBranches non-repo returned error: %v", err)
	}
	if len(got.Branches) != 0 || got.CurrentBranch != "" {
		t.Fatalf("non-repo result = %#v, want empty", got)
	}
}

func TestListGitBranchesEmptyCwd(t *testing.T) {
	t.Parallel()
	got, err := listGitBranches(context.Background(), "  ")
	if err != nil || len(got.Branches) != 0 {
		t.Fatalf("empty cwd result = %#v err=%v, want empty", got, err)
	}
}
