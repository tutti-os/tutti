package liveprotocol

import (
	"fmt"
	"strings"
)

type Subscriber struct {
	revision          string
	streamID          string
	bindingID         string
	epoch             uint64
	lastContiguousSeq uint64
}

func NewSubscriber(config SubscriberConfig) (*Subscriber, error) {
	revision := strings.TrimSpace(config.ProtocolRevision)
	if revision == "" {
		revision = ProtocolRevision
	}
	if revision != ProtocolRevision {
		return nil, ErrProtocolMismatch
	}
	return &Subscriber{
		revision:          revision,
		epoch:             config.Epoch,
		lastContiguousSeq: config.AfterSeq,
	}, nil
}

func (s *Subscriber) Apply(frame Frame) ApplyResult {
	result := ApplyResult{LastContiguousSeq: s.lastContiguousSeq}
	if frame.ProtocolRevision != s.revision {
		result.ReconcileRequired, result.Reason = true, "protocol_mismatch"
		return result
	}
	if s.streamID == "" {
		s.streamID, s.bindingID = frame.StreamID, frame.BindingID
	} else if s.streamID != frame.StreamID || s.bindingID != frame.BindingID {
		result.ReconcileRequired, result.Reason = true, "stream_identity_changed"
		return result
	}
	if s.epoch == 0 {
		s.epoch = frame.Epoch
	} else if frame.Epoch != s.epoch {
		result.ReconcileRequired, result.Reason = true, "epoch_changed"
		return result
	}
	for _, delivery := range frame.Deliveries {
		if delivery.Seq <= s.lastContiguousSeq {
			result.DuplicateCount++
			continue
		}
		if delivery.Seq != s.lastContiguousSeq+1 {
			result.ReconcileRequired, result.Reason = true, "sequence_gap"
			break
		}
		s.lastContiguousSeq = delivery.Seq
		result.LastContiguousSeq = delivery.Seq
		result.Accepted = append(result.Accepted, cloneDelivery(delivery))
		if delivery.Kind == DeliveryKindDiscontinuity {
			result.ReconcileRequired = true
			result.Reason = delivery.Discontinuity.Reason
		}
	}
	return result
}

func (s *Subscriber) ResumeCursor() ResumeRequest {
	return ResumeRequest{Epoch: s.epoch, AfterSeq: s.lastContiguousSeq}
}

func DecodeAndApply(subscriber *Subscriber, encoded []byte) (ApplyResult, error) {
	if subscriber == nil {
		return ApplyResult{}, fmt.Errorf("%w: nil subscriber", ErrInvalidFrame)
	}
	frame, err := DecodeFrame(encoded)
	if err != nil {
		return ApplyResult{}, err
	}
	return subscriber.Apply(frame), nil
}
