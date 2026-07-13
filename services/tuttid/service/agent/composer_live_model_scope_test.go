package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

type startupWaitRuntime struct {
	*fakeRuntime
	firstSessionsCall chan struct{}
	sessionsCalls     atomic.Int32
	afterWaitSessions []ProviderRuntimeSession
}

type closeSignalRuntime struct {
	*fakeRuntime
	closed chan RuntimeCloseInput
}

func (r *closeSignalRuntime) Close(_ context.Context, input RuntimeCloseInput) error {
	r.closed <- input
	return nil
}

func (r *startupWaitRuntime) Sessions(string) []ProviderRuntimeSession {
	if r.sessionsCalls.Add(1) == 1 {
		close(r.firstSessionsCall)
		return nil
	}
	return append([]ProviderRuntimeSession(nil), r.afterWaitSessions...)
}

func TestClaudeLiveModelCacheKeyIgnoresCallerCwd(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())

	rootKey := composerLiveModelCacheKey(
		agentprovider.ClaudeCode,
		"workspace-1",
		"/",
		liveModelAuthScope(agentprovider.ClaudeCode),
	)
	projectKey := composerLiveModelCacheKey(
		agentprovider.ClaudeCode,
		"workspace-1",
		"/Users/example/project",
		liveModelAuthScope(agentprovider.ClaudeCode),
	)
	if rootKey != projectKey {
		t.Fatalf("Claude cache keys differ by cwd: root=%q project=%q", rootKey, projectKey)
	}

	cursorRootKey := composerLiveModelCacheKey(agentprovider.Cursor, "workspace-1", "/", "")
	cursorProjectKey := composerLiveModelCacheKey(agentprovider.Cursor, "workspace-1", "/project", "")
	if cursorRootKey == cursorProjectKey {
		t.Fatal("non-Claude cache keys must retain their cwd scope")
	}
}

func TestClaudeLiveModelScopeIsSharedAcrossWorkspacesAndSeparatedByTarget(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	first := newComposerLiveModelScope(agentprovider.ClaudeCode, "workspace-1", "/one", "local-claude")
	second := newComposerLiveModelScope(agentprovider.ClaudeCode, "workspace-2", "/two", "local-claude")
	otherTarget := newComposerLiveModelScope(agentprovider.ClaudeCode, "workspace-2", "/two", "remote-claude")
	if first.key() != second.key() {
		t.Fatalf("Claude discovery scope differs across workspaces: %q != %q", first.key(), second.key())
	}
	if first.key() == otherTarget.key() {
		t.Fatal("Claude discovery scope must distinguish agent targets")
	}
}

func TestClaudeLiveModelDiscoveryUsesDaemonOwnedCwd(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("TUTTI_STATE_DIR", stateDir)
	service := newIsolatedAgentService(newFakeRuntime())

	fromRoot, err := service.resolveLiveModelDiscoveryCwd(context.Background(), agentprovider.ClaudeCode, "/")
	if err != nil {
		t.Fatalf("resolve root discovery cwd: %v", err)
	}
	fromProject, err := service.resolveLiveModelDiscoveryCwd(context.Background(), agentprovider.ClaudeCode, "/Users/example/project")
	if err != nil {
		t.Fatalf("resolve project discovery cwd: %v", err)
	}
	want := filepath.Join(stateDir, "agent", "discovery", agentprovider.ClaudeCode)
	if fromRoot != want || fromProject != want {
		t.Fatalf("Claude discovery cwd = %q and %q, want %q", fromRoot, fromProject, want)
	}
	info, err := os.Stat(want)
	if err != nil {
		t.Fatalf("stat discovery cwd: %v", err)
	}
	if !info.IsDir() {
		t.Fatalf("discovery cwd %q is not a directory", want)
	}
}

func TestClaudeLiveModelDiscoveryRechecksSessionsAfterStartupWait(t *testing.T) {
	t.Setenv("TUTTI_STATE_DIR", t.TempDir())
	runtime := &startupWaitRuntime{
		fakeRuntime:       newFakeRuntime(),
		firstSessionsCall: make(chan struct{}),
	}
	service := newIsolatedAgentService(runtime)
	releaseStartup, err := service.awaitClaudeStartupSlot(context.Background(), agentprovider.ClaudeCode)
	if err != nil {
		t.Fatalf("acquire startup slot: %v", err)
	}

	result := make(chan error, 1)
	go func() {
		models, discoverErr := service.discoverLiveComposerModelsUncached(
			context.Background(),
			agentprovider.ClaudeCode,
			"workspace-1",
			"/project",
			ComposerSettings{},
		)
		if discoverErr == nil && (len(models) != 1 || models[0].Value != "sonnet") {
			discoverErr = fmt.Errorf("models = %#v, want reused sonnet", models)
		}
		result <- discoverErr
	}()

	<-runtime.firstSessionsCall
	runtime.afterWaitSessions = []ProviderRuntimeSession{{
		ID:          "existing-discovery",
		Provider:    agentprovider.ClaudeCode,
		WorkspaceID: "workspace-1",
		RuntimeContext: map[string]any{
			"configOptions": []any{map[string]any{
				"id":      "model",
				"options": []any{map[string]any{"name": "Sonnet", "value": "sonnet"}},
			}},
		},
	}}
	releaseStartup()

	if err := <-result; err != nil {
		t.Fatalf("discover after startup wait: %v", err)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %d, want reuse after waiting", len(runtime.startCalls))
	}
}

func TestClaudeAuthInvalidationKeepsRetainedDiscoverySessionAlive(t *testing.T) {
	closed := make(chan RuntimeCloseInput, 1)
	runtime := &closeSignalRuntime{fakeRuntime: newFakeRuntime(), closed: closed}
	runtime.sessions["workspace-1:discovery-1"] = ProviderRuntimeSession{
		ID: "discovery-1", WorkspaceID: "workspace-1", Provider: agentprovider.ClaudeCode,
	}
	service := newIsolatedAgentService(runtime)
	scope := newComposerLiveModelScope(agentprovider.ClaudeCode, "workspace-1", "/repo", "local-claude")
	service.trackLiveModelDiscoverySession(scope, "discovery-1")
	service.markLiveModelDiscoveryAttempted(scope.key())

	service.InvalidateLiveComposerModels(agentprovider.ClaudeCode)

	select {
	case input := <-closed:
		t.Fatalf("auth invalidation closed retained discovery session %q before the ten-minute lifecycle completed", input.AgentSessionID)
	case <-time.After(50 * time.Millisecond):
	}
	if service.liveModelDiscoveryWasAttempted(scope.key()) {
		t.Fatal("auth invalidation kept the stale discovery attempt marker")
	}
}

func TestClaudeDiscoveryStartFailureRemainsRetryable(t *testing.T) {
	t.Setenv("TUTTI_STATE_DIR", t.TempDir())
	runtime := newFakeRuntime()
	runtime.startErr = errors.New("transient startup failure")
	service := newIsolatedAgentService(runtime)
	scope := newComposerLiveModelScope(agentprovider.ClaudeCode, "workspace-1", "/repo", "")

	if _, err := service.discoverLiveComposerModelsUncachedForScope(
		context.Background(), scope, nil, ComposerSettings{},
	); err == nil {
		t.Fatal("discovery start unexpectedly succeeded")
	}
	if service.liveModelDiscoveryWasAttempted(scope.key()) {
		t.Fatal("failed startup permanently consumed the discovery attempt")
	}
}
