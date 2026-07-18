package agent

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

type waitRuntime struct {
	*fakeRuntime
	events            chan RuntimeStreamEvent
	mu                sync.RWMutex
	subscribeStarted  chan struct{}
	unsubscribeCalled bool
	interactionInput  map[string]any
	interactionMeta   map[string]any
	turnOverride      *agentactivitybiz.Turn
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
	return r.events, func() {
		r.mu.Lock()
		r.unsubscribeCalled = true
		r.mu.Unlock()
	}, true
}

func (r *waitRuntime) setSession(session ProviderRuntimeSession) {
	r.mu.Lock()
	r.sessions[session.WorkspaceID+":"+session.ID] = session
	r.mu.Unlock()
}

func (r *waitRuntime) runtimeSession(workspaceID string, sessionID string) (ProviderRuntimeSession, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	session, ok := r.sessions[workspaceID+":"+sessionID]
	return session, ok
}

func (r *waitRuntime) Session(workspaceID string, sessionID string) (ProviderRuntimeSession, bool) {
	return r.runtimeSession(workspaceID, sessionID)
}

func (r *waitRuntime) didUnsubscribe() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.unsubscribeCalled
}

func (r *waitRuntime) persistedTurn(workspaceID string, sessionID string) (agentactivitybiz.Turn, bool) {
	r.mu.RLock()
	if r.turnOverride != nil && r.turnOverride.WorkspaceID == workspaceID && r.turnOverride.AgentSessionID == sessionID {
		turn := *r.turnOverride
		r.mu.RUnlock()
		return turn, true
	}
	r.mu.RUnlock()
	session, ok := r.runtimeSession(workspaceID, sessionID)
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
	outcome := ""
	if session.TurnLifecycle.Outcome != nil {
		outcome = *session.TurnLifecycle.Outcome
	}
	return agentactivitybiz.Turn{
		WorkspaceID:    workspaceID,
		AgentSessionID: sessionID,
		TurnID:         turnID,
		Phase:          phase,
		Outcome:        outcome,
	}, true
}

func (r *waitRuntime) pendingInteractions(workspaceID string, sessionID string) []agentactivitybiz.Interaction {
	turn, ok := r.persistedTurn(workspaceID, sessionID)
	if !ok || turn.Phase != agentactivitybiz.TurnPhaseWaiting {
		return nil
	}
	session, _ := r.runtimeSession(workspaceID, sessionID)
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
		ToolName:       "Approval",
		Input:          clonePayload(r.interactionInput),
		Metadata:       clonePayload(r.interactionMeta),
	}}
}

func (r *waitRuntime) GetLatestTurn(_ context.Context, workspaceID string, sessionID string) (agentactivitybiz.Turn, bool, error) {
	turn, ok := r.persistedTurn(workspaceID, sessionID)
	return turn, ok, nil
}

func (r *waitRuntime) ListSessionTurns(_ context.Context, workspaceID string, sessionID string) ([]agentactivitybiz.Turn, error) {
	turn, ok := r.persistedTurn(workspaceID, sessionID)
	if !ok {
		return []agentactivitybiz.Turn{}, nil
	}
	return []agentactivitybiz.Turn{turn}, nil
}

func (r *waitRuntime) GetTurn(_ context.Context, workspaceID string, sessionID string, turnID string) (agentactivitybiz.Turn, bool, error) {
	turn, ok := r.persistedTurn(workspaceID, sessionID)
	return turn, ok && turn.TurnID == turnID, nil
}

func (r *waitRuntime) GetSession(_ context.Context, workspaceID string, sessionID string) (agentactivitybiz.Session, bool, error) {
	turn, hasTurn := r.persistedTurn(workspaceID, sessionID)
	_, found := r.runtimeSession(workspaceID, sessionID)
	result := agentactivitybiz.Session{WorkspaceID: workspaceID, ID: sessionID}
	if hasTurn && turn.Phase != agentactivitybiz.TurnPhaseSettled {
		result.ActiveTurnID = turn.TurnID
	}
	if sessionID == "child-1" {
		result.Kind = agentactivitybiz.SessionKindChild
		result.RootAgentSessionID = "root-1"
	}
	return result, found, nil
}

func (r *waitRuntime) SubmitInteractive(ctx context.Context, input RuntimeSubmitInteractiveInput) (RuntimeSubmitInteractiveResult, error) {
	result, err := r.fakeRuntime.SubmitInteractive(ctx, input)
	if err != nil {
		return result, err
	}
	session, ok := r.runtimeSession(input.WorkspaceID, input.AgentSessionID)
	if !ok || session.TurnLifecycle == nil {
		return result, nil
	}
	outcome := agentactivitybiz.TurnOutcomeCompleted
	session.Status = "completed"
	session.TurnLifecycle.Phase = agentactivitybiz.TurnPhaseSettled
	session.TurnLifecycle.Outcome = &outcome
	session.UpdatedAtUnixMS = time.Now().UnixMilli()
	r.setSession(session)
	return result, nil
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

func TestWaitRespondChildInteractionAndReturnFinalMessage(t *testing.T) {
	runtime := newWaitRuntime()
	turnID := "child-turn-1"
	runtime.sessions["ws-1:root-1"] = ProviderRuntimeSession{
		ID: "root-1", WorkspaceID: "ws-1", Provider: "codex", Status: "working",
		Visible: true, CreatedAtUnixMS: time.Now().Add(-time.Minute).UnixMilli(), UpdatedAtUnixMS: time.Now().UnixMilli(),
	}
	runtime.sessions["ws-1:child-1"] = ProviderRuntimeSession{
		ID: "child-1", WorkspaceID: "ws-1", Provider: "codex", Status: "waiting",
		TurnLifecycle: &TurnLifecycle{ActiveTurnID: &turnID, Phase: "waiting_approval"},
		Visible:       true, CreatedAtUnixMS: time.Now().Add(-time.Minute).UnixMilli(), UpdatedAtUnixMS: time.Now().UnixMilli(),
	}
	runtime.interactionInput = map[string]any{"command": strings.Repeat("echo tutti; ", 300)}
	runtime.interactionMeta = map[string]any{"actions": []any{
		map[string]any{"id": "approve", "label": "Approve", "semantic": "approve"},
		map[string]any{"id": "deny", "label": "Deny", "semantic": "deny"},
	}}
	finalText := strings.Repeat("full result ", 400)
	reader := &waitMessageReader{list: func(input agentactivitybiz.ListSessionMessagesInput) (SessionMessagesPage, bool) {
		session, _ := runtime.runtimeSession(input.WorkspaceID, input.AgentSessionID)
		settled := session.TurnLifecycle != nil && session.TurnLifecycle.Phase == agentactivitybiz.TurnPhaseSettled
		latest := uint64(10)
		if settled {
			latest = 11
		}
		switch {
		case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == 1:
			return SessionMessagesPage{AgentSessionID: input.AgentSessionID, LatestVersion: latest}, true
		case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == defaultWaitMessageLimit:
			return SessionMessagesPage{AgentSessionID: input.AgentSessionID, LatestVersion: latest}, true
		case input.Order == agentactivitybiz.MessageOrderDesc && input.Limit == defaultListMessagesLimit && input.TurnID == turnID:
			return SessionMessagesPage{AgentSessionID: input.AgentSessionID, LatestVersion: latest, Messages: []SessionMessage{{
				AgentSessionID: input.AgentSessionID, TurnID: turnID, MessageID: "assistant-final",
				Role: "assistant", Kind: "text", Status: "completed", Payload: map[string]any{"content": finalText}, Version: 11,
			}}}, true
		default:
			t.Fatalf("unexpected ListSessionMessages input: %#v", input)
			return SessionMessagesPage{}, false
		}
	}}
	service := newIsolatedAgentService(runtime)
	service.TurnStore = runtime
	service.MessageReader = reader
	service.RuntimeOperationStore = &runtimeOperationMemoryStore{}

	waiting, err := service.Wait(context.Background(), WaitInput{WorkspaceID: "ws-1", AgentSessionID: "child-1"})
	if err != nil {
		t.Fatalf("initial Wait() error = %v", err)
	}
	if waiting.Reason != WaitReasonWaitingApproval || len(waiting.Interactions) != 1 {
		t.Fatalf("initial wait = %#v", waiting)
	}
	interaction := waiting.Interactions[0]
	if interaction.RequestID != "wait-request" || interaction.TurnID != turnID || interaction.ToolName != "Approval" ||
		len(interaction.Actions) != 2 || interaction.Actions[0].Semantic != "approve" ||
		!interaction.InputTruncated || len([]byte(interaction.InputSummary)) > waitInteractionInputSummaryLimit {
		t.Fatalf("wait interaction = %#v", interaction)
	}

	responded, err := service.Respond(context.Background(), RespondInput{
		WorkspaceID: "ws-1", AgentSessionID: "child-1", RequestID: interaction.RequestID, Semantic: "approve",
	})
	if err != nil {
		t.Fatalf("Respond() error = %v", err)
	}
	if responded.TurnID != turnID || responded.Disposition != RuntimeInteractiveDispositionAnswered {
		t.Fatalf("respond result = %#v", responded)
	}
	if len(runtime.submitInteractiveCalls) != 1 || runtime.submitInteractiveCalls[0].RootAgentSessionID != "root-1" ||
		runtime.submitInteractiveCalls[0].AgentSessionID != "child-1" || runtime.submitInteractiveCalls[0].TurnID != turnID ||
		runtime.submitInteractiveCalls[0].Action != "approve" {
		t.Fatalf("runtime submit calls = %#v", runtime.submitInteractiveCalls)
	}

	completed, err := service.Wait(context.Background(), WaitInput{WorkspaceID: "ws-1", AgentSessionID: "child-1"})
	if err != nil {
		t.Fatalf("completed Wait() error = %v", err)
	}
	if completed.Reason != WaitReasonCompleted || completed.FinalMessage == nil ||
		completed.FinalMessage.TurnID != turnID || completed.FinalMessage.Text != finalText {
		t.Fatalf("completed wait = %#v", completed)
	}
}

func TestFinalAssistantMessageScansOlderTurnPagesWithoutTruncating(t *testing.T) {
	fullText := strings.Repeat("complete result ", 500)
	reader := &waitMessageReader{list: func(input agentactivitybiz.ListSessionMessagesInput) (SessionMessagesPage, bool) {
		switch input.BeforeVersion {
		case 0:
			return SessionMessagesPage{AgentSessionID: input.AgentSessionID, HasMore: true, Messages: []SessionMessage{{
				TurnID: "turn-1", MessageID: "tool-late", Role: "tool", Kind: "call", Version: 101,
			}}}, true
		case 101:
			return SessionMessagesPage{AgentSessionID: input.AgentSessionID, Messages: []SessionMessage{{
				TurnID: "turn-1", MessageID: "assistant-final", Role: "assistant", Kind: "text",
				Payload: map[string]any{"content": fullText}, Version: 100,
			}}}, true
		default:
			t.Fatalf("unexpected before version %d", input.BeforeVersion)
			return SessionMessagesPage{}, false
		}
	}}
	service := newIsolatedAgentService(newFakeRuntime())
	service.MessageReader = reader
	message, err := service.finalAssistantMessage(context.Background(), "ws-1", "session-1", Session{
		LatestTurn: &agentactivitybiz.Turn{TurnID: "turn-1", Phase: agentactivitybiz.TurnPhaseSettled, Outcome: agentactivitybiz.TurnOutcomeFailed},
	})
	if err != nil {
		t.Fatalf("finalAssistantMessage() error = %v", err)
	}
	if message == nil || message.TurnID != "turn-1" || message.Text != fullText {
		t.Fatalf("final message = %#v", message)
	}
}

func TestFinalAssistantMessageUsesSettlementAnchor(t *testing.T) {
	reader := &waitMessageReader{list: func(input agentactivitybiz.ListSessionMessagesInput) (SessionMessagesPage, bool) {
		if input.MessageID != "assistant-middle" || input.TurnID != "turn-1" || input.Limit != 1 {
			t.Fatalf("anchored message query = %#v", input)
		}
		return SessionMessagesPage{AgentSessionID: input.AgentSessionID, Messages: []SessionMessage{{
			TurnID: "turn-1", MessageID: "assistant-middle", Role: "assistant", Kind: "text",
			Payload: map[string]any{"text": "anchored result"}, Version: 8,
		}}}, true
	}}
	service := newIsolatedAgentService(newFakeRuntime())
	service.MessageReader = reader
	message, err := service.finalAssistantMessage(context.Background(), "ws-1", "session-1", Session{
		LatestTurn: &agentactivitybiz.Turn{
			TurnID: "turn-1", Phase: agentactivitybiz.TurnPhaseSettled,
			FinalAssistantMessageID: "assistant-middle",
		},
	})
	if err != nil {
		t.Fatalf("finalAssistantMessage() error = %v", err)
	}
	if message == nil || message.Text != "anchored result" {
		t.Fatalf("final message = %#v", message)
	}
}

func TestFinalAssistantMessageFallbackIsBoundedForUserOnlyTail(t *testing.T) {
	reader := &waitMessageReader{list: func(input agentactivitybiz.ListSessionMessagesInput) (SessionMessagesPage, bool) {
		messages := make([]SessionMessage, defaultListMessagesLimit)
		start := uint64(1000)
		if input.BeforeVersion > 0 {
			start = input.BeforeVersion - 1
		}
		for index := range messages {
			messages[index] = SessionMessage{
				TurnID: "turn-1", MessageID: fmt.Sprintf("user-%d-%d", start, index),
				Role: "user", Kind: "text", Version: start - uint64(index),
			}
		}
		return SessionMessagesPage{AgentSessionID: input.AgentSessionID, Messages: messages, HasMore: true}, true
	}}
	service := newIsolatedAgentService(newFakeRuntime())
	service.MessageReader = reader
	message, err := service.finalAssistantMessage(context.Background(), "ws-1", "session-1", Session{
		LatestTurn: &agentactivitybiz.Turn{TurnID: "turn-1", Phase: agentactivitybiz.TurnPhaseSettled},
	})
	if err != nil {
		t.Fatalf("finalAssistantMessage() error = %v", err)
	}
	if message != nil {
		t.Fatalf("final message = %#v, want nil", message)
	}
	if len(reader.calls) != finalAssistantMessageFallbackPages {
		t.Fatalf("fallback message queries = %d, want %d", len(reader.calls), finalAssistantMessageFallbackPages)
	}
}

func TestWaitResolvedEmptyFinalMessageIgnoresLateAssistant(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-resolved-empty", Name: "Resolved empty"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	projection := NewActivityProjection(store)
	turnID := "turn-empty"
	if err := projection.Report(ctx, agentsessionstore.ReportActivityInput{
		WorkspaceID: "ws-resolved-empty",
		Source: canonical.EventSource{
			AgentID: "session-empty", Provider: "codex",
			SessionOrigin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		},
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{{
			AgentSessionID: "session-empty", Kind: agentactivitybiz.SessionKindRoot,
			Provider: "codex", LifecycleStatus: "active", CurrentPhase: "working", OccurredAtUnixMS: 1,
			Turn: &agentsessionstore.WorkspaceAgentTurnPatch{
				TurnID: turnID, Origin: agentactivitybiz.TurnOriginUserPrompt,
				ActiveTurnID: &turnID, Phase: agentactivitybiz.TurnPhaseRunning,
			},
		}},
	}); err != nil {
		t.Fatalf("seed running turn error = %v", err)
	}
	if err := projection.Report(ctx, agentsessionstore.ReportActivityInput{
		WorkspaceID: "ws-resolved-empty",
		Source: canonical.EventSource{
			AgentID: "session-empty", Provider: "codex",
			SessionOrigin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		},
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{{
			AgentSessionID: "session-empty", Kind: agentactivitybiz.SessionKindRoot,
			Provider: "codex", LifecycleStatus: "ready", CurrentPhase: "idle", OccurredAtUnixMS: 2,
			Turn: &agentsessionstore.WorkspaceAgentTurnPatch{
				TurnID: turnID, Phase: agentactivitybiz.TurnPhaseSettled,
				Outcome: agentactivitybiz.TurnOutcomeCompleted, CompletedAtUnixMS: 2,
			},
		}},
	}); err != nil {
		t.Fatalf("settle empty turn error = %v", err)
	}
	if err := projection.Report(ctx, agentsessionstore.ReportActivityInput{
		WorkspaceID: "ws-resolved-empty",
		Source: canonical.EventSource{
			AgentID: "session-empty", Provider: "codex",
			SessionOrigin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		},
		MessageUpdates: []agentsessionstore.WorkspaceAgentMessageUpdate{{
			AgentSessionID: "session-empty", TurnID: turnID, MessageID: "assistant-late",
			Role: "assistant", Kind: "text", Status: "completed",
			Payload: map[string]any{"text": "late result"}, OccurredAtUnixMS: 3,
		}},
	}); err != nil {
		t.Fatalf("persist late assistant error = %v", err)
	}

	turn, found, err := store.GetTurn(ctx, "ws-resolved-empty", "session-empty", turnID)
	if err != nil || !found || !turn.FinalAssistantMessageResolved || turn.FinalAssistantMessageID != "" {
		t.Fatalf("resolved-empty turn = %#v found=%v error=%v", turn, found, err)
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.TurnStore = store
	service.MessageReader = projection
	result, err := service.Wait(ctx, WaitInput{
		WorkspaceID: "ws-resolved-empty", AgentSessionID: "session-empty", SkipMessages: true,
	})
	if err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if result.Reason != WaitReasonCompleted || result.FinalMessage != nil {
		t.Fatalf("wait result = %#v, want completed without late final message", result)
	}
}

func TestWaitUserOnlyLongTailHasBoundedMessageQueries(t *testing.T) {
	runtime := newWaitRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "ws-1", Provider: "codex", Status: "completed",
		TurnLifecycle: &TurnLifecycle{Phase: agentactivitybiz.TurnPhaseSettled}, Visible: true,
	}
	runtime.turnOverride = &agentactivitybiz.Turn{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: agentactivitybiz.TurnPhaseSettled, Outcome: agentactivitybiz.TurnOutcomeCompleted,
	}
	reader := &waitMessageReader{list: func(input agentactivitybiz.ListSessionMessagesInput) (SessionMessagesPage, bool) {
		if input.Limit == 1 {
			return SessionMessagesPage{AgentSessionID: input.AgentSessionID, LatestVersion: 1000}, true
		}
		messages := make([]SessionMessage, defaultListMessagesLimit)
		start := uint64(1000)
		if input.BeforeVersion > 0 {
			start = input.BeforeVersion - 1
		}
		for index := range messages {
			messages[index] = SessionMessage{
				TurnID: "turn-1", MessageID: fmt.Sprintf("user-tail-%d-%d", start, index),
				Role: "user", Kind: "text", Version: start - uint64(index),
			}
		}
		return SessionMessagesPage{AgentSessionID: input.AgentSessionID, Messages: messages, HasMore: true}, true
	}}
	service := newIsolatedAgentService(runtime)
	service.TurnStore = runtime
	service.MessageReader = reader
	result, err := service.Wait(context.Background(), WaitInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", SkipMessages: true,
	})
	if err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if result.Reason != WaitReasonCompleted || result.FinalMessage != nil {
		t.Fatalf("wait result = %#v", result)
	}
	wantQueries := 2 + finalAssistantMessageFallbackPages
	if len(reader.calls) != wantQueries {
		t.Fatalf("wait message queries = %d, want bounded %d", len(reader.calls), wantQueries)
	}
}

func TestWaitSkipMessagesStillEnrichesCompletedResult(t *testing.T) {
	runtime := newWaitRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "ws-1", Provider: "codex", Status: "completed",
		TurnLifecycle: &TurnLifecycle{Phase: agentactivitybiz.TurnPhaseSettled}, Visible: true,
	}
	runtime.turnOverride = &agentactivitybiz.Turn{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: agentactivitybiz.TurnPhaseSettled, Outcome: agentactivitybiz.TurnOutcomeCompleted,
		FinalAssistantMessageID: "assistant-final",
	}
	reader := &waitMessageReader{list: func(input agentactivitybiz.ListSessionMessagesInput) (SessionMessagesPage, bool) {
		if input.MessageID == "assistant-final" {
			return SessionMessagesPage{AgentSessionID: input.AgentSessionID, Messages: []SessionMessage{{
				TurnID: "turn-1", MessageID: "assistant-final", Role: "assistant", Kind: "text",
				Payload: map[string]any{"text": "done"}, Version: 4,
			}}}, true
		}
		return SessionMessagesPage{AgentSessionID: input.AgentSessionID, LatestVersion: 4}, true
	}}
	service := newIsolatedAgentService(runtime)
	service.TurnStore = runtime
	service.MessageReader = reader
	result, err := service.Wait(context.Background(), WaitInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", SkipMessages: true,
	})
	if err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if result.FinalMessage == nil || result.FinalMessage.Text != "done" || len(result.Messages) != 0 {
		t.Fatalf("wait result = %#v", result)
	}
}

func TestWaitCompletedNearTimeoutUsesIndependentEnrichmentBudget(t *testing.T) {
	runtime := newWaitRuntime()
	turnID := "turn-1"
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "ws-1", Provider: "codex", Status: "working",
		TurnLifecycle: &TurnLifecycle{ActiveTurnID: &turnID, Phase: agentactivitybiz.TurnPhaseRunning}, Visible: true,
	}
	reader := &waitMessageReader{list: func(input agentactivitybiz.ListSessionMessagesInput) (SessionMessagesPage, bool) {
		if input.MessageID == "assistant-final" {
			time.Sleep(75 * time.Millisecond)
			return SessionMessagesPage{AgentSessionID: input.AgentSessionID, Messages: []SessionMessage{{
				TurnID: turnID, MessageID: "assistant-final", Role: "assistant", Kind: "text",
				Payload: map[string]any{"text": "completed near timeout"}, Version: 2,
			}}}, true
		}
		return SessionMessagesPage{AgentSessionID: input.AgentSessionID, LatestVersion: 2}, true
	}}
	service := newIsolatedAgentService(runtime)
	service.TurnStore = runtime
	service.MessageReader = reader

	done := make(chan WaitResult, 1)
	errs := make(chan error, 1)
	go func() {
		result, err := service.Wait(context.Background(), WaitInput{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", AfterVersion: uint64Ptr(0),
			SkipMessages: true, Timeout: 50 * time.Millisecond,
		})
		if err != nil {
			errs <- err
			return
		}
		done <- result
	}()
	<-runtime.subscribeStarted
	runtime.mu.Lock()
	runtime.turnOverride = &agentactivitybiz.Turn{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: turnID,
		Phase: agentactivitybiz.TurnPhaseSettled, Outcome: agentactivitybiz.TurnOutcomeCompleted,
		FinalAssistantMessageID: "assistant-final",
	}
	runtime.mu.Unlock()
	runtime.setSession(ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "ws-1", Provider: "codex", Status: "completed",
		TurnLifecycle: &TurnLifecycle{Phase: agentactivitybiz.TurnPhaseSettled}, Visible: true,
	})
	runtime.events <- RuntimeStreamEvent{EventType: "state_patch"}
	select {
	case err := <-errs:
		t.Fatalf("Wait() error = %v", err)
	case result := <-done:
		if result.TimedOut || result.Reason != WaitReasonCompleted || result.FinalMessage == nil || result.FinalMessage.Text != "completed near timeout" {
			t.Fatalf("wait result = %#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("Wait() did not return")
	}
}

func TestWaitInteractionInputSummaryTruncatesOnUTF8Boundary(t *testing.T) {
	summary, truncated := waitInteractionInputSummary(map[string]any{"question": strings.Repeat("界", 1000)})
	if !truncated || len([]byte(summary)) > waitInteractionInputSummaryLimit || !utf8.ValidString(summary) {
		t.Fatalf("summary bytes=%d truncated=%v valid=%v", len([]byte(summary)), truncated, utf8.ValidString(summary))
	}
}

func TestWaitSkipMessagesReturnsOnlyStopPointMetadata(t *testing.T) {
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
		UpdatedAtUnixMS: time.Now().UnixMilli(),
	}
	reader := &waitMessageReader{
		list: func(input agentactivitybiz.ListSessionMessagesInput) (SessionMessagesPage, bool) {
			if input.Order != agentactivitybiz.MessageOrderDesc || input.Limit != 1 {
				t.Fatalf("skip-messages wait queried execution messages: %#v", input)
			}
			return SessionMessagesPage{
				AgentSessionID: input.AgentSessionID,
				LatestVersion:  7,
			}, true
		},
	}
	service := newIsolatedAgentService(runtime)
	service.TurnStore = runtime
	service.MessageReader = reader

	result, err := service.Wait(context.Background(), WaitInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		AfterVersion:   uint64Ptr(0),
		SkipMessages:   true,
	})
	if err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if result.Reason != WaitReasonWaitingInput || result.TimedOut {
		t.Fatalf("result = %#v", result)
	}
	if result.EffectiveAfter != 0 || result.LatestVersion != 7 {
		t.Fatalf("versions = after %d latest %d, want 0/7", result.EffectiveAfter, result.LatestVersion)
	}
	if len(result.Messages) != 0 || result.HasMore {
		t.Fatalf("skip-messages result should omit message pagination: %#v", result)
	}
	if len(reader.calls) != 2 {
		t.Fatalf("message reads = %d, want two latest-version reads", len(reader.calls))
	}
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

	runtime.setSession(ProviderRuntimeSession{
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
	})
	runtime.events <- RuntimeStreamEvent{EventType: "state_patch"}

	runtime.setSession(ProviderRuntimeSession{
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
	})
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
	if !runtime.didUnsubscribe() {
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
	runtime.setSession(ProviderRuntimeSession{
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
	})
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
	runtime.setSession(ProviderRuntimeSession{
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
	})
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
	if !runtime.didUnsubscribe() {
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

func TestWaitResultTurnIDUsesTurnAssociatedWithStopReason(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name    string
		session Session
		reason  WaitReason
		want    string
	}{
		{
			name: "waiting uses canonical active turn reference",
			session: Session{
				ActiveTurnID: "active-reference",
				ActiveTurn:   &agentactivitybiz.Turn{TurnID: "active-reference"},
				LatestTurn:   &agentactivitybiz.Turn{TurnID: "latest-turn"},
			},
			reason: WaitReasonWaitingInput,
			want:   "active-reference",
		},
		{
			name:    "active timeout uses embedded turn fallback",
			session: Session{ActiveTurn: &agentactivitybiz.Turn{TurnID: "active-entity"}, LatestTurn: &agentactivitybiz.Turn{TurnID: "latest-turn"}},
			reason:  WaitReasonTimeout,
			want:    "active-entity",
		},
		{
			name:    "completion uses latest settled turn",
			session: Session{LatestTurn: &agentactivitybiz.Turn{TurnID: "latest-turn"}},
			reason:  WaitReasonCompleted,
			want:    "latest-turn",
		},
		{
			name:    "idle timeout does not reuse historical turn",
			session: Session{LatestTurn: &agentactivitybiz.Turn{TurnID: "historical-turn"}},
			reason:  WaitReasonTimeout,
		},
		{
			name:    "ready does not target a turn",
			session: Session{LatestTurn: &agentactivitybiz.Turn{TurnID: "historical-turn"}},
			reason:  WaitReasonReady,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := waitResultTurnID(test.session, test.reason); got != test.want {
				t.Fatalf("waitResultTurnID() = %q, want %q", got, test.want)
			}
		})
	}
}
