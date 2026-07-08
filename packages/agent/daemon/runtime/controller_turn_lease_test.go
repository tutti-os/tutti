package agentruntime

import (
	"context"
	"testing"
	"time"
)

// touchActiveTurn renews the lease bookkeeping used for stale-turn
// detection; it must not be confused with clearing or canceling the turn.
func TestTouchActiveTurnRenewsWithoutClearing(t *testing.T) {
	t.Parallel()

	controller := NewController(nil, nil)
	session := Session{
		RoomID:         "room-1",
		AgentSessionID: "agent-1",
		Provider:       ProviderClaudeCode,
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	staleRenewedAt := unixMS(time.Now().Add(-time.Hour))
	controller.mu.Lock()
	controller.turns[key] = activeTurn{turnID: "turn-1", renewedAtUnixMS: staleRenewedAt}
	controller.mu.Unlock()

	controller.touchActiveTurn(session.RoomID, session.AgentSessionID)

	controller.mu.Lock()
	active, ok := controller.turns[key]
	controller.mu.Unlock()
	if !ok {
		t.Fatal("touchActiveTurn must not remove the active turn record")
	}
	if active.renewedAtUnixMS <= staleRenewedAt {
		t.Fatalf("renewedAtUnixMS = %d, want newer than %d", active.renewedAtUnixMS, staleRenewedAt)
	}
}

// DetectStaleActiveTurns is observation-only: it must report a stale record
// without canceling or clearing it, and a submit against that session must
// still be rejected with ErrSessionActiveTurn afterward (no silent
// preemption of a turn that might still be legitimately in progress, e.g.
// waiting on a slow tool call or a human approval).
func TestDetectStaleActiveTurnsDoesNotReclaim(t *testing.T) {
	t.Parallel()

	controller := NewController(nil, nil)
	session := Session{
		RoomID:         "room-1",
		AgentSessionID: "agent-1",
		Provider:       ProviderClaudeCode,
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	controller.mu.Lock()
	controller.sessions[key] = session
	controller.turns[key] = activeTurn{
		turnID:          "stale-turn",
		renewedAtUnixMS: unixMS(time.Now().Add(-20 * time.Minute)),
	}
	controller.mu.Unlock()

	stale := controller.DetectStaleActiveTurns(15 * time.Minute)
	if len(stale) != 1 {
		t.Fatalf("stale turns = %d, want 1", len(stale))
	}
	if stale[0].TurnID != "stale-turn" || stale[0].AgentSessionID != "agent-1" {
		t.Fatalf("stale turn = %#v, want turn-1/agent-1", stale[0])
	}

	// Still present: detection must not clear the record.
	controller.mu.Lock()
	_, ok := controller.turns[key]
	controller.mu.Unlock()
	if !ok {
		t.Fatal("DetectStaleActiveTurns cleared the active turn record; it must only observe")
	}

	// A fresh submit against the same session must still be rejected: no
	// automatic preemption happens as a side effect of detection.
	_, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := controller.beginTurn(session, "turn-new", cancel); err != ErrSessionActiveTurn {
		t.Fatalf("beginTurn after detection = %v, want ErrSessionActiveTurn", err)
	}
}

func TestDetectStaleActiveTurnsIgnoresRecentTurns(t *testing.T) {
	t.Parallel()

	controller := NewController(nil, nil)
	session := Session{RoomID: "room-1", AgentSessionID: "agent-1", Provider: ProviderClaudeCode}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	controller.mu.Lock()
	controller.sessions[key] = session
	controller.turns[key] = activeTurn{turnID: "turn-1", renewedAtUnixMS: unixMS(time.Now())}
	controller.mu.Unlock()

	if stale := controller.DetectStaleActiveTurns(15 * time.Minute); len(stale) != 0 {
		t.Fatalf("stale turns = %#v, want none for a recently renewed turn", stale)
	}
}
