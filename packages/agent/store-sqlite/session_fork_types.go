package storesqlite

import "errors"

const (
	SessionForkPointThroughTurn       = "through_turn"
	SessionForkStatusPrepared         = "prepared"
	SessionForkStatusDispatching      = "dispatching"
	SessionForkStatusProviderAccepted = "provider_accepted"
	SessionForkStatusCommitted        = "committed"
	SessionForkStatusFailed           = "failed"
	SessionForkStatusUnknown          = "unknown"
)

var (
	ErrSessionForkRequestConflict = errors.New("agent session fork request conflicts with an existing operation")
	ErrSessionForkSourceState     = errors.New("agent session cannot be forked in its current state")
	ErrSessionForkInProgress      = errors.New("agent session has a fork operation in progress")
	ErrSessionForkTurnState       = errors.New("agent session fork turn is not a verified settled boundary")
	ErrSessionForkTargetReserved  = errors.New("agent session fork target is reserved")
	ErrSessionForkTransition      = errors.New("agent session fork operation transition is invalid")
)

type SessionForkLineage struct {
	WorkspaceID          string
	TargetAgentSessionID string
	SourceAgentSessionID string
	SourceTurnID         string
	TargetTurnID         string
	OperationID          string
	ForkedAtUnixMS       int64
}

type SessionForkOperation struct {
	CommitTransactionID     string           `json:"-"`
	CommitDelta             TransactionDelta `json:"-"`
	OperationID             string
	WorkspaceID             string
	RequestID               string
	RequestHash             string
	SourceAgentSessionID    string
	TargetAgentSessionID    string
	SourceProviderSessionID string
	SourceTurnID            string
	SourceProviderTurnID    string
	TargetTurnID            string
	PointKind               string
	DriverKind              string
	DriverVersion           string
	Status                  string
	TargetProviderSessionID string
	TargetProviderTurnIDs   []string
	TargetTitle             string
	StateBindingMode        string
	StateBindingReceipt     string
	SnapshotHash            string
	LastError               string
	CreatedAtUnixMS         int64
	UpdatedAtUnixMS         int64
	DispatchedAtUnixMS      int64
	AcceptedAtUnixMS        int64
	CompletedAtUnixMS       int64
	ClientObservedAtUnixMS  int64
}

type SessionForkPrepare struct {
	OperationID          string
	WorkspaceID          string
	RequestID            string
	RequestHash          string
	SourceAgentSessionID string
	TargetAgentSessionID string
	SourceTurnID         string
	PointKind            string
	DriverKind           string
	DriverVersion        string
	ExpectedSourceHash   string
	TargetCwd            string
	TargetRuntimeContext map[string]any
	TargetSettings       map[string]any
	OccurredAtUnixMS     int64
}

type SessionForkProviderResult struct {
	WorkspaceID             string
	OperationID             string
	Status                  string
	TargetProviderSessionID string
	TargetProviderTurnIDs   []string
	StateBindingMode        string
	StateBindingReceipt     string
	LastError               string
	OccurredAtUnixMS        int64
}

type SessionForkCommitResult struct {
	TransactionID string
	CommitDelta   TransactionDelta
	Operation     SessionForkOperation
	Session       Session
	Lineage       SessionForkLineage
	Changed       bool
}

type SessionForkBoundary struct {
	Session             Session
	Turn                Turn
	RootProviderTurnIDs []string
}

type SessionForkTurnIdentity struct {
	TurnID         string
	ProviderTurnID string
	Phase          string
}

// SessionForkRecoveryCursor is the exclusive lower bound for a stable
// (created_at_unix_ms, operation_id) recovery page.
type SessionForkRecoveryCursor struct {
	CreatedAtUnixMS int64
	OperationID     string
}
