package agent

import (
	"context"
	"slices"
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

// Cursor keeps its live model cache for the daemon's lifetime too: it has no
// probe session at all, so an expired entry could only be re-discovered by a
// running conversation — until then the picker would collapse to the single
// selected model. Running sessions still override a stale entry.
func TestGetLiveComposerModelOptionsCursorNeverExpires(t *testing.T) {
	service := &Service{}
	cachedAt := time.Now().UTC()
	service.setLiveComposerModelOptions("cursor", "ws-1", "/repo", cachedAt, []ComposerConfigOptionValue{
		{Value: "composer-2.5[fast=true]", Label: "composer-2.5"},
		{Value: "gpt-5.2[reasoning=medium,fast=false]", Label: "gpt-5.2"},
	})

	got, ok := service.getLiveComposerModelOptions("cursor", "ws-1", "/repo", cachedAt.Add(24*time.Hour))
	if !ok {
		t.Fatal("cursor live model cache expired, want last-known-good retained")
	}
	if len(got) != 2 {
		t.Fatalf("cached options = %d, want 2", len(got))
	}
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
