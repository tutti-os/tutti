package agentruntime

import (
	"context"
	"errors"
	"strings"
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
	var compactUnit *activityshared.ProviderInputUnitContext
	var identityUnit *activityshared.ProviderInputUnitContext
	deadline := time.After(2 * time.Second)
	for !sawCompactRunning {
		select {
		case event := <-emitted:
			if event.Type == activityshared.EventRootProviderTurnStarted &&
				strings.TrimSpace(event.Payload.TurnID) == "turn-compact" {
				identityUnit = event.ProviderInputUnit
			}
			if event.Type == activityshared.EventMessageAppended &&
				payloadString(event.Payload.Metadata, "noticeCommand") == "compact" &&
				payloadString(event.Payload.Metadata, "noticeCommandStatus") == "running" {
				sawCompactRunning = true
				compactUnit = event.ProviderInputUnit
			}
		case <-deadline:
			t.Fatal("timed out waiting for held compact banner after acceptance")
		}
	}
	if identityUnit != nil && compactUnit != nil && *identityUnit != *compactUnit {
		t.Fatalf(
			"flushed compact ProviderInputUnit=%#v, want acceptance unit %#v",
			compactUnit,
			identityUnit,
		)
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
	if !claudeSDKEventsMayPrecedeProviderAcceptance([]activityshared.Event{compact}) {
		t.Fatal("compact-only batch must precede provider acceptance")
	}
	if !isClaudeSDKCompactPrompt(
		[]PromptContentBlock{{Type: "text", Text: "/compact"}},
		"/compact",
	) {
		t.Fatal("expected /compact prompt detection")
	}
}

func TestRestampClaudeSDKHeldEventsOntoAcceptanceUnit(t *testing.T) {
	t.Parallel()

	acceptance := &activityshared.ProviderInputUnitContext{
		ConnectionID: "connection-1",
		ChunkSeq:     62,
		UnitIndex:    1,
		EventIndex:   1,
		UnitKind:     "protocol-message",
	}
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
		},
	}
	restamped := restampClaudeSDKHeldEventsOntoAcceptanceUnit(held, acceptance)
	if len(restamped) != 2 {
		t.Fatalf("restamped=%#v", restamped)
	}
	for index, event := range restamped {
		if event.ProviderInputUnit == nil ||
			*event.ProviderInputUnit != *acceptance {
			t.Fatalf(
				"event[%d] ProviderInputUnit=%#v, want acceptance unit %#v",
				index,
				event.ProviderInputUnit,
				acceptance,
			)
		}
	}
	if held[0].ProviderInputUnit == nil || *held[0].ProviderInputUnit != *early {
		t.Fatalf("restamp mutated the held slice: %#v", held[0].ProviderInputUnit)
	}
	identity := []activityshared.Event{{
		Type: activityshared.EventRootProviderTurnStarted,
		Payload: activityshared.EventPayload{
			TurnID:         "turn-compact",
			ProviderTurnID: "provider-compact",
		},
		ProviderInputUnit: acceptance,
	}}
	if got := claudeSDKAcceptanceProviderInputUnit(identity, "turn-compact"); got == nil ||
		*got != *acceptance {
		t.Fatalf("acceptance unit=%#v, want %#v", got, acceptance)
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
