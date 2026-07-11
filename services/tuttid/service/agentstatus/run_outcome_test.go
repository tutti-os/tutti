package agentstatus

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func TestRunOutcomeStoreIsProviderScoped(t *testing.T) {
	store := NewRunOutcomeStore()
	store.RecordAuthFailure(agentprovider.ClaudeCode)
	if !store.AuthInvalidated(agentprovider.ClaudeCode) {
		t.Fatal("claude-code should be invalidated")
	}
	if store.AuthInvalidated(agentprovider.Codex) {
		t.Fatal("codex must not be affected by a claude-code failure")
	}
	store.RecordSuccess(agentprovider.ClaudeCode)
	if store.AuthInvalidated(agentprovider.ClaudeCode) {
		t.Fatal("a success should clear the invalidation")
	}
}

func TestRunOutcomeStoreNilSafe(t *testing.T) {
	var store *RunOutcomeStore
	store.RecordAuthFailure(agentprovider.Codex) // must not panic
	if store.AuthInvalidated(agentprovider.Codex) {
		t.Fatal("nil store reports nothing invalidated")
	}
}

func TestResolveAuthOverriddenByRuntimeAuthFailure(t *testing.T) {
	store := NewRunOutcomeStore()
	svc := Service{
		RunOutcomes: store,
		HomeDir:     func() (string, error) { return t.TempDir(), nil },
	}
	// No marker paths / command → baseline is unknown.
	spec := ProviderSpec{Provider: agentprovider.ClaudeCode}

	if got := svc.resolveAuth(context.Background(), spec, true, ""); got.Status != AuthUnknown {
		t.Fatalf("baseline auth = %q, want unknown", got.Status)
	}

	store.RecordAuthFailure(agentprovider.ClaudeCode)
	if got := svc.resolveAuth(context.Background(), spec, true, ""); got.Status != AuthRequired {
		t.Fatalf("after runtime auth failure = %q, want required (override)", got.Status)
	}

	store.ClearAuthInvalidated(agentprovider.ClaudeCode)
	if got := svc.resolveAuth(context.Background(), spec, true, ""); got.Status != AuthUnknown {
		t.Fatalf("after re-auth clear = %q, want unknown", got.Status)
	}
}

// A re-login rewrites the credential file after the failure was recorded; the
// probe must self-heal (clear the stale flag and detect normally) instead of
// sticking on "needs login" until the next successful run.
func TestResolveAuthSelfHealsAfterCredentialRefresh(t *testing.T) {
	store := NewRunOutcomeStore()
	store.RecordAuthFailure(agentprovider.Codex)
	refreshed := time.Now().Add(time.Hour) // marker newer than the recorded failure
	home := t.TempDir()
	marker := filepath.Join(home, ".codex", "auth.json")
	if err := os.MkdirAll(filepath.Dir(marker), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(marker, []byte(`{"OPENAI_API_KEY":"sk-fresh"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	svc := Service{
		RunOutcomes: store,
		HomeDir:     func() (string, error) { return home, nil },
		FileExists:  func(string) bool { return true },
		FileModTime: func(string) (time.Time, bool) { return refreshed, true },
	}
	spec := ProviderSpec{Provider: agentprovider.Codex, AuthMarkerPaths: []string{"~/.codex/auth.json"}}

	if got := svc.resolveAuth(context.Background(), spec, true, ""); got.Status != AuthAuthenticated {
		t.Fatalf("after re-login refresh = %q, want authenticated (self-healed)", got.Status)
	}
	if store.AuthInvalidated(agentprovider.Codex) {
		t.Fatal("the stale flag should be cleared once credentials are refreshed")
	}
}

func TestResolveAuthSelfHealsFromAuthenticatedCommandWithoutMtimeChange(t *testing.T) {
	store := NewRunOutcomeStore()
	store.RecordAuthFailure(agentprovider.Codex)
	svc := Service{
		RunOutcomes: store,
		RunAuthStatusCommand: func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
			return AuthInfo{Status: AuthAuthenticated, AccountLabel: "fresh login"}, true
		},
		FileModTime: func(string) (time.Time, bool) {
			return time.Now().Add(-time.Hour), true
		},
	}
	spec := ProviderSpec{
		Provider:          agentprovider.Codex,
		AuthMarkerPaths:   []string{"~/.codex/auth.json"},
		AuthStatusCommand: []string{"login", "status"},
	}

	auth := svc.resolveAuth(context.Background(), spec, true, "/usr/bin/codex")
	if auth.Status != AuthAuthenticated {
		t.Fatalf("auth = %#v, want authenticated command self-heal", auth)
	}
	if store.AuthInvalidated(agentprovider.Codex) {
		t.Fatal("authenticated command should clear the stale runtime override")
	}
}

// A failure with no newer credential file (token genuinely still broken) must
// keep reporting "needs login".
func TestResolveAuthKeepsFailureWhenCredentialStale(t *testing.T) {
	store := NewRunOutcomeStore()
	store.RecordAuthFailure(agentprovider.Codex)
	stale := time.Now().Add(-time.Hour) // marker older than the recorded failure
	svc := Service{
		RunOutcomes: store,
		HomeDir:     func() (string, error) { return t.TempDir(), nil },
		FileExists:  func(string) bool { return true },
		FileModTime: func(string) (time.Time, bool) { return stale, true },
	}
	spec := ProviderSpec{Provider: agentprovider.Codex, AuthMarkerPaths: []string{"~/.codex/auth.json"}}

	if got := svc.resolveAuth(context.Background(), spec, true, ""); got.Status != AuthRequired {
		t.Fatalf("stale credential after failure = %q, want required", got.Status)
	}
	if !store.AuthInvalidated(agentprovider.Codex) {
		t.Fatal("the flag must persist while credentials remain unrefreshed")
	}
}

func TestResolveAuthOverrideAppliesToCodexToo(t *testing.T) {
	store := NewRunOutcomeStore()
	store.RecordAuthFailure(agentprovider.Codex)
	svc := Service{
		RunOutcomes: store,
		HomeDir:     func() (string, error) { return t.TempDir(), nil },
	}
	spec := ProviderSpec{Provider: agentprovider.Codex}
	if got := svc.resolveAuth(context.Background(), spec, true, ""); got.Status != AuthRequired {
		t.Fatalf("codex auth after failure = %q, want required", got.Status)
	}
}
