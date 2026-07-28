package workspace

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

const issueRunCancelCompensationTimeout = 10 * time.Second

var errIssueRunCancelCompensationRetryable = errors.New(
	"issue Run cancel compensation is retryable",
)

func durableIssueRunCleanupContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(
		context.WithoutCancel(ctx),
		issueRunCancelCompensationTimeout,
	)
}

func (s IssueManagerService) prepareAndRecoverTuttiModeRunCancelCompensation(
	ctx context.Context,
	launch IssueRunLaunch,
) bool {
	if s.TuttiModeExecutions == nil {
		return false
	}
	cleanupCtx, cancel := durableIssueRunCleanupContext(ctx)
	defer cancel()
	found, err := s.TuttiModeExecutions.EnsureRunCancelCompensation(
		cleanupCtx,
		launch.WorkspaceID,
		launch.IssueID,
		launch.TaskID,
		launch.RunID,
	)
	if err != nil {
		s.enqueueWorkspaceRunReconcile(launch.WorkspaceID)
		return true
	}
	if !found {
		return false
	}
	if err := s.RecoverTuttiModeRunCancelCompensations(
		cleanupCtx, launch.WorkspaceID,
	); err != nil {
		s.enqueueWorkspaceRunReconcile(launch.WorkspaceID)
	}
	return true
}

func (s IssueManagerService) RecoverTuttiModeRunCancelCompensations(
	ctx context.Context,
	workspaceID string,
) error {
	if s.TuttiModeExecutions == nil {
		return nil
	}
	if err := s.TuttiModeExecutions.RequeueLeasedRunCancelCompensations(
		ctx, workspaceID,
	); err != nil {
		return err
	}
	items, err := s.TuttiModeExecutions.ListPreparedRunCancelCompensations(
		ctx, workspaceID,
	)
	if err != nil {
		return err
	}
	var recoveryErrors []error
	retryNeeded := false
	for _, item := range items {
		if err := s.recoverTuttiModeRunCancelCompensation(ctx, item); err != nil {
			if errors.Is(err, errIssueRunCancelCompensationRetryable) {
				retryNeeded = true
				continue
			}
			recoveryErrors = append(recoveryErrors, err)
		}
	}
	if retryNeeded {
		s.enqueueWorkspaceRunReconcile(workspaceID)
	}
	return errors.Join(recoveryErrors...)
}

func (s IssueManagerService) recoverTuttiModeRunCancelCompensation(
	ctx context.Context,
	item executionbiz.RunCancelCompensation,
) error {
	operationCtx, cancelOperation := durableIssueRunCleanupContext(ctx)
	defer cancelOperation()
	leaseOwner := uuid.NewString()
	claimed, err := s.TuttiModeExecutions.ClaimRunCancelCompensation(
		operationCtx, item, leaseOwner, tuttiModeRunLaunchLease,
	)
	if err != nil || !claimed {
		return err
	}
	release := func(message string) error {
		recoveryCtx, cancel := durableIssueRunCleanupContext(ctx)
		defer cancel()
		return s.TuttiModeExecutions.ReleaseRunCancelCompensation(
			recoveryCtx, item, leaseOwner, message,
		)
	}
	if s.RunCancellationRequester == nil {
		err := errors.New("issue Run cancellation requester is unavailable")
		if releaseErr := release(err.Error()); releaseErr != nil {
			return errors.Join(err, releaseErr)
		}
		return fmt.Errorf("%w: %v", errIssueRunCancelCompensationRetryable, err)
	}
	result, err := s.RunCancellationRequester.RequestRunCancellation(
		operationCtx,
		IssueRunCancellationRequest{
			WorkspaceID:    item.WorkspaceID,
			AgentSessionID: item.AgentSessionID,
			RunID:          item.RunID,
			ClientSubmitID: item.ClientSubmitID,
		},
	)
	if err != nil {
		if releaseErr := release(err.Error()); releaseErr != nil {
			return errors.Join(err, releaseErr)
		}
		return fmt.Errorf("%w: %v", errIssueRunCancelCompensationRetryable, err)
	}
	switch result.State {
	case IssueRunCancelAccepted, IssueRunCancelCanceled, IssueRunCancelSettled:
		// Exact cancellation was accepted or the exact Turn is already
		// terminal; either outcome closes the compensation operation.
	case IssueRunCancelNotFound:
		err := fmt.Errorf(
			"exact Issue Run Turn %q was not found",
			strings.TrimSpace(item.ClientSubmitID),
		)
		if releaseErr := release(err.Error()); releaseErr != nil {
			return errors.Join(err, releaseErr)
		}
		return fmt.Errorf("%w: %v", errIssueRunCancelCompensationRetryable, err)
	default:
		err := fmt.Errorf("unsupported Issue Run cancellation result %q", result.State)
		if releaseErr := release(err.Error()); releaseErr != nil {
			return errors.Join(err, releaseErr)
		}
		return fmt.Errorf("%w: %v", errIssueRunCancelCompensationRetryable, err)
	}
	recoveryCtx, cancel := durableIssueRunCleanupContext(ctx)
	defer cancel()
	return s.TuttiModeExecutions.CompleteRunCancelCompensation(
		recoveryCtx, item, leaseOwner,
	)
}
