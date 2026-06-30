package agent

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"syscall"

	"github.com/tutti-os/tutti/packages/agentactivity/daemon/runtimecmd"
)

type ApplyGitPatchStatus string

const (
	ApplyGitPatchStatusSuccess        ApplyGitPatchStatus = "success"
	ApplyGitPatchStatusPartialSuccess ApplyGitPatchStatus = "partial-success"
	ApplyGitPatchStatusError          ApplyGitPatchStatus = "error"
)

type ApplyGitPatchErrorCode string

const (
	ApplyGitPatchErrorNone       ApplyGitPatchErrorCode = ""
	ApplyGitPatchErrorNotGitRepo ApplyGitPatchErrorCode = "not-git-repo"
)

type ApplyGitPatchTarget string

const (
	ApplyGitPatchTargetUnstaged          ApplyGitPatchTarget = "unstaged"
	ApplyGitPatchTargetStaged            ApplyGitPatchTarget = "staged"
	ApplyGitPatchTargetStagedAndUnstaged ApplyGitPatchTarget = "staged-and-unstaged"
)

type ApplyGitPatchInput struct {
	Cwd         string
	Diff        string
	Revert      bool
	Atomic      bool
	Target      ApplyGitPatchTarget
	AllowBinary bool
}

type ApplyGitPatchExecOutput struct {
	Command string
	Stdout  string
	Stderr  string
}

type ApplyGitPatchResult struct {
	Status          ApplyGitPatchStatus
	AppliedPaths    []string
	SkippedPaths    []string
	ConflictedPaths []string
	ErrorCode       ApplyGitPatchErrorCode
	ExecOutput      ApplyGitPatchExecOutput
}

type GitPatchSupport struct {
	Supported bool
	Root      string
	ErrorCode ApplyGitPatchErrorCode
}

type applyGitPatchOptions struct {
	TempParent string
}

type gitPatchRepo struct {
	Root            string
	DirectoryPrefix string
}

func (*Service) ApplyGitPatchForPath(ctx context.Context, workspaceID string, input ApplyGitPatchInput) (ApplyGitPatchResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	input.Cwd = strings.TrimSpace(input.Cwd)
	if workspaceID == "" || input.Cwd == "" || strings.TrimSpace(input.Diff) == "" {
		return emptyApplyGitPatchResult(ApplyGitPatchStatusError), ErrInvalidArgument
	}
	return applyGitPatchWithOptions(ctx, input, applyGitPatchOptions{})
}

func (*Service) ResolveGitPatchSupportForPath(ctx context.Context, workspaceID string, cwd string) (GitPatchSupport, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	cwd = strings.TrimSpace(cwd)
	if workspaceID == "" || cwd == "" {
		return GitPatchSupport{}, ErrInvalidArgument
	}
	repo, ok := resolveGitPatchRepo(ctx, cwd)
	if !ok {
		return GitPatchSupport{
			Supported: false,
			ErrorCode: ApplyGitPatchErrorNotGitRepo,
		}, nil
	}
	return GitPatchSupport{
		Supported: true,
		Root:      repo.Root,
	}, nil
}

func applyGitPatchWithOptions(ctx context.Context, input ApplyGitPatchInput, options applyGitPatchOptions) (ApplyGitPatchResult, error) {
	input.Cwd = strings.TrimSpace(input.Cwd)
	if input.Target == "" {
		input.Target = ApplyGitPatchTargetUnstaged
	}
	repo, ok := resolveGitPatchRepo(ctx, input.Cwd)
	if !ok {
		result := emptyApplyGitPatchResult(ApplyGitPatchStatusError)
		result.ErrorCode = ApplyGitPatchErrorNotGitRepo
		return result, nil
	}

	tempDir, err := os.MkdirTemp(options.TempParent, "tutti-apply-")
	if err != nil {
		return emptyApplyGitPatchResult(ApplyGitPatchStatusError), fmt.Errorf("create patch temp dir: %w", err)
	}
	defer func() {
		_ = os.RemoveAll(tempDir)
	}()

	patchPath := filepath.Join(tempDir, "patch.diff")
	if err := os.WriteFile(patchPath, []byte(input.Diff), 0o600); err != nil {
		return emptyApplyGitPatchResult(ApplyGitPatchStatusError), fmt.Errorf("write patch diff: %w", err)
	}

	baseEnv := runtimecmd.InjectSystemProxyEnv(gitEnvScopedToDir())
	env := baseEnv
	diffPaths := parseGitDiffPaths(input.Diff)
	if input.Target == ApplyGitPatchTargetUnstaged && !input.Atomic {
		var err error
		env, err = prepareTemporaryGitIndex(ctx, repo, tempDir, env, diffPaths)
		if err != nil {
			return emptyApplyGitPatchResult(ApplyGitPatchStatusError), err
		}
	}

	args := []string{"apply"}
	if input.Revert {
		args = append(args, "-R")
	}
	if input.AllowBinary {
		args = append(args, "--binary")
	}
	if !input.Atomic {
		args = append(args, "--3way")
	}
	switch input.Target {
	case ApplyGitPatchTargetStaged:
		args = append(args, "--cached")
	case ApplyGitPatchTargetStagedAndUnstaged:
		args = append(args, "--index")
	}
	if repo.DirectoryPrefix != "" {
		args = append(args, "--directory="+repo.DirectoryPrefix)
	}
	args = append(args, patchPath)

	execResult := runGitPatchCommand(ctx, repo.Root, env, args...)
	status := applyGitPatchStatus(execResult.ExitCode, input.Atomic)
	result := classifyGitPatchResult(status, diffPaths, execResult)
	if fallback, ok := tryApplyCreatedFileRevertFallback(ctx, repo, input, diffPaths, baseEnv, result); ok {
		return fallback, nil
	}
	return result, nil
}

func resolveGitPatchRepo(ctx context.Context, cwd string) (gitPatchRepo, bool) {
	gitCwd, err := existingGitPatchDirectory(cwd)
	if err != nil {
		return gitPatchRepo{}, false
	}
	root, err := runGitOutputWithEnv(ctx, gitCwd, runtimecmd.InjectSystemProxyEnv(gitEnvScopedToDir()), "rev-parse", "--show-toplevel")
	if err != nil {
		return gitPatchRepo{}, false
	}
	root = strings.TrimSpace(root)
	if root == "" {
		return gitPatchRepo{}, false
	}
	absRoot, err := canonicalGitPatchPath(root)
	if err != nil {
		return gitPatchRepo{}, false
	}
	absCwd, err := canonicalGitPatchPath(gitCwd)
	if err != nil {
		return gitPatchRepo{}, false
	}
	prefix := ""
	if absCwd != absRoot {
		rel, err := filepath.Rel(absRoot, absCwd)
		if err != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
			return gitPatchRepo{}, false
		}
		prefix = filepath.ToSlash(rel)
	}
	return gitPatchRepo{Root: absRoot, DirectoryPrefix: prefix}, true
}

func existingGitPatchDirectory(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", os.ErrNotExist
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	current := absPath
	for {
		info, err := os.Stat(current)
		if err == nil {
			if info.IsDir() {
				return current, nil
			}
			return filepath.Dir(current), nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", err
		}
		current = parent
	}
}

func canonicalGitPatchPath(path string) (string, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	realPath, err := filepath.EvalSymlinks(absPath)
	if err == nil {
		return realPath, nil
	}
	return absPath, nil
}

func prepareTemporaryGitIndex(ctx context.Context, repo gitPatchRepo, tempDir string, env []string, diffPaths []string) ([]string, error) {
	indexPath, err := runGitOutputWithEnv(ctx, repo.Root, env, "rev-parse", "--git-path", "index")
	if err != nil {
		return env, fmt.Errorf("resolve git index path: %w", err)
	}
	indexPath = gitPathFromOutput(repo.Root, indexPath)
	tempIndexPath := filepath.Join(tempDir, "index")
	if err := copyFileIfExists(indexPath, tempIndexPath); err != nil {
		return env, fmt.Errorf("copy git index: %w", err)
	}
	sharedIndexPath, _ := runGitOutputWithEnv(ctx, repo.Root, env, "rev-parse", "--shared-index-path")
	if sharedIndexPath = gitPathFromOutput(repo.Root, sharedIndexPath); sharedIndexPath != "" {
		_ = copyFileIfExists(sharedIndexPath, filepath.Join(tempDir, filepath.Base(sharedIndexPath)))
	}

	nextEnv := append([]string{}, env...)
	nextEnv = append(nextEnv, "GIT_INDEX_FILE="+tempIndexPath)
	paths := existingRootRelativePaths(repo, diffPaths)
	if len(paths) == 0 {
		return nextEnv, nil
	}
	args := append([]string{"add", "--"}, paths...)
	addResult := runGitPatchCommand(ctx, repo.Root, nextEnv, args...)
	if addResult.ExitCode != 0 {
		return nextEnv, fmt.Errorf("prepare temporary git index: %s", strings.TrimSpace(addResult.Stderr))
	}
	return nextEnv, nil
}

func gitPathFromOutput(root string, value string) string {
	path := strings.TrimSpace(value)
	if path == "" {
		return ""
	}
	if filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(root, filepath.FromSlash(path))
}

func copyFileIfExists(source string, destination string) error {
	if strings.TrimSpace(source) == "" {
		return nil
	}
	content, err := os.ReadFile(source)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	return os.WriteFile(destination, content, 0o600)
}

func existingRootRelativePaths(repo gitPatchRepo, diffPaths []string) []string {
	paths := make([]string, 0, len(diffPaths))
	seen := make(map[string]bool, len(diffPaths))
	for _, path := range diffPaths {
		rootRelative := rootRelativePatchPath(repo, path)
		if rootRelative == "" || seen[rootRelative] {
			continue
		}
		if _, err := os.Stat(filepath.Join(repo.Root, filepath.FromSlash(rootRelative))); err != nil {
			continue
		}
		seen[rootRelative] = true
		paths = append(paths, rootRelative)
	}
	return paths
}

func rootRelativePatchPath(repo gitPatchRepo, path string) string {
	path = strings.TrimSpace(strings.TrimPrefix(path, "a/"))
	path = strings.TrimPrefix(path, "b/")
	if path == "" || path == "/dev/null" || path == "dev/null" {
		return ""
	}
	if repo.DirectoryPrefix == "" {
		return filepath.ToSlash(filepath.Clean(path))
	}
	return filepath.ToSlash(filepath.Join(filepath.FromSlash(repo.DirectoryPrefix), filepath.FromSlash(path)))
}

type gitPatchCommandResult struct {
	Args     []string
	ExitCode int
	Stdout   string
	Stderr   string
}

func runGitPatchCommand(ctx context.Context, cwd string, env []string, args ...string) gitPatchCommandResult {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = cwd
	cmd.Env = env
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	code := 0
	if err != nil {
		code = -1
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			if status, ok := exitErr.Sys().(syscall.WaitStatus); ok {
				code = status.ExitStatus()
			}
		}
	}
	return gitPatchCommandResult{
		Args:     append([]string{}, args...),
		ExitCode: code,
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
	}
}

func runGitOutputWithEnv(ctx context.Context, cwd string, env []string, args ...string) (string, error) {
	result := runGitPatchCommand(ctx, cwd, env, args...)
	if result.ExitCode != 0 {
		return "", fmt.Errorf("git %s failed: %s", strings.Join(args, " "), strings.TrimSpace(result.Stderr))
	}
	return result.Stdout, nil
}

func applyGitPatchStatus(exitCode int, atomic bool) ApplyGitPatchStatus {
	if exitCode == 0 {
		return ApplyGitPatchStatusSuccess
	}
	if exitCode == 1 && !atomic {
		return ApplyGitPatchStatusPartialSuccess
	}
	return ApplyGitPatchStatusError
}

func classifyGitPatchResult(status ApplyGitPatchStatus, diffPaths []string, execResult gitPatchCommandResult) ApplyGitPatchResult {
	result := emptyApplyGitPatchResult(status)
	result.ExecOutput = ApplyGitPatchExecOutput{
		Command: "git " + strings.Join(execResult.Args, " "),
		Stdout:  execResult.Stdout,
		Stderr:  execResult.Stderr,
	}
	if status == ApplyGitPatchStatusSuccess {
		result.AppliedPaths = append([]string{}, diffPaths...)
		return result
	}
	result.AppliedPaths = parseGitApplyCleanPaths(execResult.Stdout + "\n" + execResult.Stderr)
	result.ConflictedPaths = parseGitApplyConflictedPaths(execResult.Stdout + "\n" + execResult.Stderr)
	result.SkippedPaths = remainingPatchPaths(diffPaths, result.AppliedPaths, result.ConflictedPaths)
	return result
}

func tryApplyCreatedFileRevertFallback(ctx context.Context, repo gitPatchRepo, input ApplyGitPatchInput, diffPaths []string, env []string, result ApplyGitPatchResult) (ApplyGitPatchResult, bool) {
	if result.Status == ApplyGitPatchStatusSuccess || !input.Revert || input.Atomic || input.Target != ApplyGitPatchTargetUnstaged {
		return result, false
	}
	createdFiles := parseCreatedPatchFiles(input.Diff)
	if len(createdFiles) == 0 || len(createdFiles) != len(diffPaths) {
		return result, false
	}

	rootRelativePaths := make([]string, 0, len(createdFiles))
	for _, file := range createdFiles {
		rootRelative := rootRelativePatchPath(repo, file.Path)
		if rootRelative == "" || !gitPatchPathIsUntracked(ctx, repo.Root, env, rootRelative) {
			return result, false
		}
		content, err := os.ReadFile(filepath.Join(repo.Root, filepath.FromSlash(rootRelative)))
		if err != nil || !createdPatchContentMatches(string(content), file.Content) {
			return result, false
		}
		rootRelativePaths = append(rootRelativePaths, rootRelative)
	}

	for _, path := range rootRelativePaths {
		if err := os.Remove(filepath.Join(repo.Root, filepath.FromSlash(path))); err != nil {
			return result, false
		}
	}
	fallback := emptyApplyGitPatchResult(ApplyGitPatchStatusSuccess)
	fallback.AppliedPaths = append([]string{}, diffPaths...)
	fallback.ExecOutput = result.ExecOutput
	return fallback, true
}

func emptyApplyGitPatchResult(status ApplyGitPatchStatus) ApplyGitPatchResult {
	return ApplyGitPatchResult{
		Status:          status,
		AppliedPaths:    []string{},
		SkippedPaths:    []string{},
		ConflictedPaths: []string{},
		ErrorCode:       ApplyGitPatchErrorNone,
	}
}

var (
	gitDiffHeaderPattern       = regexp.MustCompile(`(?m)^diff --git a/(.+?) b/(.+?)$`)
	gitDiffOldNewHeaderPattern = regexp.MustCompile(`(?m)^(?:---|\+\+\+)\s+(?:a/|b/)?([^\n]+)$`)
	gitApplyCleanPattern       = regexp.MustCompile(`(?m)Applied patch to '([^']+)' cleanly\.`)
	gitApplyConflictPattern    = regexp.MustCompile(`(?m)(?:Applied patch to '([^']+)' with conflicts\.|^U\s+(.+)$)`)
)

func parseGitDiffPaths(diff string) []string {
	seen := map[string]bool{}
	var paths []string
	add := func(path string) {
		path = normalizePatchResultPath(path)
		if path == "" || seen[path] {
			return
		}
		seen[path] = true
		paths = append(paths, path)
	}
	for _, match := range gitDiffHeaderPattern.FindAllStringSubmatch(diff, -1) {
		if len(match) >= 3 {
			add(match[2])
		}
	}
	if len(paths) > 0 {
		return paths
	}
	for _, match := range gitDiffOldNewHeaderPattern.FindAllStringSubmatch(diff, -1) {
		if len(match) >= 2 {
			add(match[1])
		}
	}
	return paths
}

func parseGitApplyCleanPaths(output string) []string {
	return parseGitApplyPaths(output, gitApplyCleanPattern)
}

func parseGitApplyConflictedPaths(output string) []string {
	return parseGitApplyPaths(output, gitApplyConflictPattern)
}

func parseGitApplyPaths(output string, pattern *regexp.Regexp) []string {
	seen := map[string]bool{}
	var paths []string
	for _, match := range pattern.FindAllStringSubmatch(output, -1) {
		for _, group := range match[1:] {
			path := normalizePatchResultPath(group)
			if path == "" || seen[path] {
				continue
			}
			seen[path] = true
			paths = append(paths, path)
			break
		}
	}
	return paths
}

func remainingPatchPaths(all []string, applied []string, conflicted []string) []string {
	var remaining []string
	for _, path := range all {
		if slices.Contains(applied, path) || slices.Contains(conflicted, path) {
			continue
		}
		remaining = append(remaining, path)
	}
	return remaining
}

type createdPatchFile struct {
	Path    string
	Content string
}

func parseCreatedPatchFiles(diff string) []createdPatchFile {
	lines := strings.Split(strings.ReplaceAll(diff, "\r\n", "\n"), "\n")
	files := []createdPatchFile{}
	for index := 0; index < len(lines); {
		if !strings.HasPrefix(lines[index], "diff --git ") {
			index++
			continue
		}
		next := index + 1
		for next < len(lines) && !strings.HasPrefix(lines[next], "diff --git ") {
			next++
		}
		if file, ok := parseCreatedPatchFile(lines[index:next]); ok {
			files = append(files, file)
		}
		index = next
	}
	return files
}

func parseCreatedPatchFile(lines []string) (createdPatchFile, bool) {
	if len(lines) == 0 {
		return createdPatchFile{}, false
	}
	header := gitDiffHeaderPattern.FindStringSubmatch(lines[0])
	if len(header) < 3 {
		return createdPatchFile{}, false
	}
	hasNewFileMode := false
	hasDevNullOldPath := false
	var content strings.Builder
	inHunk := false
	for _, line := range lines[1:] {
		if strings.HasPrefix(line, "new file mode ") {
			hasNewFileMode = true
			continue
		}
		if line == "--- /dev/null" {
			hasDevNullOldPath = true
			continue
		}
		if strings.HasPrefix(line, "@@ ") {
			inHunk = true
			continue
		}
		if !inHunk {
			continue
		}
		if line == `\ No newline at end of file` {
			value := content.String()
			content.Reset()
			content.WriteString(strings.TrimSuffix(value, "\n"))
			continue
		}
		if strings.HasPrefix(line, "+") && !strings.HasPrefix(line, "+++") {
			content.WriteString(strings.TrimPrefix(line, "+"))
			content.WriteByte('\n')
		}
	}
	if !hasNewFileMode || !hasDevNullOldPath {
		return createdPatchFile{}, false
	}
	return createdPatchFile{
		Path:    normalizePatchResultPath(header[2]),
		Content: content.String(),
	}, true
}

func gitPatchPathIsUntracked(ctx context.Context, repoRoot string, env []string, path string) bool {
	result := runGitPatchCommand(ctx, repoRoot, env, "ls-files", "--error-unmatch", "--", path)
	return result.ExitCode == 1
}

func createdPatchContentMatches(current string, expected string) bool {
	current = strings.ReplaceAll(current, "\r\n", "\n")
	expected = strings.ReplaceAll(expected, "\r\n", "\n")
	return current == expected || strings.TrimRight(current, "\n") == strings.TrimRight(expected, "\n")
}

func normalizePatchResultPath(path string) string {
	path = strings.TrimSpace(path)
	path = strings.TrimPrefix(path, "a/")
	path = strings.TrimPrefix(path, "b/")
	if path == "" || path == "/dev/null" || path == "dev/null" {
		return ""
	}
	return filepath.ToSlash(filepath.Clean(path))
}
