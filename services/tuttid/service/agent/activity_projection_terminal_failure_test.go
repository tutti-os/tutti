package agent

import (
	"context"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

type recordingAgentTerminalFailureObserver struct {
	failures []agenthost.TerminalFailure
}

func (o *recordingAgentTerminalFailureObserver) ObserveTerminalFailure(
	_ context.Context,
	failure agenthost.TerminalFailure,
) {
	o.failures = append(o.failures, failure)
}

type sessionKindRepoStub struct {
	*activityProjectionRepoStub
	session agentactivitybiz.Session
}

func (r *sessionKindRepoStub) GetSession(
	_ context.Context,
	_ string,
	_ string,
) (agentactivitybiz.Session, bool, error) {
	return r.session, true, nil
}

// A live provider reports a failed tool call through ReportSessionMessages
// alone: there is no session state on that path, so child identity has to come
// from the canonical session.
func TestReportSessionMessagesMarksChildSessionToolFailures(t *testing.T) {
	tests := []struct {
		name    string
		session agentactivitybiz.Session
		want    bool
	}{
		{
			name:    "child session by kind",
			session: agentactivitybiz.Session{ID: "session-1", Kind: agentactivitybiz.SessionKindChild},
			want:    true,
		},
		{
			name:    "child session by parent tool call",
			session: agentactivitybiz.Session{ID: "session-1", ParentToolCallID: "call-1"},
			want:    true,
		},
		{
			name:    "root session",
			session: agentactivitybiz.Session{ID: "session-1", Kind: agentactivitybiz.SessionKindRoot},
			want:    false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := &sessionKindRepoStub{
				activityProjectionRepoStub: &activityProjectionRepoStub{
					messageResult: agentactivitybiz.MessageReportResult{
						AcceptedCount: 1,
						LatestVersion: 1,
						Messages: []agentactivitybiz.Message{{
							AgentSessionID: "session-1", MessageID: "toolcall:1", Version: 1, TurnID: "turn-1",
							Role: "assistant", Kind: "tool_call", Status: "failed",
							Payload: map[string]any{
								"toolName": "Bash",
								"error":    map[string]any{"text": "Exit code 137"},
							},
						}},
						StatusTransitionedMessageIDs: []string{"toolcall:1"},
					},
				},
				session: tt.session,
			}
			observer := &recordingAgentTerminalFailureObserver{}
			projection := NewActivityProjection(repo)
			projection.SetTerminalFailureObserver(observer)

			if _, err := projection.ReportSessionMessages(context.Background(), canonical.ReportSessionMessagesInput{
				WorkspaceID:    "ws-1",
				AgentSessionID: "session-1",
				SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
				Source:         canonical.EventSource{Provider: "codex"},
				Updates: []canonical.WorkspaceAgentSessionMessageUpdate{{
					MessageID: "toolcall:1", TurnID: "turn-1", Role: "assistant", Kind: "tool_call", Status: "failed",
				}},
			}); err != nil {
				t.Fatalf("ReportSessionMessages() error = %v", err)
			}

			if len(observer.failures) != 1 {
				t.Fatalf("terminal failures = %#v, want 1", observer.failures)
			}
			got := observer.failures[0]
			if got.Flow != "tool_call" || got.ErrorMessage != "Exit code 137" || got.ToolNameFamily != "bash" || got.Provider != "codex" {
				t.Fatalf("tool failure = %#v", got)
			}
			if got.IsChildSession != tt.want {
				t.Fatalf("IsChildSession = %v, want %v", got.IsChildSession, tt.want)
			}
		})
	}
}

func TestReportSessionMessagesSkipsReplayedToolFailures(t *testing.T) {
	repo := &sessionKindRepoStub{
		activityProjectionRepoStub: &activityProjectionRepoStub{
			messageResult: agentactivitybiz.MessageReportResult{
				AcceptedCount: 1,
				LatestVersion: 1,
				Messages: []agentactivitybiz.Message{{
					AgentSessionID: "session-1", MessageID: "toolcall:1", Version: 1, TurnID: "turn-1",
					Role: "assistant", Kind: "tool_call", Status: "failed",
					Payload: map[string]any{"toolName": "Bash", "error": map[string]any{"text": "Exit code 137"}},
				}},
			},
		},
		session: agentactivitybiz.Session{ID: "session-1", Kind: agentactivitybiz.SessionKindRoot},
	}
	observer := &recordingAgentTerminalFailureObserver{}
	projection := NewActivityProjection(repo)
	projection.SetTerminalFailureObserver(observer)

	if _, err := projection.ReportSessionMessages(context.Background(), canonical.ReportSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Source:         canonical.EventSource{Provider: "codex"},
		Updates: []canonical.WorkspaceAgentSessionMessageUpdate{{
			MessageID: "toolcall:1", TurnID: "turn-1", Role: "assistant", Kind: "tool_call", Status: "failed",
		}},
	}); err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
	if len(observer.failures) != 0 {
		t.Fatalf("terminal failures = %#v, want none for a replayed failed tool call", observer.failures)
	}
}
