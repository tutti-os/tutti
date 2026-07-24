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

const (
	DeliveryKindEvent DeliveryKind = iota + 1
	DeliveryKindDiscontinuity
	DeliveryKindAttachmentChanged
	DeliveryKindGoalChanged
	DeliveryKindStreamReady
	DeliveryKindRejected
)

type EventType string

const (
	EventTypeMessageDelta      EventType = "message_delta"
	EventTypeTurnUpdate        EventType = "turn_update"
	EventTypeInteractionUpdate EventType = "interaction_update"
	EventTypeSessionAudit      EventType = "session_audit"
)

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
	WorkspaceID       string                     `json:"workspaceId"`
	AgentSessionID    string                     `json:"agentSessionId"`
	MessageID         string                     `json:"messageId"`
	TurnID            string                     `json:"turnId,omitempty"`
	Role              string                     `json:"role"`
	Kind              string                     `json:"kind"`
	OccurredAtUnixMS  int64                      `json:"occurredAtUnixMs"`
	Content           *MessageContentOperation   `json:"content,omitempty"`
	PayloadSet        map[string]json.RawMessage `json:"payloadSet,omitempty"`
	PayloadUnset      []string                   `json:"payloadUnset,omitempty"`
	Status            *string                    `json:"status,omitempty"`
	Semantics         json.RawMessage            `json:"semantics,omitempty"`
	StartedAtUnixMS   *int64                     `json:"startedAtUnixMs,omitempty"`
	CompletedAtUnixMS *int64                     `json:"completedAtUnixMs,omitempty"`
}

type MessageContentOperation struct {
	Operation string          `json:"operation"`
	Text      string          `json:"text,omitempty"`
	Value     json.RawMessage `json:"value,omitempty"`
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

type Discontinuity struct {
	Reason        string         `json:"reason"`
	ReconcileKeys []ReconcileKey `json:"reconcileKeys,omitempty"`
}

type AttachmentChanged struct {
	BindingID       string `json:"bindingId"`
	WorkspaceID     string `json:"workspaceId"`
	AgentSessionID  string `json:"agentSessionId"`
	CanonicalTurnID string `json:"canonicalTurnId,omitempty"`
	CallerTurnID    string `json:"callerTurnId,omitempty"`
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
	Seq               uint64
	Kind              DeliveryKind
	Event             json.RawMessage
	Discontinuity     *Discontinuity
	AttachmentChanged *AttachmentChanged
	GoalChanged       *GoalChanged
	StreamReady       *StreamReady
	Rejected          *Rejected
}

type Frame struct {
	ProtocolRevision string
	StreamID         string
	BindingID        string
	Epoch            uint64
	Deliveries       []Delivery
}

type PublishInput struct {
	Event             *Event
	Discontinuity     *Discontinuity
	AttachmentChanged *AttachmentChanged
	GoalChanged       *GoalChanged
	StreamReady       *StreamReady
	Rejected          *Rejected
	Immediate         bool
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
	Deliveries   []Delivery
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
	RecipientWorkspaceID    string
	RecipientAgentSessionID string
	CallerTurnID            string
}
