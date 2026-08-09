package workspace

import (
	"context"
	"fmt"
	"strings"
	"time"
)

func (s *SQLiteStore) markIssueRunLaunchIntentDispatched(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runID string,
	leaseOwner string,
	now time.Time,
	missing error,
) error {
	if err := s.ensureIssueDatabase(); err != nil {
		return err
	}
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_issue_run_launch_intents
SET status = 'dispatched', lease_owner = '', lease_expires_at_unix_ms = 0,
    dispatched_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND run_id = ?
  AND status = 'leased' AND lease_owner = ?
`, unixMs(now), unixMs(now), strings.TrimSpace(workspaceID),
		strings.TrimSpace(issueID), strings.TrimSpace(runID), strings.TrimSpace(leaseOwner))
	if err != nil {
		return fmt.Errorf("mark Issue Run launch dispatched: %w", err)
	}
	return requireRowsAffected(result, missing, "mark Issue Run launch dispatched")
}

func (s *SQLiteStore) releaseIssueRunLaunchIntent(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runID string,
	leaseOwner string,
	now time.Time,
	missing error,
) error {
	if err := s.ensureIssueDatabase(); err != nil {
		return err
	}
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_issue_run_launch_intents
SET status = 'prepared', lease_owner = '', lease_expires_at_unix_ms = 0,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND run_id = ?
  AND status = 'leased' AND lease_owner = ?
`, unixMs(now), strings.TrimSpace(workspaceID), strings.TrimSpace(issueID),
		strings.TrimSpace(runID), strings.TrimSpace(leaseOwner))
	if err != nil {
		return fmt.Errorf("release Issue Run launch intent: %w", err)
	}
	return requireRowsAffected(result, missing, "release Issue Run launch intent")
}

func (s *SQLiteStore) renewIssueRunLaunchIntent(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runID string,
	leaseOwner string,
	now time.Time,
	leaseExpires time.Time,
	missing error,
) error {
	if err := s.ensureIssueDatabase(); err != nil {
		return err
	}
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_issue_run_launch_intents
SET lease_expires_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND run_id = ?
  AND status = 'leased' AND lease_owner = ?
`, unixMs(leaseExpires), unixMs(now), strings.TrimSpace(workspaceID),
		strings.TrimSpace(issueID), strings.TrimSpace(runID), strings.TrimSpace(leaseOwner))
	if err != nil {
		return fmt.Errorf("renew Issue Run launch intent: %w", err)
	}
	return requireRowsAffected(result, missing, "renew Issue Run launch intent")
}

func (s *SQLiteStore) requeueLeasedIssueRunLaunchIntents(
	ctx context.Context,
	workspaceID string,
	now time.Time,
) error {
	if err := s.ensureIssueDatabase(); err != nil {
		return err
	}
	_, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_issue_run_launch_intents
SET status = 'prepared', lease_owner = '', lease_expires_at_unix_ms = 0,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND status = 'leased'
  AND lease_expires_at_unix_ms <= ?
`, unixMs(now), strings.TrimSpace(workspaceID), unixMs(now))
	if err != nil {
		return fmt.Errorf("requeue leased Issue Run launch intents: %w", err)
	}
	return nil
}
