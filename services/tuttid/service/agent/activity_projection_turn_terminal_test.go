package agent

import (
	"context"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentturnanalyticsbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentturnanalytics"
	tuttimodeactivationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
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

func TestActivityProjectionReportsAgentAndModelConfigSources(t *testing.T) {
	tests := []struct {
		name            string
		session         agentactivitybiz.Session
		sessionFound    bool
		wantAgentSource string
		wantModelSource string
	}{
		{
			name: "workspace agent with model plan",
			session: terminalAnalyticsSession(
				"workspace-agent:reviewer",
				"model-plan",
			),
			sessionFound:    true,
			wantAgentSource: "workspace_agent",
			wantModelSource: "model_plan",
		},
		{
			name: "workspace agent with provider native model",
			session: terminalAnalyticsSession(
				"workspace-agent:reviewer",
				"provider-native",
			),
			sessionFound:    true,
			wantAgentSource: "workspace_agent",
			wantModelSource: "provider_native",
		},
		{
			name: "built in agent target",
			session: terminalAnalyticsSession(
				"local:codex",
				"provider-native",
			),
			sessionFound:    true,
			wantAgentSource: "agent_target",
			wantModelSource: "provider_native",
		},
		{
			name: "legacy session without runtime snapshot",
			session: agentactivitybiz.Session{
				AgentTargetID: "local:codex",
			},
			sessionFound:    true,
			wantAgentSource: "agent_target",
			wantModelSource: "unknown",
		},
		{
			name:            "missing session",
			wantAgentSource: "unknown",
			wantModelSource: "unknown",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := &activityProjectionRepoStub{
				session:      tt.session,
				sessionFound: tt.sessionFound,
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
					Turn: agentactivitybiz.Turn{
						TurnID: "turn-1", Origin: agentactivitybiz.TurnOriginUserPrompt,
						Outcome: agentactivitybiz.TurnOutcomeCompleted,
					},
				}},
			})
			if err != nil {
				t.Fatalf("ObserveCommitted() error=%v", err)
			}
			if len(reporter.events) != 1 {
				t.Fatalf("events=%#v, want one terminal event", reporter.events)
			}
			params := reporter.events[0].Params
			if got := params["agent_config_source"]; got != tt.wantAgentSource {
				t.Fatalf("agent_config_source=%#v, want %q in %#v", got, tt.wantAgentSource, params)
			}
			if got := params["model_config_source"]; got != tt.wantModelSource {
				t.Fatalf("model_config_source=%#v, want %q in %#v", got, tt.wantModelSource, params)
			}
			if _, exists := params["agent_target_id"]; exists {
				t.Fatalf("params contain agent target identity: %#v", params)
			}
			if _, exists := params["model_plan_id"]; exists {
				t.Fatalf("params contain model plan identity: %#v", params)
			}
		})
	}
}

func TestActivityProjectionReportsAcceptedTuttiModeTurnState(t *testing.T) {
	tests := []struct {
		name     string
		snapshot tuttimodeactivationbiz.TurnSnapshot
		found    bool
		accepted bool
		readErr  error
		want     string
	}{
		{
			name: "accepted active snapshot",
			snapshot: tuttimodeactivationbiz.TurnSnapshot{
				ActivationID: "activation-secret", RevisionID: "revision-secret", Revision: 1,
				State: tuttimodeactivationbiz.StateActive, Source: tuttimodeactivationbiz.SourceSlashCommand,
				Effect: 80, Speed: 20,
			},
			found: true, accepted: true, want: "active",
		},
		{
			name: "accepted inactive unconfigured snapshot",
			snapshot: tuttimodeactivationbiz.TurnSnapshot{
				State: tuttimodeactivationbiz.StateInactive,
			},
			found: true, accepted: true, want: "inactive",
		},
		{name: "prepared but not accepted", found: true, want: "unknown"},
		{name: "snapshot missing", accepted: true, want: "unknown"},
		{name: "snapshot read failed", found: true, accepted: true, readErr: context.Canceled, want: "unknown"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := &activityProjectionRepoStub{
				submission: agentactivitybiz.TurnSubmission{
					ClientSubmitID: "submit-1", MetadataJSON: `{"uiMode":"agent"}`,
				},
				submissionFound:               true,
				tuttiModeTurnSnapshot:         tt.snapshot,
				tuttiModeTurnSnapshotFound:    tt.found,
				tuttiModeTurnSnapshotAccepted: tt.accepted,
				tuttiModeTurnSnapshotErr:      tt.readErr,
			}
			reporter := &recordingAgentAnalyticsReporter{}
			projection := NewActivityProjection(repo)
			projection.SetAnalyticsReporter(reporter)
			_ = projection.ObserveCommitted(context.Background(), agenthost.CommittedDelta{
				RootTurnsSettled: []agenthost.RootTurnSettled{{
					WorkspaceID: "ws-1", AgentSessionID: "session-1", Provider: "codex",
					Turn: agentactivitybiz.Turn{
						TurnID: "turn-1", Origin: agentactivitybiz.TurnOriginUserPrompt,
						Outcome: agentactivitybiz.TurnOutcomeCompleted,
					},
				}},
			})
			if len(reporter.events) != 1 || reporter.events[0].Params["tutti_mode_state"] != tt.want {
				t.Fatalf("events=%#v, want tutti_mode_state=%q", reporter.events, tt.want)
			}
			for _, forbidden := range []string{"activation_id", "revision_id", "effect", "speed"} {
				if _, exists := reporter.events[0].Params[forbidden]; exists {
					t.Fatalf("terminal event leaked %s: %#v", forbidden, reporter.events[0])
				}
			}
		})
	}
}

func terminalAnalyticsSession(agentTargetID string, modelSource string) agentactivitybiz.Session {
	modelConfiguration := map[string]any{
		"source":      modelSource,
		"fingerprint": "model-fingerprint",
	}
	if modelSource == "model-plan" {
		modelConfiguration["modelPlanId"] = "plan-1"
		modelConfiguration["modelPlanRevision"] = uint64(1)
	}
	return agentactivitybiz.Session{
		AgentTargetID: agentTargetID,
		Provider:      "codex",
		InternalRuntimeContext: map[string]any{
			"sessionRuntimeSnapshot": map[string]any{
				"version":              1,
				"agentTargetId":        agentTargetID,
				"harnessAgentTargetId": "local:codex",
				"provider":             "codex",
				"modelConfiguration":   modelConfiguration,
			},
		},
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
