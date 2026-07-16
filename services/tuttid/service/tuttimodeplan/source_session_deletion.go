package tuttimodeplan

import (
	"context"
	"fmt"
	"strings"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

const sourceSessionDeletedDecisionReason = "source_session_deleted"

// SourceSessionDeletionCoordinator is the Tutti-owned use-case contract used
// by production Agent session deletion. The Agent package mirrors this method
// shape structurally to avoid reversing the service dependency graph.
type SourceSessionDeletionCoordinator interface {
	DeleteSourceSession(context.Context, string, string) (agentactivitybiz.DeleteSessionsBatchResult, error)
	DeleteSourceSessionsBatch(context.Context, agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsBatchResult, error)
	ClearSourceSessions(context.Context, string) (agentactivitybiz.ClearSessionsResult, error)
}

var _ SourceSessionDeletionCoordinator = (*Service)(nil)

func (s *Service) DeleteSourceSession(
	ctx context.Context,
	workspaceID string,
	sessionID string,
) (agentactivitybiz.DeleteSessionsBatchResult, error) {
	return s.DeleteSourceSessionsBatch(ctx, agentactivitybiz.DeleteSessionsBatchInput{
		WorkspaceID: workspaceID,
		SessionIDs:  []string{sessionID},
	})
}

func (s *Service) DeleteSourceSessionsBatch(
	ctx context.Context,
	input agentactivitybiz.DeleteSessionsBatchInput,
) (agentactivitybiz.DeleteSessionsBatchResult, error) {
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.SessionIDs = normalizeSourceSessionIDs(input.SessionIDs)
	if input.WorkspaceID == "" || len(input.SessionIDs) == 0 {
		return agentactivitybiz.DeleteSessionsBatchResult{}, fmt.Errorf("%w: source session deletion scope is required", ErrInvalidInput)
	}
	result, err := s.executeSourceSessionDeletion(ctx, workspacedata.SourceSessionDeletionCommand{
		WorkspaceID:          input.WorkspaceID,
		SessionIDs:           input.SessionIDs,
		WorkflowCancellation: s.sourceSessionDeletionCancellation(),
	})
	if err != nil {
		return agentactivitybiz.DeleteSessionsBatchResult{}, err
	}
	return agentactivitybiz.DeleteSessionsBatchResult{
		RemovedMessages:   result.RemovedMessages,
		RemovedSessions:   result.RemovedSessions,
		RemovedSessionIDs: result.RemovedSessionIDs,
	}, nil
}

func (s *Service) ClearSourceSessions(
	ctx context.Context,
	workspaceID string,
) (agentactivitybiz.ClearSessionsResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return agentactivitybiz.ClearSessionsResult{}, fmt.Errorf("%w: workspace is required", ErrInvalidInput)
	}
	result, err := s.executeSourceSessionDeletion(ctx, workspacedata.SourceSessionDeletionCommand{
		WorkspaceID:          workspaceID,
		ClearWorkspace:       true,
		WorkflowCancellation: s.sourceSessionDeletionCancellation(),
	})
	if err != nil {
		return agentactivitybiz.ClearSessionsResult{}, err
	}
	return agentactivitybiz.ClearSessionsResult{
		RemovedMessages:   result.RemovedMessages,
		RemovedSessions:   result.RemovedSessions,
		RemovedSessionIDs: result.RemovedSessionIDs,
	}, nil
}

func (s *Service) executeSourceSessionDeletion(
	ctx context.Context,
	command workspacedata.SourceSessionDeletionCommand,
) (workspacedata.SourceSessionDeletionResult, error) {
	if s == nil || s.SourceSessionDeletions == nil {
		return workspacedata.SourceSessionDeletionResult{}, ErrServiceUnavailable
	}
	result, err := s.SourceSessionDeletions.ExecuteSourceSessionDeletion(ctx, command)
	if err != nil {
		return workspacedata.SourceSessionDeletionResult{}, err
	}
	for _, update := range result.WorkflowUpdates {
		if update.CheckpointChanged {
			s.publish(ctx, workflowUpdateFromSourceSessionDeletion(update, workflowbiz.ChangeKindCheckpointDecided))
		}
		if update.OperationChanged {
			s.publish(ctx, workflowUpdateFromSourceSessionDeletion(update, workflowbiz.ChangeKindOperationUpdated))
		}
		// Active workflow invariants normally guarantee a pending checkpoint or
		// operation. Keep snapshot invalidation complete if older durable data
		// lacks either child transition.
		if !update.CheckpointChanged && !update.OperationChanged {
			s.publish(ctx, workflowUpdateFromSourceSessionDeletion(update, workflowbiz.ChangeKindOperationUpdated))
		}
	}
	return result, nil
}

func (s *Service) sourceSessionDeletionCancellation() workspacedata.WorkspaceWorkflowCancellationCommand {
	return workspacedata.WorkspaceWorkflowCancellationCommand{
		AllowedWorkflowStatuses: []workflowbiz.WorkflowStatus{
			workflowbiz.WorkflowStatusPendingReview,
			workflowbiz.WorkflowStatusInProgress,
		},
		AllowedCheckpointStatuses: []workflowbiz.CheckpointStatus{
			workflowbiz.CheckpointStatusPending,
		},
		AllowedOperationStatuses: []workflowbiz.OperationStatus{
			workflowbiz.OperationStatusPending,
			workflowbiz.OperationStatusRunning,
		},
		WorkflowStatus:   workflowbiz.WorkflowStatusCanceled,
		CheckpointStatus: workflowbiz.CheckpointStatusCanceled,
		OperationStatus:  workflowbiz.OperationStatusCanceled,
		DecidedBy:        string(workflowbiz.WorkflowOwnerTutti),
		DecisionReason:   sourceSessionDeletedDecisionReason,
		ChangedAt:        s.now(),
	}
}

func workflowUpdateFromSourceSessionDeletion(
	update workspacedata.SourceSessionWorkflowUpdate,
	changeKind workflowbiz.ChangeKind,
) workflowbiz.Update {
	return workflowbiz.Update{
		WorkspaceID:     update.WorkspaceID,
		WorkflowID:      update.WorkflowID,
		SourceSessionID: update.SourceSessionID,
		CheckpointID:    update.CheckpointID,
		ChangeKind:      changeKind,
	}
}

func normalizeSourceSessionIDs(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
