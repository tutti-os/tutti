package liveprotocol

import (
	"encoding/json"
	"errors"
	"time"
)

const (
	DefaultBatchDelay       = 10 * time.Millisecond
	DefaultBatchDeliveries  = 32
	DefaultBatchTargetBytes = 64 << 10
	DefaultDeliveryMaxBytes = 1 << 20
	DefaultFrameMaxBytes    = 2 << 20
	DefaultReplayMaxBytes   = 8 << 20
	DefaultReplayTTL        = 30 * time.Second
)

var (
	ErrInvalidFrame      = errors.New("invalid agent live frame")
	ErrProtocolMismatch  = errors.New("agent live protocol revision mismatch")
	ErrDeliveryTooLarge  = errors.New("agent live delivery exceeds size limit")
	ErrFrameTooLarge     = errors.New("agent live frame exceeds size limit")
	ErrInvalidLiveEvent  = errors.New("invalid agent activity live event")
	ErrSequenceGap       = errors.New("agent live delivery sequence gap")
	ErrLateAfterTerminal = errors.New("agent live delivery arrived after terminal fence")
)

type DeliveryKind uint8

type EventType string

const (
	EventTypeRuntimeActivityUpdate EventType = "runtime_activity_update"
	EventTypeMessageDelta          EventType = "message_delta"
	EventTypeTurnUpdate            EventType = "turn_update"
	EventTypeInteractionUpdate     EventType = "interaction_update"
	EventTypeInteractionSnapshot   EventType = "interaction_snapshot"
	EventTypeSessionAudit          EventType = "session_audit"
)

type RuntimeActivityUpdateData struct {
	WorkspaceID      string    `json:"workspaceId"`
	AgentSessionID   string    `json:"agentSessionId"`
	EventType        EventType `json:"eventType"`
	State            string    `json:"state"`
	OccurredAtUnixMS int64     `json:"occurredAtUnixMs"`
}

// Event is the normalized AgentGUI live event. Data is kept as JSON so the
// transport stays independent from lifecycle vocabulary while DecodeEvent
// still validates the closed outer contract and each supported variant.
type Event struct {
	WorkspaceID    string          `json:"workspaceId"`
	AgentSessionID string          `json:"agentSessionId"`
	EventType      EventType       `json:"eventType"`
	Data           json.RawMessage `json:"data"`
}

type MessageDeltaData struct {
	WorkspaceID       string                      `json:"workspaceId"`
	AgentSessionID    string                      `json:"agentSessionId"`
	MessageID         string                      `json:"messageId"`
	TurnID            string                      `json:"turnId"`
	Role              string                      `json:"role"`
	Kind              string                      `json:"kind"`
	OccurredAtUnixMS  int64                       `json:"occurredAtUnixMs"`
	Content           *MessageContentOperation    `json:"content,omitempty"`
	ToolOutput        *MessageToolOutputOperation `json:"toolOutput,omitempty"`
	PayloadSet        map[string]json.RawMessage  `json:"payloadSet,omitempty"`
	PayloadUnset      []string                    `json:"payloadUnset,omitempty"`
	Status            *string                     `json:"status,omitempty"`
	Semantics         json.RawMessage             `json:"semantics,omitempty"`
	StartedAtUnixMS   *int64                      `json:"startedAtUnixMs,omitempty"`
	CompletedAtUnixMS *int64                      `json:"completedAtUnixMs,omitempty"`
}

type MessageContentOperation struct {
	Operation string          `json:"operation"`
	Text      string          `json:"text,omitempty"`
	Value     json.RawMessage `json:"value,omitempty"`
}

// MessageToolOutputOperation mutates only the normalized, displayable
// payload.output.text projection of a tool_call. Provider adapters may create
// this operation only from an explicit ordered output delta, or from a
// cumulative textual snapshot whose prefix relationship they have verified.
// OffsetBytes makes append replay/idempotency failures observable at the
// caller instead of silently duplicating or corrupting output.
type MessageToolOutputOperation struct {
	Operation   string `json:"operation"`
	Text        string `json:"text"`
	OffsetBytes *int64 `json:"offsetBytes,omitempty"`
}

type TurnUpdateData struct {
	WorkspaceID      string    `json:"workspaceId"`
	AgentSessionID   string    `json:"agentSessionId"`
	EventType        EventType `json:"eventType"`
	OccurredAtUnixMS int64     `json:"occurredAtUnixMs"`
	ActiveTurnID     *string   `json:"activeTurnId"`
	Turn             EventTurn `json:"turn"`
}

type EventTurn struct {
	TurnID                string                `json:"turnId"`
	AgentSessionID        string                `json:"agentSessionId"`
	CapabilityRefs        []CapabilityReference `json:"capabilityRefs,omitempty"`
	Phase                 string                `json:"phase"`
	Origin                string                `json:"origin"`
	SourceGoalOperationID *string               `json:"sourceGoalOperationId,omitempty"`
	SourceGoalRevision    *int64                `json:"sourceGoalRevision,omitempty"`
	SourceGoalRepairEpoch *int64                `json:"sourceGoalRepairEpoch,omitempty"`
	Outcome               *string               `json:"outcome"`
	Error                 *EventError           `json:"error"`
	FileChanges           json.RawMessage       `json:"fileChanges"`
	CompletedCommand      *CompletedCommand     `json:"completedCommand"`
	StartedAtUnixMS       int64                 `json:"startedAtUnixMs"`
	SettledAtUnixMS       *int64                `json:"settledAtUnixMs"`
	UpdatedAtUnixMS       int64                 `json:"updatedAtUnixMs"`
}

type CapabilityReference struct {
	Capability string `json:"capability"`
	Source     string `json:"source"`
}

type EventError struct {
	Message string `json:"message"`
	Code    string `json:"code,omitempty"`
}

type CompletedCommand struct {
	Kind   string `json:"kind"`
	Status string `json:"status"`
}

type InteractionUpdateData struct {
	WorkspaceID      string           `json:"workspaceId"`
	AgentSessionID   string           `json:"agentSessionId"`
	EventType        EventType        `json:"eventType"`
	OccurredAtUnixMS int64            `json:"occurredAtUnixMs"`
	Interaction      EventInteraction `json:"interaction"`
}

// InteractionSnapshotData replaces the complete interaction collection for
// one exact root Turn projection. RootTurnID scopes the collection even when
// Interactions is empty, so consumers never infer its identity from members.
type InteractionSnapshotData struct {
	WorkspaceID      string             `json:"workspaceId"`
	AgentSessionID   string             `json:"agentSessionId"`
	EventType        EventType          `json:"eventType"`
	OccurredAtUnixMS int64              `json:"occurredAtUnixMs"`
	RootTurnID       string             `json:"rootTurnId"`
	Interactions     []EventInteraction `json:"interactions"`
}

type EventInteraction struct {
	RequestID       string          `json:"requestId"`
	AgentSessionID  string          `json:"agentSessionId"`
	TurnID          string          `json:"turnId"`
	Kind            string          `json:"kind"`
	Status          string          `json:"status"`
	ToolName        *string         `json:"toolName"`
	Input           json.RawMessage `json:"input"`
	Output          json.RawMessage `json:"output"`
	Metadata        json.RawMessage `json:"metadata"`
	CreatedAtUnixMS int64           `json:"createdAtUnixMs"`
	UpdatedAtUnixMS int64           `json:"updatedAtUnixMs"`
}

type SessionAuditData struct {
	WorkspaceID    string       `json:"workspaceId"`
	AgentSessionID string       `json:"agentSessionId"`
	EventType      EventType    `json:"eventType"`
	Audit          SessionAudit `json:"audit"`
}

type SessionAudit struct {
	AuditID          string          `json:"auditId"`
	Role             string          `json:"role"`
	Payload          json.RawMessage `json:"payload"`
	OccurredAtUnixMS int64           `json:"occurredAtUnixMs"`
	Version          int64           `json:"version"`
}

type ReconcileKey struct {
	Kind           string `json:"kind"`
	WorkspaceID    string `json:"workspaceId"`
	AgentSessionID string `json:"agentSessionId"`
	MessageID      string `json:"messageId,omitempty"`
	TurnID         string `json:"turnId,omitempty"`
	RequestID      string `json:"requestId,omitempty"`
}

// The JSON controls below are revisioned by
// schema/agent-activity-live-wire-contract.json. Keep their field shapes and
// closed vocabularies aligned with that declarative contract.
type Discontinuity struct {
	Reason        string         `json:"reason"`
	ReconcileKeys []ReconcileKey `json:"reconcileKeys,omitempty"`
}

type AttachmentChanged struct {
	BindingID       string `json:"bindingId"`
	WorkspaceID     string `json:"workspaceId"`
	AgentSessionID  string `json:"agentSessionId"`
	CanonicalTurnID string `json:"canonicalTurnId,omitempty"`
	// CanonicalTurnIDs contains the canonical Turn identities that are durably
	// authorized for this attachment. Invocation attachments include their
	// singular anchor and Host-proven continuations. Turnless Goal attachments
	// have no singular anchor and grow this list from Host-proven Goal Turns.
	CanonicalTurnIDs []string `json:"canonicalTurnIds,omitempty"`
	CallerTurnID     string   `json:"callerTurnId,omitempty"`
	// CurrentInteractionRootTurnID is the Host-proven root whose complete
	// interaction collection belongs to this projection fence. It is empty
	// only while a turnless attachment has not observed its first Goal Turn.
	CurrentInteractionRootTurnID string `json:"currentInteractionRootTurnId"`
	AttachmentRevision           uint64 `json:"attachmentRevision"`
}

// AttachmentCaughtUp fences one attachment recovery baseline. StreamReady
// establishes transport readiness only; callers may treat an attachment as
// synchronized after this control arrives for the same stream epoch and
// attachment revision.
type AttachmentCaughtUp struct {
	BindingID                    string   `json:"bindingId"`
	WorkspaceID                  string   `json:"workspaceId"`
	AgentSessionID               string   `json:"agentSessionId"`
	CanonicalTurnID              string   `json:"canonicalTurnId,omitempty"`
	CanonicalTurnIDs             []string `json:"canonicalTurnIds,omitempty"`
	CallerTurnID                 string   `json:"callerTurnId,omitempty"`
	CurrentInteractionRootTurnID string   `json:"currentInteractionRootTurnId"`
	AttachmentRevision           uint64   `json:"attachmentRevision"`
}

type GoalChanged struct {
	WorkspaceID    string `json:"workspaceId"`
	AgentSessionID string `json:"agentSessionId"`
	Revision       int64  `json:"revision,omitempty"`
}

type StreamReady struct {
	ProtocolRevision string `json:"protocolRevision"`
	StreamID         string `json:"streamId"`
	BindingID        string `json:"bindingId"`
}

type RejectionReason string

const (
	RejectionProtocolRevisionMismatch RejectionReason = "protocol_revision_mismatch"
	RejectionPermission               RejectionReason = "permission"
	RejectionBinding                  RejectionReason = "binding"
)

type Rejected struct {
	Reason           RejectionReason `json:"reason"`
	ExpectedRevision string          `json:"expectedRevision,omitempty"`
	ReceivedRevision string          `json:"receivedRevision,omitempty"`
}

type Delivery struct {
	Seq                uint64
	Kind               DeliveryKind
	Event              json.RawMessage
	Discontinuity      *Discontinuity
	AttachmentChanged  *AttachmentChanged
	AttachmentCaughtUp *AttachmentCaughtUp
	GoalChanged        *GoalChanged
	StreamReady        *StreamReady
	Rejected           *Rejected
}

type Frame struct {
	ProtocolRevision string
	StreamID         string
	BindingID        string
	Epoch            uint64
	Deliveries       []Delivery
}

type PublishInput struct {
	Event              *Event
	Discontinuity      *Discontinuity
	AttachmentChanged  *AttachmentChanged
	AttachmentCaughtUp *AttachmentCaughtUp
	GoalChanged        *GoalChanged
	StreamReady        *StreamReady
	Rejected           *Rejected
	Immediate          bool
}

type PublisherConfig struct {
	StreamID         string
	BindingID        string
	Epoch            uint64
	BatchDelay       time.Duration
	BatchDeliveries  int
	BatchTargetBytes int
	DeliveryMaxBytes int
	FrameMaxBytes    int
	ReplayTTL        time.Duration
	ReplayMaxBytes   int
	Now              func() time.Time
}

type ResumeRequest struct {
	Epoch    uint64
	AfterSeq uint64
}

type ResumeResult struct {
	Hit          bool
	CurrentEpoch uint64
	// Frames are already partitioned against the publisher's encoded-frame
	// ceiling. Callers must send them independently and in order.
	Frames []Frame
}

type SubscriberConfig struct {
	ProtocolRevision string
	Epoch            uint64
	AfterSeq         uint64
}

type ApplyResult struct {
	Accepted          []Delivery
	DuplicateCount    int
	ReconcileRequired bool
	Reason            string
	LastContiguousSeq uint64
}

type ProjectionContext struct {
	OwnerWorkspaceID        string
	OwnerAgentSessionID     string
	CanonicalTurnID         string
	CanonicalTurnIDs        []string
	RecipientWorkspaceID    string
	RecipientAgentSessionID string
	CallerTurnID            string
}
