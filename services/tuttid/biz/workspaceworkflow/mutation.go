package workspaceworkflow

import (
	"fmt"
	"strings"
	"time"
)

// MutationKind identifies a caller-owned workflow mutation boundary. The
// request id belongs to this entity, rather than to a provider turn or UI
// interaction, so retries remain stable across process and transport loss.
type MutationKind string

const (
	MutationKindPropose MutationKind = "propose"
	MutationKindRevise  MutationKind = "revise"
)

func IsMutationKind(value MutationKind) bool {
	return value == MutationKindPropose || value == MutationKindRevise
}

// WorkflowMutation is the durable idempotency record for a Tutti-owned
// workflow mutation. ScopeID is empty for propose and the workflow id for
// revise. InputSHA256 detects accidental request-id reuse without treating
// identical content as the identity of an intentional mutation.
type WorkflowMutation struct {
	WorkspaceID     string
	SourceSessionID string
	Kind            MutationKind
	ScopeID         string
	RequestID       string
	InputSHA256     string
	WorkflowID      string
	RevisionID      string
	CheckpointID    string
	CreatedAt       time.Time
}

func NormalizeMutation(value WorkflowMutation) (WorkflowMutation, error) {
	value.WorkspaceID = strings.TrimSpace(value.WorkspaceID)
	value.SourceSessionID = strings.TrimSpace(value.SourceSessionID)
	value.ScopeID = strings.TrimSpace(value.ScopeID)
	value.RequestID = strings.TrimSpace(value.RequestID)
	value.InputSHA256 = strings.ToLower(strings.TrimSpace(value.InputSHA256))
	value.WorkflowID = strings.TrimSpace(value.WorkflowID)
	value.RevisionID = strings.TrimSpace(value.RevisionID)
	value.CheckpointID = strings.TrimSpace(value.CheckpointID)
	if value.WorkspaceID == "" || value.SourceSessionID == "" || value.RequestID == "" ||
		value.WorkflowID == "" || value.RevisionID == "" || value.CheckpointID == "" ||
		!IsMutationKind(value.Kind) || !sha256Pattern.MatchString(value.InputSHA256) || value.CreatedAt.IsZero() {
		return WorkflowMutation{}, fmt.Errorf("%w: invalid workflow mutation", ErrInvalidWorkflow)
	}
	switch value.Kind {
	case MutationKindPropose:
		if value.ScopeID != "" {
			return WorkflowMutation{}, fmt.Errorf("%w: propose mutation scope must be empty", ErrInvalidWorkflow)
		}
	case MutationKindRevise:
		if value.ScopeID == "" || value.ScopeID != value.WorkflowID {
			return WorkflowMutation{}, fmt.Errorf("%w: revise mutation scope must match workflow", ErrInvalidWorkflow)
		}
	}
	value.CreatedAt = value.CreatedAt.UTC()
	return value, nil
}
