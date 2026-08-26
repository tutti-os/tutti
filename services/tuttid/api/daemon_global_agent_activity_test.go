package api

import (
	"context"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

type globalAgentActivityServiceStub struct {
	filterOptions *agentsessionstore.GlobalAgentActivityFilterOptions
	sessions      *agentsessionstore.ListGlobalAgentActivitySessionsReply
	listCalls     int
}

func (s *globalAgentActivityServiceStub) FilterOptions(context.Context) (*agentsessionstore.GlobalAgentActivityFilterOptions, error) {
	return s.filterOptions, nil
}

func (s *globalAgentActivityServiceStub) ListSessions(context.Context, agentsessionstore.ListGlobalAgentActivitySessionsInput) (*agentsessionstore.ListGlobalAgentActivitySessionsReply, error) {
	s.listCalls++
	return s.sessions, nil
}

func TestGetGlobalAgentActivityFilterOptionsProjectsControlPlaneResponse(t *testing.T) {
	service := &globalAgentActivityServiceStub{filterOptions: &agentsessionstore.GlobalAgentActivityFilterOptions{
		Rooms:         []agentsessionstore.GlobalAgentActivityRoomOption{{RoomID: "room-1", Name: "Room 1"}},
		SessionOwners: []agentsessionstore.GlobalAgentActivitySessionOwnerOption{{UserID: "owner-1", DisplayName: "Owner"}},
		Agents:        []agentsessionstore.GlobalAgentActivityAgentOption{{AgentKey: "target:codex", AgentTargetID: "codex"}},
		TimeBounds:    agentsessionstore.GlobalAgentActivityTimeBounds{MinActivityAtUnixMS: 10, MaxActivityAtUnixMS: 20, ServerNowUnixMS: 30},
	}}
	response, err := (DaemonAPI{GlobalAgentActivityService: service}).GetGlobalAgentActivityFilterOptions(
		context.Background(), tuttigenerated.GetGlobalAgentActivityFilterOptionsRequestObject{},
	)
	if err != nil {
		t.Fatal(err)
	}
	ok, matched := response.(tuttigenerated.GetGlobalAgentActivityFilterOptions200JSONResponse)
	if !matched || len(ok.Rooms) != 1 || ok.Rooms[0].RoomId != "room-1" || ok.TimeBounds.ServerNowUnixMs != 30 {
		t.Fatalf("response = %#v", response)
	}
}

func TestListGlobalAgentActivitySessionsRequiresAFilterBeforeCallingService(t *testing.T) {
	service := &globalAgentActivityServiceStub{sessions: &agentsessionstore.ListGlobalAgentActivitySessionsReply{}}
	response, err := (DaemonAPI{GlobalAgentActivityService: service}).ListGlobalAgentActivitySessions(
		context.Background(), tuttigenerated.ListGlobalAgentActivitySessionsRequestObject{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, matched := response.(tuttigenerated.ListGlobalAgentActivitySessions400JSONResponse); !matched {
		t.Fatalf("response = %#v", response)
	}
	if service.listCalls != 0 {
		t.Fatalf("list calls = %d", service.listCalls)
	}
}

func TestListGlobalAgentActivitySessionsReturnsBoundedResult(t *testing.T) {
	roomIDs := []string{"room-1"}
	service := &globalAgentActivityServiceStub{sessions: &agentsessionstore.ListGlobalAgentActivitySessionsReply{
		Items: []agentsessionstore.GlobalAgentActivitySession{{
			Room:        agentsessionstore.GlobalAgentActivityRoomOption{RoomID: "room-1"},
			WorkspaceID: "workspace-1", AgentSessionID: "session-1", Status: "working",
		}},
		Truncated: true,
	}}
	response, err := (DaemonAPI{GlobalAgentActivityService: service}).ListGlobalAgentActivitySessions(
		context.Background(), tuttigenerated.ListGlobalAgentActivitySessionsRequestObject{
			Params: tuttigenerated.ListGlobalAgentActivitySessionsParams{RoomIds: &roomIDs},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	ok, matched := response.(tuttigenerated.ListGlobalAgentActivitySessions200JSONResponse)
	if !matched || len(ok.Items) != 1 || ok.Items[0].AgentSessionId != "session-1" || !ok.Truncated {
		t.Fatalf("response = %#v", response)
	}
}
