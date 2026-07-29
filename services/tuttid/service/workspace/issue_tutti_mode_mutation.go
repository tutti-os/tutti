package workspace

import (
	"context"
	"strings"

	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

// MutateTuttiModeIssue is the source-Agent-only graph mutation adapter. It
// shares the Issue mutation lock with schedule and settlement so the durable
// revision fence remains authoritative across all writers.
func (s IssueManagerService) MutateTuttiModeIssue(
	ctx context.Context,
	workspaceID string,
	input MutateTuttiModeIssueInput,
) (executionbiz.MutationResult, error) {
	if s.TuttiModeExecutions == nil {
		return executionbiz.MutationResult{}, tuttimodeexecutionservice.ErrServiceUnavailable
	}
	workspaceID = strings.TrimSpace(workspaceID)
	input.IssueID = strings.TrimSpace(input.IssueID)
	if workspaceID == "" || input.IssueID == "" {
		return executionbiz.MutationResult{}, executionbiz.ErrMutationRejected
	}
	unlock := s.MutationLocks.Lock(workspaceID, input.IssueID)
	defer unlock()
	result, err := s.TuttiModeExecutions.Mutate(ctx, tuttimodeexecutionservice.MutateInput{
		WorkspaceID: workspaceID, IssueID: input.IssueID,
		SourceSessionID: input.SourceSessionID, CheckpointID: input.CheckpointID,
		ExpectedGraphRevision: input.ExpectedGraphRevision,
		Operations:            input.Operations, RequestID: input.RequestID,
	})
	if err != nil {
		return executionbiz.MutationResult{}, err
	}
	if !result.Replayed {
		s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
			WorkspaceID: workspaceID, IssueID: input.IssueID,
			ChangeKind: eventstreamservice.WorkspaceIssueChangeIssueUpdated,
		})
	}
	return result, nil
}
