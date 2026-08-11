package agentruntime

import (
	"context"
	"errors"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestClaudeSDKProviderAcceptanceHoldsCompactBannerUntilIdentity(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapterSession.providerSessionID = session.ProviderSessionID
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	emitted := make(chan activityshared.Event, 32)
	barrierEntered := make(chan ProviderAcceptanceReceipt, 1)
	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.ExecWithProviderAcceptance(
			ctx,
			session,
			[]PromptContentBlock{{Type: "text", Text: "/compact"}},
			"/compact",
			"turn-compact",
			func(events []activityshared.Event) {
				for _, event := range events {
					emitted <- event
				}
			},
			nil,
			func(ProviderDispatchResult) {},
			func(receipt ProviderAcceptanceReceipt) error {
				barrierEntered <- receipt
				return nil
			},
		)
		execDone <- err
	}()

	waitForClaudeSDKSentRequest(t, conn, "exec")
	select {
	case event := <-emitted:
		t.Fatalf("event %q escaped before durable acceptance", event.Type)
	case <-time.After(25 * time.Millisecond):
	}

	conn.pushEvent(claudeSDKSidecarEvent{
		Type: "compact_started",
		Payload: map[string]any{
			"turnId":  "turn-compact",
			"content": "Compacting...",
		},
	})
	select {
	case event := <-emitted:
		t.Fatalf("compact banner %q escaped before durable acceptance", event.Type)
	case <-time.After(25 * time.Millisecond):
	}

	conn.pushEvent(claudeSDKSidecarEvent{
		Type: "provider_turn_identity_resolved",
		Payload: map[string]any{
			"turnId":         "turn-compact",
			"providerTurnId": "provider-compact",
		},
	})
	select {
	case <-barrierEntered:
	case <-ctx.Done():
		t.Fatal("timed out waiting for acceptance barrier")
	}

	var sawCompactRunning bool
	deadline := time.After(2 * time.Second)
	for !sawCompactRunning {
		select {
		case event := <-emitted:
			if event.Type == activityshared.EventMessageAppended &&
				payloadString(event.Payload.Metadata, "noticeCommand") == "compact" &&
				payloadString(event.Payload.Metadata, "noticeCommandStatus") == "running" {
				sawCompactRunning = true
				if event.ProviderInputUnit != nil {
					t.Fatalf(
						"flushed compact still carries ProviderInputUnit %#v",
						event.ProviderInputUnit,
					)
				}
			}
		case <-deadline:
			t.Fatal("timed out waiting for held compact banner after acceptance")
		}
	}

	conn.pushEvent(claudeSDKSidecarEvent{
		Type: "turn_completed",
		Payload: map[string]any{
			"turnId":         "turn-compact",
			"providerTurnId": "provider-compact",
			"stopReason":     "end_turn",
		},
	})
	select {
	case err := <-execDone:
		if err != nil {
			t.Fatalf("ExecWithProviderAcceptance: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for turn completion")
	}
}

func TestClaudeSDKEventMayPrecedeProviderAcceptanceAllowsCompactNotice(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderClaudeCode)
	compact := claudeSDKCompactMessageEvent(
		session,
		"turn-compact",
		"claude-sdk:compact:turn-compact",
		messageStreamStateStreaming,
		"running",
		"",
	)
	if !claudeSDKEventMayPrecedeProviderAcceptance(compact) {
		t.Fatalf("compact notice must be holdable before provider acceptance: %#v", compact)
	}
	if !partitionClaudeSDKPreAcceptanceEvents(
		"turn-compact",
		[]activityshared.Event{compact},
	).safe() {
		t.Fatal("compact-only batch must precede provider acceptance")
	}
	if !isClaudeSDKCompactPrompt(
		[]PromptContentBlock{{Type: "text", Text: "/compact"}},
		"/compact",
	) {
		t.Fatal("expected /compact prompt detection")
	}
}

func TestPartitionClaudeSDKPreAcceptanceEventsDoesNotLetTerminalMaskProviderOutput(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderClaudeCode)
	turnID := "canonical-turn"
	local := newTurnActivityEvent(
		session,
		EventTurnStarted,
		turnID,
		SessionStatusWorking,
		"",
		"",
		nil,
	)
	terminal := newTurnActivityEvent(
		session,
		EventTurnFailed,
		turnID,
		SessionStatusFailed,
		"",
		"",
		map[string]any{"error": "provider failed"},
	)
	providerOutput := activityshared.Event{
		Type: activityshared.EventMessageAppended,
		Payload: activityshared.EventPayload{
			TurnID: turnID,
			Role:   activityshared.MessageRole("assistant"),
		},
	}

	partition := partitionClaudeSDKPreAcceptanceEvents(
		turnID,
		[]activityshared.Event{local, terminal, providerOutput},
	)
	if partition.safe() {
		t.Fatal("mixed terminal/provider-output batch must not cross acceptance")
	}
	if !partition.hasDirectCanonicalTerminal {
		t.Fatal("exact canonical terminal was not classified as authoritative")
	}
	if len(partition.allowed) != 2 || len(partition.providerDependent) != 1 {
		t.Fatalf("partition = %#v, want 2 allowed and 1 provider-dependent", partition)
	}
	if partition.providerDependent[0].Type != activityshared.EventMessageAppended {
		t.Fatalf("provider-dependent events = %#v", partition.providerDependent)
	}
}

func TestStripClaudeSDKHeldEventProviderInputUnits(t *testing.T) {
	t.Parallel()

	early := &activityshared.ProviderInputUnitContext{
		ConnectionID: "connection-1",
		ChunkSeq:     53,
		UnitIndex:    1,
		EventIndex:   1,
		UnitKind:     "protocol-message",
	}
	held := []activityshared.Event{
		{
			Type:              activityshared.EventMessageAppended,
			ProviderInputUnit: early,
		},
		{
			Type: activityshared.EventTurnStarted,
			ProviderInputUnit: &activityshared.ProviderInputUnitContext{
				ConnectionID: "connection-1",
				ChunkSeq:     52,
				UnitIndex:    1,
				EventIndex:   1,
			},
		},
	}
	stripped := stripClaudeSDKHeldEventProviderInputUnits(held)
	if len(stripped) != 2 {
		t.Fatalf("stripped=%#v", stripped)
	}
	for index, event := range stripped {
		if event.ProviderInputUnit != nil {
			t.Fatalf("event[%d] still has ProviderInputUnit %#v", index, event.ProviderInputUnit)
		}
	}
	if held[0].ProviderInputUnit == nil || *held[0].ProviderInputUnit != *early {
		t.Fatalf("strip mutated the held slice: %#v", held[0].ProviderInputUnit)
	}
}

func TestClaudeSDKProviderAcceptanceReportsPreDispatchFailures(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		configure func(*ClaudeCodeSDKAdapter, *claudeSDKAdapterSession)
	}{
		{
			name: "prompt image materialization",
			configure: func(adapter *ClaudeCodeSDKAdapter, _ *claudeSDKAdapterSession) {
				adapter.promptImageMaterializer = func(
					context.Context,
					[]PromptContentBlock,
				) ([]PromptContentBlock, error) {
					return nil, errors.New("signed image expired")
				}
			},
		},
		{
			name: "reader startup",
			configure: func(_ *ClaudeCodeSDKAdapter, session *claudeSDKAdapterSession) {
				session.reader = nil
			},
		},
		{
			name:      "sidecar send",
			configure: func(_ *ClaudeCodeSDKAdapter, _ *claudeSDKAdapterSession) {},
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			adapter := NewClaudeCodeSDKAdapter(nil)
			conn := &failingClaudeSDKConnection{}
			session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
			test.configure(adapter, adapterSession)
			dispatch := make(chan ProviderDispatchResult, 1)

			_, err := adapter.ExecWithProviderAcceptance(
				t.Context(),
				session,
				[]PromptContentBlock{{Type: "text", Text: "hello"}},
				"hello",
				"turn-pre-dispatch",
				nil,
				nil,
				func(result ProviderDispatchResult) {
					select {
					case dispatch <- result:
					default:
					}
				},
				nil,
			)
			if err == nil {
				t.Fatal("ExecWithProviderAcceptance() error=nil, want pre-dispatch failure")
			}
			select {
			case result := <-dispatch:
				if result.Disposition != DispatchDispositionNotDispatched ||
					result.Acceptance != nil {
					t.Fatalf("provider dispatch=%#v, want not_dispatched", result)
				}
			default:
				t.Fatal("provider dispatch was not reported")
			}
		})
	}
}

func TestClaudeSDKProviderAcceptanceReportsExplicitAuthenticationRejection(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapterSession.providerSessionID = session.ProviderSessionID
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	dispatch := make(chan ProviderDispatchResult, 1)
	emitted := make(chan activityshared.Event, 4)
	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.ExecWithProviderAcceptance(
			ctx,
			session,
			[]PromptContentBlock{{Type: "text", Text: "hello"}},
			"hello",
			"canonical-turn-rejected",
			func(events []activityshared.Event) {
				for _, event := range events {
					emitted <- event
				}
			},
			nil,
			func(result ProviderDispatchResult) {
				dispatch <- result
			},
			func(ProviderAcceptanceReceipt) error {
				return errors.New("acceptance barrier must not run")
			},
		)
		execDone <- err
	}()

	waitForClaudeSDKSentRequest(t, conn, "exec")
	conn.pushEvent(claudeSDKSidecarEvent{
		Type: "turn_failed",
		Payload: map[string]any{
			"turnId":              "canonical-turn-rejected",
			"dispatchDisposition": "rejected",
			"code":                "authentication_failed",
			"apiErrorStatus":      401,
			"error":               "Failed to authenticate. API Error: 401",
		},
	})

	select {
	case result := <-dispatch:
		if result.Disposition != DispatchDispositionRejected ||
			result.Acceptance != nil || result.Failure == nil {
			t.Fatalf("provider dispatch = %#v, want explicit rejection", result)
		}
		var appErr *AppError
		if !errors.As(result.Failure, &appErr) || appErr.Code != "auth_required" {
			t.Fatalf("provider failure = %#v, want auth_required AppError", result.Failure)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for provider rejection")
	}
	select {
	case err := <-execDone:
		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Code != "auth_required" {
			t.Fatalf("ExecWithProviderAcceptance error = %#v, want auth_required AppError", err)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for rejected execution")
	}
	select {
	case event := <-emitted:
		t.Fatalf("event %q escaped before rejected provider acceptance", event.Type)
	default:
	}
}

func TestClaudeSDKProviderlessFailureReturnsCanonicalTerminal(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapterSession.providerSessionID = session.ProviderSessionID
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	dispatch := make(chan ProviderDispatchResult, 1)
	emitted := make(chan activityshared.Event, 4)
	barrierEntered := make(chan struct{}, 1)
	type execOutcome struct {
		events []activityshared.Event
		err    error
	}
	execDone := make(chan execOutcome, 1)
	go func() {
		events, err := adapter.ExecWithProviderAcceptance(
			ctx,
			session,
			[]PromptContentBlock{{Type: "text", Text: "hello"}},
			"hello",
			"canonical-turn-providerless-failure",
			func(events []activityshared.Event) {
				for _, event := range events {
					emitted <- event
				}
			},
			nil,
			func(result ProviderDispatchResult) {
				dispatch <- result
			},
			func(ProviderAcceptanceReceipt) error {
				barrierEntered <- struct{}{}
				return nil
			},
		)
		execDone <- execOutcome{events: events, err: err}
	}()

	waitForClaudeSDKSentRequest(t, conn, "exec")
	conn.pushEvent(claudeSDKSidecarEvent{
		Type: "turn_failed",
		Payload: map[string]any{
			"turnId": "canonical-turn-providerless-failure",
			"code":   "execution_failed",
			"error":  "Claude execution failed before identity resolution",
		},
	})

	select {
	case outcome := <-execDone:
		if outcome.err == nil {
			t.Fatal("ExecWithProviderAcceptance error=nil, want providerless failure")
		}
		var terminal *activityshared.Event
		for index := range outcome.events {
			if outcome.events[index].Type == activityshared.EventTurnFailed &&
				outcome.events[index].Payload.TurnID == "canonical-turn-providerless-failure" {
				terminal = &outcome.events[index]
				break
			}
		}
		if terminal == nil {
			t.Fatalf("events = %#v, want exact canonical turn.failed", outcome.events)
		}
		partition := partitionClaudeSDKPreAcceptanceEvents(
			"canonical-turn-providerless-failure",
			outcome.events,
		)
		if !partition.safe() {
			t.Fatalf(
				"provider-dependent events escaped before acceptance: %#v",
				partition.providerDependent,
			)
		}
		if got := payloadString(terminal.Payload.Metadata, "dispatchDisposition"); got != "" {
			t.Fatalf("dispatchDisposition = %q, want provider-neutral terminal", got)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for providerless terminal")
	}
	select {
	case result := <-dispatch:
		t.Fatalf("provider dispatch = %#v, want no provider identity disposition", result)
	default:
	}
	select {
	case <-barrierEntered:
		t.Fatal("provider acceptance barrier ran without a provider Turn identity")
	default:
	}
	select {
	case event := <-emitted:
		t.Fatalf("event %q escaped before providerless terminal return", event.Type)
	default:
	}
}

func TestClaudeSDKProviderAcceptanceUsesRecoveredSidecarIdentityBeforeCompletion(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapterSession.providerSessionID = session.ProviderSessionID
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	dispatch := make(chan ProviderDispatchResult, 1)
	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.ExecWithProviderAcceptance(
			ctx,
			session,
			[]PromptContentBlock{{Type: "text", Text: "hello"}},
			"hello",
			"canonical-turn",
			nil,
			nil,
			func(result ProviderDispatchResult) {
				dispatch <- result
			},
			func(receipt ProviderAcceptanceReceipt) error {
				dispatch <- ProviderDispatchResult{
					Disposition: DispatchDispositionApplied,
					Acceptance:  &receipt,
				}
				return nil
			},
		)
		execDone <- err
	}()

	waitForClaudeSDKSentRequest(t, conn, "exec")
	conn.pushEvent(claudeSDKSidecarEvent{
		Type: "provider_turn_identity_resolved",
		Payload: map[string]any{
			"turnId":         "canonical-turn",
			"providerTurnId": "persisted-claude-user-uuid",
		},
	})
	conn.pushEvent(claudeSDKSidecarEvent{
		Type: "provider_turn_checkpoint",
		Payload: map[string]any{
			"turnId":                      "canonical-turn",
			"providerTurnId":              "persisted-claude-user-uuid",
			"providerCheckpointMessageId": "persisted-claude-assistant-uuid",
		},
	})
	conn.pushEvent(claudeSDKSidecarEvent{
		Type: "turn_completed",
		Payload: map[string]any{
			"turnId":         "canonical-turn",
			"providerTurnId": "persisted-claude-user-uuid",
			"stopReason":     "end_turn",
		},
	})

	select {
	case result := <-dispatch:
		if result.Disposition != DispatchDispositionApplied ||
			result.Acceptance == nil ||
			result.Acceptance.ProviderSessionID != session.ProviderSessionID ||
			result.Acceptance.ProviderTurnID != "persisted-claude-user-uuid" {
			t.Fatalf("provider dispatch = %#v, want recovered durable identity", result)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for provider acceptance")
	}
	select {
	case err := <-execDone:
		if err != nil {
			t.Fatalf("ExecWithProviderAcceptance: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for turn completion")
	}
}

func TestClaudeSDKDurableAcceptanceBlocksInteractionPublication(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapterSession.providerSessionID = session.ProviderSessionID
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	emitted := make(chan activityshared.Event, 16)
	barrierEntered := make(chan ProviderAcceptanceReceipt, 1)
	releaseBarrier := make(chan struct{})
	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.ExecWithProviderAcceptance(
			ctx,
			session,
			[]PromptContentBlock{{Type: "text", Text: "write a file"}},
			"write a file",
			"canonical-turn",
			func(events []activityshared.Event) {
				for _, event := range events {
					emitted <- event
				}
			},
			nil,
			func(ProviderDispatchResult) {},
			func(receipt ProviderAcceptanceReceipt) error {
				barrierEntered <- receipt
				select {
				case <-releaseBarrier:
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			},
		)
		execDone <- err
	}()

	waitForClaudeSDKSentRequest(t, conn, "exec")
	for {
		select {
		case <-emitted:
			continue
		default:
		}
		break
	}
	conn.pushEvent(claudeSDKSidecarEvent{
		Type: "provider_turn_identity_resolved",
		Payload: map[string]any{
			"turnId":         "canonical-turn",
			"providerTurnId": "provider-turn",
		},
	})
	select {
	case receipt := <-barrierEntered:
		if receipt.ProviderTurnID != "provider-turn" {
			t.Fatalf("acceptance receipt = %#v", receipt)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for acceptance barrier")
	}
	conn.pushEvent(claudeSDKSidecarEvent{
		Type: "approval_requested",
		Payload: map[string]any{
			"turnId":     "canonical-turn",
			"requestId":  "approval-1",
			"toolCallId": "toolu-write",
			"toolName":   "Write",
			"input":      map[string]any{"file_path": "/workspace/file.txt"},
			"options": []any{
				map[string]any{
					"kind":     "allow_once",
					"name":     "Allow",
					"optionId": "allow",
				},
			},
		},
	})
	select {
	case event := <-emitted:
		t.Fatalf("event %q escaped before durable acceptance", event.Type)
	case <-time.After(25 * time.Millisecond):
	}

	close(releaseBarrier)
	var ordered []activityshared.EventType
	for len(ordered) < 8 {
		select {
		case event := <-emitted:
			ordered = append(ordered, event.Type)
			if event.Type == activityshared.EventInteractionRequested {
				goto interactionObserved
			}
		case <-ctx.Done():
			t.Fatal("timed out waiting for accepted interaction")
		}
	}

interactionObserved:
	startedIndex := -1
	interactionIndex := -1
	for index, eventType := range ordered {
		switch eventType {
		case activityshared.EventRootProviderTurnStarted:
			startedIndex = index
		case activityshared.EventInteractionRequested:
			interactionIndex = index
		}
	}
	if startedIndex < 0 || interactionIndex <= startedIndex {
		t.Fatalf("published order = %#v, want started before interaction", ordered)
	}

	conn.pushEvent(claudeSDKSidecarEvent{
		Type: "turn_completed",
		Payload: map[string]any{
			"turnId":         "canonical-turn",
			"providerTurnId": "provider-turn",
			"stopReason":     "end_turn",
		},
	})
	select {
	case err := <-execDone:
		if err != nil {
			t.Fatalf("ExecWithProviderAcceptance: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for turn completion")
	}
}
