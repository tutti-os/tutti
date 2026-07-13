package projection

import "testing"

func TestProjectSessionStateMergesExistingSnapshot(t *testing.T) {
	existing := SessionSnapshot{
		WorkspaceID:       "ws-1",
		AgentSessionID:    "session-1",
		Origin:            "runtime",
		Provider:          "codex",
		ProviderSessionID: "provider-session-1",
		Model:             "gpt-old",
		CWD:               "/workspace",
		Title:             "Existing",
		Status:            "running",
		CurrentPhase:      "working",
		LastError:         "kept",
		MessageVersion:    7,
		LastEventUnixMS:   120,
		StartedAtUnixMS:   90,
		EndedAtUnixMS:     0,
		CreatedAtUnixMS:   80,
		UpdatedAtUnixMS:   100,
	}

	projected := ProjectSessionState(existing, true, SessionStateReport{
		WorkspaceID:      "ws-1",
		AgentSessionID:   "session-1",
		Title:            "Updated",
		Status:           "completed",
		OccurredAtUnixMS: 125,
		StartedAtUnixMS:  95,
		EndedAtUnixMS:    130,
	}, 140)

	if !projected.Accepted {
		t.Fatal("Accepted = false, want true")
	}
	session := projected.Session
	if session.Provider != "codex" || session.ProviderSessionID != "provider-session-1" {
		t.Fatalf("provider fields = %q/%q, want existing values", session.Provider, session.ProviderSessionID)
	}
	if session.Title != "Updated" || session.Status != "completed" {
		t.Fatalf("updated fields = %q/%q, want incoming values", session.Title, session.Status)
	}
	if session.LastEventUnixMS != 125 {
		t.Fatalf("LastEventUnixMS = %d, want incoming 125", session.LastEventUnixMS)
	}
	if session.StartedAtUnixMS != 90 || session.EndedAtUnixMS != 130 {
		t.Fatalf("times = started %d ended %d, want 90/130", session.StartedAtUnixMS, session.EndedAtUnixMS)
	}
	if session.CreatedAtUnixMS != 80 || session.UpdatedAtUnixMS != 140 {
		t.Fatalf("storage times = created %d updated %d, want 80/140", session.CreatedAtUnixMS, session.UpdatedAtUnixMS)
	}
	if session.MessageVersion != 7 || session.LastError != "kept" {
		t.Fatalf("retained fields = version %d error %q, want 7/kept", session.MessageVersion, session.LastError)
	}
}

func TestProjectSessionStateRejectsDeletedSnapshot(t *testing.T) {
	existing := SessionSnapshot{
		WorkspaceID:     "ws-1",
		AgentSessionID:  "session-1",
		DeletedAtUnixMS: 100,
	}

	projected := ProjectSessionState(existing, true, SessionStateReport{
		WorkspaceID:      "ws-1",
		AgentSessionID:   "session-1",
		Status:           "completed",
		OccurredAtUnixMS: 120,
	}, 130)

	if projected.Accepted {
		t.Fatal("Accepted = true, want false")
	}
	if projected.LastEventUnixMS != 120 {
		t.Fatalf("LastEventUnixMS = %d, want 120", projected.LastEventUnixMS)
	}
}

func TestProjectSessionStateKeepsCompletedStateAfterLateWorkingPatch(t *testing.T) {
	existing := SessionSnapshot{
		WorkspaceID:     "ws-1",
		AgentSessionID:  "session-1",
		Status:          "completed",
		CurrentPhase:    "idle",
		LastEventUnixMS: 200,
		StartedAtUnixMS: 100,
		EndedAtUnixMS:   200,
		CreatedAtUnixMS: 90,
		UpdatedAtUnixMS: 200,
	}

	projected := ProjectSessionState(existing, true, SessionStateReport{
		WorkspaceID:      "ws-1",
		AgentSessionID:   "session-1",
		Status:           "active",
		CurrentPhase:     "working",
		OccurredAtUnixMS: 150,
		StartedAtUnixMS:  100,
	}, 250)

	if !projected.Accepted {
		t.Fatal("Accepted = false, want true")
	}
	session := projected.Session
	if session.Status != "completed" || session.CurrentPhase != "idle" {
		t.Fatalf("runtime state = %q/%q, want completed/idle", session.Status, session.CurrentPhase)
	}
	if session.LastEventUnixMS != 200 || session.EndedAtUnixMS != 200 {
		t.Fatalf("times = last event %d ended %d, want 200/200", session.LastEventUnixMS, session.EndedAtUnixMS)
	}
}

func TestProjectSessionStateKeepsRuntimeFieldsFromNewerState(t *testing.T) {
	existing := SessionSnapshot{
		WorkspaceID:     "ws-1",
		AgentSessionID:  "session-1",
		Title:           "Existing",
		Status:          "active",
		CurrentPhase:    "waiting_input",
		LastEventUnixMS: 200,
		CreatedAtUnixMS: 90,
		UpdatedAtUnixMS: 200,
	}

	projected := ProjectSessionState(existing, true, SessionStateReport{
		WorkspaceID:      "ws-1",
		AgentSessionID:   "session-1",
		Title:            "Updated title",
		Status:           "active",
		CurrentPhase:     "working",
		OccurredAtUnixMS: 150,
	}, 250)

	session := projected.Session
	if session.Status != "active" || session.CurrentPhase != "waiting_input" {
		t.Fatalf("runtime state = %q/%q, want active/waiting_input", session.Status, session.CurrentPhase)
	}
	if session.Title != "Updated title" {
		t.Fatalf("Title = %q, want metadata from incoming patch", session.Title)
	}
	if session.LastEventUnixMS != 200 {
		t.Fatalf("LastEventUnixMS = %d, want existing max 200", session.LastEventUnixMS)
	}
}

func TestProjectSessionStateKeepsTerminalStateAfterLaterNonTerminalPatch(t *testing.T) {
	existing := SessionSnapshot{
		WorkspaceID:     "ws-1",
		AgentSessionID:  "session-1",
		Status:          "canceled",
		CurrentPhase:    "idle",
		LastEventUnixMS: 100,
		EndedAtUnixMS:   100,
		CreatedAtUnixMS: 90,
		UpdatedAtUnixMS: 100,
	}

	projected := ProjectSessionState(existing, true, SessionStateReport{
		WorkspaceID:      "ws-1",
		AgentSessionID:   "session-1",
		Status:           "active",
		CurrentPhase:     "working",
		OccurredAtUnixMS: 150,
	}, 200)

	session := projected.Session
	if session.Status != "canceled" || session.CurrentPhase != "idle" {
		t.Fatalf("runtime state = %q/%q, want canceled/idle", session.Status, session.CurrentPhase)
	}
	if session.LastEventUnixMS != 150 {
		t.Fatalf("LastEventUnixMS = %d, want newer event 150", session.LastEventUnixMS)
	}
}

func TestProjectSessionStateKeepsFirstTerminalStateAfterLaterTerminalPatch(t *testing.T) {
	existing := SessionSnapshot{
		WorkspaceID:     "ws-1",
		AgentSessionID:  "session-1",
		Status:          "failed",
		CurrentPhase:    "failed",
		LastEventUnixMS: 100,
		EndedAtUnixMS:   100,
		CreatedAtUnixMS: 90,
		UpdatedAtUnixMS: 100,
	}

	projected := ProjectSessionState(existing, true, SessionStateReport{
		WorkspaceID:      "ws-1",
		AgentSessionID:   "session-1",
		Status:           "canceled",
		CurrentPhase:     "idle",
		OccurredAtUnixMS: 150,
	}, 200)

	session := projected.Session
	if session.Status != "failed" || session.CurrentPhase != "failed" {
		t.Fatalf("runtime state = %q/%q, want failed/failed", session.Status, session.CurrentPhase)
	}
	if session.LastEventUnixMS != 150 {
		t.Fatalf("LastEventUnixMS = %d, want newer event 150", session.LastEventUnixMS)
	}
}

// TestProjectSessionStateRecoversAfterTurnFailureWhenSessionStaysActive covers
// the regression where a session's badge got stuck on "failed" forever after
// one turn errored, even once a later turn on the *same* session started
// working. Unlike a real session-level termination (status
// completed/failed/canceled — see the two tests above, which must keep
// freezing), a single failed turn leaves the session's own lifecycle status
// "active" (only currentPhase reflects the failed turn), so a later turn
// starting must be allowed to move currentPhase forward again.
func TestProjectSessionStateRecoversAfterTurnFailureWhenSessionStaysActive(t *testing.T) {
	existing := SessionSnapshot{
		WorkspaceID:     "ws-1",
		AgentSessionID:  "session-1",
		Status:          "active",
		CurrentPhase:    "failed",
		LastEventUnixMS: 100,
		CreatedAtUnixMS: 90,
		UpdatedAtUnixMS: 100,
	}

	projected := ProjectSessionState(existing, true, SessionStateReport{
		WorkspaceID:      "ws-1",
		AgentSessionID:   "session-1",
		Status:           "active",
		CurrentPhase:     "working",
		OccurredAtUnixMS: 150,
	}, 200)

	session := projected.Session
	if session.Status != "active" || session.CurrentPhase != "working" {
		t.Fatalf("runtime state = %q/%q, want active/working (new turn must clear the stale failed phase)", session.Status, session.CurrentPhase)
	}
	if session.LastEventUnixMS != 150 {
		t.Fatalf("LastEventUnixMS = %d, want newer event 150", session.LastEventUnixMS)
	}
}

// TestProjectSessionStateClearsFailedPhaseAfterLaterTurnCompletes is the
// end-to-end sequence from the bug report: a turn fails, then a later turn on
// the same session completes successfully. The session's status/phase must
// reflect that later success, not remain stuck on the earlier failure.
func TestProjectSessionStateClearsFailedPhaseAfterLaterTurnCompletes(t *testing.T) {
	failed := ProjectSessionState(SessionSnapshot{
		WorkspaceID:     "ws-1",
		AgentSessionID:  "session-1",
		Status:          "active",
		CurrentPhase:    "idle",
		LastEventUnixMS: 50,
		CreatedAtUnixMS: 10,
		UpdatedAtUnixMS: 50,
	}, true, SessionStateReport{
		WorkspaceID:      "ws-1",
		AgentSessionID:   "session-1",
		Status:           "active",
		CurrentPhase:     "failed",
		OccurredAtUnixMS: 100,
	}, 110)

	if failed.Session.Status != "active" || failed.Session.CurrentPhase != "failed" {
		t.Fatalf("after turn failure = %q/%q, want active/failed", failed.Session.Status, failed.Session.CurrentPhase)
	}

	recovered := ProjectSessionState(failed.Session, true, SessionStateReport{
		WorkspaceID:      "ws-1",
		AgentSessionID:   "session-1",
		Status:           "active",
		CurrentPhase:     "idle",
		OccurredAtUnixMS: 200,
	}, 210)

	session := recovered.Session
	if session.Status != "active" || session.CurrentPhase != "idle" {
		t.Fatalf("runtime state after later successful turn = %q/%q, want active/idle, not stuck failed", session.Status, session.CurrentPhase)
	}
}

func TestProjectMessageUpdateMergesPayloadAndProtectsTerminalStatus(t *testing.T) {
	existing := MessageSnapshot{
		ID:                3,
		AgentSessionID:    "session-1",
		MessageID:         "message-1",
		Version:           4,
		TurnID:            "turn-1",
		Role:              "assistant",
		Kind:              "text",
		Status:            "completed",
		Payload:           map[string]any{"text": "hel", "nested": map[string]any{"a": "b"}},
		OccurredAtUnixMS:  120,
		StartedAtUnixMS:   90,
		CompletedAtUnixMS: 130,
		CreatedAtUnixMS:   80,
		UpdatedAtUnixMS:   100,
	}

	message, ok := ProjectMessageUpdate(existing, true, MessageUpdate{
		MessageID:         "message-1",
		Status:            "running",
		ContentDelta:      "lo",
		Payload:           map[string]any{"nested": map[string]any{"c": "d"}},
		OccurredAtUnixMS:  110,
		StartedAtUnixMS:   95,
		CompletedAtUnixMS: 125,
	}, 5, 150)
	if !ok {
		t.Fatal("ok = false, want true")
	}
	if message.Status != "completed" {
		t.Fatalf("Status = %q, want terminal completed", message.Status)
	}
	if message.Payload["text"] != "hello" {
		t.Fatalf("text payload = %#v, want hello", message.Payload["text"])
	}
	nested, ok := message.Payload["nested"].(map[string]any)
	if !ok || nested["a"] != "b" || nested["c"] != "d" {
		t.Fatalf("nested payload = %#v, want merged map", message.Payload["nested"])
	}
	if message.OccurredAtUnixMS != 120 || message.StartedAtUnixMS != 90 || message.CompletedAtUnixMS != 130 {
		t.Fatalf("times = %d/%d/%d, want 120/90/130", message.OccurredAtUnixMS, message.StartedAtUnixMS, message.CompletedAtUnixMS)
	}
	if message.Version != 5 || message.CreatedAtUnixMS != 80 || message.UpdatedAtUnixMS != 150 {
		t.Fatalf("version/storage times = %d/%d/%d, want 5/80/150", message.Version, message.CreatedAtUnixMS, message.UpdatedAtUnixMS)
	}
}

func TestProjectMessageUpdateAllowsSessionScopedMessageWithoutTurn(t *testing.T) {
	message, ok := ProjectMessageUpdate(MessageSnapshot{}, false, MessageUpdate{
		MessageID:        "imported-message-1",
		Role:             "user",
		Kind:             "text",
		Payload:          map[string]any{"text": "historical import"},
		OccurredAtUnixMS: 100,
	}, 1, 100)
	if !ok {
		t.Fatal("ok = false, want session-scoped message accepted")
	}
	if message.TurnID != "" {
		t.Fatalf("TurnID = %q, want no synthetic turn", message.TurnID)
	}
}

func TestProjectMessageUpdateClearsStaleToolErrorOnCompletion(t *testing.T) {
	existing := MessageSnapshot{
		ID:                3,
		AgentSessionID:    "session-1",
		MessageID:         "tool-1",
		Version:           4,
		TurnID:            "turn-1",
		Role:              "assistant",
		Kind:              "tool_call",
		Status:            "failed",
		Payload:           map[string]any{"error": map[string]any{"message": "request interrupted"}, "input": map[string]any{"toolName": "Read"}},
		OccurredAtUnixMS:  120,
		StartedAtUnixMS:   90,
		CompletedAtUnixMS: 130,
		CreatedAtUnixMS:   80,
		UpdatedAtUnixMS:   100,
	}

	message, ok := ProjectMessageUpdate(existing, true, MessageUpdate{
		MessageID:         "tool-1",
		Status:            "completed",
		Payload:           map[string]any{"output": map[string]any{"text": "done"}},
		CompletedAtUnixMS: 140,
	}, 5, 150)
	if !ok {
		t.Fatal("ok = false, want true")
	}
	if message.Status != "completed" {
		t.Fatalf("Status = %q, want completed", message.Status)
	}
	if _, ok := message.Payload["error"]; ok {
		t.Fatalf("payload = %#v, want stale error cleared", message.Payload)
	}
	if got := message.Payload["output"].(map[string]any)["text"]; got != "done" {
		t.Fatalf("payload = %#v, want completed output", message.Payload)
	}
	if got := message.Payload["input"].(map[string]any)["toolName"]; got != "Read" {
		t.Fatalf("payload = %#v, want existing input preserved", message.Payload)
	}
}

func TestProjectMessageUpdateNormalizesMissingOccurredAt(t *testing.T) {
	message, ok := ProjectMessageUpdate(MessageSnapshot{}, false, MessageUpdate{
		MessageID: "message-1",
		TurnID:    "turn-1",
		Role:      "assistant",
		Kind:      "text",
		Payload:   map[string]any{"text": "hello"},
	}, 1, 150)
	if !ok {
		t.Fatal("ok = false, want true")
	}
	if message.OccurredAtUnixMS != 150 {
		t.Fatalf("OccurredAtUnixMS = %d, want now fallback 150", message.OccurredAtUnixMS)
	}
}

func TestProjectMessageUpdatePreservesExistingTurnWhenUpdateOmitsIt(t *testing.T) {
	existing := MessageSnapshot{
		ID:               7,
		AgentSessionID:   "session-1",
		MessageID:        "message-1",
		Version:          1,
		TurnID:           "turn-1",
		Role:             "assistant",
		Kind:             "text",
		Payload:          map[string]any{"text": "hel"},
		OccurredAtUnixMS: 120,
		CreatedAtUnixMS:  100,
		UpdatedAtUnixMS:  100,
	}
	message, ok := ProjectMessageUpdate(existing, true, MessageUpdate{
		MessageID:    "message-1",
		ContentDelta: "lo",
	}, 2, 160)
	if !ok {
		t.Fatal("ok = false, want true")
	}
	if message.TurnID != "turn-1" {
		t.Fatalf("TurnID = %q, want existing turn", message.TurnID)
	}
	if message.OccurredAtUnixMS != 120 {
		t.Fatalf("OccurredAtUnixMS = %d, want existing occurred time", message.OccurredAtUnixMS)
	}
}

func TestProjectMessageUpdateRejectsExistingMessageTurnChange(t *testing.T) {
	existing := MessageSnapshot{
		ID:               7,
		AgentSessionID:   "session-1",
		MessageID:        "message-1",
		Version:          1,
		TurnID:           "turn-1",
		Role:             "assistant",
		Kind:             "text",
		Payload:          map[string]any{"text": "hello"},
		OccurredAtUnixMS: 120,
		CreatedAtUnixMS:  100,
		UpdatedAtUnixMS:  100,
	}
	message, ok := ProjectMessageUpdate(existing, true, MessageUpdate{
		MessageID: "message-1",
		TurnID:    "turn-2",
		Status:    "completed",
	}, 2, 160)

	if ok {
		t.Fatalf("ok = true with message %#v, want false", message)
	}
}

func TestCanonicalSessionStatus(t *testing.T) {
	tests := []struct {
		name      string
		lifecycle string
		phase     string
		want      string
	}{
		{name: "completed lifecycle wins", lifecycle: "completed", phase: "working", want: "completed"},
		{name: "failed lifecycle wins", lifecycle: "failed", phase: "idle", want: "failed"},
		{name: "waiting phase", lifecycle: "active", phase: "waiting_input", want: "waiting"},
		{name: "working phase", lifecycle: "active", phase: "streaming", want: "working"},
		{name: "settled phase", lifecycle: "created", phase: "settled", want: "idle"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := CanonicalSessionStatus(tt.lifecycle, tt.phase); got != tt.want {
				t.Fatalf("CanonicalSessionStatus() = %q, want %q", got, tt.want)
			}
		})
	}
}
