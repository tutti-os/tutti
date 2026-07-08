package agentruntime

import (
	"context"
	"strings"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestACPRetriableTurnTailError(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		text     string
		wantLine string
		want     bool
	}{
		{
			name:     "cursor retriable tail",
			text:     "\n\nError: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)",
			wantLine: "Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)",
			want:     true,
		},
		{
			name:     "connect error tail after normal text",
			text:     "Checking the repo.\nError: ConnectError: [unavailable] upstream connect error",
			wantLine: "Error: ConnectError: [unavailable] upstream connect error",
			want:     true,
		},
		{
			name: "error line followed by recovery is not a tail",
			text: "Error: RetriableError: hiccup\nall good now",
			want: false,
		},
		{
			name: "plain completion",
			text: "Done. The PR is open.",
			want: false,
		},
		{
			name: "empty",
			text: "",
			want: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			line, ok := acpRetriableTurnTailError(tc.text)
			if ok != tc.want || line != tc.wantLine {
				t.Fatalf("acpRetriableTurnTailError(%q) = %q, %v; want %q, %v", tc.text, line, ok, tc.wantLine, tc.want)
			}
		})
	}
}

func acpTestPromptText(params map[string]any) string {
	blocks, _ := params["prompt"].([]any)
	var b strings.Builder
	for _, raw := range blocks {
		block, _ := raw.(map[string]any)
		if asString(block["type"]) == "text" {
			b.WriteString(asString(block["text"]))
		}
	}
	return b.String()
}

// A cursor turn that ends "successfully" right after streaming a transient
// network error must be resumed automatically with a synthetic continue
// prompt, and the recovered turn must complete normally.
func TestCursorAdapterAutoContinuesAfterRetriableTurnError(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-1")
	transport.conn.retriableErrorPrompts = 1
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "cursor-session-1"

	events, err := adapter.Exec(context.Background(), session, textPrompt("build the report"), "", "turn-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	transport.conn.mu.Lock()
	promptCalls := transport.conn.promptCallCount
	snapshots := append([]map[string]any(nil), transport.conn.promptParamsSnapshots...)
	transport.conn.mu.Unlock()
	if promptCalls != 2 {
		t.Fatalf("prompt calls = %d, want the auto-continue to send a second prompt", promptCalls)
	}
	if text := acpTestPromptText(snapshots[1]); !strings.Contains(text, "transient network error") {
		t.Fatalf("continue prompt = %q, want the synthetic continue text", text)
	}

	var sawRetryNotice, sawCompleted, sawFailed bool
	for _, event := range events {
		if event.Type == activityshared.EventMessageAppended &&
			asString(event.Payload.Metadata["noticeKind"]) == "transport_retry" {
			sawRetryNotice = true
		}
		if event.Type == activityshared.EventTurnCompleted {
			sawCompleted = true
		}
		if event.Type == activityshared.EventTurnFailed {
			sawFailed = true
		}
	}
	if !sawRetryNotice {
		t.Fatalf("events = %#v, want a transport_retry system notice", activityEventTypeCounts(events))
	}
	if !sawCompleted || sawFailed {
		t.Fatalf("turn terminal events completed=%v failed=%v, want completed only", sawCompleted, sawFailed)
	}
}

// A continuation attempt that recovers with tool calls only (no new assistant
// text) must not re-detect the previous attempt's error tail: the turn
// completes after a single auto-continue instead of burning the remaining
// retries on stale text and surfacing a false failure.
func TestCursorAdapterAutoContinueToolOnlyContinuationCompletes(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-1")
	transport.conn.retriableErrorPrompts = 1
	transport.conn.omitAssistantTextInPromptResults = true
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "cursor-session-1"

	events, err := adapter.Exec(context.Background(), session, textPrompt("build the report"), "", "turn-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	transport.conn.mu.Lock()
	promptCalls := transport.conn.promptCallCount
	transport.conn.mu.Unlock()
	if promptCalls != 2 {
		t.Fatalf("prompt calls = %d, want exactly one auto-continue for a tool-only recovery", promptCalls)
	}

	var sawCompleted, sawFailed bool
	for _, event := range events {
		if event.Type == activityshared.EventTurnCompleted {
			sawCompleted = true
		}
		if event.Type == activityshared.EventTurnFailed {
			sawFailed = true
		}
	}
	if !sawCompleted || sawFailed {
		t.Fatalf("turn terminal events completed=%v failed=%v, want completed only", sawCompleted, sawFailed)
	}
}

// When every continue attempt is also cut short, the turn must surface as
// failed instead of a silent "completed" that strands the conversation.
func TestCursorAdapterAutoContinueExhaustedMarksTurnFailed(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-1")
	transport.conn.retriableErrorPrompts = 100
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "cursor-session-1"

	events, err := adapter.Exec(context.Background(), session, textPrompt("build the report"), "", "turn-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	transport.conn.mu.Lock()
	promptCalls := transport.conn.promptCallCount
	transport.conn.mu.Unlock()
	if want := 1 + acpAutoContinueMaxAttempts; promptCalls != want {
		t.Fatalf("prompt calls = %d, want %d (original + bounded retries)", promptCalls, want)
	}

	var failedError string
	var sawCompleted bool
	for _, event := range events {
		if event.Type == activityshared.EventTurnFailed {
			failedError = asString(event.Payload.Metadata["error"])
		}
		if event.Type == activityshared.EventTurnCompleted {
			sawCompleted = true
		}
	}
	if !strings.Contains(failedError, "RetriableError") {
		t.Fatalf("turn failed error = %q, want the retriable error line", failedError)
	}
	if sawCompleted {
		t.Fatal("turn must not also report completion after exhausting retries")
	}
}

// Providers without the auto-continue opt-in must keep the old behavior: the
// error tail stays a plain completed turn and no synthetic prompt is sent.
func TestStandardACPAdapterWithoutOptInDoesNotAutoContinue(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-1")
	transport.conn.retriableErrorPrompts = 1
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "hermes-session-1"

	events, err := adapter.Exec(context.Background(), session, textPrompt("build the report"), "", "turn-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	transport.conn.mu.Lock()
	promptCalls := transport.conn.promptCallCount
	transport.conn.mu.Unlock()
	if promptCalls != 1 {
		t.Fatalf("prompt calls = %d, want no auto-continue without the opt-in", promptCalls)
	}
	for _, event := range events {
		if event.Type == activityshared.EventTurnFailed {
			t.Fatalf("event = %#v, want the legacy completed turn", event)
		}
	}
}
