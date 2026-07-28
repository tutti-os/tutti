package tuttimodeexecution

import (
	"context"
	"fmt"
	"strings"

	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

type ArchiveInput struct {
	WorkspaceID string
	IssueID     string
	RequestID   string
	RequestedBy string
	Reason      string
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
	if input.WorkspaceID == "" || input.IssueID == "" || input.RequestID == "" ||
		input.RequestedBy == "" || input.Reason == "" {
		return executionbiz.ArchiveOperation{}, executionbiz.ErrInvalidExecution
	}
	operation, _, err := service.Archives.RequestTuttiModeArchive(ctx, executionbiz.ArchiveRequest{
		WorkspaceID: input.WorkspaceID, IssueID: input.IssueID,
		RequestID: input.RequestID, RequestedBy: input.RequestedBy,
		Reason: input.Reason, Now: service.now(),
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
	if _, err := service.ArchiveRuns.CancelTuttiModeIssueExecution(
		ctx, operation.WorkspaceID, operation.IssueID,
	); err != nil {
		failed, persistErr := service.Archives.FailTuttiModeArchive(
			ctx, operation.WorkspaceID, operation.OperationID, err.Error(), service.now(),
		)
		if persistErr != nil {
			return operation, fmt.Errorf("persist archive cancellation failure: %w", persistErr)
		}
		return failed, fmt.Errorf("cancel exact archive Runs: %w", err)
	}
	current, _, err := service.Archives.CompleteTuttiModeArchiveIfSettled(
		ctx, operation.WorkspaceID, operation.OperationID, service.now(),
	)
	return current, err
}
