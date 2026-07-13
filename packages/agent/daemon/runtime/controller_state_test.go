package agentruntime

import (
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
)

func TestControllerStateMergesAdapterRuntimeContextWithoutDroppingLaunchContext(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{
		provider: ProviderCodex,
		snapshot: SessionStateSnapshot{
			RuntimeContext: map[string]any{
				"providerState": "ready",
				"shared":        "provider",
			},
		},
	}
	controller := NewController([]Adapter{adapter}, nil)
	session := Session{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/Users/example/Documents/tutti/session-agent-session-1",
		Title:          "No project session",
		Visible:        true,
		RuntimeContext: map[string]any{
			"noProject": true,
			"shared":    "session",
		},
	}
	controller.store(session)

	snapshot, err := controller.State(session.RoomID, session.AgentSessionID)
	if err != nil {
		t.Fatalf("State() error = %v", err)
	}
	if snapshot.RuntimeContext["noProject"] != true {
		t.Fatalf("runtime context = %#v, want noProject launch marker", snapshot.RuntimeContext)
	}
	if snapshot.RuntimeContext["providerState"] != "ready" {
		t.Fatalf("runtime context = %#v, want provider state", snapshot.RuntimeContext)
	}
	if snapshot.RuntimeContext["shared"] != "provider" {
		t.Fatalf("runtime context shared = %#v, want provider override", snapshot.RuntimeContext["shared"])
	}
}

func TestEnrichReportWithSessionSnapshotPreservesNoProjectLaunchContext(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{
		provider: ProviderCodex,
		snapshot: SessionStateSnapshot{
			RuntimeContext: map[string]any{"providerState": "ready"},
		},
	}
	controller := NewController([]Adapter{adapter}, nil)
	session := Session{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/Users/example/Documents/tutti/session-agent-session-1",
		RuntimeContext: map[string]any{"noProject": true},
	}
	controller.store(session)
	report := agentsessionstore.ReportActivityInput{WorkspaceID: session.RoomID}

	controller.enrichReportWithSessionSnapshot(session, &report)

	if len(report.StatePatches) != 1 {
		t.Fatalf("state patch count = %d, want 1", len(report.StatePatches))
	}
	if report.StatePatches[0].RuntimeContext["noProject"] != true {
		t.Fatalf("runtime context = %#v, want noProject launch marker", report.StatePatches[0].RuntimeContext)
	}
}
