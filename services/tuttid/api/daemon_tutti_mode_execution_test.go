package api

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

func TestArchiveTuttiModeExecutionUsesAuthenticatedLocalOperator(t *testing.T) {
	t.Parallel()
	var received tuttimodeexecutionservice.ArchiveInput
	now := time.UnixMilli(1_700_003_000_000).UTC()
	api := DaemonAPI{TuttiModeExecutionService: tuttiModeExecutionAPIStub{
		archive: func(_ context.Context, input tuttimodeexecutionservice.ArchiveInput) (executionbiz.ArchiveOperation, error) {
			received = input
			return executionbiz.ArchiveOperation{
				WorkspaceID: input.WorkspaceID, ExecutionID: "execution-1", IssueID: input.IssueID,
				OperationID: "archive-1", RequestID: input.RequestID,
				Status: executionbiz.ArchiveStatusCompleted, RequestedBy: input.RequestedBy,
				Reason: input.Reason, CreatedAt: now, UpdatedAt: now, CompletedAt: now,
			}, nil
		},
	}}
	_, err := api.ArchiveTuttiModeExecution(context.Background(), tuttigenerated.ArchiveTuttiModeExecutionRequestObject{
		WorkspaceID: "workspace-1", IssueID: "issue-1",
		Body: &tuttigenerated.ArchiveTuttiModeExecutionRequest{
			RequestId: "request-1", Reason: "stop",
		},
	})
	if err != nil {
		t.Fatalf("ArchiveTuttiModeExecution() error=%v", err)
	}
	if received.RequestedBy != authenticatedLocalOperatorActorID {
		t.Fatalf("RequestedBy=%q, want authenticated actor %q", received.RequestedBy, authenticatedLocalOperatorActorID)
	}
}

func TestArchiveTuttiModeExecutionHTTPContractRejectsSpoofedActor(t *testing.T) {
	t.Parallel()
	now := time.UnixMilli(1_700_003_000_000).UTC()
	service := tuttiModeExecutionAPIStub{
		archive: func(_ context.Context, input tuttimodeexecutionservice.ArchiveInput) (executionbiz.ArchiveOperation, error) {
			return executionbiz.ArchiveOperation{
				WorkspaceID: input.WorkspaceID, ExecutionID: "execution-1", IssueID: input.IssueID,
				OperationID: "archive-1", RequestID: input.RequestID,
				Status: executionbiz.ArchiveStatusCompleted, RequestedBy: input.RequestedBy,
				Reason: input.Reason, CreatedAt: now, UpdatedAt: now, CompletedAt: now,
			}, nil
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{TuttiModeExecutionService: service}))
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/workspaces/workspace-1/tutti-executions/issue-1/archive",
		bytes.NewBufferString(`{
			"requestId":"request-1",
			"requestedBy":"spoofed-user",
			"reason":"stop"
		}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want %d; body=%s", response.Code, http.StatusBadRequest, response.Body.String())
	}
}

func TestArchiveTuttiModeExecutionHTTPContractReturnsTypedConflict(t *testing.T) {
	t.Parallel()
	service := tuttiModeExecutionAPIStub{
		archive: func(_ context.Context, _ tuttimodeexecutionservice.ArchiveInput) (executionbiz.ArchiveOperation, error) {
			return executionbiz.ArchiveOperation{}, executionbiz.ErrExecutionConflict
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{TuttiModeExecutionService: service}))
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/workspaces/workspace-1/tutti-executions/issue-1/archive",
		bytes.NewBufferString(`{
			"requestId":"request-1",
			"reason":"stop"
		}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("status=%d, want %d; body=%s", response.Code, http.StatusConflict, response.Body.String())
	}
	body := response.Body.String()
	for _, expected := range []string{
		`"code":"tutti_mode_archive_conflict"`,
		`"reason":"tutti_archive_request_conflict"`,
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("body=%s, want %s", body, expected)
		}
	}
}

func TestArchiveTuttiModeExecutionReturnsDurableFailedOperation(t *testing.T) {
	t.Parallel()
	now := time.UnixMilli(1_700_003_000_000).UTC()
	api := DaemonAPI{TuttiModeExecutionService: tuttiModeExecutionAPIStub{
		archive: func(_ context.Context, input tuttimodeexecutionservice.ArchiveInput) (executionbiz.ArchiveOperation, error) {
			return executionbiz.ArchiveOperation{
				WorkspaceID: input.WorkspaceID, ExecutionID: "execution-1", IssueID: input.IssueID,
				OperationID: "archive-1", RequestID: input.RequestID,
				Status: executionbiz.ArchiveStatusFailed, RequestedBy: input.RequestedBy,
				Reason: input.Reason, LastError: "cancel failed", CreatedAt: now, UpdatedAt: now,
			}, errors.New("cancel failed")
		},
	}}
	response, err := api.ArchiveTuttiModeExecution(context.Background(), tuttigenerated.ArchiveTuttiModeExecutionRequestObject{
		WorkspaceID: "workspace-1", IssueID: "issue-1",
		Body: &tuttigenerated.ArchiveTuttiModeExecutionRequest{
			RequestId: "request-1", Reason: "stop",
		},
	})
	if err != nil {
		t.Fatalf("ArchiveTuttiModeExecution() error=%v", err)
	}
	operation, ok := response.(tuttigenerated.ArchiveTuttiModeExecution200JSONResponse)
	if !ok || operation.Status != tuttigenerated.TuttiModeArchiveOperationStatusFailed ||
		operation.LastError != "cancel failed" {
		t.Fatalf("ArchiveTuttiModeExecution() response=%#v", response)
	}
}

func TestProtectedSourceDeletionMapsSingleBatchAndClearToTypedConflict(t *testing.T) {
	t.Parallel()
	err := &executionbiz.ProtectedSourceError{
		WorkspaceID: "workspace-1",
		Issues: []executionbiz.ProtectedIssue{{
			IssueID: "issue-1", ExecutionID: "execution-1",
			SourceSessionID: "source-1", Status: executionbiz.StatusRunning,
		}},
	}
	if _, ok := writeDeleteWorkspaceAgentSessionError(err).(tuttigenerated.DeleteWorkspaceAgentSession409JSONResponse); !ok {
		t.Fatal("single deletion did not return 409")
	}
	if _, ok := writeDeleteWorkspaceAgentSessionsBatchError(err).(tuttigenerated.DeleteWorkspaceAgentSessionsBatch409JSONResponse); !ok {
		t.Fatal("batch deletion did not return 409")
	}
	if _, ok := writeClearWorkspaceAgentSessionsError(err).(tuttigenerated.ClearWorkspaceAgentSessions409JSONResponse); !ok {
		t.Fatal("clear deletion did not return 409")
	}
}

func TestGetTuttiModeArchiveOperationRejectsOperationFromAnotherIssue(t *testing.T) {
	t.Parallel()
	api := DaemonAPI{TuttiModeExecutionService: tuttiModeExecutionAPIStub{
		get: func(_ context.Context, workspaceID, operationID string) (executionbiz.ArchiveOperation, error) {
			return executionbiz.ArchiveOperation{
				WorkspaceID: workspaceID, IssueID: "issue-2", OperationID: operationID,
			}, nil
		},
	}}
	response, err := api.GetTuttiModeArchiveOperation(
		context.Background(),
		tuttigenerated.GetTuttiModeArchiveOperationRequestObject{
			WorkspaceID: "workspace-1", IssueID: "issue-1",
			Params: tuttigenerated.GetTuttiModeArchiveOperationParams{OperationId: "archive-1"},
		},
	)
	if err != nil {
		t.Fatalf("GetTuttiModeArchiveOperation() error=%v", err)
	}
	if _, ok := response.(tuttigenerated.GetTuttiModeArchiveOperation404JSONResponse); !ok {
		t.Fatalf("GetTuttiModeArchiveOperation() response=%#v, want 404", response)
	}
}

type tuttiModeExecutionAPIStub struct {
	archive func(context.Context, tuttimodeexecutionservice.ArchiveInput) (executionbiz.ArchiveOperation, error)
	get     func(context.Context, string, string) (executionbiz.ArchiveOperation, error)
}

func (stub tuttiModeExecutionAPIStub) Archive(
	ctx context.Context, input tuttimodeexecutionservice.ArchiveInput,
) (executionbiz.ArchiveOperation, error) {
	return stub.archive(ctx, input)
}

func (stub tuttiModeExecutionAPIStub) GetArchive(
	ctx context.Context, workspaceID, operationID string,
) (executionbiz.ArchiveOperation, error) {
	if stub.get == nil {
		return executionbiz.ArchiveOperation{}, executionbiz.ErrExecutionNotFound
	}
	return stub.get(ctx, workspaceID, operationID)
}
