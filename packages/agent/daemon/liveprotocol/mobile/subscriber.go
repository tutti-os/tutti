// Package liveprotocolmobile exposes the Agent live-protocol subscriber through
// gomobile without moving Agent semantics into DeviceLink.
package liveprotocolmobile

import (
	"encoding/json"
	"fmt"

	"github.com/tutti-os/tutti/packages/agent/daemon/liveprotocol"
)

type Subscriber struct {
	subscriber *liveprotocol.Subscriber
}

type applyEnvelope struct {
	Accepted          []deliveryEnvelope `json:"accepted"`
	AfterSeq          int64              `json:"afterSeq"`
	DuplicateCount    int                `json:"duplicateCount"`
	Epoch             int64              `json:"epoch"`
	Reason            string             `json:"reason,omitempty"`
	ReconcileRequired bool               `json:"reconcileRequired"`
}

type deliveryEnvelope struct {
	Kind               string                           `json:"kind"`
	Seq                int64                            `json:"seq"`
	Event              json.RawMessage                  `json:"event,omitempty"`
	Discontinuity      *liveprotocol.Discontinuity      `json:"discontinuity,omitempty"`
	AttachmentChanged  *liveprotocol.AttachmentChanged  `json:"attachmentChanged,omitempty"`
	AttachmentCaughtUp *liveprotocol.AttachmentCaughtUp `json:"attachmentCaughtUp,omitempty"`
	GoalChanged        *liveprotocol.GoalChanged        `json:"goalChanged,omitempty"`
	StreamReady        *liveprotocol.StreamReady        `json:"streamReady,omitempty"`
	Rejected           *liveprotocol.Rejected           `json:"rejected,omitempty"`
}

func ProtocolRevision() string {
	return liveprotocol.ProtocolRevision
}

func NewSubscriber(epoch int64, afterSeq int64) (*Subscriber, error) {
	if epoch < 0 || afterSeq < 0 {
		return nil, fmt.Errorf("agent live resume cursor must not be negative")
	}
	subscriber, err := liveprotocol.NewSubscriber(liveprotocol.SubscriberConfig{
		Epoch:    uint64(epoch),
		AfterSeq: uint64(afterSeq),
	})
	if err != nil {
		return nil, err
	}
	return &Subscriber{subscriber: subscriber}, nil
}

// Apply validates one protobuf-wire frame and returns only accepted,
// contiguous deliveries as JSON for the React Native boundary.
func (s *Subscriber) Apply(encoded []byte) (string, error) {
	if s == nil || s.subscriber == nil {
		return "", fmt.Errorf("agent live subscriber is unavailable")
	}
	result, err := liveprotocol.DecodeAndApply(s.subscriber, encoded)
	if err != nil {
		return "", err
	}
	cursor := s.subscriber.ResumeCursor()
	if cursor.Epoch > uint64(^uint64(0)>>1) || cursor.AfterSeq > uint64(^uint64(0)>>1) {
		return "", fmt.Errorf("agent live cursor exceeds mobile integer range")
	}
	envelope := applyEnvelope{
		Accepted:          make([]deliveryEnvelope, 0, len(result.Accepted)),
		AfterSeq:          int64(cursor.AfterSeq),
		DuplicateCount:    result.DuplicateCount,
		Epoch:             int64(cursor.Epoch),
		Reason:            result.Reason,
		ReconcileRequired: result.ReconcileRequired,
	}
	for _, delivery := range result.Accepted {
		envelope.Accepted = append(envelope.Accepted, deliveryEnvelope{
			Kind:               deliveryKindName(delivery.Kind),
			Seq:                int64(delivery.Seq),
			Event:              append(json.RawMessage(nil), delivery.Event...),
			Discontinuity:      delivery.Discontinuity,
			AttachmentChanged:  delivery.AttachmentChanged,
			AttachmentCaughtUp: delivery.AttachmentCaughtUp,
			GoalChanged:        delivery.GoalChanged,
			StreamReady:        delivery.StreamReady,
			Rejected:           delivery.Rejected,
		})
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		return "", fmt.Errorf("encode agent live mobile delivery: %w", err)
	}
	return string(raw), nil
}

func deliveryKindName(kind liveprotocol.DeliveryKind) string {
	switch kind {
	case liveprotocol.DeliveryKindEvent:
		return "event"
	case liveprotocol.DeliveryKindDiscontinuity:
		return "discontinuity"
	case liveprotocol.DeliveryKindAttachmentChanged:
		return "attachment_changed"
	case liveprotocol.DeliveryKindAttachmentCaughtUp:
		return "attachment_caught_up"
	case liveprotocol.DeliveryKindGoalChanged:
		return "goal_changed"
	case liveprotocol.DeliveryKindStreamReady:
		return "stream_ready"
	case liveprotocol.DeliveryKindRejected:
		return "rejected"
	default:
		return "unknown"
	}
}
