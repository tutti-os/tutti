package agenthost

import "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"

// EditRetryImpactScope is the provider-neutral blast-radius projection for a
// single durable edit-retry operation. It is derived from the operation's
// exact Session fence and is intentionally never daemon-wide.
type EditRetryImpactScope string

const EditRetryImpactScopeSession EditRetryImpactScope = "session"

// EditRetryAdmissionPolicy is a product-supplied policy boundary. It governs
// only whether Host may create a *new* edit-retry operation. Once an operation
// is durable, its checkpoint and provider evidence alone govern recovery; a
// rollout rollback must not strand that operation behind the new-admission
// gate.
type EditRetryAdmissionPolicy string

const (
	EditRetryAdmissionAllowNew EditRetryAdmissionPolicy = "allow_new"
	EditRetryAdmissionDenyNew  EditRetryAdmissionPolicy = "deny_new"
)

func (policy EditRetryAdmissionPolicy) AllowsNew() bool {
	return policy == "" || policy == EditRetryAdmissionAllowNew
}

// EditRetryRecoveryPolicy selects how a process treats already durable V2
// operations. It never changes their eligibility facts or clears their fence:
// drain follows the normal checkpoint saga; reconcile_only durably blocks
// automatic work and leaves only explicit read-only reconciliation available.
type EditRetryRecoveryPolicy string

const (
	EditRetryRecoveryDrain         EditRetryRecoveryPolicy = "drain"
	EditRetryRecoveryReconcileOnly EditRetryRecoveryPolicy = "reconcile_only"
)

func (policy EditRetryRecoveryPolicy) AllowsMutation() bool {
	return policy == "" || policy == EditRetryRecoveryDrain
}

type EditRetryRecoveryAction string

const (
	EditRetryRecoveryActionReconcile        EditRetryRecoveryAction = "reconcile"
	EditRetryRecoveryActionRetryReplacement EditRetryRecoveryAction = "retry_replacement"
	EditRetryRecoveryActionAbandon          EditRetryRecoveryAction = "abandon"
)

type RecoverEditRetryInput struct {
	Action                   EditRetryRecoveryAction
	ClientActionID           string
	ExpectedOperationVersion int64
	ExpectedHistoryRevision  uint64
}

// EditRetryReasonCode is the stable provider-neutral classification; raw diagnostics never cross this contract.
type EditRetryReasonCode = canonical.EditRetryReasonCode

const (
	EditRetryReasonCodeRetryWait                  = canonical.EditRetryReasonRetryWait
	EditRetryReasonCodeRetryBudgetExhausted       = canonical.EditRetryReasonRetryBudgetExhausted
	EditRetryReasonCodeLocalStateInconsistent     = canonical.EditRetryReasonLocalStateInconsistent
	EditRetryReasonCodeProviderUnsupported        = canonical.EditRetryReasonProviderUnsupported
	EditRetryReasonCodeTurnNotFound               = canonical.EditRetryReasonTurnNotFound
	EditRetryReasonCodeTurnNotLatest              = canonical.EditRetryReasonTurnNotLatest
	EditRetryReasonCodeTurnNotSettled             = canonical.EditRetryReasonTurnNotSettled
	EditRetryReasonCodeHistoryRevisionConflict    = canonical.EditRetryReasonHistoryRevisionConflict
	EditRetryReasonCodeOperationConflict          = canonical.EditRetryReasonOperationConflict
	EditRetryReasonCodeRecoveryRequired           = canonical.EditRetryReasonRecoveryRequired
	EditRetryReasonCodeProviderRejected           = canonical.EditRetryReasonProviderRejected
	EditRetryReasonCodeProviderOutcomeUnknown     = canonical.EditRetryReasonProviderOutcomeUnknown
	EditRetryReasonCodeReplacementNotProvenAbsent = canonical.EditRetryReasonReplacementNotProvenAbsent
	EditRetryReasonCodeRolloutDisabled            = canonical.EditRetryReasonRolloutDisabled
)

type EditRetryInput struct {
	EditedText              string
	ClientOperationID       string
	ExpectedHistoryRevision uint64
}
type EditRetryState string

const (
	EditRetryStatePrepared         EditRetryState = "prepared"
	EditRetryStateRollingBack      EditRetryState = "rolling_back"
	EditRetryStateResendPending    EditRetryState = "resend_pending"
	EditRetryStateRecoveryRequired EditRetryState = "recovery_required"
	EditRetryStateCompleted        EditRetryState = "completed"
)

type EditRetryResult struct {
	OperationID       string
	OperationVersion  int64
	State             EditRetryState
	RetractedTurnID   string
	ReplacementTurnID string
	HistoryRevision   uint64
	ReasonCode        EditRetryReasonCode
	Automatic         bool
	NextAttemptAtMS   int64
	Attempt           int
	AvailableActions  []EditRetryRecoveryAction
}
type EditRetryAvailability struct {
	Supported        bool
	Eligible         bool
	TurnID           string
	HistoryRevision  uint64
	RecoveryState    EditRetryState
	OperationID      string
	OperationVersion int64
	Automatic        bool
	NextAttemptAtMS  int64
	Attempt          int
	AvailableActions []EditRetryRecoveryAction
	ReasonCode       EditRetryReasonCode
}

// ImpactScope is constant for edit-retry: all durable recovery state is fenced
// to the exact Agent Session named by the operation. Consumers must not invent
// a daemon-wide impact scope from a local recovery result.
func (EditRetryAvailability) ImpactScope() EditRetryImpactScope {
	return EditRetryImpactScopeSession
}

// ImpactScope has the same single-Session meaning for a command result as it
// does for availability.
func (EditRetryResult) ImpactScope() EditRetryImpactScope {
	return EditRetryImpactScopeSession
}
