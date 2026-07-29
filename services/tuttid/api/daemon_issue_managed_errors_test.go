package api

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

func TestManagedIssueMutationWritersReturnTypedConflict(t *testing.T) {
	managed := &workspaceissues.ManagedIssueMutationError{
		IssueID: "issue-managed", SourceSessionID: "source-session",
	}
	writers := map[string]func(error) any{
		"issue update":         func(err error) any { return writeUpdateWorkspaceIssueError(err) },
		"issue delete":         func(err error) any { return writeDeleteWorkspaceIssueError(err) },
		"issue context add":    func(err error) any { return writeAddWorkspaceIssueContextRefsError(err) },
		"issue context remove": func(err error) any { return writeRemoveWorkspaceIssueContextRefError(err) },
		"execution cancel":     func(err error) any { return writeCancelWorkspaceIssueExecutionError(err) },
		"issue run create":     func(err error) any { return writeCreateWorkspaceIssueRunError(err) },
		"task create":          func(err error) any { return writeCreateWorkspaceIssueTaskError(err) },
		"task batch create":    func(err error) any { return writeCreateWorkspaceIssueTasksError(err) },
		"task update":          func(err error) any { return writeUpdateWorkspaceIssueTaskError(err) },
		"task delete":          func(err error) any { return writeDeleteWorkspaceIssueTaskError(err) },
		"task context add":     func(err error) any { return writeAddWorkspaceIssueTaskContextRefsError(err) },
		"task context remove":  func(err error) any { return writeRemoveWorkspaceIssueTaskContextRefError(err) },
		"task run create":      func(err error) any { return writeCreateWorkspaceIssueTaskRunError(err) },
	}
	for name, writer := range writers {
		t.Run(name, func(t *testing.T) {
			response := writer(managed)
			if !strings.Contains(reflect.TypeOf(response).Name(), "409") {
				t.Fatalf("response type = %T, want generated 409 response", response)
			}
			encoded, err := json.Marshal(response)
			if err != nil {
				t.Fatalf("Marshal() error = %v", err)
			}
			var payload struct {
				Error struct {
					Reason string         `json:"reason"`
					Params map[string]any `json:"params"`
				} `json:"error"`
			}
			if err := json.Unmarshal(encoded, &payload); err != nil {
				t.Fatalf("Unmarshal() error = %v", err)
			}
			if payload.Error.Reason != "tutti_issue_managed" ||
				payload.Error.Params["issueId"] != "issue-managed" ||
				payload.Error.Params["sourceSessionId"] != "source-session" ||
				payload.Error.Params["recommendedAction"] != "open_source_session" {
				t.Fatalf("payload = %s", encoded)
			}
		})
	}
}
