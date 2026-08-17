package agent

import (
	"context"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentturnanalyticsbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentturnanalytics"
)

func TestActivityProjectionReportsCanonicalUserTurnOutcomes(t *testing.T) {
	tests := []struct {
		name              string
		outcome           string
		wantEvent         string
		startupReconciled bool
	}{
		{name: "completed", outcome: agentactivitybiz.TurnOutcomeCompleted, wantEvent: "agent.turn_completed"},
		{name: "failed", outcome: agentactivitybiz.TurnOutcomeFailed, wantEvent: "agent.turn_failed"},
		{name: "canceled", outcome: agentactivitybiz.TurnOutcomeCanceled, wantEvent: "agent.turn_cancelled"},
		{name: "startup interrupted", outcome: agentactivitybiz.TurnOutcomeInterrupted, wantEvent: "agent.turn_cancelled", startupReconciled: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := &activityProjectionRepoStub{
				submission: agentactivitybiz.TurnSubmission{
					ClientSubmitID: "submit-1",
					MetadataJSON:   `{"uiMode":"agent"}`,
				},
				submissionFound: true,
			}
			reporter := &recordingAgentAnalyticsReporter{}
			projection := NewActivityProjection(repo)
			projection.SetAnalyticsReporter(reporter)

			err := projection.ObserveCommitted(context.Background(), agenthost.CommittedDelta{
				RootTurnsSettled: []agenthost.RootTurnSettled{{
					WorkspaceID: "ws-1", AgentSessionID: "session-1", Provider: "codex",
					StartupReconciled: tt.startupReconciled,
					Turn: agentactivitybiz.Turn{
						TurnID: "turn-1", Origin: agentactivitybiz.TurnOriginUserPrompt,
						Outcome: tt.outcome, ErrorCode: "runtime_failed",
						StartedAtUnixMS: 1_000, SettledAtUnixMS: 11_000,
					},
				}},
			})
			if err != nil {
				t.Fatalf("ObserveCommitted() error=%v", err)
			}
			if len(reporter.events) != 1 || reporter.events[0].Name != tt.wantEvent {
				t.Fatalf("events=%#v, want one %s", reporter.events, tt.wantEvent)
			}
			params := reporter.events[0].Params
			for key, want := range map[string]any{
				"agent_session_id": "session-1",
				"client_submit_id": "submit-1",
				"event_id":         agentturnanalyticsbiz.StableEventID("ws-1", "session-1", "turn-1"),
				"mode":             "agent",
				"provider":         "codex",
				"turn_id":          "turn-1",
				"turn_origin":      agentactivitybiz.TurnOriginUserPrompt,
				"turn_outcome":     tt.outcome,
			} {
				if got := params[key]; got != want {
					t.Fatalf("params[%q]=%#v, want %#v in %#v", key, got, want, params)
				}
			}
			if _, exists := params["error_message"]; exists {
				t.Fatalf("params contain raw error message: %#v", params)
			}
			if _, exists := params["workspace_id"]; exists {
				t.Fatalf("params contain workspace identity: %#v", params)
			}
		})
	}
}

func TestActivityProjectionSkipsIneligibleTerminalTurns(t *testing.T) {
	tests := []struct {
		name       string
		metadata   string
		origin     string
		backfilled bool
		child      bool
		found      bool
	}{
		{name: "child session", metadata: `{"uiMode":"agent"}`, origin: agentactivitybiz.TurnOriginUserPrompt, child: true, found: true},
		{name: "goal turn", metadata: `{"uiMode":"agent"}`, origin: agentactivitybiz.TurnOriginGoalArm, found: true},
		{name: "provider initiated", metadata: `{"uiMode":"agent"}`, origin: agentactivitybiz.TurnOriginProviderInitiated, found: true},
		{name: "backfilled", metadata: `{"uiMode":"agent"}`, origin: agentactivitybiz.TurnOriginUserPrompt, backfilled: true, found: true},
		{name: "legacy missing submission", origin: agentactivitybiz.TurnOriginUserPrompt},
		{name: "missing mode", metadata: `{}`, origin: agentactivitybiz.TurnOriginUserPrompt, found: true},
		{name: "invalid mode", metadata: `{"uiMode":"unknown"}`, origin: agentactivitybiz.TurnOriginUserPrompt, found: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := &activityProjectionRepoStub{
				submission:      agentactivitybiz.TurnSubmission{MetadataJSON: tt.metadata},
				submissionFound: tt.found,
			}
			reporter := &recordingAgentAnalyticsReporter{}
			projection := NewActivityProjection(repo)
			projection.SetAnalyticsReporter(reporter)
			_ = projection.ObserveCommitted(context.Background(), agenthost.CommittedDelta{
				RootTurnsSettled: []agenthost.RootTurnSettled{{
					WorkspaceID: "ws-1", AgentSessionID: "session-1", Provider: "codex", IsChildSession: tt.child,
					Turn: agentactivitybiz.Turn{
						TurnID: "turn-1", Origin: tt.origin, Backfilled: tt.backfilled,
						Outcome: agentactivitybiz.TurnOutcomeCompleted,
					},
				}},
			})
			if len(reporter.events) != 0 {
				t.Fatalf("events=%#v, want none", reporter.events)
			}
		})
	}
}

func TestTerminalSubmissionModeRequiresClosedEnum(t *testing.T) {
	for _, tt := range []struct {
		metadata string
		mode     string
		ok       bool
	}{
		{metadata: `{"uiMode":"os"}`, mode: "os", ok: true},
		{metadata: `{"uiMode":"agent"}`, mode: "agent", ok: true},
		{metadata: `{"uiMode":" agent "}`},
		{metadata: `{"uiMode":null}`},
		{metadata: `{}`},
		{metadata: `not-json`},
	} {
		mode, ok := terminalSubmissionMode(tt.metadata)
		if mode != tt.mode || ok != tt.ok {
			t.Fatalf("terminalSubmissionMode(%q)=(%q,%v), want (%q,%v)", tt.metadata, mode, ok, tt.mode, tt.ok)
		}
	}
}
