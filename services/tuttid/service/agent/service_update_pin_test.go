package agent

import (
	"context"
	"testing"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func TestServiceUpdatePinReturnsFreshPersistedVersionAndLiveTurn(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:              "session-1",
		WorkspaceID:     "ws-1",
		Provider:        "codex",
		Cwd:             "/workspace",
		Status:          "working",
		CreatedAtUnixMS: 1,
		UpdatedAtUnixMS: 100,
	}
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
					PinnedAtUnixMS:  0,
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

	session, err := service.UpdatePin(context.Background(), "ws-1", "session-1", true)
	if err != nil {
		t.Fatalf("UpdatePin returned error: %v", err)
	}
	if session.PinnedAtUnixMS != 200 {
		t.Fatalf("UpdatePin pinnedAtUnixMS = %d, want 200", session.PinnedAtUnixMS)
	}
	if session.UpdatedAt == nil || session.UpdatedAt.UnixMilli() != 200 {
		t.Fatalf("UpdatePin updatedAt = %v, want persisted update timestamp 200", session.UpdatedAt)
	}
	if session.ActiveTurnID != "turn-1" || session.ActiveTurn == nil || session.ActiveTurn.TurnID != "turn-1" {
		t.Fatalf("UpdatePin active turn = %#v id=%q, want turn-1", session.ActiveTurn, session.ActiveTurnID)
	}

	reader.updatedAtUnixMS = 250
	session, err = service.UpdatePin(context.Background(), "ws-1", "session-1", false)
	if err != nil {
		t.Fatalf("UpdatePin(unpin) returned error: %v", err)
	}
	if session.PinnedAtUnixMS != 0 || session.UpdatedAt == nil || session.UpdatedAt.UnixMilli() != 250 {
		t.Fatalf("UpdatePin(unpin) session = %#v, want unpinned at persisted version 250", session)
	}

	reconciled, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get after UpdatePin returned error: %v", err)
	}
	if reconciled.PinnedAtUnixMS != 0 || reconciled.UpdatedAt == nil || reconciled.UpdatedAt.UnixMilli() != 250 {
		t.Fatalf("Get after UpdatePin session = %#v, want unpinned at persisted version 250", reconciled)
	}
}

func TestMergePersistedSessionStateDoesNotRegressNewerRuntimeVersion(t *testing.T) {
	runtimeUpdatedAt := time.UnixMilli(300)
	session := mergePersistedSessionState(
		Session{UpdatedAt: &runtimeUpdatedAt},
		PersistedSession{UpdatedAtUnixMS: 200},
	)

	if session.UpdatedAt == nil || session.UpdatedAt.UnixMilli() != 300 {
		t.Fatalf("merged updatedAt = %v, want newer runtime timestamp 300", session.UpdatedAt)
	}
}

type pinUpdateSessionReader struct {
	*fakeSessionReader
	updatedAtUnixMS int64
}

func (r *pinUpdateSessionReader) UpdateSessionPinned(
	_ context.Context,
	workspaceID string,
	agentSessionID string,
	pinned bool,
) (PersistedSession, bool, error) {
	key := workspaceID + ":" + agentSessionID
	session, ok := r.sessions[key]
	if !ok {
		return PersistedSession{}, false, nil
	}
	session.PinnedAtUnixMS = 0
	if pinned {
		session.PinnedAtUnixMS = r.updatedAtUnixMS
	}
	session.UpdatedAtUnixMS = r.updatedAtUnixMS
	r.sessions[key] = session
	return session, true, nil
}
