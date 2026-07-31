package api

import (
	"encoding/json"
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

func TestGeneratedGoalControlProjectionMakesClearExplicitAndAuthoritative(t *testing.T) {
	stale := tuttigenerated.WorkspaceAgentSessionGoal{
		Objective: "stale goal",
		Status:    tuttigenerated.Active,
	}
	session := tuttigenerated.WorkspaceAgentSession{Goal: &stale}
	goal := generatedGoalControlProjection(&session, nil)
	if goal != nil || session.Goal != nil {
		t.Fatalf("goal/session goal = %#v/%#v, want explicit clear", goal, session.Goal)
	}

	raw, err := json.Marshal(tuttigenerated.WorkspaceAgentSessionGoalControlResponse{
		Goal:    goal,
		Session: session,
	})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	value, found := payload["goal"]
	if !found || value != nil {
		t.Fatalf("goal field = %#v, found=%t; payload=%s", value, found, raw)
	}
}

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
