package agent

import (
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func TestPersistedChildSessionCannotResumeIndependently(t *testing.T) {
	t.Parallel()
	runtime := &fakeRuntime{}
	child := PersistedSession{
		Kind:     agentactivitybiz.SessionKindChild,
		Provider: "codex",
	}
	if persistedSessionCanResume(runtime, child) {
		t.Fatal("child session resumable = true, want root runtime routing only")
	}
	root := PersistedSession{
		Kind:     agentactivitybiz.SessionKindRoot,
		Provider: "codex",
	}
	if !persistedSessionCanResume(runtime, root) {
		t.Fatal("root session resumable = false, want provider resume capability")
	}
}

func TestSessionFromPersistedPreservesRailSectionKey(t *testing.T) {
	t.Parallel()

	session := sessionFromPersisted(PersistedSession{
		ID:             "session-1",
		Kind:           agentactivitybiz.SessionKindRoot,
		Provider:       "codex",
		RailSectionKey: " project:repo-1 ",
	}, false)

	if session.RailSectionKey != "project:repo-1" {
		t.Fatalf("rail section key = %q, want project:repo-1", session.RailSectionKey)
	}
}

func TestServiceSessionResponseMergesPersistedRailSectionKey(t *testing.T) {
	t.Parallel()

	session := serviceSessionWithPersistedFreshness(
		ProviderRuntimeSession{ID: "session-1", WorkspaceID: "workspace-1", Provider: "codex"},
		PersistedSession{
			ID:             "session-1",
			WorkspaceID:    "workspace-1",
			Provider:       "codex",
			RailSectionKey: "project:repo-1",
		},
		false,
	)

	if session.RailSectionKey != "project:repo-1" {
		t.Fatalf("rail section key = %q, want project:repo-1", session.RailSectionKey)
	}
}
