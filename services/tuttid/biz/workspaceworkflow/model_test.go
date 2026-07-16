package workspaceworkflow

import (
	"errors"
	"testing"
	"time"
)

func TestNormalizeWorkflowAllowsOptionalTurnAndToolCallProvenance(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	workflow, err := NormalizeWorkflow(Workflow{
		ID:                " workflow-1 ",
		WorkspaceID:       " ws-1 ",
		Type:              WorkflowTypeTuttiModePlan,
		Owner:             WorkflowOwnerTutti,
		TriggerKind:       TriggerKindAgentCLI,
		SourceSessionID:   " session-1 ",
		Status:            WorkflowStatusPendingReview,
		CurrentRevisionID: " revision-1 ",
		CreatedAt:         now,
		UpdatedAt:         now,
	})
	if err != nil {
		t.Fatalf("NormalizeWorkflow() error = %v", err)
	}
	if workflow.SourceSessionID != "session-1" || workflow.SourceTurnID != "" || workflow.SourceToolCallID != "" {
		t.Fatalf("normalized provenance = %#v", workflow)
	}
}

func TestNormalizePlanRevisionRequiresDaemonOwnedRelativeMarkdownReference(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	base := PlanRevision{
		ID:               "revision-1",
		WorkflowID:       "workflow-1",
		Sequence:         1,
		SchemaVersion:    "tutti-mode-plan/v1",
		DocumentPath:     "workflow-plans/workflow-1/revision-1.md",
		SHA256:           "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		ProducedByTurnID: "turn-1",
		CreatedAt:        now,
	}
	if _, err := NormalizePlanRevision(base); err != nil {
		t.Fatalf("NormalizePlanRevision(valid) error = %v", err)
	}

	absolute := base
	absolute.DocumentPath = "/tmp/plan.md"
	if _, err := NormalizePlanRevision(absolute); !errors.Is(err, ErrInvalidWorkflow) {
		t.Fatalf("NormalizePlanRevision(absolute) error = %v, want ErrInvalidWorkflow", err)
	}
	escaping := base
	escaping.DocumentPath = "../plan.md"
	if _, err := NormalizePlanRevision(escaping); !errors.Is(err, ErrInvalidWorkflow) {
		t.Fatalf("NormalizePlanRevision(escaping) error = %v, want ErrInvalidWorkflow", err)
	}
	invalidHash := base
	invalidHash.SHA256 = "not-a-sha256"
	if _, err := NormalizePlanRevision(invalidHash); !errors.Is(err, ErrInvalidWorkflow) {
		t.Fatalf("NormalizePlanRevision(hash) error = %v, want ErrInvalidWorkflow", err)
	}
}

func TestNormalizeMutationKeepsRequestIdentitySeparateFromContent(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_000_000).UTC()
	mutation, err := NormalizeMutation(WorkflowMutation{
		WorkspaceID:     " workspace-1 ",
		SourceSessionID: " session-1 ",
		Kind:            MutationKindRevise,
		ScopeID:         " workflow-1 ",
		RequestID:       " request-1 ",
		InputSHA256:     "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
		WorkflowID:      " workflow-1 ",
		RevisionID:      " revision-2 ",
		CheckpointID:    " checkpoint-2 ",
		CreatedAt:       now,
	})
	if err != nil {
		t.Fatalf("NormalizeMutation() error = %v", err)
	}
	if mutation.RequestID != "request-1" || mutation.InputSHA256 != "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" || mutation.ScopeID != mutation.WorkflowID {
		t.Fatalf("normalized mutation = %#v", mutation)
	}

	invalidScope := mutation
	invalidScope.ScopeID = "other-workflow"
	if _, err := NormalizeMutation(invalidScope); !errors.Is(err, ErrInvalidWorkflow) {
		t.Fatalf("NormalizeMutation(scope mismatch) error = %v, want ErrInvalidWorkflow", err)
	}
}
