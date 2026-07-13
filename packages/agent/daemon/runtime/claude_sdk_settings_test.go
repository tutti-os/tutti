package agentruntime

import (
	"context"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestClaudeCodeSDKAdapterApplySessionSettingsSpeedSendsSidecarAndUpdatesRuntimeContext(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := &ackClaudeSDKConnection{}
	adapterSession := &claudeSDKAdapterSession{
		conn:            conn,
		reader:          &claudeSDKLineReader{conn: conn},
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		Speed: stringPtr("fast"),
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "apply_settings" || sent[0].Payload["speed"] != "fast" {
		t.Fatalf("sent requests = %#v, want apply_settings fast", sent)
	}
	state := adapter.SessionState(session)
	if state.RuntimeContext["speed"] != "fast" || !hasClaudeSDKSpeedConfigOptions(state.RuntimeContext, "fast") {
		t.Fatalf("runtimeContext = %#v, want fast speed after live apply", state.RuntimeContext)
	}
}

func TestClaudeCodeSDKAdapterGuideActiveTurnSendsSidecarGuide(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	adapterSession := &claudeSDKAdapterSession{
		conn:             conn,
		reader:           &claudeSDKLineReader{conn: conn},
		pendingRequests:  make(map[string]*pendingInteractiveRequest),
		pendingResponses: make(map[string]chan claudeSDKSidecarEvent),
		liveState:        newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	type guidanceResult struct {
		events []activityshared.Event
		err    error
	}
	results := make(chan guidanceResult, 1)
	go func() {
		events, err := adapter.GuideActiveTurn(context.Background(), session, textPrompt("guide current turn"), "", "turn-guidance", nil, nil)
		results <- guidanceResult{events: events, err: err}
	}()

	request := waitForClaudeSDKSentRequest(t, conn, "guide")
	if _, ok := request.Payload["turnId"]; ok || request.Payload["prompt"] != "guide current turn" {
		t.Fatalf("guide payload = %#v", request.Payload)
	}
	conn.pushEvent(claudeSDKSidecarEvent{ID: request.ID, Type: "ok"})

	var events []activityshared.Event
	select {
	case result := <-results:
		if result.err != nil {
			t.Fatalf("GuideActiveTurn: %v", result.err)
		}
		events = result.events
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for GuideActiveTurn")
	}
	messages := eventsOfType(events, activityshared.EventMessageAppended)
	if len(messages) != 1 {
		t.Fatalf("guidance events = %#v, want one message", events)
	}
	if guidance, ok := messages[0].Payload.Metadata["guidance"].(bool); !ok || !guidance {
		t.Fatalf("guidance metadata = %#v, want guidance=true", messages[0].Payload.Metadata)
	}
}

func TestClaudeCodeSDKAdapterApplyPermissionModeSendsSidecar(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.PermissionModeID = "default"
	session.Settings = &SessionSettings{PlanMode: true, PermissionModeID: "default"}
	conn := &ackClaudeSDKConnection{}
	adapterSession := &claudeSDKAdapterSession{
		conn:      conn,
		reader:    &claudeSDKLineReader{conn: conn},
		liveState: newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	if err := adapter.ApplyPermissionMode(context.Background(), session); err != nil {
		t.Fatalf("ApplyPermissionMode: %v", err)
	}

	sent := conn.sentRequests()
	if len(sent) != 1 ||
		sent[0].Type != "apply_settings" ||
		sent[0].Payload["permissionMode"] != "plan" ||
		sent[0].Payload["planMode"] != true {
		t.Fatalf("sent requests = %#v, want apply_settings plan permission mode", sent)
	}
}

func TestClaudeCodeSDKAdapterApplySessionSettingsSendsLiveSettings(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.PermissionModeID = "auto"
	session.Settings = &SessionSettings{
		Model:            "sonnet",
		PermissionModeID: "auto",
		ReasoningEffort:  "xhigh",
		Speed:            "fast",
		PlanMode:         true,
	}
	conn := &ackClaudeSDKConnection{}
	adapterSession := &claudeSDKAdapterSession{
		conn:      conn,
		reader:    &claudeSDKLineReader{conn: conn},
		liveState: newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	planMode := true

	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		Model:           stringPtr("sonnet"),
		ReasoningEffort: stringPtr("xhigh"),
		Speed:           stringPtr("fast"),
		PlanMode:        &planMode,
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "apply_settings" {
		t.Fatalf("sent requests = %#v, want apply_settings", sent)
	}
	payload := sent[0].Payload
	if payload["model"] != "sonnet" ||
		payload["effort"] != "xhigh" ||
		payload["speed"] != "fast" ||
		payload["permissionMode"] != "plan" ||
		payload["planMode"] != true {
		t.Fatalf("apply settings payload = %#v", payload)
	}
	state := adapter.SessionState(session)
	if state.RuntimeContext["model"] != "sonnet" ||
		state.RuntimeContext["reasoningEffort"] != "xhigh" ||
		state.RuntimeContext["speed"] != "fast" ||
		state.RuntimeContext["planMode"] != true {
		t.Fatalf("runtimeContext = %#v, want applied live settings", state.RuntimeContext)
	}
}

func TestClaudeCodeSDKAdapterSettingsDoNotRequireNewSession(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	planMode := true

	if adapter.RequiresNewSessionForSettings(session, SessionSettingsPatch{
		Model:           stringPtr("sonnet"),
		ReasoningEffort: stringPtr("xhigh"),
		Speed:           stringPtr("fast"),
		PlanMode:        &planMode,
	}) {
		t.Fatal("RequiresNewSessionForSettings = true, want false for live SDK settings")
	}
}

func TestClaudeCodeSDKAdapterMapsFastModeStateAndKeepsCooldownFromClobberingSpeed(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "speed_updated",
		Payload: map[string]any{
			"turnId": "turn-1",
			"state":  "on",
		},
	})
	if err != nil || terminal || len(events) != 1 {
		t.Fatalf("speed on events=%#v terminal=%v err=%v, want one session update", events, terminal, err)
	}
	if got := adapter.SessionState(session).RuntimeContext["speed"]; got != "fast" {
		t.Fatalf("speed after on = %#v, want fast", got)
	}

	cooldown, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "speed_updated",
		Payload: map[string]any{
			"turnId": "turn-1",
			"state":  "cooldown",
		},
	})
	if err != nil || terminal || len(cooldown) != 0 {
		t.Fatalf("cooldown events=%#v terminal=%v err=%v, want no state clobber", cooldown, terminal, err)
	}
	if got := adapter.SessionState(session).RuntimeContext["speed"]; got != "fast" {
		t.Fatalf("speed after cooldown = %#v, want fast", got)
	}
}

func TestClaudeCodeSDKAdapterMapsCommandsUpdated(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	var snapshots []AgentSessionCommandSnapshot
	adapter.SetCommandSnapshotSink(func(snapshot AgentSessionCommandSnapshot) {
		snapshots = append(snapshots, snapshot)
	})

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "commands_updated",
		Payload: map[string]any{
			"commands": []any{
				map[string]any{"name": "context", "description": "Show context", "input": map[string]any{"hint": "scope"}},
				"usage",
				map[string]any{"name": "context", "description": "Duplicate"},
			},
		},
	})
	if err != nil || terminal || len(events) != 0 {
		t.Fatalf("commands_updated events=%#v terminal=%v err=%v, want non-terminal state update", events, terminal, err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %#v, want one command snapshot", snapshots)
	}
	if len(snapshots[0].Commands) != 2 ||
		snapshots[0].Commands[0].Name != "context" ||
		snapshots[0].Commands[0].InputHint != "scope" ||
		snapshots[0].Commands[1].Name != "usage" {
		t.Fatalf("snapshot commands = %#v", snapshots[0].Commands)
	}
	state := adapter.SessionState(session)
	commands, _ := state.RuntimeContext["commands"].([]string)
	if len(commands) != 2 || commands[0] != "context" || commands[1] != "usage" {
		t.Fatalf("runtime commands = %#v, want replaced command list", commands)
	}
}
