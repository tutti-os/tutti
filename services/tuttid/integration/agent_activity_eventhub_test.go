package integration_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	eventprotocol "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

func TestAgentActivityProjectionPublishesEventHubUpdatesAndSupportsReconcile(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	const (
		workspaceID    = "ws-agent-activity-eventhub"
		agentSessionID = "agent-session-1"
	)

	store := openIntegrationSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   workspaceID,
		Name: "Workspace Agent Activity EventHub",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	events := eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil)
	session := events.OpenSession()
	t.Cleanup(func() {
		events.CloseSession(session)
	})
	if err := events.Subscribe(
		session,
		[]string{eventstreamservice.TopicAgentActivityUpdated},
		eventstreamservice.EventScope{WorkspaceID: workspaceID},
	); err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}

	projection := agentservice.NewActivityProjection(store)
	projection.SetPublisher(eventstreamservice.AgentActivityPublisher{Service: events})

	stateReply, err := projection.ReportSessionState(ctx, canonical.ReportSessionStateInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Source: canonical.EventSource{
			Provider:          "codex",
			ProviderSessionID: "provider-session-1",
		},
		State: canonical.WorkspaceAgentSessionStateUpdate{
			Title:            "Hello from activity",
			LifecycleStatus:  "running",
			CurrentPhase:     "thinking",
			OccurredAtUnixMS: 100,
			StartedAtUnixMS:  90,
		},
	})
	if err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	if !stateReply.Accepted {
		t.Fatal("ReportSessionState() accepted = false, want true")
	}

	stateEvent := receiveAgentActivityEvent(t, events, session)
	if stateEvent.EventType != "session_reconcile_required" {
		t.Fatalf("state event type = %q, want session_reconcile_required", stateEvent.EventType)
	}
	stateData := agentActivityDataMap(t, stateEvent)
	if stateData["lastEventUnixMs"] != float64(100) {
		t.Fatalf("state event data = %#v, want lastEventUnixMs 100", stateData)
	}
	if _, leaked := stateData["lifecycleStatus"]; leaked {
		t.Fatalf("state event data = %#v, session lifecycle must not leak into v2 event", stateData)
	}

	persisted, ok := projection.GetSession(workspaceID, agentSessionID)
	if !ok {
		t.Fatal("GetSession() ok = false, want true")
	}
	if persisted.Title != "Hello from activity" || persisted.ActiveTurnID != "" {
		t.Fatalf("persisted session = %#v", persisted)
	}

	turnID := "turn-1"
	turnReply, err := projection.ReportSessionState(ctx, canonical.ReportSessionStateInput{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
		SessionOrigin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Source:        canonical.EventSource{Provider: "codex", ProviderSessionID: "provider-session-1"},
		State: canonical.WorkspaceAgentSessionStateUpdate{
			LifecycleStatus: "running", OccurredAtUnixMS: 105,
			Turn: &canonical.WorkspaceAgentTurnStateUpdate{
				TurnID: turnID, ActiveTurnID: &turnID, Phase: agentactivitybiz.TurnPhaseSubmitted,
				Origin: agentactivitybiz.TurnOriginUserPrompt, StartedAtUnixMS: 105,
			},
		},
	})
	if err != nil || !turnReply.Accepted {
		t.Fatalf("ReportSessionState(turn) reply=%#v error=%v", turnReply, err)
	}
	receivedTurnUpdate := false
	receivedSessionReconcile := false
	for range 2 {
		switch event := receiveAgentActivityEvent(t, events, session); event.EventType {
		case "turn_update":
			receivedTurnUpdate = true
		case "session_reconcile_required":
			receivedSessionReconcile = true
		default:
			t.Fatalf("turn state report event type = %q", event.EventType)
		}
	}
	if !receivedTurnUpdate || !receivedSessionReconcile {
		t.Fatalf("turn state report events: turn=%v reconcile=%v", receivedTurnUpdate, receivedSessionReconcile)
	}

	messageReply, err := projection.ReportSessionMessages(ctx, canonical.ReportSessionMessagesInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Updates: []canonical.WorkspaceAgentSessionMessageUpdate{{
			MessageID:        "message-1",
			TurnID:           "turn-1",
			Role:             "assistant",
			Kind:             "text",
			Status:           "completed",
			Payload:          map[string]any{"text": "hello"},
			OccurredAtUnixMS: 110,
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
	if messageReply.AcceptedCount != 1 || messageReply.LatestVersion != 1 {
		t.Fatalf("ReportSessionMessages() reply = %#v, want 1 accepted at version 1", messageReply)
	}

	messageEvent := receiveAgentActivityEvent(t, events, session)
	if messageEvent.EventType != "message_update" {
		t.Fatalf("message event type = %q, want message_update", messageEvent.EventType)
	}
	messageData := agentActivityDataMap(t, messageEvent)
	if messageData["latestVersion"] != float64(1) || messageData["acceptedCount"] != float64(1) {
		t.Fatalf("message event data = %#v, want latestVersion/acceptedCount 1", messageData)
	}
	messages, ok := messageData["messages"].([]any)
	if !ok || len(messages) != 1 {
		t.Fatalf("message event data = %#v, want one inline message", messageData)
	}
	inlineMessage, ok := messages[0].(map[string]any)
	if !ok || inlineMessage["sequence"] != float64(1) {
		t.Fatalf("inline message = %#v, want durable sequence 1", messages[0])
	}

	page, ok := projection.ListSessionMessages(agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		Limit:          10,
	})
	if !ok {
		t.Fatal("ListSessionMessages() ok = false, want true")
	}
	if page.LatestVersion != 1 || len(page.Messages) != 1 {
		t.Fatalf("message page = %#v, want one message at version 1", page)
	}
	message := page.Messages[0]
	if message.MessageID != "message-1" || message.Version != 1 || message.Payload["text"] != "hello" {
		t.Fatalf("message = %#v, want message-1 version 1 with payload text", message)
	}

	latest, ok := projection.ListSessionMessages(agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		Limit:          1,
		Order:          agentactivitybiz.MessageOrderDesc,
	})
	if !ok {
		t.Fatal("ListSessionMessages(desc) ok = false, want true")
	}
	if len(latest.Messages) != 1 || latest.Messages[0].Version != 1 {
		t.Fatalf("latest page = %#v, want one message at version 1", latest)
	}

	afterCurrent, ok := projection.ListSessionMessages(agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		AfterVersion:   1,
		Limit:          10,
	})
	if !ok {
		t.Fatal("ListSessionMessages(after current) ok = false, want true")
	}
	if len(afterCurrent.Messages) != 0 || afterCurrent.LatestVersion != 1 {
		t.Fatalf("after-current page = %#v, want no messages at latest version 1", afterCurrent)
	}
}

func openIntegrationSQLiteStore(t *testing.T) *workspacedata.SQLiteStore {
	t.Helper()

	store, err := workspacedata.OpenSQLiteStore(filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})

	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	return store
}

func receiveAgentActivityEvent(
	t *testing.T,
	events *eventstreamservice.Service,
	session *eventstreamservice.Session,
) eventprotocol.AgentActivityUpdatedPayload {
	t.Helper()

	select {
	case event := <-events.Events(session):
		if event.Topic != eventstreamservice.TopicAgentActivityUpdated {
			t.Fatalf("event topic = %q, want %q", event.Topic, eventstreamservice.TopicAgentActivityUpdated)
		}
		if event.Scope.WorkspaceID != "ws-agent-activity-eventhub" {
			t.Fatalf("event workspace scope = %q, want ws-agent-activity-eventhub", event.Scope.WorkspaceID)
		}
		var payload eventprotocol.AgentActivityUpdatedPayload
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatalf("unmarshal agent activity payload: %v", err)
		}
		if payload.WorkspaceId != "ws-agent-activity-eventhub" || payload.AgentSessionId != "agent-session-1" {
			t.Fatalf("payload = %#v, want scoped workspace/session ids", payload)
		}
		return payload
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for agent activity event")
	}
	return eventprotocol.AgentActivityUpdatedPayload{}
}

func agentActivityDataMap(
	t *testing.T,
	payload eventprotocol.AgentActivityUpdatedPayload,
) map[string]any {
	t.Helper()

	data, ok := payload.Data.(map[string]any)
	if !ok {
		t.Fatalf("payload data type = %T, want map[string]any", payload.Data)
	}
	return data
}
