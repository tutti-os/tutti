//nolint:unused // Retain migrated test fixtures until the next agent-daemon decomposition pass.
package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func TestStandardACPAdapterStampsAuthoritativeTurnLifecycle(t *testing.T) {
	t.Parallel()

	adapter := &standardACPAdapter{}
	adapterSession := &standardACPSession{}
	session := reportTestSession()
	session.Provider = "acp:gemini"
	events := adapter.stampTurnLifecycleSnapshots(adapterSession, []activityshared.Event{
		newTurnActivityEvent(session, EventTurnStarted, "turn-1", SessionStatusWorking, "", "", nil),
		newTurnActivityEvent(session, EventTurnFailed, "turn-1", SessionStatusFailed, "", "", map[string]any{"error": "quota exceeded"}),
	})

	if len(events) != 2 {
		t.Fatalf("stamped event count = %d, want 2", len(events))
	}
	started, ok := activityshared.TurnLifecycleSnapshotFromEvent(events[0])
	if !ok || started.Origin != activityshared.TurnLifecycleOriginAdapter || started.ActiveTurnID != "turn-1" || started.Phase != "running" || started.Seq != 1 {
		t.Fatalf("started lifecycle snapshot = %#v, %v", started, ok)
	}
	failed, ok := activityshared.TurnLifecycleSnapshotFromEvent(events[1])
	if !ok || failed.Origin != activityshared.TurnLifecycleOriginAdapter || failed.ActiveTurnID != "" || failed.Phase != "settled" || failed.Outcome != "failed" || failed.Seq != 2 {
		t.Fatalf("failed lifecycle snapshot = %#v, %v", failed, ok)
	}
}

func TestStandardACPAdaptersReportProviderLifecycleWithoutSettlingCanonicalRoot(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name              string
		agentTitle        string
		providerSessionID string
		provider          string
		build             func(ProcessTransport) *standardACPAdapter
	}{
		{name: "cursor", agentTitle: "Cursor Agent", providerSessionID: "cursor-session-root-lifecycle", provider: ProviderCursor, build: func(transport ProcessTransport) *standardACPAdapter {
			return newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
		}},
		{name: "opencode", agentTitle: "OpenCode", providerSessionID: "opencode-session-root-lifecycle", provider: ProviderOpenCode, build: newOpenCodeTestAdapter},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			transport := newStandardACPTransport(tt.agentTitle, tt.providerSessionID)
			adapter := tt.build(transport)
			session := standardTestSession(tt.provider)
			if _, err := adapter.Start(context.Background(), session); err != nil {
				t.Fatalf("Start: %v", err)
			}
			session.ProviderSessionID = tt.providerSessionID

			events, err := adapter.Exec(context.Background(), session, textPrompt("inspect the workspace"), "", "root-turn-1", nil, nil)
			if err != nil {
				t.Fatalf("Exec: %v", err)
			}
			if !adapter.UsesRootProviderTurnLifecycle() {
				t.Fatal("standard ACP adapter did not opt into daemon-owned root settlement")
			}

			var started, completed bool
			for _, event := range events {
				switch event.Type {
				case activityshared.EventRootProviderTurnStarted:
					started = event.Payload.TurnID == "root-turn-1" && event.Payload.ProviderTurnID == "root-turn-1"
				case activityshared.EventRootProviderTurnCompleted:
					completed = event.Payload.TurnID == "root-turn-1" &&
						event.Payload.ProviderTurnID == "root-turn-1" &&
						event.Payload.TurnOutcome == string(activityshared.TurnOutcomeCompleted)
				case activityshared.EventTurnCompleted, activityshared.EventTurnFailed, activityshared.EventTurnCanceled:
					t.Fatalf("standard ACP emitted canonical terminal event before daemon settlement: %#v", event)
				}
			}
			if !started || !completed {
				t.Fatalf("provider lifecycle started=%v completed=%v, events=%#v", started, completed, activityEventTypeCounts(events))
			}
		})
	}
}

func TestStandardACPDropsLateTurnScopedUpdatesOutsidePromptCall(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderOpenCode)
	events := standardACPUpdateEvents(
		newOpenCodeTestAdapter(nil).config,
		session,
		"settled-root-turn",
		json.RawMessage(`{"update":{"sessionUpdate":"tool_call","toolCallId":"late-task","title":"Task","status":"pending"}}`),
		nil,
	)
	if len(events) != 0 {
		t.Fatalf("late tool events = %#v, want no events attached to the settled root", events)
	}
}

func TestStandardACPRejectsLatePermissionOutsidePromptCall(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-late-permission")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "cursor-session-late-permission"
	client := adapter.getSession(session.AgentSessionID).client

	events, err := adapter.handleACPMessage(context.Background(), client, session, "settled-root-turn", acpMessage{
		ID:     json.RawMessage(`"late-permission"`),
		Method: acpMethodPermission,
		Params: json.RawMessage(`{"toolCall":{"toolCallId":"late-task","title":"Allow Task"},"options":[{"optionId":"allow","kind":"allow_once"}]}`),
	}, nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "outside an active prompt turn") {
		t.Fatalf("late permission error = %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("late permission events = %#v, want no synthetic turn or interaction", events)
	}
	if pending := adapter.getPendingApproval(session.AgentSessionID, "settled-root-turn", "late-permission"); pending != nil {
		t.Fatalf("late permission created pending interaction: %#v", pending)
	}
}

func TestStandardACPCancelPropagatesNotifyFailure(t *testing.T) {
	t.Parallel()

	wantErr := errors.New("cancel transport unavailable")
	adapter := newCursorAdapterWithHostMetadata(nil, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	adapter.storeSession(session.AgentSessionID, &standardACPSession{
		client:            &acpClient{conn: standardACPFailingSendConnection{err: wantErr}},
		providerSessionID: "cursor-session-cancel",
	})

	if _, err := adapter.Cancel(context.Background(), session, "user canceled"); !errors.Is(err, wantErr) {
		t.Fatalf("Cancel error = %v, want %v", err, wantErr)
	}
}

func TestStandardACPAutoApprovePropagatesResponseFailure(t *testing.T) {
	t.Parallel()

	wantErr := errors.New("permission response transport unavailable")
	adapter := newCursorAdapterWithHostMetadata(nil, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	session.PermissionModeID = "full-access"
	adapter.storeSession(session.AgentSessionID, &standardACPSession{
		client:            &acpClient{conn: standardACPFailingSendConnection{err: wantErr}},
		providerSessionID: "cursor-session-auto-approve",
		permissionModeID:  "full-access",
	})
	client := adapter.getSession(session.AgentSessionID).client

	events, err := adapter.handleACPMessage(context.Background(), client, session, "root-turn-1", acpMessage{
		ID:     json.RawMessage(`"permission-1"`),
		Method: acpMethodPermission,
		Params: json.RawMessage(`{"toolCall":{"toolCallId":"task-1","title":"Allow Task"},"options":[{"optionId":"allow","kind":"allow_once"}]}`),
	}, newACPTurnNormalizer(), nil, nil)
	if !errors.Is(err, wantErr) {
		t.Fatalf("auto-approve response error = %v, want %v", err, wantErr)
	}
	if len(events) != 0 {
		t.Fatalf("auto-approve response events = %#v, want no false resolution", events)
	}
}

type standardACPFailingSendConnection struct {
	err error
}

func (c standardACPFailingSendConnection) Send([]byte) error {
	return c.err
}

func (standardACPFailingSendConnection) Recv() (ProcessFrame, error) {
	return ProcessFrame{}, io.EOF
}

func (standardACPFailingSendConnection) Close() error {
	return nil
}

func TestStandardACPAdapterProviderLaunchPrepareMutatesSpecAndCleansUpOnClose(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-1")
	adapter := NewHermesAdapter(transport)
	cleanupCalls := 0
	adapter.SetProviderLaunchPreparer(func(_ context.Context, input ProviderLaunchPrepareInput) (ProviderLaunchPrepareResult, error) {
		if input.Provider != ProviderHermes {
			t.Fatalf("Provider = %q, want %q", input.Provider, ProviderHermes)
		}
		if input.DirectStart {
			t.Fatal("DirectStart = true, want false for Hermes")
		}
		return ProviderLaunchPrepareResult{
			Command: []string{"prepared-hermes", "acp"},
			Env:     append(append([]string(nil), input.Env...), "HOOK_ENV=1"),
			CWD:     "/prepared/hermes",
			Cleanup: func(context.Context) error {
				cleanupCalls++
				return nil
			},
		}, nil
	})
	session := standardTestSession(ProviderHermes)
	session.Env = []string{"SESSION_ENV=1"}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if cleanupCalls != 0 {
		t.Fatalf("cleanup calls before close = %d, want 0", cleanupCalls)
	}
	transport.mu.Lock()
	specs := append([]ProcessSpec(nil), transport.specs...)
	transport.mu.Unlock()
	if len(specs) != 1 {
		t.Fatalf("transport starts = %d, want 1", len(specs))
	}
	spec := specs[0]
	if !reflect.DeepEqual(spec.Command, []string{"prepared-hermes", "acp"}) {
		t.Fatalf("Command = %#v", spec.Command)
	}
	if spec.CWD != "/prepared/hermes" {
		t.Fatalf("CWD = %q", spec.CWD)
	}
	if !reflect.DeepEqual(spec.Env[len(spec.Env)-2:], []string{"SESSION_ENV=1", "HOOK_ENV=1"}) {
		t.Fatalf("Env tail = %#v", spec.Env)
	}

	if err := adapter.Close(context.Background(), session); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if cleanupCalls != 1 {
		t.Fatalf("cleanup calls after close = %d, want 1", cleanupCalls)
	}
}

func TestStandardACPAdapterConcurrentStartsLeaveSingleLiveProcess(t *testing.T) {
	t.Parallel()

	transport := &multiProcStandardACPTransport{
		agentTitle: "Hermes Agent",
		sessionID:  "hermes-session-1",
	}
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)

	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = adapter.Start(context.Background(), session)
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("Start[%d]: %v", i, err)
		}
	}
	spawned, live := transport.snapshot()
	if spawned != 2 {
		t.Fatalf("spawned processes = %d, want 2", spawned)
	}
	if len(live) != 1 {
		t.Fatalf("live ACP processes = %d, want exactly 1", len(live))
	}
	if !adapter.HasLiveSession(session) {
		t.Fatal("HasLiveSession = false, want true after concurrent starts")
	}
}

func TestHermesAdapterStartAppliesModelAndReasoningConfigOptions(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-1")
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)
	session.Settings = &SessionSettings{
		Model:           "hermes-pro",
		ReasoningEffort: "high",
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	calls := transport.conn.setConfigOptionCalls()
	if len(calls) != 2 {
		t.Fatalf("config option calls = %#v, want model + effort", calls)
	}
	if got, _ := calls[0]["configId"].(string); got != "model" {
		t.Fatalf("first config id = %q, want model", got)
	}
	if got, _ := calls[0]["value"].(string); got != "hermes-pro" {
		t.Fatalf("first config value = %q, want hermes-pro", got)
	}
	if got, _ := calls[1]["configId"].(string); got != "effort" {
		t.Fatalf("second config id = %q, want effort", got)
	}
	if got, _ := calls[1]["value"].(string); got != "high" {
		t.Fatalf("second config value = %q, want high", got)
	}
}

func TestCursorAdapterStartCreatesStandardACPSession(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-1")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	session.PermissionModeID = "agent"

	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	spec := transport.specs[0]
	if got := strings.Join(spec.Command, " "); got != "cursor-agent acp" {
		t.Fatalf("command = %q, want %q", got, "cursor-agent acp")
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("events = %#v, want session.started", events)
	}
	if events[0].ProviderSessionID != "cursor-session-1" {
		t.Fatalf("provider session id = %q", events[0].ProviderSessionID)
	}
	if transport.conn.lastModeID() != "agent" {
		t.Fatalf("mode id = %q, want agent", transport.conn.lastModeID())
	}
	if got := transport.conn.authenticatedMethodID(); got != "" {
		t.Fatalf("authenticated method id = %q, want empty", got)
	}
}

func TestCursorAdapterStartMapsPermissionTiersToACPModes(t *testing.T) {
	t.Parallel()

	for tier, wantMode := range map[string]string{
		"read-only":   "ask",
		"agent":       "agent",
		"full-access": "agent",
	} {
		transport := newStandardACPTransport("Cursor Agent", "cursor-session-"+tier)
		adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
		session := standardTestSession(ProviderCursor)
		session.PermissionModeID = tier

		if _, err := adapter.Start(context.Background(), session); err != nil {
			t.Fatalf("Start(%s): %v", tier, err)
		}
		if transport.conn.lastModeID() != wantMode {
			t.Fatalf("tier %q mode id = %q, want %q", tier, transport.conn.lastModeID(), wantMode)
		}
	}
}

func TestCursorAdapterStartSkipsSetModeForUnknownMode(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-unknown")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	session.PermissionModeID = "yolo"

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got := transport.conn.lastModeID(); got != "" {
		t.Fatalf("mode id = %q, want no session/set_mode call", got)
	}
}

func TestCursorAdapterNeverSpawnsWithForceFlag(t *testing.T) {
	t.Parallel()

	for _, tier := range []string{"read-only", "agent", "full-access"} {
		transport := newStandardACPTransport("Cursor Agent", "cursor-session-"+tier)
		adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
		session := standardTestSession(ProviderCursor)
		session.PermissionModeID = tier

		if _, err := adapter.Start(context.Background(), session); err != nil {
			t.Fatalf("Start(%s): %v", tier, err)
		}
		// full-access uses live auto-approval, not a spawn flag, so the
		// command is identical across tiers and never needs a respawn.
		if got := strings.Join(transport.specs[0].Command, " "); got != "cursor-agent acp" {
			t.Fatalf("tier %q command = %q, want plain cursor-agent acp", tier, got)
		}
	}
}

func TestCursorAdapterStartUsesPluginDirEnv(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-plugin")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	session.Env = []string{cursorPluginDirEnv + "=/state/runs/session/cursor-plugin/tutti-cli"}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	if got := strings.Join(transport.specs[0].Command, " "); got != "cursor-agent --plugin-dir /state/runs/session/cursor-plugin/tutti-cli acp" {
		t.Fatalf("command = %q, want cursor plugin-dir before acp", got)
	}
}

func TestCursorAdapterFullAccessAutoApprovesWithoutPrompt(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-1")
	transport.conn.promptPermission = true
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	session.PermissionModeID = "full-access"
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "cursor-session-1"

	var mu sync.Mutex
	var emittedActivity []activityshared.Event
	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("run the build"), "", "turn-1", func(events []activityshared.Event) {
			mu.Lock()
			emittedActivity = append(emittedActivity, events...)
			mu.Unlock()
		}, nil)
		execDone <- err
	}()

	select {
	case err := <-execDone:
		if err != nil {
			t.Fatalf("Exec: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Exec did not finish; full-access must auto-approve without waiting for input")
	}

	if got := transport.conn.permissionOptionID(); got != "allow" {
		t.Fatalf("permission option id = %q, want auto-approved allow", got)
	}
	mu.Lock()
	events := ProjectActivityEventsToStreamEvents(session, emittedActivity)
	mu.Unlock()
	if hasStreamCallEvent(events, "approval", "waiting_approval") {
		t.Fatal("full-access must not surface an approval prompt")
	}
}

func TestCursorAdapterAgentTierPromptsForPermission(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-2")
	transport.conn.promptPermission = true
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	session.PermissionModeID = "agent"
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "cursor-session-2"

	var mu sync.Mutex
	var emittedActivity []activityshared.Event
	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("run the build"), "", "turn-1", func(events []activityshared.Event) {
			mu.Lock()
			emittedActivity = append(emittedActivity, events...)
			mu.Unlock()
		}, nil)
		execDone <- err
	}()

	waitForCondition(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		events := ProjectActivityEventsToStreamEvents(session, emittedActivity)
		return hasStreamCallEvent(events, "approval", "waiting_approval")
	})

	if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		TurnID:    "turn-1",
		RequestID: "permission-1",
		OptionID:  "reject",
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	select {
	case err := <-execDone:
		if err != nil {
			t.Fatalf("Exec: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Exec did not finish after permission response")
	}
	if got := transport.conn.permissionOptionID(); got != "reject" {
		t.Fatalf("permission option id = %q, want the user's reject", got)
	}
}

// TestCursorPermissionRequestFallsBackToKnownToolCallInput reproduces a real
// Cursor CLI ACP trace: `session/update` streams a `tool_call` with
// `rawInput.command`, then `session/request_permission` repeats only
// `toolCallId`/`title`/`kind` for that same call (no `rawInput`). Without a
// fallback to the earlier tool_call, the approval card has no command detail
// to show — only the title and options.
func TestCursorPermissionRequestFallsBackToKnownToolCallInput(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-fallback")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	normalizer := newACPTurnNormalizer()

	started := standardACPUpdateEvents(standardACPConfig{provider: ProviderCursor}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call",
			"toolCallId": "toolu_bdrk_01Q5tgfQbZyrAVBAUp71Eq8A",
			"title": "`+"`echo hello-from-permission-probe`"+`",
			"kind": "execute",
			"status": "pending",
			"rawInput": {"command": "echo hello-from-permission-probe"}
		}
	}`), normalizer)
	if len(started) != 1 || started[0].Type != activityshared.EventCallStarted {
		t.Fatalf("started events = %#v, want one call.started", started)
	}

	events, pending, err := standardACPPermissionRequested(adapter, session, "turn-1", json.RawMessage(`2`), json.RawMessage(`{
		"toolCall": {
			"toolCallId": "toolu_bdrk_01Q5tgfQbZyrAVBAUp71Eq8A",
			"title": "`+"`echo hello-from-permission-probe`"+`",
			"kind": "execute",
			"status": "pending",
			"content": [{"type": "content", "content": {"type": "text", "text": "Not in allowlist: echo"}}]
		},
		"options": [
			{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
			{"optionId": "allow-always", "name": "Allow always", "kind": "allow_always"},
			{"optionId": "reject-once", "name": "Reject", "kind": "reject_once"}
		]
	}`), normalizer)
	if err != nil {
		t.Fatalf("standardACPPermissionRequested: %v", err)
	}
	if len(events) == 0 {
		t.Fatal("events = empty, want at least the waiting-approval turn event")
	}
	if pending == nil {
		t.Fatal("pending = nil, want a stored pending approval")
	}
	if got := asString(pending.input["command"]); got != "echo hello-from-permission-probe" {
		t.Fatalf("pending.input[command] = %q, want the command captured from the earlier tool_call", got)
	}
}

func TestACPPermissionRequestFallsBackToKnownFileChanges(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-file-changes")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	normalizer := newACPTurnNormalizer()
	config := standardACPConfig{provider: ProviderCursor}

	started := standardACPUpdateEvents(config, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call",
			"toolCallId": "file-change-1",
			"title": "Apply file changes",
			"kind": "edit",
			"status": "pending",
			"rawInput": {
				"changes": [
					{"path": "/workspace/src/app.ts", "kind": {"type": "update"}},
					{"path": "/workspace/src/game.ts", "kind": {"type": "create"}}
				]
			}
		}
	}`), normalizer)
	if len(started) != 1 || started[0].Type != activityshared.EventCallStarted {
		t.Fatalf("started events = %#v, want one call.started", started)
	}

	updated := standardACPUpdateEvents(config, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call_update",
			"toolCallId": "file-change-1",
			"title": "Apply file changes",
			"kind": "edit",
			"status": "pending"
		}
	}`), normalizer)
	if len(updated) == 0 {
		t.Fatal("empty tool-call update was not projected")
	}

	events, pending, err := standardACPPermissionRequested(adapter, session, "turn-1", json.RawMessage(`3`), json.RawMessage(`{
		"toolCall": {
			"toolCallId": "file-change-1",
			"title": "Apply file changes",
			"kind": "edit",
			"status": "pending"
		},
		"options": [
			{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
			{"optionId": "reject-once", "name": "Reject", "kind": "reject_once"}
		]
	}`), normalizer)
	if err != nil {
		t.Fatalf("standardACPPermissionRequested: %v", err)
	}
	if pending == nil {
		t.Fatal("pending approval is nil")
	}
	if pending.approvalPurpose != approvalPurposeEditFiles {
		t.Fatalf("pending approval purpose = %q, want %q", pending.approvalPurpose, approvalPurposeEditFiles)
	}
	interaction := events[len(events)-1].Payload.Interaction
	if interaction == nil || asString(interaction.Metadata["approvalPurpose"]) != approvalPurposeEditFiles {
		t.Fatalf("interaction approval purpose = %#v, want %q", interaction, approvalPurposeEditFiles)
	}
	changes, ok := pending.input["changes"].([]any)
	if !ok || len(changes) != 2 {
		t.Fatalf("pending approval changes = %#v, want both known file changes", pending.input["changes"])
	}
}

// TestCursorPermissionRequestKeepsKnownInputAfterEmptyToolCallUpdate reproduces
// the live Cursor sequence behind blank approval cards: tool_call carries
// rawInput.command, a later tool_call_update for the same id repeats only
// title/kind/status/content (no rawInput), then session/request_permission
// also omits rawInput. The empty update must not wipe the pending snapshot, or
// KnownToolCallInput has nothing left to backfill onto the approval card.
func TestCursorPermissionRequestKeepsKnownInputAfterEmptyToolCallUpdate(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-empty-update")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	normalizer := newACPTurnNormalizer()
	config := standardACPConfig{provider: ProviderCursor}
	toolCallID := "call-4341cda2-656d-41c2-8ec3-80f0b3b6d09a-0\nfc_918c4886-f213-9396-8439-d721f380bc12_0"
	command := `echo "hello from bash" && pwd && date`

	started := standardACPUpdateEvents(config, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call",
			"toolCallId": `+jsonString(toolCallID)+`,
			"title": `+jsonString("`"+command+"`")+`,
			"kind": "execute",
			"status": "pending",
			"rawInput": {"command": `+jsonString(command)+`}
		}
	}`), normalizer)
	if len(started) != 1 || started[0].Type != activityshared.EventCallStarted {
		t.Fatalf("started events = %#v, want one call.started", started)
	}
	if got := asString(payloadMap(started[0].Payload.Metadata, "input")["command"]); got != command {
		t.Fatalf("started input.command = %q, want %q", got, command)
	}

	updated := standardACPUpdateEvents(config, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call_update",
			"toolCallId": `+jsonString(toolCallID)+`,
			"title": `+jsonString("`"+command+"`")+`,
			"kind": "execute",
			"status": "pending",
			"content": [{"type": "content", "content": {"type": "text", "text": "Not in allowlist: echo"}}]
		}
	}`), normalizer)
	if len(updated) == 0 {
		t.Fatal("updated events = empty, want the tool_call_update projection")
	}
	if got := normalizer.KnownToolCallInput(toolCallID); asString(got["command"]) != command {
		t.Fatalf("KnownToolCallInput after empty update = %#v, want command %q preserved", got, command)
	}

	_, pending, err := standardACPPermissionRequested(adapter, session, "turn-1", json.RawMessage(`0`), json.RawMessage(`{
		"toolCall": {
			"toolCallId": `+jsonString(toolCallID)+`,
			"title": `+jsonString("`"+command+"`")+`,
			"kind": "execute",
			"status": "pending",
			"content": [{"type": "content", "content": {"type": "text", "text": "Not in allowlist: echo"}}]
		},
		"options": [
			{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
			{"optionId": "allow-always", "name": "Allow always", "kind": "allow_always"},
			{"optionId": "reject-once", "name": "Reject", "kind": "reject_once"}
		]
	}`), normalizer)
	if err != nil {
		t.Fatalf("standardACPPermissionRequested: %v", err)
	}
	if pending == nil {
		t.Fatal("pending = nil, want a stored pending approval")
	}
	if got := asString(pending.input["command"]); got != command {
		t.Fatalf("pending.input[command] = %q, want command preserved across empty tool_call_update", got)
	}
}

func jsonString(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func TestCursorAutoApprovePermissionDecision(t *testing.T) {
	t.Parallel()

	if got := cursorAutoApprovePermissionDecision("full-access"); got != "approved" {
		t.Fatalf("full-access decision = %q, want approved", got)
	}
	for _, tier := range []string{"agent", "read-only", "", "yolo"} {
		if got := cursorAutoApprovePermissionDecision(tier); got != "" {
			t.Fatalf("tier %q decision = %q, want prompt (empty)", tier, got)
		}
	}
}

func TestResolveACPPermissionDecisionOptionID(t *testing.T) {
	t.Parallel()

	options := []map[string]any{
		{"optionId": "allow-once", "name": "Allow once"},
		{"optionId": "allow-always", "name": "Allow always"},
		{"optionId": "reject-once", "name": "Reject"},
	}
	if got, ok := resolveACPPermissionDecisionOptionID(options, "approved"); !ok || got != "allow-once" {
		t.Fatalf("approved -> %q (ok=%v), want allow-once", got, ok)
	}
	if got, ok := resolveACPPermissionDecisionOptionID(options, "denied"); !ok || got != "reject-once" {
		t.Fatalf("denied -> %q (ok=%v), want reject-once", got, ok)
	}
	if _, ok := resolveACPPermissionDecisionOptionID(nil, "approved"); ok {
		t.Fatal("no options must not resolve")
	}
}

func TestCursorAdapterStartUsesInjectedProviderCommand(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-resolved")
	adapter := newCursorAdapterWithHostMetadata(
		transport,
		LegacyHostMetadata(),
		func(_ context.Context, provider string) (ProviderCommand, error) {
			if provider != ProviderCursor {
				t.Fatalf("provider = %q, want %q", provider, ProviderCursor)
			}
			return ProviderCommand{Command: []string{"/home/user/.local/bin/agent", "acp"}}, nil
		},
	)
	session := standardTestSession(ProviderCursor)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	if got := strings.Join(transport.specs[0].Command, " "); got != "/home/user/.local/bin/agent acp" {
		t.Fatalf("command = %q, want resolved cursor binary", got)
	}
}

func TestCursorAdapterStartUsesPluginDirWithInjectedProviderCommand(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-resolved-plugin")
	adapter := newCursorAdapterWithHostMetadata(
		transport,
		LegacyHostMetadata(),
		func(_ context.Context, provider string) (ProviderCommand, error) {
			if provider != ProviderCursor {
				t.Fatalf("provider = %q, want %q", provider, ProviderCursor)
			}
			return ProviderCommand{Command: []string{"/home/user/.local/bin/agent", "acp"}}, nil
		},
	)
	session := standardTestSession(ProviderCursor)
	session.Env = []string{cursorPluginDirEnv + "=/state/cursor-plugin/tutti-cli"}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got := strings.Join(transport.specs[0].Command, " "); got != "/home/user/.local/bin/agent --plugin-dir /state/cursor-plugin/tutti-cli acp" {
		t.Fatalf("command = %q, want resolved cursor binary with plugin-dir", got)
	}
}

func TestCursorAdapterStartAppliesModelConfigOption(t *testing.T) {
	t.Parallel()

	// Mirrors cursor-agent 2026.07 session/new output: a `model` config
	// option with parameterized ids in {value, name} entries.
	transport := newStandardACPTransport("Cursor Agent", "cursor-session-model")
	transport.conn.configOptions = []map[string]any{
		{
			"id":           "model",
			"name":         "Model",
			"category":     "model",
			"type":         "select",
			"currentValue": "composer-2.5[fast=true]",
			"options": []any{
				map[string]any{"value": "default[]", "name": "Auto"},
				map[string]any{"value": "composer-2.5[fast=true]", "name": "composer-2.5"},
				map[string]any{"value": "claude-sonnet-5[thinking=true,context=300k,effort=high]", "name": "claude-sonnet-5"},
			},
		},
	}
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	session.Settings = &SessionSettings{Model: "claude-sonnet-5[thinking=true,context=300k,effort=high]"}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	calls := transport.conn.setConfigOptionCalls()
	if len(calls) != 1 {
		t.Fatalf("config option calls = %#v, want one model update", calls)
	}
	if got, _ := calls[0]["configId"].(string); got != "model" {
		t.Fatalf("config id = %q, want model", got)
	}
	if got, _ := calls[0]["value"].(string); got != "claude-sonnet-5[thinking=true,context=300k,effort=high]" {
		t.Fatalf("config value = %q, want parameterized cursor model id", got)
	}
}

func TestCursorACPModeID(t *testing.T) {
	t.Parallel()

	for mode, want := range map[string]string{
		"read-only":   "ask",
		"agent":       "agent",
		"full-access": "agent",
		" agent ":     "agent",
		"":            "",
		"yolo":        "",
		"plan":        "",
		"ask":         "",
	} {
		if got := cursorACPModeID(mode); got != want {
			t.Fatalf("cursorACPModeID(%q) = %q, want %q", mode, got, want)
		}
	}
}

func TestCursorPlanModeFromACPModeID(t *testing.T) {
	t.Parallel()
	descriptor, ok := providerregistry.Find(ProviderCursor)
	if !ok {
		t.Fatal("cursor descriptor missing")
	}

	for modeID, wantPlanMode := range map[string]bool{
		"plan":  true,
		"agent": false,
		"ask":   false,
	} {
		got, ok := projectCurrentPlanModeFromACPModeID(descriptor.Runtime.StandardACP, modeID)
		if !ok {
			t.Fatalf("cursorPlanModeFromACPModeID(%q) ok=false, want true", modeID)
		}
		if got != wantPlanMode {
			t.Fatalf("cursorPlanModeFromACPModeID(%q) = %v, want %v", modeID, got, wantPlanMode)
		}
	}
	if _, ok := projectCurrentPlanModeFromACPModeID(descriptor.Runtime.StandardACP, "auto"); ok {
		t.Fatal("cursorPlanModeFromACPModeID(auto) ok=true, want false")
	}
}

func TestCursorAdapterApplySessionSettingsTogglesPlanMode(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-plan-toggle")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	session.PermissionModeID = "agent"
	session.Settings = &SessionSettings{
		PermissionModeID: "agent",
		PlanMode:         false,
	}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	planMode := true
	session.ProviderSessionID = "cursor-session-plan-toggle"
	session.Settings.PlanMode = planMode
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		PlanMode: &planMode,
	}); err != nil {
		t.Fatalf("ApplySessionSettings plan on: %v", err)
	}
	if transport.conn.lastModeID() != "plan" {
		t.Fatalf("mode id = %q, want plan", transport.conn.lastModeID())
	}

	planMode = false
	session.Settings.PlanMode = planMode
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		PlanMode: &planMode,
	}); err != nil {
		t.Fatalf("ApplySessionSettings plan off: %v", err)
	}
	if transport.conn.lastModeID() != "agent" {
		t.Fatalf("mode id = %q, want agent", transport.conn.lastModeID())
	}
}

func TestCursorAdapterReadOnlyReturnsFromPlanModeToAsk(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-read-only-plan-toggle")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	session.PermissionModeID = cursorPermissionReadOnly
	session.Settings = &SessionSettings{
		PermissionModeID: cursorPermissionReadOnly,
		PlanMode:         false,
	}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if transport.conn.lastModeID() != "ask" {
		t.Fatalf("initial mode id = %q, want ask", transport.conn.lastModeID())
	}

	session.ProviderSessionID = "cursor-session-read-only-plan-toggle"
	planMode := true
	session.Settings.PlanMode = planMode
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		PlanMode: &planMode,
	}); err != nil {
		t.Fatalf("ApplySessionSettings plan on: %v", err)
	}
	if transport.conn.lastModeID() != "plan" {
		t.Fatalf("plan mode id = %q, want plan", transport.conn.lastModeID())
	}

	planMode = false
	session.Settings.PlanMode = planMode
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		PlanMode: &planMode,
	}); err != nil {
		t.Fatalf("ApplySessionSettings plan off: %v", err)
	}
	if transport.conn.lastModeID() != "ask" {
		t.Fatalf("restored mode id = %q, want ask", transport.conn.lastModeID())
	}
}

func TestHermesAdapterStartCreatesStandardACPSession(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-1")
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)
	session.PermissionModeID = "full-access"

	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	spec := transport.specs[0]
	if got := strings.Join(spec.Command, " "); got != "hermes acp" {
		t.Fatalf("command = %q, want %q", got, "hermes acp")
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("events = %#v, want session.started", events)
	}
	if events[0].ProviderSessionID != "hermes-session-1" {
		t.Fatalf("provider session id = %q", events[0].ProviderSessionID)
	}
	if transport.conn.lastModeID() != "yolo" {
		t.Fatalf("mode id = %q, want yolo", transport.conn.lastModeID())
	}
	if got := transport.conn.authenticatedMethodID(); got != "" {
		t.Fatalf("authenticated method id = %q, want empty", got)
	}
}

func TestHermesAdapterStartCoercesReadOnlyModeToYolo(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-default")
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)
	session.PermissionModeID = "read-only"

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if transport.conn.lastModeID() != "yolo" {
		t.Fatalf("mode id = %q, want yolo", transport.conn.lastModeID())
	}
}

func TestHermesAdapterStartCoercesAutoModeToYolo(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-auto")
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)
	session.PermissionModeID = "auto"

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if transport.conn.lastModeID() != "yolo" {
		t.Fatalf("mode id = %q, want yolo", transport.conn.lastModeID())
	}
}

func TestOpenClawAdapterStartCreatesStandardACPSession(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenClaw", "openclaw-session-1")
	adapter := NewOpenClawAdapter(transport)
	session := standardTestSession(ProviderOpenClaw)
	session.PermissionModeID = "full-access"

	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	spec := transport.specs[0]
	if got := strings.Join(spec.Command, " "); got != "openclaw acp -v" {
		t.Fatalf("command = %q, want %q", got, "openclaw acp -v")
	}
	if !containsString(spec.Env, "NODE_DISABLE_COMPILE_CACHE=1") {
		t.Fatalf("env = %#v, want OpenClaw Node compile cache disabled for routed ACP startup", spec.Env)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("events = %#v, want session.started", events)
	}
	if events[0].ProviderSessionID != "openclaw-session-1" {
		t.Fatalf("provider session id = %q", events[0].ProviderSessionID)
	}
	if transport.conn.lastModeID() != "" {
		t.Fatalf("mode id = %q, want empty because openclaw permission mode must not use session/set_mode", transport.conn.lastModeID())
	}
	if got := transport.conn.authenticatedMethodID(); got != "" {
		t.Fatalf("authenticated method id = %q, want empty", got)
	}
	meta, ok := transport.conn.lastNewSessionParams["_meta"].(map[string]any)
	if !ok {
		t.Fatalf("session/new missing _meta params snapshot")
	}
	sk, _ := meta["sessionKey"].(string)
	wantKey := "agent:main:tsh-" + session.AgentSessionID
	if sk != wantKey {
		t.Fatalf("session/new sessionKey = %q, want %q", sk, wantKey)
	}
}

func TestOpenClawAdapterResumePassesGatewayChatSessionKeyMeta(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenClaw", "openclaw-session-resume")
	adapter := NewOpenClawAdapter(transport)
	session := standardTestSession(ProviderOpenClaw)
	session.ProviderSessionID = "persisted-openclaw-acp-session-id"

	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	meta, ok := transport.conn.lastLoadSessionParams["_meta"].(map[string]any)
	if !ok {
		t.Fatalf("session/load missing _meta params snapshot")
	}
	sk, _ := meta["sessionKey"].(string)
	wantKey := "agent:main:tsh-" + session.AgentSessionID
	if sk != wantKey {
		t.Fatalf("session/load sessionKey = %q, want %q", sk, wantKey)
	}
}

func TestOpenClawAdapterResumeClassifiesMissingProviderSession(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenClaw", "openclaw-session-resume")
	transport.conn.loadSessionError = &acpError{
		Code:    -32002,
		Message: "Resource not found",
	}
	adapter := NewOpenClawAdapter(transport)
	session := standardTestSession(ProviderOpenClaw)
	session.ProviderSessionID = "persisted-openclaw-acp-session-id"

	err := adapter.Resume(context.Background(), session)
	if AppErrorCode(err) != AppErrorProviderSessionNotFound {
		t.Fatalf("app error code = %q, want %q (err=%v)", AppErrorCode(err), AppErrorProviderSessionNotFound, err)
	}
}

func TestStandardACPProvidersResumeClassifyMissingProviderSession(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		provider string
		build    func(ProcessTransport) *standardACPAdapter
		session  func() Session
	}{
		{
			name:     "hermes",
			provider: ProviderHermes,
			build:    NewHermesAdapter,
			session: func() Session {
				session := standardTestSession(ProviderHermes)
				session.ProviderSessionID = "persisted-hermes-session-id"
				return session
			},
		},
		{
			name:     "opencode",
			provider: ProviderOpenCode,
			build:    newOpenCodeTestAdapter,
			session: func() Session {
				session := standardTestSession(ProviderOpenCode)
				session.ProviderSessionID = "persisted-opencode-session-id"
				return session
			},
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			transport := newStandardACPTransport(tc.provider, tc.session().ProviderSessionID)
			transport.conn.supportsLoadSession = true
			transport.conn.loadSessionError = &acpError{
				Code:    -32002,
				Message: "Resource not found",
			}
			adapter := tc.build(transport)
			err := adapter.Resume(context.Background(), tc.session())
			if AppErrorCode(err) != AppErrorProviderSessionNotFound {
				t.Fatalf("app error code = %q, want %q (err=%v)", AppErrorCode(err), AppErrorProviderSessionNotFound, err)
			}
		})
	}
}

func TestStandardACPProvidersResumeClassifyUnsupportedRestoreAsResumeSessionNotLocal(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-resume")
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)
	session.ProviderSessionID = "persisted-hermes-session-id"

	err := adapter.Resume(context.Background(), session)
	if AppErrorCode(err) != AppErrorResumeSessionNotLocal {
		t.Fatalf("app error code = %q, want %q (err=%v)", AppErrorCode(err), AppErrorResumeSessionNotLocal, err)
	}
	debugMessage := AppErrorDebugMessage(err)
	if !strings.Contains(debugMessage, "resume/load unsupported") {
		t.Fatalf("debug message = %q, want unsupported restore detail", debugMessage)
	}
}

func TestStandardACPProvidersResumeRequireProviderSessionID(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-resume")
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)
	session.ProviderSessionID = ""

	err := adapter.Resume(context.Background(), session)
	if AppErrorCode(err) != AppErrorResumeSessionNotLocal {
		t.Fatalf("app error code = %q, want %q (err=%v)", AppErrorCode(err), AppErrorResumeSessionNotLocal, err)
	}
	if len(transport.specs) != 0 {
		t.Fatalf("process starts = %d, want 0", len(transport.specs))
	}
	debugMessage := AppErrorDebugMessage(err)
	if !strings.Contains(debugMessage, "provider_session_id missing") {
		t.Fatalf("debug message = %q, want missing provider session detail", debugMessage)
	}
}

func TestOpenClawAdapterStartSkipsSessionSetModeForDefaultPermission(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenClaw", "openclaw-session-default")
	adapter := NewOpenClawAdapter(transport)
	session := standardTestSession(ProviderOpenClaw)
	// PermissionMode omitted → approve-reads for OpenClaw.

	_, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if transport.conn.lastModeID() != "" {
		t.Fatalf("mode id = %q, want empty because openclaw permission mode must not use session/set_mode", transport.conn.lastModeID())
	}
}

func TestOpenClawAdapterStartIgnoresSetModeErrorsBecauseNoSetModeIsSent(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenClaw", "openclaw-session-fail")
	transport.conn.setModeError = &acpError{
		Code:    -32603,
		Message: "Internal error",
		Data:    json.RawMessage(`{"details":"invalid thinkingLevel"}`),
	}
	adapter := NewOpenClawAdapter(transport)
	session := standardTestSession(ProviderOpenClaw)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start() error = %v, want nil because openclaw should not call session/set_mode", err)
	}
	if transport.conn.lastModeID() != "" {
		t.Fatalf("mode id = %q, want empty because openclaw should not call session/set_mode", transport.conn.lastModeID())
	}
}

func TestOpenCodeAdapterAllowsImagePromptWithoutInitializeCapability(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-1")
	adapter := newOpenCodeTestAdapter(transport)
	session := standardTestSession(ProviderOpenCode)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "opencode-session-1"

	content := []PromptContentBlock{{
		Type: "text",
		Text: "what is in this screenshot?",
	}, {
		Type:     "image",
		MimeType: "image/png",
		Path:     "/managed/agent-prompt-assets/screen.png",
	}}
	if err := adapter.ValidatePromptContent(session, content); err != nil {
		t.Fatalf("ValidatePromptContent error = %v, want nil", err)
	}
	snapshot := adapter.SessionState(session)
	capabilities, _ := snapshot.RuntimeContext["capabilities"].([]string)
	if !containsString(capabilities, CapabilityImageInput) {
		t.Fatalf("runtime capabilities = %#v, want imageInput", snapshot.RuntimeContext["capabilities"])
	}
}

func TestCursorAdapterAllowsImagePromptWithoutInitializeCapability(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor", "cursor-session-1")
	adapter := NewCursorAdapter(transport)
	session := standardTestSession(ProviderCursor)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "cursor-session-1"

	content := []PromptContentBlock{{
		Type: "text",
		Text: "what is in this screenshot?",
	}, {
		Type:     "image",
		MimeType: "image/png",
		Data:     "aW1hZ2U=",
	}}
	if err := adapter.ValidatePromptContent(session, content); err != nil {
		t.Fatalf("ValidatePromptContent error = %v, want nil", err)
	}
	snapshot := adapter.SessionState(session)
	capabilities, _ := snapshot.RuntimeContext["capabilities"].([]string)
	if !containsString(capabilities, CapabilityImageInput) {
		t.Fatalf("runtime capabilities = %#v, want imageInput", snapshot.RuntimeContext["capabilities"])
	}
}

func TestStandardACPAdapterRejectsImagePromptWithoutCapability(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-1")
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "hermes-session-1"

	content := []PromptContentBlock{{
		Type:     "image",
		MimeType: "image/png",
		Path:     "/managed/agent-prompt-assets/screen.png",
	}}
	if err := adapter.ValidatePromptContent(session, content); !errors.Is(err, ErrPromptImageUnsupported) {
		t.Fatalf("ValidatePromptContent error = %v, want ErrPromptImageUnsupported", err)
	}
	snapshot := adapter.SessionState(session)
	capabilities, _ := snapshot.RuntimeContext["capabilities"].([]string)
	if containsString(capabilities, CapabilityImageInput) {
		t.Fatalf("runtime promptCapabilities = %#v, want image unsupported", snapshot.RuntimeContext["promptCapabilities"])
	}
}

func TestStandardACPToolCallEventInfersCompletedStatusFromRawOutput(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderHermes)
	completed, ok := standardACPToolCallEventWithID(session, "event-complete-inferred", "turn-1", "tool_call_update", readSessionTestdataJSON(t, "standard_acp_tool_call_update_completed_without_status.json"))
	if !ok {
		t.Fatal("standardACPToolCallEventWithID(inferred complete) returned !ok")
	}
	if completed.Type != activityshared.EventCallCompleted {
		t.Fatalf("completed event type = %s, want call.completed", completed.Type)
	}
	if completed.Payload.Output["stdout"] != "/workspace/app\n" {
		t.Fatalf("completed output = %#v, want stdout preserved", completed.Payload.Output)
	}
	if completed.Payload.Metadata["toolName"] != "Bash" {
		t.Fatalf("completed tool name = %#v, want Bash", completed.Payload.Metadata["toolName"])
	}
}

func TestStandardACPToolAliasOverridesProviderToolIDDeclaratively(t *testing.T) {
	update := map[string]any{"title": "replace", "toolCallId": "call-1"}
	applyStandardACPToolAlias(standardACPConfig{toolAliases: map[string]string{"replace": "Edit"}}, update)
	if got := update["toolName"]; got != "Edit" {
		t.Fatalf("toolName = %#v, want Edit", got)
	}
}

func TestStandardACPToolCallEventInfersFailedStatusFromRawOutput(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderHermes)
	failed, ok := standardACPToolCallEventWithID(session, "event-failed-inferred", "turn-1", "tool_call_update", readSessionTestdataJSON(t, "standard_acp_tool_call_update_failed_without_status.json"))
	if !ok {
		t.Fatal("standardACPToolCallEventWithID(inferred failed) returned !ok")
	}
	if failed.Type != activityshared.EventCallFailed {
		t.Fatalf("failed event type = %s, want call.failed", failed.Type)
	}
	if failed.Payload.Error["output"] != "Exit code 137" {
		t.Fatalf("failed error = %#v, want raw output preserved", failed.Payload.Error)
	}
}

func TestStandardACPNormalizerKeepsCanonicalToolIdentityAcrossDynamicTitles(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderOpenCode)
	normalizer := newACPTurnNormalizer()
	started := standardACPUpdateEvents(standardACPConfig{provider: ProviderOpenCode}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call",
			"toolCallId": "edit-1",
			"title": "apply_patch",
			"status": "in_progress",
			"kind": "edit",
			"rawInput": {"patchText": "*** Begin Patch"}
		}
	}`), normalizer)
	completed := standardACPUpdateEvents(standardACPConfig{provider: ProviderOpenCode}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call_update",
			"toolCallId": "edit-1",
			"title": "Success. Updated the following files: index.html",
			"status": "completed",
			"kind": "edit",
			"rawInput": {"patchText": "*** Begin Patch"},
			"rawOutput": {"metadata": {"diff": "Index: index.html", "files": [{"filePath": "index.html"}]}}
		}
	}`), normalizer)
	if len(started) != 1 || started[0].Payload.Metadata["toolName"] != "Edit" {
		t.Fatalf("started events = %#v, want canonical Edit", started)
	}
	if len(completed) != 1 || completed[0].Payload.Metadata["toolName"] != "Edit" {
		t.Fatalf("completed events = %#v, want stable canonical Edit", completed)
	}
	if completed[0].Payload.Metadata["kind"] != "edit" {
		t.Fatalf("completed metadata = %#v, want ACP kind", completed[0].Payload.Metadata)
	}
	if completed[0].Payload.Output["diff"] != "Index: index.html" {
		t.Fatalf("completed output = %#v, want promoted diff", completed[0].Payload.Output)
	}
	if files, ok := completed[0].Payload.Output["files"].([]any); !ok || len(files) != 1 {
		t.Fatalf("completed output = %#v, want promoted files", completed[0].Payload.Output)
	}
}

func TestACPToolNameRecognizesOpenCodeTodoPayload(t *testing.T) {
	t.Parallel()
	if got := acpToolName("todo-1", "0 todos", "other", map[string]any{"todos": []any{}}); got != "TodoWrite" {
		t.Fatalf("acpToolName() = %q, want TodoWrite", got)
	}
}

func TestStandardACPAdapterSessionStateExposesPendingAskUserPrompt(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-interactive-1")
	transport.conn.promptKind = "ask-user"
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "hermes-session-interactive-1"

	var mu sync.Mutex
	var emittedActivity []activityshared.Event
	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("choose renderer"), "", "turn-ask-user", func(events []activityshared.Event) {
			mu.Lock()
			emittedActivity = append(emittedActivity, events...)
			mu.Unlock()
		}, nil)
		execDone <- err
	}()

	waitForCondition(t, func() bool {
		snapshot := adapter.SessionState(session)
		return snapshot.PendingInteractive != nil &&
			snapshot.PendingInteractive.Kind == "ask-user" &&
			snapshot.PendingInteractive.RequestID == "permission-1"
	})

	snapshot := adapter.SessionState(session)
	if snapshot.PendingInteractive == nil {
		t.Fatal("pending interactive = nil, want ask-user prompt")
	}
	if snapshot.PendingInteractive.ToolName != "AskUserQuestion" {
		t.Fatalf("tool name = %q, want AskUserQuestion", snapshot.PendingInteractive.ToolName)
	}
	questions, _ := snapshot.PendingInteractive.Input["questions"].([]any)
	if len(questions) == 0 {
		t.Fatalf("interactive input = %#v, want questions", snapshot.PendingInteractive.Input)
	}
	mu.Lock()
	events := append([]activityshared.Event(nil), emittedActivity...)
	mu.Unlock()
	if requested := eventsOfType(events, activityshared.EventInteractionRequested); len(requested) != 1 ||
		requested[0].Payload.Interaction == nil || requested[0].Payload.Interaction.Kind != "question" {
		t.Fatalf("ask-user events = %#v, want explicit question interaction.requested", events)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := adapter.SubmitInteractive(canceled, session, SubmitInteractiveInput{
		RoomID:         session.RoomID,
		AgentSessionID: session.AgentSessionID,
		TurnID:         "turn-ask-user",
		RequestID:      "permission-1",
		Action:         "submit",
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled SubmitInteractive error = %v, want context canceled", err)
	}
	if pending := adapter.getPendingApproval(session.AgentSessionID, "turn-ask-user", "permission-1"); pending == nil || pending.disposition() != pendingInteractiveRequestStatePending {
		t.Fatalf("pending disposition after canceled submit = %v, want pending", runtimeInteractiveDisposition(pending))
	}

	_, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		RoomID:         session.RoomID,
		AgentSessionID: session.AgentSessionID,
		TurnID:         "turn-ask-user",
		RequestID:      "permission-1",
		Action:         "submit",
		// Canonical GUI ask-user payload: flat display list + keyed map.
		Payload: map[string]any{
			"answers":             []any{"Renderer A"},
			"answersByQuestionId": map[string]any{"render-path": "Renderer A"},
		},
	})
	if err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if err := <-execDone; err != nil {
		t.Fatalf("Exec after interactive submission: %v", err)
	}
	outcome := transport.conn.interactiveOutcome()
	if got := asString(outcome["outcome"]); got != "submit" {
		t.Fatalf("interactive outcome = %#v, want submit", outcome)
	}
	payload, _ := outcome["payload"].(map[string]any)
	if payload == nil || payload["answersByQuestionId"] == nil {
		t.Fatalf("interactive payload = %#v, want answersByQuestionId", outcome)
	}
}

func TestStandardACPAdapterSessionStateExposesPendingExitPlanPrompt(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-plan-1")
	transport.conn.promptKind = "exit-plan"
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "hermes-session-plan-1"

	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("review plan"), "", "turn-plan", func([]activityshared.Event) {}, nil)
		execDone <- err
	}()

	waitForCondition(t, func() bool {
		snapshot := adapter.SessionState(session)
		return snapshot.PendingInteractive != nil &&
			snapshot.PendingInteractive.Kind == "exit-plan" &&
			snapshot.PendingInteractive.RequestID == "permission-1"
	})

	snapshot := adapter.SessionState(session)
	if snapshot.PendingInteractive == nil || snapshot.PendingInteractive.ToolName != "ExitPlanMode" {
		t.Fatalf("pending interactive = %#v, want ExitPlanMode", snapshot.PendingInteractive)
	}

	_, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		RoomID:         session.RoomID,
		AgentSessionID: session.AgentSessionID,
		TurnID:         "turn-plan",
		RequestID:      "permission-1",
		Action:         "allow",
		OptionID:       "acceptEdits",
	})
	if err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if err := <-execDone; err != nil {
		t.Fatalf("Exec after exit-plan submission: %v", err)
	}
	outcome := transport.conn.interactiveOutcome()
	if got := asString(outcome["optionId"]); got != "acceptEdits" {
		t.Fatalf("interactive outcome = %#v, want optionId acceptEdits", outcome)
	}
}

func TestStandardACPToolCallLifecycleReusesStableEventID(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name     string
		provider string
		config   standardACPConfig
	}{
		{
			name:     "hermes default config",
			provider: ProviderHermes,
			config:   standardACPConfig{provider: ProviderHermes},
		},
		{
			name:     "hermes",
			provider: ProviderHermes,
			config:   standardACPConfig{provider: ProviderHermes},
		},
		{
			name:     "openclaw",
			provider: ProviderOpenClaw,
			config:   standardACPConfig{provider: ProviderOpenClaw},
		},
		{
			name:     "opencode",
			provider: ProviderOpenCode,
			config:   standardACPConfig{provider: ProviderOpenCode},
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			session := standardTestSession(tc.provider)
			session.ProviderSessionID = tc.name + "-session-1"
			normalizer := newACPTurnNormalizer()

			started := standardACPUpdateEvents(tc.config, session, "turn-1", json.RawMessage(`{
				"update": {
					"sessionUpdate": "tool_call",
					"toolCallId": "tool-current",
					"title": "Bash",
					"status": "pending",
					"kind": "tool",
					"rawInput": {"command": "pwd"}
				}
			}`), normalizer)
			if len(started) != 1 || started[0].Type != activityshared.EventCallStarted {
				t.Fatalf("started events = %#v, want one call.started", started)
			}

			completed := standardACPUpdateEvents(tc.config, session, "turn-1", json.RawMessage(`{
				"update": {
					"sessionUpdate": "tool_call_update",
					"toolCallId": "tool-current",
					"title": "Bash",
					"status": "completed",
					"kind": "tool",
					"rawOutput": {"stdout": "/workspace/app\n"}
				}
			}`), normalizer)
			if len(completed) != 1 || completed[0].Type != activityshared.EventCallCompleted {
				t.Fatalf("completed events = %#v, want one call.completed", completed)
			}
			if started[0].EventID == "" {
				t.Fatalf("started event id = empty, want stable event id")
			}
			if completed[0].EventID != started[0].EventID {
				t.Fatalf("event ids = %q / %q, want same stable tool event id", started[0].EventID, completed[0].EventID)
			}
		})
	}
}

func TestStandardACPNormalizerSegmentsAssistantAndThinkingAroundToolCalls(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderHermes)
	session.ProviderSessionID = "hermes-session-segment-1"
	normalizer := newACPTurnNormalizer()

	var events []activityshared.Event
	events = append(events, normalizer.AppendThinkingChunk(session, "turn-1", "Thinking before tool. ")...)
	events = append(events, normalizer.AppendAssistantChunk(session, "turn-1", "Before tool. ")...)
	events = append(events, standardACPUpdateEvents(standardACPConfig{provider: ProviderHermes}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call",
			"toolCallId": "tool-segment-1",
			"title": "Bash",
			"status": "pending"
		}
	}`), normalizer)...)
	events = append(events, normalizer.AppendThinkingChunk(session, "turn-1", "Thinking after tool. ")...)
	events = append(events, normalizer.AppendAssistantChunk(session, "turn-1", "After tool.")...)
	events = append(events, normalizer.Finish(session, "turn-1", messageStreamStateCompleted)...)

	assistantMessages := activityMessagesWithRole(events, activityshared.MessageRoleAssistant)
	if len(assistantMessages) != 4 {
		t.Fatalf("assistant messages = %#v, want streaming+completed before tool and streaming+completed after tool", assistantMessages)
	}
	if assistantMessages[0].EventID == "" ||
		assistantMessages[1].EventID != assistantMessages[0].EventID ||
		assistantMessages[2].EventID == "" ||
		assistantMessages[3].EventID != assistantMessages[2].EventID ||
		assistantMessages[2].EventID == assistantMessages[0].EventID {
		t.Fatalf("assistant event IDs = %#v, want distinct IDs split by tool boundary", assistantMessages)
	}
	if assistantMessages[1].Payload.Content != "Before tool. " ||
		assistantMessages[3].Payload.Content != "After tool." {
		t.Fatalf("assistant contents = %#v, want text split around tool call", assistantMessages)
	}

	thinkingMessages := activityMessagesWithRole(events, activityshared.MessageRoleAssistantThinking)
	if len(thinkingMessages) != 4 {
		t.Fatalf("thinking messages = %#v, want streaming+completed before tool and streaming+completed after tool", thinkingMessages)
	}
	if thinkingMessages[0].EventID == "" ||
		thinkingMessages[1].EventID != thinkingMessages[0].EventID ||
		thinkingMessages[2].EventID == "" ||
		thinkingMessages[3].EventID != thinkingMessages[2].EventID ||
		thinkingMessages[2].EventID == thinkingMessages[0].EventID {
		t.Fatalf("thinking event IDs = %#v, want distinct IDs split by tool boundary", thinkingMessages)
	}
	if thinkingMessages[1].Payload.Content != "Thinking before tool. " ||
		thinkingMessages[3].Payload.Content != "Thinking after tool. " {
		t.Fatalf("thinking contents = %#v, want thinking split around tool call", thinkingMessages)
	}

	if events[2].Type != activityshared.EventMessageAppended ||
		events[3].Type != activityshared.EventMessageAppended ||
		events[4].Type != activityshared.EventCallStarted ||
		events[5].Type != activityshared.EventMessageAppended ||
		events[6].Type != activityshared.EventMessageAppended {
		t.Fatalf("event order = %#v, want thinking completion, assistant completion, tool call, then next segments", events)
	}
}

func TestStandardACPUpdateDoesNotProjectInternalMentionRoutingTitle(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderHermes)
	session.ProviderSessionID = "hermes-session-1"
	events := standardACPUpdateEvents(standardACPConfig{provider: ProviderHermes}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "session_info_update",
			"title": "`+tuttiMentionRoutingReminder+`"
		}
	}`), newACPTurnNormalizer())
	for _, event := range events {
		if event.Payload.Title == tuttiMentionRoutingReminder {
			t.Fatalf("events = %#v, want internal mention routing title excluded from title updates", events)
		}
	}
}

func TestStandardACPSystemNoticeChunkProjectsAssistantNotice(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderHermes)
	session.ProviderSessionID = "hermes-session-1"

	events := standardACPUpdateEvents(standardACPConfig{provider: ProviderHermes}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "agent_message_chunk",
			"content": {
				"type": "text",
				"text": "Codex switched to HTTPS transport."
			},
			"_meta": {
				"tsh": {
					"kind": "agent_system_notice",
					"noticeKind": "transport_fallback",
					"severity": "warning",
					"title": "Codex switched to HTTPS transport.",
					"detail": "Falling back from WebSockets to HTTPS transport."
				}
			}
		}
	}`), newACPTurnNormalizer())

	if len(events) != 1 {
		t.Fatalf("events = %#v, want one system notice message", events)
	}
	event := events[0]
	if event.Type != activityshared.EventMessageAppended || event.Payload.Role != activityshared.MessageRoleAssistant {
		t.Fatalf("event = %#v, want assistant message", event)
	}
	if got := event.Payload.Metadata["kind"]; got != "agent_system_notice" {
		t.Fatalf("notice kind marker = %#v, want agent_system_notice", got)
	}
	if got := event.Payload.Metadata["noticeKind"]; got != "transport_fallback" {
		t.Fatalf("noticeKind = %#v, want transport_fallback", got)
	}
}

func TestNexightSpawnCommandCarriesModelSettings(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		settings *SessionSettings
		want     []string
	}{
		{
			name:     "spark model adds reasoning summary override",
			settings: &SessionSettings{Model: "gpt-5.3-codex-spark", ReasoningEffort: "high"},
			want: []string{
				nexightACPCommand,
				"--config", "model=gpt-5.3-codex-spark",
				"--config", "model_reasoning_summary=none",
				"--config", "model_reasoning_effort=high",
			},
		},
		{
			name:     "plain model omits reasoning summary override",
			settings: &SessionSettings{Model: "gpt-5.1-codex", ReasoningEffort: "medium"},
			want: []string{
				nexightACPCommand,
				"--config", "model=gpt-5.1-codex",
				"--config", "model_reasoning_effort=medium",
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			transport := newStandardACPTransport("Nexight", "nexight-session-1")
			adapter := NewNexightAdapter(transport)
			session := standardTestSession(ProviderNexight)
			session.Settings = tc.settings
			if _, err := adapter.Start(context.Background(), session); err != nil {
				t.Fatalf("Start: %v", err)
			}
			transport.mu.Lock()
			specs := append([]ProcessSpec(nil), transport.specs...)
			transport.mu.Unlock()
			if len(specs) != 1 {
				t.Fatalf("specs = %#v, want one process spawn", specs)
			}
			if !reflect.DeepEqual(specs[0].Command, tc.want) {
				t.Fatalf("spawn command = %#v, want %#v", specs[0].Command, tc.want)
			}
		})
	}
}

func TestNexightRequiresNewSessionWhenReasoningSummaryOverrideChanges(t *testing.T) {
	t.Parallel()

	adapter := NewNexightAdapter(nil)
	session := standardTestSession(ProviderNexight)
	session.Settings = &SessionSettings{Model: "gpt-5.1-codex"}

	sparkModel := "gpt-5.3-codex-spark"
	if !adapter.RequiresNewSessionForSettings(session, SessionSettingsPatch{Model: &sparkModel}) {
		t.Fatal("switching to a spark-family model must force a new session (spawn-time model_reasoning_summary override)")
	}
	plainModel := "gpt-5.2-codex"
	if adapter.RequiresNewSessionForSettings(session, SessionSettingsPatch{Model: &plainModel}) {
		t.Fatal("plain-to-plain model change must not force a new session")
	}
	if adapter.RequiresNewSessionForSettings(session, SessionSettingsPatch{}) {
		t.Fatal("empty patch must not force a new session")
	}
}

func TestStandardACPSpawnCommandUnchangedForOtherProviders(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-1")
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)
	session.Settings = &SessionSettings{Model: "gpt-5.3-codex-spark", ReasoningEffort: "high"}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	transport.mu.Lock()
	specs := append([]ProcessSpec(nil), transport.specs...)
	transport.mu.Unlock()
	if len(specs) != 1 || !reflect.DeepEqual(specs[0].Command, []string{"hermes", "acp"}) {
		t.Fatalf("spawn command = %#v, want bare hermes command", specs)
	}
	sparkModel := "gpt-5.3-codex-spark"
	if adapter.RequiresNewSessionForSettings(session, SessionSettingsPatch{Model: &sparkModel}) {
		t.Fatal("non-nexight providers must not force new sessions for model changes")
	}
}

func TestStandardACPTransportFallbackTextProjectsAssistantNotice(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderNexight)
	session.ProviderSessionID = "nexight-session-1"

	events := standardACPUpdateEvents(NewNexightAdapter(nil).config, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "agent_message_chunk",
			"content": {
				"type": "text",
				"text": "Falling back from WebSockets to HTTPS transport."
			}
		}
	}`), newACPTurnNormalizer())

	if len(events) != 1 {
		t.Fatalf("events = %#v, want one system notice message", events)
	}
	if got := events[0].Payload.Metadata["kind"]; got != "agent_system_notice" {
		t.Fatalf("notice kind marker = %#v, want agent_system_notice", got)
	}
	if got := events[0].Payload.Metadata["noticeKind"]; got != "transport_fallback" {
		t.Fatalf("noticeKind = %#v, want transport_fallback", got)
	}
}

func TestStandardACPReconnectThoughtChunkProjectsAssistantNotice(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderNexight)
	session.ProviderSessionID = "nexight-session-1"

	events := standardACPUpdateEvents(NewNexightAdapter(nil).config, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "agent_thought_chunk",
			"content": {
				"type": "text",
				"text": "Reconnecting... 1/5 Some(ResponseStreamDisconnected { http_status_code: None })"
			}
		}
	}`), newACPTurnNormalizer())

	if len(events) != 1 {
		t.Fatalf("events = %#v, want one system notice message", events)
	}
	if got := events[0].Payload.Metadata["kind"]; got != "agent_system_notice" {
		t.Fatalf("notice kind marker = %#v, want agent_system_notice", got)
	}
	if got := events[0].Payload.Metadata["noticeKind"]; got != "transport_retry" {
		t.Fatalf("noticeKind = %#v, want transport_retry", got)
	}
}

func TestNexightACPSystemNoticeMessageFromStderr(t *testing.T) {
	t.Parallel()

	mapper := NewNexightAdapter(nil).config.stderrMessageMapper
	if mapper == nil {
		t.Fatal("nexight config stderrMessageMapper = nil, want stream-error mapper")
	}

	message, ok := mapper([]byte(
		`2026-05-29T09:05:51.179821Z ERROR codex_acp::thread: Handled error during turn: Reconnecting... 1/5 Some(ResponseStreamDisconnected { http_status_code: Some(401) }) Some("unexpected status 401 Unauthorized")`,
	))
	if !ok {
		t.Fatal("stderr notice ok = false, want true")
	}
	if message.Method != acpMethodUpdate {
		t.Fatalf("method = %q, want %q", message.Method, acpMethodUpdate)
	}
	var params struct {
		Update map[string]any `json:"update"`
	}
	if err := json.Unmarshal(message.Params, &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if got := params.Update["sessionUpdate"]; got != "stream_error" {
		t.Fatalf("sessionUpdate = %#v, want stream_error", got)
	}
	if got := params.Update["noticeKind"]; got != "transport_retry" {
		t.Fatalf("noticeKind = %#v, want transport_retry", got)
	}
	if got := params.Update["source"]; got != "acp_stderr" {
		t.Fatalf("source = %#v, want acp_stderr", got)
	}

	if _, ok := mapper([]byte("WARN unrelated")); ok {
		t.Fatal("generic stderr ok = true, want false")
	}
}

func TestStandardACPTransportFallbackTextStaysProviderScoped(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderHermes)
	session.ProviderSessionID = "hermes-session-1"

	events := standardACPUpdateEvents(standardACPConfig{provider: ProviderHermes}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "agent_message_chunk",
			"content": {
				"type": "text",
				"text": "Falling back from WebSockets to HTTPS transport."
			}
		}
	}`), newACPTurnNormalizer())

	if len(events) != 1 {
		t.Fatalf("events = %#v, want normal assistant chunk for non-Codex providers", events)
	}
	if got := events[0].Payload.Metadata["kind"]; got == "agent_system_notice" {
		t.Fatalf("notice kind marker = %#v, want ordinary assistant message", got)
	}
	if got := events[0].Payload.Content; got != "Falling back from WebSockets to HTTPS transport." {
		t.Fatalf("content = %q, want ordinary assistant content", got)
	}
}

func TestStandardACPConfigOptionUpdateSignalsSessionStateReload(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderOpenCode)
	session.ProviderSessionID = "opencode-session-1"

	events := standardACPUpdateEvents(standardACPConfig{provider: ProviderOpenCode}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "config_option_update",
			"key": "model",
			"value": "opus"
		}
	}`), newACPTurnNormalizer())

	if len(events) != 1 {
		t.Fatalf("events = %#v, want one session update signal", events)
	}
	if events[0].Type != activityshared.EventSessionUpdated {
		t.Fatalf("event type = %q, want session updated", events[0].Type)
	}
	if got := events[0].Payload.Metadata["sessionUpdateKind"]; got != "config_option_update" {
		t.Fatalf("metadata sessionUpdateKind = %#v, want config_option_update", got)
	}
	if got := events[0].Payload.Metadata["configOptionKey"]; got != "model" {
		t.Fatalf("metadata configOptionKey = %#v, want model", got)
	}
}

func TestStandardACPIgnoresForeignProviderSessionUpdateDuringTurn(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-current")
	adapter := newOpenCodeTestAdapter(transport)
	session := standardTestSession(ProviderOpenCode)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "opencode-session-current"

	var commandSnapshots []AgentSessionCommandSnapshot
	var emittedEvents [][]activityshared.Event
	var configUpdates []AgentSessionConfigOptionsUpdate
	adapter.SetCommandSnapshotSink(func(snapshot AgentSessionCommandSnapshot) {
		commandSnapshots = append(commandSnapshots, snapshot)
	})
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		emittedEvents = append(emittedEvents, events)
	})
	adapter.SetConfigOptionsUpdateSink(func(update AgentSessionConfigOptionsUpdate) {
		configUpdates = append(configUpdates, update)
	})

	events, err := adapter.handleACPMessage(context.Background(), nil, session, "turn-foreign", acpMessage{
		Method: acpMethodUpdate,
		Params: json.RawMessage(`{
			"sessionId": "opencode-session-foreign",
			"update": {
				"sessionUpdate": "session_info_update",
				"title": "Foreign title"
			}
		}`),
	}, newACPTurnNormalizer(), nil, nil)
	if err != nil {
		t.Fatalf("handle foreign title update: %v", err)
	}
	if len(events) != 0 || len(emittedEvents) != 0 {
		t.Fatalf("foreign title events = %#v emitted=%#v, want none", events, emittedEvents)
	}

	if _, err := adapter.handleACPMessage(context.Background(), nil, session, "turn-foreign", acpMessage{
		Method: acpMethodUpdate,
		Params: json.RawMessage(`{
			"sessionId": "opencode-session-foreign",
			"update": {
				"sessionUpdate": "available_commands_update",
				"availableCommands": [{
					"name": "foreign-web",
					"description": "Foreign command"
				}]
			}
		}`),
	}, newACPTurnNormalizer(), nil, nil); err != nil {
		t.Fatalf("handle foreign command update: %v", err)
	}
	if _, err := adapter.handleACPMessage(context.Background(), nil, session, "turn-foreign", acpMessage{
		Method: acpMethodUpdate,
		Params: json.RawMessage(`{
			"sessionId": "opencode-session-foreign",
			"update": {
				"sessionUpdate": "config_option_update",
				"key": "model",
				"value": "foreign-model"
			}
		}`),
	}, newACPTurnNormalizer(), nil, nil); err != nil {
		t.Fatalf("handle foreign config update: %v", err)
	}
	if len(commandSnapshots) != 0 {
		t.Fatalf("foreign command snapshots = %#v, want none", commandSnapshots)
	}
	if len(configUpdates) != 0 {
		t.Fatalf("foreign config updates = %#v, want none", configUpdates)
	}

	snapshot, ok := adapter.SessionCommandSnapshot(session)
	if ok {
		if names := agentSessionCommandNames(snapshot.Commands); containsString(names, "foreign-web") {
			t.Fatalf("command names = %#v, want foreign command filtered", names)
		}
	}
	state := adapter.SessionState(session)
	config := payloadObject(state.RuntimeContext["config"])
	if got := asString(config["model"]); got == "foreign-model" {
		t.Fatalf("runtime config model = %q, want foreign config filtered", got)
	}
}

func TestStandardACPAcceptsMatchingProviderSessionUpdate(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-current")
	adapter := newOpenCodeTestAdapter(transport)
	session := standardTestSession(ProviderOpenCode)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "opencode-session-current"

	events, err := adapter.handleACPMessage(context.Background(), nil, session, "turn-current", acpMessage{
		Method: acpMethodUpdate,
		Params: json.RawMessage(`{
			"sessionId": "opencode-session-current",
			"update": {
				"sessionUpdate": "session_info_update",
				"title": "Current title"
			}
		}`),
	}, newACPTurnNormalizer(), nil, nil)
	if err != nil {
		t.Fatalf("handle matching update: %v", err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionUpdated {
		t.Fatalf("events = %#v, want matching session update projected", events)
	}
	if got := events[0].Payload.Title; got != "Current title" {
		t.Fatalf("title = %q, want Current title", got)
	}
}

func TestStandardACPAdapterExecAddsInternalMentionRoutingPromptForGemini(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-mention-routing")
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)
	session.PermissionModeID = "full-access"
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	prompt := "[@User & Codex story](mention://agent-session/session-1?workspaceId=workspace-1&provider=codex) 这里有什么内容？"

	if _, err := adapter.Exec(context.Background(), session, textPrompt(prompt), "", "turn-mention", func([]activityshared.Event) {}, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}

	texts := promptTexts(t, transport.conn.lastPromptParamsSnapshot)
	if len(texts) < 2 {
		t.Fatalf("prompt texts = %#v, want user prompt plus internal routing", texts)
	}
	if texts[0] != prompt {
		t.Fatalf("user prompt text = %q, want unmodified prompt %q", texts[0], prompt)
	}
	if texts[len(texts)-1] != tuttiAgentMentionRoutingReminder {
		t.Fatalf("routing prompt = %q, want internal mention routing", texts[len(texts)-1])
	}
}

func firstPromptText(t *testing.T, params map[string]any) string {
	t.Helper()
	texts := promptTexts(t, params)
	if len(texts) == 0 {
		t.Fatalf("prompt params = %#v, want prompt text", params)
	}
	return texts[0]
}

func promptTexts(t *testing.T, params map[string]any) []string {
	t.Helper()
	items, ok := params["prompt"].([]any)
	if !ok || len(items) == 0 {
		t.Fatalf("prompt params = %#v, want prompt items", params)
	}
	texts := make([]string, 0, len(items))
	for _, item := range items {
		block, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("prompt item = %#v, want map", item)
		}
		text, ok := block["text"].(string)
		if !ok {
			continue
		}
		texts = append(texts, text)
	}
	return texts
}

func firstUserMessageContent(t *testing.T, events []activityshared.Event) string {
	t.Helper()
	for _, event := range events {
		if event.Type == activityshared.EventMessageAppended && event.Payload.Role == activityshared.MessageRoleUser {
			return event.Payload.Content
		}
	}
	t.Fatalf("events = %#v, want user message event", events)
	return ""
}

func configOptionDescriptorValues(descriptors []map[string]any, configID string) []string {
	for _, descriptor := range descriptors {
		if strings.TrimSpace(asString(descriptor["id"])) != configID {
			continue
		}
		switch options := descriptor["options"].(type) {
		case []any:
			values := make([]string, 0, len(options))
			for _, option := range options {
				record, ok := option.(map[string]any)
				if !ok {
					continue
				}
				if value := strings.TrimSpace(asString(record["value"])); value != "" {
					values = append(values, value)
				}
			}
			return values
		case []map[string]any:
			values := make([]string, 0, len(options))
			for _, option := range options {
				if value := strings.TrimSpace(asString(option["value"])); value != "" {
					values = append(values, value)
				}
			}
			return values
		default:
			return nil
		}
	}
	return nil
}

func configOptionDescriptorOptionDescription(descriptors []map[string]any, configID string, value string) string {
	for _, descriptor := range descriptors {
		if strings.TrimSpace(asString(descriptor["id"])) != configID {
			continue
		}
		switch options := descriptor["options"].(type) {
		case []any:
			for _, option := range options {
				record, ok := option.(map[string]any)
				if !ok {
					continue
				}
				if strings.TrimSpace(asString(record["value"])) == value {
					return strings.TrimSpace(asString(record["description"]))
				}
			}
		case []map[string]any:
			for _, option := range options {
				if strings.TrimSpace(asString(option["value"])) == value {
					return strings.TrimSpace(asString(option["description"]))
				}
			}
		}
	}
	return ""
}

func TestHermesAdapterStartPreservesCommandsAdvertisedDuringNewSession(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-commands")
	transport.conn.commandUpdateOnNewSession = true
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	snapshot, ok := adapter.SessionCommandSnapshot(session)
	if !ok || len(snapshot.Commands) != 1 ||
		snapshot.Commands[0].Name != "web" ||
		snapshot.Commands[0].Description != "Search the web" ||
		snapshot.Commands[0].InputHint != "query" {
		t.Fatalf("command snapshot = %#v ok=%v, want command update preserved from session/new", snapshot, ok)
	}
	state := adapter.SessionState(session)
	commands, ok := state.RuntimeContext["availableCommands"].([]map[string]any)
	if !ok || len(commands) != 1 || commands[0]["name"] != "web" || commands[0]["description"] != "Search the web" || commands[0]["inputHint"] != "query" {
		t.Fatalf("runtime availableCommands = %#v", state.RuntimeContext["availableCommands"])
	}
}

func TestControllerPublishesIdleStandardACPCommandUpdatesAfterStart(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-idle-commands")
	adapter := newOpenCodeTestAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	session := standardTestSession(ProviderOpenCode)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           session.RoomID,
		AgentSessionID:   session.AgentSessionID,
		Provider:         session.Provider,
		CWD:              session.CWD,
		PermissionModeID: session.PermissionModeID,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	stream, unsubscribe, ok := controller.Subscribe(started.Session.RoomID, started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe ok=false, want live session stream")
	}
	defer unsubscribe()

	transport.conn.sendAvailableCommandsUpdate()

	deadline := time.After(time.Second)
	for {
		select {
		case event := <-stream:
			if event.EventType != StreamEventAvailableCommands {
				continue
			}
			snapshot, ok := event.Data.(AgentSessionCommandSnapshot)
			if !ok {
				t.Fatalf("event data = %#v, want AgentSessionCommandSnapshot", event.Data)
			}
			if len(snapshot.Commands) == 1 && snapshot.Commands[0].Name == "web" {
				return
			}
		case <-deadline:
			t.Fatal("idle available_commands_update was not published")
		}
	}
}

func TestControllerPublishesIdleStandardACPGoalUpdatesAfterStart(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-idle-goal")
	adapter := newOpenCodeTestAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	session := standardTestSession(ProviderOpenCode)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           session.RoomID,
		AgentSessionID:   session.AgentSessionID,
		Provider:         session.Provider,
		CWD:              session.CWD,
		PermissionModeID: session.PermissionModeID,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	stream, unsubscribe, ok := controller.Subscribe(started.Session.RoomID, started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe ok=false, want live session stream")
	}
	defer unsubscribe()

	transport.conn.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": transport.conn.sessionID,
			"update": map[string]any{
				"sessionUpdate": "thread_goal_update",
				"goal": map[string]any{
					"objective": "ship slash commands",
					"status":    "active",
				},
			},
		},
	})

	deadline := time.After(time.Second)
	for {
		select {
		case event := <-stream:
			if event.EventType != StreamEventStatePatch {
				continue
			}
			patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
			if !ok {
				t.Fatalf("event data = %#v, want WorkspaceAgentStatePatch", event.Data)
			}
			goal := payloadObject(patch.RuntimeContext["goal"])
			if asString(goal["objective"]) == "ship slash commands" {
				return
			}
		case <-deadline:
			t.Fatal("idle thread_goal_update was not published")
		}
	}
}

func TestControllerSyncCursorPlanModeFromACPUpdate(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-plan-sync")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	controller := NewController([]Adapter{adapter}, nil)
	session := standardTestSession(ProviderCursor)
	session.PermissionModeID = "agent"
	session.Settings = &SessionSettings{
		PermissionModeID: "agent",
		PlanMode:         false,
	}

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           session.RoomID,
		AgentSessionID:   session.AgentSessionID,
		Provider:         session.Provider,
		CWD:              session.CWD,
		PermissionModeID: session.PermissionModeID,
		Settings:         session.Settings,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	stream, unsubscribe, ok := controller.Subscribe(started.Session.RoomID, started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe ok=false, want live session stream")
	}
	defer unsubscribe()

	transport.conn.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": transport.conn.sessionID,
			"update": map[string]any{
				"sessionUpdate": "current_mode_update",
				"currentModeId": "plan",
			},
		},
	})

	deadline := time.After(time.Second)
	for {
		select {
		case event := <-stream:
			if event.EventType != StreamEventStatePatch {
				continue
			}
			patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
			if !ok {
				t.Fatalf("event data = %#v, want WorkspaceAgentStatePatch", event.Data)
			}
			if patch.Settings != nil && patch.Settings["planMode"] == true {
				stored, ok := controller.get(started.Session.RoomID, started.Session.AgentSessionID)
				if !ok || stored.Settings == nil || !stored.Settings.PlanMode {
					t.Fatalf("stored session settings = %#v, want planMode true", stored.Settings)
				}
				if stored.PermissionModeID != "agent" {
					t.Fatalf("permission mode = %q, want unchanged agent", stored.PermissionModeID)
				}
				return
			}
		case <-deadline:
			t.Fatal("cursor current_mode_update did not publish planMode state patch")
		}
	}
}

func TestControllerPublishesIdleStandardACPConfigOptionsUpdatesAfterStart(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-idle-config-options")
	adapter := newOpenCodeTestAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	session := standardTestSession(ProviderOpenCode)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           session.RoomID,
		AgentSessionID:   session.AgentSessionID,
		Provider:         session.Provider,
		CWD:              session.CWD,
		PermissionModeID: session.PermissionModeID,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	stream, unsubscribe, ok := controller.Subscribe(started.Session.RoomID, started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe ok=false, want live session stream")
	}
	defer unsubscribe()

	transport.conn.sendConfigOptionsUpdate("model", "opus")

	event := waitForStreamEventType(t, stream, StreamEventConfigOptions)
	update, ok := event.Data.(AgentSessionConfigOptionsUpdate)
	if !ok {
		t.Fatalf("event data = %#v, want AgentSessionConfigOptionsUpdate", event.Data)
	}
	if update.AgentSessionID != started.Session.AgentSessionID || update.ConfigOptionKey != "model" {
		t.Fatalf("config options update = %#v, want model update for session", update)
	}
}

func TestStandardACPAdapterResumePreservesCommandsAdvertisedDuringLoadSession(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenClaw", "openclaw-session-resume-commands")
	transport.conn.commandUpdateOnLoadSession = true
	adapter := NewOpenClawAdapter(transport)
	session := standardTestSession(ProviderOpenClaw)
	session.ProviderSessionID = "persisted-openclaw-session-id"
	transport.conn.sessionID = session.ProviderSessionID

	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}

	snapshot, ok := adapter.SessionCommandSnapshot(session)
	if !ok || len(snapshot.Commands) != 1 || snapshot.Commands[0].Name != "web" {
		t.Fatalf("command snapshot = %#v ok=%v, want command update preserved from resume", snapshot, ok)
	}
}

func TestStandardACPAdapterCloseSendsProtocolSessionCloseBeforeTransportClose(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-close")
	transport.conn.supportsCloseSession = true
	transport.conn.closeSessionExits = true
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := adapter.Close(context.Background(), session); err != nil {
		t.Fatalf("Close: %v", err)
	}

	params := transport.conn.closeSessionParams()
	if got := asString(params["sessionId"]); got != "hermes-session-close" {
		t.Fatalf("session/close sessionId = %q, want provider session id", got)
	}
	if !transport.conn.closed() {
		t.Fatal("transport was not closed after protocol session close")
	}
}

func TestStandardACPAdapterCloseFallsBackWhenProtocolSessionCloseFails(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-close-failure")
	transport.conn.supportsCloseSession = true
	transport.conn.closeSessionError = &acpError{Code: -32601, Message: "session close unavailable"}
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := adapter.Close(context.Background(), session); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if got := asString(transport.conn.closeSessionParams()["sessionId"]); got != "hermes-session-close-failure" {
		t.Fatalf("session/close sessionId = %q, want provider session id", got)
	}
	if !transport.conn.closed() {
		t.Fatal("transport was not closed after protocol close failure")
	}
}

func standardTestSession(provider string) Session {
	return Session{
		RoomID:            "room-1",
		AgentSessionID:    "agent-session-1",
		Provider:          provider,
		ProviderSessionID: "agent-session-1",
		CWD:               "/workspace/room-1",
		Status:            SessionStatusReady,
		Title:             provider,
	}
}

type standardACPTransport struct {
	mu    sync.Mutex
	specs []ProcessSpec
	conn  *standardACPConnection
}

type multiProcStandardACPTransport struct {
	mu         sync.Mutex
	agentTitle string
	sessionID  string
	specs      []ProcessSpec
	conns      []*standardACPConnection
}

func newStandardACPTransport(agentTitle string, sessionID string) *standardACPTransport {
	return &standardACPTransport{
		conn: &standardACPConnection{
			recv:       make(chan ProcessFrame, 32),
			agentTitle: agentTitle,
			sessionID:  sessionID,
		},
	}
}

func (t *standardACPTransport) Start(_ context.Context, spec ProcessSpec) (ProcessConnection, error) {
	t.mu.Lock()
	t.specs = append(t.specs, spec)
	t.mu.Unlock()
	return t.conn, nil
}

func (t *multiProcStandardACPTransport) Start(_ context.Context, spec ProcessSpec) (ProcessConnection, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	conn := &standardACPConnection{
		recv:       make(chan ProcessFrame, 32),
		agentTitle: t.agentTitle,
		sessionID:  t.sessionID,
	}
	t.specs = append(t.specs, spec)
	t.conns = append(t.conns, conn)
	return conn, nil
}

func (t *multiProcStandardACPTransport) snapshot() (spawned int, live []*standardACPConnection) {
	t.mu.Lock()
	conns := append([]*standardACPConnection(nil), t.conns...)
	t.mu.Unlock()
	for _, conn := range conns {
		conn.mu.Lock()
		closed := conn.isClosed
		conn.mu.Unlock()
		if !closed {
			live = append(live, conn)
		}
	}
	return len(conns), live
}

type standardACPConnection struct {
	mu                            sync.Mutex
	closeOnce                     sync.Once
	recv                          chan ProcessFrame
	agentTitle                    string
	sessionID                     string
	lastInitializeParamsSnapshot  map[string]any
	commandUpdateOnNewSession     bool
	commandUpdateOnLoadSession    bool
	promptPermission              bool
	promptKind                    string
	pauseBeforePromptResult       chan struct{}
	pauseBeforeToolCallCompletion chan struct{}
	pendingPermissionCallID       json.RawMessage
	selectedPermissionOption      string
	selectedInteractiveResult     map[string]any
	appliedModeID                 string
	lastSetModeParamsSnapshot     map[string]any
	lastAuthenticatedMethodID     string
	setModeError                  *acpError
	loadSessionError              *acpError
	closeSessionError             *acpError
	rejectModelValue              string
	supportsLoadSession           bool
	supportsCloseSession          bool
	closeSessionExits             bool
	isClosed                      bool
	lastNewSessionParams          map[string]any
	lastLoadSessionParams         map[string]any
	lastCloseSessionParams        map[string]any
	lastPromptParamsSnapshot      map[string]any
	promptParamsSnapshots         []map[string]any
	promptCallCount               int
	// retriableErrorPrompts makes the first N session/prompt calls emulate
	// cursor-agent's transient-failure shape: an "Error: RetriableError: ..."
	// text chunk followed by a normal end_turn result.
	retriableErrorPrompts int
	// retriableErrorPriorText, when set, is streamed as an agent_message_chunk
	// before the RetriableError tail so tests can exercise mid-task
	// auto-continue wording (useful progress before the drop).
	retriableErrorPriorText string
	// planLimitPromptError makes session/prompt fail with Cursor's plan-gate
	// copy so the adapter can soft-settle instead of emitting a red failure.
	planLimitPromptError bool
	// omitAssistantTextInPromptResults drops the agent_message_chunk from
	// normal prompt results, emulating a tool-calls-only turn.
	omitAssistantTextInPromptResults bool
	setConfigOptionSnapshots         []map[string]any
	configOptions                    []map[string]any
}

func (c *standardACPConnection) Send(data []byte) error {
	for _, line := range acpScanLines(data) {
		var message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.Unmarshal([]byte(line), &message)
		switch message.Method {
		case acpMethodInitialize:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				c.lastInitializeParamsSnapshot = maps.Clone(request.Params)
			}
			c.mu.Unlock()
			result := map[string]any{
				"protocolVersion": acpProtocolVersion,
				"agentInfo": map[string]any{
					"name":  strings.ToLower(strings.ReplaceAll(c.agentTitle, " ", "-")),
					"title": c.agentTitle,
				},
			}
			sessionCapabilities := map[string]any{}
			if strings.EqualFold(c.agentTitle, "OpenCode") {
				sessionCapabilities["resume"] = true
			}
			if c.supportsLoadSession || strings.EqualFold(strings.TrimSpace(c.agentTitle), "OpenClaw") {
				sessionCapabilities["load"] = true
			}
			if c.supportsCloseSession {
				sessionCapabilities["close"] = true
			}
			if len(sessionCapabilities) > 0 {
				result["sessionCapabilities"] = sessionCapabilities
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  result,
			})
		case acpMethodAuthenticate:
			var request struct {
				Params struct {
					MethodID string `json:"methodId"`
				} `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			c.lastAuthenticatedMethodID = request.Params.MethodID
			c.mu.Unlock()
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  map[string]any{},
			})
		case acpMethodNewSession:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				c.lastNewSessionParams = maps.Clone(request.Params)
			}
			c.mu.Unlock()
			if c.commandUpdateOnNewSession {
				c.sendAvailableCommandsUpdate()
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result": map[string]any{
					"sessionId":     c.sessionID,
					"configOptions": c.defaultConfigOptions(),
				},
			})
		case acpMethodLoadSession, acpMethodResume:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				c.lastLoadSessionParams = maps.Clone(request.Params)
			}
			c.mu.Unlock()
			if c.commandUpdateOnLoadSession {
				c.sendAvailableCommandsUpdate()
			}
			if c.loadSessionError != nil {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"error":   c.loadSessionError,
				})
				return nil
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result": map[string]any{
					"configOptions": c.defaultConfigOptions(),
				},
			})
		case acpMethodCloseSession:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				c.lastCloseSessionParams = maps.Clone(request.Params)
			}
			closeSessionError := c.closeSessionError
			closeSessionExits := c.closeSessionExits
			c.mu.Unlock()
			if closeSessionError != nil {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"error":   closeSessionError,
				})
				return nil
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  map[string]any{},
			})
			if closeSessionExits {
				c.closeRecv()
			}
		case acpMethodSetMode:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				if mid, ok := request.Params["modeId"].(string); ok {
					c.appliedModeID = mid
				}
				c.lastSetModeParamsSnapshot = maps.Clone(request.Params)
			}
			setModeError := c.setModeError
			c.mu.Unlock()
			if setModeError != nil {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"error":   setModeError,
				})
				return nil
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  map[string]any{},
			})
		case "session/set_config_option":
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				c.setConfigOptionSnapshots = append(c.setConfigOptionSnapshots, maps.Clone(request.Params))
			}
			rejectModelValue := c.rejectModelValue
			c.mu.Unlock()
			if rejectModelValue != "" && request.Params != nil {
				configID, _ := request.Params["configId"].(string)
				value, _ := request.Params["value"].(string)
				if configID == "model" && value == rejectModelValue {
					c.sendJSON(map[string]any{
						"jsonrpc": "2.0",
						"id":      message.ID,
						"error": &acpError{
							Code:    -32603,
							Message: "Internal error",
							Data:    json.RawMessage(`{"details":"Invalid value for config option model: ` + value + `"}`),
						},
					})
					return nil
				}
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  map[string]any{},
			})
		case acpMethodPrompt:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				c.lastPromptParamsSnapshot = maps.Clone(request.Params)
				c.promptParamsSnapshots = append(c.promptParamsSnapshots, maps.Clone(request.Params))
			}
			c.promptCallCount++
			promptCall := c.promptCallCount
			c.mu.Unlock()
			if c.planLimitPromptError {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"error": map[string]any{
						"code":    -32000,
						"message": "Upgrade your plan to continue",
					},
				})
				return nil
			}
			if promptCall <= c.retriableErrorPrompts {
				c.mu.Lock()
				priorText := c.retriableErrorPriorText
				c.mu.Unlock()
				if priorText != "" {
					c.sendJSON(map[string]any{
						"jsonrpc": "2.0",
						"method":  acpMethodUpdate,
						"params": map[string]any{
							"sessionId": c.sessionID,
							"update": map[string]any{
								"sessionUpdate": "agent_message_chunk",
								"content": map[string]any{
									"type": "text",
									"text": priorText,
								},
							},
						},
					})
				}
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"method":  acpMethodUpdate,
					"params": map[string]any{
						"sessionId": c.sessionID,
						"update": map[string]any{
							"sessionUpdate": "agent_message_chunk",
							"content": map[string]any{
								"type": "text",
								"text": "\n\nError: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)",
							},
						},
					},
				})
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"result":  map[string]any{"stopReason": "end_turn"},
				})
				return nil
			}
			if c.promptPermission || c.promptKind != "" {
				c.mu.Lock()
				c.pendingPermissionCallID = append(json.RawMessage(nil), message.ID...)
				c.mu.Unlock()
				toolCall, options := c.promptRequest()
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      "permission-1",
					"method":  acpMethodPermission,
					"params": map[string]any{
						"toolCall": toolCall,
						"options":  options,
					},
				})
				return nil
			}
			c.streamPromptResult(message.ID)
		default:
			if (c.promptPermission || c.promptKind != "") && acpRequestID(message.ID) == "permission-1" {
				var response struct {
					Result struct {
						Outcome struct {
							OptionID string         `json:"optionId"`
							Outcome  string         `json:"outcome"`
							Payload  map[string]any `json:"payload"`
						} `json:"outcome"`
					} `json:"result"`
				}
				_ = json.Unmarshal([]byte(line), &response)
				c.mu.Lock()
				c.selectedPermissionOption = response.Result.Outcome.OptionID
				c.selectedInteractiveResult = map[string]any{
					"outcome":  response.Result.Outcome.Outcome,
					"optionId": response.Result.Outcome.OptionID,
					"payload":  clonePayload(response.Result.Outcome.Payload),
				}
				promptID := append(json.RawMessage(nil), c.pendingPermissionCallID...)
				c.mu.Unlock()
				c.streamPromptResult(promptID)
			}
		}
	}
	return nil
}

func (c *standardACPConnection) streamPromptResult(promptID json.RawMessage) {
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": c.sessionID,
			"update": map[string]any{
				"sessionUpdate": "session_info_update",
				"title":         "Inspect workspace state",
			},
		},
	})
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": c.sessionID,
			"update": map[string]any{
				"sessionUpdate": "agent_thought_chunk",
				"content": map[string]any{
					"type": "text",
					"text": "Need more context.",
				},
			},
		},
	})
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": c.sessionID,
			"update": map[string]any{
				"sessionUpdate": "tool_call",
				"toolCallId":    "tool-1",
				"title":         "Read workspace files",
				"kind":          "execute",
				"status":        "pending",
				"rawInput": map[string]any{
					"path": "/workspace/room-1",
				},
			},
		},
	})
	if !c.omitAssistantTextInPromptResults {
		c.sendJSON(map[string]any{
			"jsonrpc": "2.0",
			"method":  acpMethodUpdate,
			"params": map[string]any{
				"sessionId": c.sessionID,
				"update": map[string]any{
					"sessionUpdate": "agent_message_chunk",
					"content": map[string]any{
						"type": "text",
						"text": "Inspecting files.",
					},
				},
			},
		})
	}
	if c.pauseBeforeToolCallCompletion != nil {
		<-c.pauseBeforeToolCallCompletion
	}
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": c.sessionID,
			"update": map[string]any{
				"sessionUpdate": "tool_call_update",
				"toolCallId":    "tool-1",
				"title":         "Read workspace files",
				"kind":          "execute",
				"status":        "completed",
				"rawOutput": map[string]any{
					"filesRead": 3,
				},
			},
		},
	})
	if c.pauseBeforePromptResult != nil {
		<-c.pauseBeforePromptResult
	}
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"id":      promptID,
		"result": map[string]any{
			"stopReason": "end_turn",
		},
	})
}

func (c *standardACPConnection) Recv() (ProcessFrame, error) {
	frame, ok := <-c.recv
	if !ok {
		return ProcessFrame{}, io.EOF
	}
	return frame, nil
}

func (c *standardACPConnection) Close() error {
	c.mu.Lock()
	c.isClosed = true
	c.mu.Unlock()
	c.closeRecv()
	return nil
}

func (c *standardACPConnection) closeRecv() {
	c.closeOnce.Do(func() {
		close(c.recv)
	})
}

func (c *standardACPConnection) sendJSON(value any) {
	raw, _ := json.Marshal(value)
	raw = append(raw, '\n')
	c.recv <- ProcessFrame{Stdout: raw}
}

func (c *standardACPConnection) sendAvailableCommandsUpdate() {
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": c.sessionID,
			"update": map[string]any{
				"sessionUpdate": "available_commands_update",
				"availableCommands": []any{
					map[string]any{
						"name":        "web",
						"description": "Search the web",
						"input": map[string]any{
							"hint": "query",
						},
					},
				},
			},
		},
	})
}

func (c *standardACPConnection) sendConfigOptionsUpdate(key string, value string) {
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": c.sessionID,
			"update": map[string]any{
				"sessionUpdate": "config_option_update",
				"key":           key,
				"value":         value,
				"configOptions": []any{
					map[string]any{
						"id":           key,
						"currentValue": value,
						"options": []any{
							map[string]any{"value": value, "name": value},
						},
					},
				},
			},
		},
	})
}

func (c *standardACPConnection) defaultConfigOptions() []map[string]any {
	if len(c.configOptions) > 0 {
		out := make([]map[string]any, 0, len(c.configOptions))
		for _, option := range c.configOptions {
			out = append(out, clonePayloadDeep(option))
		}
		return out
	}
	title := strings.TrimSpace(c.agentTitle)
	if strings.EqualFold(title, "OpenCode") || strings.EqualFold(title, "Hermes Agent") {
		return []map[string]any{
			{"id": "model"},
			{"id": "effort"},
		}
	}
	return nil
}

func (c *standardACPConnection) permissionOptionID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.selectedPermissionOption
}

func (c *standardACPConnection) interactiveOutcome() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return clonePayload(c.selectedInteractiveResult)
}

func (c *standardACPConnection) promptRequest() (map[string]any, []map[string]any) {
	switch c.promptKind {
	case "ask-user":
		return map[string]any{
			"toolCallId": "interactive-ask-1",
			"title":      "AskUserQuestion",
			"input": map[string]any{
				"questions": []map[string]any{{
					"id":       "render-path",
					"header":   "Renderer",
					"question": "Which renderer should we use?",
					"options": []map[string]any{
						{"label": "Renderer A", "description": "Shared transcript renderer"},
						{"label": "Renderer B", "description": "Legacy room renderer"},
					},
				}},
			},
		}, nil
	case "exit-plan":
		return map[string]any{
			"toolCallId": "interactive-plan-1",
			"title":      "ExitPlanMode",
			"input": map[string]any{
				"plan": "Implement the shared renderer",
			},
		}, nil
	default:
		return map[string]any{
				"toolCallId": "approval-1",
				"title":      "Allow Bash",
			}, []map[string]any{
				{"optionId": "allow", "label": "Allow", "kind": "allow_once"},
				{"optionId": "reject", "label": "Reject", "kind": "reject_once"},
			}
	}
}

func (c *standardACPConnection) lastModeID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.appliedModeID
}

func (c *standardACPConnection) lastPromptParams() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastPromptParamsSnapshot == nil {
		return nil
	}
	return maps.Clone(c.lastPromptParamsSnapshot)
}

func (c *standardACPConnection) lastSetModeParams() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastSetModeParamsSnapshot == nil {
		return nil
	}
	return maps.Clone(c.lastSetModeParamsSnapshot)
}

func (c *standardACPConnection) closeSessionParams() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastCloseSessionParams == nil {
		return nil
	}
	return maps.Clone(c.lastCloseSessionParams)
}

func (c *standardACPConnection) authenticatedMethodID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastAuthenticatedMethodID
}

func (c *standardACPConnection) lastInitializeParams() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastInitializeParamsSnapshot == nil {
		return nil
	}
	return maps.Clone(c.lastInitializeParamsSnapshot)
}

func (c *standardACPConnection) setConfigOptionCalls() []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.setConfigOptionSnapshots) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(c.setConfigOptionSnapshots))
	for _, snapshot := range c.setConfigOptionSnapshots {
		out = append(out, maps.Clone(snapshot))
	}
	return out
}

func (c *standardACPConnection) closed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.isClosed
}
