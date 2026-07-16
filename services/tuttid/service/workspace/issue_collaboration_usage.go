package workspace

import (
	"context"

	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

// RecordCollaborationRun attributes terminal collaboration usage to an Issue
// through durable session lineage. The store excludes delegate mirrors of an
// Issue Task Run and makes retries/adoption notifications idempotent by run ID.
func (s IssueManagerService) RecordCollaborationRun(ctx context.Context, run collabrunbiz.Run) error {
	store, ok := s.Store.(workspacedata.IssueCollaborationUsageStore)
	if !ok {
		return nil
	}
	link, found, err := store.ResolveIssueCollaborationUsageLink(ctx, run)
	if err != nil || !found || link.DuplicateTaskRun {
		return err
	}
	inserted, err := store.RecordIssueCollaborationUsage(ctx, link, run)
	if err != nil || !inserted {
		return err
	}
	s.refreshIssueCostEstimateBestEffort(ctx, run.WorkspaceID, link.IssueID)
	s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
		WorkspaceID: run.WorkspaceID,
		IssueID:     link.IssueID,
		TaskID:      link.TaskID,
		RunID:       run.ID,
		ChangeKind:  eventstreamservice.WorkspaceIssueChangeIssueUpdated,
	})
	return nil
}
