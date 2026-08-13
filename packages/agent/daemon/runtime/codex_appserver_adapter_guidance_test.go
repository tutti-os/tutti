package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestCodexAppServerAdapterExecSteersActiveTurn(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.holdTurn = true

	execDone := make(chan struct{})
	go func() {
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long task",
		}}, "", "turn-local-1", nil, nil)
		close(execDone)
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	dispatches := make(chan ProviderDispatchResult, 1)
	events, err := adapter.ExecWithProviderAcceptance(
		context.Background(),
		session,
		[]PromptContentBlock{{
			Type: "text", Text: "also update the docs",
		}},
		"",
		"turn-local-2",
		nil,
		nil,
		func(result ProviderDispatchResult) { dispatches <- result },
		nil,
	)
	if err != nil {
		t.Fatalf("steer Exec: %v", err)
	}
	dispatch := <-dispatches
	if dispatch.Disposition != DispatchDispositionAppliedWithoutProviderTurn ||
		dispatch.Acceptance != nil {
		t.Fatalf("steer dispatch = %#v", dispatch)
	}
	steer := appServerRequestParams(t, transport.conn, appServerMethodTurnSteer)
	if asString(steer["expectedTurnId"]) != "turn-1" {
		t.Fatalf("turn/steer params = %#v", steer)
	}
	messages := eventsOfType(events, activityshared.EventMessageAppended)
	if len(messages) != 1 || messages[0].Payload.Role != activityshared.MessageRoleUser {
		t.Fatalf("steer events = %#v, want single user message", events)
	}
	// The controller relies on this marker (turnSteeredIntoActiveTurn) to
	// settle the steer submission's turn record: no terminal event will ever
	// arrive for a steered turn id.
	if steered, ok := messages[0].Payload.Metadata["steered"].(bool); !ok || !steered {
		t.Fatalf("steer message metadata = %#v, want steered=true", messages[0].Payload.Metadata)
	}
	if guidance, ok := messages[0].Payload.Metadata["guidance"].(bool); !ok || !guidance {
		t.Fatalf("steer message metadata = %#v, want guidance=true", messages[0].Payload.Metadata)
	}

	transport.server.completePendingTurn()
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatalf("original Exec did not finish")
	}
}

func TestCodexAppServerAdapterGuideActiveTurnUsesTurnSteer(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.holdTurn = true

	execDone := make(chan struct{})
	go func() {
		_, _ = adapter.Exec(context.Background(), session, textPrompt("long task"), "", "turn-local-1", nil, nil)
		close(execDone)
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	returned, err := adapter.GuideActiveTurn(
		context.Background(), session, textPrompt("guide current turn"), "", "turn-local-1", nil, nil,
	)
	if err != nil {
		t.Fatalf("GuideActiveTurn: %v", err)
	}
	steer := appServerRequestParams(t, transport.conn, appServerMethodTurnSteer)
	if asString(steer["threadId"]) != "codex-thread-1" || asString(steer["expectedTurnId"]) != "turn-1" {
		t.Fatalf("turn/steer params = %#v", steer)
	}
	if interrupts := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt); len(interrupts) != 0 {
		t.Fatalf("turn/interrupt requests = %#v, want non-interrupting guidance", interrupts)
	}
	if starts := appServerRequestParamsList(t, transport.conn, appServerMethodTurnStart); len(starts) != 1 {
		t.Fatalf("turn/start requests = %#v, want only the original provider turn", starts)
	}
	messages := eventsOfType(returned, activityshared.EventMessageAppended)
	if len(messages) != 1 || messages[0].Payload.Role != activityshared.MessageRoleUser {
		t.Fatalf("guidance events = %#v, want one user message", returned)
	}
	if messages[0].Payload.Metadata["guidance"] != true || messages[0].Payload.Metadata["steered"] != true {
		t.Fatalf("guidance metadata = %#v, want guidance+steered", messages[0].Payload.Metadata)
	}

	transport.server.completePendingTurn()
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatalf("original Exec did not finish")
	}
}

func TestCodexAppServerAdapterGuideMaterializesRemoteImageAtProviderBoundary(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	imageURL, materializer := testRemotePromptImageMaterializer(t)
	adapter.promptImageMaterializer = materializer
	transport.server.holdTurn = true

	execDone := make(chan struct{})
	go func() {
		_, _ = adapter.Exec(context.Background(), session, textPrompt("long task"), "", "turn-local-1", nil, nil)
		close(execDone)
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	if _, err := adapter.GuideActiveTurn(context.Background(), session, []PromptContentBlock{
		{Type: "text", Text: "use this screenshot"},
		{Type: "image", MimeType: "image/png", URL: imageURL},
	}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("GuideActiveTurn: %v", err)
	}

	steer := appServerRequestParams(t, transport.conn, appServerMethodTurnSteer)
	input, _ := steer["input"].([]any)
	if len(input) != 2 {
		t.Fatalf("guidance turn/steer input = %#v, want text+image", steer["input"])
	}
	image := payloadObject(input[1])
	if got := asString(image["url"]); got != "data:image/png;base64,aGk=" {
		t.Fatalf("guidance turn/steer image URL = %q, want inline data URL", got)
	}
	if interrupts := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt); len(interrupts) != 0 {
		t.Fatalf("turn/interrupt requests = %#v, want non-interrupting guidance", interrupts)
	}
	if starts := appServerRequestParamsList(t, transport.conn, appServerMethodTurnStart); len(starts) != 1 {
		t.Fatalf("turn/start requests = %#v, want only the original provider turn", starts)
	}

	transport.server.completePendingTurn()
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatal("original Exec did not finish after guidance steer")
	}
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == ""
	})
}

func TestCodexAppServerAdapterGuidanceStartsProviderContinuationOnSameRootTurn(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	if _, err := adapter.Exec(context.Background(), session, textPrompt("delegate work"), "", "root-turn-1", nil, nil); err != nil {
		t.Fatalf("initial Exec: %v", err)
	}
	if got := adapter.sessionActiveTurnID(session.AgentSessionID); got != "" {
		t.Fatalf("provider turn id after completion = %q, want empty", got)
	}
	_, childEvents := adapter.rememberAppServerChildThreads(
		session,
		session.ProviderSessionID,
		session.AgentSessionID,
		"root-turn-1",
		session.AgentSessionID,
		"root-turn-1",
		map[string]any{
			"type":              "collabAgentToolCall",
			"id":                "spawn-child-1",
			"tool":              "spawnAgent",
			"receiverThreadIds": []any{"child-thread-1"},
		},
	)
	if len(childEvents) != 1 || childEvents[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("child creation events = %#v", childEvents)
	}

	var mu sync.Mutex
	var streamed []activityshared.Event
	returned, err := adapter.GuideActiveTurn(
		context.Background(),
		session,
		textPrompt("include the child's findings"),
		"",
		"root-turn-1",
		func(events []activityshared.Event) {
			mu.Lock()
			streamed = append(streamed, events...)
			mu.Unlock()
		},
		nil,
	)
	if err != nil {
		t.Fatalf("GuideActiveTurn: %v", err)
	}
	if len(returned) != 1 || returned[0].Type != activityshared.EventRootProviderTurnStarted ||
		returned[0].Payload.TurnID != "root-turn-1" {
		t.Fatalf("guidance return events = %#v, want provisional provider continuation", returned)
	}

	waitForCondition(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		for _, event := range streamed {
			if event.Type == activityshared.EventRootProviderTurnCompleted && event.Payload.TurnID == "root-turn-1" {
				return true
			}
		}
		return false
	})
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnStart); len(requests) < 2 {
		t.Fatalf("turn/start requests = %#v, want initial turn and same-root continuation", requests)
	}
}

func TestCodexAppServerAdapterGuidanceContinuationMaterializationFailureClosesProvisionalProviderTurn(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	if _, err := adapter.Exec(context.Background(), session, textPrompt("delegate work"), "", "root-turn-1", nil, nil); err != nil {
		t.Fatalf("initial Exec: %v", err)
	}
	_, childEvents := adapter.rememberAppServerChildThreads(
		session,
		session.ProviderSessionID,
		session.AgentSessionID,
		"root-turn-1",
		session.AgentSessionID,
		"root-turn-1",
		map[string]any{
			"type":              "collabAgentToolCall",
			"id":                "spawn-child-1",
			"tool":              "spawnAgent",
			"receiverThreadIds": []any{"child-thread-1"},
		},
	)
	if len(childEvents) != 1 || childEvents[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("child creation events = %#v", childEvents)
	}
	adapter.promptImageMaterializer = func(context.Context, []PromptContentBlock) ([]PromptContentBlock, error) {
		return nil, errors.New("signed image expired")
	}

	var mu sync.Mutex
	var streamed []activityshared.Event
	returned, err := adapter.GuideActiveTurn(
		context.Background(),
		session,
		[]PromptContentBlock{
			{Type: "text", Text: "include this image"},
			{Type: "image", MimeType: "image/png", URL: "https://public.example/image.png"},
		},
		"",
		"root-turn-1",
		func(events []activityshared.Event) {
			mu.Lock()
			streamed = append(streamed, events...)
			mu.Unlock()
		},
		nil,
	)
	if err != nil {
		t.Fatalf("GuideActiveTurn: %v", err)
	}
	if len(returned) != 1 || returned[0].Type != activityshared.EventRootProviderTurnStarted {
		t.Fatalf("guidance return events = %#v, want provisional provider continuation", returned)
	}
	attemptID := returned[0].Payload.ProviderTurnID
	waitForCondition(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		for _, event := range streamed {
			if event.Type == activityshared.EventRootProviderTurnCompleted &&
				event.Payload.ProviderTurnID == attemptID &&
				event.Payload.TurnOutcome == string(activityshared.TurnOutcomeFailed) {
				return true
			}
		}
		return false
	})
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnStart); len(requests) != 1 {
		t.Fatalf("turn/start requests = %#v, want no continuation provider request", requests)
	}
}

func TestCodexAppServerAdapterConcurrentGuidancePublishesSingleProvisionalContinuation(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	if _, err := adapter.Exec(context.Background(), session, textPrompt("delegate work"), "", "root-turn-1", nil, nil); err != nil {
		t.Fatalf("initial Exec: %v", err)
	}
	_, childEvents := adapter.rememberAppServerChildThreads(
		session,
		session.ProviderSessionID,
		session.AgentSessionID,
		"root-turn-1",
		session.AgentSessionID,
		"root-turn-1",
		map[string]any{
			"type":              "collabAgentToolCall",
			"id":                "spawn-child-1",
			"tool":              "spawnAgent",
			"receiverThreadIds": []any{"child-thread-1"},
		},
	)
	if len(childEvents) != 1 || childEvents[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("child creation events = %#v", childEvents)
	}
	transport.server.holdTurn = true

	type guidanceCallResult struct {
		events []activityshared.Event
		err    error
	}
	var streamedMu sync.Mutex
	var streamed []activityshared.Event
	emit := func(events []activityshared.Event) {
		streamedMu.Lock()
		defer streamedMu.Unlock()
		streamed = append(streamed, events...)
	}
	start := make(chan struct{})
	results := make(chan guidanceCallResult, 2)
	for index := 0; index < 2; index++ {
		index := index
		go func() {
			<-start
			events, err := adapter.GuideActiveTurn(
				context.Background(),
				session,
				textPrompt(fmt.Sprintf("guidance %d", index)),
				"",
				"root-turn-1",
				emit,
				nil,
			)
			results <- guidanceCallResult{events: events, err: err}
		}()
	}
	close(start)

	provisionalStarts := 0
	for index := 0; index < 2; index++ {
		select {
		case result := <-results:
			for _, event := range result.events {
				if event.Type == activityshared.EventRootProviderTurnStarted &&
					strings.HasPrefix(event.Payload.ProviderTurnID, "continuation:") {
					provisionalStarts++
				}
			}
		case <-time.After(5 * time.Second):
			t.Fatal("timed out waiting for concurrent guidance")
		}
	}
	if provisionalStarts != 1 {
		t.Fatalf("provisional provider starts = %d, want exactly 1", provisionalStarts)
	}
	waitForCondition(t, func() bool {
		streamedMu.Lock()
		defer streamedMu.Unlock()
		started := 0
		for _, event := range streamed {
			if event.Type == activityshared.EventTurnStarted {
				started++
			}
		}
		return started >= 1
	})
	streamedMu.Lock()
	started := 0
	for _, event := range streamed {
		if event.Type == activityshared.EventTurnStarted {
			started++
		}
	}
	streamedMu.Unlock()
	if started != 1 {
		t.Fatalf("streamed turn starts = %d, want exactly 1 admitted continuation", started)
	}

	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) != ""
	})
	transport.server.completePendingTurn()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == ""
	})
}

func TestCodexAppServerAdapterRejectedContinuationAdmissionEmitsNoTurnStart(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	blockingTurn := &codexAppServerActiveTurn{turnID: "blocking-turn"}
	if !adapter.beginActiveTurn(session.AgentSessionID, blockingTurn) {
		t.Fatal("failed to reserve blocking turn")
	}
	defer adapter.endActiveTurn(session.AgentSessionID, blockingTurn)

	var streamed []activityshared.Event
	continuation := newCodexGuidanceContinuationAdmission("continuation:rejected")
	events, err := adapter.execBlocking(
		context.Background(),
		session,
		textPrompt("guidance"),
		"",
		"root-turn-1",
		func(next []activityshared.Event) {
			streamed = append(streamed, next...)
		},
		nil,
		codexTurnExecOptions{continuation: continuation},
	)
	if !errors.Is(err, ErrSessionActiveTurn) {
		t.Fatalf("execBlocking error = %v, want ErrSessionActiveTurn", err)
	}
	if admittedErr := <-continuation.admitted; !errors.Is(admittedErr, ErrSessionActiveTurn) {
		t.Fatalf("admission error = %v, want ErrSessionActiveTurn", admittedErr)
	}
	if len(events) != 0 || len(streamed) != 0 {
		t.Fatalf("rejected continuation events = %#v, streamed = %#v; want none", events, streamed)
	}
}

func TestCodexAppServerAdapterSteerRoutesAgentTargetMention(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.holdTurn = true

	execDone := make(chan struct{})
	go func() {
		_, _ = adapter.Exec(context.Background(), session, textPrompt("long task"), "", "turn-local-1", nil, nil)
		close(execDone)
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	prompt := "让 [@Codex](mention://agent-target/local:codex?workspaceId=workspace-1) 来看下"
	events, err := adapter.Exec(context.Background(), session, textPrompt(prompt), "", "turn-agent-target-steer", nil, nil)
	if err != nil {
		t.Fatalf("steer Exec: %v", err)
	}
	steer := appServerRequestParams(t, transport.conn, appServerMethodTurnSteer)
	if asString(steer["expectedTurnId"]) != "turn-1" {
		t.Fatalf("turn/steer params = %#v", steer)
	}
	input, _ := steer["input"].([]any)
	if len(input) != 2 {
		t.Fatalf("turn/steer input = %#v, want user prompt plus internal routing prompt", steer["input"])
	}
	first, _ := input[0].(map[string]any)
	if asString(first["text"]) != prompt {
		t.Fatalf("turn/steer user text = %q, want %q", asString(first["text"]), prompt)
	}
	last, _ := input[len(input)-1].(map[string]any)
	if asString(last["text"]) != tuttiAgentMentionRoutingReminder {
		t.Fatalf("turn/steer routing text = %q, want %q", asString(last["text"]), tuttiAgentMentionRoutingReminder)
	}

	userContent := firstUserMessageContent(t, events)
	if userContent != prompt || strings.Contains(userContent, "system-reminder") {
		t.Fatalf("user activity content = %q, want original prompt only", userContent)
	}

	transport.server.completePendingTurn()
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatalf("original Exec did not finish")
	}
}
