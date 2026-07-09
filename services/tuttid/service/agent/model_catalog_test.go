package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeCodexModelCatalogConfig(t *testing.T, contents string) {
	t.Helper()
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	if err := os.WriteFile(filepath.Join(codexHome, codexConfigFileName), []byte(contents), 0o600); err != nil {
		t.Fatalf("write codex config.toml: %v", err)
	}
}

// Contract: when ~/.codex/config.toml routes Codex through a custom
// model_provider (cc-switch/OpenRouter style), the official `model/list`
// catalog does not apply — those ids are not servable through the custom
// endpoint. The composer model menu must expose exactly the configured model
// instead of the official list plus an orphaned custom entry.
func TestAgentModelCatalogCustomModelProviderExposesOnlyConfiguredModel(t *testing.T) {
	writeCodexModelCatalogConfig(t,
		"model_provider = \"openrouter\"\n"+
			"model = \"minimax/minimax-m2.5\"\n\n"+
			"[model_providers.openrouter]\n"+
			"base_url = \"https://openrouter.ai/api/v1\"\n")
	lister := &fakeAgentModelLister{
		models: []AgentModelOption{
			{ID: "gpt-5.5", DisplayName: "GPT-5.5", IsDefault: true},
			{ID: "gpt-5.4", DisplayName: "GPT-5.4"},
			{ID: "gpt-5.2", DisplayName: "GPT-5.2"},
		},
	}
	catalog := &CachedAgentModelCatalog{
		Codex: lister,
		Now: func() time.Time {
			return time.UnixMilli(1000)
		},
	}

	result, err := catalog.ListModels(context.Background(), "codex")
	if err != nil {
		t.Fatalf("ListModels returned error: %v", err)
	}
	if len(result.Models) != 1 {
		t.Fatalf("models = %#v, want only the configured custom-provider model", result.Models)
	}
	if result.Models[0].ID != "minimax/minimax-m2.5" || !result.Models[0].IsDefault {
		t.Fatalf("model = %#v, want configured minimax/minimax-m2.5 as default", result.Models[0])
	}
	if result.Source != "codex-configured-model" {
		t.Fatalf("source = %q, want codex-configured-model", result.Source)
	}
}

// Contract: with the default OpenAI provider the official catalog stays
// authoritative, and a configured model missing from it is appended as the
// default (existing append-if-missing behavior).
func TestAgentModelCatalogDefaultProviderKeepsOfficialListWithConfiguredDefault(t *testing.T) {
	writeCodexModelCatalogConfig(t, "model = \"gpt-5.5\"\n")
	lister := &fakeAgentModelLister{
		models: []AgentModelOption{
			{ID: "gpt-5.5", DisplayName: "GPT-5.5"},
			{ID: "gpt-5.4", DisplayName: "GPT-5.4"},
		},
	}
	catalog := &CachedAgentModelCatalog{
		Codex: lister,
		Now: func() time.Time {
			return time.UnixMilli(1000)
		},
	}

	result, err := catalog.ListModels(context.Background(), "codex")
	if err != nil {
		t.Fatalf("ListModels returned error: %v", err)
	}
	if len(result.Models) != 2 {
		t.Fatalf("models = %#v, want official catalog untouched", result.Models)
	}
	if !result.Models[0].IsDefault || result.Models[0].ID != "gpt-5.5" {
		t.Fatalf("models = %#v, want configured gpt-5.5 marked default", result.Models)
	}
}

func TestAgentModelCatalogDoesNotReturnClaudeStaticModels(t *testing.T) {
	catalog := &CachedAgentModelCatalog{
		Now: func() time.Time {
			return time.UnixMilli(1000)
		},
	}

	if _, err := catalog.ListModels(context.Background(), "claude-code"); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("ListModels error = %v, want ErrInvalidArgument", err)
	}
}

func TestAgentModelCatalogInvalidateDropsCodexCacheBeforeTTL(t *testing.T) {
	now := time.UnixMilli(1000)
	lister := &fakeAgentModelLister{
		models: []AgentModelOption{{ID: "gpt-5.2-codex", DisplayName: "gpt-5.2-codex", IsDefault: true}},
	}
	catalog := &CachedAgentModelCatalog{
		Codex: lister,
		Now: func() time.Time {
			return now
		},
	}

	if _, err := catalog.ListModels(context.Background(), "codex"); err != nil {
		t.Fatalf("first ListModels returned error: %v", err)
	}
	if _, err := catalog.ListModels(context.Background(), "codex"); err != nil {
		t.Fatalf("second ListModels returned error: %v", err)
	}
	if lister.calls != 1 {
		t.Fatalf("lister calls before invalidate = %d, want 1", lister.calls)
	}

	catalog.Invalidate("codex")
	if _, err := catalog.ListModels(context.Background(), "codex"); err != nil {
		t.Fatalf("ListModels after invalidate returned error: %v", err)
	}
	if lister.calls != 2 {
		t.Fatalf("lister calls after invalidate = %d, want 2", lister.calls)
	}
}

func TestAgentModelCatalogInvalidateIgnoresOtherProviders(t *testing.T) {
	now := time.UnixMilli(1000)
	lister := &fakeAgentModelLister{
		models: []AgentModelOption{{ID: "gpt-5.2-codex", DisplayName: "gpt-5.2-codex", IsDefault: true}},
	}
	catalog := &CachedAgentModelCatalog{
		Codex: lister,
		Now: func() time.Time {
			return now
		},
	}

	if _, err := catalog.ListModels(context.Background(), "codex"); err != nil {
		t.Fatalf("first ListModels returned error: %v", err)
	}
	catalog.Invalidate("claude-code", "unknown-provider")
	if _, err := catalog.ListModels(context.Background(), "codex"); err != nil {
		t.Fatalf("second ListModels returned error: %v", err)
	}
	if lister.calls != 1 {
		t.Fatalf("lister calls = %d, want 1 (codex cache must survive unrelated invalidations)", lister.calls)
	}
}

func TestAgentModelCatalogCachesGeminiFallbackForShortTTL(t *testing.T) {
	now := time.UnixMilli(1000)
	lister := &fakeAgentModelLister{
		models:   []AgentModelOption{{ID: "auto", DisplayName: "auto", IsDefault: true}},
		fallback: true,
	}
	catalog := &CachedAgentModelCatalog{
		Gemini: lister,
		Now: func() time.Time {
			return now
		},
	}

	if _, err := catalog.ListModels(context.Background(), "gemini"); err != nil {
		t.Fatalf("first ListModels returned error: %v", err)
	}
	if _, err := catalog.ListModels(context.Background(), "gemini"); err != nil {
		t.Fatalf("second ListModels returned error: %v", err)
	}
	if lister.calls != 1 {
		t.Fatalf("lister calls before ttl = %d, want 1", lister.calls)
	}

	now = now.Add(geminiModelFallbackTTL + time.Millisecond)
	if _, err := catalog.ListModels(context.Background(), "gemini"); err != nil {
		t.Fatalf("third ListModels returned error: %v", err)
	}
	if lister.calls != 2 {
		t.Fatalf("lister calls after fallback ttl = %d, want 2", lister.calls)
	}
}
