package api

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
	"gopkg.in/yaml.v3"
)

const switchGoalReviewToSelfPath = "/v1/workspaces/{workspaceID}/issues/{issueID}/tutti-mode-review/self"

type stubTuttiModeGoalReviewService struct {
	input  tuttimodeexecutionservice.SwitchReviewToSelfInput
	result tuttimodeexecutionservice.SwitchReviewToSelfResult
	err    error
}

func (stub *stubTuttiModeGoalReviewService) SwitchReviewToSelf(
	_ context.Context,
	input tuttimodeexecutionservice.SwitchReviewToSelfInput,
) (tuttimodeexecutionservice.SwitchReviewToSelfResult, error) {
	stub.input = input
	return stub.result, stub.err
}

func TestOpenAPIDefinesExplicitAuditedGoalReviewFallback(t *testing.T) {
	raw, err := os.ReadFile("openapi/tuttid.v1.yaml")
	if err != nil {
		t.Fatalf("ReadFile(openapi) error = %v", err)
	}
	document := string(raw)
	for _, required := range []string{
		switchGoalReviewToSelfPath + ":",
		"operationId: switchTuttiModeGoalReviewToSelf",
		"checkpointId:",
		"expectedGraphRevision:",
		"requestId:",
		"reason:",
		"additionalProperties: false",
		"security:",
		"- bearerAuth: []",
	} {
		if !strings.Contains(document, required) {
			t.Fatalf("OpenAPI is missing Goal Review fallback contract %q", required)
		}
	}
	pathStart := strings.Index(document, switchGoalReviewToSelfPath+":")
	if pathStart < 0 {
		t.Fatal("Goal Review fallback path is missing")
	}
	pathDocument := document[pathStart:]
	if nextPath := strings.Index(pathDocument[1:], "\n  /v1/"); nextPath >= 0 {
		pathDocument = pathDocument[:nextPath+1]
	}
	if strings.Contains(pathDocument, "requestedBy") {
		t.Fatal("Goal Review fallback request must not accept a caller-supplied actor")
	}

	var parsed map[string]any
	if err := yaml.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("yaml.Unmarshal(openapi) error = %v", err)
	}
	paths, ok := parsed["paths"].(map[string]any)
	if !ok {
		t.Fatal("OpenAPI paths are not parseable")
	}
	path, ok := paths[switchGoalReviewToSelfPath].(map[string]any)
	if !ok {
		t.Fatalf("parsed OpenAPI path %q is missing", switchGoalReviewToSelfPath)
	}
	post, ok := path["post"].(map[string]any)
	if !ok || post["operationId"] != "switchTuttiModeGoalReviewToSelf" {
		t.Fatalf("parsed Goal Review POST operation = %#v", post)
	}
	if override, exists := post["security"]; exists {
		entries, isList := override.([]any)
		if !isList || !isExactBearerSecurityRequirement(entries) {
			t.Fatalf("Goal Review POST weakens inherited security: %#v", override)
		}
	}
	security, ok := parsed["security"].([]any)
	if !ok || !isExactBearerSecurityRequirement(security) {
		t.Fatalf("OpenAPI effective root security = %#v", parsed["security"])
	}
}

func TestGeneratedGoalReviewFallbackTypesContainNoCallerSuppliedActor(t *testing.T) {
	requestType := reflect.TypeOf(tuttigenerated.SwitchTuttiModeGoalReviewToSelfRequest{})
	if _, ok := requestType.FieldByName("RequestedBy"); ok {
		t.Fatal("generated Goal Review fallback request exposes RequestedBy")
	}
	for _, name := range []string{"CheckpointId", "ExpectedGraphRevision", "RequestId", "Reason"} {
		if _, ok := requestType.FieldByName(name); !ok {
			t.Fatalf("generated Goal Review fallback request is missing %s", name)
		}
	}
}

func TestExactBearerSecurityRequirementRejectsAnonymousOrDifferentOverrides(t *testing.T) {
	tests := []struct {
		name    string
		entries []any
		want    bool
	}{
		{
			name:    "exact bearer",
			entries: []any{map[string]any{"bearerAuth": []any{}}},
			want:    true,
		},
		{name: "empty security", entries: []any{}},
		{name: "anonymous requirement", entries: []any{map[string]any{}}},
		{
			name:    "different scheme",
			entries: []any{map[string]any{"oauth": []any{}}},
		},
		{
			name: "bearer plus anonymous alternative",
			entries: []any{
				map[string]any{"bearerAuth": []any{}},
				map[string]any{},
			},
		},
		{
			name:    "bearer plus second scheme",
			entries: []any{map[string]any{"bearerAuth": []any{}, "oauth": []any{}}},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := isExactBearerSecurityRequirement(test.entries); got != test.want {
				t.Fatalf("isExactBearerSecurityRequirement(%#v) = %v, want %v", test.entries, got, test.want)
			}
		})
	}
}

func TestSwitchGoalReviewToSelfUsesTrustedActorAndReturnsTypedReplay(t *testing.T) {
	for _, replayed := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "replay"}[replayed], func(t *testing.T) {
			service := &stubTuttiModeGoalReviewService{
				result: tuttimodeexecutionservice.SwitchReviewToSelfResult{
					ExecutionID: "execution-1",
					ReviewID:    "review-1",
					ReviewMode:  "self",
					Replayed:    replayed,
				},
			}
			body := goalReviewFallbackRequest()
			body.CheckpointId = " checkpoint-1 "
			body.RequestId = " fallback-1 "
			body.Reason = " reviewer failed "
			response, err := (DaemonAPI{TuttiModeGoalReviewService: service}).SwitchTuttiModeGoalReviewToSelf(
				context.Background(),
				tuttigenerated.SwitchTuttiModeGoalReviewToSelfRequestObject{
					WorkspaceID: " workspace-1 ",
					IssueID:     " issue-1 ",
					Body:        &body,
				},
			)
			if err != nil {
				t.Fatalf("SwitchTuttiModeGoalReviewToSelf() error = %v", err)
			}
			got, ok := response.(tuttigenerated.SwitchTuttiModeGoalReviewToSelf200JSONResponse)
			if !ok {
				t.Fatalf("response type = %T, want 200 response", response)
			}
			if got.ExecutionId != "execution-1" || got.ReviewId != "review-1" ||
				got.ReviewMode != tuttigenerated.Self || got.Replayed != replayed {
				t.Fatalf("response = %#v", got)
			}
			wantInput := tuttimodeexecutionservice.SwitchReviewToSelfInput{
				WorkspaceID:           "workspace-1",
				IssueID:               "issue-1",
				CheckpointID:          "checkpoint-1",
				ExpectedGraphRevision: 7,
				RequestID:             "fallback-1",
				Reason:                "reviewer failed",
				RequestedByActorID:    authenticatedLocalOperatorActorID,
			}
			if service.input != wantInput {
				t.Fatalf("service input = %#v, want %#v", service.input, wantInput)
			}
		})
	}
}

func TestSwitchGoalReviewToSelfRejectsInvalidTypedRequests(t *testing.T) {
	valid := goalReviewFallbackRequest()
	tests := []struct {
		name       string
		body       *tuttigenerated.SwitchTuttiModeGoalReviewToSelfJSONRequestBody
		wantReason string
	}{
		{name: "missing body", wantReason: "empty_body"},
		{name: "blank checkpoint", body: mutateGoalReviewFallbackRequest(valid, func(body *tuttigenerated.SwitchTuttiModeGoalReviewToSelfJSONRequestBody) {
			body.CheckpointId = " "
		}), wantReason: "malformed_request"},
		{name: "invalid revision", body: mutateGoalReviewFallbackRequest(valid, func(body *tuttigenerated.SwitchTuttiModeGoalReviewToSelfJSONRequestBody) {
			body.ExpectedGraphRevision = 0
		}), wantReason: "malformed_request"},
		{name: "blank request id", body: mutateGoalReviewFallbackRequest(valid, func(body *tuttigenerated.SwitchTuttiModeGoalReviewToSelfJSONRequestBody) {
			body.RequestId = " "
		}), wantReason: "malformed_request"},
		{name: "blank reason", body: mutateGoalReviewFallbackRequest(valid, func(body *tuttigenerated.SwitchTuttiModeGoalReviewToSelfJSONRequestBody) {
			body.Reason = " "
		}), wantReason: "malformed_request"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := &stubTuttiModeGoalReviewService{}
			response, err := (DaemonAPI{TuttiModeGoalReviewService: service}).SwitchTuttiModeGoalReviewToSelf(
				context.Background(),
				tuttigenerated.SwitchTuttiModeGoalReviewToSelfRequestObject{
					WorkspaceID: "workspace-1",
					IssueID:     "issue-1",
					Body:        test.body,
				},
			)
			if err != nil {
				t.Fatalf("SwitchTuttiModeGoalReviewToSelf() error = %v", err)
			}
			if _, ok := response.(tuttigenerated.SwitchTuttiModeGoalReviewToSelf400JSONResponse); !ok {
				t.Fatalf("response type = %T, want 400 response", response)
			}
			details := goalReviewResponseErrorDetails(t, response)
			assertGoalReviewErrorDetails(
				t, details, tuttigenerated.InvalidRequest, test.wantReason, true,
			)
			if service.input != (tuttimodeexecutionservice.SwitchReviewToSelfInput{}) {
				t.Fatalf("invalid request reached service: %#v", service.input)
			}
		})
	}
}

func TestSwitchGoalReviewToSelfMapsDomainFailures(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantType   any
		wantCode   tuttigenerated.ApiErrorDetailsCode
		wantReason string
	}{
		{
			name:     "not found",
			err:      tuttimodeexecutionservice.ErrExecutionNotFound,
			wantType: tuttigenerated.SwitchTuttiModeGoalReviewToSelf404JSONResponse{},
			wantCode: tuttigenerated.TuttiModeGoalReviewNotFound, wantReason: "tutti_goal_review_not_found",
		},
		{
			name:     "rejected",
			err:      tuttimodeexecutionservice.ErrSwitchReviewToSelfRejected,
			wantType: tuttigenerated.SwitchTuttiModeGoalReviewToSelf409JSONResponse{},
			wantCode: tuttigenerated.TuttiModeGoalReviewConflict, wantReason: "tutti_goal_review_conflict",
		},
		{
			name:     "mutation conflict",
			err:      tuttimodeexecutionservice.ErrSwitchReviewToSelfMutationConflict,
			wantType: tuttigenerated.SwitchTuttiModeGoalReviewToSelf409JSONResponse{},
			wantCode: tuttigenerated.TuttiModeGoalReviewConflict, wantReason: "tutti_goal_review_conflict",
		},
		{
			name:     "execution conflict",
			err:      tuttimodeexecutionservice.ErrExecutionConflict,
			wantType: tuttigenerated.SwitchTuttiModeGoalReviewToSelf409JSONResponse{},
			wantCode: tuttigenerated.TuttiModeGoalReviewConflict, wantReason: "tutti_goal_review_conflict",
		},
		{
			name:     "service unavailable",
			err:      tuttimodeexecutionservice.ErrServiceUnavailable,
			wantType: tuttigenerated.SwitchTuttiModeGoalReviewToSelf503JSONResponse{},
			wantCode: tuttigenerated.TuttiModeGoalReviewServiceUnavailable, wantReason: "tutti_goal_review_service_unavailable",
		},
		{
			name:     "unexpected",
			err:      errors.New("database secret must not escape"),
			wantType: tuttigenerated.SwitchTuttiModeGoalReviewToSelf502JSONResponse{},
			wantCode: tuttigenerated.TuttiModeGoalReviewOperationFailed, wantReason: "tutti_goal_review_operation_failed",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := &stubTuttiModeGoalReviewService{err: test.err}
			body := goalReviewFallbackRequest()
			response, err := (DaemonAPI{TuttiModeGoalReviewService: service}).SwitchTuttiModeGoalReviewToSelf(
				context.Background(),
				tuttigenerated.SwitchTuttiModeGoalReviewToSelfRequestObject{
					WorkspaceID: "workspace-1",
					IssueID:     "issue-1",
					Body:        &body,
				},
			)
			if err != nil {
				t.Fatalf("SwitchTuttiModeGoalReviewToSelf() error = %v", err)
			}
			if reflect.TypeOf(response) != reflect.TypeOf(test.wantType) {
				t.Fatalf("response type = %T, want %T", response, test.wantType)
			}
			details := goalReviewResponseErrorDetails(t, response)
			assertGoalReviewErrorDetails(t, details, test.wantCode, test.wantReason, false)
			if strings.Contains(goalReviewErrorDetailsText(details), test.err.Error()) {
				t.Fatalf("error response leaked cause %q: %#v", test.err, details)
			}
		})
	}
}

func TestSwitchGoalReviewToSelfReturnsServiceUnavailableWithoutService(t *testing.T) {
	body := goalReviewFallbackRequest()
	response, err := (DaemonAPI{}).SwitchTuttiModeGoalReviewToSelf(
		context.Background(),
		tuttigenerated.SwitchTuttiModeGoalReviewToSelfRequestObject{
			WorkspaceID: "workspace-1",
			IssueID:     "issue-1",
			Body:        &body,
		},
	)
	if err != nil {
		t.Fatalf("SwitchTuttiModeGoalReviewToSelf() error = %v", err)
	}
	if _, ok := response.(tuttigenerated.SwitchTuttiModeGoalReviewToSelf503JSONResponse); !ok {
		t.Fatalf("response type = %T, want 503 response", response)
	}
	assertGoalReviewErrorDetails(
		t,
		goalReviewResponseErrorDetails(t, response),
		tuttigenerated.TuttiModeGoalReviewServiceUnavailable,
		"tutti_goal_review_service_unavailable",
		false,
	)
}

func TestGoalReviewFallbackHTTPContractRejectsSpoofedActorAndExposesRoute(t *testing.T) {
	service := &stubTuttiModeGoalReviewService{}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{TuttiModeGoalReviewService: service}))

	for _, test := range []struct {
		name       string
		body       string
		wantStatus int
	}{
		{
			name: "valid",
			body: `{
				"checkpointId":"checkpoint-1",
				"expectedGraphRevision":7,
				"requestId":"fallback-1",
				"reason":"Reviewer target is unavailable"
			}`,
			wantStatus: http.StatusOK,
		},
		{
			name: "spoofed actor",
			body: `{
				"checkpointId":"checkpoint-1",
				"expectedGraphRevision":7,
				"requestId":"fallback-1",
				"reason":"Reviewer target is unavailable",
				"requestedBy":"spoofed-user"
			}`,
			wantStatus: http.StatusBadRequest,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			service.result = tuttimodeexecutionservice.SwitchReviewToSelfResult{
				ExecutionID: "execution-1",
				ReviewID:    "review-1",
				ReviewMode:  "self",
			}
			request := httptest.NewRequest(
				http.MethodPost,
				"/v1/workspaces/workspace-1/issues/issue-1/tutti-mode-review/self",
				bytes.NewBufferString(test.body),
			)
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", response.Code, test.wantStatus, response.Body.String())
			}
			if test.wantStatus == http.StatusBadRequest && strings.Contains(response.Body.String(), "spoofed-user") {
				t.Fatalf("response leaked spoofed identity: %s", response.Body.String())
			}
		})
	}
}

func goalReviewFallbackRequest() tuttigenerated.SwitchTuttiModeGoalReviewToSelfJSONRequestBody {
	return tuttigenerated.SwitchTuttiModeGoalReviewToSelfJSONRequestBody{
		CheckpointId:          "checkpoint-1",
		ExpectedGraphRevision: 7,
		RequestId:             "fallback-1",
		Reason:                "reviewer failed",
	}
}

func mutateGoalReviewFallbackRequest(
	body tuttigenerated.SwitchTuttiModeGoalReviewToSelfJSONRequestBody,
	mutate func(*tuttigenerated.SwitchTuttiModeGoalReviewToSelfJSONRequestBody),
) *tuttigenerated.SwitchTuttiModeGoalReviewToSelfJSONRequestBody {
	mutate(&body)
	return &body
}

func goalReviewResponseErrorDetails(
	t *testing.T,
	response tuttigenerated.SwitchTuttiModeGoalReviewToSelfResponseObject,
) tuttigenerated.ApiErrorDetails {
	t.Helper()
	switch typed := response.(type) {
	case tuttigenerated.SwitchTuttiModeGoalReviewToSelf400JSONResponse:
		return typed.Error
	case tuttigenerated.SwitchTuttiModeGoalReviewToSelf404JSONResponse:
		return typed.Error
	case tuttigenerated.SwitchTuttiModeGoalReviewToSelf409JSONResponse:
		return typed.Error
	case tuttigenerated.SwitchTuttiModeGoalReviewToSelf502JSONResponse:
		return typed.Error
	case tuttigenerated.SwitchTuttiModeGoalReviewToSelf503JSONResponse:
		return typed.Error
	default:
		t.Fatalf("response type %T has no Goal Review error details", response)
		return tuttigenerated.ApiErrorDetails{}
	}
}

func assertGoalReviewErrorDetails(
	t *testing.T,
	details tuttigenerated.ApiErrorDetails,
	wantCode tuttigenerated.ApiErrorDetailsCode,
	wantReason string,
	allowDeveloperMessage bool,
) {
	t.Helper()
	if details.Code != wantCode || details.Reason == nil || *details.Reason != wantReason {
		t.Fatalf("error details = %#v, want code=%q reason=%q", details, wantCode, wantReason)
	}
	if !allowDeveloperMessage && details.DeveloperMessage != nil {
		t.Fatalf("error details unexpectedly expose developerMessage: %#v", details)
	}
}

func goalReviewErrorDetailsText(details tuttigenerated.ApiErrorDetails) string {
	values := []string{string(details.Code)}
	if details.Reason != nil {
		values = append(values, *details.Reason)
	}
	if details.DeveloperMessage != nil {
		values = append(values, *details.DeveloperMessage)
	}
	return strings.Join(values, " ")
}

func isExactBearerSecurityRequirement(entries []any) bool {
	if len(entries) != 1 {
		return false
	}
	requirement, ok := entries[0].(map[string]any)
	if !ok || len(requirement) != 1 {
		return false
	}
	scopes, ok := requirement["bearerAuth"].([]any)
	return ok && len(scopes) == 0
}
