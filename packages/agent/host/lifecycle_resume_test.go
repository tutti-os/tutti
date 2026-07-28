package agenthost

import (
	"context"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type liveResumeCanonicalStore struct {
	CanonicalStore
	session  storesqlite.Session
	evidence storesqlite.ProviderSessionResumeEvidence
}

func (s liveResumeCanonicalStore) GetSession(context.Context, string, string) (storesqlite.Session, bool, error) {
	return s.session, true, nil
}

func (liveResumeCanonicalStore) SessionDeleted(context.Context, string, string) (bool, error) {
	return false, nil
}

func (s liveResumeCanonicalStore) GetProviderSessionResumeEvidence(
	context.Context,
	string,
	string,
) (storesqlite.ProviderSessionResumeEvidence, error) {
	return s.evidence, nil
}

type liveResumeRuntime struct {
	RuntimeController
	session ProviderRuntimeSession
}

func (r liveResumeRuntime) Session(workspaceID, sessionID string) (ProviderRuntimeSession, bool) {
	return r.session, workspaceID == r.session.WorkspaceID && sessionID == r.session.ID
}

func TestEnsureRuntimeSessionPreservesLiveResumableObservation(t *testing.T) {
	store := liveResumeCanonicalStore{session: storesqlite.Session{
		ID: "session-1", WorkspaceID: "workspace-1", Kind: storesqlite.SessionKindRoot,
		Provider: "codex", ProviderSessionID: "provider-session-1",
	}}
	runtime := liveResumeRuntime{session: ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "workspace-1", Provider: "codex",
		ProviderSessionID: "provider-session-1", Resumable: true,
	}}
	host := New(Config{CanonicalStore: store, Runtime: runtime})

	session, err := host.EnsureRuntimeSession(t.Context(), SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatalf("EnsureRuntimeSession() error = %v", err)
	}
	if !session.Resumable {
		t.Fatal("EnsureRuntimeSession() discarded live resumable observation")
	}
}
