package agentruntime

import (
	"context"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"strings"
	"testing"
)

func TestCodexAppServerAdapterSlashCompact(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	dispatches := make(chan ProviderDispatchResult, 1)
	events, err := adapter.ExecWithProviderAcceptance(
		context.Background(),
		session,
		[]PromptContentBlock{{
			Type: "text", Text: "/compact",
		}},
		"",
		"turn-local-1",
		nil,
		nil,
		func(result ProviderDispatchResult) { dispatches <- result },
		nil,
	)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	dispatch := <-dispatches
	if dispatch.Disposition != DispatchDispositionAppliedWithoutProviderTurn ||
		dispatch.Acceptance != nil {
		t.Fatalf("compact dispatch = %#v", dispatch)
	}
	compact := appServerRequestParams(t, transport.conn, appServerMethodThreadCompact)
	if asString(compact["threadId"]) != "codex-thread-1" {
		t.Fatalf("compact params = %#v", compact)
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnStart); len(requests) != 0 {
		t.Fatalf("turn/start should not run for /compact")
	}
	// "Context compacted." must arrive via item/completed through the
	// session-level handler — not as a locally-emitted terminal message.
	var gotCompactedBanner bool
	bannerIndex := -1
	progressIndex := -1
	terminalIndex := -1
	for index, event := range events {
		if event.Payload.Content == "Compacting context." && progressIndex == -1 {
			progressIndex = index
		}
		if event.Payload.Content == "Context compacted." {
			gotCompactedBanner = true
			bannerIndex = index
		}
		if event.Type == activityshared.EventTurnCompleted && terminalIndex == -1 {
			terminalIndex = index
		}
	}
	if !gotCompactedBanner {
		t.Fatalf("expected 'Context compacted.' banner in compact events; got %#v", events)
	}
	if progressIndex == -1 || progressIndex > bannerIndex {
		t.Fatalf("compacting progress banner index = %d, completed banner index = %d, events = %#v", progressIndex, bannerIndex, events)
	}
	if terminalIndex == -1 || bannerIndex == -1 || bannerIndex > terminalIndex {
		t.Fatalf("compact banner index = %d, terminal index = %d, events = %#v", bannerIndex, terminalIndex, events)
	}
	if completed := eventsOfType(events, activityshared.EventTurnCompleted); len(completed) != 1 {
		t.Fatalf("compact turn completed events = %d, want 1", len(completed))
	}
}

// Codex app-server frequently finishes thread/compact/start (turn/started →
// turn/completed) without ever streaming a contextCompaction item/started or
// item/completed notification. This used to leave /compact completely
// invisible in the transcript: no "Compacting context." banner (nothing
// rendered while it ran) and no "Context compacted." banner (nothing showed
// it finished either), because both banners were driven exclusively by the
// server's item notifications. The client must show the progress banner up
// front and settle it at turn completion even when the server stays silent.
func TestCodexAppServerAdapterSlashCompactWhenServerStaysSilent(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.compactSilent = true
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/compact",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	var progressCount, completedCount int
	var progressMessageID, completedMessageID string
	for _, event := range events {
		switch event.Payload.Content {
		case "Compacting context.":
			progressCount++
			progressMessageID = asString(event.Payload.Metadata["messageId"])
		case "Context compacted.":
			completedCount++
			completedMessageID = asString(event.Payload.Metadata["messageId"])
		}
	}
	if progressCount != 1 {
		t.Fatalf("progress banners = %d, want exactly 1 (silent server must not leave /compact invisible); events = %#v", progressCount, events)
	}
	if completedCount != 1 {
		t.Fatalf("completed banners = %d, want exactly 1 (silent server must still settle the banner); events = %#v", completedCount, events)
	}
	if progressMessageID == "" || progressMessageID != completedMessageID {
		t.Fatalf("messageId mismatch: progress %q, completed %q", progressMessageID, completedMessageID)
	}
	if completed := eventsOfType(events, activityshared.EventTurnCompleted); len(completed) != 1 {
		t.Fatalf("compact turn completed events = %d, want 1", len(completed))
	}
}

func TestCodexAppServerAdapterSlashReview(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	dispatches := make(chan ProviderDispatchResult, 1)
	events, err := adapter.ExecWithProviderAcceptance(
		context.Background(),
		session,
		[]PromptContentBlock{{
			Type: "text", Text: "/review check the auth flow",
		}},
		"",
		"turn-local-1",
		nil,
		nil,
		func(result ProviderDispatchResult) { dispatches <- result },
		func(receipt ProviderAcceptanceReceipt) error {
			dispatches <- ProviderDispatchResult{
				Disposition: DispatchDispositionApplied,
				Acceptance:  &receipt,
			}
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	dispatch := <-dispatches
	if dispatch.Disposition != DispatchDispositionApplied ||
		dispatch.Acceptance == nil ||
		dispatch.Acceptance.ProviderSessionID != "codex-thread-1" ||
		dispatch.Acceptance.ProviderTurnID != "turn-review" {
		t.Fatalf("review dispatch = %#v", dispatch)
	}
	review := appServerRequestParams(t, transport.conn, appServerMethodReviewStart)
	target := payloadObject(review["target"])
	if asString(target["type"]) != "custom" || asString(target["instructions"]) != "check the auth flow" {
		t.Fatalf("review target = %#v", target)
	}
	if asString(review["summary"]) != "auto" {
		t.Fatalf("review/start summary = %q, want auto", review["summary"])
	}
	var assistantText string
	for _, event := range eventsOfType(events, activityshared.EventMessageAppended) {
		if event.Payload.Role == activityshared.MessageRoleAssistant {
			assistantText = event.Payload.Content
		}
	}
	if assistantText != "Found one issue." {
		t.Fatalf("review assistant message = %q", assistantText)
	}
	if completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted); len(completed) != 1 {
		t.Fatalf("review turn completed events = %d, want 1", len(completed))
	}
}

func TestCodexAppServerAdapterSlashReviewInlineReasoning(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.reviewInline = true
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/review check the auth flow",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	// Inline reasoning items must surface as finalized thinking so they break
	// the otherwise-unbroken tool-call streak in the GUI.
	thinking := activityMessagesWithRole(events, activityshared.MessageRoleAssistantThinking)
	sawReasoningText := false
	for _, event := range thinking {
		if event.Payload.Metadata["messageKind"] != "review-process" {
			t.Fatalf("thinking messageKind = %#v, want review-process", event.Payload.Metadata["messageKind"])
		}
		if strings.Contains(event.Payload.Content, "Inspecting the auth flow.") {
			sawReasoningText = true
		}
	}
	if !sawReasoningText {
		t.Fatalf("expected reasoning to surface as thinking, got %#v", thinking)
	}

	// Reasoning streamed and finalized exactly once (no double-append).
	if strings.Count(lastThinkingContent(thinking), "Inspecting the auth flow.") != 1 {
		t.Fatalf("reasoning text duplicated in thinking: %q", lastThinkingContent(thinking))
	}

	assistantText := ""
	for _, event := range activityMessagesWithRole(events, activityshared.MessageRoleAssistant) {
		assistantText = event.Payload.Content
	}
	if assistantText != "Found one issue." {
		t.Fatalf("review assistant message = %q", assistantText)
	}

	if completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted); len(completed) != 1 {
		t.Fatalf("review turn completed events = %d, want 1", len(completed))
	}
}

func TestAppServerReasoningText(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		item map[string]any
		want string
	}{
		{
			name: "string summary array",
			item: map[string]any{
				"summary": []any{"Inspecting the auth flow."},
			},
			want: "Inspecting the auth flow.",
		},
		{
			name: "plain string summary",
			item: map[string]any{
				"summary": "Inspecting the auth flow.",
			},
			want: "Inspecting the auth flow.",
		},
		{
			name: "object summary sections",
			item: map[string]any{
				"summary": []any{map[string]any{"text": "Inspecting the auth flow."}},
			},
			want: "Inspecting the auth flow.",
		},
		{
			name: "top-level text fallback",
			item: map[string]any{
				"summary": []any{},
				"content": []any{},
				"text":    "Inspecting the auth flow.",
			},
			want: "Inspecting the auth flow.",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := appServerReasoningText(tt.item); got != tt.want {
				t.Fatalf("appServerReasoningText() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestAppServerReasoningDeltaTextPreservesWhitespace(t *testing.T) {
	t.Parallel()

	if got := appServerReasoningDeltaText(map[string]any{"delta": "Need "}); got != "Need " {
		t.Fatalf("delta text = %q, want trailing space preserved", got)
	}
	if got := appServerReasoningDeltaText(map[string]any{"text": "still "}); got != "still " {
		t.Fatalf("fallback text = %q, want trailing space preserved", got)
	}
	if got := appServerReasoningDeltaText(map[string]any{"text": " more"}); got != " more" {
		t.Fatalf("text fallback = %q, want leading space preserved", got)
	}
}

func TestCodexAppServerAdapterSlashReviewInlineReasoningSummaryDelta(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.reviewInline = true
	transport.server.reviewInlineSummaryDelta = true
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/review check the auth flow",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	thinking := activityMessagesWithRole(events, activityshared.MessageRoleAssistantThinking)
	if len(thinking) == 0 {
		t.Fatalf("expected streamed reasoning to surface as thinking, got none")
	}
	finalContent := thinking[len(thinking)-1].Payload.Content
	if finalContent != "Inspecting the auth flow." {
		t.Fatalf("thinking content = %q, want authoritative completed summary text", finalContent)
	}
	if thinking[len(thinking)-1].Payload.Metadata["messageKind"] != "review-process" {
		t.Fatalf("messageKind = %#v, want review-process", thinking[len(thinking)-1].Payload.Metadata["messageKind"])
	}
}

func lastThinkingContent(thinking []activityshared.Event) string {
	content := ""
	for _, event := range thinking {
		content = event.Payload.Content
	}
	return content
}

func TestCodexAppServerAdapterSlashReviewCancel(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.reviewHang = true
	entered := make(chan struct{})
	transport.server.reviewStartEntered = entered

	ctx, cancel := context.WithCancel(context.Background())
	type execResult struct {
		events []activityshared.Event
		err    error
	}
	resultCh := make(chan execResult, 1)
	go func() {
		events, err := adapter.Exec(ctx, session, []PromptContentBlock{{
			Type: "text", Text: "/review",
		}}, "", "turn-local-1", nil, nil)
		resultCh <- execResult{events: events, err: err}
	}()

	<-entered
	cancel()
	res := <-resultCh
	if res.err != nil {
		t.Fatalf("Exec: %v", res.err)
	}

	// A canceled review must report as canceled (interrupted), not failed,
	// mirroring a normal turn.
	if failed := eventsOfType(res.events, activityshared.EventTurnFailed); len(failed) != 0 {
		t.Fatalf("canceled review emitted %d turn.failed events, want 0", len(failed))
	}
	sawCanceled := false
	for _, event := range eventsOfType(res.events, activityshared.EventTurnCompleted) {
		if event.Payload.TurnOutcome == string(activityshared.TurnOutcomeInterrupted) {
			sawCanceled = true
		}
	}
	if !sawCanceled {
		t.Fatalf("canceled review missing interrupted turn outcome: %#v", res.events)
	}
}

func TestCodexAppServerAdapterSlashReviewDefaultsToUncommitted(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/review",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	review := appServerRequestParams(t, transport.conn, appServerMethodReviewStart)
	if asString(payloadObject(review["target"])["type"]) != "uncommittedChanges" {
		t.Fatalf("review target = %#v, want uncommittedChanges", review["target"])
	}
}

func TestCodexAppServerAdapterSlashReviewUncommittedKeyword(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/review uncommitted",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	review := appServerRequestParams(t, transport.conn, appServerMethodReviewStart)
	if asString(payloadObject(review["target"])["type"]) != "uncommittedChanges" {
		t.Fatalf("review target = %#v, want uncommittedChanges", review["target"])
	}
}

func TestAppServerReviewTargetParsing(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		args string
		want map[string]any
	}{
		{name: "empty", args: "", want: map[string]any{"type": "uncommittedChanges"}},
		{name: "blank", args: "   ", want: map[string]any{"type": "uncommittedChanges"}},
		{name: "uncommitted keyword", args: "uncommitted", want: map[string]any{"type": "uncommittedChanges"}},
		{name: "base branch", args: "base:main", want: map[string]any{"type": "baseBranch", "branch": "main"}},
		{name: "base branch slashes", args: "base:feature/x", want: map[string]any{"type": "baseBranch", "branch": "feature/x"}},
		{name: "commit", args: "commit:abc123", want: map[string]any{"type": "commit", "sha": "abc123"}},
		{name: "custom keyword", args: "custom:check the auth flow", want: map[string]any{"type": "custom", "instructions": "check the auth flow"}},
		{name: "free text stays custom", args: "check the auth flow", want: map[string]any{"type": "custom", "instructions": "check the auth flow"}},
		// Collision guard: free text starting with a keyword but no colon must
		// not be parsed as a structured target.
		{name: "base no colon", args: "base our error handling", want: map[string]any{"type": "custom", "instructions": "base our error handling"}},
		// Unknown keyword before a colon falls back to a full custom prompt.
		{name: "unknown keyword colon", args: "fix the bug: it crashes", want: map[string]any{"type": "custom", "instructions": "fix the bug: it crashes"}},
		// Empty payload after a keyword falls back to custom.
		{name: "base empty", args: "base:", want: map[string]any{"type": "custom", "instructions": "base:"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := appServerReviewTarget(tc.args)
			if len(got) != len(tc.want) {
				t.Fatalf("target = %#v, want %#v", got, tc.want)
			}
			for key, want := range tc.want {
				if asString(got[key]) != want {
					t.Fatalf("target[%q] = %v, want %v", key, got[key], want)
				}
			}
		})
	}
}

func TestCodexAppServerAdapterReviewBannersEmitOnce(t *testing.T) {
	t.Parallel()

	adapter := &CodexAppServerAdapter{}
	session := Session{Provider: "codex", AgentSessionID: "agent-review", RoomID: "room-review"}

	countNotice := func(itemType, wantTitle string) int {
		// Real app-server streams both item/started and item/completed for
		// review/compaction items; the banner must appear exactly once.
		normalizer := newACPTurnNormalizer()
		item := map[string]any{"type": itemType, "id": "item-1"}
		events := adapter.appServerItemEvents(session, "turn-review", item, false, normalizer)
		events = append(events, adapter.appServerItemEvents(session, "turn-review", item, true, normalizer)...)
		count := 0
		for _, event := range events {
			if event.Payload.Content == wantTitle {
				count++
			}
		}
		return count
	}

	if got := countNotice("enteredReviewMode", "Code review started."); got != 1 {
		t.Fatalf("entered review banners = %d, want exactly 1", got)
	}
	if got := countNotice("exitedReviewMode", "Code review finished."); got != 1 {
		t.Fatalf("exited review banners = %d, want exactly 1", got)
	}
	if got := countNotice("contextCompaction", "Context compacted."); got != 1 {
		t.Fatalf("context compaction banners = %d, want exactly 1", got)
	}
	if got := countNotice("contextCompaction", "Compacting context."); got != 1 {
		t.Fatalf("context compaction progress banners = %d, want exactly 1", got)
	}
}

// The in-progress banner and the completed banner must share one messageId so
// the completed notice replaces the progress notice in place instead of
// leaving a stale "Compacting context." row in the transcript.
func TestCodexAppServerAdapterCompactionBannersShareMessageID(t *testing.T) {
	t.Parallel()

	adapter := &CodexAppServerAdapter{}
	session := Session{Provider: "codex", AgentSessionID: "agent-compact", RoomID: "room-compact"}
	normalizer := newACPTurnNormalizer()
	item := map[string]any{"type": "contextCompaction", "id": "item-compact-1"}

	started := adapter.appServerItemEvents(session, "turn-1", item, false, normalizer)
	completed := adapter.appServerItemEvents(session, "turn-1", item, true, normalizer)
	if len(started) != 1 || len(completed) != 1 {
		t.Fatalf("compaction events = %d started, %d completed, want 1 each", len(started), len(completed))
	}
	if got := started[0].Payload.Content; got != "Compacting context." {
		t.Fatalf("started banner = %q, want %q", got, "Compacting context.")
	}
	if got := completed[0].Payload.Content; got != "Context compacted." {
		t.Fatalf("completed banner = %q, want %q", got, "Context compacted.")
	}
	if got := asString(completed[0].Payload.Metadata["noticeCommandStatus"]); got != "completed" {
		t.Fatalf("completed banner status = %q, want completed", got)
	}
	startedID := asString(started[0].Payload.Metadata["messageId"])
	completedID := asString(completed[0].Payload.Metadata["messageId"])
	if startedID == "" || startedID != completedID {
		t.Fatalf("messageId mismatch: started %q, completed %q", startedID, completedID)
	}
	// The explicit provider terminal won first, so a later synthesized turn
	// terminal must not rewrite the lifecycle to canceled.
	for _, event := range normalizer.FinishInterrupted(session, "turn-1", "interrupted") {
		if asString(event.Payload.Metadata["noticeCommand"]) == "compact" {
			t.Fatalf("completed compaction was overwritten by turn interruption: %#v", event)
		}
	}
}

// A turn that dies mid-compaction must settle the in-progress banner in place;
// otherwise the transcript keeps a live "Compacting context." row ticking
// forever after the failure.
func TestCodexAppServerAdapterCompactionBannerSettlesOnInterrupt(t *testing.T) {
	t.Parallel()

	adapter := &CodexAppServerAdapter{}
	session := Session{Provider: "codex", AgentSessionID: "agent-compact", RoomID: "room-compact"}
	normalizer := newACPTurnNormalizer()
	item := map[string]any{"type": "contextCompaction", "id": "item-compact-1"}

	started := adapter.appServerItemEvents(session, "turn-1", item, false, normalizer)
	if len(started) != 1 {
		t.Fatalf("compaction started events = %d, want 1", len(started))
	}
	terminal := normalizer.FinishInterrupted(session, "turn-1", "interrupted")
	var settled *activityshared.Event
	for index := range terminal {
		if terminal[index].Payload.Content == "Context compaction interrupted." {
			settled = &terminal[index]
		}
	}
	if settled == nil {
		t.Fatalf("expected interrupted compaction banner in terminal events; got %#v", terminal)
		return
	}
	if got, want := asString(settled.Payload.Metadata["messageId"]), asString(started[0].Payload.Metadata["messageId"]); got != want || got == "" {
		t.Fatalf("interrupted banner messageId = %q, want %q", got, want)
	}
	if got := asString(settled.Payload.Metadata["noticeCommand"]); got != "compact" {
		t.Fatalf("interrupted banner command = %q, want compact", got)
	}
	if got := asString(settled.Payload.Metadata["noticeCommandStatus"]); got != "canceled" {
		t.Fatalf("interrupted banner status = %q, want canceled", got)
	}
	// The synthesized canceled terminal won first. A provider completion that
	// was already in flight must be ignored rather than replacing it.
	if late := adapter.appServerItemEvents(session, "turn-1", item, true, normalizer); len(late) != 0 {
		t.Fatalf("late compaction completion emitted after cancellation: %#v", late)
	}
	// Once settled, later terminal calls must not emit the banner again.
	if again := normalizer.FinishFailed(session, "turn-1"); len(again) != 0 {
		for _, event := range again {
			if event.Payload.Content == "Context compaction interrupted." {
				t.Fatalf("compaction banner settled twice: %#v", again)
			}
		}
	}
}

func TestCodexAppServerAdapterCompactionBannerSettlesOnFailure(t *testing.T) {
	t.Parallel()

	adapter := &CodexAppServerAdapter{}
	session := Session{Provider: "codex", AgentSessionID: "agent-compact", RoomID: "room-compact"}
	normalizer := newACPTurnNormalizer()
	item := map[string]any{"type": "contextCompaction", "id": "item-compact-1"}

	if started := adapter.appServerItemEvents(session, "turn-1", item, false, normalizer); len(started) != 1 {
		t.Fatalf("compaction started events = %d, want 1", len(started))
	}
	terminal := normalizer.FinishFailed(session, "turn-1")
	var settled *activityshared.Event
	for index := range terminal {
		if asString(terminal[index].Payload.Metadata["noticeCommand"]) == "compact" {
			settled = &terminal[index]
		}
	}
	if settled == nil {
		t.Fatalf("expected failed compaction banner in terminal events; got %#v", terminal)
		return
	}
	if got := asString(settled.Payload.Metadata["noticeCommandStatus"]); got != "failed" {
		t.Fatalf("failed banner status = %q, want failed", got)
	}
	if late := adapter.appServerItemEvents(session, "turn-1", item, true, normalizer); len(late) != 0 {
		t.Fatalf("late compaction completion emitted after failure: %#v", late)
	}
}

func TestCodexAppServerAdapterSlashReviewBaseBranch(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/review base:main",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	review := appServerRequestParams(t, transport.conn, appServerMethodReviewStart)
	target := payloadObject(review["target"])
	if asString(target["type"]) != "baseBranch" || asString(target["branch"]) != "main" {
		t.Fatalf("review target = %#v, want baseBranch main", target)
	}
}

func TestCodexAppServerAdapterSlashUndo(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/undo",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	rollback := appServerRequestParams(t, transport.conn, appServerMethodThreadRollback)
	if numTurns, _ := int64Value(rollback["numTurns"]); numTurns != 1 {
		t.Fatalf("rollback params = %#v", rollback)
	}
	if completed := eventsOfType(events, activityshared.EventTurnCompleted); len(completed) != 1 {
		t.Fatalf("undo turn completed events = %d, want 1", len(completed))
	}
}
