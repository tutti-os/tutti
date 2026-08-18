package turn_terminal

import "testing"

func TestBuildMapsTerminalOutcomes(t *testing.T) {
	tests := []struct {
		name       string
		outcome    string
		eventName  string
		status     string
		extraKey   string
		extraValue any
	}{
		{name: "completed", outcome: "completed", eventName: EventCompleted, status: "completed", extraKey: "value_enum", extraValue: "completed"},
		{name: "failed", outcome: "failed", eventName: EventFailed, status: "failed", extraKey: "error_code", extraValue: "runtime_failed"},
		{name: "canceled", outcome: "canceled", eventName: EventCancelled, status: "cancelled", extraKey: "source", extraValue: "runtime_event"},
		{name: "interrupted", outcome: "interrupted", eventName: EventCancelled, status: "cancelled", extraKey: "source", extraValue: "startup_reconciliation"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			eventName, params, ok := Build(Input{
				AgentSessionID: "session-1", ClientSubmitID: "submit-1", ErrorCode: "runtime_failed",
				Mode: "agent", Origin: "user_prompt", Outcome: tt.outcome, Provider: "codex",
				StartupReconciled: tt.outcome == "interrupted", StartedAtUnixMS: 1_000,
				SettledAtUnixMS: 11_000, TurnID: "turn-1",
			})
			if !ok || eventName != tt.eventName {
				t.Fatalf("Build() event=%q ok=%v, want %q true", eventName, ok, tt.eventName)
			}
			for key, want := range map[string]any{
				"agent_session_id": "session-1", "client_submit_id": "submit-1",
				"duration_bucket": "10s_to_30s", "duration_ms": int64(10_000),
				"mode": "agent", "provider": "codex", "status": tt.status,
				"turn_id": "turn-1", "turn_origin": "user_prompt", "turn_outcome": tt.outcome,
				tt.extraKey: tt.extraValue,
			} {
				if got := params[key]; got != want {
					t.Fatalf("params[%q]=%#v, want %#v in %#v", key, got, want, params)
				}
			}
		})
	}
}

func TestBuildRejectsMissingModeAndUnknownOutcome(t *testing.T) {
	for _, input := range []Input{
		{Mode: "", Outcome: "completed"},
		{Mode: "unknown", Outcome: "completed"},
		{Mode: "agent", Outcome: "running"},
	} {
		if eventName, params, ok := Build(input); ok || eventName != "" || params != nil {
			t.Fatalf("Build(%#v)=(%q,%#v,%v), want rejected", input, eventName, params, ok)
		}
	}
}

func TestBuildUsesContentFreeErrorFallback(t *testing.T) {
	_, params, ok := Build(Input{Mode: "os", Outcome: "failed", ErrorCode: "secret path /Users/example"})
	if !ok || params["error_code"] != unknownErrorCode {
		t.Fatalf("params=%#v ok=%v, want safe fallback", params, ok)
	}
	if _, exists := params["error_message"]; exists {
		t.Fatalf("params contain raw error message: %#v", params)
	}
}
