package api

import (
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func TestGeneratedAgentSessionGoalStateNormalizesInvalidEnums(t *testing.T) {
	state := generatedAgentSessionGoalState(agentactivitybiz.SessionGoalState{
		SyncStatus: "",
		Observed:   map[string]any{"objective": "ship", "status": "limited"},
	})
	if state.SyncStatus != tuttigenerated.WorkspaceAgentSessionGoalStateSyncStatusUnknown {
		t.Fatalf("syncStatus = %q", state.SyncStatus)
	}
	if state.Observed != nil {
		t.Fatalf("invalid observed goal leaked into API: %#v", state.Observed)
	}
}
