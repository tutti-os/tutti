package storesqlite

import "errors"

const (
	RuntimeOperationKindInteractiveResponse = "interactive_response"
	RuntimeOperationKindCancelTurn          = "cancel_turn"
	RuntimeOperationKindPlanDecision        = "plan_decision"

	RuntimeOperationStatusPrepared  = "prepared"
	RuntimeOperationStatusLeased    = "leased"
	RuntimeOperationStatusCompleted = "completed"
	RuntimeOperationStatusFailed    = "failed"

	RuntimeOperationResultAnswered       = "answered"
	RuntimeOperationResultSuperseded     = "superseded"
	RuntimeOperationResultCanceled       = "canceled"
	RuntimeOperationResultAlreadySettled = "already_settled"
	RuntimeOperationResultApplied        = "applied"
	RuntimeOperationResultFailed         = "failed"

	RuntimeOperationEventInteractiveCompleted  = "interactive_completed"
	RuntimeOperationEventTurnCanceled          = "turn_canceled"
	RuntimeOperationEventPlanDecisionPending   = "plan_decision_pending_confirmation"
	RuntimeOperationEventPlanDecisionCompleted = "plan_decision_completed"
)

var (
	ErrRuntimeOperationConflict         = errors.New("runtime operation identity conflicts with an existing operation")
	ErrRuntimeOperationIdentityMismatch = errors.New("runtime operation durable identity does not match its subject")
	ErrRuntimeOperationNotClaimable     = errors.New("runtime operation is not claimable")
	ErrRuntimeOperationLeaseLost        = errors.New("runtime operation lease is not owned by the caller")
	ErrRuntimeOperationSubjectState     = errors.New("runtime operation subject is not in the required state")
)

type RuntimeOperation struct {
	// CommitTransactionID is populated only on a successful mutation return;
	// it is not persisted as operation state.
	CommitTransactionID string           `json:"-"`
	CommitDelta         TransactionDelta `json:"-"`
	OperationID         string
	WorkspaceID         string
	AgentSessionID      string
	Kind                string
	Status              string
	Result              string
	TurnID              string
	RequestID           string
	Payload             map[string]any
	LeaseOwner          string
	LeaseExpiresAtMS    int64
	NextAttemptAtMS     int64
	Attempt             int
	Version             int64
	LastError           string
	CreatedAtUnixMS     int64
	UpdatedAtUnixMS     int64
	CompletedAtUnixMS   int64
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

type RuntimeOperationEvent struct {
	ID                int64
	OperationID       string
	WorkspaceID       string
	AgentSessionID    string
	Kind              string
	Payload           map[string]any
	CreatedAtUnixMS   int64
	PublishedAtUnixMS int64
}

type RuntimeOperationCompletion struct {
	TransactionID string           `json:"-"`
	CommitDelta   TransactionDelta `json:"-"`
	Operation     RuntimeOperation
	Event         RuntimeOperationEvent
}
