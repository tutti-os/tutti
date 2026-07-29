package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const (
	WorktreeIsolationMode        = "worktree"
	worktreeIsolationContextKey  = "isolation"
	worktreeDirtyBaseWarningCode = "worktree_base_dirty"
	worktreeGitOperationTimeout  = 30 * time.Second
)

var (
	ErrNotAGitRepo           = errors.New("cwd is not a git repository")
	ErrGitUnavailable        = errors.New("git is unavailable")
	ErrUnsupportedRepoLayout = errors.New("git repository layout is unsupported")
	ErrWorktreeCreateFailed  = errors.New("git worktree creation failed")
)

type WorktreeIsolationError struct {
	Kind   error
	Detail string
}

func (e *WorktreeIsolationError) Error() string {
	if e == nil {
		return ""
	}
	if detail := strings.TrimSpace(e.Detail); detail != "" {
		return detail
	}
	if e.Kind != nil {
		return e.Kind.Error()
	}
	return "worktree isolation failed"
}

func (e *WorktreeIsolationError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Kind
}

type sessionWorktreeRecord struct {
	SessionIsolation
	SessionID   string `json:"sessionId"`
	WorkspaceID string `json:"workspaceId"`
	RepoRoot    string `json:"repoRoot"`
	// GitCommonDir anchors GC git operations to the main repository's git
	// directory, which stays valid even when RepoRoot was itself a linked
	// worktree that has since been garbage-collected.
	GitCommonDir string `json:"gitCommonDir,omitempty"`
}

func worktreeGitAnchor(record sessionWorktreeRecord) (string, []string) {
	if common := strings.TrimSpace(record.GitCommonDir); common != "" {
		return common, []string{"--git-dir", common}
	}
	return record.RepoRoot, nil
}

func gitRepoOutput(ctx context.Context, record sessionWorktreeRecord, args ...string) (string, error) {
	dir, prefix := worktreeGitAnchor(record)
	return gitOutput(ctx, dir, append(append([]string(nil), prefix...), args...)...)
}

func (s *Service) worktreeStateDir() string {
	if s != nil {
		if stateDir := strings.TrimSpace(s.WorktreeStateDir); stateDir != "" {
			return filepath.Clean(stateDir)
		}
	}
	return tuttitypes.DefaultStateDir()
}

func (s *Service) createSessionWorktree(
	ctx context.Context,
	workspaceID string,
	cwd string,
	sessionID string,
) (SessionIsolation, []SessionWarning, error) {
	return createSessionWorktree(ctx, s.worktreeStateDir(), workspaceID, cwd, sessionID)
}

func createSessionWorktree(
	ctx context.Context,
	stateDir string,
	workspaceID string,
	cwd string,
	sessionID string,
) (SessionIsolation, []SessionWarning, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return SessionIsolation{}, nil, &WorktreeIsolationError{Kind: ErrGitUnavailable, Detail: err.Error()}
	}
	cwd = strings.TrimSpace(cwd)
	if cwd == "" {
		return SessionIsolation{}, nil, &WorktreeIsolationError{Kind: ErrNotAGitRepo}
	}
	absCwd, err := filepath.Abs(cwd)
	if err != nil {
		return SessionIsolation{}, nil, &WorktreeIsolationError{Kind: ErrNotAGitRepo, Detail: err.Error()}
	}
	if resolved, resolveErr := filepath.EvalSymlinks(absCwd); resolveErr == nil {
		absCwd = resolved
	}
	repoRoot, err := gitOutput(ctx, absCwd, "rev-parse", "--show-toplevel")
	if err != nil || strings.TrimSpace(repoRoot) == "" {
		return SessionIsolation{}, nil, &WorktreeIsolationError{Kind: ErrNotAGitRepo, Detail: gitErrorDetail(err)}
	}
	repoRoot = filepath.Clean(strings.TrimSpace(repoRoot))
	if resolved, resolveErr := filepath.EvalSymlinks(repoRoot); resolveErr == nil {
		repoRoot = resolved
	}
	if superproject, superErr := gitOutput(ctx, repoRoot, "rev-parse", "--show-superproject-working-tree"); superErr == nil && strings.TrimSpace(superproject) != "" {
		return SessionIsolation{}, nil, &WorktreeIsolationError{Kind: ErrUnsupportedRepoLayout, Detail: "git submodules are not supported for worktree isolation"}
	}
	if outerRoot, outerErr := gitOutput(ctx, filepath.Dir(repoRoot), "rev-parse", "--show-toplevel"); outerErr == nil && strings.TrimSpace(outerRoot) != "" && filepath.Clean(strings.TrimSpace(outerRoot)) != repoRoot {
		return SessionIsolation{}, nil, &WorktreeIsolationError{Kind: ErrUnsupportedRepoLayout, Detail: "nested git repositories are not supported for worktree isolation"}
	}
	commonDirOut, err := gitOutput(ctx, absCwd, "rev-parse", "--git-common-dir")
	if err != nil || strings.TrimSpace(commonDirOut) == "" {
		return SessionIsolation{}, nil, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: gitErrorDetail(err)}
	}
	gitCommonDir := strings.TrimSpace(commonDirOut)
	if !filepath.IsAbs(gitCommonDir) {
		gitCommonDir = filepath.Join(absCwd, gitCommonDir)
	}
	gitCommonDir = filepath.Clean(gitCommonDir)
	if resolved, resolveErr := filepath.EvalSymlinks(gitCommonDir); resolveErr == nil {
		gitCommonDir = resolved
	}
	baseCommit, err := gitOutput(ctx, repoRoot, "rev-parse", "HEAD")
	if err != nil || strings.TrimSpace(baseCommit) == "" {
		return SessionIsolation{}, nil, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: gitErrorDetail(err)}
	}
	baseCommit = strings.TrimSpace(baseCommit)
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" || filepath.Base(sessionID) != sessionID || strings.ContainsAny(sessionID, `/\\`) {
		return SessionIsolation{}, nil, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: "agent session id is unsafe for a worktree path"}
	}
	worktreesRoot := filepath.Join(filepath.Clean(stateDir), "agent", "worktrees")
	worktreePath := filepath.Join(worktreesRoot, sessionID)
	branch := "tutti/" + sessionID
	if _, statErr := os.Lstat(worktreePath); statErr == nil || !errors.Is(statErr, os.ErrNotExist) {
		return SessionIsolation{}, nil, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: "session worktree path already exists"}
	}
	if _, statErr := os.Lstat(worktreeRecordPath(worktreesRoot, sessionID)); statErr == nil || !errors.Is(statErr, os.ErrNotExist) {
		return SessionIsolation{}, nil, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: "session worktree metadata already exists"}
	}
	if _, branchErr := gitOutput(ctx, repoRoot, "show-ref", "--verify", "refs/heads/"+branch); branchErr == nil {
		return SessionIsolation{}, nil, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: "session worktree branch already exists"}
	}
	info := SessionIsolation{Mode: WorktreeIsolationMode, WorktreePath: worktreePath, Branch: branch, BaseCommit: baseCommit}
	record := sessionWorktreeRecord{
		SessionIsolation: info,
		SessionID:        sessionID, WorkspaceID: strings.TrimSpace(workspaceID),
		RepoRoot: repoRoot, GitCommonDir: gitCommonDir,
	}
	if err := writeSessionWorktreeRecord(worktreesRoot, record); err != nil {
		return SessionIsolation{}, nil, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: err.Error()}
	}
	created := false
	defer func() {
		if !created {
			rollbackSessionWorktree(context.Background(), worktreesRoot, record)
		}
	}()
	if _, err := gitOutput(ctx, repoRoot, "worktree", "add", "-b", branch, worktreePath, baseCommit); err != nil {
		return SessionIsolation{}, nil, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: gitErrorDetail(err)}
	}
	created = true
	warnings := []SessionWarning(nil)
	if status, statusErr := gitOutput(ctx, repoRoot, "status", "--porcelain"); statusErr == nil && strings.TrimSpace(status) != "" {
		warnings = append(warnings, SessionWarning{
			Code:    worktreeDirtyBaseWarningCode,
			Message: "The source checkout has uncommitted changes; the isolated worktree is based on HEAD and does not include them.",
		})
	}
	return info, warnings, nil
}

type gitCommandError struct {
	err    error
	detail string
}

func (e *gitCommandError) Error() string { return strings.TrimSpace(e.detail) }
func (e *gitCommandError) Unwrap() error { return e.err }

func gitOutput(ctx context.Context, cwd string, args ...string) (string, error) {
	commandCtx, cancel := context.WithTimeout(ctx, worktreeGitOperationTimeout)
	defer cancel()
	cmd := exec.CommandContext(commandCtx, "git", args...)
	cmd.Dir = cwd
	cmd.Env = gitEnvScopedToDir()
	out, err := cmd.CombinedOutput()
	if err != nil {
		detail := strings.TrimSpace(string(out))
		if detail == "" {
			detail = err.Error()
		}
		return "", &gitCommandError{err: err, detail: detail}
	}
	return string(out), nil
}

func gitErrorDetail(err error) string {
	if err == nil {
		return ""
	}
	return strings.TrimSpace(err.Error())
}

func sessionIsolationRuntimeContext(runtimeContext map[string]any, isolation SessionIsolation) map[string]any {
	result := clonePayload(runtimeContext)
	if result == nil {
		result = map[string]any{}
	}
	result[worktreeIsolationContextKey] = map[string]any{
		"mode": isolation.Mode, "worktreePath": isolation.WorktreePath,
		"branch": isolation.Branch, "baseCommit": isolation.BaseCommit,
	}
	return result
}

func sessionIsolationFromRuntimeContext(runtimeContext map[string]any) *SessionIsolation {
	raw := runtimeContext[worktreeIsolationContextKey]
	if raw == nil {
		return nil
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var isolation SessionIsolation
	if err := json.Unmarshal(data, &isolation); err != nil || strings.TrimSpace(isolation.Mode) == "" {
		return nil
	}
	return &isolation
}

func worktreeRecordsDir(worktreesRoot string) string {
	return filepath.Join(worktreesRoot, ".metadata")
}

func worktreeRecordPath(worktreesRoot string, sessionID string) string {
	return filepath.Join(worktreeRecordsDir(worktreesRoot), sessionID+".json")
}

func writeSessionWorktreeRecord(worktreesRoot string, record sessionWorktreeRecord) error {
	if err := os.MkdirAll(worktreeRecordsDir(worktreesRoot), 0o700); err != nil {
		return fmt.Errorf("create worktree metadata directory: %w", err)
	}
	data, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("marshal worktree metadata: %w", err)
	}
	path := worktreeRecordPath(worktreesRoot, record.SessionID)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("write worktree metadata: %w", err)
	}
	written := false
	defer func() {
		_ = file.Close()
		if !written {
			_ = os.Remove(path)
		}
	}()
	if _, err := file.Write(data); err != nil {
		return fmt.Errorf("write worktree metadata: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("write worktree metadata: %w", err)
	}
	written = true
	return nil
}

func rollbackSessionWorktree(ctx context.Context, worktreesRoot string, record sessionWorktreeRecord) {
	_, _ = gitRepoOutput(ctx, record, "worktree", "remove", "--force", record.WorktreePath)
	_ = os.RemoveAll(record.WorktreePath)
	_, _ = gitRepoOutput(ctx, record, "branch", "-D", record.Branch)
	_, _ = gitRepoOutput(ctx, record, "worktree", "prune")
	_ = os.Remove(worktreeRecordPath(worktreesRoot, record.SessionID))
}

func (s *Service) rollbackSessionWorktree(ctx context.Context, isolation SessionIsolation) {
	worktreesRoot := filepath.Join(s.worktreeStateDir(), "agent", "worktrees")
	record, err := readSessionWorktreeRecord(worktreeRecordPath(worktreesRoot, filepath.Base(isolation.WorktreePath)))
	if err == nil {
		rollbackSessionWorktree(ctx, worktreesRoot, record)
	}
}

func readSessionWorktreeRecord(path string) (sessionWorktreeRecord, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return sessionWorktreeRecord{}, err
	}
	var record sessionWorktreeRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return sessionWorktreeRecord{}, err
	}
	return record, nil
}

func (s *Service) SweepWorktreeIsolation(ctx context.Context) error {
	if s == nil {
		return nil
	}
	s.worktreeIsolationMu.Lock()
	defer s.worktreeIsolationMu.Unlock()
	if s.WorkspaceIDs == nil || s.SessionReader == nil {
		return nil
	}
	workspaceIDs, err := s.WorkspaceIDs(ctx)
	if err != nil {
		return err
	}
	var sessions []PersistedSession
	for _, workspaceID := range workspaceIDs {
		roots, ok := s.SessionReader.ListSessions(workspaceID)
		if !ok {
			continue
		}
		sessions = append(sessions, roots...)
		childrenReader, hasChildren := s.SessionReader.(ChildSessionReader)
		if !hasChildren {
			continue
		}
		for _, root := range roots {
			children, listErr := childrenReader.ListChildSessions(ctx, workspaceID, root.ID)
			if listErr != nil {
				return listErr
			}
			sessions = append(sessions, children...)
		}
	}
	return sweepSessionWorktrees(ctx, s.worktreeStateDir(), sessions, func(session PersistedSession) bool {
		return s.persistedSessionCanResume(ctx, session)
	})
}

func sweepSessionWorktrees(
	ctx context.Context,
	stateDir string,
	sessions []PersistedSession,
	canResume func(PersistedSession) bool,
) error {
	worktreesRoot := filepath.Join(filepath.Clean(stateDir), "agent", "worktrees")
	entries, err := os.ReadDir(worktreeRecordsDir(worktreesRoot))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		recordPath := filepath.Join(worktreeRecordsDir(worktreesRoot), entry.Name())
		record, readErr := readSessionWorktreeRecord(recordPath)
		if readErr != nil {
			continue
		}
		creatorIndex := -1
		for index := range sessions {
			if sessions[index].ID == record.SessionID && sessions[index].WorkspaceID == record.WorkspaceID {
				creatorIndex = index
				break
			}
		}
		if creatorIndex >= 0 && canResume != nil && canResume(sessions[creatorIndex]) {
			continue
		}
		blockedBySession := false
		for index := range sessions {
			if pathInsideWorktree(sessions[index].Cwd, record.WorktreePath) {
				blockedBySession = true
				break
			}
		}
		if blockedBySession {
			continue
		}
		if _, statErr := os.Stat(record.WorktreePath); errors.Is(statErr, os.ErrNotExist) {
			if _, branchErr := gitRepoOutput(ctx, record, "show-ref", "--verify", "refs/heads/"+record.Branch); branchErr != nil {
				if _, pruneErr := gitRepoOutput(ctx, record, "worktree", "prune"); pruneErr == nil {
					_ = os.Remove(recordPath)
				}
				continue
			}
			aheadText, aheadErr := gitRepoOutput(ctx, record, "rev-list", "--count", record.BaseCommit+"..refs/heads/"+record.Branch)
			if aheadErr != nil {
				continue
			}
			ahead, parseErr := strconv.Atoi(strings.TrimSpace(aheadText))
			if parseErr != nil || ahead != 0 {
				continue
			}
			if _, branchErr := gitRepoOutput(ctx, record, "branch", "-D", record.Branch); branchErr != nil {
				continue
			}
			if _, pruneErr := gitRepoOutput(ctx, record, "worktree", "prune"); pruneErr != nil {
				continue
			}
			_ = os.Remove(recordPath)
			continue
		}
		status, statusErr := gitOutput(ctx, record.WorktreePath, "status", "--porcelain")
		if statusErr != nil || strings.TrimSpace(status) != "" {
			continue
		}
		aheadText, aheadErr := gitRepoOutput(ctx, record, "rev-list", "--count", record.BaseCommit+"..refs/heads/"+record.Branch)
		if aheadErr != nil {
			continue
		}
		ahead, parseErr := strconv.Atoi(strings.TrimSpace(aheadText))
		if parseErr != nil || ahead != 0 {
			continue
		}
		if _, removeErr := gitRepoOutput(ctx, record, "worktree", "remove", record.WorktreePath); removeErr != nil {
			continue
		}
		if _, branchErr := gitRepoOutput(ctx, record, "branch", "-D", record.Branch); branchErr != nil {
			_, _ = gitRepoOutput(ctx, record, "worktree", "prune")
			continue
		}
		if _, pruneErr := gitRepoOutput(ctx, record, "worktree", "prune"); pruneErr != nil {
			return pruneErr
		}
		_ = os.Remove(recordPath)
	}
	return nil
}

func pathInsideWorktree(path string, worktreePath string) bool {
	path = canonicalWorktreePath(path)
	worktreePath = canonicalWorktreePath(worktreePath)
	if path == "" || worktreePath == "" {
		return false
	}
	relative, err := filepath.Rel(worktreePath, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func canonicalWorktreePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return ""
	}
	existing := abs
	var suffix []string
	for {
		if _, statErr := os.Stat(existing); statErr == nil {
			break
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			return filepath.Clean(abs)
		}
		suffix = append([]string{filepath.Base(existing)}, suffix...)
		existing = parent
	}
	if resolved, resolveErr := filepath.EvalSymlinks(existing); resolveErr == nil {
		abs = filepath.Join(append([]string{resolved}, suffix...)...)
	}
	return filepath.Clean(abs)
}
