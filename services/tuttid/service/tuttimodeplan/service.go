// Package tuttimodeplan orchestrates Tutti-owned, durable plan review
// workflows. Agent sessions and turns are provenance; the workflow, immutable
// Markdown revisions, checkpoints, and follow-up operations are Tutti state.
package tuttimodeplan

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	tuttimodeactivation "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeactivation"
)

const defaultWaitInterval = 100 * time.Millisecond

var (
	ErrInvalidInput       = errors.New("invalid Tutti Mode Plan input")
	ErrInvalidTransition  = errors.New("invalid Tutti Mode Plan transition")
	ErrInvalidDecision    = errors.New("invalid Tutti Mode Plan decision")
	ErrDecisionConflict   = errors.New("tutti mode plan checkpoint decision conflicts with durable state")
	ErrMutationConflict   = errors.New("tutti mode plan request id conflicts with a prior mutation")
	ErrCheckpointMissing  = errors.New("tutti mode plan checkpoint was not found")
	ErrServiceUnavailable = errors.New("tutti mode plan service is unavailable")
	// ErrTuttiModeDisabled rejects writes while the lab.tuttiMode feature
	// flag is off. Reads (Get/List/Wait) stay available so existing workflows
	// remain inspectable.
	ErrTuttiModeDisabled = errors.New("tutti mode is disabled by the lab.tuttiMode feature flag")
)

// Store is the durable workflow surface owned by the workspace data layer.
type Store interface {
	CreateWorkspaceWorkflowProposalWithMutation(context.Context, workspacedata.CreateWorkspaceWorkflowProposalMutationInput) (workflowbiz.WorkflowMutation, bool, error)
	GetWorkspaceWorkflowMutation(context.Context, workspacedata.GetWorkspaceWorkflowMutationInput) (workflowbiz.WorkflowMutation, bool, error)
	GetWorkspaceWorkflowSnapshot(context.Context, string, string) (workflowbiz.Snapshot, error)
	ListWorkflowsBySourceSession(context.Context, string, string) ([]workflowbiz.Workflow, error)
	ListPendingWorkflowCheckpointsBySourceSession(context.Context, string, string) ([]workflowbiz.PendingCheckpoint, error)
	AppendWorkspaceWorkflowPlanRevisionWithMutation(context.Context, workspacedata.AppendWorkspaceWorkflowPlanRevisionMutationInput) (workflowbiz.WorkflowMutation, bool, error)
	AppendWorkspaceWorkflowTurnLink(context.Context, string, workflowbiz.WorkflowTurnLink) error
	DecideWorkspaceWorkflowCheckpoint(context.Context, workspacedata.DecideWorkspaceWorkflowCheckpointInput) (workflowbiz.WorkflowCheckpoint, bool, error)
	RecordWorkspaceWorkflowOperation(context.Context, string, workflowbiz.WorkflowOperation) error
	RetryWorkspaceWorkflowOperation(context.Context, workspacedata.RetryWorkspaceWorkflowOperationInput) (workflowbiz.WorkflowOperation, bool, error)
	CompleteWorkspaceWorkflowOperation(context.Context, workspacedata.CompleteWorkspaceWorkflowOperationInput) (workflowbiz.WorkflowOperation, bool, error)
	ListRecoverableCreateIssueOperations(context.Context) ([]workspacedata.RecoverableCreateIssueOperation, error)
	ListPendingConfigurationReviewCheckpoints(context.Context) ([]workspacedata.PendingConfigurationReviewCheckpoint, error)
}

// SourceSessionDeletionStore executes a service-authorized transaction
// command without owning the workflow cancellation policy.
type SourceSessionDeletionStore interface {
	ExecuteSourceSessionDeletion(context.Context, workspacedata.SourceSessionDeletionCommand) (workspacedata.SourceSessionDeletionResult, error)
}

type Publisher interface {
	PublishWorkspaceWorkflowUpdated(context.Context, workflowbiz.Update) error
}

// RevisionContentStore is the daemon-owned immutable content seam. Parsing and
// workflow transitions stay in this package; the data-layer adapter owns local
// filesystem durability and digest verification.
type RevisionContentStore interface {
	Write(workflowID string, raw []byte) (documentPath string, sha256 string, err error)
	Read(workflowID string, documentPath string, expectedSHA256 string) ([]byte, error)
}

// IssueMaterializer is the downstream Tutti capability used after a user
// accepts the current task graph. The workflow service remains authoritative
// for when materialization is allowed and which revision is executable.
type IssueMaterializer interface {
	MaterializeIssue(context.Context, MaterializeIssueInput) (string, error)
}

type MaterializeIssueInput struct {
	WorkspaceID     string
	WorkflowID      string
	RevisionID      string
	SourceSessionID string
	Title           string
	Content         string
	TopicID         string
	Execution       PlanExecution
	Budget          PlanBudget
	ActionableItems []ActionableItem
}

// FeedbackDispatcher lets the daemon composition drive the source Agent
// session after the user requests changes on the single review checkpoint.
// The decision itself stays durable regardless of dispatch outcome.
type FeedbackDispatcher interface {
	DispatchPlanRevisionFeedback(context.Context, PlanRevisionFeedbackInput) error
}

type PlanRevisionFeedbackInput struct {
	WorkspaceID     string
	WorkflowID      string
	CheckpointID    string
	RevisionID      string
	SourceSessionID string
	Feedback        string
}

type Service struct {
	Store                  Store
	SourceSessionDeletions SourceSessionDeletionStore
	Revisions              RevisionContentStore
	Publisher              Publisher
	IssueMaterializer      IssueMaterializer
	FeedbackDispatcher     FeedbackDispatcher
	// FeatureFlags reads the desktop preferences feature-flag map. Nil keeps
	// every write allowed; when set, Propose/Revise/Decide are rejected with
	// ErrTuttiModeDisabled unless lab.tuttiMode is true.
	FeatureFlags func(context.Context) (map[string]bool, error)
	Now          func() time.Time
	NewID        func() string
	WaitInterval time.Duration
}

type ProposeInput struct {
	WorkspaceID      string
	SourceSessionID  string
	SourceTurnID     string
	SourceToolCallID string
	RequestID        string
	Markdown         []byte
}

type ProposalResult struct {
	Snapshot  workflowbiz.Snapshot
	Document  PlanDocument
	RequestID string
	Replayed  bool
}

type ReviseInput struct {
	WorkspaceID      string
	WorkflowID       string
	ProducedByTurnID string
	RequestID        string
	Markdown         []byte
}

type RevisionResult struct {
	Snapshot   workflowbiz.Snapshot
	Revision   workflowbiz.PlanRevision
	Checkpoint workflowbiz.WorkflowCheckpoint
	Document   PlanDocument
	RequestID  string
	Replayed   bool
}

type GetInput struct {
	WorkspaceID string
	WorkflowID  string
}

type RevisionView struct {
	Revision workflowbiz.PlanRevision
	Document PlanDocument
}

type SnapshotView struct {
	Workflow    workflowbiz.Workflow
	Plan        workflowbiz.TuttiModePlan
	Revisions   []RevisionView
	Checkpoints []workflowbiz.WorkflowCheckpoint
	TurnLinks   []workflowbiz.WorkflowTurnLink
	Operations  []workflowbiz.WorkflowOperation
	// ActionableItems is a derived projection. It is never persisted separately
	// from the accepted current Markdown revision.
	ActionableItems []ActionableItem
}

type DecideInput struct {
	WorkspaceID    string
	WorkflowID     string
	CheckpointID   string
	Decision       workflowbiz.CheckpointStatus
	DecidedBy      string
	DecisionReason string
	// TaskAssignments carries user-owned per-task overrides. It is only valid
	// when accepting a task review checkpoint.
	TaskAssignments []workflowbiz.TaskAssignment
}

type NextAction string

const (
	NextActionGenerateTaskGraph   NextAction = "generate_task_graph"
	NextActionReviseConfiguration NextAction = "revise_configuration"
	NextActionReviseTaskGraph     NextAction = "revise_task_graph"
	NextActionCreateIssue         NextAction = "create_issue"
	NextActionIssueCreated        NextAction = "issue_created"
	NextActionCanceled            NextAction = "canceled"
	NextActionSuperseded          NextAction = "superseded"
)

type DecisionResult struct {
	Checkpoint workflowbiz.WorkflowCheckpoint
	Changed    bool
	NextAction NextAction
	Operation  *workflowbiz.WorkflowOperation
}

type WaitInput struct {
	WorkspaceID  string
	WorkflowID   string
	CheckpointID string
}

type WaitResult struct {
	Checkpoint workflowbiz.WorkflowCheckpoint
	NextAction NextAction
	Operation  *workflowbiz.WorkflowOperation
}

// NextActionForCheckpoint maps an observed durable checkpoint state to the
// Agent's next permitted action. Pending is intentionally not an action: the
// Agent may only wait while the user owns the decision boundary.
func NextActionForCheckpoint(checkpoint workflowbiz.WorkflowCheckpoint) (NextAction, bool) {
	if checkpoint.Status == workflowbiz.CheckpointStatusPending {
		return "", false
	}
	if checkpoint.Status == workflowbiz.CheckpointStatusSuperseded {
		return NextActionSuperseded, true
	}
	next, _, _, err := decisionTransition(checkpoint.Kind, checkpoint.Status)
	return next, err == nil
}

func (s *Service) Propose(ctx context.Context, input ProposeInput) (ProposalResult, error) {
	if err := s.ready(); err != nil {
		return ProposalResult{}, err
	}
	if err := s.requireTuttiModeEnabled(ctx); err != nil {
		return ProposalResult{}, err
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.SourceSessionID = strings.TrimSpace(input.SourceSessionID)
	input.SourceTurnID = strings.TrimSpace(input.SourceTurnID)
	input.SourceToolCallID = strings.TrimSpace(input.SourceToolCallID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	if input.WorkspaceID == "" || input.SourceSessionID == "" || input.RequestID == "" {
		return ProposalResult{}, fmt.Errorf("%w: workspace, source session, and request id are required", ErrInvalidInput)
	}
	if err := validateMutationRequestID(input.RequestID); err != nil {
		return ProposalResult{}, err
	}
	inputDigest := mutationInputSHA256(input.Markdown)
	if mutation, found, err := s.findMutation(ctx, workspacedata.GetWorkspaceWorkflowMutationInput{
		WorkspaceID: input.WorkspaceID, SourceSessionID: input.SourceSessionID,
		Kind: workflowbiz.MutationKindPropose, RequestID: input.RequestID,
	}, inputDigest); err != nil {
		return ProposalResult{}, err
	} else if found {
		return s.proposalResultFromMutation(ctx, mutation, true)
	}
	document, err := ParsePlanMarkdown(input.Markdown)
	if err != nil {
		return ProposalResult{}, err
	}
	if document.Phase != PhaseTaskGraph {
		return ProposalResult{}, fmt.Errorf("%w: the proposal must contain the complete plan narrative and task graph in one document", ErrInvalidTransition)
	}
	if err := ValidatePlanExecutionIsolation(document); err != nil {
		return ProposalResult{}, err
	}

	now := s.now()
	workflowID := s.newID()
	revisionID := s.newID()
	checkpointID := s.newID()
	if workflowID == "" || revisionID == "" || checkpointID == "" {
		return ProposalResult{}, fmt.Errorf("%w: generated ids must not be empty", ErrInvalidInput)
	}
	documentPath, digest, err := s.Revisions.Write(workflowID, input.Markdown)
	if err != nil {
		return ProposalResult{}, err
	}

	workflow := workflowbiz.Workflow{
		ID:                workflowID,
		WorkspaceID:       input.WorkspaceID,
		Type:              workflowbiz.WorkflowTypeTuttiModePlan,
		Owner:             workflowbiz.WorkflowOwnerTutti,
		TriggerKind:       workflowbiz.TriggerKindAgentCLI,
		SourceSessionID:   input.SourceSessionID,
		SourceTurnID:      input.SourceTurnID,
		SourceToolCallID:  input.SourceToolCallID,
		Status:            workflowbiz.WorkflowStatusPendingReview,
		CurrentRevisionID: revisionID,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	revision := workflowbiz.PlanRevision{
		ID:               revisionID,
		WorkflowID:       workflowID,
		Sequence:         1,
		SchemaVersion:    document.Schema,
		DocumentPath:     documentPath,
		SHA256:           digest,
		ProducedByTurnID: input.SourceTurnID,
		CreatedAt:        now,
	}
	checkpoint := workflowbiz.WorkflowCheckpoint{
		ID:         checkpointID,
		WorkflowID: workflowID,
		Kind:       workflowbiz.CheckpointKindTaskReview,
		RevisionID: revisionID,
		Status:     workflowbiz.CheckpointStatusPending,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	mutation := workflowbiz.WorkflowMutation{
		WorkspaceID:     input.WorkspaceID,
		SourceSessionID: input.SourceSessionID,
		Kind:            workflowbiz.MutationKindPropose,
		RequestID:       input.RequestID,
		InputSHA256:     inputDigest,
		WorkflowID:      workflowID,
		RevisionID:      revisionID,
		CheckpointID:    checkpointID,
		CreatedAt:       now,
	}
	aggregate := workflowbiz.ProposalAggregate{
		Workflow:   workflow,
		Plan:       workflowbiz.TuttiModePlan{WorkflowID: workflowID},
		Revision:   revision,
		Checkpoint: checkpoint,
	}
	if input.SourceTurnID != "" {
		aggregate.TurnLinks = []workflowbiz.WorkflowTurnLink{{
			WorkflowID: workflowID,
			TurnID:     input.SourceTurnID,
			Relation:   workflowbiz.TurnRelationSource,
			CreatedAt:  now,
		}}
	}
	committedMutation, created, err := s.Store.CreateWorkspaceWorkflowProposalWithMutation(ctx, workspacedata.CreateWorkspaceWorkflowProposalMutationInput{
		Aggregate: aggregate,
		Mutation:  mutation,
	})
	if err != nil {
		return ProposalResult{}, mutationStoreError(err)
	}
	if !created {
		return s.proposalResultFromMutation(ctx, committedMutation, true)
	}
	s.publish(ctx, workflowbiz.Update{
		WorkspaceID:     input.WorkspaceID,
		WorkflowID:      workflowID,
		SourceSessionID: input.SourceSessionID,
		CheckpointID:    checkpointID,
		ChangeKind:      workflowbiz.ChangeKindProposalCreated,
	})
	return s.proposalResultFromMutation(ctx, committedMutation, false)
}

func (s *Service) Revise(ctx context.Context, input ReviseInput) (RevisionResult, error) {
	return s.revise(ctx, input, "")
}

func (s *Service) revise(ctx context.Context, input ReviseInput, expectedSourceSessionID string) (RevisionResult, error) {
	if err := s.ready(); err != nil {
		return RevisionResult{}, err
	}
	if err := s.requireTuttiModeEnabled(ctx); err != nil {
		return RevisionResult{}, err
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.WorkflowID = strings.TrimSpace(input.WorkflowID)
	input.ProducedByTurnID = strings.TrimSpace(input.ProducedByTurnID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	if input.WorkspaceID == "" || input.WorkflowID == "" || input.RequestID == "" {
		return RevisionResult{}, fmt.Errorf("%w: workspace, workflow, and request id are required", ErrInvalidInput)
	}
	if err := validateMutationRequestID(input.RequestID); err != nil {
		return RevisionResult{}, err
	}
	snapshot, err := s.Get(ctx, GetInput{WorkspaceID: input.WorkspaceID, WorkflowID: input.WorkflowID})
	if err != nil {
		return RevisionResult{}, err
	}
	if err := requireWorkflowSourceSession(snapshot, expectedSourceSessionID); err != nil {
		return RevisionResult{}, err
	}
	inputDigest := mutationInputSHA256(input.Markdown)
	if mutation, found, err := s.findMutation(ctx, workspacedata.GetWorkspaceWorkflowMutationInput{
		WorkspaceID: input.WorkspaceID, SourceSessionID: snapshot.Workflow.SourceSessionID,
		Kind: workflowbiz.MutationKindRevise, ScopeID: input.WorkflowID, RequestID: input.RequestID,
	}, inputDigest); err != nil {
		return RevisionResult{}, err
	} else if found {
		return s.revisionResultFromMutation(ctx, mutation, true)
	}
	document, err := ParsePlanMarkdown(input.Markdown)
	if err != nil {
		return RevisionResult{}, err
	}
	if err := ValidatePlanExecutionIsolation(document); err != nil {
		return RevisionResult{}, err
	}
	if isTerminalWorkflow(snapshot.Workflow.Status) {
		return RevisionResult{}, fmt.Errorf("%w: workflow is %s", ErrInvalidTransition, snapshot.Workflow.Status)
	}
	current, ok := checkpointForRevision(snapshot.Checkpoints, snapshot.Workflow.CurrentRevisionID)
	if !ok {
		return RevisionResult{}, ErrCheckpointMissing
	}
	if err := validateRevisionPhase(current, document.Phase); err != nil {
		return RevisionResult{}, err
	}
	completion, err := s.revisionOperationCompletion(ctx, input.WorkspaceID, snapshot, current)
	if err != nil {
		return RevisionResult{}, err
	}

	nextSequence := nextRevisionSequence(snapshot.Revisions)
	now := s.now()
	revisionID := s.newID()
	checkpointID := s.newID()
	if revisionID == "" || checkpointID == "" {
		return RevisionResult{}, fmt.Errorf("%w: generated ids must not be empty", ErrInvalidInput)
	}
	documentPath, digest, err := s.Revisions.Write(input.WorkflowID, input.Markdown)
	if err != nil {
		return RevisionResult{}, err
	}
	revision := workflowbiz.PlanRevision{
		ID:               revisionID,
		WorkflowID:       input.WorkflowID,
		Sequence:         nextSequence,
		SchemaVersion:    document.Schema,
		DocumentPath:     documentPath,
		SHA256:           digest,
		ProducedByTurnID: input.ProducedByTurnID,
		CreatedAt:        now,
	}
	checkpoint := workflowbiz.WorkflowCheckpoint{
		ID:         checkpointID,
		WorkflowID: input.WorkflowID,
		Kind:       checkpointKindForPhase(document.Phase),
		RevisionID: revisionID,
		Status:     workflowbiz.CheckpointStatusPending,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	mutation := workflowbiz.WorkflowMutation{
		WorkspaceID:     input.WorkspaceID,
		SourceSessionID: snapshot.Workflow.SourceSessionID,
		Kind:            workflowbiz.MutationKindRevise,
		ScopeID:         input.WorkflowID,
		RequestID:       input.RequestID,
		InputSHA256:     inputDigest,
		WorkflowID:      input.WorkflowID,
		RevisionID:      revisionID,
		CheckpointID:    checkpointID,
		CreatedAt:       now,
	}
	relation := workflowbiz.TurnRelationRevision
	if document.Phase == PhaseTaskGraph {
		relation = workflowbiz.TurnRelationDecomposition
	}
	appendInput := workspacedata.AppendWorkspaceWorkflowPlanRevisionInput{
		WorkspaceID:               input.WorkspaceID,
		WorkflowID:                input.WorkflowID,
		ExpectedSourceSessionID:   snapshot.Workflow.SourceSessionID,
		ExpectedCurrentRevisionID: snapshot.Workflow.CurrentRevisionID,
		ExpectedWorkflowStatus:    snapshot.Workflow.Status,
		ExpectedCheckpointID:      current.ID,
		ExpectedCheckpointStatus:  current.Status,
		Revision:                  revision,
		Checkpoint:                checkpoint,
		CompleteOperation:         completion,
		UpdatedAt:                 now,
	}
	if input.ProducedByTurnID != "" {
		appendInput.TurnLinks = []workflowbiz.WorkflowTurnLink{{
			WorkflowID: input.WorkflowID,
			TurnID:     input.ProducedByTurnID,
			Relation:   relation,
			CreatedAt:  now,
		}}
	}
	committedMutation, created, err := s.Store.AppendWorkspaceWorkflowPlanRevisionWithMutation(ctx, workspacedata.AppendWorkspaceWorkflowPlanRevisionMutationInput{
		Append:   appendInput,
		Mutation: mutation,
	})
	if err != nil {
		return RevisionResult{}, mutationStoreError(err)
	}
	if !created {
		return s.revisionResultFromMutation(ctx, committedMutation, true)
	}
	s.publish(ctx, workflowbiz.Update{
		WorkspaceID:     input.WorkspaceID,
		WorkflowID:      input.WorkflowID,
		SourceSessionID: snapshot.Workflow.SourceSessionID,
		CheckpointID:    checkpointID,
		ChangeKind:      workflowbiz.ChangeKindRevisionCreated,
	})
	return s.revisionResultFromMutation(ctx, committedMutation, false)
}

func (s *Service) Decide(ctx context.Context, input DecideInput) (DecisionResult, error) {
	if err := s.ready(); err != nil {
		return DecisionResult{}, err
	}
	if err := s.requireTuttiModeEnabled(ctx); err != nil {
		return DecisionResult{}, err
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.WorkflowID = strings.TrimSpace(input.WorkflowID)
	input.CheckpointID = strings.TrimSpace(input.CheckpointID)
	input.DecidedBy = strings.TrimSpace(input.DecidedBy)
	input.DecisionReason = strings.TrimSpace(input.DecisionReason)
	if input.WorkspaceID == "" || input.WorkflowID == "" || input.CheckpointID == "" || input.DecidedBy == "" {
		return DecisionResult{}, fmt.Errorf("%w: workspace, workflow, checkpoint, and decision actor are required", ErrInvalidDecision)
	}
	if !workflowbiz.IsCheckpointDecision(input.Decision) {
		return DecisionResult{}, fmt.Errorf("%w: unsupported checkpoint decision %q", ErrInvalidDecision, input.Decision)
	}
	if input.Decision == workflowbiz.CheckpointStatusRejected && input.DecisionReason == "" {
		return DecisionResult{}, fmt.Errorf("%w: rejection feedback is required", ErrInvalidDecision)
	}

	snapshot, err := s.Get(ctx, GetInput{WorkspaceID: input.WorkspaceID, WorkflowID: input.WorkflowID})
	if err != nil {
		return DecisionResult{}, err
	}
	checkpoint, ok := checkpointByID(snapshot.Checkpoints, input.CheckpointID)
	if !ok || checkpoint.RevisionID != snapshot.Workflow.CurrentRevisionID {
		return DecisionResult{}, ErrCheckpointMissing
	}
	nextAction, workflowStatus, operationKind, err := decisionTransition(checkpoint.Kind, input.Decision)
	if err != nil {
		return DecisionResult{}, err
	}
	assignments, err := s.validatedDecisionTaskAssignments(input, snapshot, checkpoint)
	if err != nil {
		return DecisionResult{}, err
	}
	if checkpoint.Status != workflowbiz.CheckpointStatusPending {
		if checkpoint.Status != input.Decision {
			return DecisionResult{}, ErrDecisionConflict
		}
		// A replayed decision keeps the durable assignments recorded with the
		// original decision; late-supplied overrides are ignored.
		operation, ensureErr := s.ensureAndExecuteDecisionOperation(ctx, input.WorkspaceID, snapshot, checkpoint, operationKind)
		if ensureErr != nil {
			return DecisionResult{}, ensureErr
		}
		return DecisionResult{Checkpoint: checkpoint, NextAction: nextActionAfterOperation(nextAction, operation), Operation: operation}, nil
	}

	now := s.now()
	pendingOperation, err := newDecisionOperation(snapshot, checkpoint, operationKind, now)
	if err != nil {
		return DecisionResult{}, err
	}
	decided, changed, err := s.Store.DecideWorkspaceWorkflowCheckpoint(ctx, workspacedata.DecideWorkspaceWorkflowCheckpointInput{
		WorkspaceID:               input.WorkspaceID,
		WorkflowID:                input.WorkflowID,
		CheckpointID:              input.CheckpointID,
		ExpectedStatus:            workflowbiz.CheckpointStatusPending,
		ExpectedCurrentRevisionID: snapshot.Workflow.CurrentRevisionID,
		ExpectedWorkflowStatus:    snapshot.Workflow.Status,
		Decision:                  input.Decision,
		DecidedBy:                 input.DecidedBy,
		DecisionReason:            input.DecisionReason,
		TaskAssignments:           assignments,
		DecidedAt:                 now,
		WorkflowStatus:            workflowStatus,
		Operation:                 pendingOperation,
	})
	if err != nil {
		return DecisionResult{}, err
	}
	if !changed && decided.Status != input.Decision {
		return DecisionResult{}, ErrDecisionConflict
	}
	decidedSnapshot := snapshot
	decidedSnapshot.Workflow.Status = workflowStatus
	decidedSnapshot.Workflow.UpdatedAt = now
	for index := range decidedSnapshot.Checkpoints {
		if decidedSnapshot.Checkpoints[index].ID == decided.ID {
			decidedSnapshot.Checkpoints[index] = decided
		}
	}
	if changed {
		s.publish(ctx, workflowbiz.Update{
			WorkspaceID:     input.WorkspaceID,
			WorkflowID:      input.WorkflowID,
			SourceSessionID: snapshot.Workflow.SourceSessionID,
			CheckpointID:    decided.ID,
			ChangeKind:      workflowbiz.ChangeKindCheckpointDecided,
		})
	}
	var operation *workflowbiz.WorkflowOperation
	if changed {
		operation, err = s.executeDecisionOperation(ctx, input.WorkspaceID, decidedSnapshot, decided, pendingOperation)
	} else {
		operation, err = s.ensureAndExecuteDecisionOperation(ctx, input.WorkspaceID, decidedSnapshot, decided, operationKind)
	}
	if err != nil {
		return DecisionResult{}, err
	}
	if changed && decided.Status == workflowbiz.CheckpointStatusRejected &&
		decided.Kind == workflowbiz.CheckpointKindTaskReview && s.FeedbackDispatcher != nil {
		// The rejection is already durable. Dispatch failure must not turn the
		// committed decision into an apparent error; the Agent can still
		// observe the rejection through plan get/wait.
		_ = s.FeedbackDispatcher.DispatchPlanRevisionFeedback(ctx, PlanRevisionFeedbackInput{
			WorkspaceID:     input.WorkspaceID,
			WorkflowID:      input.WorkflowID,
			CheckpointID:    decided.ID,
			RevisionID:      decided.RevisionID,
			SourceSessionID: snapshot.Workflow.SourceSessionID,
			Feedback:        input.DecisionReason,
		})
	}
	return DecisionResult{
		Checkpoint: decided,
		Changed:    changed,
		NextAction: nextActionAfterOperation(nextAction, operation),
		Operation:  operation,
	}, nil
}

// validatedDecisionTaskAssignments enforces the accept-only, task-review-only
// scope of per-task overrides and verifies every override targets a task in
// the current revision document.
func (s *Service) validatedDecisionTaskAssignments(
	input DecideInput,
	snapshot workflowbiz.Snapshot,
	checkpoint workflowbiz.WorkflowCheckpoint,
) ([]workflowbiz.TaskAssignment, error) {
	assignments, err := workflowbiz.NormalizeTaskAssignments(input.TaskAssignments)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidDecision, err)
	}
	if len(assignments) == 0 {
		return nil, nil
	}
	if input.Decision != workflowbiz.CheckpointStatusAccepted || checkpoint.Kind != workflowbiz.CheckpointKindTaskReview {
		return nil, fmt.Errorf("%w: task assignments are only valid when accepting a task review", ErrInvalidDecision)
	}
	revision, found := revisionByID(snapshot.Revisions, checkpoint.RevisionID)
	if !found {
		return nil, ErrCheckpointMissing
	}
	raw, err := s.Revisions.Read(snapshot.Workflow.ID, revision.DocumentPath, revision.SHA256)
	if err != nil {
		return nil, err
	}
	document, err := ParsePlanMarkdown(raw)
	if err != nil {
		return nil, err
	}
	knownTasks := make(map[string]struct{}, len(document.Tasks))
	for _, task := range document.Tasks {
		knownTasks[task.ID] = struct{}{}
	}
	for _, assignment := range assignments {
		if _, ok := knownTasks[assignment.TaskID]; !ok {
			return nil, fmt.Errorf("%w: task assignment references unknown task %q", ErrInvalidDecision, assignment.TaskID)
		}
	}
	return assignments, nil
}

func (s *Service) Wait(ctx context.Context, input WaitInput) (WaitResult, error) {
	return s.wait(ctx, input, "")
}

func (s *Service) wait(ctx context.Context, input WaitInput, expectedSourceSessionID string) (WaitResult, error) {
	if err := s.ready(); err != nil {
		return WaitResult{}, err
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.WorkflowID = strings.TrimSpace(input.WorkflowID)
	input.CheckpointID = strings.TrimSpace(input.CheckpointID)
	if input.WorkspaceID == "" || input.WorkflowID == "" || input.CheckpointID == "" {
		return WaitResult{}, fmt.Errorf("%w: workspace, workflow, and checkpoint are required", ErrInvalidInput)
	}
	interval := s.WaitInterval
	if interval <= 0 {
		interval = defaultWaitInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return WaitResult{}, err
		}
		snapshot, err := s.Get(ctx, GetInput{WorkspaceID: input.WorkspaceID, WorkflowID: input.WorkflowID})
		if err != nil {
			return WaitResult{}, err
		}
		if err := requireWorkflowSourceSession(snapshot, expectedSourceSessionID); err != nil {
			return WaitResult{}, err
		}
		checkpoint, ok := checkpointByID(snapshot.Checkpoints, input.CheckpointID)
		if !ok {
			return WaitResult{}, ErrCheckpointMissing
		}
		if checkpoint.Status != workflowbiz.CheckpointStatusPending {
			if checkpoint.Status == workflowbiz.CheckpointStatusSuperseded {
				return WaitResult{Checkpoint: checkpoint, NextAction: NextActionSuperseded}, nil
			}
			nextAction, _, operationKind, transitionErr := decisionTransition(checkpoint.Kind, checkpoint.Status)
			if transitionErr != nil {
				return WaitResult{}, transitionErr
			}
			operation, ensureErr := s.ensureAndExecuteDecisionOperation(ctx, input.WorkspaceID, snapshot, checkpoint, operationKind)
			if ensureErr != nil {
				return WaitResult{}, ensureErr
			}
			return WaitResult{Checkpoint: checkpoint, NextAction: nextActionAfterOperation(nextAction, operation), Operation: operation}, nil
		}
		select {
		case <-ctx.Done():
			return WaitResult{}, ctx.Err()
		case <-ticker.C:
		}
	}
}

func (s *Service) ready() error {
	if s == nil || s.Store == nil || s.Revisions == nil {
		return ErrServiceUnavailable
	}
	return nil
}

// requireTuttiModeEnabled enforces the lab.tuttiMode write gate. A flag-read
// failure fails closed for writes: durable state is unchanged either way, and
// a misconfigured gate must not silently open the feature.
func (s *Service) requireTuttiModeEnabled(ctx context.Context) error {
	if s.FeatureFlags == nil {
		return nil
	}
	flags, err := s.FeatureFlags(ctx)
	if err != nil {
		return fmt.Errorf("read tutti mode feature flag: %w", err)
	}
	if !preferencesbiz.IsLabFlagEnabled(flags, tuttimodeactivation.TuttiModeFeatureFlag) {
		return ErrTuttiModeDisabled
	}
	return nil
}

func (s *Service) publish(ctx context.Context, update workflowbiz.Update) {
	if s.Publisher != nil {
		// Durable workflow state is authoritative. A transient stream failure
		// must not turn a committed mutation into a retryable duplicate; clients
		// recover with the list/get snapshot endpoints after reconnect.
		_ = s.Publisher.PublishWorkspaceWorkflowUpdated(ctx, update)
	}
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *Service) newID() string {
	if s.NewID != nil {
		return strings.TrimSpace(s.NewID())
	}
	return uuid.NewString()
}
