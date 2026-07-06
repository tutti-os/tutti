package agent

import (
	"context"
	"errors"
	"testing"
	"time"
)

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
