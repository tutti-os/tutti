package api

import (
	"context"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func TestGetWorkspaceAgentSessionUsesMessageHydrationProjection(t *testing.T) {
	var received agentservice.SessionDetailProjection
	service := stubAgentSessionService{
		getDetailWithProjectionFn: func(
			_ context.Context,
			_, _ string,
			projection agentservice.SessionDetailProjection,
		) (agentservice.SessionDetail, error) {
			received = projection
			return agentservice.SessionDetail{
				Session: agentservice.Session{
					ID:             "session-1",
					Kind:           "root",
					RailSectionKey: "conversations",
				},
				ChildSessions: []agentservice.Session{},
			}, nil
		},
	}
	projection := tuttigenerated.MessageHydration

	response, err := (DaemonAPI{AgentSessionService: service}).
		GetWorkspaceAgentSession(t.Context(), tuttigenerated.GetWorkspaceAgentSessionRequestObject{
			WorkspaceID:    "workspace-1",
			AgentSessionID: "session-1",
			Params: tuttigenerated.GetWorkspaceAgentSessionParams{
				Projection: &projection,
			},
		})
	if err != nil {
		t.Fatal(err)
	}
	resolved, ok := response.(tuttigenerated.GetWorkspaceAgentSession200JSONResponse)
	if !ok {
		t.Fatalf("response=%T, want 200", response)
	}
	if resolved.Projection != tuttigenerated.MessageHydration {
		t.Fatalf("response projection=%q, want messageHydration", resolved.Projection)
	}
	if resolved.LifecycleCapabilitiesProjected {
		t.Fatal("message hydration capabilities unexpectedly resolved")
	}
	if received != agentservice.SessionDetailProjectionMessageHydration {
		t.Fatalf("projection=%q, want messageHydration", received)
	}
}

func TestGetWorkspaceAgentSessionRejectsUnknownProjection(t *testing.T) {
	projection := tuttigenerated.WorkspaceAgentSessionDetailProjection("unknown")

	response, err := (DaemonAPI{}).
		GetWorkspaceAgentSession(t.Context(), tuttigenerated.GetWorkspaceAgentSessionRequestObject{
			WorkspaceID:    "workspace-1",
			AgentSessionID: "session-1",
			Params: tuttigenerated.GetWorkspaceAgentSessionParams{
				Projection: &projection,
			},
		})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := response.(tuttigenerated.GetWorkspaceAgentSession400JSONResponse); !ok {
		t.Fatalf("response=%T, want 400", response)
	}
}
