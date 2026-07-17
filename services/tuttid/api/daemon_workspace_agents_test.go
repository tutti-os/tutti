package api

import (
	"context"
	"testing"
	"time"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	workspaceagentservice "github.com/tutti-os/tutti/services/tuttid/service/workspaceagent"
)

type stubWorkspaceAgentService struct {
	view        workspaceagentbiz.View
	err         error
	createdWith workspaceagentservice.PutInput
}

func (s *stubWorkspaceAgentService) List(context.Context, string) ([]workspaceagentbiz.View, error) {
	if s.err != nil {
		return nil, s.err
	}
	return []workspaceagentbiz.View{s.view}, nil
}

func (s *stubWorkspaceAgentService) Get(context.Context, string, string) (workspaceagentbiz.View, error) {
	return s.view, s.err
}

func (s *stubWorkspaceAgentService) Create(_ context.Context, input workspaceagentservice.PutInput) (workspaceagentbiz.View, error) {
	s.createdWith = input
	return s.view, s.err
}

func (s *stubWorkspaceAgentService) Update(_ context.Context, _ workspaceagentservice.PutInput) (workspaceagentbiz.View, error) {
	return s.view, s.err
}

func (s *stubWorkspaceAgentService) Delete(context.Context, string, string) error {
	return s.err
}

func testWorkspaceAgentView() workspaceagentbiz.View {
	now := time.Unix(1700000000, 0).UTC()
	return workspaceagentbiz.View{
		Agent: workspaceagentbiz.Agent{
			ID:                   "workspace-agent:one",
			WorkspaceID:          "ws",
			Name:                 "Builder",
			Description:          "Build",
			HarnessAgentTargetID: "local:codex",
			Instructions:         "Focus",
			CallConditions:       []string{"When implementation is needed"},
			Skills:               []string{"go"},
			Tools:                []string{},
			Source:               workspaceagentbiz.SourceUser,
			Revision:             1,
			CreatedAt:            now,
			UpdatedAt:            now,
		},
		Harness: workspaceagentbiz.Harness{
			AgentTargetID: "local:codex",
			Available:     true,
			Provider:      "codex",
			Name:          "Codex",
			IconKey:       "codex",
			Enabled:       true,
		},
	}
}

func TestCreateWorkspaceAgentMapsRequestAndProjection(t *testing.T) {
	service := &stubWorkspaceAgentService{view: testWorkspaceAgentView()}
	api := DaemonAPI{WorkspaceAgentService: service}
	response, err := api.CreateWorkspaceAgent(context.Background(), tuttigenerated.CreateWorkspaceAgentRequestObject{
		WorkspaceID: "ws",
		Body: &tuttigenerated.PutWorkspaceAgentRequest{
			Name:                 "Builder",
			Description:          "Build",
			HarnessAgentTargetId: "local:codex",
			Instructions:         "Focus",
			CallConditions:       []string{"When implementation is needed"},
			Skills:               []string{"go"},
			Tools:                []string{},
		},
	})
	if err != nil {
		t.Fatalf("CreateWorkspaceAgent() error = %v", err)
	}
	created, ok := response.(tuttigenerated.CreateWorkspaceAgent201JSONResponse)
	if !ok {
		t.Fatalf("CreateWorkspaceAgent() response = %T", response)
	}
	if created.Id != "workspace-agent:one" || created.AgentTargetId != created.Id {
		t.Fatalf("CreateWorkspaceAgent() identity = %#v", created)
	}
	if created.Harness.Provider == nil || *created.Harness.Provider != "codex" || created.Harness.IconKey == nil {
		t.Fatalf("CreateWorkspaceAgent() harness = %#v", created.Harness)
	}
	if service.createdWith.HarnessAgentTargetID != "local:codex" || service.createdWith.Description != "Build" {
		t.Fatalf("CreateWorkspaceAgent() input = %#v", service.createdWith)
	}
	if len(service.createdWith.CallConditions) != 1 || len(created.CallConditions) != 1 {
		t.Fatalf("CreateWorkspaceAgent() call conditions = %#v / %#v", service.createdWith.CallConditions, created.CallConditions)
	}
}

func TestGetWorkspaceAgentReturnsSpecificNotFoundCode(t *testing.T) {
	api := DaemonAPI{WorkspaceAgentService: &stubWorkspaceAgentService{err: workspacedata.ErrWorkspaceAgentNotFound}}
	response, err := api.GetWorkspaceAgent(context.Background(), tuttigenerated.GetWorkspaceAgentRequestObject{
		WorkspaceID:      "ws",
		WorkspaceAgentID: "workspace-agent:missing",
	})
	if err != nil {
		t.Fatalf("GetWorkspaceAgent() error = %v", err)
	}
	notFound, ok := response.(tuttigenerated.GetWorkspaceAgent404JSONResponse)
	if !ok {
		t.Fatalf("GetWorkspaceAgent() response = %T", response)
	}
	if notFound.Error.Code != tuttigenerated.WorkspaceAgentNotFound {
		t.Fatalf("GetWorkspaceAgent() code = %q", notFound.Error.Code)
	}
}
