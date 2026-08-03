package storesqlite

import "errors"

const (
	RuntimeOperationKindInteractiveResponse = "interactive_response"
	RuntimeOperationKindCancelTurn          = "cancel_turn"
	RuntimeOperationKindPlanDecision        = "plan_decision"
	RuntimeOperationKindEditRetry           = "edit_retry"

	RuntimeOperationStatusPrepared  = "prepared"
	RuntimeOperationStatusLeased    = "leased"
	RuntimeOperationStatusBlocked   = "blocked"
	RuntimeOperationStatusCompleted = "completed"
	RuntimeOperationStatusFailed    = "failed"

	RuntimeOperationResultAnswered       = "answered"
	RuntimeOperationResultSuperseded     = "superseded"
	RuntimeOperationResultCanceled       = "canceled"
	RuntimeOperationResultAlreadySettled = "already_settled"
	RuntimeOperationResultApplied        = "applied"
	RuntimeOperationResultAbandoned      = "abandoned"
	RuntimeOperationResultFailed         = "failed"

	RuntimeOperationEventInteractiveCompleted  = "interactive_completed"
	RuntimeOperationEventTurnCanceled          = "turn_canceled"
	RuntimeOperationEventPlanDecisionPending   = "plan_decision_pending_confirmation"
	RuntimeOperationEventPlanDecisionCompleted = "plan_decision_completed"
	RuntimeOperationEventEditRetryPending      = "edit_retry_rollback_pending"
	RuntimeOperationEventEditRetryRollback     = "edit_retry_rollback_confirmed"
	RuntimeOperationEventEditRetryCompleted    = "edit_retry_completed"
	RuntimeOperationEventEditRetryRecovery     = "edit_retry_recovery_required"
	RuntimeOperationEventEditRetryAbandoned    = "edit_retry_abandoned"
	RuntimeOperationEventEditRetryWake         = "edit_retry_wake"
	// Replacement authorization is a distinct durable fact from a prior wake:
	// the event table is unique by operation+kind, so sharing the wake kind
	// could otherwise hide an already-published authorization from consumers.
	RuntimeOperationEventEditRetryReplacementAuthorized = "edit_retry_replacement_authorized"
)

var (
	ErrRuntimeOperationConflict         = errors.New("runtime operation identity conflicts with an existing operation")
	ErrRuntimeOperationIdentityMismatch = errors.New("runtime operation durable identity does not match its subject")
	ErrRuntimeOperationNotClaimable     = errors.New("runtime operation is not claimable")
	ErrRuntimeOperationLeaseLost        = errors.New("runtime operation lease is not owned by the caller")
	ErrRuntimeOperationSubjectState     = errors.New("runtime operation subject is not in the required state")
	ErrRuntimeOperationActionConflict   = errors.New("runtime operation recovery action identity conflicts with an existing client action")
)

type RuntimeOperation struct {
	// CommitTransactionID is populated only on a successful mutation return;
	// it is not persisted as operation state.
	CommitTransactionID string           `json:"-"`
	CommitDelta         TransactionDelta `json:"-"`
	OperationID         string
	WorkspaceID         string
	AgentSessionID      string
	// ProviderKey is an ephemeral canonical-session projection used only by the
	// Host process bulkhead; it is never persisted in the operation payload.
	ProviderKey       string
	Kind              string
	Status            string
	Result            string
	TurnID            string
	RequestID         string
	Payload           map[string]any
	LeaseOwner        string
	LeaseExpiresAtMS  int64
	NextAttemptAtMS   int64
	Attempt           int
	Version           int64
	LastError         string
	CreatedAtUnixMS   int64
	UpdatedAtUnixMS   int64
	CompletedAtUnixMS int64
}

// ActiveEditRetryDegradation is a durable edit-retry diagnostic projection.
// It deliberately excludes LastError and all raw diagnostics.
type ActiveEditRetryDegradation struct {
	Operation RuntimeOperation
	History   SessionHistory
	Invariant bool
	// OrphanFence marks a non-ready session fence whose owner operation no
	// longer exists. Operation carries the fence identity only for a stable
	// diagnostic key; it must never authorize a recovery action.
	OrphanFence bool
}

type RuntimeOperationPrepare struct {
	OperationID    string
	WorkspaceID    string
	AgentSessionID string
	Kind           string
	TurnID         string
	RequestID      string
	Payload        map[string]any
	OccurredAtMS   int64
}

type runtimeCancelTarget struct {
	AgentSessionID string
	TurnID         string
}

type ListClaimableRuntimeOperationsInput struct {
	// WorkspaceID scopes recovery when non-empty; empty lists all workspaces.
	WorkspaceID string
	NowUnixMS   int64
	Limit       int
}

type ClaimRuntimeOperationLeaseInput struct {
	WorkspaceID      string
	OperationID      string
	LeaseOwner       string
	NowUnixMS        int64
	LeaseExpiresAtMS int64
}

type ReleaseOrFailRuntimeOperationInput struct {
	WorkspaceID     string
	OperationID     string
	LeaseOwner      string
	LastError       string
	NowUnixMS       int64
	NextAttemptAtMS int64
	Fail            bool
}

type CheckpointRuntimeOperationInput struct {
	WorkspaceID string
	OperationID string
	LeaseOwner  string
	Payload     map[string]any
	NowUnixMS   int64
}

type CompleteInteractiveRuntimeOperationInput struct {
	WorkspaceID string
	OperationID string
	LeaseOwner  string
	Disposition string
	Output      map[string]any
	NowUnixMS   int64
}

type CompleteCancelRuntimeOperationInput struct {
	WorkspaceID    string
	OperationID    string
	LeaseOwner     string
	TargetOutcomes []CancelRuntimeOperationTargetOutcome
	NowUnixMS      int64
}

type CancelRuntimeOperationTargetOutcome struct {
	AgentSessionID string
	TurnID         string
	Outcome        string
}

type CompletePlanDecisionRuntimeOperationInput struct {
	WorkspaceID string
	OperationID string
	LeaseOwner  string
	Output      map[string]any
	NowUnixMS   int64
}

type ConfirmEditRetryRollbackInput struct {
	WorkspaceID     string
	OperationID     string
	LeaseOwner      string
	Payload         EditRetryOperationPayload
	NowUnixMS       int64
	ProviderTurnIDs []string
}

type AbortEditRetryRollbackInput struct {
	WorkspaceID     string
	OperationID     string
	LeaseOwner      string
	ReasonCode      EditRetryReasonCode
	Reason          string
	NowUnixMS       int64
	ProviderTurnIDs []string
}

type MarkEditRetryRollbackDispatchedInput struct {
	WorkspaceID string
	OperationID string
	LeaseOwner  string
	Payload     EditRetryOperationPayload
	NowUnixMS   int64
}

// AuthorizeEditRetryReplacementRetryInput is the explicit user-command
// boundary for a replacement redispatch. The Host obtains the provider proof
// before calling this transition; SQLite validates and consumes that exact
// proof together with the command CAS and recovery-action ledger.
type AuthorizeEditRetryReplacementRetryInput struct {
	WorkspaceID              string
	OperationID              string
	ExpectedOperationVersion int64
	ExpectedHistoryRevision  int64
	ClientActionID           string
	ActionIdentity           string
	ReplacementTurnID        string
	ProviderSessionID        string
	ProviderTurnIDs          []string
	ProofAtUnixMS            int64
	NowUnixMS                int64
}

type BlockedEditRetryReconcileDisposition string

const (
	BlockedEditRetryReconcileUnknown            BlockedEditRetryReconcileDisposition = "unknown"
	BlockedEditRetryReconcileSourcePresent      BlockedEditRetryReconcileDisposition = "source_present"
	BlockedEditRetryReconcileReplacementAbsent  BlockedEditRetryReconcileDisposition = "replacement_absent"
	BlockedEditRetryReconcileReplacementPresent BlockedEditRetryReconcileDisposition = "replacement_present"
)

// ReconcileBlockedEditRetryInput contains only provider evidence already read
// by Host. SQLite never holds its transaction across the provider boundary.
type ReconcileBlockedEditRetryInput struct {
	WorkspaceID              string
	OperationID              string
	ExpectedOperationVersion int64
	ExpectedHistoryRevision  int64
	ClientActionID           string
	ActionIdentity           string
	Disposition              BlockedEditRetryReconcileDisposition
	ProviderSessionID        string
	ProviderTurnIDs          []string
	ProviderTurnID           string
	NowUnixMS                int64
}

type CompleteEditRetryRuntimeOperationInput struct {
	WorkspaceID       string
	OperationID       string
	LeaseOwner        string
	ReplacementTurnID string
	ProviderTurnID    string
	NowUnixMS         int64
}

type FailEditRetryRecoveryInput struct {
	WorkspaceID string
	OperationID string
	LeaseOwner  string
	ReasonCode  EditRetryReasonCode
	Reason      string
	NowUnixMS   int64
}

// BlockEditRetryInput records a provider-unknown or otherwise unsafe recovery
// outcome. It deliberately leaves the session fence in place: a blocked item
// cannot be claimed by the worker, redispatched, or abandoned implicitly.
//
// It is the stable name for the durable transition. FailEditRetryRecovery is
// retained as a source-compatible spelling for older Host consumers.
type BlockEditRetryInput = FailEditRetryRecoveryInput

// DeferEditRetryInput is the edit-retry-specific retry transition. The
// operation must keep (or, before rollback, be eligible to establish) its
// session fence, and the next retry must be in the future according to the
// caller's real clock.
type DeferEditRetryInput struct {
	WorkspaceID     string
	OperationID     string
	LeaseOwner      string
	ReasonCode      EditRetryReasonCode
	NowUnixMS       int64
	NextAttemptAtMS int64
}

// CaptureEditRetryPreEffectSnapshotInput durably binds the provider's
// read-only pre-effect history to an already fenced prepared operation. It is
// intentionally separate from rollback intent: a crash after this commit is
// still before-effect and can never be mistaken for a dispatched rollback.
type CaptureEditRetryPreEffectSnapshotInput struct {
	WorkspaceID       string
	OperationID       string
	LeaseOwner        string
	ProviderSessionID string
	ProviderTurnIDs   []string
	NowUnixMS         int64
}

// AbandonEditRetryInput is deliberately evidence-bearing. `prepared` means a
// rollback was never dispatched; `rollback_confirmed` means the old turn stays
// retracted while the owned fence may be released. `rollback_dispatched` (an
// unknown provider result) is never abandonable.
type AbandonEditRetryInput struct {
	WorkspaceID              string
	OperationID              string
	LeaseOwner               string
	ExpectedOperationVersion int64
	ExpectedHistoryRevision  int64
	ClientActionID           string
	NowUnixMS                int64
}

// WakeDeferredEditRetryInput is an explicit operator action. It atomically
// moves a deferred prepared operation to the real current time only while the
// same operation still owns the session-history fence. It never wakes blocked
// unknown-provider work; that requires a separate authoritative disposition.
type WakeDeferredEditRetryInput struct {
	WorkspaceID              string
	OperationID              string
	ExpectedOperationVersion int64
	ExpectedHistoryRevision  int64
	ClientActionID           string
	// ActionIdentity binds this generic recovery-action record to the Host
	// command that consumed it. Callers that predate typed recovery commands
	// may leave it empty; the store then derives the legacy wake identity.
	ActionIdentity string
	NowUnixMS      int64
}

// RuntimeOperationRecoveryAction is the durable, provider-neutral action
// ledger row used to make explicit recovery commands idempotent.
type RuntimeOperationRecoveryAction struct {
	WorkspaceID    string
	OperationID    string
	ClientActionID string
	ActionKind     string
	ActionIdentity string
	CreatedAtMS    int64
}

type ClearAbandonedEditRetryFenceInput struct {
	WorkspaceID    string
	AgentSessionID string
	NowUnixMS      int64
}

type RuntimeOperationEvent struct {
	ID             int64
	OperationID    string
	WorkspaceID    string
	AgentSessionID string
	Kind           string
	// OccurrenceKey is a durable idempotency identity for one occurrence of a
	// fact. It lets later legal recovery actions publish a new fact without
	// making replay of the same action duplicate it.
	OccurrenceKey     string
	Payload           map[string]any
	CreatedAtUnixMS   int64
	PublishedAtUnixMS int64
	PublishAttempt    int64
	NextAttemptAtMS   int64
	LastErrorCode     string
}

type DeferRuntimeOperationEventPublishInput struct {
	WorkspaceID     string
	EventID         int64
	NowUnixMS       int64
	NextAttemptAtMS int64
	ReasonCode      string
}

type RuntimeOperationCompletion struct {
	TransactionID string           `json:"-"`
	CommitDelta   TransactionDelta `json:"-"`
	Operation     RuntimeOperation
	Event         RuntimeOperationEvent
}
