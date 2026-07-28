package agent

import (
	"context"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func TestGetLiveComposerModelOptionsClaudeExpiresForRediscovery(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	service := &Service{}
	cachedAt := time.Now().UTC()
	service.setLiveComposerModelOptions("claude-code", "ws-1", "/repo", cachedAt, []ComposerConfigOptionValue{
		{Value: "default", Label: "Default"},
		{Value: "claude-fable-5[1m]", Label: "Fable"},
	})

	if _, ok := service.getLiveComposerModelOptions("claude-code", "ws-1", "/repo", cachedAt.Add(24*time.Hour)); ok {
		t.Fatal("claude live model cache did not expire")
	}
}

func TestGetLiveComposerModelOptionsCursorExpiresForAccountRediscovery(t *testing.T) {
	service := &Service{}
	cachedAt := time.Now().UTC()
	service.setLiveComposerModelOptions("cursor", "ws-1", "/repo", cachedAt, []ComposerConfigOptionValue{
		{Value: "composer-2.5[fast=true]", Label: "composer-2.5"},
		{Value: "gpt-5.2[reasoning=medium,fast=false]", Label: "gpt-5.2"},
	})

	if _, ok := service.getLiveComposerModelOptions("cursor", "ws-1", "/repo", cachedAt.Add(24*time.Hour)); ok {
		t.Fatal("cursor live model cache did not expire")
	}
}

func TestAvailableTaskAssignmentModelsRefreshesCursorCatalog(t *testing.T) {
	t.Setenv("TUTTI_STATE_DIR", t.TempDir())
	runtime := newFakeRuntime()
	runtime.startHook = func(_ RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		session.RuntimeContext = cursorModelRuntimeContext()
		return session
	}
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	service.LiveModelDiscoveryDeleteDelay = time.Hour
	scope := newComposerLiveModelScope(agentprovider.Cursor, "ws-1", "", "local:cursor")
	service.setLiveComposerModelOptionsForScope(scope, time.Now().UTC(), []ComposerConfigOptionValue{
		{ID: "cursor-opus", Label: "Opus", Value: "cursor-opus"},
	})

	models, err := service.AvailableTaskAssignmentModels(
		context.Background(),
		"ws-1",
		"local:cursor",
		"",
	)
	if err != nil {
		t.Fatalf("AvailableTaskAssignmentModels() error = %v", err)
	}
	want := []string{"default[]", "composer-2.5[fast=true]", "gpt-5.2[reasoning=medium,fast=false]"}
	if !slices.Equal(models, want) {
		t.Fatalf("AvailableTaskAssignmentModels() = %v, want refreshed catalog %v", models, want)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("hidden discovery starts = %d, want 1", len(runtime.startCalls))
	}
}

func TestAvailableTaskAssignmentModelsRequiresFreshCursorProbe(t *testing.T) {
	staleContext := map[string]any{
		"configOptions": []any{map[string]any{
			"id":      "model",
			"options": []any{map[string]any{"name": "Opus", "value": "cursor-opus"}},
		}},
	}
	for _, test := range []struct {
		name  string
		setup func(*Service, *fakeRuntime)
	}{
		{
			name: "running session",
			setup: func(_ *Service, runtime *fakeRuntime) {
				futureUnixMS := time.Now().Add(time.Hour).UnixMilli()
				runtime.sessions["ws-1:stale-running"] = ProviderRuntimeSession{
					ID:              "stale-running",
					WorkspaceID:     "ws-1",
					AgentTargetID:   "local:cursor",
					Provider:        agentprovider.Cursor,
					RuntimeContext:  staleContext,
					CreatedAtUnixMS: futureUnixMS,
					UpdatedAtUnixMS: futureUnixMS,
				}
			},
		},
		{
			name: "persisted session",
			setup: func(service *Service, _ *fakeRuntime) {
				service.SessionReader = fakeSessionReader{sessions: map[string]PersistedSession{
					"ws-1:stale-persisted": {
						ID:                     "stale-persisted",
						WorkspaceID:            "ws-1",
						AgentTargetID:          "local:cursor",
						Provider:               agentprovider.Cursor,
						InternalRuntimeContext: staleContext,
						UpdatedAtUnixMS:        time.Now().Add(time.Hour).UnixMilli(),
					},
				}}
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("TUTTI_STATE_DIR", t.TempDir())
			runtime := newFakeRuntime()
			runtime.startHook = func(_ RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
				session.RuntimeContext = cursorModelRuntimeContext()
				return session
			}
			service := newIsolatedAgentService(runtime)
			service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
			service.LiveModelDiscoveryDeleteDelay = time.Hour
			test.setup(service, runtime)

			models, err := service.AvailableTaskAssignmentModels(
				context.Background(),
				"ws-1",
				"local:cursor",
				"",
			)
			if err != nil {
				t.Fatalf("AvailableTaskAssignmentModels() error = %v", err)
			}
			want := []string{"default[]", "composer-2.5[fast=true]", "gpt-5.2[reasoning=medium,fast=false]"}
			if !slices.Equal(models, want) {
				t.Fatalf("AvailableTaskAssignmentModels() = %v, want fresh probe catalog %v", models, want)
			}
			if len(runtime.startCalls) != 1 {
				t.Fatalf("hidden discovery starts = %d, want 1 fresh probe", len(runtime.startCalls))
			}
		})
	}
}

func TestAvailableTaskAssignmentModelsDoesNotAcceptSupersededProbe(t *testing.T) {
	t.Setenv("TUTTI_STATE_DIR", t.TempDir())
	runtime := newTaskAssignmentProbeRaceRuntime()
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	service.LiveModelDiscoveryDeleteDelay = time.Hour

	type result struct {
		models []string
		err    error
	}
	firstResult := make(chan result, 1)
	go func() {
		models, err := service.AvailableTaskAssignmentModels(context.Background(), "ws-1", "local:cursor", "")
		firstResult <- result{models: models, err: err}
	}()
	<-runtime.firstProbeStarted

	initialInvalidatedAt := service.liveModelInvalidatedAtUnixMSForProvider(agentprovider.Cursor)
	time.Sleep(2 * time.Millisecond)
	secondResult := make(chan result, 1)
	go func() {
		models, err := service.AvailableTaskAssignmentModels(context.Background(), "ws-1", "local:cursor", "")
		secondResult <- result{models: models, err: err}
	}()

	deadline := time.Now().Add(time.Second)
	for service.liveModelInvalidatedAtUnixMSForProvider(agentprovider.Cursor) <= initialInvalidatedAt {
		if time.Now().After(deadline) {
			t.Fatal("second validation did not invalidate the provider")
		}
		time.Sleep(time.Millisecond)
	}
	// Reproduce two invalidations sharing the same millisecond token. The
	// generation under test must still distinguish the later validation.
	service.liveModelDiscoveryMu.Lock()
	service.liveModelInvalidatedAtUnixMS[agentprovider.Cursor] = initialInvalidatedAt
	service.liveModelDiscoveryMu.Unlock()
	close(runtime.releaseFirstProbe)

	second := <-secondResult
	want := []string{"default[]", "composer-2.5[fast=true]", "gpt-5.2[reasoning=medium,fast=false]"}
	if second.err != nil {
		t.Fatalf("second AvailableTaskAssignmentModels() error = %v", second.err)
	}
	if !slices.Equal(second.models, want) {
		t.Fatalf("second AvailableTaskAssignmentModels() = %v, want post-invalidation catalog %v", second.models, want)
	}
	first := <-firstResult
	if first.err == nil && !slices.Equal(first.models, want) {
		t.Fatalf("superseded first validation accepted stale catalog %v", first.models)
	}
	if starts := runtime.startCount(); starts != 2 {
		t.Fatalf("hidden discovery starts = %d, want independent probes for both invalidation generations", starts)
	}
	scope := newComposerLiveModelScope(agentprovider.Cursor, "ws-1", "", "local:cursor")
	cached, ok := service.getLiveComposerModelOptionsForScope(scope, time.Now().UTC())
	if !ok || !slices.Equal(composerConfigOptionModelValues(cached), want) {
		t.Fatalf("cache after superseded probe = %v ok = %v, want current generation %v", cached, ok, want)
	}
}

type taskAssignmentProbeRaceRuntime struct {
	*fakeRuntime
	mu                sync.Mutex
	starts            int
	firstProbeStarted chan struct{}
	releaseFirstProbe chan struct{}
}

func newTaskAssignmentProbeRaceRuntime() *taskAssignmentProbeRaceRuntime {
	return &taskAssignmentProbeRaceRuntime{
		fakeRuntime:       newFakeRuntime(),
		firstProbeStarted: make(chan struct{}),
		releaseFirstProbe: make(chan struct{}),
	}
}

func (runtime *taskAssignmentProbeRaceRuntime) Start(
	ctx context.Context,
	input RuntimeStartInput,
) (ProviderRuntimeSession, error) {
	runtime.mu.Lock()
	runtime.starts++
	ordinal := runtime.starts
	runtime.mu.Unlock()
	if ordinal == 1 {
		close(runtime.firstProbeStarted)
		select {
		case <-ctx.Done():
			return ProviderRuntimeSession{}, ctx.Err()
		case <-runtime.releaseFirstProbe:
		}
	}
	runtimeContext := cursorModelRuntimeContext()
	if ordinal == 1 {
		runtimeContext = map[string]any{
			"configOptions": []any{map[string]any{
				"id":      "model",
				"options": []any{map[string]any{"name": "Opus", "value": "cursor-opus"}},
			}},
		}
	}
	nowUnixMS := time.Now().UnixMilli()
	return ProviderRuntimeSession{
		ID:              input.AgentSessionID,
		AgentTargetID:   input.AgentTargetID,
		Provider:        input.Provider,
		WorkspaceID:     input.WorkspaceID,
		RuntimeContext:  runtimeContext,
		CreatedAtUnixMS: nowUnixMS,
		UpdatedAtUnixMS: nowUnixMS,
		Status:          "ready",
	}, nil
}

func (*taskAssignmentProbeRaceRuntime) Sessions(string) []ProviderRuntimeSession {
	return nil
}

func (*taskAssignmentProbeRaceRuntime) Session(string, string) (ProviderRuntimeSession, bool) {
	return ProviderRuntimeSession{}, false
}

func (runtime *taskAssignmentProbeRaceRuntime) startCount() int {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	return runtime.starts
}

// Switching Claude auth context (e.g. OAuth subscription -> ANTHROPIC_API_KEY
// billing) must not serve the previous context's cached model list: the auth
// fingerprint in the cache key buckets them separately.
func TestGetLiveComposerModelOptionsClaudeAuthScopeIsolatesCache(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "")
	service := &Service{}
	now := time.Now().UTC()
	service.setLiveComposerModelOptions("claude-code", "ws-1", "/repo", now, []ComposerConfigOptionValue{
		{Value: "default", Label: "Default"},
		{Value: "opus[1m]", Label: "Opus"},
	})

	if _, ok := service.getLiveComposerModelOptions("claude-code", "ws-1", "/repo", now); !ok {
		t.Fatal("cache miss under same auth scope, want hit")
	}

	// Switch to API-key billing: the OAuth-context list must not leak through.
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-test")
	if _, ok := service.getLiveComposerModelOptions("claude-code", "ws-1", "/repo", now); ok {
		t.Fatal("cache hit across auth switch, want miss (cross-auth isolation)")
	}
}

// A running Claude session's advertised model list is the freshest source and
// must override a stale cache (and refresh it). Without running-session-first
// ordering, a never-expiring cache would shadow the live session and freeze the
// picker at the stale list until daemon restart.
func TestGetComposerOptionsClaudeRunningSessionOverridesStaleCache(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "ready",
		RuntimeContext: map[string]any{
			"configOptions": []any{
				map[string]any{
					"id":           "model",
					"currentValue": "default",
					"options": []any{
						map[string]any{"name": "Default", "value": "default"},
						map[string]any{"name": "Opus", "value": "opus[1m]"},
						map[string]any{"name": "Fable", "value": "claude-fable-5[1m]"},
					},
				},
			},
		},
	}
	service := newIsolatedAgentService(runtime)
	// Seed a stale cache that predates the running session's newer list.
	service.setLiveComposerModelOptions("claude-code", "ws-1", "/repo", time.Now().UTC().Add(-time.Hour), []ComposerConfigOptionValue{
		{Value: "default", Label: "Default"},
		{Value: "sonnet", Label: "Sonnet"},
	})

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider:    "claude-code",
		WorkspaceID: "ws-1",
		Cwd:         "/repo",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %d, want no hidden discovery beside running session", len(runtime.startCalls))
	}

	wantValues := []string{"default", "opus[1m]", "claude-fable-5[1m]"}
	if got := composerConfigOptionModelValues(options.ModelConfig.Options); !slices.Equal(got, wantValues) {
		t.Fatalf("model options = %v, want newer running-session list %v", got, wantValues)
	}
	if options.RuntimeContext["modelCatalogSource"] != runtimeLiveModelCatalogSource {
		t.Fatalf("modelCatalogSource = %#v, want %s", options.RuntimeContext["modelCatalogSource"], runtimeLiveModelCatalogSource)
	}

	// The live session must have refreshed the cache, not the reverse.
	cached, ok := service.getLiveComposerModelOptions("claude-code", "ws-1", "/repo", time.Now().UTC())
	if !ok {
		t.Fatal("cache missing after refresh")
	}
	if got := composerConfigOptionModelValues(cached); !slices.Equal(got, wantValues) {
		t.Fatalf("cache after refresh = %v, want %v", got, wantValues)
	}
}

func TestInvalidateLiveComposerModelsDropsCacheAndAttemptMarkers(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	service := &Service{}
	now := time.UnixMilli(1000)
	options := []ComposerConfigOptionValue{{ID: "opus", Label: "Opus", Value: "opus"}}
	service.setLiveComposerModelOptions(agentprovider.ClaudeCode, "ws-1", "/repo", now, options)
	cacheKey := composerLiveModelCacheKey(agentprovider.ClaudeCode, "ws-1", "/repo", liveModelAuthScope(agentprovider.ClaudeCode))
	if !service.markLiveModelDiscoveryAttempted(cacheKey) {
		t.Fatal("first markLiveModelDiscoveryAttempted must succeed")
	}

	service.InvalidateLiveComposerModels(agentprovider.ClaudeCode)

	if _, ok := service.getLiveComposerModelOptions(agentprovider.ClaudeCode, "ws-1", "/repo", now); ok {
		t.Fatal("cached live models must be dropped after invalidation")
	}
	if !service.markLiveModelDiscoveryAttempted(cacheKey) {
		t.Fatal("discovery attempt marker must be cleared after invalidation")
	}
}

func TestInvalidateLiveComposerModelsKeepsOtherProviders(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	service := &Service{}
	now := time.UnixMilli(1000)
	options := []ComposerConfigOptionValue{{ID: "opus", Label: "Opus", Value: "opus"}}
	service.setLiveComposerModelOptions(agentprovider.ClaudeCode, "ws-1", "/repo", now, options)

	service.InvalidateLiveComposerModels(agentprovider.Codex)

	if _, ok := service.getLiveComposerModelOptions(agentprovider.ClaudeCode, "ws-1", "/repo", now); !ok {
		t.Fatal("claude cache must survive a codex-only invalidation")
	}
}
