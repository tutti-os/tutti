package agent

import (
	"context"
	"testing"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	tuttimodeactivationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
)

func TestUpdateTitleReturnsCanonicalTuttiModeActivationProjection(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:              "session-1",
		WorkspaceID:     "ws-1",
		Provider:        "codex",
		Cwd:             "/workspace",
		Status:          "ready",
		Title:           "Old runtime title",
		CreatedAtUnixMS: 1,
		UpdatedAtUnixMS: 10,
	}
	service := newIsolatedAgentService(runtime)
	service.SessionReader = &fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:              "session-1",
				WorkspaceID:     "ws-1",
				Provider:        "codex",
				Cwd:             "/workspace",
				Title:           "Old persisted title",
				CreatedAtUnixMS: 1,
				UpdatedAtUnixMS: 10,
			},
		},
	}
	service.TuttiModeActivations = &fakeTuttiModeActivationCoordinator{
		activation: canonicalResponseActivation("ws-1", "session-1"),
	}

	session, err := service.UpdateTitle(context.Background(), "ws-1", "session-1", "Renamed session")
	if err != nil {
		t.Fatalf("UpdateTitle() error = %v", err)
	}
	assertCanonicalResponseActivation(t, session)
}

func TestUpdateVisibleReturnsCanonicalTuttiModeActivationProjection(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:              "session-1",
		WorkspaceID:     "ws-1",
		Provider:        "codex",
		Cwd:             "/workspace",
		Status:          "ready",
		CreatedAtUnixMS: 1,
		UpdatedAtUnixMS: 10,
	}
	service := newIsolatedAgentService(runtime)
	service.TuttiModeActivations = &fakeTuttiModeActivationCoordinator{
		activation: canonicalResponseActivation("ws-1", "session-1"),
	}

	session, err := service.UpdateVisible(context.Background(), "ws-1", "session-1", true)
	if err != nil {
		t.Fatalf("UpdateVisible() error = %v", err)
	}
	assertCanonicalResponseActivation(t, session)
}

func TestUpdatePinWithoutLiveRuntimeReturnsCanonicalSessionProjection(t *testing.T) {
	runtime := newFakeRuntime()
	reader := &pinUpdateSessionReader{
		fakeSessionReader: &fakeSessionReader{
			sessions: map[string]PersistedSession{
				"ws-1:session-1": {
					ID:              "session-1",
					WorkspaceID:     "ws-1",
					Provider:        "codex",
					Cwd:             "/workspace",
					CreatedAtUnixMS: 1,
					UpdatedAtUnixMS: 100,
					LastEventUnixMS: 100,
					ActiveTurnID:    "turn-1",
				},
			},
		},
		updatedAtUnixMS: 200,
	}
	turn := agentactivitybiz.Turn{
		WorkspaceID:     "ws-1",
		AgentSessionID:  "session-1",
		TurnID:          "turn-1",
		Phase:           agentactivitybiz.TurnPhaseRunning,
		UpdatedAtUnixMS: 150,
	}
	service := newIsolatedAgentService(runtime)
	service.SessionReader = reader
	service.TurnStore = failingTurnStore{
		latestTurn: turn,
		session: agentactivitybiz.Session{
			ID:           "session-1",
			WorkspaceID:  "ws-1",
			ActiveTurnID: "turn-1",
		},
		turn: turn,
	}
	service.TuttiModeActivations = &fakeTuttiModeActivationCoordinator{
		activation: canonicalResponseActivation("ws-1", "session-1"),
	}

	session, err := service.UpdatePin(context.Background(), "ws-1", "session-1", true)
	if err != nil {
		t.Fatalf("UpdatePin() error = %v", err)
	}
	if session.ActiveTurnID != "turn-1" || session.ActiveTurn == nil || session.ActiveTurn.TurnID != "turn-1" {
		t.Fatalf("UpdatePin() turn projection = %#v (activeTurnId %q), want turn-1", session.ActiveTurn, session.ActiveTurnID)
	}
	assertCanonicalResponseActivation(t, session)
}

func canonicalResponseActivation(workspaceID string, sessionID string) *tuttimodeactivationbiz.Activation {
	createdAt := time.UnixMilli(100).UTC()
	return &tuttimodeactivationbiz.Activation{
		ID:             "activation-1",
		WorkspaceID:    workspaceID,
		AgentSessionID: sessionID,
		CurrentRevision: tuttimodeactivationbiz.Revision{
			ID:           "activation-revision-1",
			ActivationID: "activation-1",
			Revision:     1,
			State:        tuttimodeactivationbiz.StateActive,
			Source:       tuttimodeactivationbiz.SourceSlashCommand,
			CreatedAt:    createdAt,
		},
		CreatedAt: createdAt,
		UpdatedAt: createdAt,
	}
}

func assertCanonicalResponseActivation(t *testing.T, session Session) {
	t.Helper()
	if session.TuttiModeActivation == nil {
		t.Fatal("session TuttiModeActivation = nil, want canonical active projection")
	}
	if session.TuttiModeActivation.ID != "activation-1" ||
		session.TuttiModeActivation.CurrentRevision.ID != "activation-revision-1" ||
		session.TuttiModeActivation.CurrentRevision.State != tuttimodeactivationbiz.StateActive {
		t.Fatalf("session TuttiModeActivation = %#v, want activation-1 revision-1 active", session.TuttiModeActivation)
	}
}
