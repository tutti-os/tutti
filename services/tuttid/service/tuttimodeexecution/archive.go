package tuttimodeexecution

import (
	"context"
	"errors"
	"fmt"
	"strings"

	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

type ArchiveInput struct {
	WorkspaceID           string
	IssueID               string
	RequestID             string
	RequestedBy           string
	Reason                string
	SourceSessionID       string
	CheckpointID          string
	ExpectedGraphRevision int64
}

type StopSourceSessionInput struct {
	WorkspaceID     string
	SourceSessionID string
	RequestID       string
	Reason          string
}

func (service Service) Archive(
	ctx context.Context,
	input ArchiveInput,
) (executionbiz.ArchiveOperation, error) {
	if service.Archives == nil || service.ArchiveRuns == nil {
		return executionbiz.ArchiveOperation{}, ErrServiceUnavailable
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.IssueID = strings.TrimSpace(input.IssueID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	input.RequestedBy = strings.TrimSpace(input.RequestedBy)
	input.Reason = strings.TrimSpace(input.Reason)
	input.SourceSessionID = strings.TrimSpace(input.SourceSessionID)
	input.CheckpointID = strings.TrimSpace(input.CheckpointID)
	sourceScoped := input.SourceSessionID != "" || input.CheckpointID != "" ||
		input.ExpectedGraphRevision != 0
	if sourceScoped {
		if input.SourceSessionID == "" || input.CheckpointID == "" ||
			input.ExpectedGraphRevision < 1 {
			return executionbiz.ArchiveOperation{}, executionbiz.ErrInvalidExecution
		}
		input.RequestedBy = input.SourceSessionID
	}
	if input.WorkspaceID == "" || input.IssueID == "" || input.RequestID == "" ||
		input.RequestedBy == "" || input.Reason == "" {
		return executionbiz.ArchiveOperation{}, executionbiz.ErrInvalidExecution
	}
	operation, _, err := service.Archives.RequestTuttiModeArchive(ctx, executionbiz.ArchiveRequest{
		WorkspaceID: input.WorkspaceID, IssueID: input.IssueID,
		RequestID: input.RequestID, RequestedBy: input.RequestedBy,
		Reason: input.Reason, SourceSessionID: input.SourceSessionID,
		CheckpointID:          input.CheckpointID,
		ExpectedGraphRevision: input.ExpectedGraphRevision, Now: service.now(),
	})
	if err != nil || operation.Status == executionbiz.ArchiveStatusCompleted {
		return operation, err
	}
	current, reconcileErr := service.reconcileArchive(ctx, operation)
	if current.Status != executionbiz.ArchiveStatusCompleted && service.ArchiveRecoveryQueue != nil {
		service.ArchiveRecoveryQueue.Enqueue(current.WorkspaceID)
	}
	return current, reconcileErr
}

func (service Service) StopSourceSession(
	ctx context.Context,
	input StopSourceSessionInput,
) (int, error) {
	if service.Archives == nil || service.ArchiveRuns == nil {
		return 0, ErrServiceUnavailable
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.SourceSessionID = strings.TrimSpace(input.SourceSessionID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	input.Reason = strings.TrimSpace(input.Reason)
	if input.WorkspaceID == "" || input.SourceSessionID == "" {
		return 0, executionbiz.ErrInvalidExecution
	}
	if input.RequestID == "" {
		input.RequestID = "source-session-stop"
	}
	if input.Reason == "" {
		input.Reason = "source_turn_canceled"
	}
	operations, err := service.Archives.RequestTuttiModeArchivesForSourceSession(
		ctx,
		executionbiz.SourceSessionArchiveRequest{
			WorkspaceID: input.WorkspaceID, SourceSessionID: input.SourceSessionID,
			RequestID: input.RequestID, RequestedBy: input.SourceSessionID,
			Reason: input.Reason, Now: service.now(),
		},
	)
	if err != nil {
		return 0, err
	}
	var reconcileErrors []error
	for _, operation := range operations {
		current, reconcileErr := service.reconcileArchive(ctx, operation)
		if reconcileErr != nil {
			reconcileErrors = append(reconcileErrors, reconcileErr)
		}
		if current.Status != executionbiz.ArchiveStatusCompleted &&
			service.ArchiveRecoveryQueue != nil {
			service.ArchiveRecoveryQueue.Enqueue(current.WorkspaceID)
		}
	}
	return len(operations), errors.Join(reconcileErrors...)
}

func (service Service) GetArchive(
	ctx context.Context, workspaceID, operationID string,
) (executionbiz.ArchiveOperation, error) {
	if service.Archives == nil {
		return executionbiz.ArchiveOperation{}, ErrServiceUnavailable
	}
	return service.Archives.GetTuttiModeArchiveOperation(
		ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(operationID),
	)
}

func (service Service) RecoverArchives(ctx context.Context, workspaceID string) error {
	_, err := service.RecoverArchivesAndCount(ctx, workspaceID)
	return err
}

func (service Service) RecoverArchivesAndCount(ctx context.Context, workspaceID string) (int, error) {
	if service.Archives == nil || service.ArchiveRuns == nil {
		return 0, ErrServiceUnavailable
	}
	workspaceID = strings.TrimSpace(workspaceID)
	operations, err := service.Archives.ListRecoverableTuttiModeArchives(
		ctx, workspaceID,
	)
	if err != nil {
		return 0, err
	}
	for _, operation := range operations {
		if _, err := service.reconcileArchive(ctx, operation); err != nil {
			// A cancellation failure is already durable and fail-closed. Keep
			// recovering unrelated archives; the next pass retries this one.
			continue
		}
	}
	remaining, err := service.Archives.ListRecoverableTuttiModeArchives(ctx, workspaceID)
	return len(remaining), err
}

func (service Service) reconcileArchive(
	ctx context.Context, operation executionbiz.ArchiveOperation,
) (executionbiz.ArchiveOperation, error) {
	_, runErr := service.ArchiveRuns.CancelTuttiModeIssueExecution(
		ctx, operation.WorkspaceID, operation.IssueID,
	)
	automationErr := service.cancelArchivedAutomationTurns(ctx, operation)
	if err := errors.Join(runErr, automationErr); err != nil {
		failed, persistErr := service.Archives.FailTuttiModeArchive(
			ctx, operation.WorkspaceID, operation.OperationID, err.Error(), service.now(),
		)
		if persistErr != nil {
			return operation, fmt.Errorf("persist archive cancellation failure: %w", persistErr)
		}
		return failed, fmt.Errorf("cancel archived execution activity: %w", err)
	}
	current, _, err := service.Archives.CompleteTuttiModeArchiveIfSettled(
		ctx, operation.WorkspaceID, operation.OperationID, service.now(),
	)
	return current, err
}

func (service Service) cancelArchivedAutomationTurns(
	ctx context.Context,
	operation executionbiz.ArchiveOperation,
) error {
	if service.ArchiveAutomationTurns == nil {
		return nil
	}
	var cancelErrors []error
	seen := make(map[string]struct{})
	cancel := func(sessionID, turnID string) {
		sessionID = strings.TrimSpace(sessionID)
		turnID = strings.TrimSpace(turnID)
		if sessionID == "" || turnID == "" {
			return
		}
		key := sessionID + "\x00" + turnID
		if _, found := seen[key]; found {
			return
		}
		seen[key] = struct{}{}
		if err := service.cancelAutomationTurn(
			ctx, operation.WorkspaceID, sessionID, turnID,
		); err != nil {
			cancelErrors = append(cancelErrors, fmt.Errorf(
				"cancel automation Turn %s/%s: %w", sessionID, turnID, err,
			))
		}
	}
	if wakeStore := service.wakeStore(); wakeStore != nil {
		wakes, err := wakeStore.ListTuttiModeExecutionWakes(
			ctx, operation.WorkspaceID, operation.IssueID,
		)
		if err != nil {
			cancelErrors = append(cancelErrors, fmt.Errorf("list archived main wakes: %w", err))
		} else {
			for _, wake := range wakes {
				sessionID := wake.CanonicalSessionID
				turnID := wake.CanonicalTurnID
				if turnID == "" && service.MainWakeTargets != nil {
					observation, found, readErr := service.MainWakeTargets.ReadMainWakeTurn(
						ctx, wake.WorkspaceID, wake.TargetSessionID, wake.ClientSubmitID,
					)
					if readErr != nil {
						cancelErrors = append(cancelErrors, fmt.Errorf(
							"resolve archived main wake %s: %w", wake.ID, readErr,
						))
						continue
					}
					if found {
						sessionID = wake.TargetSessionID
						turnID = observation.CanonicalTurnID
					}
				}
				cancel(sessionID, turnID)
			}
		}
	}
	if reviewStore := service.reviewStore(); reviewStore != nil {
		reviews, err := reviewStore.ListTuttiModeGoalReviews(
			ctx, operation.WorkspaceID, operation.IssueID,
		)
		if err != nil {
			cancelErrors = append(cancelErrors, fmt.Errorf("list archived reviewers: %w", err))
		} else {
			for _, review := range reviews {
				sessionID := review.SessionID
				turnID := review.TurnID
				if turnID == "" && service.ReviewerTargets != nil {
					delivery, found, readErr := service.ReviewerTargets.ReadReviewer(
						ctx,
						ReviewerLaunch{
							WorkspaceID: review.WorkspaceID, IssueID: review.IssueID,
							AgentTargetID: review.AgentTargetID, SessionID: review.SessionID,
							ClientSubmitID: review.ClientSubmitID,
						},
					)
					if readErr != nil {
						cancelErrors = append(cancelErrors, fmt.Errorf(
							"resolve archived reviewer %s: %w", review.ID, readErr,
						))
						continue
					}
					if found {
						sessionID = delivery.CanonicalSessionID
						turnID = delivery.CanonicalTurnID
					}
				}
				cancel(sessionID, turnID)
			}
		}
	}
	return errors.Join(cancelErrors...)
}

func (service Service) cancelAutomationTurn(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	turnID string,
) error {
	if service.ArchiveAutomationTurns == nil ||
		strings.TrimSpace(sessionID) == "" || strings.TrimSpace(turnID) == "" {
		return nil
	}
	return service.ArchiveAutomationTurns.CancelAutomationTurn(
		context.WithoutCancel(ctx),
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(sessionID),
		strings.TrimSpace(turnID),
	)
}
