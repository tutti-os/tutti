package agent

import (
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func TestPersistedChildSessionCannotResumeIndependently(t *testing.T) {
	t.Parallel()
	runtime := &fakeRuntime{}
	service := newIsolatedAgentService(runtime)
	child := PersistedSession{
		Kind:     agentactivitybiz.SessionKindChild,
		Provider: "codex",
	}
	if service.persistedSessionCanResume(t.Context(), child) {
		t.Fatal("child session resumable = true, want root runtime routing only")
	}
	root := PersistedSession{
		Kind:     agentactivitybiz.SessionKindRoot,
		Provider: "codex",
	}
	if !service.persistedSessionCanResume(t.Context(), root) {
		t.Fatal("root session resumable = false, want provider resume capability")
	}
}

func TestSessionFromPersistedPreservesRailPlacement(t *testing.T) {
	t.Parallel()

	session := sessionFromPersisted(PersistedSession{
		ID:              "session-1",
		Kind:            agentactivitybiz.SessionKindRoot,
		MessageVersion:  17,
		Provider:        "codex",
		RailSectionKind: " project ",
		RailProjectPath: " /workspace/repo-1 ",
		RailSectionKey:  " project:repo-1 ",
	}, false)

	if session.RailSectionKind != "project" ||
		session.RailProjectPath != "/workspace/repo-1" ||
		session.RailSectionKey != "project:repo-1" {
		t.Fatalf("rail placement = %#v", session)
	}
	if session.MessageVersion != 17 {
		t.Fatalf("message version = %d, want 17", session.MessageVersion)
	}
}

func TestPersistedSessionFromActivityPreservesMessageVersion(t *testing.T) {
	t.Parallel()

	session := persistedSessionFromActivity(agentactivitybiz.Session{
		ID: "session-1", WorkspaceID: "workspace-1", MessageVersion: 23,
		RailSectionKind: "project", RailProjectPath: "/workspace/repo-1", RailSectionKey: "project:repo-1",
	})

	if session.MessageVersion != 23 {
		t.Fatalf("message version = %d, want 23", session.MessageVersion)
	}
	if session.RailSectionKind != "project" ||
		session.RailProjectPath != "/workspace/repo-1" ||
		session.RailSectionKey != "project:repo-1" {
		t.Fatalf("rail placement = %#v", session)
	}
}

func TestServiceSessionResponseMergesPersistedRailPlacement(t *testing.T) {
	t.Parallel()

	session := serviceSessionWithPersistedFreshness(
		ProviderRuntimeSession{ID: "session-1", WorkspaceID: "workspace-1", Provider: "codex"},
		PersistedSession{
			ID:              "session-1",
			WorkspaceID:     "workspace-1",
			MessageVersion:  19,
			Provider:        "codex",
			RailSectionKind: "project",
			RailProjectPath: "/workspace/repo-1",
			RailSectionKey:  "project:repo-1",
		},
		false,
	)

	if session.RailSectionKind != "project" ||
		session.RailProjectPath != "/workspace/repo-1" ||
		session.RailSectionKey != "project:repo-1" {
		t.Fatalf("rail placement = %#v", session)
	}
	if session.MessageVersion != 19 {
		t.Fatalf("message version = %d, want 19", session.MessageVersion)
	}
}
