package agentruntime

import (
	"context"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestClaudeCodeSDKAdapterMapsSessionTitleUpdated(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.Title = "inspect repo"

	events, terminal, err := adapter.sidecarTurnEvents(&claudeSDKAdapterSession{}, session, "turn-1", claudeSDKSidecarEvent{
		Type: "session_title_updated",
		Payload: map[string]any{
			"title": " Inspect repository structure ",
		},
	})
	if err != nil || terminal {
		t.Fatalf("session_title_updated terminal=%v err=%v", terminal, err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionUpdated {
		t.Fatalf("events = %#v, want session.updated", events)
	}
	if events[0].Payload.Title != "Inspect repository structure" {
		t.Fatalf("title = %q, want provider title", events[0].Payload.Title)
	}
}

func TestClaudeCodeSDKAdapterMirrorsGoalSlashPromptIntoRuntimeContext(t *testing.T) {
	t.Parallel()

	adapterSession := &claudeSDKAdapterSession{
		liveState: newClaudeSDKLiveState(),
	}
	session := standardTestSession(ProviderClaudeCode)

	if event, ok := adapterSession.mirrorGoalSlashPrompt(session, "/goal ship native goal"); !ok {
		t.Fatal("mirrorGoalSlashPrompt ok=false, want goal mirror")
	} else if event.Type != activityshared.EventSessionUpdated {
		t.Fatalf("event type = %q, want session.updated", event.Type)
	}
	goal := payloadObject(claudeSDKRuntimeContext(session, adapterSession)["goal"])
	if asString(goal["objective"]) != "ship native goal" || asString(goal["status"]) != "active" {
		t.Fatalf("runtime goal = %#v, want active objective", goal)
	}

	if _, ok := adapterSession.mirrorGoalSlashPrompt(session, "/goal clear"); !ok {
		t.Fatal("mirrorGoalSlashPrompt clear ok=false")
	}
	if goal := payloadObject(claudeSDKRuntimeContext(session, adapterSession)["goal"]); len(goal) != 0 {
		t.Fatalf("runtime goal after clear = %#v, want empty", goal)
	}
}

func TestClaudeCodeSDKAdapterMapsGoalUpdatedSidecarEvent(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	adapterSession := &claudeSDKAdapterSession{
		liveState: newClaudeSDKLiveState(),
	}
	session := standardTestSession(ProviderClaudeCode)

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-goal", claudeSDKSidecarEvent{
		Type: "goal_updated",
		Payload: map[string]any{
			"turnId":     "turn-goal",
			"updateType": "thread_goal_update",
			"goal": map[string]any{
				"objective": "ship native goal",
				"status":    "active",
				"sentinel":  true,
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("goal_updated terminal=%v err=%v", terminal, err)
	}
	if len(activityEventsWithType(events, activityshared.EventSessionUpdated)) < 2 {
		t.Fatalf("events = %#v, want goal session.updated events", events)
	}
	goal := payloadObject(claudeSDKRuntimeContext(session, adapterSession)["goal"])
	if asString(goal["objective"]) != "ship native goal" || asString(goal["status"]) != "active" {
		t.Fatalf("runtime goal = %#v, want active SDK goal status", goal)
	}

	events, terminal, err = adapter.sidecarTurnEvents(adapterSession, session, "turn-goal", claudeSDKSidecarEvent{
		Type: "goal_updated",
		Payload: map[string]any{
			"turnId":     "turn-goal",
			"updateType": "thread_goal_cleared",
		},
	})
	if err != nil || terminal {
		t.Fatalf("goal cleared terminal=%v err=%v", terminal, err)
	}
	if len(events) == 0 {
		t.Fatal("events empty, want goal cleared session.updated")
	}
	if goal := payloadObject(claudeSDKRuntimeContext(session, adapterSession)["goal"]); len(goal) != 0 {
		t.Fatalf("runtime goal after clear = %#v, want empty", goal)
	}
}

func TestClaudeCodeSDKAdapterExecLeavesInitialTitleToController(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"turn_completed","payload":{"turnId":"turn-1","stopReason":"end_turn"}}` + "\n"),
		}},
	}
	adapterSession := &claudeSDKAdapterSession{
		conn:              conn,
		reader:            &claudeSDKLineReader{conn: conn},
		providerSessionID: session.ProviderSessionID,
		pendingRequests:   make(map[string]*pendingInteractiveRequest),
		liveState:         newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	var emitted []activityshared.Event
	events, err := adapter.Exec(context.Background(), session, textPrompt(" inspect repo "), "", "turn-1", func(next []activityshared.Event) {
		emitted = append(emitted, next...)
	}, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	titleEvents := activityEventsWithType(emitted, activityshared.EventSessionUpdated)
	if len(titleEvents) != 0 {
		t.Fatalf("title events = %#v, want adapter to leave initial title to controller", titleEvents)
	}
	if !hasActivityMessage(events, activityshared.MessageRoleUser, "inspect repo") {
		t.Fatalf("events = %#v, missing user prompt", events)
	}
}

func TestClaudeCodeSDKAdapterIgnoresCanceledTurnOrphanBeforeCompactResult(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}

	_, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-canceled", claudeSDKSidecarEvent{
		Type:    "turn_canceled",
		Payload: map[string]any{"turnId": "turn-canceled"},
	})
	if err != nil || !terminal {
		t.Fatalf("turn_canceled terminal=%v err=%v, want terminal cancel", terminal, err)
	}
	orphan, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-compact", claudeSDKSidecarEvent{
		Type:    "turn_completed",
		Payload: map[string]any{"turnId": "turn-canceled"},
	})
	if err != nil || terminal || len(orphan) != 0 {
		t.Fatalf("orphan events=%#v terminal=%v err=%v, want ignored stale turn result", orphan, terminal, err)
	}
	compact, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-compact", claudeSDKSidecarEvent{
		Type:    "turn_completed",
		Payload: map[string]any{"turnId": "turn-compact"},
	})
	if err != nil || !terminal || len(compact) != 1 || compact[0].Type != activityshared.EventTurnCompleted {
		t.Fatalf("compact result events=%#v terminal=%v err=%v, want compact turn completion", compact, terminal, err)
	}
}

func TestClaudeCodeSDKAdapterMapsThinkingEvents(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	adapterSession := &claudeSDKAdapterSession{}
	session := standardTestSession(ProviderClaudeCode)

	streaming, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "thinking_delta",
		Payload: map[string]any{
			"snapshot": "Need context.",
		},
	})
	if err != nil || terminal {
		t.Fatalf("thinking_delta err=%v terminal=%v", err, terminal)
	}
	completed, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "thinking_completed",
		Payload: map[string]any{
			"content": "Need context.",
		},
	})
	if err != nil || terminal {
		t.Fatalf("thinking_completed err=%v terminal=%v", err, terminal)
	}
	if len(streaming) != 1 || len(completed) != 1 {
		t.Fatalf("events = %#v %#v, want one streaming and one completed thinking event", streaming, completed)
	}
	if streaming[0].Type != activityshared.EventMessageAppended ||
		streaming[0].Payload.Role != activityshared.MessageRoleAssistantThinking ||
		streaming[0].Payload.Content != "Need context." {
		t.Fatalf("streaming thinking = %#v", streaming[0])
	}
	if completed[0].EventID != streaming[0].EventID {
		t.Fatalf("thinking event IDs = %q and %q, want stable ID", streaming[0].EventID, completed[0].EventID)
	}
	if completed[0].Payload.Metadata["streamState"] != messageStreamStateCompleted {
		t.Fatalf("completed metadata = %#v, want completed stream state", completed[0].Payload.Metadata)
	}
}

func TestClaudeCodeSDKAdapterMapsToolLifecycleAndFileMetadata(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	adapterSession := &claudeSDKAdapterSession{}
	session := standardTestSession(ProviderClaudeCode)

	started, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "tool_started",
		Payload: map[string]any{
			"toolCallId": "toolu-1",
			"toolName":   "Edit",
			"callType":   "file_change",
			"name":       "Edit",
			"status":     "streaming",
			"input": map[string]any{
				"file_path":  "/tmp/a.txt",
				"old_string": "old",
				"new_string": "new",
			},
			"locations": []any{map[string]any{"path": "/tmp/a.txt"}},
			"metadata": map[string]any{
				"fileChange": map[string]any{
					"paths":   []any{"/tmp/a.txt"},
					"oldText": "old",
					"newText": "new",
				},
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("tool_started err=%v terminal=%v", err, terminal)
	}
	completed, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "tool_completed",
		Payload: map[string]any{
			"toolCallId": "toolu-1",
			"toolName":   "Edit",
			"callType":   "file_change",
			"name":       "Edit",
			"status":     "completed",
			"output": map[string]any{
				"text": "updated",
			},
			"metadata": map[string]any{
				"claudeToolResponse": map[string]any{
					"structuredPatch": map[string]any{"path": "/tmp/a.txt"},
				},
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("tool_completed err=%v terminal=%v", err, terminal)
	}
	if len(started) != 1 || started[0].Type != activityshared.EventCallStarted {
		t.Fatalf("started = %#v, want call.started", started)
	}
	if len(completed) != 1 || completed[0].Type != activityshared.EventCallCompleted {
		t.Fatalf("completed = %#v, want call.completed", completed)
	}
	if started[0].EventID != "claude-sdk:tool:toolu-1" || completed[0].EventID != started[0].EventID {
		t.Fatalf("event IDs = %q %q, want stable tool ID", started[0].EventID, completed[0].EventID)
	}
	if started[0].Payload.CallID != "toolu-1" || started[0].Payload.CallType != "file_change" {
		t.Fatalf("started payload = %#v", started[0].Payload)
	}
	if locations, ok := started[0].Payload.Metadata["locations"].([]any); !ok || len(locations) != 1 {
		t.Fatalf("locations metadata = %#v, want one file location", started[0].Payload.Metadata["locations"])
	}
	sidecarMetadata := payloadMap(started[0].Payload.Metadata, "metadata")
	fileChange := payloadMap(sidecarMetadata, "fileChange")
	if fileChange["oldText"] != "old" || fileChange["newText"] != "new" {
		t.Fatalf("fileChange metadata = %#v, want edit diff text", fileChange)
	}
	completedMetadata := payloadMap(completed[0].Payload.Metadata, "metadata")
	if toolResponse := payloadMap(completedMetadata, "claudeToolResponse"); payloadMap(toolResponse, "structuredPatch") == nil {
		t.Fatalf("completed metadata = %#v, want structuredPatch", completed[0].Payload.Metadata)
	}
}
