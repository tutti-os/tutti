package liveprotocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"google.golang.org/protobuf/encoding/protowire"
)

const (
	frameRevisionField   = 1
	frameStreamIDField   = 2
	frameBindingIDField  = 3
	frameEpochField      = 4
	frameDeliveriesField = 5

	deliverySeqField           = 1
	deliveryKindField          = 2
	deliveryEventField         = 3
	deliveryDiscontinuityField = 4
	deliveryAttachmentField    = 5
	deliveryGoalField          = 6
	deliveryReadyField         = 7
	deliveryRejectedField      = 8
)

// EncodeFrame uses a deliberately small protobuf wire schema. The containing
// gRPC contract transports these bytes opaquely, so every Go consumer shares
// this codec and no generated transport DTO can drift from it.
func EncodeFrame(frame Frame) ([]byte, error) {
	if err := validateFrame(frame); err != nil {
		return nil, err
	}
	var out []byte
	out = protowire.AppendTag(out, frameRevisionField, protowire.BytesType)
	out = protowire.AppendString(out, frame.ProtocolRevision)
	out = protowire.AppendTag(out, frameStreamIDField, protowire.BytesType)
	out = protowire.AppendString(out, frame.StreamID)
	out = protowire.AppendTag(out, frameBindingIDField, protowire.BytesType)
	out = protowire.AppendString(out, frame.BindingID)
	out = protowire.AppendTag(out, frameEpochField, protowire.VarintType)
	out = protowire.AppendVarint(out, frame.Epoch)
	for _, delivery := range frame.Deliveries {
		raw, err := encodeDelivery(delivery)
		if err != nil {
			return nil, err
		}
		out = protowire.AppendTag(out, frameDeliveriesField, protowire.BytesType)
		out = protowire.AppendBytes(out, raw)
	}
	if len(out) > DefaultFrameMaxBytes {
		return nil, ErrFrameTooLarge
	}
	return out, nil
}

func DecodeFrame(raw []byte) (Frame, error) {
	if len(raw) == 0 || len(raw) > DefaultFrameMaxBytes {
		return Frame{}, ErrInvalidFrame
	}
	var frame Frame
	seen := map[protowire.Number]bool{}
	for len(raw) > 0 {
		number, wireType, consumed := protowire.ConsumeTag(raw)
		if consumed < 0 {
			return Frame{}, wireParseError(consumed)
		}
		raw = raw[consumed:]
		if number != frameDeliveriesField && seen[number] {
			return Frame{}, fmt.Errorf("%w: duplicate field %d", ErrInvalidFrame, number)
		}
		seen[number] = true
		switch number {
		case frameRevisionField, frameStreamIDField, frameBindingIDField:
			if wireType != protowire.BytesType {
				return Frame{}, ErrInvalidFrame
			}
			value, n := protowire.ConsumeString(raw)
			if n < 0 {
				return Frame{}, wireParseError(n)
			}
			raw = raw[n:]
			switch number {
			case frameRevisionField:
				frame.ProtocolRevision = value
			case frameStreamIDField:
				frame.StreamID = value
			case frameBindingIDField:
				frame.BindingID = value
			}
		case frameEpochField:
			if wireType != protowire.VarintType {
				return Frame{}, ErrInvalidFrame
			}
			value, n := protowire.ConsumeVarint(raw)
			if n < 0 {
				return Frame{}, wireParseError(n)
			}
			raw = raw[n:]
			frame.Epoch = value
		case frameDeliveriesField:
			if wireType != protowire.BytesType {
				return Frame{}, ErrInvalidFrame
			}
			value, n := protowire.ConsumeBytes(raw)
			if n < 0 {
				return Frame{}, wireParseError(n)
			}
			raw = raw[n:]
			delivery, err := decodeDelivery(value)
			if err != nil {
				return Frame{}, err
			}
			frame.Deliveries = append(frame.Deliveries, delivery)
		default:
			return Frame{}, fmt.Errorf("%w: unknown field %d", ErrInvalidFrame, number)
		}
	}
	if err := validateFrame(frame); err != nil {
		return Frame{}, err
	}
	return frame, nil
}

func encodeDelivery(delivery Delivery) ([]byte, error) {
	if err := validateDelivery(delivery); err != nil {
		return nil, err
	}
	var out []byte
	out = protowire.AppendTag(out, deliverySeqField, protowire.VarintType)
	out = protowire.AppendVarint(out, delivery.Seq)
	out = protowire.AppendTag(out, deliveryKindField, protowire.VarintType)
	out = protowire.AppendVarint(out, uint64(delivery.Kind))
	var payload []byte
	var field protowire.Number
	var err error
	switch delivery.Kind {
	case DeliveryKindEvent:
		field, payload = deliveryEventField, delivery.Event
	case DeliveryKindDiscontinuity:
		field, payload = deliveryDiscontinuityField, mustMarshalControl(delivery.Discontinuity)
	case DeliveryKindAttachmentChanged:
		field, payload = deliveryAttachmentField, mustMarshalControl(delivery.AttachmentChanged)
	case DeliveryKindGoalChanged:
		field, payload = deliveryGoalField, mustMarshalControl(delivery.GoalChanged)
	case DeliveryKindStreamReady:
		field, payload = deliveryReadyField, mustMarshalControl(delivery.StreamReady)
	case DeliveryKindRejected:
		field, payload = deliveryRejectedField, mustMarshalControl(delivery.Rejected)
	default:
		err = ErrInvalidFrame
	}
	if err != nil {
		return nil, err
	}
	out = protowire.AppendTag(out, field, protowire.BytesType)
	out = protowire.AppendBytes(out, payload)
	if len(out) > DefaultDeliveryMaxBytes {
		return nil, ErrDeliveryTooLarge
	}
	return out, nil
}

func decodeDelivery(raw []byte) (Delivery, error) {
	if len(raw) == 0 || len(raw) > DefaultDeliveryMaxBytes {
		return Delivery{}, ErrDeliveryTooLarge
	}
	var delivery Delivery
	var payload []byte
	var payloadField protowire.Number
	seen := map[protowire.Number]bool{}
	for len(raw) > 0 {
		number, wireType, consumed := protowire.ConsumeTag(raw)
		if consumed < 0 || seen[number] {
			return Delivery{}, ErrInvalidFrame
		}
		seen[number] = true
		raw = raw[consumed:]
		switch number {
		case deliverySeqField, deliveryKindField:
			if wireType != protowire.VarintType {
				return Delivery{}, ErrInvalidFrame
			}
			value, n := protowire.ConsumeVarint(raw)
			if n < 0 {
				return Delivery{}, wireParseError(n)
			}
			raw = raw[n:]
			if number == deliverySeqField {
				delivery.Seq = value
			} else {
				delivery.Kind = DeliveryKind(value)
			}
		case deliveryEventField, deliveryDiscontinuityField, deliveryAttachmentField, deliveryGoalField, deliveryReadyField, deliveryRejectedField:
			if wireType != protowire.BytesType || payloadField != 0 {
				return Delivery{}, ErrInvalidFrame
			}
			value, n := protowire.ConsumeBytes(raw)
			if n < 0 {
				return Delivery{}, wireParseError(n)
			}
			raw = raw[n:]
			payloadField = number
			payload = append([]byte(nil), value...)
		default:
			return Delivery{}, fmt.Errorf("%w: unknown delivery field %d", ErrInvalidFrame, number)
		}
	}
	expectedPayload := map[DeliveryKind]protowire.Number{
		DeliveryKindEvent:             deliveryEventField,
		DeliveryKindDiscontinuity:     deliveryDiscontinuityField,
		DeliveryKindAttachmentChanged: deliveryAttachmentField,
		DeliveryKindGoalChanged:       deliveryGoalField,
		DeliveryKindStreamReady:       deliveryReadyField,
		DeliveryKindRejected:          deliveryRejectedField,
	}[delivery.Kind]
	if expectedPayload == 0 || payloadField != expectedPayload {
		return Delivery{}, ErrInvalidFrame
	}
	switch delivery.Kind {
	case DeliveryKindEvent:
		if _, err := DecodeEvent(payload); err != nil {
			delivery.Kind = DeliveryKindDiscontinuity
			delivery.Discontinuity = &Discontinuity{Reason: "invalid_delivery"}
		} else {
			delivery.Event = payload
		}
	case DeliveryKindDiscontinuity:
		delivery.Discontinuity = &Discontinuity{}
		if err := strictControlDecode(payload, delivery.Discontinuity); err != nil {
			return Delivery{}, err
		}
	case DeliveryKindAttachmentChanged:
		delivery.AttachmentChanged = &AttachmentChanged{}
		if err := strictControlDecode(payload, delivery.AttachmentChanged); err != nil {
			return Delivery{}, err
		}
	case DeliveryKindGoalChanged:
		delivery.GoalChanged = &GoalChanged{}
		if err := strictControlDecode(payload, delivery.GoalChanged); err != nil {
			return Delivery{}, err
		}
	case DeliveryKindStreamReady:
		delivery.StreamReady = &StreamReady{}
		if err := strictControlDecode(payload, delivery.StreamReady); err != nil {
			return Delivery{}, err
		}
	case DeliveryKindRejected:
		delivery.Rejected = &Rejected{}
		if err := strictControlDecode(payload, delivery.Rejected); err != nil {
			return Delivery{}, err
		}
	}
	if err := validateDelivery(delivery); err != nil {
		return Delivery{}, err
	}
	return delivery, nil
}

func validateFrame(frame Frame) error {
	if strings.TrimSpace(frame.StreamID) == "" || strings.TrimSpace(frame.BindingID) == "" || frame.Epoch == 0 ||
		len(frame.Deliveries) == 0 {
		return ErrInvalidFrame
	}
	var previous uint64
	for _, delivery := range frame.Deliveries {
		if err := validateDelivery(delivery); err != nil {
			return err
		}
		if previous != 0 && delivery.Seq != previous+1 {
			return ErrSequenceGap
		}
		previous = delivery.Seq
	}
	if frame.ProtocolRevision != ProtocolRevision && !isTypedRejectionFrame(frame) {
		return fmt.Errorf("%w: got %q want %q", ErrProtocolMismatch, frame.ProtocolRevision, ProtocolRevision)
	}
	return nil
}

func isTypedRejectionFrame(frame Frame) bool {
	return len(frame.Deliveries) == 1 &&
		frame.Deliveries[0].Kind == DeliveryKindRejected &&
		frame.Deliveries[0].Rejected != nil
}

func validateDelivery(delivery Delivery) error {
	if delivery.Seq == 0 {
		return ErrInvalidFrame
	}
	count := 0
	switch delivery.Kind {
	case DeliveryKindEvent:
		count = boolCount(len(delivery.Event) > 0)
		if count == 1 {
			if _, err := DecodeEvent(delivery.Event); err != nil {
				return err
			}
		}
	case DeliveryKindDiscontinuity:
		count = boolCount(delivery.Discontinuity != nil)
		if delivery.Discontinuity != nil && strings.TrimSpace(delivery.Discontinuity.Reason) == "" {
			return ErrInvalidFrame
		}
	case DeliveryKindAttachmentChanged:
		count = boolCount(delivery.AttachmentChanged != nil)
		if delivery.AttachmentChanged != nil &&
			(strings.TrimSpace(delivery.AttachmentChanged.BindingID) == "" ||
				strings.TrimSpace(delivery.AttachmentChanged.WorkspaceID) == "" ||
				strings.TrimSpace(delivery.AttachmentChanged.AgentSessionID) == "") {
			return ErrInvalidFrame
		}
	case DeliveryKindGoalChanged:
		count = boolCount(delivery.GoalChanged != nil)
		if delivery.GoalChanged != nil &&
			(strings.TrimSpace(delivery.GoalChanged.WorkspaceID) == "" ||
				strings.TrimSpace(delivery.GoalChanged.AgentSessionID) == "") {
			return ErrInvalidFrame
		}
	case DeliveryKindStreamReady:
		count = boolCount(delivery.StreamReady != nil)
		if delivery.StreamReady != nil &&
			(delivery.StreamReady.ProtocolRevision != ProtocolRevision ||
				strings.TrimSpace(delivery.StreamReady.StreamID) == "" ||
				strings.TrimSpace(delivery.StreamReady.BindingID) == "") {
			return ErrInvalidFrame
		}
	case DeliveryKindRejected:
		count = boolCount(delivery.Rejected != nil)
		if delivery.Rejected != nil {
			switch delivery.Rejected.Reason {
			case RejectionProtocolRevisionMismatch, RejectionPermission, RejectionBinding:
			default:
				return ErrInvalidFrame
			}
		}
	default:
		return ErrInvalidFrame
	}
	if count != 1 {
		return ErrInvalidFrame
	}
	return nil
}

func strictControlDecode(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidFrame, err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return fmt.Errorf("%w: trailing control data", ErrInvalidFrame)
	}
	return nil
}

func mustMarshalControl(value any) []byte {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return raw
}

func wireParseError(code int) error {
	return fmt.Errorf("%w: protobuf parse code %d", ErrInvalidFrame, code)
}

func boolCount(value bool) int {
	if value {
		return 1
	}
	return 0
}
