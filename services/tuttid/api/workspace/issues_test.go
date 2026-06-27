package workspace

import (
	"encoding/json"
	"testing"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

func TestGeneratedIssueManagerContextRefFromDomainScopesTaskID(t *testing.T) {
	t.Parallel()

	issuePayload := generatedContextRefPayload(t, workspaceissues.ContextRef{
		ContextRefID:    "context-ref-1",
		WorkspaceID:     "workspace-1",
		IssueID:         "issue-1",
		ParentKind:      workspaceissues.ContextRefParentIssue,
		RefType:         "file",
		Path:            "/workspace/issue.md",
		DisplayName:     "issue.md",
		CreatedAtUnixMS: 1700000000000,
	})
	if issuePayload["parentKind"] != string(workspaceissues.ContextRefParentIssue) {
		t.Fatalf("issue parentKind = %v, want issue", issuePayload["parentKind"])
	}
	if _, ok := issuePayload["taskId"]; ok {
		t.Fatalf("issue context ref taskId = %v, want omitted", issuePayload["taskId"])
	}

	taskPayload := generatedContextRefPayload(t, workspaceissues.ContextRef{
		ContextRefID:    "context-ref-2",
		WorkspaceID:     "workspace-1",
		IssueID:         "issue-1",
		TaskID:          "task-1",
		ParentKind:      workspaceissues.ContextRefParentTask,
		RefType:         "file",
		Path:            "/workspace/task.md",
		DisplayName:     "task.md",
		CreatedAtUnixMS: 1700000000000,
	})
	if taskPayload["parentKind"] != string(workspaceissues.ContextRefParentTask) {
		t.Fatalf("task parentKind = %v, want task", taskPayload["parentKind"])
	}
	if taskPayload["taskId"] != "task-1" {
		t.Fatalf("task context ref taskId = %v, want task-1", taskPayload["taskId"])
	}
}

func TestGeneratedIssueManagerStatusCountsFromDomainOmitsLegacyInProgress(t *testing.T) {
	t.Parallel()

	encoded, err := json.Marshal(GeneratedIssueManagerStatusCountsFromDomain(workspaceissues.StatusCounts{
		All:     3,
		Running: 3,
	}))
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if _, ok := payload["inProgress"]; ok {
		t.Fatalf("inProgress = %v, want omitted", payload["inProgress"])
	}
	if payload["running"] != float64(3) {
		t.Fatalf("running = %v, want 3", payload["running"])
	}
}

func generatedContextRefPayload(
	t *testing.T,
	ref workspaceissues.ContextRef,
) map[string]any {
	t.Helper()

	encoded, err := json.Marshal(GeneratedIssueManagerContextRefFromDomain(ref))
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	return payload
}
