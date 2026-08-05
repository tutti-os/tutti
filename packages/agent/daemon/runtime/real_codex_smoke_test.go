package agentruntime

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// TestRealCodexAppServerTurn drives the adapter against the locally
// installed `codex app-server` binary. Gated behind an env var because it
// needs codex credentials and spends real tokens.
func TestRealCodexAppServerTurn(t *testing.T) {
	if os.Getenv("TUTTI_REAL_CODEX_TEST") == "" {
		t.Skip("set TUTTI_REAL_CODEX_TEST=1 to run against the real codex app-server")
	}
	workDir := t.TempDir()
	adapter := NewCodexAppServerAdapter(NewLocalProcessTransport())
	session := Session{
		RoomID:         "real-room",
		AgentSessionID: "real-session",
		Provider:       ProviderCodex,
		CWD:            workDir,
		Status:         SessionStatusReady,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	events, err := adapter.Start(ctx, session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(events) == 0 {
		t.Fatal("no start events")
	}
	state := adapter.SessionState(session)
	t.Logf("auth state: %s", state.AuthState)
	if state.AuthState != "authenticated" {
		t.Fatalf("not authenticated: %s", state.AuthState)
	}
	defer func() { _ = adapter.Close(context.Background(), session) }()

	var streamed []activityshared.Event
	turnEvents, err := adapter.Exec(ctx, session, []PromptContentBlock{{
		Type: "text",
		Text: "Reply with exactly the word PONG and nothing else. Do not run any commands.",
	}}, "", "real-turn-1", func(next []activityshared.Event) {
		streamed = append(streamed, next...)
	}, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	var assistantText string
	var completed bool
	for _, event := range turnEvents {
		if event.Type == activityshared.EventMessageAppended && event.Payload.Role == activityshared.MessageRoleAssistant {
			assistantText = event.Payload.Content
		}
		if event.Type == activityshared.EventTurnCompleted && event.Payload.TurnOutcome == string(activityshared.TurnOutcomeCompleted) {
			completed = true
		}
	}
	t.Logf("streamed=%d total=%d assistant=%q completed=%v", len(streamed), len(turnEvents), assistantText, completed)
	if !completed {
		t.Fatalf("turn did not complete: %d events", len(turnEvents))
	}
	if !strings.Contains(strings.ToUpper(assistantText), "PONG") {
		t.Fatalf("assistant reply = %q, want PONG", assistantText)
	}
}

// TestRealCodexAppServerActiveSide verifies the complete live Side path:
// fork an ephemeral Side while the durable parent Turn is still active, run a
// Side Turn, then unsubscribe the Side without interrupting the parent.
func TestRealCodexAppServerActiveSide(t *testing.T) {
	if os.Getenv("TUTTI_REAL_CODEX_SIDE_TEST") == "" {
		t.Skip(
			"set TUTTI_REAL_CODEX_SIDE_TEST=1 to run the real active Side test",
		)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()

	adapter := NewCodexAppServerAdapter(NewLocalProcessTransport())
	source := Session{
		RoomID:         "real-side-room",
		AgentSessionID: "real-side-parent",
		Provider:       ProviderCodex,
		CWD:            t.TempDir(),
		Status:         SessionStatusReady,
	}
	startEvents, err := adapter.Start(ctx, source)
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	for _, event := range startEvents {
		if strings.TrimSpace(event.ProviderSessionID) != "" {
			source.ProviderSessionID = event.ProviderSessionID
			break
		}
	}
	if source.ProviderSessionID == "" {
		t.Fatal("parent start did not return a provider thread id")
	}
	t.Cleanup(func() {
		if adapter.sessionActiveTurn(source.AgentSessionID) != nil {
			cancelCtx, cancelTurn := context.WithTimeout(
				context.Background(),
				10*time.Second,
			)
			_, _ = adapter.Cancel(cancelCtx, source, "live Side test cleanup")
			cancelTurn()
		}
		_ = adapter.Close(context.Background(), source)
	})

	parentDone := make(chan error, 1)
	go func() {
		_, execErr := adapter.Exec(
			ctx,
			source,
			[]PromptContentBlock{{
				Type: "text",
				Text: "Use the terminal to run `sleep 30`. After it finishes, " +
					"reply PARENT_DONE. Do not modify any files.",
			}},
			"",
			"real-side-parent-turn",
			nil,
			nil,
		)
		parentDone <- execErr
	}()

	activeDeadline := time.Now().Add(30 * time.Second)
	for adapter.sessionActiveTurnID(source.AgentSessionID) == "" &&
		time.Now().Before(activeDeadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if activeID := adapter.sessionActiveTurnID(source.AgentSessionID); activeID == "" {
		t.Fatal("parent provider Turn did not become active")
	} else {
		t.Logf("parent provider Turn active: %s", activeID)
	}

	capabilities, err := adapter.SideCapabilities(ctx, source)
	if err != nil {
		t.Fatalf("SideCapabilities: %v", err)
	}
	if !capabilities.Supported || !capabilities.ActiveSourceTurn ||
		!capabilities.Ephemeral {
		t.Fatalf("Side capabilities = %#v", capabilities)
	}

	side := source
	side.AgentSessionID = "real-side-child"
	side.ProviderSessionID = ""
	side.Scope = RuntimeSessionScopeSide
	side.SourceAgentSessionID = source.AgentSessionID
	side.Resumable = false
	opened, err := adapter.OpenSide(ctx, SideConversationAdapterOpenInput{
		Source: source, Side: side, RequestID: "real-side-open",
	})
	if err != nil {
		t.Fatalf("OpenSide during active parent Turn: %v", err)
	}
	side = opened.Session
	t.Logf("Side provider thread: %s", side.ProviderSessionID)
	defer func() { _ = adapter.Close(context.Background(), side) }()

	sideEvents, err := adapter.Exec(
		ctx,
		side,
		[]PromptContentBlock{{
			Type: "text",
			Text: "Reply exactly SIDE_OK. Do not use tools or modify anything.",
		}},
		"",
		"real-side-child-turn",
		nil,
		nil,
	)
	if err != nil {
		t.Fatalf("execute Side Turn: %v", err)
	}
	var sideText string
	for _, event := range sideEvents {
		if event.Type == activityshared.EventMessageAppended &&
			event.Payload.Role == activityshared.MessageRoleAssistant {
			sideText = event.Payload.Content
		}
	}
	if !strings.Contains(strings.ToUpper(sideText), "SIDE_OK") {
		t.Fatalf("Side assistant reply = %q, want SIDE_OK", sideText)
	}
	if adapter.sessionActiveTurnID(source.AgentSessionID) == "" {
		t.Fatal("parent Turn stopped before the Side Turn completed")
	}
	if err := adapter.Close(ctx, side); err != nil {
		t.Fatalf("close Side: %v", err)
	}
	if !adapter.HasLiveSession(source) {
		t.Fatal("closing Side disconnected the parent session")
	}

	cancelCtx, cancelParent := context.WithTimeout(
		context.Background(),
		10*time.Second,
	)
	_, err = adapter.Cancel(cancelCtx, source, "live Side test complete")
	cancelParent()
	if err != nil {
		t.Fatalf("cancel parent after Side test: %v", err)
	}
	select {
	case parentErr := <-parentDone:
		t.Logf("parent Exec settled after cleanup: %v", parentErr)
	case <-time.After(15 * time.Second):
		t.Fatal("parent Exec did not settle after cancellation")
	}
}
