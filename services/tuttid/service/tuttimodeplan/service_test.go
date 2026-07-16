package tuttimodeplan

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

func TestServiceProposePersistsConfigurationRevisionAndReviewCheckpoint(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	service := newTestService(t, store, now, "workflow-1", "revision-1", "checkpoint-1")

	result, err := service.Propose(context.Background(), ProposeInput{
		WorkspaceID:      " workspace-1 ",
		SourceSessionID:  " session-1 ",
		SourceTurnID:     " turn-1 ",
		SourceToolCallID: " tool-1 ",
		RequestID:        " request-1 ",
		Markdown:         configurationMarkdown("Initial proposal"),
	})
	if err != nil {
		t.Fatalf("Propose() error = %v", err)
	}

	workflow := result.Snapshot.Workflow
	if workflow.ID != "workflow-1" || workflow.WorkspaceID != "workspace-1" || workflow.Status != workflowbiz.WorkflowStatusPendingReview {
		t.Fatalf("workflow = %#v", workflow)
	}
	if workflow.SourceSessionID != "session-1" || workflow.SourceTurnID != "turn-1" || workflow.SourceToolCallID != "tool-1" {
		t.Fatalf("workflow provenance = %#v", workflow)
	}
	if len(result.Snapshot.Revisions) != 1 || result.Snapshot.Revisions[0].Sequence != 1 || result.Snapshot.Revisions[0].ProducedByTurnID != "turn-1" {
		t.Fatalf("revisions = %#v", result.Snapshot.Revisions)
	}
	if len(result.Snapshot.Checkpoints) != 1 || result.Snapshot.Checkpoints[0].Kind != workflowbiz.CheckpointKindConfigurationReview || result.Snapshot.Checkpoints[0].Status != workflowbiz.CheckpointStatusPending {
		t.Fatalf("checkpoints = %#v", result.Snapshot.Checkpoints)
	}
	if len(result.Snapshot.TurnLinks) != 1 || result.Snapshot.TurnLinks[0].Relation != workflowbiz.TurnRelationSource {
		t.Fatalf("turn links = %#v", result.Snapshot.TurnLinks)
	}
	if result.Document.Phase != PhaseConfiguration || result.Document.Title != "Initial proposal" {
		t.Fatalf("document = %#v", result.Document)
	}
	if result.Snapshot.Revisions[0].DocumentPath == "" || result.Snapshot.Revisions[0].SHA256 == "" {
		t.Fatalf("stored revision metadata = %#v", result.Snapshot.Revisions[0])
	}
	if !result.Snapshot.Workflow.CreatedAt.Equal(now) || !result.Snapshot.Checkpoints[0].CreatedAt.Equal(now) {
		t.Fatalf("timestamps do not use service clock: %#v", result.Snapshot)
	}
}

func TestServiceProposeRejectsTaskGraphAsInitialRevision(t *testing.T) {
	t.Parallel()

	store := newMemoryWorkflowStore()
	service := newTestService(t, store, time.Now().UTC(), "workflow-1", "revision-1", "checkpoint-1")
	_, err := service.Propose(context.Background(), ProposeInput{
		WorkspaceID:     "workspace-1",
		SourceSessionID: "session-1",
		SourceTurnID:    "turn-1",
		RequestID:       "request-1",
		Markdown:        taskGraphMarkdown("Premature graph"),
	})
	if !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("Propose() error = %v, want ErrInvalidTransition", err)
	}
	if len(store.snapshots) != 0 {
		t.Fatalf("proposal persisted after invalid transition: %#v", store.snapshots)
	}
}

func TestServiceProposeAllowsSessionOnlyProvenanceBeforeTurnIsObservable(t *testing.T) {
	t.Parallel()
	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	service := newTestService(t, store, now, "workflow-1", "revision-1", "checkpoint-1")

	result, err := service.Propose(context.Background(), ProposeInput{
		WorkspaceID:     "workspace-1",
		SourceSessionID: "session-1",
		RequestID:       "request-1",
		Markdown:        configurationMarkdown("Session provenance"),
	})
	if err != nil {
		t.Fatalf("Propose() error = %v", err)
	}
	if result.Snapshot.Workflow.SourceTurnID != "" || len(result.Snapshot.TurnLinks) != 0 {
		t.Fatalf("session-only provenance = %#v", result.Snapshot)
	}
}

func TestServicePublishesDurableWorkflowInvalidationAfterProposalCommit(t *testing.T) {
	t.Parallel()
	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	publisher := &recordingWorkflowPublisher{}
	service := newTestService(t, store, now, "workflow-1", "revision-1", "checkpoint-1")
	service.Publisher = publisher

	if _, err := service.Propose(context.Background(), ProposeInput{
		WorkspaceID:     "workspace-1",
		SourceSessionID: "session-1",
		RequestID:       "request-1",
		Markdown:        configurationMarkdown("Event proposal"),
	}); err != nil {
		t.Fatalf("Propose() error = %v", err)
	}
	if len(publisher.updates) != 1 || publisher.updates[0].ChangeKind != workflowbiz.ChangeKindProposalCreated || publisher.updates[0].WorkflowID != "workflow-1" || publisher.updates[0].CheckpointID != "checkpoint-1" {
		t.Fatalf("updates = %#v", publisher.updates)
	}
}

func TestServiceProposeMutationReplayIsIdempotentWithoutMakingContentIdentity(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	service := newTestService(t, store, now,
		"workflow-1", "revision-1", "checkpoint-1",
		"workflow-2", "revision-2", "checkpoint-2",
	)
	input := ProposeInput{
		WorkspaceID:     "workspace-1",
		SourceSessionID: "session-1",
		RequestID:       "proposal-request-1",
		Markdown:        configurationMarkdown("Replay-safe proposal"),
	}

	first, err := service.Propose(context.Background(), input)
	if err != nil {
		t.Fatalf("first Propose() error = %v", err)
	}
	replayed, err := service.Propose(context.Background(), input)
	if err != nil {
		t.Fatalf("replayed Propose() error = %v", err)
	}
	if replayed.RequestID != input.RequestID || !replayed.Replayed || replayed.Snapshot.Workflow.ID != first.Snapshot.Workflow.ID {
		t.Fatalf("replayed proposal = %#v, first = %#v", replayed, first)
	}
	if len(store.snapshots) != 1 {
		t.Fatalf("replayed proposal created %d workflows, want 1", len(store.snapshots))
	}

	conflict := input
	conflict.Markdown = configurationMarkdown("Different content under the same request")
	if _, err := service.Propose(context.Background(), conflict); !errors.Is(err, ErrMutationConflict) {
		t.Fatalf("conflicting Propose() error = %v, want ErrMutationConflict", err)
	}

	intentional := input
	intentional.RequestID = "proposal-request-2"
	second, err := service.Propose(context.Background(), intentional)
	if err != nil {
		t.Fatalf("intentional reapply Propose() error = %v", err)
	}
	if second.Replayed || second.Snapshot.Workflow.ID == first.Snapshot.Workflow.ID || len(store.snapshots) != 2 {
		t.Fatalf("intentional reapply = %#v, workflows = %d", second, len(store.snapshots))
	}
}

func TestServiceGetViewLoadsVerifiedRevisionDocumentsForRecovery(t *testing.T) {
	t.Parallel()
	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	service := newTestService(t, store, now, "workflow-1", "revision-1", "checkpoint-1")
	if _, err := service.Propose(context.Background(), ProposeInput{
		WorkspaceID:     "workspace-1",
		SourceSessionID: "session-1",
		RequestID:       "request-1",
		Markdown:        configurationMarkdown("Recovered proposal"),
	}); err != nil {
		t.Fatalf("Propose() error = %v", err)
	}

	view, err := service.GetView(context.Background(), GetInput{WorkspaceID: "workspace-1", WorkflowID: "workflow-1"})
	if err != nil {
		t.Fatalf("GetView() error = %v", err)
	}
	if len(view.Revisions) != 1 || view.Revisions[0].Document.Title != "Recovered proposal" {
		t.Fatalf("GetView() = %#v", view)
	}

	pending, err := service.ListPendingBySourceSession(context.Background(), "workspace-1", "session-1")
	if err != nil {
		t.Fatalf("ListPendingBySourceSession() error = %v", err)
	}
	if len(pending) != 1 || pending[0].Workflow.ID != "workflow-1" || pending[0].Revisions[0].Document.Title != "Recovered proposal" {
		t.Fatalf("pending views = %#v", pending)
	}
}

func TestServiceAgentWorkflowAccessIsScopedToSourceSession(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	service := newTestService(t, store, now, "workflow-1", "revision-1", "checkpoint-1", "revision-2", "checkpoint-2")
	if _, err := service.Propose(context.Background(), ProposeInput{
		WorkspaceID:     "workspace-1",
		SourceSessionID: "session-1",
		RequestID:       "request-1",
		Markdown:        configurationMarkdown("Scoped proposal"),
	}); err != nil {
		t.Fatalf("Propose() error = %v", err)
	}

	if _, err := service.GetViewForAgent(context.Background(), AgentGetInput{
		WorkspaceID: "workspace-1", WorkflowID: "workflow-1", AgentSessionID: "session-1",
	}); err != nil {
		t.Fatalf("GetViewForAgent(owner) error = %v", err)
	}
	if _, err := service.GetViewForAgent(context.Background(), AgentGetInput{
		WorkspaceID: "workspace-1", WorkflowID: "workflow-1", AgentSessionID: "session-2",
	}); !errors.Is(err, workspacedata.ErrWorkspaceWorkflowNotFound) {
		t.Fatalf("GetViewForAgent(other session) error = %v, want not found", err)
	}
	if _, err := service.ReviseFromAgent(context.Background(), AgentReviseInput{
		WorkspaceID: "workspace-1", WorkflowID: "workflow-1", AgentSessionID: "session-2", RequestID: "request-2",
		Markdown: configurationMarkdown("Unauthorized revision"),
	}); !errors.Is(err, workspacedata.ErrWorkspaceWorkflowNotFound) {
		t.Fatalf("ReviseFromAgent(other session) error = %v, want not found", err)
	}
	if _, err := service.WaitForAgent(context.Background(), AgentWaitInput{
		WorkspaceID: "workspace-1", WorkflowID: "workflow-1", CheckpointID: "checkpoint-1", AgentSessionID: "session-2",
	}); !errors.Is(err, workspacedata.ErrWorkspaceWorkflowNotFound) {
		t.Fatalf("WaitForAgent(other session) error = %v, want not found", err)
	}
	snapshot := store.snapshots[workflowStoreKey("workspace-1", "workflow-1")]
	if len(snapshot.Revisions) != 1 || len(snapshot.Checkpoints) != 1 {
		t.Fatalf("unauthorized access mutated workflow: %#v", snapshot)
	}
}

func TestProjectActionableItemsOnlyExposesAcceptedCurrentTaskGraph(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	view := SnapshotView{
		Workflow: workflowSnapshotFixture(
			workflowbiz.CheckpointKindTaskReview,
			workflowbiz.CheckpointStatusAccepted,
			workflowbiz.WorkflowStatusAccepted,
			now,
		).Workflow,
		Revisions: []RevisionView{{
			Revision: workflowbiz.PlanRevision{
				ID:         "revision-1",
				WorkflowID: "workflow-1",
				Sequence:   1,
				CreatedAt:  now,
			},
			Document: PlanDocument{
				Schema:  SchemaV1,
				Phase:   PhaseTaskGraph,
				Title:   "Task graph",
				TopicID: "topic-1",
				Tasks: []PlanTask{{
					ID:        "task-1",
					Title:     "Implement",
					Content:   "Ship the workflow",
					Priority:  "high",
					DependsOn: []string{"task-0"},
				}},
			},
		}},
		Checkpoints: []workflowbiz.WorkflowCheckpoint{{
			ID:         "checkpoint-1",
			WorkflowID: "workflow-1",
			RevisionID: "revision-1",
			Kind:       workflowbiz.CheckpointKindTaskReview,
			Status:     workflowbiz.CheckpointStatusAccepted,
		}},
	}

	items := ProjectActionableItems(view)
	if len(items) != 1 {
		t.Fatalf("items = %#v", items)
	}
	if items[0].ID != "workflow-1/revision-1/task-1" || items[0].SourceWorkflowID != "workflow-1" || items[0].SourceRevisionID != "revision-1" || items[0].Task.ID != "task-1" {
		t.Fatalf("item = %#v", items[0])
	}

	view.Checkpoints[0].Status = workflowbiz.CheckpointStatusPending
	if pending := ProjectActionableItems(view); len(pending) != 0 {
		t.Fatalf("pending task review projected actionable items = %#v", pending)
	}
	view.Checkpoints[0].Status = workflowbiz.CheckpointStatusAccepted
	view.Workflow.CurrentRevisionID = "revision-2"
	if stale := ProjectActionableItems(view); len(stale) != 0 {
		t.Fatalf("stale revision projected actionable items = %#v", stale)
	}
}

func TestServiceReviseEnforcesPhaseStateMachine(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name           string
		checkpointKind workflowbiz.CheckpointKind
		status         workflowbiz.CheckpointStatus
		workflowStatus workflowbiz.WorkflowStatus
		markdown       []byte
		wantKind       workflowbiz.CheckpointKind
		wantErr        error
	}{
		{
			name:           "pending configuration may be superseded by configuration",
			checkpointKind: workflowbiz.CheckpointKindConfigurationReview,
			status:         workflowbiz.CheckpointStatusPending,
			workflowStatus: workflowbiz.WorkflowStatusPendingReview,
			markdown:       configurationMarkdown("Refined configuration"),
			wantKind:       workflowbiz.CheckpointKindConfigurationReview,
		},
		{
			name:           "rejected configuration accepts revised configuration",
			checkpointKind: workflowbiz.CheckpointKindConfigurationReview,
			status:         workflowbiz.CheckpointStatusRejected,
			workflowStatus: workflowbiz.WorkflowStatusInProgress,
			markdown:       configurationMarkdown("Addressed feedback"),
			wantKind:       workflowbiz.CheckpointKindConfigurationReview,
		},
		{
			name:           "accepted configuration advances to task graph",
			checkpointKind: workflowbiz.CheckpointKindConfigurationReview,
			status:         workflowbiz.CheckpointStatusAccepted,
			workflowStatus: workflowbiz.WorkflowStatusInProgress,
			markdown:       taskGraphMarkdown("Task graph"),
			wantKind:       workflowbiz.CheckpointKindTaskReview,
		},
		{
			name:           "configuration cannot skip its acceptance",
			checkpointKind: workflowbiz.CheckpointKindConfigurationReview,
			status:         workflowbiz.CheckpointStatusRejected,
			workflowStatus: workflowbiz.WorkflowStatusInProgress,
			markdown:       taskGraphMarkdown("Task graph"),
			wantErr:        ErrInvalidTransition,
		},
		{
			name:           "task review only accepts task graph revisions",
			checkpointKind: workflowbiz.CheckpointKindTaskReview,
			status:         workflowbiz.CheckpointStatusRejected,
			workflowStatus: workflowbiz.WorkflowStatusInProgress,
			markdown:       configurationMarkdown("Wrong phase"),
			wantErr:        ErrInvalidTransition,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			now := time.UnixMilli(1_700_000_000_000).UTC()
			store := newMemoryWorkflowStore()
			store.snapshots[workflowStoreKey("workspace-1", "workflow-1")] = workflowSnapshotFixture(test.checkpointKind, test.status, test.workflowStatus, now)
			service := newTestService(t, store, now.Add(time.Minute), "revision-2", "checkpoint-2")

			result, err := service.Revise(context.Background(), ReviseInput{
				WorkspaceID:      "workspace-1",
				WorkflowID:       "workflow-1",
				ProducedByTurnID: "turn-2",
				RequestID:        "request-2",
				Markdown:         test.markdown,
			})
			if test.wantErr != nil {
				if !errors.Is(err, test.wantErr) {
					t.Fatalf("Revise() error = %v, want %v", err, test.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Revise() error = %v", err)
			}
			if result.Revision.Sequence != 2 || result.Checkpoint.Kind != test.wantKind || result.Checkpoint.Status != workflowbiz.CheckpointStatusPending {
				t.Fatalf("result = %#v", result)
			}
			if result.Snapshot.Workflow.Status != workflowbiz.WorkflowStatusPendingReview || result.Snapshot.Workflow.CurrentRevisionID != "revision-2" {
				t.Fatalf("snapshot workflow = %#v", result.Snapshot.Workflow)
			}
		})
	}
}

func TestServiceReviseRetriesAfterMetadataCommitFailureWithoutRevisionFileConflict(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	store.snapshots[workflowStoreKey("workspace-1", "workflow-1")] = workflowSnapshotFixture(
		workflowbiz.CheckpointKindConfigurationReview,
		workflowbiz.CheckpointStatusRejected,
		workflowbiz.WorkflowStatusInProgress,
		now,
	)
	store.appendFailures = 1
	service := newTestService(t, store, now.Add(time.Minute), "revision-2", "checkpoint-2", "revision-3", "checkpoint-3")
	markdown := configurationMarkdown("Retryable revision")

	if _, err := service.Revise(context.Background(), ReviseInput{
		WorkspaceID: "workspace-1",
		WorkflowID:  "workflow-1",
		RequestID:   "request-2",
		Markdown:    markdown,
	}); err == nil {
		t.Fatal("first Revise() error = nil, want metadata commit failure")
	}
	result, err := service.Revise(context.Background(), ReviseInput{
		WorkspaceID: "workspace-1",
		WorkflowID:  "workflow-1",
		RequestID:   "request-2",
		Markdown:    markdown,
	})
	if err != nil {
		t.Fatalf("retry Revise() error = %v", err)
	}
	if result.Revision.Sequence != 2 || result.Revision.DocumentPath == "" {
		t.Fatalf("retry revision = %#v", result.Revision)
	}
}

func TestServiceReviseMutationReplayIsIdempotentWithoutBanningIntentionalReapply(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	store.snapshots[workflowStoreKey("workspace-1", "workflow-1")] = workflowSnapshotFixture(
		workflowbiz.CheckpointKindConfigurationReview,
		workflowbiz.CheckpointStatusPending,
		workflowbiz.WorkflowStatusPendingReview,
		now,
	)
	service := newTestService(t, store, now.Add(time.Minute),
		"revision-2", "checkpoint-2", "revision-3", "checkpoint-3",
	)
	input := ReviseInput{
		WorkspaceID: "workspace-1",
		WorkflowID:  "workflow-1",
		RequestID:   "revision-request-1",
		Markdown:    configurationMarkdown("Replay-safe revision"),
	}

	first, err := service.Revise(context.Background(), input)
	if err != nil {
		t.Fatalf("first Revise() error = %v", err)
	}
	replayed, err := service.Revise(context.Background(), input)
	if err != nil {
		t.Fatalf("replayed Revise() error = %v", err)
	}
	if replayed.RequestID != input.RequestID || !replayed.Replayed || replayed.Revision.ID != first.Revision.ID {
		t.Fatalf("replayed revision = %#v, first = %#v", replayed, first)
	}
	if revisions := store.snapshots[workflowStoreKey("workspace-1", "workflow-1")].Revisions; len(revisions) != 2 {
		t.Fatalf("replayed revision history = %#v, want two total revisions", revisions)
	}

	conflict := input
	conflict.Markdown = configurationMarkdown("Different content under the same request")
	if _, err := service.Revise(context.Background(), conflict); !errors.Is(err, ErrMutationConflict) {
		t.Fatalf("conflicting Revise() error = %v, want ErrMutationConflict", err)
	}

	intentional := input
	intentional.RequestID = "revision-request-2"
	second, err := service.Revise(context.Background(), intentional)
	if err != nil {
		t.Fatalf("intentional reapply Revise() error = %v", err)
	}
	if second.Replayed || second.Revision.ID == first.Revision.ID || second.Revision.Sequence != 3 {
		t.Fatalf("intentional reapply = %#v", second)
	}
}

func TestServiceDecideMapsCheckpointDecisionToWorkflowAndOperation(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name               string
		kind               workflowbiz.CheckpointKind
		decision           workflowbiz.CheckpointStatus
		reason             string
		wantWorkflowStatus workflowbiz.WorkflowStatus
		wantNext           NextAction
		wantOperation      workflowbiz.OperationKind
	}{
		{
			name:               "accept configuration requests task graph",
			kind:               workflowbiz.CheckpointKindConfigurationReview,
			decision:           workflowbiz.CheckpointStatusAccepted,
			wantWorkflowStatus: workflowbiz.WorkflowStatusInProgress,
			wantNext:           NextActionGenerateTaskGraph,
			wantOperation:      workflowbiz.OperationKindGenerateTaskGraph,
		},
		{
			name:               "reject configuration requests revision",
			kind:               workflowbiz.CheckpointKindConfigurationReview,
			decision:           workflowbiz.CheckpointStatusRejected,
			reason:             "Need a smaller scope",
			wantWorkflowStatus: workflowbiz.WorkflowStatusInProgress,
			wantNext:           NextActionReviseConfiguration,
			wantOperation:      workflowbiz.OperationKindCreateRevision,
		},
		{
			name:               "reject task graph requests graph revision",
			kind:               workflowbiz.CheckpointKindTaskReview,
			decision:           workflowbiz.CheckpointStatusRejected,
			reason:             "Split task two",
			wantWorkflowStatus: workflowbiz.WorkflowStatusInProgress,
			wantNext:           NextActionReviseTaskGraph,
			wantOperation:      workflowbiz.OperationKindCreateRevision,
		},
		{
			name:               "accept task graph requests issue creation",
			kind:               workflowbiz.CheckpointKindTaskReview,
			decision:           workflowbiz.CheckpointStatusAccepted,
			wantWorkflowStatus: workflowbiz.WorkflowStatusAccepted,
			wantNext:           NextActionCreateIssue,
			wantOperation:      workflowbiz.OperationKindCreateIssue,
		},
		{
			name:               "cancel ends workflow without operation",
			kind:               workflowbiz.CheckpointKindTaskReview,
			decision:           workflowbiz.CheckpointStatusCanceled,
			wantWorkflowStatus: workflowbiz.WorkflowStatusCanceled,
			wantNext:           NextActionCanceled,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			now := time.UnixMilli(1_700_000_000_000).UTC()
			store := newMemoryWorkflowStore()
			store.snapshots[workflowStoreKey("workspace-1", "workflow-1")] = workflowSnapshotFixture(test.kind, workflowbiz.CheckpointStatusPending, workflowbiz.WorkflowStatusPendingReview, now)
			service := newTestService(t, store, now.Add(time.Minute), "operation-1")

			result, err := service.Decide(context.Background(), DecideInput{
				WorkspaceID:    "workspace-1",
				WorkflowID:     "workflow-1",
				CheckpointID:   "checkpoint-1",
				Decision:       test.decision,
				DecidedBy:      "user-1",
				DecisionReason: test.reason,
			})
			if err != nil {
				t.Fatalf("Decide() error = %v", err)
			}
			if !result.Changed || result.Checkpoint.Status != test.decision || result.NextAction != test.wantNext {
				t.Fatalf("result = %#v", result)
			}
			snapshot := store.snapshots[workflowStoreKey("workspace-1", "workflow-1")]
			if snapshot.Workflow.Status != test.wantWorkflowStatus {
				t.Fatalf("workflow status = %q, want %q", snapshot.Workflow.Status, test.wantWorkflowStatus)
			}
			if test.wantOperation == "" {
				if len(snapshot.Operations) != 0 {
					t.Fatalf("operations = %#v, want none", snapshot.Operations)
				}
			} else if len(snapshot.Operations) != 1 || snapshot.Operations[0].Kind != test.wantOperation || snapshot.Operations[0].Status != workflowbiz.OperationStatusPending {
				t.Fatalf("operations = %#v, want pending %q", snapshot.Operations, test.wantOperation)
			}

			again, err := service.Decide(context.Background(), DecideInput{
				WorkspaceID:    "workspace-1",
				WorkflowID:     "workflow-1",
				CheckpointID:   "checkpoint-1",
				Decision:       test.decision,
				DecidedBy:      "user-1",
				DecisionReason: test.reason,
			})
			if err != nil || again.Changed {
				t.Fatalf("idempotent Decide() result=%#v error=%v", again, err)
			}
			if test.wantOperation != "" && len(store.snapshots[workflowStoreKey("workspace-1", "workflow-1")].Operations) != 1 {
				t.Fatalf("idempotent decision duplicated operation")
			}
		})
	}
}

func TestServiceRevisionCompletesDecisionOperationLifecycle(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	store.snapshots[workflowStoreKey("workspace-1", "workflow-1")] = workflowSnapshotFixture(
		workflowbiz.CheckpointKindConfigurationReview,
		workflowbiz.CheckpointStatusPending,
		workflowbiz.WorkflowStatusPendingReview,
		now,
	)
	service := newTestService(t, store, now.Add(time.Minute), "revision-2", "checkpoint-2")
	decision, err := service.Decide(context.Background(), DecideInput{
		WorkspaceID: "workspace-1", WorkflowID: "workflow-1", CheckpointID: "checkpoint-1",
		Decision: workflowbiz.CheckpointStatusAccepted, DecidedBy: "user-1",
	})
	if err != nil || decision.Operation == nil || decision.Operation.Status != workflowbiz.OperationStatusPending {
		t.Fatalf("Decide() result=%#v error=%v", decision, err)
	}
	result, err := service.ReviseFromAgent(context.Background(), AgentReviseInput{
		WorkspaceID: "workspace-1", WorkflowID: "workflow-1", AgentSessionID: "session-1",
		ProducedByTurnID: "turn-2", RequestID: "request-2", Markdown: taskGraphMarkdown("Generated graph"),
	})
	if err != nil {
		t.Fatalf("ReviseFromAgent() error = %v", err)
	}
	if len(result.Snapshot.Operations) != 1 || result.Snapshot.Operations[0].ID != decision.Operation.ID || result.Snapshot.Operations[0].Status != workflowbiz.OperationStatusSucceeded {
		t.Fatalf("operations = %#v, want exact decision operation succeeded", result.Snapshot.Operations)
	}
}

func TestServiceDecideRequiresFeedbackForRejectionAndRejectsConflictingReplay(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	store.snapshots[workflowStoreKey("workspace-1", "workflow-1")] = workflowSnapshotFixture(workflowbiz.CheckpointKindConfigurationReview, workflowbiz.CheckpointStatusPending, workflowbiz.WorkflowStatusPendingReview, now)
	service := newTestService(t, store, now.Add(time.Minute), "operation-1")

	_, err := service.Decide(context.Background(), DecideInput{
		WorkspaceID:  "workspace-1",
		WorkflowID:   "workflow-1",
		CheckpointID: "checkpoint-1",
		Decision:     workflowbiz.CheckpointStatusRejected,
		DecidedBy:    "user-1",
	})
	if !errors.Is(err, ErrInvalidDecision) {
		t.Fatalf("Decide(reject without feedback) error = %v", err)
	}

	if _, err := service.Decide(context.Background(), DecideInput{
		WorkspaceID:  "workspace-1",
		WorkflowID:   "workflow-1",
		CheckpointID: "checkpoint-1",
		Decision:     workflowbiz.CheckpointStatusAccepted,
		DecidedBy:    "user-1",
	}); err != nil {
		t.Fatalf("Decide(accept) error = %v", err)
	}
	_, err = service.Decide(context.Background(), DecideInput{
		WorkspaceID:    "workspace-1",
		WorkflowID:     "workflow-1",
		CheckpointID:   "checkpoint-1",
		Decision:       workflowbiz.CheckpointStatusRejected,
		DecidedBy:      "user-1",
		DecisionReason: "Changed mind",
	})
	if !errors.Is(err, ErrDecisionConflict) {
		t.Fatalf("Decide(conflicting replay) error = %v, want ErrDecisionConflict", err)
	}
}

func TestServiceAcceptTaskGraphMaterializesActionableItemsAndCompletesOperation(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	service := newTestService(t, store, now.Add(time.Minute))
	documentPath, digest, err := service.Revisions.Write("workflow-1", taskGraphMarkdown("Executable plan"))
	if err != nil {
		t.Fatalf("write task graph: %v", err)
	}
	snapshot := workflowSnapshotFixture(
		workflowbiz.CheckpointKindTaskReview,
		workflowbiz.CheckpointStatusPending,
		workflowbiz.WorkflowStatusPendingReview,
		now,
	)
	snapshot.Revisions[0].DocumentPath = documentPath
	snapshot.Revisions[0].SHA256 = digest
	store.snapshots[workflowStoreKey("workspace-1", "workflow-1")] = snapshot
	materializer := &recordingIssueMaterializer{issueID: "issue-1"}
	service.IssueMaterializer = materializer

	result, err := service.Decide(context.Background(), DecideInput{
		WorkspaceID:  "workspace-1",
		WorkflowID:   "workflow-1",
		CheckpointID: "checkpoint-1",
		Decision:     workflowbiz.CheckpointStatusAccepted,
		DecidedBy:    "user-1",
	})
	if err != nil {
		t.Fatalf("Decide() error = %v", err)
	}
	if result.Operation == nil || result.Operation.Status != workflowbiz.OperationStatusSucceeded || result.Operation.IssueID != "issue-1" {
		t.Fatalf("operation = %#v", result.Operation)
	}
	if result.NextAction != NextActionIssueCreated {
		t.Fatalf("next action = %q, want %q", result.NextAction, NextActionIssueCreated)
	}
	if len(materializer.inputs) != 1 || len(materializer.inputs[0].ActionableItems) != 1 {
		t.Fatalf("materializer inputs = %#v", materializer.inputs)
	}
	if materializer.inputs[0].ActionableItems[0].Task.ID != "task-1" || materializer.inputs[0].SourceSessionID != "session-1" {
		t.Fatalf("materializer input = %#v", materializer.inputs[0])
	}
	replayed, err := service.Decide(context.Background(), DecideInput{
		WorkspaceID:  "workspace-1",
		WorkflowID:   "workflow-1",
		CheckpointID: "checkpoint-1",
		Decision:     workflowbiz.CheckpointStatusAccepted,
		DecidedBy:    "user-1",
	})
	if err != nil || replayed.Changed || replayed.Operation == nil || replayed.Operation.ID != result.Operation.ID {
		t.Fatalf("replayed response-loss decision = %#v error=%v", replayed, err)
	}
	if len(materializer.inputs) != 1 {
		t.Fatalf("replayed decision duplicated materialization: calls=%d", len(materializer.inputs))
	}
}

func TestServiceAcceptTaskGraphRetriesFailedMaterializationWithSameOperation(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	service := newTestService(t, store, now.Add(time.Minute))
	documentPath, digest, err := service.Revisions.Write("workflow-1", taskGraphMarkdown("Retryable plan"))
	if err != nil {
		t.Fatalf("write task graph: %v", err)
	}
	snapshot := workflowSnapshotFixture(
		workflowbiz.CheckpointKindTaskReview,
		workflowbiz.CheckpointStatusPending,
		workflowbiz.WorkflowStatusPendingReview,
		now,
	)
	snapshot.Revisions[0].DocumentPath = documentPath
	snapshot.Revisions[0].SHA256 = digest
	store.snapshots[workflowStoreKey("workspace-1", "workflow-1")] = snapshot
	materializer := &recordingIssueMaterializer{err: errors.New("temporary issue store outage")}
	service.IssueMaterializer = materializer

	failedResult, err := service.Decide(context.Background(), DecideInput{
		WorkspaceID:  "workspace-1",
		WorkflowID:   "workflow-1",
		CheckpointID: "checkpoint-1",
		Decision:     workflowbiz.CheckpointStatusAccepted,
		DecidedBy:    "user-1",
	})
	if err != nil {
		t.Fatalf("first Decide() error = %v, durable failure should remain observable", err)
	}
	failed := store.snapshots[workflowStoreKey("workspace-1", "workflow-1")].Operations
	if len(failed) != 1 || failed[0].Status != workflowbiz.OperationStatusFailed {
		t.Fatalf("failed operations = %#v", failed)
	}
	if failedResult.Checkpoint.Status != workflowbiz.CheckpointStatusAccepted || failedResult.Operation == nil || failedResult.Operation.Status != workflowbiz.OperationStatusFailed {
		t.Fatalf("failed decision result = %#v, want committed checkpoint and failed operation", failedResult)
	}
	operationID := failed[0].ID

	materializer.err = nil
	materializer.issueID = "issue-1"
	result, err := service.Decide(context.Background(), DecideInput{
		WorkspaceID:  "workspace-1",
		WorkflowID:   "workflow-1",
		CheckpointID: "checkpoint-1",
		Decision:     workflowbiz.CheckpointStatusAccepted,
		DecidedBy:    "user-1",
	})
	if err != nil {
		t.Fatalf("retry Decide() error = %v", err)
	}
	if result.Operation == nil || result.Operation.ID != operationID || result.Operation.Status != workflowbiz.OperationStatusSucceeded || result.Operation.IssueID != "issue-1" {
		t.Fatalf("retry operation = %#v, want same succeeded operation", result.Operation)
	}
	if result.NextAction != NextActionIssueCreated {
		t.Fatalf("retry next action = %q, want %q", result.NextAction, NextActionIssueCreated)
	}
	if len(materializer.inputs) != 2 {
		t.Fatalf("materializer calls = %d, want 2", len(materializer.inputs))
	}
}

func TestServiceDecisionReturnsErrorWhenOperationFailureCannotBeRecorded(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	service := newTestService(t, store, now.Add(time.Minute))
	documentPath, digest, err := service.Revisions.Write("workflow-1", taskGraphMarkdown("Unrecordable failure"))
	if err != nil {
		t.Fatalf("write task graph: %v", err)
	}
	snapshot := workflowSnapshotFixture(
		workflowbiz.CheckpointKindTaskReview,
		workflowbiz.CheckpointStatusPending,
		workflowbiz.WorkflowStatusPendingReview,
		now,
	)
	snapshot.Revisions[0].DocumentPath = documentPath
	snapshot.Revisions[0].SHA256 = digest
	store.snapshots[workflowStoreKey("workspace-1", "workflow-1")] = snapshot
	store.completeFailures = 1
	service.IssueMaterializer = &recordingIssueMaterializer{err: errors.New("issue store unavailable")}

	_, err = service.Decide(context.Background(), DecideInput{
		WorkspaceID: "workspace-1", WorkflowID: "workflow-1", CheckpointID: "checkpoint-1",
		Decision: workflowbiz.CheckpointStatusAccepted, DecidedBy: "user-1",
	})
	if err == nil {
		t.Fatal("Decide() error = nil, want failure because operation result was not durable")
	}
	committed := store.snapshots[workflowStoreKey("workspace-1", "workflow-1")]
	if committed.Checkpoints[0].Status != workflowbiz.CheckpointStatusAccepted || len(committed.Operations) != 1 || committed.Operations[0].Status != workflowbiz.OperationStatusPending {
		t.Fatalf("committed state = %#v, want accepted checkpoint with retryable pending operation", committed)
	}
}

func TestServiceWaitRecoversCreateIssueOperationAfterDaemonRestart(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	service := newTestService(t, store, now.Add(time.Minute))
	documentPath, digest, err := service.Revisions.Write("workflow-1", taskGraphMarkdown("Restart recovery"))
	if err != nil {
		t.Fatalf("write task graph: %v", err)
	}
	snapshot := workflowSnapshotFixture(
		workflowbiz.CheckpointKindTaskReview,
		workflowbiz.CheckpointStatusAccepted,
		workflowbiz.WorkflowStatusAccepted,
		now,
	)
	snapshot.Revisions[0].DocumentPath = documentPath
	snapshot.Revisions[0].SHA256 = digest
	snapshot.Operations = []workflowbiz.WorkflowOperation{{
		ID:         operationIDForCheckpoint(snapshot.Checkpoints[0], workflowbiz.OperationKindCreateIssue),
		WorkflowID: "workflow-1",
		Kind:       workflowbiz.OperationKindCreateIssue,
		Status:     workflowbiz.OperationStatusPending,
		RevisionID: "revision-1",
		CreatedAt:  now,
		UpdatedAt:  now,
	}}
	store.snapshots[workflowStoreKey("workspace-1", "workflow-1")] = snapshot
	materializer := &recordingIssueMaterializer{issueID: "issue-after-restart"}
	service.IssueMaterializer = materializer

	result, err := service.Wait(context.Background(), WaitInput{
		WorkspaceID: "workspace-1", WorkflowID: "workflow-1", CheckpointID: "checkpoint-1",
	})
	if err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if result.NextAction != NextActionIssueCreated || result.Operation == nil || result.Operation.Status != workflowbiz.OperationStatusSucceeded || result.Operation.IssueID != "issue-after-restart" {
		t.Fatalf("Wait() result = %#v, want recovered issue operation", result)
	}
	if len(materializer.inputs) != 1 {
		t.Fatalf("restart recovery materializer calls = %d, want 1", len(materializer.inputs))
	}
}

func TestServiceStartupRecoveryConvergesCreateIssueOperationsWithoutObservation(t *testing.T) {
	t.Parallel()

	for _, status := range []workflowbiz.OperationStatus{
		workflowbiz.OperationStatusPending,
		workflowbiz.OperationStatusFailed,
	} {
		status := status
		t.Run(string(status), func(t *testing.T) {
			t.Parallel()
			now := time.UnixMilli(1_700_000_000_000).UTC()
			store := newMemoryWorkflowStore()
			service := newTestService(t, store, now.Add(time.Minute))
			documentPath, digest, err := service.Revisions.Write("workflow-1", taskGraphMarkdown("Automatic restart recovery"))
			if err != nil {
				t.Fatalf("write task graph: %v", err)
			}
			snapshot := workflowSnapshotFixture(
				workflowbiz.CheckpointKindTaskReview,
				workflowbiz.CheckpointStatusAccepted,
				workflowbiz.WorkflowStatusAccepted,
				now,
			)
			snapshot.Revisions[0].DocumentPath = documentPath
			snapshot.Revisions[0].SHA256 = digest
			snapshot.Operations = []workflowbiz.WorkflowOperation{{
				ID:           operationIDForCheckpoint(snapshot.Checkpoints[0], workflowbiz.OperationKindCreateIssue),
				WorkflowID:   "workflow-1",
				Kind:         workflowbiz.OperationKindCreateIssue,
				Status:       status,
				RevisionID:   "revision-1",
				ErrorCode:    operationErrorCode(status),
				ErrorMessage: operationErrorMessage(status),
				CreatedAt:    now,
				UpdatedAt:    now,
				CompletedAt:  operationCompletedAt(status, now),
			}}
			store.snapshots[workflowStoreKey("workspace-1", "workflow-1")] = snapshot
			materializer := &recordingIssueMaterializer{issueID: "issue-after-startup"}
			service.IssueMaterializer = materializer

			if err := service.RecoverCreateIssueOperations(context.Background()); err != nil {
				t.Fatalf("RecoverCreateIssueOperations() error = %v", err)
			}
			if err := service.RecoverCreateIssueOperations(context.Background()); err != nil {
				t.Fatalf("second RecoverCreateIssueOperations() error = %v", err)
			}
			operation := store.snapshots[workflowStoreKey("workspace-1", "workflow-1")].Operations[0]
			if operation.Status != workflowbiz.OperationStatusSucceeded || operation.IssueID != "issue-after-startup" {
				t.Fatalf("recovered operation = %#v", operation)
			}
			if len(materializer.inputs) != 1 {
				t.Fatalf("startup recovery materializer calls = %d, want 1", len(materializer.inputs))
			}
		})
	}
}

func TestServiceStartupRecoveryIsolatesCorruptRevisionAndContinuesOtherOperations(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	service := newTestService(t, store, now.Add(time.Minute))

	corrupt := namedAcceptedTaskGraphSnapshot("corrupt", now)
	corrupt.Revisions[0].DocumentPath = "tutti-mode-plans/workflow-corrupt/revisions/missing.md"
	corrupt.Revisions[0].SHA256 = strings.Repeat("a", 64)
	corrupt.Operations[0].Status = workflowbiz.OperationStatusFailed
	corrupt.Operations[0].ErrorCode = "prior_failure"
	corrupt.Operations[0].ErrorMessage = "retry this corrupt revision"
	corrupt.Operations[0].CompletedAt = now
	store.snapshots[workflowStoreKey("workspace-1", corrupt.Workflow.ID)] = corrupt
	invalidFailed := namedAcceptedTaskGraphSnapshot("invalid-failed", now)
	invalidFailed.Workflow.CurrentRevisionID = "revision-stale"
	invalidFailed.Operations[0].Status = workflowbiz.OperationStatusFailed
	invalidFailed.Operations[0].ErrorCode = "prior_failure"
	invalidFailed.Operations[0].ErrorMessage = "invalid before retry"
	invalidFailed.Operations[0].CompletedAt = now
	store.snapshots[workflowStoreKey("workspace-1", invalidFailed.Workflow.ID)] = invalidFailed

	valid := namedAcceptedTaskGraphSnapshot("valid", now)
	documentPath, digest, err := service.Revisions.Write(valid.Workflow.ID, taskGraphMarkdown("Recover valid workflow"))
	if err != nil {
		t.Fatalf("write valid task graph: %v", err)
	}
	valid.Revisions[0].DocumentPath = documentPath
	valid.Revisions[0].SHA256 = digest
	store.snapshots[workflowStoreKey("workspace-1", valid.Workflow.ID)] = valid
	materializer := &recordingIssueMaterializer{issueID: "issue-valid"}
	service.IssueMaterializer = materializer

	if err := service.RecoverCreateIssueOperations(context.Background()); err != nil {
		t.Fatalf("RecoverCreateIssueOperations() error = %v", err)
	}
	corruptOperation := store.snapshots[workflowStoreKey("workspace-1", corrupt.Workflow.ID)].Operations[0]
	if corruptOperation.Status != workflowbiz.OperationStatusFailed || corruptOperation.ErrorCode != "startup_recovery_failed" {
		t.Fatalf("corrupt operation = %#v, want durable isolated failure", corruptOperation)
	}
	invalidFailedOperation := store.snapshots[workflowStoreKey("workspace-1", invalidFailed.Workflow.ID)].Operations[0]
	if invalidFailedOperation.Status != workflowbiz.OperationStatusFailed || invalidFailedOperation.ErrorCode != "startup_recovery_failed" {
		t.Fatalf("pre-retry failed operation = %#v, want refreshed durable failure", invalidFailedOperation)
	}
	validOperation := store.snapshots[workflowStoreKey("workspace-1", valid.Workflow.ID)].Operations[0]
	if validOperation.Status != workflowbiz.OperationStatusSucceeded || validOperation.IssueID != "issue-valid" {
		t.Fatalf("valid operation = %#v, want recovery after corrupt sibling", validOperation)
	}
	if len(materializer.inputs) != 1 || materializer.inputs[0].WorkflowID != valid.Workflow.ID {
		t.Fatalf("materializer inputs = %#v", materializer.inputs)
	}
}

func TestServiceStartupRecoveryFailsWhenOperationOutcomeCannotBePersisted(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	service := newTestService(t, store, now.Add(time.Minute))
	snapshot := namedAcceptedTaskGraphSnapshot("unrecordable", now)
	snapshot.Revisions[0].DocumentPath = "tutti-mode-plans/workflow-unrecordable/revisions/missing.md"
	snapshot.Revisions[0].SHA256 = strings.Repeat("a", 64)
	store.snapshots[workflowStoreKey("workspace-1", snapshot.Workflow.ID)] = snapshot
	store.completeFailures = 1
	service.IssueMaterializer = &recordingIssueMaterializer{issueID: "unused"}

	if err := service.RecoverCreateIssueOperations(context.Background()); err == nil {
		t.Fatal("RecoverCreateIssueOperations() error = nil, want durable outcome failure")
	}
	operation := store.snapshots[workflowStoreKey("workspace-1", snapshot.Workflow.ID)].Operations[0]
	if operation.Status != workflowbiz.OperationStatusPending {
		t.Fatalf("operation = %#v, want still pending after failed outcome write", operation)
	}
}

func namedAcceptedTaskGraphSnapshot(name string, now time.Time) workflowbiz.Snapshot {
	snapshot := workflowSnapshotFixture(
		workflowbiz.CheckpointKindTaskReview,
		workflowbiz.CheckpointStatusAccepted,
		workflowbiz.WorkflowStatusAccepted,
		now,
	)
	workflowID := "workflow-" + name
	revisionID := "revision-" + name
	checkpointID := "checkpoint-" + name
	snapshot.Workflow.ID = workflowID
	snapshot.Workflow.CurrentRevisionID = revisionID
	snapshot.Plan.WorkflowID = workflowID
	snapshot.Revisions[0].ID = revisionID
	snapshot.Revisions[0].WorkflowID = workflowID
	snapshot.Checkpoints[0].ID = checkpointID
	snapshot.Checkpoints[0].WorkflowID = workflowID
	snapshot.Checkpoints[0].RevisionID = revisionID
	snapshot.TurnLinks[0].WorkflowID = workflowID
	snapshot.Operations = []workflowbiz.WorkflowOperation{{
		ID: "operation-" + name, WorkflowID: workflowID,
		Kind: workflowbiz.OperationKindCreateIssue, Status: workflowbiz.OperationStatusPending,
		RevisionID: revisionID, CreatedAt: now, UpdatedAt: now,
	}}
	return snapshot
}

func operationErrorCode(status workflowbiz.OperationStatus) string {
	if status == workflowbiz.OperationStatusFailed {
		return "temporary_failure"
	}
	return ""
}

func operationErrorMessage(status workflowbiz.OperationStatus) string {
	if status == workflowbiz.OperationStatusFailed {
		return "retry on restart"
	}
	return ""
}

func operationCompletedAt(status workflowbiz.OperationStatus, now time.Time) time.Time {
	if status == workflowbiz.OperationStatusFailed {
		return now
	}
	return time.Time{}
}

func TestServiceAcceptTaskGraphConcurrentSuccessDominatesFailure(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	service := newTestService(t, store, now.Add(time.Minute))
	documentPath, digest, err := service.Revisions.Write("workflow-1", taskGraphMarkdown("Concurrent plan"))
	if err != nil {
		t.Fatalf("write task graph: %v", err)
	}
	snapshot := workflowSnapshotFixture(
		workflowbiz.CheckpointKindTaskReview,
		workflowbiz.CheckpointStatusPending,
		workflowbiz.WorkflowStatusPendingReview,
		now,
	)
	snapshot.Revisions[0].DocumentPath = documentPath
	snapshot.Revisions[0].SHA256 = digest
	store.snapshots[workflowStoreKey("workspace-1", "workflow-1")] = snapshot
	materializer := newControlledConcurrentIssueMaterializer()
	service.IssueMaterializer = materializer

	type decisionOutcome struct {
		result DecisionResult
		err    error
	}
	outcomes := make(chan decisionOutcome, 2)
	decide := func() {
		result, decideErr := service.Decide(context.Background(), DecideInput{
			WorkspaceID:  "workspace-1",
			WorkflowID:   "workflow-1",
			CheckpointID: "checkpoint-1",
			Decision:     workflowbiz.CheckpointStatusAccepted,
			DecidedBy:    "user-1",
		})
		outcomes <- decisionOutcome{result: result, err: decideErr}
	}
	go decide()
	if call := <-materializer.entered; call != 0 {
		t.Fatalf("first materializer call = %d", call)
	}
	go decide()
	if call := <-materializer.entered; call != 1 {
		t.Fatalf("second materializer call = %d", call)
	}

	materializer.release[0] <- struct{}{}
	first := <-outcomes
	if first.err != nil || first.result.Operation == nil || first.result.Operation.Status != workflowbiz.OperationStatusFailed {
		t.Fatalf("first concurrent decision result=%#v error=%v, want durable failed operation", first.result, first.err)
	}
	materializer.release[1] <- struct{}{}
	second := <-outcomes
	if second.err != nil {
		t.Fatalf("second concurrent decision error = %v", second.err)
	}

	operations := store.snapshots[workflowStoreKey("workspace-1", "workflow-1")].Operations
	if len(operations) != 1 || operations[0].Status != workflowbiz.OperationStatusSucceeded || operations[0].IssueID != "issue-1" {
		t.Fatalf("converged operations = %#v", operations)
	}
	if second.result.Operation == nil || second.result.Operation.ID != operations[0].ID || second.result.NextAction != NextActionIssueCreated {
		t.Fatalf("successful decision result = %#v", second.result)
	}

	replayed, err := service.Decide(context.Background(), DecideInput{
		WorkspaceID:  "workspace-1",
		WorkflowID:   "workflow-1",
		CheckpointID: "checkpoint-1",
		Decision:     workflowbiz.CheckpointStatusAccepted,
		DecidedBy:    "user-1",
	})
	if err != nil || replayed.NextAction != NextActionIssueCreated || replayed.Operation == nil || replayed.Operation.ID != operations[0].ID {
		t.Fatalf("replayed decision = %#v error=%v", replayed, err)
	}
}

func TestServiceWaitReturnsDurableDecisionAndFeedback(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	store.snapshots[workflowStoreKey("workspace-1", "workflow-1")] = workflowSnapshotFixture(workflowbiz.CheckpointKindTaskReview, workflowbiz.CheckpointStatusPending, workflowbiz.WorkflowStatusPendingReview, now)
	service := newTestService(t, store, now.Add(time.Minute), "operation-1")
	service.WaitInterval = time.Millisecond

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	resultChannel := make(chan WaitResult, 1)
	errorChannel := make(chan error, 1)
	go func() {
		result, err := service.Wait(ctx, WaitInput{
			WorkspaceID:  "workspace-1",
			WorkflowID:   "workflow-1",
			CheckpointID: "checkpoint-1",
		})
		if err != nil {
			errorChannel <- err
			return
		}
		resultChannel <- result
	}()

	deadline := time.Now().Add(500 * time.Millisecond)
	for store.getCalls() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if _, err := service.Decide(context.Background(), DecideInput{
		WorkspaceID:    "workspace-1",
		WorkflowID:     "workflow-1",
		CheckpointID:   "checkpoint-1",
		Decision:       workflowbiz.CheckpointStatusRejected,
		DecidedBy:      "user-1",
		DecisionReason: "Reorder the graph",
	}); err != nil {
		t.Fatalf("Decide() error = %v", err)
	}

	select {
	case err := <-errorChannel:
		t.Fatalf("Wait() error = %v", err)
	case result := <-resultChannel:
		if result.Checkpoint.Status != workflowbiz.CheckpointStatusRejected || result.Checkpoint.DecisionReason != "Reorder the graph" || result.NextAction != NextActionReviseTaskGraph {
			t.Fatalf("Wait() result = %#v", result)
		}
	case <-ctx.Done():
		t.Fatal("Wait() did not observe durable decision")
	}
}

func TestServiceWaitHonorsContextCancellation(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	store.snapshots[workflowStoreKey("workspace-1", "workflow-1")] = workflowSnapshotFixture(workflowbiz.CheckpointKindConfigurationReview, workflowbiz.CheckpointStatusPending, workflowbiz.WorkflowStatusPendingReview, now)
	service := newTestService(t, store, now, "unused")
	service.WaitInterval = time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := service.Wait(ctx, WaitInput{WorkspaceID: "workspace-1", WorkflowID: "workflow-1", CheckpointID: "checkpoint-1"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Wait() error = %v, want context.Canceled", err)
	}
}

func TestServiceWaitReportsSupersededCheckpointWithoutTreatingItAsDecision(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	snapshot := workflowSnapshotFixture(workflowbiz.CheckpointKindConfigurationReview, workflowbiz.CheckpointStatusSuperseded, workflowbiz.WorkflowStatusPendingReview, now)
	snapshot.Workflow.CurrentRevisionID = "revision-2"
	store.snapshots[workflowStoreKey("workspace-1", "workflow-1")] = snapshot
	service := newTestService(t, store, now, "unused")

	result, err := service.Wait(context.Background(), WaitInput{
		WorkspaceID:  "workspace-1",
		WorkflowID:   "workflow-1",
		CheckpointID: "checkpoint-1",
	})
	if err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if result.Checkpoint.Status != workflowbiz.CheckpointStatusSuperseded || result.NextAction != NextActionSuperseded {
		t.Fatalf("Wait() result = %#v", result)
	}
}

func TestServiceWaitRepairsMissingFollowUpOperationAfterDecisionCrashGap(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	store := newMemoryWorkflowStore()
	store.snapshots[workflowStoreKey("workspace-1", "workflow-1")] = workflowSnapshotFixture(
		workflowbiz.CheckpointKindConfigurationReview,
		workflowbiz.CheckpointStatusAccepted,
		workflowbiz.WorkflowStatusInProgress,
		now,
	)
	service := newTestService(t, store, now, "unused")

	result, err := service.Wait(context.Background(), WaitInput{
		WorkspaceID:  "workspace-1",
		WorkflowID:   "workflow-1",
		CheckpointID: "checkpoint-1",
	})
	if err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if result.Operation == nil || result.Operation.Kind != workflowbiz.OperationKindGenerateTaskGraph || result.Operation.Status != workflowbiz.OperationStatusPending {
		t.Fatalf("Wait() operation = %#v", result.Operation)
	}
	if operations := store.snapshots[workflowStoreKey("workspace-1", "workflow-1")].Operations; len(operations) != 1 || operations[0].ID != result.Operation.ID {
		t.Fatalf("durable repaired operations = %#v", operations)
	}
}

func newTestService(t *testing.T, store *memoryWorkflowStore, now time.Time, ids ...string) *Service {
	t.Helper()
	index := 0
	return &Service{
		Store:     store,
		Revisions: workspacedata.WorkflowRevisionFiles{StateDir: t.TempDir()},
		Now:       func() time.Time { return now },
		NewID: func() string {
			if index >= len(ids) {
				t.Fatalf("unexpected id allocation after %d ids", len(ids))
			}
			id := ids[index]
			index++
			return id
		},
	}
}

func configurationMarkdown(title string) []byte {
	return []byte("---\nschema: tutti-mode-plan/v1\nphase: configuration\ntitle: " + title + "\ntopicId: topic-1\nexecution:\n  mode: sequential\n  reasoningIntensity: 50\n  orchestrationIntensity: 50\nbudget:\n  mode: auto\n  tokenLimit: 0\n  quotaWaterlinePercent: 0\n---\nConfiguration narrative\n")
}

func taskGraphMarkdown(title string) []byte {
	return []byte("---\nschema: tutti-mode-plan/v1\nphase: task_graph\ntitle: " + title + "\ntopicId: topic-1\nexecution:\n  mode: sequential\n  reasoningIntensity: 50\n  orchestrationIntensity: 50\nbudget:\n  mode: auto\n  tokenLimit: 0\n  quotaWaterlinePercent: 0\ntasks:\n  - id: task-1\n    title: Implement task\n    priority: medium\n---\nTask graph narrative\n")
}

func workflowSnapshotFixture(kind workflowbiz.CheckpointKind, checkpointStatus workflowbiz.CheckpointStatus, workflowStatus workflowbiz.WorkflowStatus, now time.Time) workflowbiz.Snapshot {
	return workflowbiz.Snapshot{
		Workflow: workflowbiz.Workflow{
			ID:                "workflow-1",
			WorkspaceID:       "workspace-1",
			Type:              workflowbiz.WorkflowTypeTuttiModePlan,
			Owner:             workflowbiz.WorkflowOwnerTutti,
			TriggerKind:       workflowbiz.TriggerKindAgentCLI,
			SourceSessionID:   "session-1",
			SourceTurnID:      "turn-1",
			Status:            workflowStatus,
			CurrentRevisionID: "revision-1",
			CreatedAt:         now,
			UpdatedAt:         now,
		},
		Plan: workflowbiz.TuttiModePlan{WorkflowID: "workflow-1"},
		Revisions: []workflowbiz.PlanRevision{{
			ID:               "revision-1",
			WorkflowID:       "workflow-1",
			Sequence:         1,
			SchemaVersion:    SchemaV1,
			DocumentPath:     "tutti-mode-plans/workflow-1/revisions/" + strings.Repeat("a", 64) + ".md",
			SHA256:           "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			ProducedByTurnID: "turn-1",
			CreatedAt:        now,
		}},
		Checkpoints: []workflowbiz.WorkflowCheckpoint{{
			ID:             "checkpoint-1",
			WorkflowID:     "workflow-1",
			Kind:           kind,
			RevisionID:     "revision-1",
			Status:         checkpointStatus,
			DecidedBy:      decisionActor(checkpointStatus),
			DecisionReason: decisionReason(checkpointStatus),
			CreatedAt:      now,
			UpdatedAt:      now,
			DecidedAt:      decisionTime(checkpointStatus, now),
		}},
		TurnLinks: []workflowbiz.WorkflowTurnLink{{
			WorkflowID: "workflow-1",
			TurnID:     "turn-1",
			Relation:   workflowbiz.TurnRelationSource,
			CreatedAt:  now,
		}},
		Operations: []workflowbiz.WorkflowOperation{},
	}
}

func decisionActor(status workflowbiz.CheckpointStatus) string {
	if status == workflowbiz.CheckpointStatusPending {
		return ""
	}
	return "user-1"
}

func decisionReason(status workflowbiz.CheckpointStatus) string {
	if status == workflowbiz.CheckpointStatusRejected {
		return "feedback"
	}
	return ""
}

func decisionTime(status workflowbiz.CheckpointStatus, now time.Time) time.Time {
	if status == workflowbiz.CheckpointStatusPending {
		return time.Time{}
	}
	return now
}

type memoryWorkflowStore struct {
	mu               sync.Mutex
	snapshots        map[string]workflowbiz.Snapshot
	mutations        map[string]workflowbiz.WorkflowMutation
	getCount         int
	appendFailures   int
	completeFailures int
}

type recordingWorkflowPublisher struct {
	updates []workflowbiz.Update
}

func (publisher *recordingWorkflowPublisher) PublishWorkspaceWorkflowUpdated(_ context.Context, update workflowbiz.Update) error {
	publisher.updates = append(publisher.updates, update)
	return nil
}

func newMemoryWorkflowStore() *memoryWorkflowStore {
	return &memoryWorkflowStore{
		snapshots: make(map[string]workflowbiz.Snapshot),
		mutations: make(map[string]workflowbiz.WorkflowMutation),
	}
}

func workflowStoreKey(workspaceID string, workflowID string) string {
	return workspaceID + "/" + workflowID
}

func (store *memoryWorkflowStore) getCalls() int {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.getCount
}

func (store *memoryWorkflowStore) CreateWorkspaceWorkflowProposal(_ context.Context, aggregate workflowbiz.ProposalAggregate) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.createWorkspaceWorkflowProposalLocked(aggregate)
}

func (store *memoryWorkflowStore) CreateWorkspaceWorkflowProposalWithMutation(
	_ context.Context,
	input workspacedata.CreateWorkspaceWorkflowProposalMutationInput,
) (workflowbiz.WorkflowMutation, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	mutation, err := workflowbiz.NormalizeMutation(input.Mutation)
	if err != nil {
		return workflowbiz.WorkflowMutation{}, false, err
	}
	key := workflowMutationStoreKey(mutation)
	if existing, found := store.mutations[key]; found {
		if existing.InputSHA256 != mutation.InputSHA256 {
			return existing, false, workspacedata.ErrWorkflowMutationConflict
		}
		return existing, false, nil
	}
	if err := store.createWorkspaceWorkflowProposalLocked(input.Aggregate); err != nil {
		return workflowbiz.WorkflowMutation{}, false, err
	}
	store.mutations[key] = mutation
	return mutation, true, nil
}

func (store *memoryWorkflowStore) createWorkspaceWorkflowProposalLocked(aggregate workflowbiz.ProposalAggregate) error {
	key := workflowStoreKey(aggregate.Workflow.WorkspaceID, aggregate.Workflow.ID)
	if _, exists := store.snapshots[key]; exists {
		return errors.New("duplicate workflow")
	}
	store.snapshots[key] = workflowbiz.Snapshot{
		Workflow:    aggregate.Workflow,
		Plan:        aggregate.Plan,
		Revisions:   []workflowbiz.PlanRevision{aggregate.Revision},
		Checkpoints: []workflowbiz.WorkflowCheckpoint{aggregate.Checkpoint},
		TurnLinks:   append([]workflowbiz.WorkflowTurnLink(nil), aggregate.TurnLinks...),
		Operations:  []workflowbiz.WorkflowOperation{},
	}
	return nil
}

func (store *memoryWorkflowStore) GetWorkspaceWorkflowMutation(
	_ context.Context,
	input workspacedata.GetWorkspaceWorkflowMutationInput,
) (workflowbiz.WorkflowMutation, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	key := strings.Join([]string{input.WorkspaceID, input.SourceSessionID, string(input.Kind), input.ScopeID, input.RequestID}, "\x00")
	mutation, found := store.mutations[key]
	return mutation, found, nil
}

func workflowMutationStoreKey(mutation workflowbiz.WorkflowMutation) string {
	return strings.Join([]string{
		mutation.WorkspaceID,
		mutation.SourceSessionID,
		string(mutation.Kind),
		mutation.ScopeID,
		mutation.RequestID,
	}, "\x00")
}

func (store *memoryWorkflowStore) GetWorkspaceWorkflowSnapshot(_ context.Context, workspaceID string, workflowID string) (workflowbiz.Snapshot, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.getCount++
	snapshot, exists := store.snapshots[workflowStoreKey(workspaceID, workflowID)]
	if !exists {
		return workflowbiz.Snapshot{}, errors.New("workflow not found")
	}
	return cloneWorkflowSnapshot(snapshot), nil
}

func (store *memoryWorkflowStore) ListPendingWorkflowCheckpointsBySourceSession(_ context.Context, workspaceID string, sourceSessionID string) ([]workflowbiz.PendingCheckpoint, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	result := make([]workflowbiz.PendingCheckpoint, 0)
	for _, snapshot := range store.snapshots {
		if snapshot.Workflow.WorkspaceID != workspaceID || snapshot.Workflow.SourceSessionID != sourceSessionID {
			continue
		}
		for _, checkpoint := range snapshot.Checkpoints {
			if checkpoint.Status != workflowbiz.CheckpointStatusPending {
				continue
			}
			for _, revision := range snapshot.Revisions {
				if revision.ID == checkpoint.RevisionID {
					result = append(result, workflowbiz.PendingCheckpoint{Workflow: snapshot.Workflow, Checkpoint: checkpoint, Revision: revision})
				}
			}
		}
	}
	return result, nil
}

func (store *memoryWorkflowStore) AppendWorkspaceWorkflowPlanRevision(_ context.Context, input workspacedata.AppendWorkspaceWorkflowPlanRevisionInput) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.appendWorkspaceWorkflowPlanRevisionLocked(input)
}

func (store *memoryWorkflowStore) AppendWorkspaceWorkflowPlanRevisionWithMutation(
	_ context.Context,
	input workspacedata.AppendWorkspaceWorkflowPlanRevisionMutationInput,
) (workflowbiz.WorkflowMutation, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	mutation, err := workflowbiz.NormalizeMutation(input.Mutation)
	if err != nil {
		return workflowbiz.WorkflowMutation{}, false, err
	}
	key := workflowMutationStoreKey(mutation)
	if existing, found := store.mutations[key]; found {
		if existing.InputSHA256 != mutation.InputSHA256 {
			return existing, false, workspacedata.ErrWorkflowMutationConflict
		}
		return existing, false, nil
	}
	if err := store.appendWorkspaceWorkflowPlanRevisionLocked(input.Append); err != nil {
		return workflowbiz.WorkflowMutation{}, false, err
	}
	store.mutations[key] = mutation
	return mutation, true, nil
}

func (store *memoryWorkflowStore) appendWorkspaceWorkflowPlanRevisionLocked(input workspacedata.AppendWorkspaceWorkflowPlanRevisionInput) error {
	if store.appendFailures > 0 {
		store.appendFailures--
		return errors.New("metadata commit failed")
	}
	key := workflowStoreKey(input.WorkspaceID, input.WorkflowID)
	snapshot, exists := store.snapshots[key]
	if !exists {
		return workspacedata.ErrWorkspaceWorkflowNotFound
	}
	snapshot = cloneWorkflowSnapshot(snapshot)
	if snapshot.Workflow.SourceSessionID != input.ExpectedSourceSessionID {
		return workspacedata.ErrWorkspaceWorkflowNotFound
	}
	current, ok := checkpointByID(snapshot.Checkpoints, input.ExpectedCheckpointID)
	if snapshot.Workflow.CurrentRevisionID != input.ExpectedCurrentRevisionID ||
		snapshot.Workflow.Status != input.ExpectedWorkflowStatus || !ok ||
		current.RevisionID != input.ExpectedCurrentRevisionID || current.Status != input.ExpectedCheckpointStatus {
		return workspacedata.ErrWorkflowRevisionConflict
	}
	for index := range snapshot.Checkpoints {
		if snapshot.Checkpoints[index].ID == input.ExpectedCheckpointID && snapshot.Checkpoints[index].Status == workflowbiz.CheckpointStatusPending {
			snapshot.Checkpoints[index].Status = workflowbiz.CheckpointStatusSuperseded
			snapshot.Checkpoints[index].UpdatedAt = input.UpdatedAt
			snapshot.Checkpoints[index].DecidedAt = input.UpdatedAt
		}
	}
	snapshot.Revisions = append(snapshot.Revisions, input.Revision)
	snapshot.Checkpoints = append(snapshot.Checkpoints, input.Checkpoint)
	snapshot.TurnLinks = append(snapshot.TurnLinks, input.TurnLinks...)
	snapshot.Workflow.CurrentRevisionID = input.Revision.ID
	snapshot.Workflow.Status = workflowbiz.WorkflowStatusPendingReview
	snapshot.Workflow.UpdatedAt = input.UpdatedAt
	if completion := input.CompleteOperation; completion != nil {
		completed := false
		for index := range snapshot.Operations {
			operation := &snapshot.Operations[index]
			if operation.ID == completion.OperationID && operation.Kind == completion.Kind && operation.RevisionID == completion.RevisionID && operation.Status == completion.ExpectedStatus {
				operation.Status = workflowbiz.OperationStatusSucceeded
				operation.ErrorCode = ""
				operation.ErrorMessage = ""
				operation.UpdatedAt = input.UpdatedAt
				operation.CompletedAt = input.UpdatedAt
				completed = true
				break
			}
		}
		if !completed {
			return workspacedata.ErrWorkflowRevisionConflict
		}
	}
	store.snapshots[key] = snapshot
	return nil
}

func (store *memoryWorkflowStore) ListRecoverableCreateIssueOperations(_ context.Context) ([]workspacedata.RecoverableCreateIssueOperation, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	result := make([]workspacedata.RecoverableCreateIssueOperation, 0)
	for _, snapshot := range store.snapshots {
		if snapshot.Workflow.Status != workflowbiz.WorkflowStatusAccepted {
			continue
		}
		for _, operation := range snapshot.Operations {
			if operation.Kind != workflowbiz.OperationKindCreateIssue ||
				(operation.Status != workflowbiz.OperationStatusPending && operation.Status != workflowbiz.OperationStatusFailed) {
				continue
			}
			checkpoint, found := checkpointForRevision(snapshot.Checkpoints, operation.RevisionID)
			if !found || checkpoint.Kind != workflowbiz.CheckpointKindTaskReview || checkpoint.Status != workflowbiz.CheckpointStatusAccepted {
				continue
			}
			result = append(result, workspacedata.RecoverableCreateIssueOperation{
				WorkspaceID: snapshot.Workflow.WorkspaceID, SourceSessionID: snapshot.Workflow.SourceSessionID,
				Checkpoint: checkpoint, Operation: operation,
			})
		}
	}
	return result, nil
}

func (store *memoryWorkflowStore) AppendWorkspaceWorkflowTurnLink(_ context.Context, workspaceID string, link workflowbiz.WorkflowTurnLink) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	key := workflowStoreKey(workspaceID, link.WorkflowID)
	snapshot := store.snapshots[key]
	snapshot.TurnLinks = append(snapshot.TurnLinks, link)
	store.snapshots[key] = snapshot
	return nil
}

func (store *memoryWorkflowStore) DecideWorkspaceWorkflowCheckpoint(_ context.Context, input workspacedata.DecideWorkspaceWorkflowCheckpointInput) (workflowbiz.WorkflowCheckpoint, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	key := workflowStoreKey(input.WorkspaceID, input.WorkflowID)
	snapshot, exists := store.snapshots[key]
	if !exists {
		return workflowbiz.WorkflowCheckpoint{}, false, errors.New("workflow not found")
	}
	snapshot = cloneWorkflowSnapshot(snapshot)
	for index := range snapshot.Checkpoints {
		checkpoint := &snapshot.Checkpoints[index]
		if checkpoint.ID != input.CheckpointID {
			continue
		}
		if checkpoint.Status != input.ExpectedStatus || checkpoint.RevisionID != input.ExpectedCurrentRevisionID ||
			snapshot.Workflow.CurrentRevisionID != input.ExpectedCurrentRevisionID || snapshot.Workflow.Status != input.ExpectedWorkflowStatus {
			return *checkpoint, false, nil
		}
		if input.Operation != nil {
			for _, operation := range snapshot.Operations {
				if operation.ID == input.Operation.ID {
					return workflowbiz.WorkflowCheckpoint{}, false, errors.New("duplicate operation")
				}
			}
		}
		checkpoint.Status = input.Decision
		checkpoint.DecidedBy = input.DecidedBy
		checkpoint.DecisionReason = input.DecisionReason
		checkpoint.DecidedAt = input.DecidedAt
		checkpoint.UpdatedAt = input.DecidedAt
		snapshot.Workflow.Status = input.WorkflowStatus
		snapshot.Workflow.UpdatedAt = input.DecidedAt
		if input.Operation != nil {
			snapshot.Operations = append(snapshot.Operations, *input.Operation)
		}
		store.snapshots[key] = snapshot
		return *checkpoint, true, nil
	}
	return workflowbiz.WorkflowCheckpoint{}, false, errors.New("checkpoint not found")
}

func (store *memoryWorkflowStore) RecordWorkspaceWorkflowOperation(_ context.Context, workspaceID string, operation workflowbiz.WorkflowOperation) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	key := workflowStoreKey(workspaceID, operation.WorkflowID)
	snapshot := store.snapshots[key]
	for _, current := range snapshot.Operations {
		if current.ID == operation.ID {
			return errors.New("duplicate operation")
		}
	}
	snapshot.Operations = append(snapshot.Operations, operation)
	store.snapshots[key] = snapshot
	return nil
}

func (store *memoryWorkflowStore) CompleteWorkspaceWorkflowOperation(_ context.Context, input workspacedata.CompleteWorkspaceWorkflowOperationInput) (workflowbiz.WorkflowOperation, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.completeFailures > 0 {
		store.completeFailures--
		return workflowbiz.WorkflowOperation{}, false, errors.New("operation completion failed")
	}
	key := workflowStoreKey(input.WorkspaceID, input.WorkflowID)
	snapshot := store.snapshots[key]
	for index := range snapshot.Operations {
		operation := &snapshot.Operations[index]
		if operation.ID != input.OperationID {
			continue
		}
		if operation.Status != input.ExpectedStatus &&
			(input.Status != workflowbiz.OperationStatusSucceeded || operation.Status != workflowbiz.OperationStatusFailed) {
			return *operation, false, nil
		}
		operation.Status = input.Status
		operation.IssueID = input.IssueID
		operation.ErrorCode = input.ErrorCode
		operation.ErrorMessage = input.ErrorMessage
		operation.CompletedAt = input.CompletedAt
		operation.UpdatedAt = input.CompletedAt
		store.snapshots[key] = snapshot
		return *operation, true, nil
	}
	return workflowbiz.WorkflowOperation{}, false, errors.New("operation not found")
}

func (store *memoryWorkflowStore) RetryWorkspaceWorkflowOperation(_ context.Context, input workspacedata.RetryWorkspaceWorkflowOperationInput) (workflowbiz.WorkflowOperation, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	key := workflowStoreKey(input.WorkspaceID, input.WorkflowID)
	snapshot := store.snapshots[key]
	for index := range snapshot.Operations {
		operation := &snapshot.Operations[index]
		if operation.ID != input.OperationID {
			continue
		}
		if operation.Status != workflowbiz.OperationStatusFailed {
			return *operation, false, nil
		}
		operation.Status = workflowbiz.OperationStatusPending
		operation.IssueID = ""
		operation.ErrorCode = ""
		operation.ErrorMessage = ""
		operation.StartedAt = time.Time{}
		operation.CompletedAt = time.Time{}
		operation.UpdatedAt = input.RetriedAt
		store.snapshots[key] = snapshot
		return *operation, true, nil
	}
	return workflowbiz.WorkflowOperation{}, false, errors.New("operation not found")
}

func cloneWorkflowSnapshot(snapshot workflowbiz.Snapshot) workflowbiz.Snapshot {
	snapshot.Revisions = append([]workflowbiz.PlanRevision(nil), snapshot.Revisions...)
	snapshot.Checkpoints = append([]workflowbiz.WorkflowCheckpoint(nil), snapshot.Checkpoints...)
	snapshot.TurnLinks = append([]workflowbiz.WorkflowTurnLink(nil), snapshot.TurnLinks...)
	snapshot.Operations = append([]workflowbiz.WorkflowOperation(nil), snapshot.Operations...)
	return snapshot
}

type recordingIssueMaterializer struct {
	inputs  []MaterializeIssueInput
	issueID string
	err     error
}

func (materializer *recordingIssueMaterializer) MaterializeIssue(_ context.Context, input MaterializeIssueInput) (string, error) {
	materializer.inputs = append(materializer.inputs, input)
	return materializer.issueID, materializer.err
}

type controlledConcurrentIssueMaterializer struct {
	entered chan int
	mu      sync.Mutex
	next    int
	release [2]chan struct{}
}

func newControlledConcurrentIssueMaterializer() *controlledConcurrentIssueMaterializer {
	return &controlledConcurrentIssueMaterializer{
		entered: make(chan int, 2),
		release: [2]chan struct{}{make(chan struct{}), make(chan struct{})},
	}
}

func (materializer *controlledConcurrentIssueMaterializer) MaterializeIssue(_ context.Context, _ MaterializeIssueInput) (string, error) {
	materializer.mu.Lock()
	call := materializer.next
	materializer.next++
	materializer.mu.Unlock()
	materializer.entered <- call
	<-materializer.release[call]
	if call == 0 {
		return "", errors.New("temporary concurrent failure")
	}
	return "issue-1", nil
}
