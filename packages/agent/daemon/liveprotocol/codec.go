package liveprotocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"google.golang.org/protobuf/encoding/protowire"
)

// EncodeFrame uses a deliberately small protobuf wire schema. The containing
// gRPC contract transports these bytes opaquely, so every Go consumer shares
// this codec and no generated transport DTO can drift from it. Field numbers
// and delivery-kind values are generated from the revisioned wire contract.
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

func frameEnvelopeWireSize(frame Frame) int {
	return protowire.SizeTag(frameRevisionField) +
		protowire.SizeBytes(len(frame.ProtocolRevision)) +
		protowire.SizeTag(frameStreamIDField) +
		protowire.SizeBytes(len(frame.StreamID)) +
		protowire.SizeTag(frameBindingIDField) +
		protowire.SizeBytes(len(frame.BindingID)) +
		protowire.SizeTag(frameEpochField) +
		protowire.SizeVarint(frame.Epoch)
}

func framedDeliveryWireSize(encodedDeliveryBytes int) int {
	return protowire.SizeTag(frameDeliveriesField) +
		protowire.SizeBytes(encodedDeliveryBytes)
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
	case DeliveryKindAttachmentCaughtUp:
		field, payload = deliveryAttachmentCaughtUpField, mustMarshalControl(delivery.AttachmentCaughtUp)
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
		case deliveryEventField, deliveryDiscontinuityField, deliveryAttachmentField, deliveryGoalField, deliveryReadyField, deliveryRejectedField, deliveryAttachmentCaughtUpField:
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
		DeliveryKindEvent:              deliveryEventField,
		DeliveryKindDiscontinuity:      deliveryDiscontinuityField,
		DeliveryKindAttachmentChanged:  deliveryAttachmentField,
		DeliveryKindAttachmentCaughtUp: deliveryAttachmentCaughtUpField,
		DeliveryKindGoalChanged:        deliveryGoalField,
		DeliveryKindStreamReady:        deliveryReadyField,
		DeliveryKindRejected:           deliveryRejectedField,
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
	case DeliveryKindAttachmentCaughtUp:
		delivery.AttachmentCaughtUp = &AttachmentCaughtUp{}
		if err := strictControlDecode(payload, delivery.AttachmentCaughtUp); err != nil {
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
		if delivery.AttachmentChanged != nil && !validAttachmentControl(
			delivery.AttachmentChanged.BindingID,
			delivery.AttachmentChanged.WorkspaceID,
			delivery.AttachmentChanged.AgentSessionID,
			delivery.AttachmentChanged.CanonicalTurnID,
			delivery.AttachmentChanged.CanonicalTurnIDs,
			delivery.AttachmentChanged.CallerTurnID,
			delivery.AttachmentChanged.CurrentInteractionRootTurnID,
			delivery.AttachmentChanged.AttachmentRevision,
		) {
			return ErrInvalidFrame
		}
	case DeliveryKindAttachmentCaughtUp:
		count = boolCount(delivery.AttachmentCaughtUp != nil)
		if delivery.AttachmentCaughtUp != nil && !validAttachmentControl(
			delivery.AttachmentCaughtUp.BindingID,
			delivery.AttachmentCaughtUp.WorkspaceID,
			delivery.AttachmentCaughtUp.AgentSessionID,
			delivery.AttachmentCaughtUp.CanonicalTurnID,
			delivery.AttachmentCaughtUp.CanonicalTurnIDs,
			delivery.AttachmentCaughtUp.CallerTurnID,
			delivery.AttachmentCaughtUp.CurrentInteractionRootTurnID,
			delivery.AttachmentCaughtUp.AttachmentRevision,
		) {
			return ErrInvalidFrame
		}
	case DeliveryKindGoalChanged:
		count = boolCount(delivery.GoalChanged != nil)
		if delivery.GoalChanged != nil &&
			(strings.TrimSpace(delivery.GoalChanged.WorkspaceID) == "" ||
				strings.TrimSpace(delivery.GoalChanged.AgentSessionID) == "" ||
				delivery.GoalChanged.Revision < 0) {
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

func validAttachmentControl(
	bindingID, workspaceID, agentSessionID, canonicalTurnID string, canonicalTurnIDs []string, callerTurnID,
	currentInteractionRootTurnID string,
	revision uint64,
) bool {
	if strings.TrimSpace(bindingID) == "" ||
		strings.TrimSpace(workspaceID) == "" ||
		strings.TrimSpace(agentSessionID) == "" ||
		revision == 0 {
		return false
	}
	// Goal-only attachments are turnless; invocation attachments always carry
	// both sides of the Turn identity mapping. A half-populated pair cannot be
	// projected safely by a recipient. The optional canonical set may still be
	// populated for a turnless attachment after Host proves each Goal Turn.
	canonicalTurnID = strings.TrimSpace(canonicalTurnID)
	callerTurnID = strings.TrimSpace(callerTurnID)
	currentInteractionRootTurnID = strings.TrimSpace(currentInteractionRootTurnID)
	if (canonicalTurnID == "") != (callerTurnID == "") {
		return false
	}
	if len(canonicalTurnIDs) == 0 {
		// A singular anchor is the complete identity set. A turnless attachment
		// with no set has not yet observed a Host-proven Goal Turn.
		if canonicalTurnID == "" {
			return currentInteractionRootTurnID == ""
		}
		return currentInteractionRootTurnID == canonicalTurnID
	}
	seen := make(map[string]struct{}, len(canonicalTurnIDs))
	for _, candidate := range canonicalTurnIDs {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			return false
		}
		if _, ok := seen[candidate]; ok {
			return false
		}
		seen[candidate] = struct{}{}
	}
	if canonicalTurnID != "" {
		_, anchored := seen[canonicalTurnID]
		return anchored && currentInteractionRootTurnID == canonicalTurnID
	}
	_, current := seen[currentInteractionRootTurnID]
	return currentInteractionRootTurnID != "" && current
}

func strictControlDecode(raw []byte, target any) error {
	if err := validateRequiredControlFields(raw, target); err != nil {
		return err
	}
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

func validateRequiredControlFields(raw []byte, target any) error {
	var required []string
	switch target.(type) {
	case *AttachmentChanged, *AttachmentCaughtUp:
		required = []string{"currentInteractionRootTurnId"}
	default:
		return nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidFrame, err)
	}
	for _, field := range required {
		value, present := fields[field]
		if !present {
			return fmt.Errorf("%w: missing required control field %q", ErrInvalidFrame, field)
		}
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return fmt.Errorf("%w: required control field %q cannot be null", ErrInvalidFrame, field)
		}
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
