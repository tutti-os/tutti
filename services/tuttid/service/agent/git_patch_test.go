package agent

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
)

func TestApplyGitPatchRevertsDiffAndCleansTempDir(t *testing.T) {
	t.Parallel()
	requireGitForPatchTest(t)

	dir := t.TempDir()
	runGitForTest(t, dir, "init", "-q", "-b", "main")
	writeTextForPatchTest(t, filepath.Join(dir, "a.txt"), "old\n")
	runGitForTest(t, dir, "add", "a.txt")
	runGitForTest(t, dir, "commit", "-q", "-m", "init")
	writeTextForPatchTest(t, filepath.Join(dir, "a.txt"), "newer\n")
	diff := gitOutputForPatchTest(t, dir, "diff", "--", "a.txt")
	tempParent := t.TempDir()

	result, err := applyGitPatchWithOptions(context.Background(), ApplyGitPatchInput{
		Cwd:    dir,
		Diff:   diff,
		Revert: true,
	}, applyGitPatchOptions{TempParent: tempParent})
	if err != nil {
		t.Fatalf("applyGitPatchWithOptions returned error: %v", err)
	}
	if result.Status != ApplyGitPatchStatusSuccess {
		t.Fatalf("status = %q, want %q, result=%#v", result.Status, ApplyGitPatchStatusSuccess, result)
	}
	if got := readTextForPatchTest(t, filepath.Join(dir, "a.txt")); got != "old\n" {
		t.Fatalf("a.txt = %q, want old", got)
	}
	if !slices.Equal(result.AppliedPaths, []string{"a.txt"}) {
		t.Fatalf("appliedPaths = %#v, want [a.txt]", result.AppliedPaths)
	}
	if entries := mustReadDirForPatchTest(t, tempParent); len(entries) != 0 {
		t.Fatalf("temp parent still has entries after apply: %#v", entries)
	}
}

func TestApplyGitPatchSupportsCwdRelativeDiffs(t *testing.T) {
	t.Parallel()
	requireGitForPatchTest(t)

	dir := t.TempDir()
	subdir := filepath.Join(dir, "sub")
	if err := os.MkdirAll(subdir, 0o755); err != nil {
		t.Fatalf("mkdir subdir: %v", err)
	}
	runGitForTest(t, dir, "init", "-q", "-b", "main")
	writeTextForPatchTest(t, filepath.Join(subdir, "a.txt"), "old\n")
	runGitForTest(t, dir, "add", "sub/a.txt")
	runGitForTest(t, dir, "commit", "-q", "-m", "init")
	diff := "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"

	result, err := applyGitPatchWithOptions(context.Background(), ApplyGitPatchInput{
		Cwd:  subdir,
		Diff: diff,
	}, applyGitPatchOptions{TempParent: t.TempDir()})
	if err != nil {
		t.Fatalf("applyGitPatchWithOptions returned error: %v", err)
	}
	if result.Status != ApplyGitPatchStatusSuccess {
		t.Fatalf("status = %q, want %q, result=%#v", result.Status, ApplyGitPatchStatusSuccess, result)
	}
	if got := readTextForPatchTest(t, filepath.Join(subdir, "a.txt")); got != "new\n" {
		t.Fatalf("sub/a.txt = %q, want new", got)
	}
}

func TestApplyGitPatchRevertsCreatedUntrackedFileWithTrailingBlankLineDrift(t *testing.T) {
	t.Parallel()
	requireGitForPatchTest(t)

	dir := t.TempDir()
	runGitForTest(t, dir, "init", "-q", "-b", "main")
	writeTextForPatchTest(t, filepath.Join(dir, "README.md"), "base\n")
	runGitForTest(t, dir, "add", "README.md")
	runGitForTest(t, dir, "commit", "-q", "-m", "init")
	writeTextForPatchTest(t, filepath.Join(dir, "hello_world.md"), "# Hello, world!\n\n")
	diff := "diff --git a/hello_world.md b/hello_world.md\nnew file mode 100644\n--- /dev/null\n+++ b/hello_world.md\n@@ -0,0 +1,1 @@\n+# Hello, world!\n"

	result, err := applyGitPatchWithOptions(context.Background(), ApplyGitPatchInput{
		Cwd:    dir,
		Diff:   diff,
		Revert: true,
	}, applyGitPatchOptions{TempParent: t.TempDir()})
	if err != nil {
		t.Fatalf("applyGitPatchWithOptions returned error: %v", err)
	}
	if result.Status != ApplyGitPatchStatusSuccess {
		t.Fatalf("status = %q, want %q, result=%#v", result.Status, ApplyGitPatchStatusSuccess, result)
	}
	if _, err := os.Stat(filepath.Join(dir, "hello_world.md")); !os.IsNotExist(err) {
		t.Fatalf("hello_world.md still exists or stat failed with unexpected error: %v", err)
	}
	if !slices.Equal(result.AppliedPaths, []string{"hello_world.md"}) {
		t.Fatalf("appliedPaths = %#v, want [hello_world.md]", result.AppliedPaths)
	}
}

func TestApplyGitPatchDoesNotFallbackDeleteChangedCreatedFile(t *testing.T) {
	t.Parallel()
	requireGitForPatchTest(t)

	dir := t.TempDir()
	runGitForTest(t, dir, "init", "-q", "-b", "main")
	writeTextForPatchTest(t, filepath.Join(dir, "README.md"), "base\n")
	runGitForTest(t, dir, "add", "README.md")
	runGitForTest(t, dir, "commit", "-q", "-m", "init")
	writeTextForPatchTest(t, filepath.Join(dir, "hello_world.md"), "# Hello, world!\nchanged\n")
	diff := "diff --git a/hello_world.md b/hello_world.md\nnew file mode 100644\n--- /dev/null\n+++ b/hello_world.md\n@@ -0,0 +1,1 @@\n+# Hello, world!\n"

	result, err := applyGitPatchWithOptions(context.Background(), ApplyGitPatchInput{
		Cwd:    dir,
		Diff:   diff,
		Revert: true,
	}, applyGitPatchOptions{TempParent: t.TempDir()})
	if err != nil {
		t.Fatalf("applyGitPatchWithOptions returned error: %v", err)
	}
	if result.Status == ApplyGitPatchStatusSuccess {
		t.Fatalf("status = %q, want non-success result=%#v", result.Status, result)
	}
	if got := readTextForPatchTest(t, filepath.Join(dir, "hello_world.md")); got != "# Hello, world!\nchanged\n" {
		t.Fatalf("hello_world.md = %q, want changed file preserved", got)
	}
}

func TestApplyGitPatchDoesNotPolluteRealIndex(t *testing.T) {
	t.Parallel()
	requireGitForPatchTest(t)

	dir := t.TempDir()
	runGitForTest(t, dir, "init", "-q", "-b", "main")
	writeTextForPatchTest(t, filepath.Join(dir, "a.txt"), "old\n")
	writeTextForPatchTest(t, filepath.Join(dir, "staged.txt"), "base\n")
	runGitForTest(t, dir, "add", ".")
	runGitForTest(t, dir, "commit", "-q", "-m", "init")
	writeTextForPatchTest(t, filepath.Join(dir, "staged.txt"), "staged\n")
	runGitForTest(t, dir, "add", "staged.txt")
	stagedBefore := gitOutputForPatchTest(t, dir, "diff", "--cached")
	diff := "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"

	result, err := applyGitPatchWithOptions(context.Background(), ApplyGitPatchInput{
		Cwd:  dir,
		Diff: diff,
	}, applyGitPatchOptions{TempParent: t.TempDir()})
	if err != nil {
		t.Fatalf("applyGitPatchWithOptions returned error: %v", err)
	}
	if result.Status != ApplyGitPatchStatusSuccess {
		t.Fatalf("status = %q, want %q, result=%#v", result.Status, ApplyGitPatchStatusSuccess, result)
	}
	stagedAfter := gitOutputForPatchTest(t, dir, "diff", "--cached")
	if stagedAfter != stagedBefore {
		t.Fatalf("cached diff changed\nbefore:\n%s\nafter:\n%s", stagedBefore, stagedAfter)
	}
}

func TestApplyGitPatchNonRepo(t *testing.T) {
	t.Parallel()
	requireGitForPatchTest(t)

	result, err := applyGitPatchWithOptions(context.Background(), ApplyGitPatchInput{
		Cwd:  t.TempDir(),
		Diff: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
	}, applyGitPatchOptions{TempParent: t.TempDir()})
	if err != nil {
		t.Fatalf("applyGitPatchWithOptions returned error: %v", err)
	}
	if result.Status != ApplyGitPatchStatusError || result.ErrorCode != ApplyGitPatchErrorNotGitRepo {
		t.Fatalf("result = %#v, want not-git-repo error", result)
	}
}

func TestResolveGitPatchSupportForPath(t *testing.T) {
	t.Parallel()
	requireGitForPatchTest(t)

	service := &Service{}
	dir := t.TempDir()
	runGitForTest(t, dir, "init", "-q", "-b", "main")

	supported, err := service.ResolveGitPatchSupportForPath(context.Background(), "workspace-1", dir)
	if err != nil {
		t.Fatalf("ResolveGitPatchSupportForPath returned error: %v", err)
	}
	if !supported.Supported || supported.Root == "" || supported.ErrorCode != ApplyGitPatchErrorNone {
		t.Fatalf("supported = %#v, want supported git repo", supported)
	}

	filePath := filepath.Join(dir, "hello_world.md")
	writeTextForPatchTest(t, filePath, "# Hello\n")
	filePathSupported, err := service.ResolveGitPatchSupportForPath(context.Background(), "workspace-1", filePath)
	if err != nil {
		t.Fatalf("ResolveGitPatchSupportForPath file path returned error: %v", err)
	}
	if !filePathSupported.Supported || filePathSupported.Root != supported.Root || filePathSupported.ErrorCode != ApplyGitPatchErrorNone {
		t.Fatalf("filePathSupported = %#v, want supported git repo rooted at %q", filePathSupported, supported.Root)
	}

	missingFileSupported, err := service.ResolveGitPatchSupportForPath(context.Background(), "workspace-1", filepath.Join(dir, "nested", "new.md"))
	if err != nil {
		t.Fatalf("ResolveGitPatchSupportForPath missing file path returned error: %v", err)
	}
	if !missingFileSupported.Supported || missingFileSupported.Root != supported.Root || missingFileSupported.ErrorCode != ApplyGitPatchErrorNone {
		t.Fatalf("missingFileSupported = %#v, want supported git repo rooted at %q", missingFileSupported, supported.Root)
	}

	unsupported, err := service.ResolveGitPatchSupportForPath(context.Background(), "workspace-1", t.TempDir())
	if err != nil {
		t.Fatalf("ResolveGitPatchSupportForPath non-repo returned error: %v", err)
	}
	if unsupported.Supported || unsupported.ErrorCode != ApplyGitPatchErrorNotGitRepo {
		t.Fatalf("unsupported = %#v, want not-git-repo", unsupported)
	}
}

func requireGitForPatchTest(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
}

func gitOutputForPatchTest(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(gitEnvScopedToDir(),
		"GIT_CEILING_DIRECTORIES="+dir,
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
	)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return string(out)
}

func writeTextForPatchTest(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func readTextForPatchTest(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(content)
}

func mustReadDirForPatchTest(t *testing.T, path string) []os.DirEntry {
	t.Helper()
	entries, err := os.ReadDir(path)
	if err != nil {
		t.Fatalf("read dir %s: %v", path, err)
	}
	return entries
}
