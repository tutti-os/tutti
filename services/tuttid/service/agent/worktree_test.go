package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

type recordingSessionDirectoryAllocator struct {
	calls int
	path  string
}

func (a *recordingSessionDirectoryAllocator) CreateSessionDirectory(context.Context) (string, error) {
	a.calls++
	if err := os.MkdirAll(a.path, 0o755); err != nil {
		return "", err
	}
	return a.path, nil
}

func (*recordingSessionDirectoryAllocator) ReleaseSessionDirectory(_ context.Context, path string) error {
	return os.RemoveAll(path)
}

func initSessionWorktreeRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	repo := t.TempDir()
	runGitForTest(t, repo, "init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(repo, "tracked.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGitForTest(t, repo, "add", "tracked.txt")
	runGitForTest(t, repo, "commit", "-q", "-m", "initial")
	return repo
}

func projectRailPlacement(projectPath string) *agenthost.RailPlacement {
	return &agenthost.RailPlacement{
		Version:     1,
		Kind:        agenthost.RailPlacementKindProject,
		ProjectPath: projectPath,
		SectionKey:  agentactivitybiz.RailSectionKeyForProject(projectPath),
	}
}

func createWorktreeFixture(t *testing.T, sessionID string) (string, string, SessionIsolation) {
	t.Helper()
	stateDir := t.TempDir()
	repo := initSessionWorktreeRepo(t)
	launch, err := createSessionWorktree(context.Background(), stateDir, "workspace-1", repo, sessionID)
	if err != nil {
		t.Fatalf("createSessionWorktree() error = %v", err)
	}
	cleanupManagedWorktreeFixture(t, stateDir, launch.Isolation)
	return stateDir, repo, launch.Isolation
}

func cleanupManagedWorktreeFixture(t *testing.T, stateDir string, isolation SessionIsolation) {
	t.Helper()
	t.Cleanup(func() {
		service := &Service{WorktreeStateDir: stateDir}
		service.rollbackSessionWorktree(context.Background(), isolation)
	})
}

func assertWorktreeExists(t *testing.T, worktreePath string) {
	t.Helper()
	if stat, err := os.Stat(worktreePath); err != nil || !stat.IsDir() {
		t.Fatalf("managed worktree %q is unavailable: stat=%#v error=%v", worktreePath, stat, err)
	}
}

func TestCreateSessionWorktree(t *testing.T) {
	stateDir, _, isolation := createWorktreeFixture(t, "session-create")
	if isolation.WorktreeID == "" || isolation.Mode != WorktreeIsolationMode ||
		isolation.Branch != "tutti/worktree/"+isolation.WorktreeID {
		t.Fatalf("isolation = %#v", isolation)
	}
	if isolation.WorktreePath != filepath.Join(stateDir, "agent", "worktrees", isolation.WorktreeID) {
		t.Fatalf("worktree path = %q", isolation.WorktreePath)
	}
	metadata, err := os.ReadFile(worktreeRecordPath(
		filepath.Join(stateDir, "agent", "worktrees"), isolation.WorktreeID,
	))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(metadata), "sessionId") || strings.Contains(string(metadata), "session-create") {
		t.Fatalf("managed worktree metadata retained Session identity: %s", metadata)
	}
	var record managedWorktreeRecord
	if err := json.Unmarshal(metadata, &record); err != nil || record.State != managedWorktreeStateReady {
		t.Fatalf("managed worktree metadata state = %q, error = %v", record.State, err)
	}
	if _, err := os.Stat(filepath.Join(isolation.WorktreePath, "tracked.txt")); err != nil {
		t.Fatalf("worktree tracked file: %v", err)
	}
	branch, err := gitOutput(context.Background(), isolation.WorktreePath, "branch", "--show-current")
	if err != nil || strings.TrimSpace(branch) != isolation.Branch {
		t.Fatalf("worktree branch = %q, err = %v", branch, err)
	}
}

func TestCreateSessionWorktreeReusesMatchingSessionLaunch(t *testing.T) {
	stateDir := t.TempDir()
	repo := initSessionWorktreeRepo(t)
	first, err := createSessionWorktree(context.Background(), stateDir, "workspace-1", repo, "session-retry")
	if err != nil {
		t.Fatal(err)
	}
	cleanupManagedWorktreeFixture(t, stateDir, first.Isolation)
	second, err := createSessionWorktree(context.Background(), stateDir, "workspace-1", repo, "session-retry")
	if err != nil {
		t.Fatalf("retry createSessionWorktree() error = %v", err)
	}
	if second.Created {
		t.Fatal("retried launch created a second worktree")
	}
	if second.Isolation != first.Isolation || second.Cwd != first.Cwd {
		t.Fatalf("retried launch = %#v, want %#v", second, first)
	}
}

func TestCreateSessionWorktreeRecoversInterruptedCreatingRecord(t *testing.T) {
	stateDir := t.TempDir()
	repo := initSessionWorktreeRepo(t)
	source, err := resolveSessionWorktreeSource(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	worktreesRoot := filepath.Join(stateDir, "agent", "worktrees")
	interruptedID := "interrupted-worktree"
	record := managedWorktreeRecord{
		WorktreeID: interruptedID, State: managedWorktreeStateCreating,
		WorktreePath: filepath.Join(worktreesRoot, interruptedID),
		Branch:       "tutti/worktree/" + interruptedID,
		BaseCommit:   source.BaseCommit,
		WorkspaceID:  "workspace-1", RepoRoot: source.RepoRoot,
		GitCommonDir: source.GitCommonDir, RelativeCwd: ".",
		CreationRequestHash: managedWorktreeCreationRequestHash("workspace-1", "request-retry"),
	}
	if err := writeManagedWorktreeRecord(worktreesRoot, record); err != nil {
		t.Fatal(err)
	}

	launch, err := createSessionWorktree(
		context.Background(), stateDir, "workspace-1", repo, "request-retry",
	)
	if err != nil {
		t.Fatalf("createSessionWorktree() retry error = %v", err)
	}
	cleanupManagedWorktreeFixture(t, stateDir, launch.Isolation)
	if launch.Isolation.WorktreeID == interruptedID || !launch.Created {
		t.Fatalf("recovered launch = %#v", launch)
	}
	if _, err := os.Stat(worktreeRecordPath(worktreesRoot, interruptedID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("interrupted metadata stat error = %v", err)
	}
}

func TestCreateSessionWorktreeCompletesInterruptedReadyCheckout(t *testing.T) {
	stateDir := t.TempDir()
	repo := initSessionWorktreeRepo(t)
	source, err := resolveSessionWorktreeSource(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	worktreesRoot := filepath.Join(stateDir, "agent", "worktrees")
	worktreeID := "interrupted-ready-checkout"
	record := managedWorktreeRecord{
		WorktreeID: worktreeID, State: managedWorktreeStateCreating,
		WorktreePath: filepath.Join(worktreesRoot, worktreeID),
		Branch:       "tutti/worktree/" + worktreeID,
		BaseCommit:   source.BaseCommit,
		WorkspaceID:  "workspace-1", RepoRoot: source.RepoRoot,
		GitCommonDir: source.GitCommonDir, RelativeCwd: ".",
		CreationRequestHash: managedWorktreeCreationRequestHash("workspace-1", "request-finish"),
	}
	if err := writeManagedWorktreeRecord(worktreesRoot, record); err != nil {
		t.Fatal(err)
	}
	if _, err := gitOutput(context.Background(), repo, "worktree", "add", "-b", record.Branch, record.WorktreePath, record.BaseCommit); err != nil {
		t.Fatal(err)
	}
	cleanupManagedWorktreeFixture(t, stateDir, managedWorktreeIsolation(record))

	launch, err := createSessionWorktree(
		context.Background(), stateDir, "workspace-1", repo, "request-finish",
	)
	if err != nil || launch.Created || launch.Isolation.WorktreeID != worktreeID {
		t.Fatalf("createSessionWorktree() launch=%#v error=%v", launch, err)
	}
	ready, err := readManagedWorktreeRecord(worktreeRecordPath(worktreesRoot, worktreeID))
	if err != nil || ready.State != managedWorktreeStateReady {
		t.Fatalf("managed worktree state=%q error=%v", ready.State, err)
	}
}

func TestCreateSessionWorktreeIgnoresDamagedUnrelatedMetadata(t *testing.T) {
	stateDir := t.TempDir()
	repo := initSessionWorktreeRepo(t)
	worktreesRoot := filepath.Join(stateDir, "agent", "worktrees")
	if err := os.MkdirAll(worktreeRecordsDir(worktreesRoot), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(worktreeRecordPath(worktreesRoot, "damaged"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	launch, err := createSessionWorktree(
		context.Background(), stateDir, "workspace-1", repo, "request-after-damage",
	)
	if err != nil {
		t.Fatalf("createSessionWorktree() error = %v", err)
	}
	cleanupManagedWorktreeFixture(t, stateDir, launch.Isolation)
}

func TestCreateSessionWorktreeScopesCreationIdempotencyByWorkspace(t *testing.T) {
	stateDir := t.TempDir()
	repo := initSessionWorktreeRepo(t)
	first, err := createSessionWorktree(context.Background(), stateDir, "workspace-1", repo, "session-scope-mismatch")
	if err != nil {
		t.Fatal(err)
	}
	cleanupManagedWorktreeFixture(t, stateDir, first.Isolation)
	second, err := createSessionWorktree(context.Background(), stateDir, "workspace-2", repo, "session-scope-mismatch")
	if err != nil {
		t.Fatalf("second workspace create error = %v", err)
	}
	cleanupManagedWorktreeFixture(t, stateDir, second.Isolation)
	if second.Isolation.WorktreeID == first.Isolation.WorktreeID {
		t.Fatalf("workspace-scoped worktrees reused id %q", second.Isolation.WorktreeID)
	}
}

func TestCreateSessionWorktreePreservesSelectedRepositorySubdirectory(t *testing.T) {
	stateDir := t.TempDir()
	repo := initSessionWorktreeRepo(t)
	projectDir := filepath.Join(repo, "packages", "foo")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectDir, "project.txt"), []byte("project\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGitForTest(t, repo, "add", "packages/foo/project.txt")
	runGitForTest(t, repo, "commit", "-q", "-m", "add nested project")

	launch, err := createSessionWorktree(context.Background(), stateDir, "workspace-1", projectDir, "session-subdirectory")
	if err != nil {
		t.Fatal(err)
	}
	cleanupManagedWorktreeFixture(t, stateDir, launch.Isolation)
	wantCwd := filepath.Join(launch.Isolation.WorktreePath, "packages", "foo")
	if launch.Cwd != wantCwd {
		t.Fatalf("runtime cwd = %q, want %q", launch.Cwd, wantCwd)
	}
	if _, err := os.Stat(filepath.Join(launch.Cwd, "project.txt")); err != nil {
		t.Fatalf("nested project file: %v", err)
	}
}

func TestCreateSessionWorktreeReportsDirtySourceWarning(t *testing.T) {
	stateDir := t.TempDir()
	repo := initSessionWorktreeRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "dirty.txt"), []byte("dirty\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	launch, err := createSessionWorktree(context.Background(), stateDir, "workspace-1", repo, "session-dirty-source")
	if err != nil {
		t.Fatal(err)
	}
	isolation := launch.Isolation
	cleanupManagedWorktreeFixture(t, stateDir, isolation)
	if len(launch.Warnings) != 1 || launch.Warnings[0].Code != worktreeDirtyBaseWarningCode {
		t.Fatalf("warnings = %#v", launch.Warnings)
	}
	if _, statErr := os.Stat(filepath.Join(isolation.WorktreePath, "dirty.txt")); !os.IsNotExist(statErr) {
		t.Fatalf("dirty source file is visible in worktree, stat error = %v", statErr)
	}
}

func TestCreateSessionWorktreeRejectsNonGitDirectory(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	_, err := createSessionWorktree(context.Background(), t.TempDir(), "workspace-1", t.TempDir(), "session-not-git")
	if !errors.Is(err, ErrNotAGitRepo) {
		t.Fatalf("error = %v, want ErrNotAGitRepo", err)
	}
}

func TestResolveSessionWorktreeSupportForPath(t *testing.T) {
	repo := initSessionWorktreeRepo(t)
	nested := filepath.Join(repo, "packages", "agent")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}

	result, err := (&Service{}).ResolveSessionWorktreeSupportForPath(
		context.Background(),
		"workspace-1",
		nested,
	)
	if err != nil {
		t.Fatal(err)
	}
	resolvedRepo, err := filepath.EvalSymlinks(repo)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Supported || result.Root != resolvedRepo || result.ErrorCode != "" {
		t.Fatalf("support = %#v", result)
	}
}

func TestResolveSessionWorktreeSupportForPathHidesNonGitDirectory(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	result, err := (&Service{}).ResolveSessionWorktreeSupportForPath(
		context.Background(),
		"workspace-1",
		t.TempDir(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.Supported || result.ErrorCode != SessionWorktreeSupportNotGitRepo {
		t.Fatalf("support = %#v", result)
	}
}

func TestResolveSessionWorktreeSupportRejectsSharedAgentTarget(t *testing.T) {
	result, err := (&Service{}).ResolveSessionWorktreeSupport(
		context.Background(),
		"workspace-1",
		"shared-agent:agent-1",
		t.TempDir(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.Supported || result.ErrorCode != SessionWorktreeSupportTargetUnsupported {
		t.Fatalf("support = %#v", result)
	}
}

func TestResolveSessionWorktreeSupportAdmitsLocalAgentTarget(t *testing.T) {
	repo := initSessionWorktreeRepo(t)
	service := &Service{AgentTargetStore: fakeAgentTargetStore{targets: map[string]agenttargetbiz.Target{
		agenttargetbiz.IDLocalCodex: {
			ID:            agenttargetbiz.IDLocalCodex,
			Provider:      "codex",
			LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
			Name:          "Codex",
			Enabled:       true,
			Source:        agenttargetbiz.SourceSystem,
		},
	}}}

	result, err := service.ResolveSessionWorktreeSupport(
		context.Background(),
		"workspace-1",
		agenttargetbiz.IDLocalCodex,
		repo,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Supported || result.Root == "" || result.ErrorCode != "" {
		t.Fatalf("support = %#v", result)
	}
}

func TestCreateSessionWorktreeRejectsSharedAgentTarget(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: map[string]agenttargetbiz.Target{
		"shared-agent:agent-1": {
			ID:            "shared-agent:agent-1",
			Provider:      "codex",
			LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
			Name:          "Shared Agent",
			Enabled:       true,
			Source:        agenttargetbiz.SourceUser,
		},
	}}

	_, err := service.Create(context.Background(), "workspace-1", CreateSessionInput{
		AgentSessionID: "session-shared-worktree",
		AgentTargetID:  "shared-agent:agent-1",
		Cwd:            stringPointer(t.TempDir()),
		Isolation:      WorktreeIsolationMode,
		RailPlacement:  projectRailPlacement(t.TempDir()),
	})
	if !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), "worktree isolation is unavailable") {
		t.Fatalf("Create error = %v, want worktree target rejection", err)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %d, want 0", len(runtime.startCalls))
	}
}

func TestServiceCreateWorktreeIsolationRequiresProjectRailPlacement(t *testing.T) {
	repo := initSessionWorktreeRepo(t)
	for _, test := range []struct {
		name      string
		placement *agenthost.RailPlacement
	}{
		{name: "missing"},
		{
			name: "conversations",
			placement: &agenthost.RailPlacement{
				Version:    1,
				Kind:       agenthost.RailPlacementKindConversations,
				SectionKey: agentactivitybiz.RailSectionKeyConversations,
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			stateDir := t.TempDir()
			runtime := newFakeRuntime()
			service := newTestService(runtime)
			service.WorktreeStateDir = stateDir
			_, err := service.Create(context.Background(), "workspace-1", CreateSessionInput{
				AgentSessionID: "session-" + test.name,
				AgentTargetID:  agenttargetbiz.IDLocalCodex,
				Cwd:            stringPointer(repo),
				Isolation:      WorktreeIsolationMode,
				RailPlacement:  test.placement,
			})
			if !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), "requires project rail placement") {
				t.Fatalf("Create error = %v, want project rail placement rejection", err)
			}
			if len(runtime.startCalls) != 0 {
				t.Fatalf("start calls = %d, want 0", len(runtime.startCalls))
			}
			if _, statErr := os.Stat(filepath.Join(stateDir, "agent")); !os.IsNotExist(statErr) {
				t.Fatalf("rejected create left agent state behind: %v", statErr)
			}
		})
	}
}

func TestCreateSessionWorktreeRejectsUnavailableGit(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	_, err := createSessionWorktree(context.Background(), t.TempDir(), "workspace-1", t.TempDir(), "session-no-git")
	if !errors.Is(err, ErrGitUnavailable) {
		t.Fatalf("error = %v, want ErrGitUnavailable", err)
	}
}

func TestCreateSessionWorktreeRejectsSubmodule(t *testing.T) {
	parent := initSessionWorktreeRepo(t)
	submoduleSource := initSessionWorktreeRepo(t)
	runGitForTest(t, parent, "-c", "protocol.file.allow=always", "submodule", "add", "-q", submoduleSource, "nested")
	runGitForTest(t, parent, "commit", "-q", "-am", "add submodule")
	_, err := createSessionWorktree(context.Background(), t.TempDir(), "workspace-1", filepath.Join(parent, "nested"), "session-submodule")
	if !errors.Is(err, ErrUnsupportedRepoLayout) {
		t.Fatalf("error = %v, want ErrUnsupportedRepoLayout", err)
	}
}

func TestCreateSessionWorktreeRejectsNestedRepository(t *testing.T) {
	outer := initSessionWorktreeRepo(t)
	nested := filepath.Join(outer, "nested")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	runGitForTest(t, nested, "init", "-q", "-b", "main")
	runGitForTest(t, nested, "commit", "-q", "--allow-empty", "-m", "nested")
	_, err := createSessionWorktree(context.Background(), t.TempDir(), "workspace-1", nested, "session-nested")
	if !errors.Is(err, ErrUnsupportedRepoLayout) {
		t.Fatalf("error = %v, want ErrUnsupportedRepoLayout", err)
	}
}

func TestCreateSessionWorktreePersistsAndProjectsIsolation(t *testing.T) {
	_, _, isolation := createWorktreeFixture(t, "session-context")
	runtimeContext := sessionIsolationRuntimeContext(map[string]any{"existing": true}, isolation)
	if runtimeContext["existing"] != true {
		t.Fatalf("runtime context existing field was lost: %#v", runtimeContext)
	}
	session := serviceSession(ProviderRuntimeSession{
		ID: "session-context", Provider: "codex", Cwd: isolation.WorktreePath,
		Visible: true, RuntimeContext: runtimeContext,
	}, true)
	if session.Isolation == nil || *session.Isolation != isolation {
		t.Fatalf("projected isolation = %#v, want %#v", session.Isolation, isolation)
	}
}

func TestServiceCreateUsesIsolatedWorktreeAndRuntimeContext(t *testing.T) {
	stateDir := t.TempDir()
	repo := initSessionWorktreeRepo(t)
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.WorktreeStateDir = stateDir
	session, err := service.Create(context.Background(), "workspace-1", CreateSessionInput{
		AgentSessionID: "session-service-create", AgentTargetID: agenttargetbiz.IDLocalCodex,
		Cwd: stringPointer(repo), Isolation: WorktreeIsolationMode, InitialContent: TextPromptContent("work"),
		RailPlacement: projectRailPlacement(repo),
	})
	if err != nil {
		t.Fatal(err)
	}
	if session.Isolation == nil || session.Cwd != session.Isolation.WorktreePath {
		t.Fatalf("session = %#v", session)
	}
	t.Cleanup(func() { service.rollbackSessionWorktree(context.Background(), *session.Isolation) })
	if len(runtime.startCalls) != 1 || runtime.startCalls[0].Cwd != session.Isolation.WorktreePath {
		t.Fatalf("runtime start calls = %#v", runtime.startCalls)
	}
	projected := sessionIsolationFromRuntimeContext(runtime.startCalls[0].RuntimeContext)
	if projected == nil || *projected != *session.Isolation {
		t.Fatalf("runtime isolation = %#v, want %#v", projected, session.Isolation)
	}
}

func TestServiceCreateWorktreeIsolationRejectsEmptyCwdBeforeAllocation(t *testing.T) {
	stateDir := t.TempDir()
	allocatedPath := filepath.Join(stateDir, "agent", "sessions", "allocated")
	allocator := &recordingSessionDirectoryAllocator{path: allocatedPath}
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.WorktreeStateDir = stateDir
	service.SessionDirectoryAllocator = allocator
	_, err := service.Create(context.Background(), "workspace-1", CreateSessionInput{
		AgentSessionID: "session-empty-cwd", AgentTargetID: agenttargetbiz.IDLocalCodex,
		Isolation: WorktreeIsolationMode, InitialContent: TextPromptContent("work"),
		RailPlacement: projectRailPlacement(t.TempDir()),
	})
	if !errors.Is(err, ErrNotAGitRepo) {
		t.Fatalf("Create error = %v, want ErrNotAGitRepo", err)
	}
	if allocator.calls != 0 {
		t.Fatalf("session directory allocator calls = %d, want 0", allocator.calls)
	}
	if _, statErr := os.Stat(filepath.Join(stateDir, "agent")); !os.IsNotExist(statErr) {
		t.Fatalf("empty-cwd isolation left agent state behind: %v", statErr)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("runtime start calls = %#v, want none", runtime.startCalls)
	}
}

func TestServiceCreateRollsBackWorktreeWhenHostStartFails(t *testing.T) {
	stateDir := t.TempDir()
	repo := initSessionWorktreeRepo(t)
	startErr := errors.New("start failed")
	runtime := newFakeRuntime()
	runtime.startErr = startErr
	service := newTestService(runtime)
	service.WorktreeStateDir = stateDir
	_, err := service.Create(context.Background(), "workspace-1", CreateSessionInput{
		AgentSessionID: "session-service-fail", AgentTargetID: agenttargetbiz.IDLocalCodex,
		Cwd: stringPointer(repo), Isolation: WorktreeIsolationMode, InitialContent: TextPromptContent("work"),
		RailPlacement: projectRailPlacement(repo),
	})
	if !errors.Is(err, startErr) {
		t.Fatalf("Create error = %v, want %v", err, startErr)
	}
	entries, readErr := os.ReadDir(filepath.Join(stateDir, "agent", "worktrees"))
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		t.Fatal(readErr)
	}
	for _, entry := range entries {
		if entry.Name() != ".metadata" {
			t.Fatalf("failed create worktree still exists: %s", entry.Name())
		}
	}
	if len(runtime.sessions) != 0 {
		t.Fatalf("runtime sessions = %#v, want none", runtime.sessions)
	}
	branches, branchErr := gitOutput(context.Background(), repo, "branch", "--list", "tutti/worktree/*")
	if branchErr != nil || strings.TrimSpace(branches) != "" {
		t.Fatalf("failed create branches = %q, error=%v", branches, branchErr)
	}
}

func TestServiceCreateWorktreeRetryReusesExistingCheckout(t *testing.T) {
	stateDir := t.TempDir()
	repo := initSessionWorktreeRepo(t)
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.WorktreeStateDir = stateDir
	input := CreateSessionInput{
		AgentSessionID: "session-create-retry",
		ClientSubmitID: "submit-create-retry",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Cwd:            stringPointer(repo),
		Isolation:      WorktreeIsolationMode,
		InitialContent: TextPromptContent("hello"),
		RailPlacement:  projectRailPlacement(repo),
	}
	first, err := service.Create(context.Background(), "workspace-1", input)
	if err != nil {
		t.Fatalf("first Create() error = %v", err)
	}
	if first.Isolation == nil {
		t.Fatal("first Create() did not return worktree isolation")
	}
	t.Cleanup(func() { service.rollbackSessionWorktree(context.Background(), *first.Isolation) })
	second, err := service.Create(context.Background(), "workspace-1", input)
	if err != nil {
		t.Fatalf("retried Create() error = %v", err)
	}
	if second.Isolation == nil || *second.Isolation != *first.Isolation || second.Cwd != first.Cwd {
		t.Fatalf("retried session = %#v, want isolation/cwd from %#v", second, first)
	}
}

func TestServiceCreateWorktreeUsesSelectedRepositorySubdirectory(t *testing.T) {
	stateDir := t.TempDir()
	repo := initSessionWorktreeRepo(t)
	projectDir := filepath.Join(repo, "packages", "foo")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectDir, "project.txt"), []byte("project\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGitForTest(t, repo, "add", "packages/foo/project.txt")
	runGitForTest(t, repo, "commit", "-q", "-m", "add nested project")

	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.WorktreeStateDir = stateDir
	created, err := service.Create(context.Background(), "workspace-1", CreateSessionInput{
		AgentSessionID: "session-create-subdirectory",
		ClientSubmitID: "submit-create-subdirectory",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Cwd:            stringPointer(projectDir),
		Isolation:      WorktreeIsolationMode,
		RailPlacement:  projectRailPlacement(projectDir),
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.Isolation == nil {
		t.Fatal("Create() did not return worktree isolation")
	}
	t.Cleanup(func() { service.rollbackSessionWorktree(context.Background(), *created.Isolation) })
	wantCwd := filepath.Join(created.Isolation.WorktreePath, "packages", "foo")
	if created.Cwd != wantCwd || len(runtime.startCalls) != 1 || runtime.startCalls[0].Cwd != wantCwd {
		t.Fatalf("created cwd = %q, runtime starts = %#v, want %q", created.Cwd, runtime.startCalls, wantCwd)
	}
}

func TestListManagedWorktreesUsesIndependentResourceIdentity(t *testing.T) {
	stateDir, _, isolation := createWorktreeFixture(t, "session-list-resource")
	service := &Service{WorktreeStateDir: stateDir}
	worktrees, err := service.ListManagedWorktrees(context.Background(), "workspace-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(worktrees) != 1 {
		t.Fatalf("managed worktrees = %#v", worktrees)
	}
	got := worktrees[0]
	if got.WorktreeID != isolation.WorktreeID || got.WorktreeID == "session-list-resource" {
		t.Fatalf("managed worktree identity = %#v", got)
	}
	if filepath.Base(got.WorktreePath) != got.WorktreeID || got.Branch != "tutti/worktree/"+got.WorktreeID {
		t.Fatalf("managed worktree path/branch = %#v", got)
	}
}

func TestDeleteManagedWorktreeRequiresExplicitRequest(t *testing.T) {
	stateDir, repo, isolation := createWorktreeFixture(t, "session-explicit-delete")
	service := &Service{WorktreeStateDir: stateDir}
	deleted, err := service.DeleteManagedWorktree(context.Background(), "workspace-1", isolation.WorktreeID)
	if err != nil || !deleted {
		t.Fatalf("DeleteManagedWorktree() deleted=%v error=%v", deleted, err)
	}
	if _, statErr := os.Stat(isolation.WorktreePath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("deleted worktree stat error = %v", statErr)
	}
	if _, branchErr := gitOutput(context.Background(), repo, "show-ref", "--verify", "refs/heads/"+isolation.Branch); branchErr == nil {
		t.Fatal("explicitly deleted worktree branch still exists")
	}
	worktrees, listErr := service.ListManagedWorktrees(context.Background(), "workspace-1")
	if listErr != nil || len(worktrees) != 0 {
		t.Fatalf("managed worktrees after delete = %#v error=%v", worktrees, listErr)
	}
}

func TestSessionDeleteDoesNotDeleteManagedWorktree(t *testing.T) {
	stateDir := t.TempDir()
	repo := initSessionWorktreeRepo(t)
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	installFakeCanonicalSessionStore(service)
	service.WorktreeStateDir = stateDir
	session, err := service.Create(context.Background(), "workspace-1", CreateSessionInput{
		AgentSessionID: "11111111-1111-4111-8111-111111111111",
		ClientSubmitID: "submit-independent-worktree",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Cwd:            stringPointer(repo), Isolation: WorktreeIsolationMode,
		RailPlacement: projectRailPlacement(repo),
	})
	if err != nil || session.Isolation == nil {
		t.Fatalf("Create() session=%#v error=%v", session, err)
	}
	t.Cleanup(func() { service.rollbackSessionWorktree(context.Background(), *session.Isolation) })
	deleted, err := service.Delete(context.Background(), "workspace-1", session.ID)
	if err != nil || !deleted.Removed {
		t.Fatalf("Delete() result=%#v error=%v", deleted, err)
	}
	assertWorktreeExists(t, session.Isolation.WorktreePath)
	worktrees, err := service.ListManagedWorktrees(context.Background(), "workspace-1")
	if err != nil || len(worktrees) != 1 || worktrees[0].WorktreeID != session.Isolation.WorktreeID {
		t.Fatalf("managed worktrees after Session delete=%#v error=%v", worktrees, err)
	}
}

func TestDeleteManagedWorktreeRejectsDirtyCheckout(t *testing.T) {
	stateDir, _, isolation := createWorktreeFixture(t, "session-explicit-delete-dirty")
	if err := os.WriteFile(filepath.Join(isolation.WorktreePath, "dirty.txt"), []byte("dirty\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	service := &Service{WorktreeStateDir: stateDir}
	if _, err := service.DeleteManagedWorktree(context.Background(), "workspace-1", isolation.WorktreeID); !errors.Is(err, ErrManagedWorktreeDirty) {
		t.Fatalf("DeleteManagedWorktree() error=%v, want dirty conflict", err)
	}
	assertWorktreeExists(t, isolation.WorktreePath)
}

func TestDeleteManagedWorktreeRejectsAheadBranch(t *testing.T) {
	stateDir, _, isolation := createWorktreeFixture(t, "session-explicit-delete-ahead")
	if err := os.WriteFile(filepath.Join(isolation.WorktreePath, "committed.txt"), []byte("commit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGitForTest(t, isolation.WorktreePath, "add", "committed.txt")
	runGitForTest(t, isolation.WorktreePath, "commit", "-q", "-m", "worktree commit")
	service := &Service{WorktreeStateDir: stateDir}
	if _, err := service.DeleteManagedWorktree(context.Background(), "workspace-1", isolation.WorktreeID); !errors.Is(err, ErrManagedWorktreeAhead) {
		t.Fatalf("DeleteManagedWorktree() error=%v, want ahead conflict", err)
	}
	assertWorktreeExists(t, isolation.WorktreePath)
}

func TestDeleteManagedWorktreeBranchRejectsConcurrentAdvance(t *testing.T) {
	stateDir, _, isolation := createWorktreeFixture(t, "session-explicit-delete-race")
	worktreesRoot := filepath.Join(stateDir, "agent", "worktrees")
	record, err := readManagedWorktreeRecord(worktreeRecordPath(worktreesRoot, isolation.WorktreeID))
	if err != nil {
		t.Fatal(err)
	}
	branchRef := "refs/heads/" + isolation.Branch
	expectedOID, exists, err := managedWorktreeBranchOID(context.Background(), record, branchRef)
	if err != nil || !exists {
		t.Fatalf("managedWorktreeBranchOID() oid=%q exists=%v error=%v", expectedOID, exists, err)
	}
	if err := os.WriteFile(filepath.Join(isolation.WorktreePath, "concurrent.txt"), []byte("commit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGitForTest(t, isolation.WorktreePath, "add", "concurrent.txt")
	runGitForTest(t, isolation.WorktreePath, "commit", "-q", "-m", "concurrent commit")

	err = deleteManagedWorktreeBranch(context.Background(), record, branchRef, expectedOID)
	if !errors.Is(err, ErrManagedWorktreeChanged) {
		t.Fatalf("deleteManagedWorktreeBranch() error=%v, want changed conflict", err)
	}
	if _, err := gitRepoOutput(context.Background(), record, "show-ref", "--verify", branchRef); err != nil {
		t.Fatalf("concurrently advanced branch was removed: %v", err)
	}
}

func TestListManagedWorktreesReadsLegacySessionMetadataWithoutOwnership(t *testing.T) {
	stateDir := t.TempDir()
	repo := initSessionWorktreeRepo(t)
	worktreesRoot := filepath.Join(stateDir, "agent", "worktrees")
	legacyID := "legacy-session-id"
	worktreePath := filepath.Join(worktreesRoot, legacyID)
	branch := "tutti/" + legacyID
	baseCommit, err := gitOutput(context.Background(), repo, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := gitOutput(context.Background(), repo, "worktree", "add", "-b", branch, worktreePath, strings.TrimSpace(baseCommit)); err != nil {
		t.Fatal(err)
	}
	record := managedWorktreeRecord{
		WorktreePath: worktreePath, Branch: branch, BaseCommit: strings.TrimSpace(baseCommit),
		LegacySessionID: legacyID, WorkspaceID: "workspace-1", RepoRoot: repo,
	}
	if err := os.MkdirAll(worktreeRecordsDir(worktreesRoot), 0o700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(worktreeRecordPath(worktreesRoot, legacyID), data, 0o600); err != nil {
		t.Fatal(err)
	}
	service := &Service{WorktreeStateDir: stateDir}
	t.Cleanup(func() {
		legacyIsolation := managedWorktreeIsolation(record)
		legacyIsolation.WorktreeID = legacyID
		service.rollbackSessionWorktree(context.Background(), legacyIsolation)
	})
	worktrees, err := service.ListManagedWorktrees(context.Background(), "workspace-1")
	if err != nil || len(worktrees) != 1 || worktrees[0].WorktreeID != legacyID {
		t.Fatalf("legacy managed worktrees = %#v error=%v", worktrees, err)
	}
}
