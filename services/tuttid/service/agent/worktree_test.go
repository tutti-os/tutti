package agent

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

type recordingSessionDirectoryAllocator struct {
	calls int
	path  string
}

type recordingWorktreeSessionInitializer struct {
	sessions *fakeSessionReader
}

func (i recordingWorktreeSessionInitializer) InitializeRuntimeSession(
	ctx context.Context,
	session ProviderRuntimeSession,
	railPlacement *agenthost.RailPlacement,
) (PersistedSession, error) {
	persisted, err := (fakeSessionInitializer{}).InitializeRuntimeSession(ctx, session, railPlacement)
	if err == nil {
		i.sessions.sessions[persisted.WorkspaceID+":"+persisted.ID] = persisted
	}
	return persisted, err
}

func (a *recordingSessionDirectoryAllocator) CreateSessionDirectory(context.Context) (string, error) {
	a.calls++
	if err := os.MkdirAll(a.path, 0o755); err != nil {
		return "", err
	}
	return a.path, nil
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
	record := sessionWorktreeRecord{
		SessionIsolation: launch.Isolation,
		SessionID:        sessionID, WorkspaceID: "workspace-1", RepoRoot: repo,
	}
	t.Cleanup(func() {
		rollbackSessionWorktree(context.Background(), filepath.Join(stateDir, "agent", "worktrees"), record)
	})
	return stateDir, repo, launch.Isolation
}

func TestCreateSessionWorktree(t *testing.T) {
	stateDir, _, isolation := createWorktreeFixture(t, "session-create")
	if isolation.Mode != WorktreeIsolationMode || isolation.Branch != "tutti/session-create" {
		t.Fatalf("isolation = %#v", isolation)
	}
	if isolation.WorktreePath != filepath.Join(stateDir, "agent", "worktrees", "session-create") {
		t.Fatalf("worktree path = %q", isolation.WorktreePath)
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
	t.Cleanup(func() {
		rollbackSessionWorktree(context.Background(), filepath.Join(stateDir, "agent", "worktrees"), sessionWorktreeRecord{
			SessionIsolation: first.Isolation,
			SessionID:        "session-retry",
			WorkspaceID:      "workspace-1",
			RepoRoot:         repo,
		})
	})
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

func TestCreateSessionWorktreeRejectsRetryFromDifferentWorkspace(t *testing.T) {
	stateDir := t.TempDir()
	repo := initSessionWorktreeRepo(t)
	first, err := createSessionWorktree(context.Background(), stateDir, "workspace-1", repo, "session-scope-mismatch")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		rollbackSessionWorktree(context.Background(), filepath.Join(stateDir, "agent", "worktrees"), sessionWorktreeRecord{
			SessionIsolation: first.Isolation,
			SessionID:        "session-scope-mismatch",
			WorkspaceID:      "workspace-1",
			RepoRoot:         repo,
		})
	})
	if _, err := createSessionWorktree(context.Background(), stateDir, "workspace-2", repo, "session-scope-mismatch"); !errors.Is(err, ErrWorktreeCreateFailed) {
		t.Fatalf("retry error = %v, want ErrWorktreeCreateFailed", err)
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
	t.Cleanup(func() {
		rollbackSessionWorktree(context.Background(), filepath.Join(stateDir, "agent", "worktrees"), sessionWorktreeRecord{
			SessionIsolation: launch.Isolation,
			SessionID:        "session-subdirectory",
			WorkspaceID:      "workspace-1",
			RepoRoot:         repo,
		})
	})
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
	record := sessionWorktreeRecord{SessionIsolation: isolation, SessionID: "session-dirty-source", WorkspaceID: "workspace-1", RepoRoot: repo}
	t.Cleanup(func() {
		rollbackSessionWorktree(context.Background(), filepath.Join(stateDir, "agent", "worktrees"), record)
	})
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
	worktreePath := filepath.Join(stateDir, "agent", "worktrees", "session-service-fail")
	if _, statErr := os.Stat(worktreePath); !os.IsNotExist(statErr) {
		t.Fatalf("failed create worktree still exists: %v", statErr)
	}
	if len(runtime.sessions) != 0 {
		t.Fatalf("runtime sessions = %#v, want none", runtime.sessions)
	}
	if _, branchErr := gitOutput(context.Background(), repo, "show-ref", "--verify", "refs/heads/tutti/session-service-fail"); branchErr == nil {
		t.Fatal("failed create branch still exists")
	}
}

func TestServiceCreateSerializesWorktreeWithSweep(t *testing.T) {
	stateDir := t.TempDir()
	repo := initSessionWorktreeRepo(t)
	startEntered := make(chan struct{})
	releaseStart := make(chan struct{})
	runtime := newFakeRuntime()
	runtime.startHook = func(input RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		if err := os.WriteFile(filepath.Join(input.Cwd, "creating.txt"), []byte("creating\n"), 0o644); err != nil {
			t.Errorf("write creating marker: %v", err)
		}
		close(startEntered)
		<-releaseStart
		return session
	}
	service := newTestService(runtime)
	service.WorktreeStateDir = stateDir
	service.WorkspaceIDs = func(context.Context) ([]string, error) { return []string{"workspace-1"}, nil }
	service.SessionReader = fakeSessionReader{sessions: map[string]PersistedSession{}}

	createDone := make(chan struct{})
	var created Session
	var createErr error
	go func() {
		defer close(createDone)
		created, createErr = service.Create(context.Background(), "workspace-1", CreateSessionInput{
			AgentSessionID: "session-concurrent-create", AgentTargetID: agenttargetbiz.IDLocalCodex,
			Cwd: stringPointer(repo), Isolation: WorktreeIsolationMode, InitialContent: TextPromptContent("work"),
			RailPlacement: projectRailPlacement(repo),
		})
	}()
	select {
	case <-startEntered:
	case <-createDone:
		t.Fatalf("Create finished before runtime start hook: %v", createErr)
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for runtime start hook")
	}
	if service.worktreeIsolationMu.TryLock() {
		service.worktreeIsolationMu.Unlock()
		t.Fatal("worktree isolation lock was not held during session creation")
	}

	sweepStarted := make(chan struct{})
	sweepDone := make(chan error, 1)
	go func() {
		close(sweepStarted)
		sweepDone <- service.SweepWorktreeIsolation(context.Background())
	}()
	<-sweepStarted
	select {
	case err := <-sweepDone:
		t.Fatalf("sweep completed during worktree creation: %v", err)
	case <-time.After(150 * time.Millisecond):
	}

	close(releaseStart)
	select {
	case <-createDone:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for isolated create")
	}
	if createErr != nil {
		t.Fatalf("Create error = %v", createErr)
	}
	select {
	case err := <-sweepDone:
		if err != nil {
			t.Fatalf("SweepWorktreeIsolation error = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for worktree sweep")
	}
	if created.Isolation == nil {
		t.Fatalf("created session isolation = %#v", created.Isolation)
	}
	t.Cleanup(func() { service.rollbackSessionWorktree(context.Background(), *created.Isolation) })
	assertWorktreeExists(t, created.Isolation.WorktreePath)
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

func TestServiceCreateSerializesManagedCwdReferenceWithSweep(t *testing.T) {
	stateDir, _, isolation := createWorktreeFixture(t, "session-gc-reference-race")
	managedCwd := filepath.Join(isolation.WorktreePath, "nested")
	if err := os.MkdirAll(managedCwd, 0o755); err != nil {
		t.Fatal(err)
	}
	startEntered := make(chan struct{})
	releaseStart := make(chan struct{})
	runtime := newFakeRuntime()
	runtime.startHook = func(_ RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		close(startEntered)
		<-releaseStart
		return session
	}
	service := newTestService(runtime)
	service.WorktreeStateDir = stateDir
	service.WorkspaceIDs = func(context.Context) ([]string, error) { return []string{"workspace-1"}, nil }
	sessions := &fakeSessionReader{sessions: map[string]PersistedSession{}}
	service.SessionReader = sessions
	service.SessionInitializer = recordingWorktreeSessionInitializer{sessions: sessions}

	createDone := make(chan error, 1)
	go func() {
		_, err := service.Create(context.Background(), "workspace-1", CreateSessionInput{
			AgentSessionID: "session-referencing-managed-cwd", AgentTargetID: agenttargetbiz.IDLocalCodex,
			Cwd: stringPointer(managedCwd),
		})
		createDone <- err
	}()
	select {
	case <-startEntered:
	case err := <-createDone:
		t.Fatalf("Create finished before runtime start hook: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for runtime start hook")
	}
	if service.worktreeIsolationMu.TryLock() {
		service.worktreeIsolationMu.Unlock()
		t.Fatal("worktree GC lock was not held while creating a session with a managed cwd")
	}

	sweepDone := make(chan error, 1)
	go func() { sweepDone <- service.SweepWorktreeIsolation(context.Background()) }()
	select {
	case err := <-sweepDone:
		t.Fatalf("sweep completed while the managed cwd session was being created: %v", err)
	case <-time.After(150 * time.Millisecond):
	}

	close(releaseStart)
	select {
	case err := <-createDone:
		if err != nil {
			t.Fatalf("Create error = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for managed cwd session create")
	}
	select {
	case err := <-sweepDone:
		if err != nil {
			t.Fatalf("SweepWorktreeIsolation error = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for worktree sweep")
	}
	assertWorktreeExists(t, isolation.WorktreePath)
}

func TestSweepSessionWorktreesKeepsDirtyWorktree(t *testing.T) {
	stateDir, _, isolation := createWorktreeFixture(t, "session-gc-dirty")
	if err := os.WriteFile(filepath.Join(isolation.WorktreePath, "dirty.txt"), []byte("dirty\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := sweepSessionWorktrees(context.Background(), stateDir, nil, nil); err != nil {
		t.Fatal(err)
	}
	assertWorktreeExists(t, isolation.WorktreePath)
}

func TestSweepConfiguredWorktreeIsolationProtectsRecoverableDeletedSession(t *testing.T) {
	stateDir, _, isolation := createWorktreeFixture(t, "session-gc-deleted-recoverable")
	reader := &fakeSessionReader{
		sessions: map[string]PersistedSession{},
		recoverableDeleted: []agentactivitybiz.DeletedSessionResource{{
			WorkspaceID:    "workspace-1",
			AgentSessionID: "session-gc-deleted-recoverable",
			Cwd:            isolation.WorktreePath,
		}},
	}
	if err := sweepConfiguredWorktreeIsolation(
		context.Background(),
		&sync.RWMutex{},
		stateDir,
		func(context.Context) ([]string, error) { return []string{"workspace-1"}, nil },
		reader,
		func(PersistedSession) bool { return false },
	); err != nil {
		t.Fatal(err)
	}
	assertWorktreeExists(t, isolation.WorktreePath)
}

func TestSweepSessionWorktreesKeepsAheadBranch(t *testing.T) {
	stateDir, _, isolation := createWorktreeFixture(t, "session-gc-ahead")
	if err := os.WriteFile(filepath.Join(isolation.WorktreePath, "committed.txt"), []byte("commit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGitForTest(t, isolation.WorktreePath, "add", "committed.txt")
	runGitForTest(t, isolation.WorktreePath, "commit", "-q", "-m", "worktree commit")
	if err := sweepSessionWorktrees(context.Background(), stateDir, nil, nil); err != nil {
		t.Fatal(err)
	}
	assertWorktreeExists(t, isolation.WorktreePath)
}

func TestSweepSessionWorktreesKeepsAheadRecordedBranchWhenHeadDetached(t *testing.T) {
	stateDir, repo, isolation := createWorktreeFixture(t, "session-gc-ahead-detached")
	if err := os.WriteFile(filepath.Join(isolation.WorktreePath, "committed.txt"), []byte("commit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGitForTest(t, isolation.WorktreePath, "add", "committed.txt")
	runGitForTest(t, isolation.WorktreePath, "commit", "-q", "-m", "worktree commit")
	runGitForTest(t, isolation.WorktreePath, "checkout", "-q", "--detach", isolation.BaseCommit)
	if err := sweepSessionWorktrees(context.Background(), stateDir, nil, nil); err != nil {
		t.Fatal(err)
	}
	assertWorktreeExists(t, isolation.WorktreePath)
	if _, err := gitOutput(context.Background(), repo, "show-ref", "--verify", "refs/heads/"+isolation.Branch); err != nil {
		t.Fatalf("recorded branch %q was removed: %v", isolation.Branch, err)
	}
}

func TestSweepSessionWorktreesKeepsResumableCreator(t *testing.T) {
	stateDir, repo, isolation := createWorktreeFixture(t, "session-gc-resumable")
	sessions := []PersistedSession{{ID: "session-gc-resumable", WorkspaceID: "workspace-1", Cwd: repo}}
	canResumeCalled := false
	if err := sweepSessionWorktrees(context.Background(), stateDir, sessions, func(PersistedSession) bool {
		canResumeCalled = true
		return true
	}); err != nil {
		t.Fatal(err)
	}
	if !canResumeCalled {
		t.Fatal("creator resumability was not evaluated")
	}
	assertWorktreeExists(t, isolation.WorktreePath)
}

func TestSweepSessionWorktreesKeepsTreeUsedByAnotherSession(t *testing.T) {
	stateDir, repo, isolation := createWorktreeFixture(t, "session-gc-used")
	sessions := []PersistedSession{
		{ID: "session-gc-used", WorkspaceID: "workspace-1", Cwd: repo},
		{ID: "other-session", WorkspaceID: "workspace-1", Cwd: filepath.Join(isolation.WorktreePath, "nested")},
	}
	if err := sweepSessionWorktrees(context.Background(), stateDir, sessions, func(PersistedSession) bool { return false }); err != nil {
		t.Fatal(err)
	}
	assertWorktreeExists(t, isolation.WorktreePath)
}

func TestSweepSessionWorktreesKeepsTreeReferencedByUnresumableCreator(t *testing.T) {
	stateDir, _, isolation := createWorktreeFixture(t, "session-gc-creator-cwd")
	sessions := []PersistedSession{{ID: "session-gc-creator-cwd", WorkspaceID: "workspace-1", Cwd: isolation.WorktreePath}}
	if err := sweepSessionWorktrees(context.Background(), stateDir, sessions, func(PersistedSession) bool { return false }); err != nil {
		t.Fatal(err)
	}
	assertWorktreeExists(t, isolation.WorktreePath)
}

func TestSweepSessionWorktreesDeletesCleanOrphanAndBranch(t *testing.T) {
	stateDir, repo, isolation := createWorktreeFixture(t, "session-gc-delete")
	if err := sweepSessionWorktrees(context.Background(), stateDir, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(isolation.WorktreePath); !os.IsNotExist(err) {
		t.Fatalf("worktree still exists, stat error = %v", err)
	}
	if _, err := gitOutput(context.Background(), repo, "show-ref", "--verify", "refs/heads/"+isolation.Branch); err == nil {
		t.Fatalf("branch %q still exists", isolation.Branch)
	}
}

func TestSweepSessionWorktreesCleansChildAfterParentWorktreeRemoved(t *testing.T) {
	stateDir := t.TempDir()
	repo := initSessionWorktreeRepo(t)
	parentLaunch, err := createSessionWorktree(context.Background(), stateDir, "workspace-1", repo, "session-gc-parent")
	if err != nil {
		t.Fatalf("create parent worktree: %v", err)
	}
	parent := parentLaunch.Isolation
	childLaunch, err := createSessionWorktree(context.Background(), stateDir, "workspace-1", parent.WorktreePath, "session-gc-child")
	if err != nil {
		t.Fatalf("create child worktree from parent cwd: %v", err)
	}
	child := childLaunch.Isolation
	worktreesRoot := filepath.Join(stateDir, "agent", "worktrees")
	childRecord, err := readSessionWorktreeRecord(worktreeRecordPath(worktreesRoot, "session-gc-child"))
	if err != nil {
		t.Fatal(err)
	}
	if childRecord.GitCommonDir == "" || pathInsideWorktree(childRecord.GitCommonDir, parent.WorktreePath) {
		t.Fatalf("child GC anchor %q depends on collectable parent worktree %q", childRecord.GitCommonDir, parent.WorktreePath)
	}
	runGitForTest(t, repo, "worktree", "remove", parent.WorktreePath)
	runGitForTest(t, repo, "branch", "-D", parent.Branch)
	if err := os.Remove(worktreeRecordPath(worktreesRoot, "session-gc-parent")); err != nil {
		t.Fatal(err)
	}
	if err := sweepSessionWorktrees(context.Background(), stateDir, nil, nil); err != nil {
		t.Fatalf("sweep after parent removal: %v", err)
	}
	if _, statErr := os.Stat(child.WorktreePath); !os.IsNotExist(statErr) {
		t.Fatalf("child worktree still exists, stat error = %v", statErr)
	}
	if _, branchErr := gitOutput(context.Background(), repo, "show-ref", "--verify", "refs/heads/"+child.Branch); branchErr == nil {
		t.Fatalf("child branch %q still exists", child.Branch)
	}
	if _, statErr := os.Stat(worktreeRecordPath(worktreesRoot, "session-gc-child")); !os.IsNotExist(statErr) {
		t.Fatalf("child record still exists, stat error = %v", statErr)
	}
}

func assertWorktreeExists(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("worktree %q does not exist: %v", path, err)
	}
}
