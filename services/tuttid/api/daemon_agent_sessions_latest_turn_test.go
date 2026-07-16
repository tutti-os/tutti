package api

import (
	"encoding/json"
	"testing"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func TestGeneratedAgentSessionIncludesIndependentLatestTurnProjection(t *testing.T) {
	latest := agentactivitybiz.Turn{
		WorkspaceID:     "workspace-1",
		AgentSessionID:  "session-1",
		TurnID:          "turn-settled",
		Phase:           agentactivitybiz.TurnPhaseSettled,
		Outcome:         agentactivitybiz.TurnOutcomeCompleted,
		StartedAtUnixMS: 10,
		UpdatedAtUnixMS: 20,
	}
	latestInteractions := []agentactivitybiz.Interaction{
		{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-settled",
			RequestID: "request-answered", Kind: agentactivitybiz.InteractionKindQuestion,
			Status: agentactivitybiz.InteractionStatusAnswered,
		},
		{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-settled",
			RequestID: "request-superseded", Kind: agentactivitybiz.InteractionKindApproval,
			Status: agentactivitybiz.InteractionStatusSuperseded,
		},
	}
	generated, err := generatedAgentSession(agentservice.Session{
		ID:                     "session-1",
		Kind:                   agentactivitybiz.SessionKindRoot,
		Provider:               "codex",
		RailSectionKey:         "project:repo-1",
		CreatedAt:              time.UnixMilli(10),
		LatestTurn:             &latest,
		LatestTurnInteractions: latestInteractions,
		Metadata: agentactivitybiz.SessionMetadata{
			Capabilities: []string{"planMode", "planImplementation"},
			Usage: &agentactivitybiz.SessionUsage{
				ContextWindow: &agentactivitybiz.SessionUsageContextWindow{UsedTokens: 7_460, TotalTokens: 200_000},
				Quotas:        []agentactivitybiz.SessionUsageQuota{},
			},
			Goal:     &agentactivitybiz.SessionGoal{Objective: "ship", Status: "active"},
			Imported: true,
		},
	})
	if err != nil {
		t.Fatalf("generatedAgentSession() error = %v", err)
	}
	if generated.ActiveTurn != nil || generated.ActiveTurnId != nil {
		t.Fatalf("active turn = %#v id=%#v, want none", generated.ActiveTurn, generated.ActiveTurnId)
	}
	if generated.LatestTurn == nil || generated.LatestTurn.TurnId != "turn-settled" || generated.LatestTurn.Outcome == nil {
		t.Fatalf("latest turn = %#v", generated.LatestTurn)
	}
	if len(generated.LatestTurnInteractions) != 2 ||
		generated.LatestTurnInteractions[0].Status != "answered" ||
		generated.LatestTurnInteractions[1].Status != "superseded" {
		t.Fatalf("latest turn interactions = %#v", generated.LatestTurnInteractions)
	}
	if generated.PendingInteractions == nil || generated.Capabilities == nil || !generated.Capabilities.PlanMode ||
		generated.Usage == nil || generated.Usage.ContextWindow == nil || generated.Usage.ContextWindow.UsedTokens != 7_460 ||
		generated.Goal == nil || !generated.Imported {
		t.Fatalf("v2 session fields = %#v", generated)
	}
	if generated.RailSectionKey != "project:repo-1" {
		t.Fatalf("rail section key = %q, want project:repo-1", generated.RailSectionKey)
	}
	encoded, err := json.Marshal(generated)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	if _, ok := payload["activeTurnId"]; !ok || payload["activeTurnId"] != nil {
		t.Fatalf("activeTurnId payload=%#v", payload)
	}
	if interactions, ok := payload["pendingInteractions"].([]any); !ok || len(interactions) != 0 {
		t.Fatalf("pendingInteractions payload=%#v", payload)
	}
	if payload["railSectionKey"] != "project:repo-1" {
		t.Fatalf("railSectionKey payload=%#v", payload)
	}
	for _, removed := range []string{"status", "turnLifecycle", "submitAvailability", "runtimeContext", "createdAt", "updatedAt", "endedAt", "lastError"} {
		if _, ok := payload[removed]; ok {
			t.Fatalf("removed field %q leaked in payload=%#v", removed, payload)
		}
	}
}
