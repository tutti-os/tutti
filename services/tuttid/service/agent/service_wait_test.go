package agent

import (
	"context"
	"testing"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

type waitRuntime struct {
	*fakeRuntime
	events            chan RuntimeStreamEvent
	subscribeStarted  chan struct{}
	unsubscribeCalled bool
}

func newWaitRuntime() *waitRuntime {
	return &waitRuntime{
		fakeRuntime:      newFakeRuntime(),
		events:           make(chan RuntimeStreamEvent),
		subscribeStarted: make(chan struct{}, 1),
	}
}

func (r *waitRuntime) Subscribe(string, string) (<-chan RuntimeStreamEvent, func(), bool) {
	select {
	case r.subscribeStarted <- struct{}{}:
	default:
	}
	return r.events, func() { r.unsubscribeCalled = true }, true
}

func (r *waitRuntime) persistedTurn(workspaceID string, sessionID string) (agentactivitybiz.Turn, bool) {
	session, ok := r.sessions[workspaceID+":"+sessionID]
	if !ok || session.TurnLifecycle == nil || session.TurnLifecycle.ActiveTurnID == nil {
		return agentactivitybiz.Turn{}, false
	}
	turnID := *session.TurnLifecycle.ActiveTurnID
	phase := session.TurnLifecycle.Phase
	switch phase {
	case "waiting_input", "waiting_approval":
		phase = agentactivitybiz.TurnPhaseWaiting
	case "preparing":
		phase = agentactivitybiz.TurnPhaseSubmitted
	}
	return agentactivitybiz.Turn{
		WorkspaceID:    workspaceID,
		AgentSessionID: sessionID,
		TurnID:         turnID,
		Phase:          phase,
	}, true
}

func (r *waitRuntime) pendingInteractions(workspaceID string, sessionID string) []agentactivitybiz.Interaction {
	turn, ok := r.persistedTurn(workspaceID, sessionID)
	if !ok || turn.Phase != agentactivitybiz.TurnPhaseWaiting {
		return nil
	}
	session := r.sessions[workspaceID+":"+sessionID]
	kind := agentactivitybiz.InteractionKindQuestion
	if session.TurnLifecycle.Phase == "waiting_approval" {
		kind = agentactivitybiz.InteractionKindApproval
	}
	return []agentactivitybiz.Interaction{{
		WorkspaceID:    workspaceID,
		AgentSessionID: sessionID,
		TurnID:         turn.TurnID,
		RequestID:      "wait-request",
		Kind:           kind,
		Status:         agentactivitybiz.InteractionStatusPending,
	}}
}

func (r *waitRuntime) GetLatestTurn(_ context.Context, workspaceID string, sessionID string) (agentactivitybiz.Turn, bool, error) {
	turn, ok := r.persistedTurn(workspaceID, sessionID)
	return turn, ok, nil
}

func (r *waitRuntime) GetTurn(_ context.Context, workspaceID string, sessionID string, turnID string) (agentactivitybiz.Turn, bool, error) {
	turn, ok := r.persistedTurn(workspaceID, sessionID)
	return turn, ok && turn.TurnID == turnID, nil
}

func (r *waitRuntime) GetSession(_ context.Context, workspaceID string, sessionID string) (agentactivitybiz.Session, bool, error) {
	turn, hasTurn := r.persistedTurn(workspaceID, sessionID)
	_, found := r.sessions[workspaceID+":"+sessionID]
	result := agentactivitybiz.Session{WorkspaceID: workspaceID, ID: sessionID}
	if hasTurn {
		result.ActiveTurnID = turn.TurnID
	}
	return result, found, nil
}

func (r *waitRuntime) ListSessionInteractions(_ context.Context, input agentactivitybiz.ListSessionInteractionsInput) ([]agentactivitybiz.Interaction, error) {
	return r.pendingInteractions(input.WorkspaceID, input.AgentSessionID), nil
}

func (r *waitRuntime) ListLatestTurns(_ context.Context, workspaceID string, sessionIDs []string) (map[string]agentactivitybiz.Turn, error) {
	result := make(map[string]agentactivitybiz.Turn)
	for _, sessionID := range sessionIDs {
		if turn, ok := r.persistedTurn(workspaceID, sessionID); ok {
			result[sessionID] = turn
		}
	}
	return result, nil
}

func (r *waitRuntime) ListLatestTurnInteractions(_ context.Context, workspaceID string, sessionIDs []string) (map[string][]agentactivitybiz.Interaction, error) {
	return r.ListPendingInteractionsBySession(context.Background(), workspaceID, sessionIDs)
}

func (r *waitRuntime) ListTurnsBySession(_ context.Context, workspaceID string, turnIDs map[string]string) (map[string]agentactivitybiz.Turn, error) {
	result := make(map[string]agentactivitybiz.Turn)
	for sessionID, turnID := range turnIDs {
		if turn, ok := r.persistedTurn(workspaceID, sessionID); ok && turn.TurnID == turnID {
			result[sessionID] = turn
		}
	}
	return result, nil
}

func (r *waitRuntime) ListPendingInteractionsBySession(_ context.Context, workspaceID string, sessionIDs []string) (map[string][]agentactivitybiz.Interaction, error) {
	result := make(map[string][]agentactivitybiz.Interaction)
	for _, sessionID := range sessionIDs {
		if interactions := r.pendingInteractions(workspaceID, sessionID); len(interactions) != 0 {
			result[sessionID] = interactions
		}
	}
	return result, nil
}

type waitMessageReader struct {
	calls []agentactivitybiz.ListSessionMessagesInput
	list  func(agentactivitybiz.ListSessionMessagesInput) (SessionMessagesPage, bool)
}

func (r *waitMessageReader) ListSessionMessages(input agentactivitybiz.ListSessionMessagesInput) (SessionMessagesPage, bool) {
	r.calls = append(r.calls, input)
	if r.list != nil {
		return r.list(input)
	}
	return SessionMessagesPage{AgentSessionID: input.AgentSessionID}, true
}

func uint64Ptr(value uint64) *uint64 {
	return &value
}

func TestWaitIgnoresStaleStopUntilNewProgressArrives(t *testing.T) {
	runtime := newWaitRuntime()
	turnID := "turn-1"
	latestVersionReads := 0
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "waiting",
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &turnID,
			Phase:        "waiting_input",
		},
		Visible:         true,
		CreatedAtUnixMS: time.Now().Add(-time.Minute).UnixMilli(),
		UpdatedAtUnixMS: time.Now().Add(-time.Second).UnixMilli(),
	}
	reader := &waitMessageReader{
		list: func(input agentactivitybiz.ListSessionMessagesInput) (SessionMessagesPage, bool) {
			switch {
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 100:
				return SessionMessagesPage{AgentSessionID: input.AgentSessionID}, true
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 1:
				latestVersionReads++
				if latestVersionReads <= 1 {
					return SessionMessagesPage{AgentSessionID: input.AgentSessionID, LatestVersion: 4}, true
				}
				return SessionMessagesPage{AgentSessionID: input.AgentSessionID, LatestVersion: 8}, true
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 20:
				return SessionMessagesPage{
					AgentSessionID: input.AgentSessionID,
					LatestVersion:  8,
					Messages: []SessionMessage{
						{AgentSessionID: input.AgentSessionID, MessageID: "assistant-2", Role: "assistant", Kind: "text", Payload: map[string]any{"content": "Second"}, Version: 8},
						{AgentSessionID: input.AgentSessionID, MessageID: "user-1", Role: "user", Kind: "text", Payload: map[string]any{"content": "Ignore"}, Version: 7},
						{AgentSessionID: input.AgentSessionID, MessageID: "assistant-1", Role: "assistant", Kind: "text", Payload: map[string]any{"content": "First"}, Version: 6},
					},
				}, true
			default:
				t.Fatalf("unexpected ListSessionMessages input: %#v", input)
				return SessionMessagesPage{}, false
			}
		},
	}
	service := newIsolatedAgentService(runtime)
	service.TurnStore = runtime
	service.MessageReader = reader

	waitDone := make(chan WaitResult, 1)
	waitErr := make(chan error, 1)
	go func() {
		result, err := service.Wait(context.Background(), WaitInput{
			WorkspaceID:    "ws-1",
			AgentSessionID: "session-1",
			AfterVersion:   uint64Ptr(4),
			MessageLimit:   2,
			Timeout:        2 * time.Second,
		})
		if err != nil {
			waitErr <- err
			return
		}
		waitDone <- result
	}()

	<-runtime.subscribeStarted
	select {
	case err := <-waitErr:
		t.Fatalf("Wait() error = %v", err)
	case result := <-waitDone:
		t.Fatalf("Wait() returned stale stop result: %#v", result)
	case <-time.After(30 * time.Millisecond):
	}

	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "working",
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &turnID,
			Phase:        "running",
		},
		Visible:         true,
		CreatedAtUnixMS: time.Now().Add(-time.Minute).UnixMilli(),
		UpdatedAtUnixMS: time.Now().UnixMilli(),
	}
	runtime.events <- RuntimeStreamEvent{EventType: "state_patch"}

	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "waiting",
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &turnID,
			Phase:        "waiting_input",
		},
		Visible:         true,
		CreatedAtUnixMS: time.Now().Add(-time.Minute).UnixMilli(),
		UpdatedAtUnixMS: time.Now().Add(10 * time.Millisecond).UnixMilli(),
	}
	runtime.events <- RuntimeStreamEvent{EventType: "state_patch"}
	close(runtime.events)

	select {
	case err := <-waitErr:
		t.Fatalf("Wait() error = %v", err)
	case result := <-waitDone:
		if result.Reason != WaitReasonWaitingInput {
			t.Fatalf("reason = %q, want %q", result.Reason, WaitReasonWaitingInput)
		}
		if result.EffectiveAfter != 4 || result.LatestVersion != 8 {
			t.Fatalf("versions = after %d latest %d, want 4/8", result.EffectiveAfter, result.LatestVersion)
		}
		if len(result.Messages) != 2 {
			t.Fatalf("messages = %#v", result.Messages)
		}
		if result.Messages[0].MessageID != "assistant-1" || result.Messages[1].MessageID != "assistant-2" {
			t.Fatalf("messages = %#v, want chronological assistant tail", result.Messages)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Wait() did not return after new stop point")
	}
	if !runtime.unsubscribeCalled {
		t.Fatalf("unsubscribe not called")
	}
}

func TestWaitTreatsCreatedSessionAsReady(t *testing.T) {
	runtime := newWaitRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:              "session-1",
		WorkspaceID:     "ws-1",
		Provider:        "codex",
		Status:          "ready",
		Visible:         true,
		CreatedAtUnixMS: time.Now().Add(-time.Minute).UnixMilli(),
		UpdatedAtUnixMS: time.Now().Add(-time.Second).UnixMilli(),
	}
	reader := &waitMessageReader{
		list: func(input agentactivitybiz.ListSessionMessagesInput) (SessionMessagesPage, bool) {
			switch {
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 100:
				return SessionMessagesPage{AgentSessionID: input.AgentSessionID}, true
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 1:
				return SessionMessagesPage{AgentSessionID: input.AgentSessionID, LatestVersion: 3}, true
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 20:
				return SessionMessagesPage{AgentSessionID: input.AgentSessionID, LatestVersion: 3}, true
			default:
				t.Fatalf("unexpected ListSessionMessages input: %#v", input)
				return SessionMessagesPage{}, false
			}
		},
	}
	service := newIsolatedAgentService(runtime)
	service.TurnStore = runtime
	service.MessageReader = reader

	result, err := service.Wait(context.Background(), WaitInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if result.Reason != WaitReasonReady {
		t.Fatalf("reason = %q, want %q", result.Reason, WaitReasonReady)
	}
}

func TestWaitHasMoreTracksFilteredExecutionMessages(t *testing.T) {
	runtime := newWaitRuntime()
	turnID := "turn-1"
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "working",
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &turnID,
			Phase:        "running",
		},
		Visible:         true,
		CreatedAtUnixMS: time.Now().Add(-time.Minute).UnixMilli(),
		UpdatedAtUnixMS: time.Now().Add(-time.Second).UnixMilli(),
	}
	reader := &waitMessageReader{
		list: func(input agentactivitybiz.ListSessionMessagesInput) (SessionMessagesPage, bool) {
			switch {
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 100:
				return SessionMessagesPage{AgentSessionID: input.AgentSessionID}, true
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 1:
				return SessionMessagesPage{AgentSessionID: input.AgentSessionID, LatestVersion: 11}, true
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 20 && input.BeforeVersion == 0:
				return SessionMessagesPage{
					AgentSessionID: input.AgentSessionID,
					LatestVersion:  11,
					HasMore:        true,
					Messages: []SessionMessage{
						{AgentSessionID: input.AgentSessionID, MessageID: "assistant-1", Role: "assistant", Kind: "text", Payload: map[string]any{"content": "Only relevant"}, Version: 11},
						{AgentSessionID: input.AgentSessionID, MessageID: "user-1", Role: "user", Kind: "text", Payload: map[string]any{"content": "Ignore"}, Version: 10},
					},
				}, true
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 20 && input.BeforeVersion == 10:
				return SessionMessagesPage{
					AgentSessionID: input.AgentSessionID,
					LatestVersion:  11,
					HasMore:        false,
					Messages: []SessionMessage{
						{AgentSessionID: input.AgentSessionID, MessageID: "user-2", Role: "user", Kind: "text", Payload: map[string]any{"content": "Ignore"}, Version: 9},
						{AgentSessionID: input.AgentSessionID, MessageID: "assistant-old", Role: "assistant", Kind: "text", Payload: map[string]any{"content": "Old"}, Version: 4},
					},
				}, true
			default:
				t.Fatalf("unexpected ListSessionMessages input: %#v", input)
				return SessionMessagesPage{}, false
			}
		},
	}
	service := newIsolatedAgentService(runtime)
	service.TurnStore = runtime
	service.MessageReader = reader

	waitDone := make(chan WaitResult, 1)
	waitErr := make(chan error, 1)
	go func() {
		result, err := service.Wait(context.Background(), WaitInput{
			WorkspaceID:    "ws-1",
			AgentSessionID: "session-1",
			AfterVersion:   uint64Ptr(5),
			MessageLimit:   1,
			Timeout:        2 * time.Second,
		})
		if err != nil {
			waitErr <- err
			return
		}
		waitDone <- result
	}()

	<-runtime.subscribeStarted
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "waiting",
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &turnID,
			Phase:        "waiting_input",
		},
		Visible:         true,
		CreatedAtUnixMS: time.Now().Add(-time.Minute).UnixMilli(),
		UpdatedAtUnixMS: time.Now().UnixMilli(),
	}
	runtime.events <- RuntimeStreamEvent{EventType: "state_patch"}
	close(runtime.events)

	select {
	case err := <-waitErr:
		t.Fatalf("Wait() error = %v", err)
	case result := <-waitDone:
		if result.HasMore {
			t.Fatalf("hasMore = true, want false after filtered pagination")
		}
		if len(result.Messages) != 1 || result.Messages[0].MessageID != "assistant-1" {
			t.Fatalf("messages = %#v", result.Messages)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Wait() did not return")
	}
}

func TestWaitStopsScanningOlderPagesAfterCrossingAfterVersion(t *testing.T) {
	runtime := newWaitRuntime()
	turnID := "turn-1"
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "working",
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &turnID,
			Phase:        "running",
		},
		Visible:         true,
		CreatedAtUnixMS: time.Now().Add(-time.Minute).UnixMilli(),
		UpdatedAtUnixMS: time.Now().Add(-time.Second).UnixMilli(),
	}
	reader := &waitMessageReader{
		list: func(input agentactivitybiz.ListSessionMessagesInput) (SessionMessagesPage, bool) {
			switch {
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 100:
				return SessionMessagesPage{AgentSessionID: input.AgentSessionID}, true
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 1:
				return SessionMessagesPage{AgentSessionID: input.AgentSessionID, LatestVersion: 11}, true
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 20 && input.BeforeVersion == 0:
				return SessionMessagesPage{
					AgentSessionID: input.AgentSessionID,
					LatestVersion:  11,
					HasMore:        true,
					Messages: []SessionMessage{
						{AgentSessionID: input.AgentSessionID, MessageID: "assistant-1", Role: "assistant", Kind: "text", Payload: map[string]any{"content": "Relevant"}, Version: 11},
						{AgentSessionID: input.AgentSessionID, MessageID: "user-1", Role: "user", Kind: "text", Payload: map[string]any{"content": "Cursor"}, Version: 10},
					},
				}, true
			default:
				t.Fatalf("unexpected ListSessionMessages input: %#v", input)
				return SessionMessagesPage{}, false
			}
		},
	}
	service := newIsolatedAgentService(runtime)
	service.TurnStore = runtime
	service.MessageReader = reader

	waitDone := make(chan WaitResult, 1)
	waitErr := make(chan error, 1)
	go func() {
		result, err := service.Wait(context.Background(), WaitInput{
			WorkspaceID:    "ws-1",
			AgentSessionID: "session-1",
			AfterVersion:   uint64Ptr(10),
			MessageLimit:   1,
			Timeout:        2 * time.Second,
		})
		if err != nil {
			waitErr <- err
			return
		}
		waitDone <- result
	}()

	<-runtime.subscribeStarted
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "waiting",
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &turnID,
			Phase:        "waiting_input",
		},
		Visible:         true,
		CreatedAtUnixMS: time.Now().Add(-time.Minute).UnixMilli(),
		UpdatedAtUnixMS: time.Now().UnixMilli(),
	}
	runtime.events <- RuntimeStreamEvent{EventType: "state_patch"}
	close(runtime.events)

	select {
	case err := <-waitErr:
		t.Fatalf("Wait() error = %v", err)
	case result := <-waitDone:
		if result.HasMore {
			t.Fatalf("hasMore = true, want false once after-version boundary is crossed")
		}
		if len(result.Messages) != 1 || result.Messages[0].MessageID != "assistant-1" {
			t.Fatalf("messages = %#v", result.Messages)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Wait() did not return")
	}
}

func TestWaitTimesOutAndReturnsCurrentSessionSnapshot(t *testing.T) {
	runtime := newWaitRuntime()
	turnID := "turn-1"
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "working",
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &turnID,
			Phase:        "running",
		},
		Visible:         true,
		CreatedAtUnixMS: time.Now().Add(-time.Minute).UnixMilli(),
		UpdatedAtUnixMS: time.Now().Add(-time.Second).UnixMilli(),
	}
	reader := &waitMessageReader{
		list: func(input agentactivitybiz.ListSessionMessagesInput) (SessionMessagesPage, bool) {
			switch {
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 100:
				return SessionMessagesPage{AgentSessionID: input.AgentSessionID}, true
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 1:
				return SessionMessagesPage{
					AgentSessionID: input.AgentSessionID,
					LatestVersion:  10,
				}, true
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 20:
				return SessionMessagesPage{
					AgentSessionID: input.AgentSessionID,
					LatestVersion:  12,
					Messages: []SessionMessage{
						{AgentSessionID: input.AgentSessionID, MessageID: "assistant-2", Role: "assistant", Kind: "text", Payload: map[string]any{"content": "Second"}, Version: 12},
						{AgentSessionID: input.AgentSessionID, MessageID: "assistant-1", Role: "assistant", Kind: "text", Payload: map[string]any{"content": "First"}, Version: 11},
					},
				}, true
			default:
				t.Fatalf("unexpected ListSessionMessages input: %#v", input)
				return SessionMessagesPage{}, false
			}
		},
	}
	service := newIsolatedAgentService(runtime)
	service.TurnStore = runtime
	service.MessageReader = reader

	result, err := service.Wait(context.Background(), WaitInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		MessageLimit:   2,
		Timeout:        20 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if !result.TimedOut || result.Reason != WaitReasonTimeout {
		t.Fatalf("result = %#v, want timeout", result)
	}
	if result.EffectiveAfter != 10 || result.LatestVersion != 12 {
		t.Fatalf("versions = after %d latest %d, want 10/12", result.EffectiveAfter, result.LatestVersion)
	}
	if len(result.Messages) != 2 || result.Messages[0].MessageID != "assistant-1" || result.Messages[1].MessageID != "assistant-2" {
		t.Fatalf("messages = %#v", result.Messages)
	}
}

func TestWaitPreservesExplicitZeroAfterVersion(t *testing.T) {
	runtime := newWaitRuntime()
	turnID := "turn-1"
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "waiting",
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &turnID,
			Phase:        "waiting_input",
		},
		Visible:         true,
		CreatedAtUnixMS: time.Now().Add(-time.Minute).UnixMilli(),
		UpdatedAtUnixMS: time.Now().Add(-time.Second).UnixMilli(),
	}
	reader := &waitMessageReader{
		list: func(input agentactivitybiz.ListSessionMessagesInput) (SessionMessagesPage, bool) {
			switch {
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 100:
				return SessionMessagesPage{AgentSessionID: input.AgentSessionID}, true
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 1:
				return SessionMessagesPage{AgentSessionID: input.AgentSessionID, LatestVersion: 2}, true
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 20:
				return SessionMessagesPage{
					AgentSessionID: input.AgentSessionID,
					LatestVersion:  2,
					Messages: []SessionMessage{
						{AgentSessionID: input.AgentSessionID, MessageID: "assistant-1", Role: "assistant", Kind: "text", Payload: map[string]any{"content": "Fresh"}, Version: 2},
						{AgentSessionID: input.AgentSessionID, MessageID: "user-1", Role: "user", Kind: "text", Payload: map[string]any{"content": "Ignore"}, Version: 1},
					},
				}, true
			default:
				t.Fatalf("unexpected ListSessionMessages input: %#v", input)
				return SessionMessagesPage{}, false
			}
		},
	}
	service := newIsolatedAgentService(runtime)
	service.TurnStore = runtime
	service.MessageReader = reader

	result, err := service.Wait(context.Background(), WaitInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		AfterVersion:   uint64Ptr(0),
	})
	if err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if result.Reason != WaitReasonWaitingInput || result.TimedOut {
		t.Fatalf("result = %#v", result)
	}
	if result.EffectiveAfter != 0 || result.LatestVersion != 2 {
		t.Fatalf("versions = after %d latest %d, want 0/2", result.EffectiveAfter, result.LatestVersion)
	}
	if len(result.Messages) != 1 || result.Messages[0].MessageID != "assistant-1" {
		t.Fatalf("messages = %#v", result.Messages)
	}
	if !runtime.unsubscribeCalled {
		t.Fatalf("unsubscribe not called")
	}
}

func TestWaitClosedStreamDoesNotReturnStaleStop(t *testing.T) {
	runtime := newWaitRuntime()
	turnID := "turn-1"
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "waiting",
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &turnID,
			Phase:        "waiting_input",
		},
		Visible:         true,
		CreatedAtUnixMS: time.Now().Add(-time.Minute).UnixMilli(),
		UpdatedAtUnixMS: time.Now().Add(-time.Second).UnixMilli(),
	}
	reader := &waitMessageReader{
		list: func(input agentactivitybiz.ListSessionMessagesInput) (SessionMessagesPage, bool) {
			switch {
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 100:
				return SessionMessagesPage{AgentSessionID: input.AgentSessionID}, true
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 1:
				return SessionMessagesPage{AgentSessionID: input.AgentSessionID, LatestVersion: 4}, true
			case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 20:
				return SessionMessagesPage{AgentSessionID: input.AgentSessionID, LatestVersion: 4}, true
			default:
				t.Fatalf("unexpected ListSessionMessages input: %#v", input)
				return SessionMessagesPage{}, false
			}
		},
	}
	service := newIsolatedAgentService(runtime)
	service.TurnStore = runtime
	service.MessageReader = reader

	waitDone := make(chan WaitResult, 1)
	waitErr := make(chan error, 1)
	go func() {
		result, err := service.Wait(context.Background(), WaitInput{
			WorkspaceID:    "ws-1",
			AgentSessionID: "session-1",
			AfterVersion:   uint64Ptr(4),
			Timeout:        time.Second,
		})
		if err != nil {
			waitErr <- err
			return
		}
		waitDone <- result
	}()

	<-runtime.subscribeStarted
	close(runtime.events)

	select {
	case err := <-waitErr:
		t.Fatalf("Wait() error = %v", err)
	case result := <-waitDone:
		if !result.TimedOut || result.Reason != WaitReasonTimeout {
			t.Fatalf("result = %#v, want timeout instead of stale stop", result)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Wait() did not return")
	}
}
