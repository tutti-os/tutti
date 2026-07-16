package workspace

import (
	"context"
	"testing"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestSQLiteIssueCollaborationUsageAttributesAllTokenCategoriesOnce(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-collab-usage", Name: "Collaboration usage"}); err != nil {
		t.Fatalf("Create(workspace) error = %v", err)
	}
	service := testIssueService(store)
	tokenLimit := workspaceissues.CompileEstimatedRunTokenBudget(workspaceissues.DefaultExecutionProfile()) + 50
	issue, err := service.CreateIssue(ctx, workspaceissues.CreateIssueInput{
		WorkspaceID:     "ws-collab-usage",
		TopicID:         workspaceissues.DefaultTopicID,
		ActorUserID:     "user-1",
		Title:           "Account for reviews",
		SourceSessionID: "planning-session",
		Budget: workspaceissues.Budget{
			Mode:                  workspaceissues.BudgetModeFixed,
			TokenLimit:            tokenLimit,
			QuotaWaterlinePercent: 10,
			Status:                workspaceissues.BudgetStatusActive,
		},
		HasBudget: true,
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	task, err := service.CreateTask(ctx, workspaceissues.CreateTaskInput{
		WorkspaceID: "ws-collab-usage",
		IssueID:     issue.IssueID,
		ActorUserID: "user-1",
		Title:       "Implementation",
	})
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}
	issueRun, err := service.CreateRun(ctx, workspaceissues.CreateRunInput{
		WorkspaceID:    "ws-collab-usage",
		IssueID:        issue.IssueID,
		TaskID:         task.TaskID,
		ActorUserID:    "user-1",
		AgentTargetID:  "local:codex",
		AgentSessionID: "task-session",
	})
	if err != nil {
		t.Fatalf("CreateRun() error = %v", err)
	}

	duplicate := collabrunbiz.Run{
		ID:              "collab-delegate-mirror",
		WorkspaceID:     "ws-collab-usage",
		SourceSessionID: "planning-session",
		TargetSessionID: issueRun.AgentSessionID,
	}
	link, found, err := store.ResolveIssueCollaborationUsageLink(ctx, duplicate)
	if err != nil || !found || !link.DuplicateTaskRun {
		t.Fatalf("duplicate link = %#v, found=%v, error=%v", link, found, err)
	}
	if inserted, err := store.RecordIssueCollaborationUsage(ctx, link, duplicate); err != nil || inserted {
		t.Fatalf("RecordIssueCollaborationUsage(duplicate) inserted=%v error=%v", inserted, err)
	}

	now := time.UnixMilli(1_700_000_001_000).UTC()
	review := collabrunbiz.Run{
		ID:              "collab-review",
		WorkspaceID:     "ws-collab-usage",
		SourceSessionID: issueRun.AgentSessionID,
		Status:          collabrunbiz.StatusCompleted,
		Usage: collabrunbiz.Usage{
			InputTokens:      tokenLimit - 60,
			OutputTokens:     20,
			CacheReadTokens:  30,
			CacheWriteTokens: 10,
		},
		Cost:      collabrunbiz.Cost{Currency: "USD", EstimatedMicros: 1_234},
		CreatedAt: now,
		UpdatedAt: now,
	}
	link, found, err = store.ResolveIssueCollaborationUsageLink(ctx, review)
	if err != nil || !found || link.IssueID != issue.IssueID || link.TaskID != task.TaskID || link.DuplicateTaskRun {
		t.Fatalf("review link = %#v, found=%v, error=%v", link, found, err)
	}
	inserted, err := store.RecordIssueCollaborationUsage(ctx, link, review)
	if err != nil || !inserted {
		t.Fatalf("RecordIssueCollaborationUsage() inserted=%v error=%v", inserted, err)
	}
	inserted, err = store.RecordIssueCollaborationUsage(ctx, link, review)
	if err != nil || inserted {
		t.Fatalf("RecordIssueCollaborationUsage(replay) inserted=%v error=%v", inserted, err)
	}

	updated, err := store.GetIssue(ctx, "ws-collab-usage", issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssue() error = %v", err)
	}
	if updated.Budget.ConsumedTokens != tokenLimit || updated.Budget.Status != workspaceissues.BudgetStatusSoftLimited {
		t.Fatalf("updated budget = %#v", updated.Budget)
	}
	if updated.Cost.Currency != "USD" || updated.Cost.EstimatedMicros != 1_234 {
		t.Fatalf("updated cost = %#v", updated.Cost)
	}
	totals, err := store.GetIssueCollaborationUsageTotals(ctx, "ws-collab-usage", issue.IssueID, "USD")
	if err != nil {
		t.Fatalf("GetIssueCollaborationUsageTotals() error = %v", err)
	}
	if totals.Usage != review.Usage || totals.Cost.EstimatedMicros != 1_234 {
		t.Fatalf("totals = %#v", totals)
	}
}

func TestSQLiteIssueCollaborationUsageResolvesPlanningAndDescendantSessions(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-collab-lineage", Name: "Collaboration lineage"}); err != nil {
		t.Fatalf("Create(workspace) error = %v", err)
	}
	service := testIssueService(store)
	issue, err := service.CreateIssue(ctx, workspaceissues.CreateIssueInput{
		WorkspaceID:     "ws-collab-lineage",
		TopicID:         workspaceissues.DefaultTopicID,
		ActorUserID:     "user-1",
		Title:           "Plan lineage",
		SourceSessionID: "planning-session",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}

	before := collabrunbiz.Run{
		ID:              "collab-before-issue",
		WorkspaceID:     "ws-collab-lineage",
		SourceSessionID: "planning-session",
		CreatedAt:       time.UnixMilli(issue.CreatedAtUnixMS - 1).UTC(),
	}
	if link, found, err := store.ResolveIssueCollaborationUsageLink(ctx, before); err != nil || found {
		t.Fatalf("pre-Issue link = %#v, found=%v, error=%v", link, found, err)
	}

	first := collabrunbiz.Run{
		ID:              "collab-plan-child",
		WorkspaceID:     "ws-collab-lineage",
		SourceSessionID: "planning-session",
		TargetSessionID: "child-session",
		Status:          collabrunbiz.StatusCompleted,
		Usage:           collabrunbiz.Usage{InputTokens: 5},
		CreatedAt:       time.UnixMilli(issue.CreatedAtUnixMS + 1).UTC(),
		UpdatedAt:       time.UnixMilli(issue.CreatedAtUnixMS + 2).UTC(),
	}
	link, found, err := store.ResolveIssueCollaborationUsageLink(ctx, first)
	if err != nil || !found || link.IssueID != issue.IssueID || link.TaskID != "" {
		t.Fatalf("planning link = %#v, found=%v, error=%v", link, found, err)
	}
	if inserted, err := store.RecordIssueCollaborationUsage(ctx, link, first); err != nil || !inserted {
		t.Fatalf("RecordIssueCollaborationUsage(first) inserted=%v error=%v", inserted, err)
	}

	descendant := collabrunbiz.Run{
		ID:              "collab-descendant",
		WorkspaceID:     "ws-collab-lineage",
		SourceSessionID: first.TargetSessionID,
		Status:          collabrunbiz.StatusCompleted,
		Usage:           collabrunbiz.Usage{OutputTokens: 7},
		CreatedAt:       time.UnixMilli(issue.CreatedAtUnixMS + 3).UTC(),
		UpdatedAt:       time.UnixMilli(issue.CreatedAtUnixMS + 4).UTC(),
	}
	link, found, err = store.ResolveIssueCollaborationUsageLink(ctx, descendant)
	if err != nil || !found || link.IssueID != issue.IssueID {
		t.Fatalf("descendant link = %#v, found=%v, error=%v", link, found, err)
	}
}
