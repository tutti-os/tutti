package storesqlite

import (
	"encoding/json"
	"errors"
)

const (
	SessionForkPointThroughTurn       = "through_turn"
	SessionForkStatusPrepared         = "prepared"
	SessionForkStatusDispatching      = "dispatching"
	SessionForkStatusProviderAccepted = "provider_accepted"
	SessionForkStatusCommitted        = "committed"
	SessionForkStatusFailed           = "failed"
	SessionForkStatusUnknown          = "unknown"
)

// SessionForkBoundaryReason is a stable, content-free diagnostic code for one
// fail-closed through-Turn boundary validation.
type SessionForkBoundaryReason string

const (
	SessionForkBoundaryReasonSourceNotRoot                SessionForkBoundaryReason = "agent_session_fork_source_not_root"
	SessionForkBoundaryReasonSourceActiveTurn             SessionForkBoundaryReason = "agent_session_fork_source_active_turn"
	SessionForkBoundaryReasonProviderSessionMissing       SessionForkBoundaryReason = "agent_session_fork_provider_session_missing"
	SessionForkBoundaryReasonPendingInteraction           SessionForkBoundaryReason = "agent_session_fork_pending_interaction"
	SessionForkBoundaryReasonSourceNotQuiescent           SessionForkBoundaryReason = "agent_session_fork_source_not_quiescent"
	SessionForkBoundaryReasonTurnNotFound                 SessionForkBoundaryReason = "agent_session_fork_turn_not_found"
	SessionForkBoundaryReasonTurnSequenceMissing          SessionForkBoundaryReason = "agent_session_fork_turn_sequence_missing"
	SessionForkBoundaryReasonTurnNotSettled               SessionForkBoundaryReason = "agent_session_fork_turn_not_settled"
	SessionForkBoundaryReasonTurnSequenceUnverified       SessionForkBoundaryReason = "agent_session_fork_turn_sequence_unverified"
	SessionForkBoundaryReasonProviderTurnMissing          SessionForkBoundaryReason = "agent_session_fork_provider_turn_missing"
	SessionForkBoundaryReasonPrefixTurnMissing            SessionForkBoundaryReason = "agent_session_fork_prefix_turn_missing"
	SessionForkBoundaryReasonPrefixTurnNotSettled         SessionForkBoundaryReason = "agent_session_fork_prefix_turn_not_settled"
	SessionForkBoundaryReasonPrefixSequenceUnverified     SessionForkBoundaryReason = "agent_session_fork_prefix_sequence_unverified"
	SessionForkBoundaryReasonPrefixProviderTurnMissing    SessionForkBoundaryReason = "agent_session_fork_prefix_provider_turn_missing"
	SessionForkBoundaryReasonProviderTurnDuplicate        SessionForkBoundaryReason = "agent_session_fork_provider_turn_duplicate"
	SessionForkBoundaryReasonProviderTurnBoundaryMismatch SessionForkBoundaryReason = "agent_session_fork_provider_turn_boundary_mismatch"
	SessionForkBoundaryReasonDescendantLaneUnsupported    SessionForkBoundaryReason = "agent_session_fork_descendant_lane_unsupported"
	SessionForkBoundaryReasonBoundaryMessagesMissing      SessionForkBoundaryReason = "agent_session_fork_boundary_messages_missing"
	SessionForkBoundaryReasonTurnlessMessageUnsupported   SessionForkBoundaryReason = "agent_session_fork_turnless_message_unsupported"
	SessionForkBoundaryReasonAttachmentUnsupported        SessionForkBoundaryReason = "agent_session_fork_attachment_unsupported"
)

var (
	ErrSessionForkRequestConflict             = errors.New("agent session fork request conflicts with an existing operation")
	ErrSessionForkSourceState                 = errors.New("agent session cannot be forked in its current state")
	ErrSessionForkInProgress                  = errors.New("agent session has a fork operation in progress")
	ErrSessionForkTurnState                   = errors.New("agent session fork turn does not have a usable provider binding")
	ErrSessionForkMaterializationInconsistent = errors.New("agent session fork materialization evidence is permanently inconsistent")
	ErrSessionForkTargetReserved              = errors.New("agent session fork target is reserved")
	ErrSessionForkTransition                  = errors.New("agent session fork operation transition is invalid")
)

// SessionForkBoundaryError preserves the exact failed boundary invariant while
// remaining compatible with ErrSessionForkTurnState.
type SessionForkBoundaryError struct {
	Reason SessionForkBoundaryReason
	detail string
}

func (e *SessionForkBoundaryError) Error() string {
	if e == nil {
		return ""
	}
	if e.detail == "" {
		return ErrSessionForkTurnState.Error()
	}
	return ErrSessionForkTurnState.Error() + ": " + e.detail
}

func (*SessionForkBoundaryError) Unwrap() error {
	return ErrSessionForkTurnState
}

// ForkBoundaryReason exposes the stable code without exposing canonical data.
func (e *SessionForkBoundaryError) ForkBoundaryReason() string {
	if e == nil {
		return ""
	}
	return string(e.Reason)
}

func newSessionForkBoundaryError(
	reason SessionForkBoundaryReason,
	detail string,
) error {
	return &SessionForkBoundaryError{Reason: reason, detail: detail}
}

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
	CommitTransactionID           string           `json:"-"`
	CommitDelta                   TransactionDelta `json:"-"`
	OperationID                   string
	WorkspaceID                   string
	RequestID                     string
	RequestHash                   string
	SourceAgentSessionID          string
	TargetAgentSessionID          string
	SourceProviderSessionID       string
	SourceTurnID                  string
	SourceProviderTurnID          string
	SourceProviderTurnBindingJSON json.RawMessage
	TargetTurnID                  string
	PointKind                     string
	DriverKind                    string
	DriverVersion                 string
	Status                        string
	TargetProviderSessionID       string
	TargetProviderTurnBindings    []SessionForkProviderTurnBinding
	TargetTitle                   string
	StateBindingMode              string
	StateBindingReceipt           string
	SnapshotHash                  string
	LastError                     string
	CreatedAtUnixMS               int64
	UpdatedAtUnixMS               int64
	DispatchedAtUnixMS            int64
	AcceptedAtUnixMS              int64
	CompletedAtUnixMS             int64
	ClientObservedAtUnixMS        int64
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
	TargetCwd            string
	TargetRuntimeContext map[string]any
	TargetSettings       map[string]any
	OccurredAtUnixMS     int64
}

type SessionForkProviderResult struct {
	WorkspaceID                string
	OperationID                string
	Status                     string
	TargetProviderSessionID    string
	TargetProviderTurnBindings []SessionForkProviderTurnBinding
	StateBindingMode           string
	StateBindingReceipt        string
	LastError                  string
	OccurredAtUnixMS           int64
}

type SessionForkProviderTurnBinding struct {
	ProviderTurnID          string          `json:"providerTurnId"`
	ProviderTurnBindingJSON json.RawMessage `json:"providerTurnBindingJson"`
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
	RejectionReason     SessionForkBoundaryReason
	rejectionDetail     string
}

// RejectionError returns the typed reason carried by an unsupported boundary.
func (b SessionForkBoundary) RejectionError() error {
	if b.RejectionReason == "" {
		return nil
	}
	return newSessionForkBoundaryError(b.RejectionReason, b.rejectionDetail)
}

func rejectedSessionForkBoundary(
	reason SessionForkBoundaryReason,
	detail string,
) SessionForkBoundary {
	return SessionForkBoundary{
		RejectionReason: reason,
		rejectionDetail: detail,
	}
}

type SessionForkTurnIdentity struct {
	TurnID         string
	ProviderTurnID string
	Phase          string
}

// SessionForkAttachmentBinding is frozen with the canonical snapshot. The
// target identity is deterministic for the operation, so staging is
// idempotent across a crash before provider dispatch.
type SessionForkAttachmentBinding struct {
	SourceAttachmentID string
	TargetAttachmentID string
}

// SessionForkRecoveryCursor is the exclusive lower bound for a stable
// (created_at_unix_ms, operation_id) recovery page.
type SessionForkRecoveryCursor struct {
	CreatedAtUnixMS int64
	OperationID     string
}
