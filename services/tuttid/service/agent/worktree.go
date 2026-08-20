package agent

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const (
	WorktreeIsolationMode        = "worktree"
	worktreeIsolationContextKey  = "isolation"
	worktreeDirtyBaseWarningCode = "worktree_base_dirty"
	worktreeGitOperationTimeout  = 30 * time.Second
	managedWorktreeStateCreating = "creating"
	managedWorktreeStateReady    = "ready"
)

var (
	ErrNotAGitRepo             = errors.New("cwd is not a git repository")
	ErrGitUnavailable          = errors.New("git is unavailable")
	ErrUnsupportedRepoLayout   = errors.New("git repository layout is unsupported")
	ErrWorktreeCreateFailed    = errors.New("git worktree creation failed")
	ErrManagedWorktreeNotFound = errors.New("managed worktree not found")
	ErrManagedWorktreeDirty    = errors.New("managed worktree has uncommitted changes")
	ErrManagedWorktreeAhead    = errors.New("managed worktree has commits beyond its base commit")
	ErrManagedWorktreeChanged  = errors.New("managed worktree branch changed during deletion")
)

type WorktreeIsolationError struct {
	Kind   error
	Detail string
}

type SessionWorktreeSupportErrorCode string

const (
	SessionWorktreeSupportGitUnavailable        SessionWorktreeSupportErrorCode = "git-unavailable"
	SessionWorktreeSupportNotGitRepo            SessionWorktreeSupportErrorCode = "not-git-repo"
	SessionWorktreeSupportTargetUnsupported     SessionWorktreeSupportErrorCode = "agent-target-unsupported"
	SessionWorktreeSupportUnsupportedRepoLayout SessionWorktreeSupportErrorCode = "unsupported-repo-layout"
)

type SessionWorktreeSupport struct {
	Supported bool
	Root      string
	ErrorCode SessionWorktreeSupportErrorCode
}

type sessionWorktreeSource struct {
	Cwd          string
	RepoRoot     string
	GitCommonDir string
	BaseCommit   string
}

type sessionWorktreeLaunch struct {
	Isolation SessionIsolation
	Cwd       string
	Warnings  []SessionWarning
	Created   bool
}

// ManagedWorktree is a workspace-scoped Git resource with an explicit
// lifecycle. Sessions may run with its path as cwd, but they do not own,
// retain, or release the resource.
type ManagedWorktree struct {
	WorktreeID   string
	WorkspaceID  string
	RepoRoot     string
	WorktreePath string
	Branch       string
	BaseCommit   string
	RelativeCwd  string
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

type managedWorktreeRecord struct {
	WorktreeID          string `json:"worktreeId,omitempty"`
	State               string `json:"state,omitempty"`
	WorktreePath        string `json:"worktreePath"`
	Branch              string `json:"branch"`
	BaseCommit          string `json:"baseCommit"`
	WorkspaceID         string `json:"workspaceId"`
	RepoRoot            string `json:"repoRoot"`
	RelativeCwd         string `json:"relativeCwd,omitempty"`
	CreationRequestHash string `json:"creationRequestHash,omitempty"`
	// LegacySessionID is read only for compatibility with metadata created
	// before worktrees became independent resources. It is never interpreted
	// as ownership and is omitted from newly written records.
	LegacySessionID string `json:"sessionId,omitempty"`
	// GitCommonDir anchors explicit git operations to the main repository's git
	// directory, which stays valid even when RepoRoot was itself a linked
	// worktree that has since been removed.
	GitCommonDir string `json:"gitCommonDir,omitempty"`
}

func worktreeGitAnchor(record managedWorktreeRecord) (string, []string) {
	if common := strings.TrimSpace(record.GitCommonDir); common != "" {
		return common, []string{"--git-dir", common}
	}
	return record.RepoRoot, nil
}

func gitRepoOutput(ctx context.Context, record managedWorktreeRecord, args ...string) (string, error) {
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

func (s *Service) worktreeLock() *sync.RWMutex {
	if s != nil && s.worktreeIsolationLock != nil {
		return s.worktreeIsolationLock
	}
	return &s.worktreeIsolationMu
}

func (s *Service) createSessionWorktree(
	ctx context.Context,
	workspaceID string,
	cwd string,
	sessionID string,
) (sessionWorktreeLaunch, error) {
	return createSessionWorktree(ctx, s.worktreeStateDir(), workspaceID, cwd, sessionID)
}

func (s *Service) ResolveSessionWorktreeSupport(
	ctx context.Context,
	workspaceID string,
	agentTargetID string,
	cwd string,
) (SessionWorktreeSupport, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentTargetID = strings.TrimSpace(agentTargetID)
	if workspaceID == "" || agentTargetID == "" || strings.TrimSpace(cwd) == "" {
		return SessionWorktreeSupport{}, ErrInvalidArgument
	}
	if strings.HasPrefix(agentTargetID, "shared-agent:") {
		return SessionWorktreeSupport{ErrorCode: SessionWorktreeSupportTargetUnsupported}, nil
	}
	input := CreateSessionInput{AgentTargetID: agentTargetID}
	launch, err := s.resolveCreateSessionLaunch(ctx, workspaceID, &input)
	if err != nil {
		return SessionWorktreeSupport{}, err
	}
	if !sessionWorktreeTargetSupported(agentTargetID, launch.ProviderTargetRef) {
		return SessionWorktreeSupport{ErrorCode: SessionWorktreeSupportTargetUnsupported}, nil
	}
	return s.ResolveSessionWorktreeSupportForPath(ctx, workspaceID, cwd)
}

func sessionWorktreeTargetSupported(agentTargetID string, providerTargetRef map[string]any) bool {
	if strings.HasPrefix(strings.TrimSpace(agentTargetID), "shared-agent:") {
		return false
	}
	switch providerTargetRefKind(providerTargetRef) {
	case agenttargetbiz.LaunchRefTypeBuiltinLocal, agenttargetbiz.LaunchRefTypeAgentExtension:
		return true
	default:
		return false
	}
}

func (*Service) ResolveSessionWorktreeSupportForPath(
	ctx context.Context,
	workspaceID string,
	cwd string,
) (SessionWorktreeSupport, error) {
	if strings.TrimSpace(workspaceID) == "" || strings.TrimSpace(cwd) == "" {
		return SessionWorktreeSupport{}, ErrInvalidArgument
	}
	source, err := resolveSessionWorktreeSource(ctx, cwd)
	if err == nil {
		return SessionWorktreeSupport{Supported: true, Root: source.RepoRoot}, nil
	}
	support := SessionWorktreeSupport{Supported: false}
	switch {
	case errors.Is(err, ErrGitUnavailable):
		support.ErrorCode = SessionWorktreeSupportGitUnavailable
	case errors.Is(err, ErrNotAGitRepo):
		support.ErrorCode = SessionWorktreeSupportNotGitRepo
	default:
		support.ErrorCode = SessionWorktreeSupportUnsupportedRepoLayout
	}
	return support, nil
}

func createSessionWorktree(
	ctx context.Context,
	stateDir string,
	workspaceID string,
	cwd string,
	creationRequestID string,
) (sessionWorktreeLaunch, error) {
	source, err := resolveSessionWorktreeSource(ctx, cwd)
	if err != nil {
		return sessionWorktreeLaunch{}, err
	}
	repoRoot := source.RepoRoot
	gitCommonDir := source.GitCommonDir
	baseCommit := source.BaseCommit
	relativeCwd, err := sessionWorktreeRelativeCwd(source)
	if err != nil {
		return sessionWorktreeLaunch{}, err
	}

	workspaceID = strings.TrimSpace(workspaceID)
	creationRequestID = strings.TrimSpace(creationRequestID)
	if workspaceID == "" || creationRequestID == "" {
		return sessionWorktreeLaunch{}, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: "worktree creation request identity is required"}
	}
	worktreesRoot := filepath.Join(filepath.Clean(stateDir), "agent", "worktrees")
	creationRequestHash := managedWorktreeCreationRequestHash(workspaceID, creationRequestID)
	if reused, found, reuseErr := reuseManagedWorktree(
		ctx,
		worktreesRoot,
		workspaceID,
		creationRequestID,
		creationRequestHash,
		source,
		relativeCwd,
	); reuseErr != nil {
		return sessionWorktreeLaunch{}, reuseErr
	} else if found {
		return reused, nil
	}
	worktreeID := uuid.NewString()
	worktreePath := filepath.Join(worktreesRoot, worktreeID)
	branch := "tutti/worktree/" + worktreeID
	if _, statErr := os.Lstat(worktreePath); statErr == nil || !errors.Is(statErr, os.ErrNotExist) {
		return sessionWorktreeLaunch{}, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: "managed worktree path already exists"}
	}
	if _, statErr := os.Lstat(worktreeRecordPath(worktreesRoot, worktreeID)); statErr == nil || !errors.Is(statErr, os.ErrNotExist) {
		return sessionWorktreeLaunch{}, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: "managed worktree metadata already exists"}
	}
	if _, branchErr := gitOutput(ctx, repoRoot, "show-ref", "--verify", "refs/heads/"+branch); branchErr == nil {
		return sessionWorktreeLaunch{}, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: "managed worktree branch already exists"}
	}
	info := SessionIsolation{WorktreeID: worktreeID, Mode: WorktreeIsolationMode, WorktreePath: worktreePath, Branch: branch, BaseCommit: baseCommit}
	record := managedWorktreeRecord{
		WorktreeID: info.WorktreeID, State: managedWorktreeStateCreating,
		WorktreePath: info.WorktreePath,
		Branch:       info.Branch, BaseCommit: info.BaseCommit,
		WorkspaceID: workspaceID, RepoRoot: repoRoot, GitCommonDir: gitCommonDir,
		RelativeCwd: relativeCwd, CreationRequestHash: creationRequestHash,
	}
	if err := writeManagedWorktreeRecord(worktreesRoot, record); err != nil {
		return sessionWorktreeLaunch{}, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: err.Error()}
	}
	created := false
	defer func() {
		if !created {
			rollbackManagedWorktree(context.Background(), worktreesRoot, record)
		}
	}()
	if _, err := gitOutput(ctx, repoRoot, "worktree", "add", "-b", branch, worktreePath, baseCommit); err != nil {
		return sessionWorktreeLaunch{}, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: gitErrorDetail(err)}
	}
	runtimeCwd := sessionWorktreeRuntimeCwd(worktreePath, relativeCwd)
	if stat, statErr := os.Stat(runtimeCwd); statErr != nil || !stat.IsDir() {
		detail := "selected project directory does not exist in the isolated worktree"
		if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
			detail = statErr.Error()
		}
		return sessionWorktreeLaunch{}, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: detail}
	}
	record.State = managedWorktreeStateReady
	if err := replaceManagedWorktreeRecord(worktreesRoot, record); err != nil {
		return sessionWorktreeLaunch{}, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: err.Error()}
	}
	created = true
	return sessionWorktreeLaunch{
		Isolation: info,
		Cwd:       runtimeCwd,
		Warnings:  sessionWorktreeWarnings(ctx, repoRoot),
		Created:   true,
	}, nil
}

func sessionWorktreeRelativeCwd(source sessionWorktreeSource) (string, error) {
	relative, err := filepath.Rel(source.RepoRoot, source.Cwd)
	if err != nil {
		return "", &WorktreeIsolationError{Kind: ErrUnsupportedRepoLayout, Detail: err.Error()}
	}
	relative = filepath.Clean(relative)
	if filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", &WorktreeIsolationError{Kind: ErrUnsupportedRepoLayout, Detail: "selected project directory is outside the repository root"}
	}
	return relative, nil
}

func sessionWorktreeRuntimeCwd(worktreePath string, relativeCwd string) string {
	if relativeCwd == "" || relativeCwd == "." {
		return filepath.Clean(worktreePath)
	}
	return filepath.Join(filepath.Clean(worktreePath), relativeCwd)
}

func managedWorktreeCreationRequestHash(workspaceID string, requestID string) string {
	digest := sha256.Sum256([]byte(strings.TrimSpace(workspaceID) + "\x00" + strings.TrimSpace(requestID)))
	return fmt.Sprintf("%x", digest[:])
}

func reuseManagedWorktree(
	ctx context.Context,
	worktreesRoot string,
	workspaceID string,
	creationRequestID string,
	creationRequestHash string,
	source sessionWorktreeSource,
	relativeCwd string,
) (sessionWorktreeLaunch, bool, error) {
	record, found, err := findManagedWorktreeForCreationRequest(
		worktreesRoot, creationRequestID, creationRequestHash,
	)
	if err != nil {
		return sessionWorktreeLaunch{}, false, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: "managed worktree metadata is unreadable"}
	}
	if !found {
		return sessionWorktreeLaunch{}, false, nil
	}
	recordedRelativeCwd := filepath.Clean(strings.TrimSpace(record.RelativeCwd))
	if strings.TrimSpace(record.RelativeCwd) == "" {
		recordedRelativeCwd = "."
	}
	if strings.TrimSpace(record.WorkspaceID) != workspaceID ||
		canonicalWorktreePath(record.RepoRoot) != canonicalWorktreePath(source.RepoRoot) ||
		recordedRelativeCwd != relativeCwd ||
		strings.TrimSpace(record.WorktreeID) == "" ||
		canonicalWorktreePath(record.WorktreePath) != canonicalWorktreePath(filepath.Join(worktreesRoot, record.WorktreeID)) ||
		strings.TrimSpace(record.BaseCommit) == "" ||
		(record.State != "" && record.State != managedWorktreeStateCreating && record.State != managedWorktreeStateReady) {
		return sessionWorktreeLaunch{}, false, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: "managed worktree metadata does not match the retried launch"}
	}
	worktreePath := record.WorktreePath
	topLevel, err := gitOutput(ctx, record.WorktreePath, "rev-parse", "--show-toplevel")
	if err != nil || canonicalWorktreePath(strings.TrimSpace(topLevel)) != canonicalWorktreePath(worktreePath) {
		if record.State == managedWorktreeStateCreating {
			rollbackManagedWorktree(ctx, worktreesRoot, record)
			return sessionWorktreeLaunch{}, false, nil
		}
		return sessionWorktreeLaunch{}, false, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: "session worktree checkout is unavailable"}
	}
	runtimeCwd := sessionWorktreeRuntimeCwd(worktreePath, relativeCwd)
	if stat, statErr := os.Stat(runtimeCwd); statErr != nil || !stat.IsDir() {
		if record.State == managedWorktreeStateCreating {
			rollbackManagedWorktree(ctx, worktreesRoot, record)
			return sessionWorktreeLaunch{}, false, nil
		}
		return sessionWorktreeLaunch{}, false, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: "selected project directory is unavailable in the isolated worktree"}
	}
	if record.State == managedWorktreeStateCreating {
		record.State = managedWorktreeStateReady
		if err := replaceManagedWorktreeRecord(worktreesRoot, record); err != nil {
			return sessionWorktreeLaunch{}, false, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: err.Error()}
		}
	}
	return sessionWorktreeLaunch{
		Isolation: managedWorktreeIsolation(record),
		Cwd:       runtimeCwd,
		Warnings:  sessionWorktreeWarnings(ctx, source.RepoRoot),
		Created:   false,
	}, true, nil
}

func managedWorktreeIsolation(record managedWorktreeRecord) SessionIsolation {
	return SessionIsolation{
		WorktreeID: strings.TrimSpace(record.WorktreeID), Mode: WorktreeIsolationMode,
		WorktreePath: strings.TrimSpace(record.WorktreePath),
		Branch:       strings.TrimSpace(record.Branch), BaseCommit: strings.TrimSpace(record.BaseCommit),
	}
}

func findManagedWorktreeForCreationRequest(
	worktreesRoot string,
	legacyRequestID string,
	creationRequestHash string,
) (managedWorktreeRecord, bool, error) {
	entries, err := os.ReadDir(worktreeRecordsDir(worktreesRoot))
	if errors.Is(err, os.ErrNotExist) {
		return managedWorktreeRecord{}, false, nil
	}
	if err != nil {
		return managedWorktreeRecord{}, false, err
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		record, readErr := readManagedWorktreeRecord(filepath.Join(worktreeRecordsDir(worktreesRoot), entry.Name()))
		if readErr != nil {
			// A damaged unrelated record must not make every future Worktree create
			// unavailable. Listing still surfaces the damaged record to an operator,
			// and this scan never removes it.
			continue
		}
		if strings.TrimSpace(record.CreationRequestHash) == creationRequestHash ||
			(record.CreationRequestHash == "" && strings.TrimSpace(record.LegacySessionID) == legacyRequestID) {
			return record, true, nil
		}
	}
	return managedWorktreeRecord{}, false, nil
}

func sessionWorktreeWarnings(ctx context.Context, repoRoot string) []SessionWarning {
	if status, statusErr := gitOutput(ctx, repoRoot, "status", "--porcelain"); statusErr == nil && strings.TrimSpace(status) != "" {
		return []SessionWarning{{
			Code:    worktreeDirtyBaseWarningCode,
			Message: "The source checkout has uncommitted changes; the isolated worktree is based on HEAD and does not include them.",
		}}
	}
	return nil
}

func resolveSessionWorktreeSource(ctx context.Context, cwd string) (sessionWorktreeSource, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return sessionWorktreeSource{}, &WorktreeIsolationError{Kind: ErrGitUnavailable, Detail: err.Error()}
	}
	cwd = strings.TrimSpace(cwd)
	if cwd == "" {
		return sessionWorktreeSource{}, &WorktreeIsolationError{Kind: ErrNotAGitRepo}
	}
	absCwd, err := filepath.Abs(cwd)
	if err != nil {
		return sessionWorktreeSource{}, &WorktreeIsolationError{Kind: ErrNotAGitRepo, Detail: err.Error()}
	}
	if resolved, resolveErr := filepath.EvalSymlinks(absCwd); resolveErr == nil {
		absCwd = resolved
	}
	repoRoot, err := gitOutput(ctx, absCwd, "rev-parse", "--show-toplevel")
	if err != nil || strings.TrimSpace(repoRoot) == "" {
		return sessionWorktreeSource{}, &WorktreeIsolationError{Kind: ErrNotAGitRepo, Detail: gitErrorDetail(err)}
	}
	repoRoot = filepath.Clean(strings.TrimSpace(repoRoot))
	if resolved, resolveErr := filepath.EvalSymlinks(repoRoot); resolveErr == nil {
		repoRoot = resolved
	}
	if superproject, superErr := gitOutput(ctx, repoRoot, "rev-parse", "--show-superproject-working-tree"); superErr == nil && strings.TrimSpace(superproject) != "" {
		return sessionWorktreeSource{}, &WorktreeIsolationError{Kind: ErrUnsupportedRepoLayout, Detail: "git submodules are not supported for worktree isolation"}
	}
	if outerRoot, outerErr := gitOutput(ctx, filepath.Dir(repoRoot), "rev-parse", "--show-toplevel"); outerErr == nil && strings.TrimSpace(outerRoot) != "" && filepath.Clean(strings.TrimSpace(outerRoot)) != repoRoot {
		return sessionWorktreeSource{}, &WorktreeIsolationError{Kind: ErrUnsupportedRepoLayout, Detail: "nested git repositories are not supported for worktree isolation"}
	}
	commonDirOut, err := gitOutput(ctx, absCwd, "rev-parse", "--git-common-dir")
	if err != nil || strings.TrimSpace(commonDirOut) == "" {
		return sessionWorktreeSource{}, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: gitErrorDetail(err)}
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
		return sessionWorktreeSource{}, &WorktreeIsolationError{Kind: ErrWorktreeCreateFailed, Detail: gitErrorDetail(err)}
	}
	return sessionWorktreeSource{
		Cwd:          absCwd,
		RepoRoot:     repoRoot,
		GitCommonDir: gitCommonDir,
		BaseCommit:   strings.TrimSpace(baseCommit),
	}, nil
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
		"worktreeId": isolation.WorktreeID,
		"mode":       isolation.Mode, "worktreePath": isolation.WorktreePath,
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

func worktreeRecordPath(worktreesRoot string, worktreeID string) string {
	return filepath.Join(worktreeRecordsDir(worktreesRoot), worktreeID+".json")
}

func writeManagedWorktreeRecord(worktreesRoot string, record managedWorktreeRecord) error {
	if err := os.MkdirAll(worktreeRecordsDir(worktreesRoot), 0o700); err != nil {
		return fmt.Errorf("create worktree metadata directory: %w", err)
	}
	data, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("marshal worktree metadata: %w", err)
	}
	path := worktreeRecordPath(worktreesRoot, record.WorktreeID)
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

func replaceManagedWorktreeRecord(worktreesRoot string, record managedWorktreeRecord) error {
	dir := worktreeRecordsDir(worktreesRoot)
	data, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("marshal worktree metadata: %w", err)
	}
	temporary, err := os.CreateTemp(dir, "."+record.WorktreeID+"-*.tmp")
	if err != nil {
		return fmt.Errorf("create worktree metadata update: %w", err)
	}
	replaced := false
	defer func() {
		_ = temporary.Close()
		if !replaced {
			_ = os.Remove(temporary.Name())
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return fmt.Errorf("secure worktree metadata update: %w", err)
	}
	if _, err := temporary.Write(data); err != nil {
		return fmt.Errorf("write worktree metadata update: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("sync worktree metadata update: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close worktree metadata update: %w", err)
	}
	if err := os.Rename(temporary.Name(), worktreeRecordPath(worktreesRoot, record.WorktreeID)); err != nil {
		return fmt.Errorf("replace worktree metadata: %w", err)
	}
	replaced = true
	return nil
}

func rollbackManagedWorktree(ctx context.Context, worktreesRoot string, record managedWorktreeRecord) {
	_, _ = gitRepoOutput(ctx, record, "worktree", "remove", "--force", record.WorktreePath)
	_ = os.RemoveAll(record.WorktreePath)
	_, _ = gitRepoOutput(ctx, record, "branch", "-D", record.Branch)
	_, _ = gitRepoOutput(ctx, record, "worktree", "prune")
	_ = os.Remove(worktreeRecordPath(worktreesRoot, record.WorktreeID))
}

func (s *Service) rollbackSessionWorktree(ctx context.Context, isolation SessionIsolation) {
	worktreesRoot := filepath.Join(s.worktreeStateDir(), "agent", "worktrees")
	worktreeID := strings.TrimSpace(isolation.WorktreeID)
	if worktreeID == "" {
		worktreeID = filepath.Base(isolation.WorktreePath)
	}
	record, err := readManagedWorktreeRecord(worktreeRecordPath(worktreesRoot, worktreeID))
	if err == nil {
		rollbackManagedWorktree(ctx, worktreesRoot, record)
	}
}

func readManagedWorktreeRecord(path string) (managedWorktreeRecord, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return managedWorktreeRecord{}, err
	}
	var record managedWorktreeRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return managedWorktreeRecord{}, err
	}
	if strings.TrimSpace(record.WorktreeID) == "" {
		record.WorktreeID = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	}
	return record, nil
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
