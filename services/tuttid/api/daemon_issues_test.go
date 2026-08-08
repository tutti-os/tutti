package api

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

type recordingIssueRunLauncher struct {
	launches []workspaceservice.IssueRunLaunch
}

func (launcher *recordingIssueRunLauncher) Launch(_ context.Context, launch workspaceservice.IssueRunLaunch) error {
	launcher.launches = append(launcher.launches, launch)
	return nil
}

func TestDaemonAPIGeneratedRoutesCreateWorkspaceIssueMapsDuplicateIDTo409(t *testing.T) {
	store := openIssueRouteSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-route-1",
		Name: "Issue Route Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		IssueService: workspaceservice.IssueManagerService{Store: store},
	}))

	first := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-issue-route-1/issues", map[string]any{
		"issueId": "issue-fixed",
		"topicId": workspaceissues.DefaultTopicID,
		"title":   "First issue",
	})
	if first.Code != http.StatusCreated {
		t.Fatalf("first status = %d, want %d; body: %s", first.Code, http.StatusCreated, first.Body.String())
	}

	second := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-issue-route-1/issues", map[string]any{
		"issueId": "issue-fixed",
		"topicId": workspaceissues.DefaultTopicID,
		"title":   "Duplicate issue",
	})
	if second.Code != http.StatusConflict {
		t.Fatalf("second status = %d, want %d; body: %s", second.Code, http.StatusConflict, second.Body.String())
	}

	assertGeneratedRouteError(
		t,
		second,
		tuttigenerated.WorkspaceIssueResourceExists,
		apierrors.ReasonWorkspaceIssueExists,
		workspaceissues.ErrIssueAlreadyExists.Error(),
	)
}

func TestDaemonAPIGeneratedRoutesRejectInvalidIssueAttachments(t *testing.T) {
	store := openIssueRouteSQLiteStore(t)
	ctx := context.Background()
	const workspaceID = "ws-issue-attachment-contract"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Attachment contract"}); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		IssueService: workspaceservice.IssueManagerService{
			AttachmentFiles: workspacedata.IssueAttachmentFiles{StateDir: t.TempDir()},
			Store:           store,
		},
	}))
	tooMany := make([]map[string]any, 9)
	for index := range tooMany {
		tooMany[index] = map[string]any{"dataBase64": "iVBORw0KGgo=", "mimeType": "image/png"}
	}
	testCases := []struct {
		name        string
		attachments any
	}{
		{name: "invalid UUID", attachments: []map[string]any{{"attachmentId": "not-a-uuid", "dataBase64": "iVBORw0KGgo=", "mimeType": "image/png"}}},
		{name: "invalid MIME", attachments: []map[string]any{{"dataBase64": "iVBORw0KGgo=", "mimeType": "image/gif"}}},
		{name: "invalid base64", attachments: []map[string]any{{"dataBase64": "not base64!", "mimeType": "image/png"}}},
		{name: "too many", attachments: tooMany},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/"+workspaceID+"/issues", map[string]any{
				"attachments": testCase.attachments,
				"topicId":     workspaceissues.DefaultTopicID,
				"title":       "Invalid attachment",
			})
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
			}
		})
	}
}

func TestDaemonAPIStartsIssueRunWithTextAndImageAttachment(t *testing.T) {
	store := openIssueRouteSQLiteStore(t)
	ctx := context.Background()
	const workspaceID = "ws-issue-attachment-launch"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Attachment launch"}); err != nil {
		t.Fatal(err)
	}
	launcher := &recordingIssueRunLauncher{}
	issueService := &workspaceservice.IssueManagerService{
		AttachmentFiles: workspacedata.IssueAttachmentFiles{StateDir: t.TempDir()},
		MutationLocks:   workspaceservice.NewIssueMutationLocks(),
		RunLauncher:     launcher,
		Store:           store,
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{IssueService: issueService}))

	create := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/"+workspaceID+"/issues", map[string]any{
		"attachments": []map[string]any{{
			"dataBase64":  base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\ncontent")),
			"displayName": "capture.png",
			"mimeType":    "image/png",
		}},
		"content": "Check the broken layout",
		"topicId": workspaceissues.DefaultTopicID,
		"title":   "Inspect screenshot",
	})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d, want %d; body: %s", create.Code, http.StatusCreated, create.Body.String())
	}
	var created tuttigenerated.IssueManagerIssueResponse
	decodeGeneratedRouteResponse(t, create, &created)

	start := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/"+workspaceID+"/issues/"+created.Issue.IssueId+"/run-launches", map[string]any{
		"agentTargetId": "local:codex",
	})
	if start.Code != http.StatusCreated {
		t.Fatalf("start status = %d, want %d; body: %s", start.Code, http.StatusCreated, start.Body.String())
	}
	if len(launcher.launches) != 1 {
		t.Fatalf("launches = %#v, want one", launcher.launches)
	}
	launch := launcher.launches[0]
	if !strings.Contains(launch.Prompt, "Inspect screenshot") || !strings.Contains(launch.Prompt, "Check the broken layout") {
		t.Fatalf("prompt = %q, want title and note", launch.Prompt)
	}
	if len(launch.Attachments) != 1 || launch.Attachments[0].MimeType != "image/png" || launch.Attachments[0].Name != "capture.png" {
		t.Fatalf("attachments = %#v, want one PNG", launch.Attachments)
	}
	if !issueService.AttachmentFiles.IsManagedPath(launch.Attachments[0].Path) {
		t.Fatalf("attachment path = %q, want managed path", launch.Attachments[0].Path)
	}
}

func TestDaemonAPIPlanIssueSchemaRejectsAttachments(t *testing.T) {
	store := openIssueRouteSQLiteStore(t)
	ctx := context.Background()
	const workspaceID = "ws-plan-attachment-contract"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Plan attachment contract"}); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{IssueService: &workspaceservice.IssueManagerService{Store: store}}))
	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/"+workspaceID+"/issues/from-plan", map[string]any{
		"issue": map[string]any{
			"attachments":    []map[string]any{{"dataBase64": "iVBORw0KGgo=", "mimeType": "image/png"}},
			"planningSource": "traditional_plan",
			"topicId":        workspaceissues.DefaultTopicID,
			"title":          "Plan",
		},
		"tasks": []map[string]any{{"title": "Implement"}},
	})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
}

func TestDaemonAPIGeneratedRoutesRejectForgedTuttiModeIssueProvenance(t *testing.T) {
	store := openIssueRouteSQLiteStore(t)
	ctx := context.Background()
	const workspaceID = "ws-issue-route-tutti-provenance"
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   workspaceID,
		Name: "Issue Tutti Provenance Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		IssueService: workspaceservice.IssueManagerService{Store: store},
	}))
	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/"+workspaceID+"/issues", map[string]any{
		"issueId":         "ordinary-forged-tutti",
		"topicId":         workspaceissues.DefaultTopicID,
		"title":           "Forged Tutti provenance",
		"planningSource":  string(workspaceissues.PlanningSourceTuttiModePlan),
		"sourceSessionId": "session-1",
	})

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
	if _, err := store.GetIssue(ctx, workspaceID, "ordinary-forged-tutti"); !errors.Is(err, workspaceissues.ErrIssueNotFound) {
		t.Fatalf("GetIssue() error = %v, want no forged Issue", err)
	}
}

func TestDaemonAPIGeneratedRoutesIssueTopicLifecycle(t *testing.T) {
	store := openIssueRouteSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-topic-route",
		Name: "Issue Topic Route Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		IssueService: workspaceservice.IssueManagerService{Store: store},
	}))

	create := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-issue-topic-route/issue-topics", map[string]any{
		"summary": "Renderer migration issues",
		"title":   "Renderer",
		"topicId": "topic-renderer",
	})
	if create.Code != http.StatusCreated {
		t.Fatalf("create topic status = %d, want %d; body: %s", create.Code, http.StatusCreated, create.Body.String())
	}
	var createResponse tuttigenerated.IssueManagerTopicResponse
	decodeGeneratedRouteResponse(t, create, &createResponse)
	if createResponse.Topic.TopicId != "topic-renderer" || createResponse.Topic.Summary != "Renderer migration issues" {
		t.Fatalf("created topic = %+v", createResponse.Topic)
	}

	pinned := true
	update := performGeneratedRouteRequest(t, mux, http.MethodPatch, "/v1/workspaces/ws-issue-topic-route/issue-topics/topic-renderer", map[string]any{
		"pinned":  pinned,
		"summary": "Updated summary",
	})
	if update.Code != http.StatusOK {
		t.Fatalf("update topic status = %d, want %d; body: %s", update.Code, http.StatusOK, update.Body.String())
	}
	var updateResponse tuttigenerated.IssueManagerTopicResponse
	decodeGeneratedRouteResponse(t, update, &updateResponse)
	if updateResponse.Topic.PinnedAtUnix == 0 || updateResponse.Topic.Summary != "Updated summary" {
		t.Fatalf("updated topic = %+v", updateResponse.Topic)
	}

	list := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/workspaces/ws-issue-topic-route/issue-topics", nil)
	if list.Code != http.StatusOK {
		t.Fatalf("list topic status = %d, want %d; body: %s", list.Code, http.StatusOK, list.Body.String())
	}
	var listResponse tuttigenerated.IssueManagerTopicListResponse
	decodeGeneratedRouteResponse(t, list, &listResponse)
	if len(listResponse.Topics) != 2 || listResponse.Topics[0].TopicId != "topic-renderer" {
		t.Fatalf("topic list = %+v", listResponse.Topics)
	}

	deleteTopic := performGeneratedRouteRequest(t, mux, http.MethodDelete, "/v1/workspaces/ws-issue-topic-route/issue-topics/topic-renderer", nil)
	if deleteTopic.Code != http.StatusOK {
		t.Fatalf("delete topic status = %d, want %d; body: %s", deleteTopic.Code, http.StatusOK, deleteTopic.Body.String())
	}
	var deleteResponse tuttigenerated.DeleteIssueManagerTopicResponse
	decodeGeneratedRouteResponse(t, deleteTopic, &deleteResponse)
	if !deleteResponse.Removed {
		t.Fatal("delete topic removed = false, want true")
	}

	nonEmptyTopic := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-issue-topic-route/issue-topics", map[string]any{
		"title":   "Non empty",
		"topicId": "topic-non-empty",
	})
	if nonEmptyTopic.Code != http.StatusCreated {
		t.Fatalf("create non-empty topic status = %d, want %d; body: %s", nonEmptyTopic.Code, http.StatusCreated, nonEmptyTopic.Body.String())
	}
	issue := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-issue-topic-route/issues", map[string]any{
		"title":   "Keep topic",
		"topicId": "topic-non-empty",
	})
	if issue.Code != http.StatusCreated {
		t.Fatalf("create issue status = %d, want %d; body: %s", issue.Code, http.StatusCreated, issue.Body.String())
	}
	deleteNonEmptyTopic := performGeneratedRouteRequest(t, mux, http.MethodDelete, "/v1/workspaces/ws-issue-topic-route/issue-topics/topic-non-empty", nil)
	if deleteNonEmptyTopic.Code != http.StatusConflict {
		t.Fatalf("delete non-empty topic status = %d, want %d; body: %s", deleteNonEmptyTopic.Code, http.StatusConflict, deleteNonEmptyTopic.Body.String())
	}
	assertGeneratedRouteError(
		t,
		deleteNonEmptyTopic,
		tuttigenerated.WorkspaceIssueResourceExists,
		apierrors.ReasonWorkspaceIssueTopicNotEmpty,
		workspaceissues.ErrTopicNotEmpty.Error(),
	)
}

func TestDaemonAPIGeneratedRoutesRequireIssueTopicID(t *testing.T) {
	store := openIssueRouteSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-topic-required",
		Name: "Issue Topic Required Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		IssueService: workspaceservice.IssueManagerService{Store: store},
	}))

	createMissingTopic := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-issue-topic-required/issues", map[string]any{
		"title": "Missing topic",
	})
	if createMissingTopic.Code != http.StatusBadRequest {
		t.Fatalf("create missing topic status = %d, want %d; body: %s", createMissingTopic.Code, http.StatusBadRequest, createMissingTopic.Body.String())
	}

	listMissingTopic := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/workspaces/ws-issue-topic-required/issues", nil)
	if listMissingTopic.Code != http.StatusBadRequest {
		t.Fatalf("list missing topic status = %d, want %d; body: %s", listMissingTopic.Code, http.StatusBadRequest, listMissingTopic.Body.String())
	}
}

func TestDaemonAPIGeneratedRoutesMapMissingIssueTopicTo404(t *testing.T) {
	store := openIssueRouteSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-topic-missing",
		Name: "Issue Topic Missing Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		IssueService: workspaceservice.IssueManagerService{Store: store},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-issue-topic-missing/issues", map[string]any{
		"title":   "Missing topic",
		"topicId": "missing-topic",
	})
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusNotFound, recorder.Body.String())
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.WorkspaceIssueResourceNotFound,
		apierrors.ReasonWorkspaceIssueTopicNotFound,
		workspaceissues.ErrTopicNotFound.Error(),
	)

	list := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/workspaces/ws-issue-topic-missing/issues?topicId=missing-topic", nil)
	if list.Code != http.StatusNotFound {
		t.Fatalf("list status = %d, want %d; body: %s", list.Code, http.StatusNotFound, list.Body.String())
	}
	assertGeneratedRouteError(
		t,
		list,
		tuttigenerated.WorkspaceIssueResourceNotFound,
		apierrors.ReasonWorkspaceIssueTopicNotFound,
		workspaceissues.ErrTopicNotFound.Error(),
	)
}

func TestDaemonAPIGeneratedRoutesUpdateWorkspaceIssueStatus(t *testing.T) {
	store := openIssueRouteSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-route-status",
		Name: "Issue Route Status Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	issueService := workspaceservice.IssueManagerService{Store: store}
	issue, err := issueService.CreateIssue(ctx, "ws-issue-route-status", workspaceservice.CreateIssueManagerIssueInput{
		IssueID: "issue-status",
		TopicID: workspaceissues.DefaultTopicID,
		Title:   "Mark me done",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}

	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{IssueService: issueService}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPatch,
		"/v1/workspaces/ws-issue-route-status/issues/issue-status",
		map[string]any{"status": "completed"},
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.IssueManagerIssueResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Issue.Status != tuttigenerated.IssueManagerStatusCompleted {
		t.Fatalf("response issue status = %q", response.Issue.Status)
	}

	detail, err := issueService.GetIssueDetail(ctx, "ws-issue-route-status", issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if detail.Issue.Status != workspaceissues.StatusCompleted {
		t.Fatalf("stored issue status = %q", detail.Issue.Status)
	}
}

func TestDaemonAPIGeneratedRoutesCreateWorkspaceIssueTasksPreservesOrder(t *testing.T) {
	store := openIssueRouteSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-route-batch",
		Name: "Issue Route Batch Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	issueService := workspaceservice.IssueManagerService{Store: store}
	issue, err := issueService.CreateIssue(ctx, "ws-issue-route-batch", workspaceservice.CreateIssueManagerIssueInput{
		IssueID: "issue-batch",
		TopicID: workspaceissues.DefaultTopicID,
		Title:   "Break down work",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}

	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{IssueService: issueService}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/ws-issue-route-batch/issues/issue-batch/tasks/batch-create",
		map[string]any{"tasks": []map[string]any{
			{"taskId": "task-1", "title": "1. Baseline", "content": "Capture current state"},
			{"taskId": "task-2", "title": "2. Metrics", "priority": "high"},
		}},
	)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusCreated, recorder.Body.String())
	}

	var response tuttigenerated.IssueManagerTasksResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if len(response.Tasks) != 2 || response.Tasks[0].TaskId != "task-1" || response.Tasks[0].SortIndex != 1 || response.Tasks[1].TaskId != "task-2" || response.Tasks[1].SortIndex != 2 {
		t.Fatalf("response tasks = %#v", response.Tasks)
	}

	detail, err := issueService.GetIssueDetail(ctx, "ws-issue-route-batch", issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if len(detail.Tasks) != 2 || detail.Tasks[0].TaskID != "task-1" || detail.Tasks[1].TaskID != "task-2" {
		t.Fatalf("stored tasks = %#v", detail.Tasks)
	}
}

func TestDaemonAPIGeneratedRoutesRemoveWorkspaceIssueTaskContextRef(t *testing.T) {
	store := openIssueRouteSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-route-2",
		Name: "Issue Route Workspace Two",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	issueService := workspaceservice.IssueManagerService{Store: store}
	issue, err := issueService.CreateIssue(ctx, "ws-issue-route-2", workspaceservice.CreateIssueManagerIssueInput{
		IssueID: "issue-1",
		TopicID: workspaceissues.DefaultTopicID,
		Title:   "Scoped delete",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	task, err := issueService.CreateTask(ctx, "ws-issue-route-2", issue.IssueID, workspaceservice.CreateIssueManagerTaskInput{
		TaskID: "task-1",
		Title:  "Delete a ref",
	})
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}
	refs, err := issueService.AddTaskContextRefs(ctx, "ws-issue-route-2", issue.IssueID, task.TaskID, workspaceservice.AddIssueManagerContextRefsInput{
		Refs: []workspaceissues.AddContextRefInput{{
			ContextRefID: "task-ref-1",
			RefType:      "file",
			Path:         "/workspace/docs/task.md",
		}},
	})
	if err != nil {
		t.Fatalf("AddTaskContextRefs() error = %v", err)
	}
	if len(refs) != 1 {
		t.Fatalf("refs len = %d, want 1", len(refs))
	}

	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{IssueService: issueService}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodDelete,
		"/v1/workspaces/ws-issue-route-2/issues/issue-1/tasks/task-1/context-refs/task-ref-1",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response struct {
		Removed bool `json:"removed"`
	}
	decodeGeneratedRouteResponse(t, recorder, &response)
	if !response.Removed {
		t.Fatal("removed = false, want true")
	}

	detail, err := issueService.GetTaskDetail(ctx, "ws-issue-route-2", issue.IssueID, task.TaskID)
	if err != nil {
		t.Fatalf("GetTaskDetail() error = %v", err)
	}
	if len(detail.ContextRefs) != 0 {
		t.Fatalf("task context refs len = %d, want 0", len(detail.ContextRefs))
	}
}

func openIssueRouteSQLiteStore(t *testing.T) *workspacedata.SQLiteStore {
	t.Helper()

	dbPath := filepath.Join(t.TempDir(), "tuttid.db")
	store, err := workspacedata.OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	return store
}
