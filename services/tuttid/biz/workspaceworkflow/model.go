// Package workspaceworkflow defines Tutti-owned durable workflow state.
// Provider-owned agent interactions intentionally do not appear in this model.
package workspaceworkflow

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type WorkflowType string

const WorkflowTypeTuttiModePlan WorkflowType = "tutti_mode_plan"

type WorkflowOwner string

const WorkflowOwnerTutti WorkflowOwner = "tutti"

type TriggerKind string

const TriggerKindAgentCLI TriggerKind = "agent_cli"

type WorkflowStatus string

const (
	WorkflowStatusPendingReview WorkflowStatus = "pending_review"
	WorkflowStatusInProgress    WorkflowStatus = "in_progress"
	WorkflowStatusAccepted      WorkflowStatus = "accepted"
	WorkflowStatusRejected      WorkflowStatus = "rejected"
	WorkflowStatusCompleted     WorkflowStatus = "completed"
	WorkflowStatusFailed        WorkflowStatus = "failed"
	WorkflowStatusCanceled      WorkflowStatus = "canceled"
)

func IsWorkflowStatus(value WorkflowStatus) bool {
	switch value {
	case WorkflowStatusPendingReview,
		WorkflowStatusInProgress,
		WorkflowStatusAccepted,
		WorkflowStatusRejected,
		WorkflowStatusCompleted,
		WorkflowStatusFailed,
		WorkflowStatusCanceled:
		return true
	default:
		return false
	}
}

type Workflow struct {
	ID                string
	WorkspaceID       string
	Type              WorkflowType
	Owner             WorkflowOwner
	TriggerKind       TriggerKind
	SourceSessionID   string
	SourceTurnID      string
	SourceToolCallID  string
	Status            WorkflowStatus
	CurrentRevisionID string
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

type TurnRelation string

const (
	TurnRelationSource        TurnRelation = "source"
	TurnRelationDecomposition TurnRelation = "decomposition"
	TurnRelationRevision      TurnRelation = "revision"
	TurnRelationFeedback      TurnRelation = "feedback"
)

func IsTurnRelation(value TurnRelation) bool {
	switch value {
	case TurnRelationSource, TurnRelationDecomposition, TurnRelationRevision, TurnRelationFeedback:
		return true
	default:
		return false
	}
}

type WorkflowTurnLink struct {
	WorkflowID string
	TurnID     string
	Relation   TurnRelation
	CreatedAt  time.Time
}

// TuttiModePlan is the type-specific one-to-one marker for a workflow. Plan
// content lives in immutable Markdown revisions, not in SQLite.
type TuttiModePlan struct {
	WorkflowID string
}

type PlanRevision struct {
	ID               string
	WorkflowID       string
	Sequence         int
	SchemaVersion    string
	DocumentPath     string
	SHA256           string
	ProducedByTurnID string
	CreatedAt        time.Time
}

type CheckpointKind string

const (
	CheckpointKindConfigurationReview CheckpointKind = "configuration_review"
	CheckpointKindTaskReview          CheckpointKind = "task_review"
)

func IsCheckpointKind(value CheckpointKind) bool {
	switch value {
	case CheckpointKindConfigurationReview, CheckpointKindTaskReview:
		return true
	default:
		return false
	}
}

type CheckpointStatus string

const (
	CheckpointStatusPending    CheckpointStatus = "pending"
	CheckpointStatusAccepted   CheckpointStatus = "accepted"
	CheckpointStatusRejected   CheckpointStatus = "rejected"
	CheckpointStatusSuperseded CheckpointStatus = "superseded"
	CheckpointStatusCanceled   CheckpointStatus = "canceled"
)

func IsCheckpointStatus(value CheckpointStatus) bool {
	switch value {
	case CheckpointStatusPending,
		CheckpointStatusAccepted,
		CheckpointStatusRejected,
		CheckpointStatusSuperseded,
		CheckpointStatusCanceled:
		return true
	default:
		return false
	}
}

func IsCheckpointDecision(value CheckpointStatus) bool {
	switch value {
	case CheckpointStatusAccepted, CheckpointStatusRejected, CheckpointStatusCanceled:
		return true
	default:
		return false
	}
}

// TaskAssignment is one user-owned per-task assignment override recorded
// durably with an accepted task review decision. Nil fields keep the plan
// document value; empty strings explicitly clear it.
type TaskAssignment struct {
	TaskID           string
	AgentTargetID    *string
	ModelPlanID      *string
	Model            *string
	PermissionModeID *string
	ReasoningEffort  *string
	// Parallelizable overrides the plan document's per-task parallel opt-in.
	// Nil keeps the document value.
	Parallelizable *bool
}

type WorkflowCheckpoint struct {
	ID             string
	WorkflowID     string
	Kind           CheckpointKind
	RevisionID     string
	Status         CheckpointStatus
	DecidedBy      string
	DecisionReason string
	// TaskAssignments is recorded only on an accepted task review decision.
	TaskAssignments []TaskAssignment
	CreatedAt       time.Time
	UpdatedAt       time.Time
	DecidedAt       time.Time
}

type OperationKind string

const (
	OperationKindGenerateTaskGraph OperationKind = "generate_task_graph"
	OperationKindCreateRevision    OperationKind = "create_revision"
	OperationKindCreateIssue       OperationKind = "create_issue"
	OperationKindStartIssue        OperationKind = "start_issue"
)

func IsOperationKind(value OperationKind) bool {
	switch value {
	case OperationKindGenerateTaskGraph,
		OperationKindCreateRevision,
		OperationKindCreateIssue,
		OperationKindStartIssue:
		return true
	default:
		return false
	}
}

type OperationStatus string

const (
	OperationStatusPending   OperationStatus = "pending"
	OperationStatusRunning   OperationStatus = "running"
	OperationStatusSucceeded OperationStatus = "succeeded"
	OperationStatusFailed    OperationStatus = "failed"
	OperationStatusCanceled  OperationStatus = "canceled"
)

func IsOperationStatus(value OperationStatus) bool {
	switch value {
	case OperationStatusPending,
		OperationStatusRunning,
		OperationStatusSucceeded,
		OperationStatusFailed,
		OperationStatusCanceled:
		return true
	default:
		return false
	}
}

func IsTerminalOperationStatus(value OperationStatus) bool {
	switch value {
	case OperationStatusSucceeded, OperationStatusFailed, OperationStatusCanceled:
		return true
	default:
		return false
	}
}

type WorkflowOperation struct {
	ID           string
	WorkflowID   string
	Kind         OperationKind
	Status       OperationStatus
	RevisionID   string
	IssueID      string
	ErrorCode    string
	ErrorMessage string
	CreatedAt    time.Time
	UpdatedAt    time.Time
	StartedAt    time.Time
	CompletedAt  time.Time
}

type ProposalAggregate struct {
	Workflow   Workflow
	Plan       TuttiModePlan
	Revision   PlanRevision
	Checkpoint WorkflowCheckpoint
	TurnLinks  []WorkflowTurnLink
}

type Snapshot struct {
	Workflow    Workflow
	Plan        TuttiModePlan
	Revisions   []PlanRevision
	Checkpoints []WorkflowCheckpoint
	TurnLinks   []WorkflowTurnLink
	Operations  []WorkflowOperation
}

type PendingCheckpoint struct {
	Workflow   Workflow
	Checkpoint WorkflowCheckpoint
	Revision   PlanRevision
}

type ChangeKind string

const (
	ChangeKindProposalCreated   ChangeKind = "proposal_created"
	ChangeKindRevisionCreated   ChangeKind = "revision_created"
	ChangeKindCheckpointDecided ChangeKind = "checkpoint_decided"
	ChangeKindOperationUpdated  ChangeKind = "operation_updated"
)

type Update struct {
	WorkspaceID     string
	WorkflowID      string
	SourceSessionID string
	CheckpointID    string
	ChangeKind      ChangeKind
}

var ErrInvalidWorkflow = errors.New("invalid workspace workflow")

var sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func NormalizeProposalAggregate(value ProposalAggregate) (ProposalAggregate, error) {
	workflow, err := NormalizeWorkflow(value.Workflow)
	if err != nil {
		return ProposalAggregate{}, err
	}
	value.Workflow = workflow
	value.Plan.WorkflowID = strings.TrimSpace(value.Plan.WorkflowID)
	if value.Plan.WorkflowID != workflow.ID {
		return ProposalAggregate{}, fmt.Errorf("%w: plan workflow id must match workflow", ErrInvalidWorkflow)
	}
	revision, err := NormalizePlanRevision(value.Revision)
	if err != nil {
		return ProposalAggregate{}, err
	}
	if revision.WorkflowID != workflow.ID || workflow.CurrentRevisionID != revision.ID {
		return ProposalAggregate{}, fmt.Errorf("%w: initial revision must be the workflow current revision", ErrInvalidWorkflow)
	}
	value.Revision = revision
	checkpoint, err := NormalizeCheckpoint(value.Checkpoint)
	if err != nil {
		return ProposalAggregate{}, err
	}
	if checkpoint.WorkflowID != workflow.ID || checkpoint.RevisionID != revision.ID || checkpoint.Status != CheckpointStatusPending {
		return ProposalAggregate{}, fmt.Errorf("%w: initial pending checkpoint must bind the initial revision", ErrInvalidWorkflow)
	}
	value.Checkpoint = checkpoint
	for index, link := range value.TurnLinks {
		normalized, normalizeErr := NormalizeTurnLink(link)
		if normalizeErr != nil {
			return ProposalAggregate{}, normalizeErr
		}
		if normalized.WorkflowID != workflow.ID {
			return ProposalAggregate{}, fmt.Errorf("%w: turn link workflow id must match workflow", ErrInvalidWorkflow)
		}
		value.TurnLinks[index] = normalized
	}
	return value, nil
}

func NormalizeWorkflow(value Workflow) (Workflow, error) {
	value.ID = strings.TrimSpace(value.ID)
	value.WorkspaceID = strings.TrimSpace(value.WorkspaceID)
	value.SourceSessionID = strings.TrimSpace(value.SourceSessionID)
	value.SourceTurnID = strings.TrimSpace(value.SourceTurnID)
	value.SourceToolCallID = strings.TrimSpace(value.SourceToolCallID)
	value.CurrentRevisionID = strings.TrimSpace(value.CurrentRevisionID)
	if value.ID == "" || value.WorkspaceID == "" {
		return Workflow{}, fmt.Errorf("%w: workflow id and workspace id are required", ErrInvalidWorkflow)
	}
	if value.Type != WorkflowTypeTuttiModePlan || value.Owner != WorkflowOwnerTutti || value.TriggerKind != TriggerKindAgentCLI {
		return Workflow{}, fmt.Errorf("%w: unsupported workflow provenance", ErrInvalidWorkflow)
	}
	if value.SourceSessionID == "" {
		return Workflow{}, fmt.Errorf("%w: agent cli source session is required", ErrInvalidWorkflow)
	}
	if !IsWorkflowStatus(value.Status) || value.CurrentRevisionID == "" {
		return Workflow{}, fmt.Errorf("%w: valid status and current revision are required", ErrInvalidWorkflow)
	}
	if value.CreatedAt.IsZero() || value.UpdatedAt.IsZero() {
		return Workflow{}, fmt.Errorf("%w: workflow timestamps are required", ErrInvalidWorkflow)
	}
	value.CreatedAt = value.CreatedAt.UTC()
	value.UpdatedAt = value.UpdatedAt.UTC()
	return value, nil
}

func NormalizeTurnLink(value WorkflowTurnLink) (WorkflowTurnLink, error) {
	value.WorkflowID = strings.TrimSpace(value.WorkflowID)
	value.TurnID = strings.TrimSpace(value.TurnID)
	if value.WorkflowID == "" || value.TurnID == "" || !IsTurnRelation(value.Relation) || value.CreatedAt.IsZero() {
		return WorkflowTurnLink{}, fmt.Errorf("%w: invalid workflow turn link", ErrInvalidWorkflow)
	}
	value.CreatedAt = value.CreatedAt.UTC()
	return value, nil
}

func NormalizePlanRevision(value PlanRevision) (PlanRevision, error) {
	value.ID = strings.TrimSpace(value.ID)
	value.WorkflowID = strings.TrimSpace(value.WorkflowID)
	value.SchemaVersion = strings.TrimSpace(value.SchemaVersion)
	value.DocumentPath = filepath.ToSlash(strings.TrimSpace(value.DocumentPath))
	value.SHA256 = strings.ToLower(strings.TrimSpace(value.SHA256))
	value.ProducedByTurnID = strings.TrimSpace(value.ProducedByTurnID)
	if value.ID == "" || value.WorkflowID == "" || value.Sequence <= 0 || value.SchemaVersion == "" {
		return PlanRevision{}, fmt.Errorf("%w: incomplete plan revision", ErrInvalidWorkflow)
	}
	cleanPath := filepath.ToSlash(filepath.Clean(value.DocumentPath))
	if value.DocumentPath == "" || cleanPath == "." || filepath.IsAbs(value.DocumentPath) || cleanPath == ".." || strings.HasPrefix(cleanPath, "../") {
		return PlanRevision{}, fmt.Errorf("%w: document path must be daemon-owned and relative", ErrInvalidWorkflow)
	}
	value.DocumentPath = cleanPath
	if !sha256Pattern.MatchString(value.SHA256) {
		return PlanRevision{}, fmt.Errorf("%w: revision sha256 must be 64 lowercase hex characters", ErrInvalidWorkflow)
	}
	if value.CreatedAt.IsZero() {
		return PlanRevision{}, fmt.Errorf("%w: revision created at is required", ErrInvalidWorkflow)
	}
	value.CreatedAt = value.CreatedAt.UTC()
	return value, nil
}

// NormalizeTaskAssignments validates and canonicalizes per-task overrides.
// Task IDs must be unique and non-empty; nil override fields stay nil while
// non-nil values are trimmed (an explicit empty string clears the field).
func NormalizeTaskAssignments(values []TaskAssignment) ([]TaskAssignment, error) {
	if len(values) == 0 {
		return nil, nil
	}
	seen := make(map[string]struct{}, len(values))
	result := make([]TaskAssignment, 0, len(values))
	for _, value := range values {
		value.TaskID = strings.TrimSpace(value.TaskID)
		if value.TaskID == "" {
			return nil, fmt.Errorf("%w: task assignment requires a task id", ErrInvalidWorkflow)
		}
		if _, exists := seen[value.TaskID]; exists {
			return nil, fmt.Errorf("%w: duplicate task assignment for %q", ErrInvalidWorkflow, value.TaskID)
		}
		seen[value.TaskID] = struct{}{}
		value.AgentTargetID = trimStringPointer(value.AgentTargetID)
		value.ModelPlanID = trimStringPointer(value.ModelPlanID)
		value.Model = trimStringPointer(value.Model)
		value.PermissionModeID = trimStringPointer(value.PermissionModeID)
		value.ReasoningEffort = trimStringPointer(value.ReasoningEffort)
		result = append(result, value)
	}
	return result, nil
}

func trimStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	return &trimmed
}

func NormalizeCheckpoint(value WorkflowCheckpoint) (WorkflowCheckpoint, error) {
	value.ID = strings.TrimSpace(value.ID)
	value.WorkflowID = strings.TrimSpace(value.WorkflowID)
	value.RevisionID = strings.TrimSpace(value.RevisionID)
	value.DecidedBy = strings.TrimSpace(value.DecidedBy)
	value.DecisionReason = strings.TrimSpace(value.DecisionReason)
	normalizedAssignments, err := NormalizeTaskAssignments(value.TaskAssignments)
	if err != nil {
		return WorkflowCheckpoint{}, err
	}
	value.TaskAssignments = normalizedAssignments
	if value.ID == "" || value.WorkflowID == "" || value.RevisionID == "" || !IsCheckpointKind(value.Kind) || !IsCheckpointStatus(value.Status) {
		return WorkflowCheckpoint{}, fmt.Errorf("%w: invalid workflow checkpoint", ErrInvalidWorkflow)
	}
	if value.CreatedAt.IsZero() || value.UpdatedAt.IsZero() {
		return WorkflowCheckpoint{}, fmt.Errorf("%w: checkpoint timestamps are required", ErrInvalidWorkflow)
	}
	value.CreatedAt = value.CreatedAt.UTC()
	value.UpdatedAt = value.UpdatedAt.UTC()
	if !value.DecidedAt.IsZero() {
		value.DecidedAt = value.DecidedAt.UTC()
	}
	return value, nil
}

func NormalizeOperation(value WorkflowOperation) (WorkflowOperation, error) {
	value.ID = strings.TrimSpace(value.ID)
	value.WorkflowID = strings.TrimSpace(value.WorkflowID)
	value.RevisionID = strings.TrimSpace(value.RevisionID)
	value.IssueID = strings.TrimSpace(value.IssueID)
	value.ErrorCode = strings.TrimSpace(value.ErrorCode)
	value.ErrorMessage = strings.TrimSpace(value.ErrorMessage)
	if value.ID == "" || value.WorkflowID == "" || !IsOperationKind(value.Kind) || !IsOperationStatus(value.Status) {
		return WorkflowOperation{}, fmt.Errorf("%w: invalid workflow operation", ErrInvalidWorkflow)
	}
	if value.CreatedAt.IsZero() || value.UpdatedAt.IsZero() {
		return WorkflowOperation{}, fmt.Errorf("%w: operation timestamps are required", ErrInvalidWorkflow)
	}
	value.CreatedAt = value.CreatedAt.UTC()
	value.UpdatedAt = value.UpdatedAt.UTC()
	if !value.StartedAt.IsZero() {
		value.StartedAt = value.StartedAt.UTC()
	}
	if !value.CompletedAt.IsZero() {
		value.CompletedAt = value.CompletedAt.UTC()
	}
	return value, nil
}
