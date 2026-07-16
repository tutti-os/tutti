package api

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	tuttimodeplanservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeplan"
)

const (
	testWorkflowID   = "11111111-1111-4111-8111-111111111111"
	testRevisionID   = "22222222-2222-4222-8222-222222222222"
	testCheckpointID = "33333333-3333-4333-8333-333333333333"
)

type stubTuttiModePlanService struct {
	views           []tuttimodeplanservice.SnapshotView
	getInput        tuttimodeplanservice.GetInput
	listWorkspaceID string
	listSessionID   string
	decideInput     tuttimodeplanservice.DecideInput
	decideFn        func(context.Context, tuttimodeplanservice.DecideInput) (tuttimodeplanservice.DecisionResult, error)
}

func (service *stubTuttiModePlanService) GetView(_ context.Context, input tuttimodeplanservice.GetInput) (tuttimodeplanservice.SnapshotView, error) {
	service.getInput = input
	return service.views[0], nil
}

func (service *stubTuttiModePlanService) ListPendingBySourceSession(_ context.Context, workspaceID string, sessionID string) ([]tuttimodeplanservice.SnapshotView, error) {
	service.listWorkspaceID = workspaceID
	service.listSessionID = sessionID
	return service.views, nil
}

func (service *stubTuttiModePlanService) Decide(ctx context.Context, input tuttimodeplanservice.DecideInput) (tuttimodeplanservice.DecisionResult, error) {
	if service.decideFn != nil {
		return service.decideFn(ctx, input)
	}
	service.decideInput = input
	service.views[0].Checkpoints[0].Status = input.Decision
	return tuttimodeplanservice.DecisionResult{Checkpoint: service.views[0].Checkpoints[0], Changed: true}, nil
}

func TestListWorkspaceWorkflowsReturnsAuthoritativeMarkdownSnapshot(t *testing.T) {
	service := &stubTuttiModePlanService{views: []tuttimodeplanservice.SnapshotView{workflowViewFixture()}}
	response, err := (DaemonAPI{TuttiModePlanService: service}).ListWorkspaceWorkflows(context.Background(), tuttigenerated.ListWorkspaceWorkflowsRequestObject{
		WorkspaceID: "workspace-1",
		Params: tuttigenerated.ListWorkspaceWorkflowsParams{
			SourceSessionId: "session-1",
		},
	})
	if err != nil {
		t.Fatalf("ListWorkspaceWorkflows() error = %v", err)
	}
	result, ok := response.(tuttigenerated.ListWorkspaceWorkflows200JSONResponse)
	if !ok {
		t.Fatalf("response = %T", response)
	}
	if service.listWorkspaceID != "workspace-1" || service.listSessionID != "session-1" {
		t.Fatalf("list inputs = %q/%q", service.listWorkspaceID, service.listSessionID)
	}
	if len(result.Workflows) != 1 || result.Workflows[0].Revisions[0].Document.MarkdownBody != "Plan body\n" {
		t.Fatalf("workflows = %#v", result.Workflows)
	}
	if len(result.Workflows[0].ActionableItems) != 1 || result.Workflows[0].ActionableItems[0].Id != testWorkflowID+"/"+testRevisionID+"/task-1" {
		t.Fatalf("actionable items = %#v", result.Workflows[0].ActionableItems)
	}
}

func TestListWorkspaceWorkflowsRejectsUnsupportedCheckpointStatusAtTransportBoundary(t *testing.T) {
	t.Parallel()
	service := &stubTuttiModePlanService{views: []tuttimodeplanservice.SnapshotView{workflowViewFixture()}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{TuttiModePlanService: service}))

	response := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodGet,
		"/v1/workspaces/workspace-1/workflows?sourceSessionId=session-1&checkpointStatus=accepted",
		nil,
	)
	mux.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusBadRequest, response.Body.String())
	}
	if service.listWorkspaceID != "" || service.listSessionID != "" {
		t.Fatalf("list service received invalid request: workspace=%q session=%q", service.listWorkspaceID, service.listSessionID)
	}
}

func TestDecideWorkspaceWorkflowCheckpointForwardsUserDecisionOutsideAgentInteraction(t *testing.T) {
	service := &stubTuttiModePlanService{views: []tuttimodeplanservice.SnapshotView{workflowViewFixture()}}
	reason := "Split the task"
	response, err := (DaemonAPI{TuttiModePlanService: service}).DecideWorkspaceWorkflowCheckpoint(context.Background(), tuttigenerated.DecideWorkspaceWorkflowCheckpointRequestObject{
		WorkspaceID:  "workspace-1",
		WorkflowID:   uuid.MustParse(testWorkflowID),
		CheckpointID: uuid.MustParse(testCheckpointID),
		Body: &tuttigenerated.DecideWorkspaceWorkflowCheckpointRequest{
			Decision:  tuttigenerated.DecideWorkspaceWorkflowCheckpointRequestDecisionRejected,
			DecidedBy: "user-1",
			Reason:    &reason,
		},
	})
	if err != nil {
		t.Fatalf("DecideWorkspaceWorkflowCheckpoint() error = %v", err)
	}
	if _, ok := response.(tuttigenerated.DecideWorkspaceWorkflowCheckpoint200JSONResponse); !ok {
		t.Fatalf("response = %T", response)
	}
	if service.decideInput.WorkflowID != testWorkflowID || service.decideInput.CheckpointID != testCheckpointID || service.decideInput.Decision != workflowbiz.CheckpointStatusRejected || service.decideInput.DecidedBy != "user-1" || service.decideInput.DecisionReason != reason {
		t.Fatalf("decision input = %#v", service.decideInput)
	}
}

func TestDecideWorkspaceWorkflowCheckpointRejectsInvalidDecisionAtTransportBoundary(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		body map[string]any
	}{
		{name: "invalid decision", body: map[string]any{"decision": "deferred", "decidedBy": "user-1"}},
		{name: "missing decision", body: map[string]any{"decidedBy": "user-1"}},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			service := &stubTuttiModePlanService{decideFn: func(context.Context, tuttimodeplanservice.DecideInput) (tuttimodeplanservice.DecisionResult, error) {
				t.Fatal("Decide should not be called for an invalid decision enum")
				return tuttimodeplanservice.DecisionResult{}, nil
			}}
			mux := http.NewServeMux()
			RegisterRoutes(mux, NewRoutes(DaemonAPI{TuttiModePlanService: service}))

			response := performGeneratedRouteRequest(
				t,
				mux,
				http.MethodPost,
				"/v1/workspaces/workspace-1/workflows/"+testWorkflowID+"/checkpoints/"+testCheckpointID+"/decision",
				test.body,
			)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusBadRequest, response.Body.String())
			}
		})
	}
}

func TestWorkspaceWorkflowRoutesAreRegistered(t *testing.T) {
	service := &stubTuttiModePlanService{views: []tuttimodeplanservice.SnapshotView{workflowViewFixture()}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{TuttiModePlanService: service}))

	t.Run("list by source session", func(t *testing.T) {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/v1/workspaces/workspace-1/workflows?sourceSessionId=session-1", nil)
		mux.ServeHTTP(response, request)

		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusOK, response.Body.String())
		}
		if service.listWorkspaceID != "workspace-1" || service.listSessionID != "session-1" {
			t.Fatalf("list inputs = %q/%q", service.listWorkspaceID, service.listSessionID)
		}
	})

	t.Run("get authoritative snapshot", func(t *testing.T) {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/v1/workspaces/workspace-1/workflows/"+testWorkflowID, nil)
		mux.ServeHTTP(response, request)

		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusOK, response.Body.String())
		}
		if service.getInput.WorkspaceID != "workspace-1" || service.getInput.WorkflowID != testWorkflowID {
			t.Fatalf("get input = %#v", service.getInput)
		}
	})

	t.Run("decide checkpoint", func(t *testing.T) {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(
			http.MethodPost,
			"/v1/workspaces/workspace-1/workflows/"+testWorkflowID+"/checkpoints/"+testCheckpointID+"/decision",
			strings.NewReader(`{"decision":"rejected","decidedBy":"user-1","reason":"Split the task"}`),
		)
		request.Header.Set("Content-Type", "application/json")
		mux.ServeHTTP(response, request)

		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusOK, response.Body.String())
		}
		if service.decideInput.WorkflowID != testWorkflowID || service.decideInput.CheckpointID != testCheckpointID {
			t.Fatalf("decision input = %#v", service.decideInput)
		}
	})
}

func TestListWorkspaceWorkflowsSerializesEmptyTaskDependenciesAsArray(t *testing.T) {
	t.Parallel()

	service := &stubTuttiModePlanService{views: []tuttimodeplanservice.SnapshotView{workflowViewFixture()}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{TuttiModePlanService: service}))

	response := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodGet,
		"/v1/workspaces/workspace-1/workflows?sourceSessionId=session-1&checkpointStatus=pending",
		nil,
	)
	mux.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusOK, response.Body.String())
	}
	var payload struct {
		Workflows []struct {
			Revisions []struct {
				Document struct {
					Tasks []struct {
						DependsOn json.RawMessage `json:"dependsOn"`
					} `json:"tasks"`
				} `json:"document"`
			} `json:"revisions"`
		} `json:"workflows"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v; body: %s", err, response.Body.String())
	}
	got := payload.Workflows[0].Revisions[0].Document.Tasks[0].DependsOn
	if string(got) != "[]" {
		t.Fatalf("dependsOn = %s, want []", got)
	}
}

func TestGetWorkspaceWorkflowRecoversNonFinitePersistedBudgetAsJSONError(t *testing.T) {
	t.Parallel()

	view := workflowViewFixture()
	view.Revisions[0].Document.Budget.QuotaWaterlinePercent = math.NaN()
	service := &stubTuttiModePlanService{views: []tuttimodeplanservice.SnapshotView{view}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{TuttiModePlanService: service}))

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/v1/workspaces/workspace-1/workflows/"+testWorkflowID, nil)
	mux.ServeHTTP(response, request)

	if response.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusBadGateway, response.Body.String())
	}
	if !json.Valid(response.Body.Bytes()) || strings.Contains(response.Body.String(), "NaN") {
		t.Fatalf("response is not a finite JSON recovery error: %q", response.Body.String())
	}
}

func workflowViewFixture() tuttimodeplanservice.SnapshotView {
	now := time.UnixMilli(1_700_000_000_000).UTC()
	task := tuttimodeplanservice.PlanTask{ID: "task-1", Title: "Implement", Content: "Ship it", Priority: "high", DependsOn: []string{}}
	execution := tuttimodeplanservice.PlanExecution{Mode: "sequential", ReasoningIntensity: 60, OrchestrationIntensity: 70}
	budget := tuttimodeplanservice.PlanBudget{Mode: "auto", TokenLimit: 0, QuotaWaterlinePercent: 20}
	return tuttimodeplanservice.SnapshotView{
		Workflow: workflowbiz.Workflow{
			ID:                testWorkflowID,
			WorkspaceID:       "workspace-1",
			Type:              workflowbiz.WorkflowTypeTuttiModePlan,
			Owner:             workflowbiz.WorkflowOwnerTutti,
			TriggerKind:       workflowbiz.TriggerKindAgentCLI,
			SourceSessionID:   "session-1",
			SourceToolCallID:  "tool-1",
			Status:            workflowbiz.WorkflowStatusAccepted,
			CurrentRevisionID: testRevisionID,
			CreatedAt:         now,
			UpdatedAt:         now,
		},
		Revisions: []tuttimodeplanservice.RevisionView{{
			Revision: workflowbiz.PlanRevision{
				ID:            testRevisionID,
				WorkflowID:    testWorkflowID,
				Sequence:      1,
				SchemaVersion: tuttimodeplanservice.SchemaV1,
				DocumentPath:  "tutti-mode-plans/11111111-1111-4111-8111-111111111111/revisions/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md",
				SHA256:        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				CreatedAt:     now,
			},
			Document: tuttimodeplanservice.PlanDocument{
				Schema:    tuttimodeplanservice.SchemaV1,
				Phase:     tuttimodeplanservice.PhaseTaskGraph,
				Title:     "Plan",
				TopicID:   "topic-1",
				Execution: execution,
				Budget:    budget,
				Tasks:     []tuttimodeplanservice.PlanTask{task},
				Body:      "Plan body\n",
			},
		}},
		Checkpoints: []workflowbiz.WorkflowCheckpoint{{
			ID:         testCheckpointID,
			WorkflowID: testWorkflowID,
			Kind:       workflowbiz.CheckpointKindTaskReview,
			RevisionID: testRevisionID,
			Status:     workflowbiz.CheckpointStatusAccepted,
			CreatedAt:  now,
			UpdatedAt:  now,
		}},
		ActionableItems: []tuttimodeplanservice.ActionableItem{{
			ID:               testWorkflowID + "/" + testRevisionID + "/task-1",
			SourceWorkflowID: testWorkflowID,
			SourceRevisionID: testRevisionID,
			Ordinal:          1,
			TopicID:          "topic-1",
			Execution:        execution,
			Budget:           budget,
			Task:             task,
		}},
	}
}
