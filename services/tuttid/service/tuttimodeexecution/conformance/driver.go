package conformance

import (
	"context"
	"time"
)

type AcceptPlanInput struct {
	WorkspaceID         string
	WorkflowID          string
	RevisionID          string
	CheckpointID        string
	SourceSessionID     string
	TopicID             string
	Title               string
	Content             string
	BudgetMode          string
	TokenLimit          int64
	ReviewMode          string
	ReviewAgentTargetID string
	Tasks               []Task
}

type Issue struct {
	WorkspaceID     string
	IssueID         string
	TopicID         string
	Title           string
	Content         string
	Status          string
	TaskCount       int
	CompletedCount  int
	CanceledCount   int
	PlanningSource  string
	SourceSessionID string
}

type Task struct {
	TaskID             string
	Title              string
	Content            string
	Status             string
	AcceptanceState    string
	Priority           string
	SortIndex          int
	AgentTargetID      string
	Model              string
	PermissionModeID   string
	ExecutionDirectory string
	DependencyTaskIDs  []string
	Parallelizable     bool
	AutoAccept         bool
	SupersededAtUnixMS int64
	SupersededByTaskID string
}

type RunSnapshot struct {
	RunID  string
	TaskID string
	Status string
}

type Execution struct {
	WorkspaceID                string
	IssueID                    string
	WorkflowID                 string
	SourceSessionID            string
	Status                     string
	GraphRevision              int64
	LastOrchestratorActivityAt time.Time
	WatchdogDueAt              time.Time
	ReviewMode                 string
	ReviewAgentTargetID        string
	CompletedAt                time.Time
	ArchivedAt                 time.Time
	ArchivedBy                 string
	ArchiveReason              string
}

type Checkpoint struct {
	CheckpointID  string
	Kind          string
	Status        string
	Sequence      int64
	GraphRevision int64
	SubjectTaskID string
	SubjectRunID  string
}

type Snapshot struct {
	Issue       Issue
	Tasks       []Task
	Execution   Execution
	Checkpoints []Checkpoint
	RunCount    int
	Runs        []RunSnapshot
	OutputCount int
	Reviews     []GoalReview
	Audit       []ReviewAuditEntry
}

type GoalReview struct {
	ReviewID       string
	CheckpointID   string
	AgentTargetID  string
	ClientSubmitID string
	SessionID      string
	TurnID         string
	Status         string
	Verdict        string
	Summary        string
	FailureReason  string
	AttemptCount   int
	LeaseOwner     string
	LeaseExpiresAt time.Time
}

type ReviewAuditEntry struct {
	Kind      string
	ActorID   string
	Reason    string
	ReviewID  string
	CreatedAt time.Time
}

type ScheduleInput struct {
	WorkspaceID           string
	IssueID               string
	SourceSessionID       string
	CheckpointID          string
	ExpectedGraphRevision int64
	TaskIDs               []string
	RequestID             string
}

type ScheduleResult struct {
	ExecutionID   string
	CheckpointID  string
	GraphRevision int64
	RunIDs        []string
	Replayed      bool
}

type SettleRunInput struct {
	WorkspaceID string
	IssueID     string
	TaskID      string
	RunID       string
	Status      string
}

type AcknowledgeInput struct {
	WorkspaceID           string
	IssueID               string
	SourceSessionID       string
	CheckpointID          string
	ExpectedGraphRevision int64
	RequestID             string
}

type AcknowledgeResult struct {
	ExecutionID         string
	CheckpointID        string
	GraphRevision       int64
	NextCheckpointID    string
	NextCheckpointKind  string
	NextCheckpointState string
	Replayed            bool
}

type MutationOperation struct {
	Kind   string
	TaskID string
	Task   Task
}

type MutateInput struct {
	WorkspaceID           string
	IssueID               string
	SourceSessionID       string
	CheckpointID          string
	ExpectedGraphRevision int64
	Operations            []MutationOperation
	RequestID             string
}

type MutateResult struct {
	ExecutionID       string
	CheckpointID      string
	GraphRevision     int64
	AddedTaskIDs      []string
	UpdatedTaskIDs    []string
	SupersededTaskIDs []string
	Replayed          bool
}

type CompleteInput struct {
	WorkspaceID           string
	IssueID               string
	SourceSessionID       string
	CheckpointID          string
	ExpectedGraphRevision int64
	RequestID             string
	Decision              string
	DisagreementReason    string
}

type CompleteResult struct {
	ExecutionID   string
	CheckpointID  string
	GraphRevision int64
	Decision      string
	Replayed      bool
}

type ReviewerVerdictInput struct {
	WorkspaceID           string
	IssueID               string
	ReviewID              string
	ReviewSessionID       string
	ReviewTurnID          string
	CheckpointID          string
	ExpectedGraphRevision int64
	RequestID             string
	Verdict               string
	Summary               string
}

type ReviewerVerdictResult struct {
	ReviewID string
	Verdict  string
	Replayed bool
}

type SwitchReviewToSelfInput struct {
	WorkspaceID           string
	IssueID               string
	CheckpointID          string
	ExpectedGraphRevision int64
	RequestedBy           string
	RequestID             string
	Reason                string
}

type SwitchReviewToSelfResult struct {
	ExecutionID string
	ReviewID    string
	Replayed    bool
}

type ArchiveInput struct {
	WorkspaceID           string
	IssueID               string
	RequestID             string
	RequestedBy           string
	Reason                string
	SourceSessionID       string
	CheckpointID          string
	ExpectedGraphRevision int64
}

type ArchiveOperation struct {
	OperationID string
	Status      string
	RequestedBy string
	Reason      string
	LastError   string
	CompletedAt time.Time
}

type Wake struct {
	WakeID             string
	ExecutionID        string
	CheckpointID       string
	TargetKind         string
	WakeSequence       int64
	ClientSubmitID     string
	TargetSessionID    string
	CanonicalSessionID string
	CanonicalTurnID    string
	Status             string
	AttemptCount       int
	LeaseOwner         string
	DueAt              time.Time
	LeaseExpiresAt     time.Time
}

type WakeDelivery struct {
	TargetSessionID string
	ClientSubmitID  string
	Prompt          string
	HadDeadline     bool
	DeadlineBudget  time.Duration
}

type SourceSessionActivity struct {
	WorkspaceID string
	SessionID   string
	Kind        string
	ActivityID  string
	OccurredAt  time.Time
	// TurnStartedAt allows guidance on an already-active Turn to prove that
	// canonical message occurrence, not the older Turn start, owns debounce.
	TurnStartedAt time.Time
}

type AutomationTurnCancellation struct {
	SessionID string
	TurnID    string
}

// Driver is the narrow public contract exercised by Tutti execution product
// conformance. Implementations may compose real services and persistence, but
// scenarios do not reach through this seam to implementation details.
type Driver interface {
	AcceptPlan(context.Context, AcceptPlanInput) (string, error)
	GetSnapshot(context.Context, string, string) (Snapshot, error)
	Schedule(context.Context, ScheduleInput) (ScheduleResult, error)
	ScheduleReplica(context.Context, ScheduleInput) (ScheduleResult, error)
	SettleRun(context.Context, SettleRunInput) error
	SettleRunReplica(context.Context, SettleRunInput) error
	TimeoutRun(context.Context, SettleRunInput) error
	ClaimRunLaunchReplica(context.Context, string, string, string) (bool, error)
	FailNextLaunchAuthoritatively()
	FailNextCancellation()
	ReturnUnknownNextCancellation()
	HoldNextLaunchThenFailAuthoritatively() (<-chan struct{}, func())
	PersistTerminalRunWithoutCheckpoint(context.Context, SettleRunInput) error
	RepairSettlements(context.Context, string) error
	Acknowledge(context.Context, AcknowledgeInput) (AcknowledgeResult, error)
	AcknowledgeReplica(context.Context, AcknowledgeInput) (AcknowledgeResult, error)
	Mutate(context.Context, MutateInput) (MutateResult, error)
	MutateReplica(context.Context, MutateInput) (MutateResult, error)
	Complete(context.Context, CompleteInput) (CompleteResult, error)
	CompleteReplica(context.Context, CompleteInput) (CompleteResult, error)
	SubmitReviewerVerdict(context.Context, ReviewerVerdictInput) (ReviewerVerdictResult, error)
	SubmitReviewerVerdictReplica(context.Context, ReviewerVerdictInput) (ReviewerVerdictResult, error)
	SwitchReviewToSelf(context.Context, SwitchReviewToSelfInput) (SwitchReviewToSelfResult, error)
	SwitchReviewToSelfReplica(context.Context, SwitchReviewToSelfInput) (SwitchReviewToSelfResult, error)
	ClaimReviewer(context.Context, string, string, string, time.Duration) (bool, error)
	RecoverReviewers(context.Context, string, string) error
	StartupRecoverReviewers(context.Context, string, string) error
	SettleReviewerTurnWithoutVerdict(context.Context, string, string, string, string) error
	SetReviewerSessionBusy(string, bool)
	FailNextGoalReviewCommit(string)
	FailNextReviewerBeforeCanonical()
	FailNextReviewerAfterCanonical()
	SubmitReviewerVerdictOnNextSend(ReviewerVerdictInput)
	SettleReviewerOnNextSend()
	StopSourceSessionDuringNextReviewerSend(string, string)
	ReviewerLaunchCallCount() int
	ReviewerCanonicalTurnCount() int
	ReviewerCanonicalIdentity(string) (string, string, bool)
	ReviewerCapabilities() []string
	Archive(context.Context, ArchiveInput) (ArchiveOperation, error)
	GetArchive(context.Context, string, string) (ArchiveOperation, error)
	RestartRecoverArchives(context.Context, string) error
	StopSourceSession(context.Context, string, string) (int, error)
	CommitCanonicalSourceCancellation(context.Context, string, string, string) error
	AutomationTurnCancellations() []AutomationTurnCancellation
	AdmitSourceDeletion(context.Context, string, []string) error
	ReleaseSourceDeletion(context.Context, string, []string, bool) error
	SeedActiveRun(context.Context, string, string, string) error
	FailNextLaunch()
	HoldNextLaunch() (<-chan struct{}, func())
	AdvanceClock(time.Duration) error
	StopLeaseRenewal()
	AdvanceClockWithoutRenewal(time.Duration)
	StartupRecoverReplica(context.Context, string) error
	StartupReconcileReplica(context.Context, string) error
	PeriodicRecoverReplica(context.Context, string) error
	RecoverLaunches(context.Context, string) error
	EnableAutomaticRecovery(context.Context)
	AwaitLauncherCalls(context.Context, int) error
	LauncherClientSubmitIDs() []string
	LauncherCanonicalTurnCount() int
	LauncherCallCount() int
	CancellationCallCount() int
	CancellationClientSubmitIDs() []string
	PreparedCancelCompensationCount(context.Context, string) (int, error)
	ListWakes(context.Context, string, string) ([]Wake, error)
	ClaimWake(context.Context, string, string, string, time.Duration) (bool, error)
	DispatchClaimedWake(context.Context, string, string, string) error
	DispatchClaimedWakeWithCallerCancellation(
		context.Context, string, string, string, string,
	) error
	RecoverWakes(context.Context, string, string) error
	// StartupRecoverWakes must construct a fresh execution service over the
	// same durable store before running startup recovery.
	StartupRecoverWakes(context.Context, string, string) error
	// SetSourceBusy changes only the exact workspace/session observation in
	// the canonical liveness port used by the production wake service; it must
	// not mutate a wake row directly.
	SetSourceBusy(string, string, bool)
	FailNextWakeBeforeCanonical()
	FailNextWakeAmbiguouslyBeforeCanonical()
	FailNextWakeAfterCanonical()
	FailNextWakeCanonicalLookup()
	SetMainWakeSendTimeout(time.Duration)
	HangWakeUntilContextDone(string, string)
	AdvanceClockDuringWake(string, string, time.Duration)
	FailWakeObservation(string, string)
	FailWakeClaim(string)
	SeedPreparedReviewerWake(context.Context, string, string) error
	CorruptWakeIdentity(context.Context, string, string, string, string) error
	// SettleWakeTurn changes the canonical Turn observation and then enters
	// the production wake reconciliation seam.
	SettleWakeTurn(context.Context, string, string, string) error
	// SettleWakeTurnAt separates canonical Turn settlement time from callback
	// delivery time so the contract can reject wall-clock deadline drift.
	SettleWakeTurnAt(context.Context, string, string, string, time.Time) error
	// SetCanonicalWakeTurnSettledAt mutates only the canonical Agent fake and
	// deliberately skips the Tutti product observer to model a lost callback
	// projection that durable recovery must repair.
	SetCanonicalWakeTurnSettledAt(string, string, string, time.Time)
	SetExecutionStatus(context.Context, string, string, string) error
	CorruptWakeTargetSession(context.Context, string, string, string) error
	ObserveSourceSessionActivity(context.Context, SourceSessionActivity) error
	// CommitCanonicalSourceActivity persists the canonical Agent fact without
	// invoking the Tutti observer, modeling a lost post-commit projection.
	// clientSubmitID is retained when present for user_turn and ignored for
	// agent_turn.
	CommitCanonicalSourceActivity(
		context.Context, SourceSessionActivity, string,
	) error
	// CommitCanonicalSourceActivityBeforeNextWakeClaim commits canonical source
	// activity after the dispatchable scan but before the durable claim while
	// deliberately losing the low-latency Tutti observer projection.
	CommitCanonicalSourceActivityBeforeNextWakeClaim(
		context.Context, SourceSessionActivity, string,
	)
	// ObserveSourceActivityAfterNextWakeClaim injects canonical source
	// activity in the claim-to-send window, before the second liveness
	// observation returns.
	ObserveSourceActivityAfterNextWakeClaim(context.Context, SourceSessionActivity)
	// CommitCanonicalSourceActivityAfterNextWakeClaim commits canonical source
	// activity in the claim-to-send window while deliberately losing the
	// low-latency Tutti observer projection.
	CommitCanonicalSourceActivityAfterNextWakeClaim(
		context.Context, SourceSessionActivity, string,
	)
	// ObserveSourceActivityDuringNextWakeSend injects canonical root activity
	// after SendInput has established its idempotent Turn but before the wake
	// owner performs the final durable dispatch CAS.
	ObserveSourceActivityDuringNextWakeSend(context.Context, SourceSessionActivity)
	// CommitCanonicalSourceActivityDuringNextWakeSend commits canonical source
	// activity in the send-to-finalize window while deliberately losing the
	// low-latency Tutti observer projection.
	CommitCanonicalSourceActivityDuringNextWakeSend(
		context.Context, SourceSessionActivity, string,
	)
	PauseIssueDuringNextWakeSend(context.Context, string, string, string)
	ResumeIssueDispatch(context.Context, string, string, string) error
	FailNextAutomationTurnCancellation()
	StopSourceSessionDuringNextWakeSend(string, string)
	RunWatchdog(context.Context, string, string) error
	// StartupRecoverWatchdog must construct a fresh worker over the same
	// durable store before scanning and recovering watchdog operations.
	StartupRecoverWatchdog(context.Context, string, string) error
	// SetReviewerActive seeds only the external goal-review owner state read by
	// this service. It must not mutate execution, checkpoint, or wake rows.
	SetReviewerActive(context.Context, string, string, bool) error
	ReviewerActive(context.Context, string, string) (bool, error)
	CurrentTime() time.Time
	WakeDeliveryCallCount() int
	WakeDeliveries() []WakeDelivery
	WakeDeliveryClientSubmitIDs() []string
	WakeDeliveryCanonicalTurnCount() int
}
