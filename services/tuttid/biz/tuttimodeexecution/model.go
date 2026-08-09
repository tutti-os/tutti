// Package tuttimodeexecution defines Tutti-owned Issue orchestration state.
// Agent Session and Turn lifecycle facts remain owned by Agent Host.
package tuttimodeexecution

import (
	"errors"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

var ErrSourceDeletionFenced = errors.New("source session deletion is fenced")

type ArchiveStatus string

const (
	ArchiveStatusRequested     ArchiveStatus = "requested"
	ArchiveStatusCancelingRuns ArchiveStatus = "canceling_runs"
	ArchiveStatusArchiving     ArchiveStatus = "archiving"
	ArchiveStatusCompleted     ArchiveStatus = "completed"
	ArchiveStatusFailed        ArchiveStatus = "failed"
)

type ArchiveRequest struct {
	WorkspaceID           string
	IssueID               string
	RequestID             string
	RequestedBy           string
	Reason                string
	SourceSessionID       string
	CheckpointID          string
	ExpectedGraphRevision int64
	Now                   time.Time
}

type SourceSessionArchiveRequest struct {
	WorkspaceID     string
	SourceSessionID string
	RequestID       string
	RequestedBy     string
	Reason          string
	Now             time.Time
}

type ArchiveOperation struct {
	WorkspaceID  string
	ExecutionID  string
	IssueID      string
	OperationID  string
	RequestID    string
	Status       ArchiveStatus
	RequestedBy  string
	Reason       string
	AttemptCount int
	LastError    string
	CreatedAt    time.Time
	UpdatedAt    time.Time
	CompletedAt  time.Time
}

type ProtectedIssue struct {
	IssueID         string `json:"issueId"`
	ExecutionID     string `json:"executionId"`
	SourceSessionID string `json:"sourceSessionId"`
	Status          Status `json:"status"`
}

type ProtectedSourceError struct {
	WorkspaceID string
	Issues      []ProtectedIssue
}

func (*ProtectedSourceError) Error() string {
	return "tutti_execution_active"
}

type SourceSessionDeletionAdmission struct {
	WorkspaceID string
	AdmissionID string
	SessionIDs  []string
	Now         time.Time
}

type Status string

const (
	StatusAwaitingSchedule  Status = "awaiting_schedule"
	StatusRunning           Status = "running"
	StatusAwaitingMain      Status = "awaiting_main"
	StatusPendingGoalReview Status = "pending_goal_review"
	StatusOrphanedSource    Status = "orphaned_source"
	StatusCompleted         Status = "completed"
	StatusArchiving         Status = "archiving"
	StatusArchived          Status = "archived"
)

type ReviewMode string

const (
	ReviewModeSelf        ReviewMode = "self"
	ReviewModeIndependent ReviewMode = "independent"
)

type ReviewConfiguration struct {
	Mode          ReviewMode
	AgentTargetID string
}

type GoalReviewStatus string

const (
	GoalReviewStatusPrepared   GoalReviewStatus = "prepared"
	GoalReviewStatusLeased     GoalReviewStatus = "leased"
	GoalReviewStatusDispatched GoalReviewStatus = "dispatched"
	GoalReviewStatusSubmitted  GoalReviewStatus = "submitted"
	GoalReviewStatusFailed     GoalReviewStatus = "failed"
	GoalReviewStatusCanceled   GoalReviewStatus = "canceled"
)

type GoalReviewVerdict string

const (
	GoalReviewVerdictSatisfied GoalReviewVerdict = "goal_satisfied"
	GoalReviewVerdictMoreWork  GoalReviewVerdict = "more_work_required"
	GoalReviewVerdictUnknown   GoalReviewVerdict = "inconclusive"
)

type CheckpointKind string

const (
	CheckpointKindInitialSchedule  CheckpointKind = "initial_schedule"
	CheckpointKindTaskSettled      CheckpointKind = "task_settled"
	CheckpointKindTaskFailed       CheckpointKind = "task_failed"
	CheckpointKindTaskCanceled     CheckpointKind = "task_canceled"
	CheckpointKindWatchdog         CheckpointKind = "watchdog"
	CheckpointKindAllTasksTerminal CheckpointKind = "all_tasks_terminal"
	CheckpointKindMigration        CheckpointKind = "migration"
)

type CheckpointStatus string

const (
	CheckpointStatusPending    CheckpointStatus = "pending"
	CheckpointStatusActive     CheckpointStatus = "active"
	CheckpointStatusResolved   CheckpointStatus = "resolved"
	CheckpointStatusSuperseded CheckpointStatus = "superseded"
	CheckpointStatusCanceled   CheckpointStatus = "canceled"
)

type WakeTargetKind string

const WakeTargetMain WakeTargetKind = "main"

type WakeStatus string

const (
	WakeStatusPrepared     WakeStatus = "prepared"
	WakeStatusLeased       WakeStatus = "leased"
	WakeStatusDispatched   WakeStatus = "dispatched"
	WakeStatusTurnSettled  WakeStatus = "turn_settled"
	WakeStatusAcknowledged WakeStatus = "acknowledged"
	WakeStatusFailed       WakeStatus = "failed"
	WakeStatusCanceled     WakeStatus = "canceled"
)

type Execution struct {
	ID                         string
	WorkspaceID                string
	IssueID                    string
	WorkflowID                 string
	SourceSessionID            string
	Status                     Status
	GraphRevision              int64
	ActiveCheckpointID         string
	LastOrchestratorActivityAt time.Time
	WatchdogDueAt              time.Time
	ReviewMode                 ReviewMode
	ReviewAgentTargetID        string
	CompletedAt                time.Time
	ArchivedAt                 time.Time
	ArchivedBy                 string
	ArchiveReason              string
	CreatedAt                  time.Time
	UpdatedAt                  time.Time
}

type Checkpoint struct {
	ID                 string
	ExecutionID        string
	Kind               CheckpointKind
	Status             CheckpointStatus
	Sequence           int64
	GraphRevision      int64
	SubjectTaskID      string
	SubjectRunID       string
	CreationReason     string
	RequiresGoalReview bool
	CreatedAt          time.Time
	UpdatedAt          time.Time
	ResolvedAt         time.Time
}

type Aggregate struct {
	Execution   Execution
	Checkpoints []Checkpoint
}

type GoalReview struct {
	ID             string
	WorkspaceID    string
	ExecutionID    string
	IssueID        string
	CheckpointID   string
	GraphRevision  int64
	AgentTargetID  string
	ClientSubmitID string
	SessionID      string
	TurnID         string
	Status         GoalReviewStatus
	Verdict        GoalReviewVerdict
	Summary        string
	FailureReason  string
	AttemptCount   int
	LeaseOwner     string
	LeaseExpiresAt time.Time
	CreatedAt      time.Time
	UpdatedAt      time.Time
	SubmittedAt    time.Time
}

type ReviewAuditEntry struct {
	ID          string
	WorkspaceID string
	ExecutionID string
	ReviewID    string
	Kind        string
	ActorID     string
	Reason      string
	CreatedAt   time.Time
}

type GoalReviewCompleteAdmission struct {
	WorkspaceID           string
	IssueID               string
	SourceSessionID       string
	CheckpointID          string
	ExpectedGraphRevision int64
	RequestID             string
	InputSHA256           string
	Decision              string
	DisagreementReason    string
	Now                   time.Time
	BeforeStep            func(string) error
}

type GoalReviewCompleteResult struct {
	ExecutionID   string `json:"executionId"`
	CheckpointID  string `json:"checkpointId"`
	GraphRevision int64  `json:"graphRevision"`
	Decision      string `json:"decision"`
	Replayed      bool   `json:"-"`
}

type ReviewerVerdictAdmission struct {
	WorkspaceID           string
	IssueID               string
	ReviewID              string
	ReviewSessionID       string
	ReviewTurnID          string
	CheckpointID          string
	ExpectedGraphRevision int64
	RequestID             string
	InputSHA256           string
	Verdict               GoalReviewVerdict
	Summary               string
	Now                   time.Time
	BeforeStep            func(string) error
}

type ReviewerVerdictResult struct {
	ReviewID string            `json:"reviewId"`
	Verdict  GoalReviewVerdict `json:"verdict"`
	Replayed bool              `json:"-"`
}

type SwitchReviewToSelfAdmission struct {
	WorkspaceID           string
	IssueID               string
	CheckpointID          string
	ExpectedGraphRevision int64
	RequestID             string
	InputSHA256           string
	Reason                string
	RequestedByActorID    string
	Now                   time.Time
	BeforeStep            func(string) error
}

type SwitchReviewToSelfResult struct {
	ExecutionID string `json:"executionId"`
	ReviewID    string `json:"reviewId"`
	ReviewMode  string `json:"reviewMode"`
	Replayed    bool   `json:"-"`
}

type Wake struct {
	ID                  string
	WorkspaceID         string
	ExecutionID         string
	IssueID             string
	CheckpointID        string
	CheckpointKind      CheckpointKind
	CheckpointRevision  int64
	ReviewMode          ReviewMode
	ReviewID            string
	ReviewStatus        GoalReviewStatus
	ReviewVerdict       GoalReviewVerdict
	ReviewSummary       string
	ReviewFailureReason string
	TargetKind          WakeTargetKind
	Sequence            int64
	ClientSubmitID      string
	SourceSessionID     string
	TargetSessionID     string
	CanonicalSessionID  string
	CanonicalTurnID     string
	Status              WakeStatus
	DueAt               time.Time
	AttemptCount        int
	LeaseOwner          string
	LeaseExpiresAt      time.Time
	DispatchedAt        time.Time
	TurnSettledAt       time.Time
	AcknowledgedAt      time.Time
	LastError           string
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

type ScheduleAdmission struct {
	WorkspaceID           string
	IssueID               string
	SourceSessionID       string
	CheckpointID          string
	ExpectedGraphRevision int64
	RequestID             string
	InputSHA256           string
	Runs                  []workspaceissues.Run
	Now                   time.Time
}

type ScheduleResult struct {
	ExecutionID   string   `json:"executionId"`
	CheckpointID  string   `json:"checkpointId"`
	GraphRevision int64    `json:"graphRevision"`
	RunIDs        []string `json:"runIds"`
	Replayed      bool     `json:"-"`
}

type MutationOperationKind string

const (
	MutationOperationAdd       MutationOperationKind = "add"
	MutationOperationUpdate    MutationOperationKind = "update"
	MutationOperationRework    MutationOperationKind = "rework"
	MutationOperationSupersede MutationOperationKind = "supersede"
)

type MutationOperation struct {
	Kind       MutationOperationKind `json:"kind"`
	TaskID     string                `json:"taskId,omitempty"`
	Task       workspaceissues.Task  `json:"task,omitempty"`
	TaskFields MutationTaskFields    `json:"taskFields,omitempty"`
}

// MutationTaskFields distinguishes omitted patch fields from explicit zero
// values. Add operations use the complete Task value; update and rework apply
// only the fields present in the public mutation payload.
type MutationTaskFields struct {
	Title              bool `json:"title,omitempty"`
	Content            bool `json:"content,omitempty"`
	Priority           bool `json:"priority,omitempty"`
	DueAtUnixMS        bool `json:"dueAtUnixMs,omitempty"`
	AgentTargetID      bool `json:"agentTargetId,omitempty"`
	ModelPlanID        bool `json:"modelPlanId,omitempty"`
	Model              bool `json:"model,omitempty"`
	PermissionModeID   bool `json:"permissionModeId,omitempty"`
	ReasoningEffort    bool `json:"reasoningEffort,omitempty"`
	ExecutionDirectory bool `json:"executionDirectory,omitempty"`
	DependencyTaskIDs  bool `json:"dependencyTaskIds,omitempty"`
	Parallelizable     bool `json:"parallelizable,omitempty"`
	AutoAccept         bool `json:"autoAccept,omitempty"`
}

func (fields MutationTaskFields) Any() bool {
	return fields.Title || fields.Content || fields.Priority || fields.DueAtUnixMS ||
		fields.AgentTargetID || fields.ModelPlanID || fields.Model ||
		fields.PermissionModeID || fields.ReasoningEffort ||
		fields.ExecutionDirectory || fields.DependencyTaskIDs ||
		fields.Parallelizable || fields.AutoAccept
}

type MutationAdmission struct {
	WorkspaceID           string
	IssueID               string
	SourceSessionID       string
	CheckpointID          string
	ExpectedGraphRevision int64
	RequestID             string
	InputSHA256           string
	Operations            []MutationOperation
	Now                   time.Time
}

type MutationResult struct {
	ExecutionID       string   `json:"executionId"`
	CheckpointID      string   `json:"checkpointId"`
	GraphRevision     int64    `json:"graphRevision"`
	AddedTaskIDs      []string `json:"addedTaskIds"`
	UpdatedTaskIDs    []string `json:"updatedTaskIds"`
	SupersededTaskIDs []string `json:"supersededTaskIds"`
	Replayed          bool     `json:"-"`
}

type LaunchIntent struct {
	WorkspaceID        string
	IssueID            string
	TaskID             string
	RunID              string
	LaunchIntentID     string
	ClientSubmitID     string
	Status             string
	CanonicalSessionID string
	CanonicalTurnID    string
}

type PreparedRunLaunch = workspaceissues.PreparedRunLaunch

type RunCancelCompensation struct {
	WorkspaceID    string
	IssueID        string
	TaskID         string
	RunID          string
	AgentSessionID string
	ClientSubmitID string
}

type RunSettlement struct {
	WorkspaceID string
	IssueID     string
	TaskID      string
	RunID       string
	Status      workspaceissues.Status
	Now         time.Time
}

type RunLaunchFailure struct {
	WorkspaceID  string
	IssueID      string
	RunID        string
	LeaseOwner   string
	ErrorMessage string
	Now          time.Time
}

type AcknowledgeAdmission struct {
	WorkspaceID           string
	IssueID               string
	SourceSessionID       string
	CheckpointID          string
	ExpectedGraphRevision int64
	RequestID             string
	InputSHA256           string
	Now                   time.Time
}

type AcknowledgeResult struct {
	ExecutionID         string           `json:"executionId"`
	CheckpointID        string           `json:"checkpointId"`
	GraphRevision       int64            `json:"graphRevision"`
	NextCheckpointID    string           `json:"nextCheckpointId"`
	NextCheckpointKind  CheckpointKind   `json:"nextCheckpointKind"`
	NextCheckpointState CheckpointStatus `json:"nextCheckpointState"`
	Replayed            bool             `json:"-"`
}
