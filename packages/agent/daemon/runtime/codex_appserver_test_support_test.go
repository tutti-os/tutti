package agentruntime

import (
	"context"
	"encoding/json"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

const (
	testAppServerPlanCollaborationInstructions    = "# Plan Mode (Conversational)\n\nPlan before implementing."
	testAppServerDefaultCollaborationInstructions = "# Collaboration Mode: Default\n\nExecute with reasonable assumptions."
)

func testAppServerSession() Session {
	return Session{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace/room-1",
		Status:         SessionStatusReady,
	}
}

func codexProviderDescriptorForTest(t *testing.T) providerregistry.ProviderDescriptor {
	t.Helper()
	descriptor, ok := providerregistry.Find(providerregistry.CodexProviderID)
	if !ok {
		t.Fatal("migrated Codex provider descriptor is missing")
	}
	return descriptor
}

func appServerForkStrategyForTest(
	t *testing.T,
	provider string,
) appServerForkStrategy {
	t.Helper()
	descriptor, ok := providerregistry.Find(provider)
	if !ok {
		t.Fatalf("migrated provider descriptor %q is missing", provider)
	}
	minimumVersion, ok := parseVersionTriplet(
		descriptor.Runtime.AppServerFork.ThroughTurnMinVersion,
	)
	if !ok {
		t.Fatalf(
			"provider %q fork minimum version = %q",
			provider,
			descriptor.Runtime.AppServerFork.ThroughTurnMinVersion,
		)
	}
	return appServerForkStrategy{
		userAgentBrand:            descriptor.Runtime.AppServerFork.UserAgentBrand,
		throughTurnMinimumVersion: minimumVersion,
	}
}

func appServerRequestParamsList(t *testing.T, conn *scriptedAppServerConnection, method string) []map[string]any {
	t.Helper()
	conn.mu.Lock()
	sent := append([][]byte(nil), conn.sent...)
	conn.mu.Unlock()
	var matches []map[string]any
	for _, data := range sent {
		for _, line := range acpScanLines(data) {
			var request struct {
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if err := json.Unmarshal([]byte(line), &request); err != nil {
				t.Fatalf("unmarshal app-server request: %v", err)
			}
			if request.Method == method {
				matches = append(matches, request.Params)
			}
		}
	}
	return matches
}

func appServerRequestParams(t *testing.T, conn *scriptedAppServerConnection, method string) map[string]any {
	t.Helper()
	requests := appServerRequestParamsList(t, conn, method)
	if len(requests) == 0 {
		t.Fatalf("missing app-server request method %q", method)
	}
	return requests[0]
}

func startedAppServerAdapter(t *testing.T) (*CodexAppServerAdapter, *scriptedAppServerTransport, Session) {
	t.Helper()
	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("start events = %#v, want session.started", events)
	}
	session.ProviderSessionID = "codex-thread-1"
	return adapter, transport, session
}

func eventsOfType(events []activityshared.Event, eventType activityshared.EventType) []activityshared.Event {
	var matches []activityshared.Event
	for _, event := range events {
		if event.Type == eventType {
			matches = append(matches, event)
		}
	}
	return matches
}
