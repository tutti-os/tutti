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
	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-compact", "turn-compact")
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
	if err != nil || !terminal || len(compact) != 1 || compact[0].Type != activityshared.EventRootProviderTurnCompleted ||
		compact[0].Payload.TurnID != "turn-compact" || compact[0].Payload.ProviderTurnID != "turn-compact" {
		t.Fatalf("compact result events=%#v terminal=%v err=%v, want root provider completion", compact, terminal, err)
	}
}

func TestClaudeCodeSDKAdapterMapsCompactLifecycleAsSystemNotice(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	session := standardTestSession(ProviderClaudeCode)

	started, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-compact", claudeSDKSidecarEvent{
		Type:    "compact_started",
		Payload: map[string]any{"turnId": "turn-compact"},
	})
	if err != nil || terminal || len(started) != 1 {
		t.Fatalf("compact_started events=%#v terminal=%v err=%v", started, terminal, err)
	}
	failed, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-compact", claudeSDKSidecarEvent{
		Type: "compact_failed",
		Payload: map[string]any{
			"turnId":  "turn-compact",
			"content": "Compacting failed: Not enough messages to compact.",
		},
	})
	if err != nil || terminal || len(failed) != 1 {
		t.Fatalf("compact_failed events=%#v terminal=%v err=%v", failed, terminal, err)
	}
	if started[0].EventID != failed[0].EventID {
		t.Fatalf("compact event IDs = %q and %q, want one stable notice", started[0].EventID, failed[0].EventID)
	}
	if started[0].Payload.Content != appServerCompactingContextTitle ||
		started[0].Payload.Metadata["kind"] != "agent_system_notice" ||
		started[0].Payload.Metadata["noticeCommand"] != "compact" ||
		started[0].Payload.Metadata["noticeCommandStatus"] != "running" {
		t.Fatalf("compact_started = %#v, want running compact system notice", started[0])
	}
	if failed[0].Payload.Content != appServerCompactionInterruptedTitle ||
		failed[0].Payload.Metadata["noticeCommandStatus"] != "failed" ||
		failed[0].Payload.Metadata["detail"] != "Not enough messages to compact." {
		t.Fatalf("compact_failed = %#v, want failed compact system notice", failed[0])
	}
}

func TestClaudeCodeSDKAdapterSettlesActiveCompactWithTurn(t *testing.T) {
	tests := []struct {
		name             string
		turnEvent        string
		wantNoticeStatus string
	}{
		{name: "canceled", turnEvent: "turn_canceled", wantNoticeStatus: "canceled"},
		{name: "failed", turnEvent: "turn_failed", wantNoticeStatus: "failed"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			adapter := NewClaudeCodeSDKAdapter(nil)
			adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
			session := standardTestSession(ProviderClaudeCode)

			started, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-compact", claudeSDKSidecarEvent{
				Type:    "compact_started",
				Payload: map[string]any{"turnId": "turn-compact"},
			})
			if err != nil || terminal || len(started) != 1 {
				t.Fatalf("compact_started events=%#v terminal=%v err=%v", started, terminal, err)
			}

			settled, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-compact", claudeSDKSidecarEvent{
				Type:    test.turnEvent,
				Payload: map[string]any{"turnId": "turn-compact", "error": "provider stopped"},
			})
			if err != nil || !terminal {
				t.Fatalf("%s events=%#v terminal=%v err=%v", test.turnEvent, settled, terminal, err)
			}
			var compact *activityshared.Event
			for index := range settled {
				if settled[index].Payload.Metadata["noticeCommand"] == "compact" {
					compact = &settled[index]
					break
				}
			}
			if compact == nil {
				t.Fatalf("%s events=%#v, want terminal compact notice", test.turnEvent, settled)
			}
			if compact.EventID != started[0].EventID ||
				compact.Payload.Content != appServerCompactionInterruptedTitle ||
				compact.Payload.Metadata["noticeCommandStatus"] != test.wantNoticeStatus {
				t.Fatalf("terminal compact = %#v, want stable %s notice", compact, test.wantNoticeStatus)
			}
		})
	}
}

func TestClaudeCodeSDKAdapterDoesNotResettleTerminalCompactWithTurn(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	session := standardTestSession(ProviderClaudeCode)

	if _, _, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-compact", claudeSDKSidecarEvent{
		Type:    "compact_started",
		Payload: map[string]any{"turnId": "turn-compact"},
	}); err != nil {
		t.Fatalf("compact_started: %v", err)
	}
	if _, _, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-compact", claudeSDKSidecarEvent{
		Type:    "compact_failed",
		Payload: map[string]any{"turnId": "turn-compact", "reason": "not enough context"},
	}); err != nil {
		t.Fatalf("compact_failed: %v", err)
	}
	settled, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-compact", claudeSDKSidecarEvent{
		Type:    "turn_failed",
		Payload: map[string]any{"turnId": "turn-compact", "error": "provider stopped"},
	})
	if err != nil || !terminal {
		t.Fatalf("turn_failed events=%#v terminal=%v err=%v", settled, terminal, err)
	}
	for _, event := range settled {
		if event.Payload.Metadata["noticeCommand"] == "compact" {
			t.Fatalf("turn_failed events=%#v, terminal compact must not be emitted twice", settled)
		}
	}
}

func TestClaudeCodeSDKAdapterIgnoresCompactTerminalAfterSynthesizedCancel(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	session := standardTestSession(ProviderClaudeCode)

	started, _, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-compact", claudeSDKSidecarEvent{
		Type:    "compact_started",
		Payload: map[string]any{"turnId": "turn-compact"},
	})
	if err != nil || len(started) != 1 {
		t.Fatalf("compact_started events=%#v err=%v", started, err)
	}
	settled, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-compact", claudeSDKSidecarEvent{
		Type:    "turn_canceled",
		Payload: map[string]any{"turnId": "turn-compact"},
	})
	if err != nil || !terminal {
		t.Fatalf("turn_canceled events=%#v terminal=%v err=%v", settled, terminal, err)
	}
	var canceledCompact *activityshared.Event
	for index := range settled {
		if settled[index].Payload.Metadata["noticeCommandStatus"] == "canceled" {
			canceledCompact = &settled[index]
			break
		}
	}
	if canceledCompact == nil || canceledCompact.EventID != started[0].EventID {
		t.Fatalf("turn_canceled events=%#v, want stable canceled compact notice", settled)
	}

	lateEvents := []claudeSDKSidecarEvent{
		{Type: "compact_completed", Payload: map[string]any{"turnId": "turn-compact"}},
		{Type: "compact_failed", Payload: map[string]any{"turnId": "turn-compact", "reason": "late failure"}},
	}
	for _, event := range lateEvents {
		late, lateTerminal, lateErr := adapter.sidecarTurnEvents(adapterSession, session, "turn-compact", event)
		if lateErr != nil || lateTerminal || len(late) != 0 {
			t.Fatalf("late %s events=%#v terminal=%v err=%v, want ignored terminal", event.Type, late, lateTerminal, lateErr)
		}
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

func TestClaudeCodeSDKAdapterSuppressesGoalClearControlTranscript(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	adapterSession := &claudeSDKAdapterSession{
		liveState: newClaudeSDKLiveState(),
		goalClearControlTurns: map[string]struct{}{
			"turn-clear": {},
		},
	}
	session := standardTestSession(ProviderClaudeCode)

	for _, event := range []claudeSDKSidecarEvent{
		{Type: "turn_started", Payload: map[string]any{"turnId": "turn-clear"}},
		{Type: "assistant_delta", Payload: map[string]any{"turnId": "turn-clear", "snapshot": "Goal cleared: ship it"}},
		{Type: "assistant_completed", Payload: map[string]any{"turnId": "turn-clear", "content": "Goal cleared: ship it"}},
		{Type: "thinking_delta", Payload: map[string]any{"turnId": "turn-clear", "snapshot": "Clearing goal"}},
		{Type: "thinking_completed", Payload: map[string]any{"turnId": "turn-clear", "content": "Clearing goal"}},
	} {
		events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "", event)
		if err != nil || terminal || len(events) != 0 {
			t.Fatalf("%s events=%#v terminal=%v err=%v, want suppressed transcript", event.Type, events, terminal, err)
		}
	}

	ordinary, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-normal", claudeSDKSidecarEvent{
		Type: "assistant_completed",
		Payload: map[string]any{
			"turnId":  "turn-normal",
			"content": "Goal cleared: ship it",
		},
	})
	if err != nil || terminal || !hasActivityMessage(ordinary, activityshared.MessageRoleAssistant, "Goal cleared: ship it") {
		t.Fatalf("ordinary assistant events=%#v terminal=%v err=%v, want visible matching text", ordinary, terminal, err)
	}

	for index, terminalType := range []string{"turn_completed", "turn_canceled", "turn_failed"} {
		turnID := "turn-clear"
		if index > 0 {
			turnID += "-" + terminalType
		}
		adapterSession.goalClearControlTurns[turnID] = struct{}{}
		terminalEvents, terminal, terminalErr := adapter.sidecarTurnEvents(adapterSession, session, "", claudeSDKSidecarEvent{
			Type:    terminalType,
			Payload: map[string]any{"turnId": turnID, "error": "failed"},
		})
		if terminalErr != nil || !terminal {
			t.Fatalf("%s terminal=%v err=%v, want terminal", terminalType, terminal, terminalErr)
		}
		if len(terminalEvents) != 0 {
			t.Fatalf("%s events=%#v, want internal control terminal suppressed", terminalType, terminalEvents)
		}
		if adapter.isGoalClearControlTurn(adapterSession, turnID) {
			t.Fatalf("%s clear control turn remained registered", terminalType)
		}
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
	if len(completed) != 2 || completed[0].Type != activityshared.EventCallCompleted || completed[1].Type != activityshared.EventTurnUpdated {
		t.Fatalf("completed = %#v, want call.completed followed by turn.updated", completed)
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
	turnFiles := payloadArray(payloadMap(completed[1].Payload.Metadata, "fileChanges")["files"])
	if len(turnFiles) != 1 || turnFiles[0]["path"] != "/tmp/a.txt" || turnFiles[0]["change"] != "modified" {
		t.Fatalf("turn file changes = %#v, want canonical modified file", turnFiles)
	}
}

func TestNormalizeClaudeSDKToolPayloadCanonicalizesNoNewlineMarkers(t *testing.T) {
	payload := normalizeClaudeSDKToolPayload(map[string]any{
		"output": map[string]any{
			"changes": []any{map[string]any{
				"path": "/tmp/a.txt",
				"diff": "@@ -1 +1 @@\n-old\n \\ No newline at end of file\n+new\n \\ No newline at end of file",
			}},
		},
	})
	output := payloadMap(payload, "output")
	changes, _ := output["changes"].([]any)
	change := payloadObject(changes[0])
	want := "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file"
	if change["diff"] != want {
		t.Fatalf("normalized diff = %q, want %q", change["diff"], want)
	}
}
