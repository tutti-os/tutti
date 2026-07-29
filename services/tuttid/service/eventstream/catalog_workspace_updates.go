package eventstream

import (
	"fmt"
	"strings"

	"github.com/google/uuid"
	eventprotocol "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
)

func validateWorkspaceIssueUpdatedPayload(payload []byte) error {
	var decoded eventprotocol.WorkspaceIssueUpdatedPayload
	if err := decodeJSONStrict(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	if strings.TrimSpace(decoded.WorkspaceId) == "" {
		return fmt.Errorf("workspaceId is required")
	}
	if strings.TrimSpace(decoded.IssueId) == "" {
		return fmt.Errorf("issueId is required")
	}
	if decoded.TaskId != nil && strings.TrimSpace(*decoded.TaskId) == "" {
		return fmt.Errorf("taskId must not be blank")
	}
	if decoded.RunId != nil && strings.TrimSpace(*decoded.RunId) == "" {
		return fmt.Errorf("runId must not be blank")
	}
	switch strings.TrimSpace(decoded.ChangeKind) {
	case "issue_created",
		"issue_updated",
		"issue_deleted",
		"issue_context_refs_updated",
		"task_created",
		"task_updated",
		"task_deleted",
		"task_context_refs_updated",
		"run_created",
		"run_completed":
	default:
		return fmt.Errorf("changeKind is unsupported")
	}
	return nil
}

func validateWorkspaceWorkflowUpdatedPayload(payload []byte) error {
	var decoded eventprotocol.WorkspaceWorkflowUpdatedPayload
	if err := decodeJSONStrict(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	if _, err := uuid.Parse(strings.TrimSpace(decoded.WorkflowId)); err != nil {
		return fmt.Errorf("workflowId must be a UUID")
	}
	if strings.TrimSpace(decoded.SourceSessionId) == "" {
		return fmt.Errorf("sourceSessionId is required")
	}
	if _, err := uuid.Parse(strings.TrimSpace(decoded.CheckpointId)); err != nil {
		return fmt.Errorf("checkpointId must be a UUID")
	}
	switch strings.TrimSpace(decoded.ChangeKind) {
	case "proposal_created", "revision_created", "checkpoint_decided", "operation_updated":
	default:
		return fmt.Errorf("changeKind is unsupported")
	}
	return nil
}

func validateWorkspaceTuttiModeUpdatedPayload(payload []byte) error {
	var decoded eventprotocol.WorkspaceTuttimodeUpdatedPayload
	if err := decodeJSONStrict(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	if strings.TrimSpace(decoded.AgentSessionId) == "" {
		return fmt.Errorf("agentSessionId is required")
	}
	if _, err := uuid.Parse(strings.TrimSpace(decoded.ActivationId)); err != nil {
		return fmt.Errorf("activationId must be a UUID")
	}
	if decoded.Revision <= 0 {
		return fmt.Errorf("revision must be positive")
	}
	switch strings.TrimSpace(decoded.Status) {
	case "active", "inactive":
	default:
		return fmt.Errorf("status is unsupported")
	}
	switch strings.TrimSpace(decoded.ChangeKind) {
	case "activated", "deactivated":
	default:
		return fmt.Errorf("changeKind is unsupported")
	}
	return nil
}
