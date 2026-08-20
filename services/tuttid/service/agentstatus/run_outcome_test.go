package agentstatus

import (
	"testing"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerstatus"
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
	evidence, _, ok := store.AuthEvidence(agentprovider.ClaudeCode)
	if !ok || evidence.Kind != providerstatus.AuthEvidenceRemoteSuccess {
		t.Fatalf("success evidence = %#v, %v", evidence, ok)
	}
}

func TestRunOutcomeStoreNilSafe(t *testing.T) {
	var store *RunOutcomeStore
	store.RecordAuthFailure(agentprovider.Codex) // must not panic
	if store.AuthInvalidated(agentprovider.Codex) {
		t.Fatal("nil store reports nothing invalidated")
	}
}

func TestReduceProviderAuthUsesRuntimeAuthFailure(t *testing.T) {
	store := NewRunOutcomeStore()
	svc := Service{
		RunOutcomes: store,
		HomeDir:     func() (string, error) { return t.TempDir(), nil },
	}
	// No marker paths / command → baseline is unknown.
	spec := ProviderSpec{Provider: agentprovider.ClaudeCode}

	if got := svc.reduceProviderAuth(spec, AuthInfo{Status: AuthUnknown}, false, providerstatus.AuthEvidenceAuthorityLocal); got.Status != AuthUnknown {
		t.Fatalf("baseline auth = %q, want unknown", got.Status)
	}

	store.RecordAuthFailure(agentprovider.ClaudeCode)
	if got := svc.reduceProviderAuth(spec, AuthInfo{Status: AuthUnknown}, false, providerstatus.AuthEvidenceAuthorityLocal); got.Status != AuthRequired {
		t.Fatalf("after runtime auth failure = %q, want required (override)", got.Status)
	}

	store.ClearAuthInvalidated(agentprovider.ClaudeCode)
	if got := svc.reduceProviderAuth(spec, AuthInfo{Status: AuthUnknown}, false, providerstatus.AuthEvidenceAuthorityLocal); got.Status != AuthUnknown {
		t.Fatalf("after re-auth clear = %q, want unknown", got.Status)
	}
}

// A re-login rewrites the credential file after the failure was recorded; the
// probe must self-heal (clear the stale flag and detect normally) instead of
// sticking on "needs login" until the next successful run.
func TestReduceProviderAuthSelfHealsAfterCredentialRefresh(t *testing.T) {
	store := NewRunOutcomeStore()
	store.RecordAuthFailure(agentprovider.Codex)
	refreshed := time.Now().Add(time.Hour) // marker newer than the recorded failure
	svc := Service{
		RunOutcomes: store,
		HomeDir:     func() (string, error) { return t.TempDir(), nil },
		FileExists:  func(string) bool { return true },
		FileModTime: func(string) (time.Time, bool) { return refreshed, true },
	}
	spec := ProviderSpec{Provider: agentprovider.Codex, AuthMarkerPaths: []string{"~/.codex/auth.json"}}

	if got := svc.reduceProviderAuth(spec, AuthInfo{Status: AuthAuthenticated}, false, providerstatus.AuthEvidenceAuthorityLocal); got.Status != AuthConfigured {
		t.Fatalf("after re-login refresh = %q, want configured (self-healed)", got.Status)
	}
	if store.AuthInvalidated(agentprovider.Codex) {
		t.Fatal("the stale flag should be cleared once credentials are refreshed")
	}
}

// A failure with no newer credential file (token genuinely still broken) must
// keep reporting "needs login".
func TestReduceProviderAuthKeepsFailureWhenCredentialStale(t *testing.T) {
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

	if got := svc.reduceProviderAuth(spec, AuthInfo{Status: AuthAuthenticated}, false, providerstatus.AuthEvidenceAuthorityLocal); got.Status != AuthRequired {
		t.Fatalf("stale credential after failure = %q, want required", got.Status)
	}
	if !store.AuthInvalidated(agentprovider.Codex) {
		t.Fatal("the flag must persist while credentials remain unrefreshed")
	}
}

func TestReduceProviderAuthOverrideAppliesToCodexToo(t *testing.T) {
	store := NewRunOutcomeStore()
	store.RecordAuthFailure(agentprovider.Codex)
	svc := Service{
		RunOutcomes: store,
		HomeDir:     func() (string, error) { return t.TempDir(), nil },
	}
	spec := ProviderSpec{Provider: agentprovider.Codex}
	if got := svc.reduceProviderAuth(spec, AuthInfo{Status: AuthUnknown}, false, providerstatus.AuthEvidenceAuthorityLocal); got.Status != AuthRequired {
		t.Fatalf("codex auth after failure = %q, want required", got.Status)
	}
}

func TestReduceProviderAuthPromotesConfiguredCredentialsAfterRuntimeSuccess(t *testing.T) {
	store := NewRunOutcomeStore()
	store.RecordSuccess(agentprovider.ClaudeCode)
	svc := Service{RunOutcomes: store}
	spec := ProviderSpec{Provider: agentprovider.ClaudeCode}

	got := svc.reduceProviderAuth(spec, AuthInfo{Status: AuthAuthenticated, AuthMethod: "oauth"}, false, providerstatus.AuthEvidenceAuthorityLocal)
	if got.Status != AuthAuthenticated || got.AuthMethod != "oauth" {
		t.Fatalf("auth after runtime success = %#v, want authenticated oauth", got)
	}
}
