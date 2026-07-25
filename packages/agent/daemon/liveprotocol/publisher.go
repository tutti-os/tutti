package liveprotocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

type replayEntry struct {
	delivery Delivery
	size     int
	at       time.Time
}

type Publisher struct {
	mu sync.Mutex

	config              PublisherConfig
	nextSeq             uint64
	pending             []Delivery
	pendingBytes        int
	pendingSince        time.Time
	pendingAppendInputs int
	replay              []replayEntry
	replayBytes         int
	settledTurns        map[string]struct{}
}

func NewPublisher(config PublisherConfig) (*Publisher, error) {
	applyPublisherDefaults(&config)
	if strings.TrimSpace(config.StreamID) == "" || strings.TrimSpace(config.BindingID) == "" || config.Epoch == 0 {
		return nil, fmt.Errorf("%w: publisher identity", ErrInvalidFrame)
	}
	return &Publisher{config: config, settledTurns: make(map[string]struct{})}, nil
}

// Publish appends one semantic delivery. Immediate controls and threshold
// crossings return encoded-ready frames; otherwise the caller schedules a
// Flush using NextFlushDelay.
func (p *Publisher) Publish(input PublishInput) ([]Frame, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	delivery, size, err := deliveryFromInput(input)
	if err != nil {
		return nil, err
	}
	turnID, terminal, rejectAfterTerminal := liveEventTurnFence(input.Event)
	if turnID != "" && rejectAfterTerminal {
		if _, settled := p.settledTurns[turnID]; settled {
			p.nextSeq++
			delivery := Delivery{
				Seq:  p.nextSeq,
				Kind: DeliveryKindDiscontinuity,
				Discontinuity: &Discontinuity{
					Reason:        "late_after_terminal",
					ReconcileKeys: reconcileKeysForEvent(input.Event),
				},
			}
			if len(p.pending) == 0 {
				p.pendingSince = p.config.Now()
			}
			p.pending = append(p.pending, delivery)
			p.pendingBytes += estimateDeliverySize(delivery)
			p.pendingAppendInputs = 0
			return p.flushLocked()
		}
	}
	if p.coalesceAppendText(delivery) {
		p.pendingAppendInputs++
		p.pendingBytes = estimateDeliveriesSize(p.pending)
		if p.pendingBytes < p.config.BatchTargetBytes &&
			p.pendingAppendInputs < p.config.BatchDeliveries &&
			!input.Immediate {
			return nil, nil
		}
		return p.flushLocked()
	}
	p.nextSeq++
	delivery.Seq = p.nextSeq
	if size > p.deliveryMaxBytes() {
		delivery = Delivery{
			Seq:  p.nextSeq,
			Kind: DeliveryKindDiscontinuity,
			Discontinuity: &Discontinuity{
				Reason:        "delivery_too_large",
				ReconcileKeys: reconcileKeysForEvent(input.Event),
			},
		}
		size, err = validatedDeliverySize(delivery)
		if err != nil {
			p.nextSeq--
			return nil, err
		}
	}
	if len(p.pending) == 0 {
		p.pendingSince = p.config.Now()
	}
	p.pending = append(p.pending, delivery)
	p.pendingBytes += size
	if isPureAppendTextDelivery(delivery) {
		p.pendingAppendInputs = 1
	} else {
		p.pendingAppendInputs = 0
	}
	immediate := input.Immediate || terminal || delivery.Kind != DeliveryKindEvent
	if !immediate && len(p.pending) < p.config.BatchDeliveries && p.pendingBytes < p.config.BatchTargetBytes {
		return nil, nil
	}
	frames, err := p.flushLocked()
	if err == nil && terminal && turnID != "" {
		p.settledTurns[turnID] = struct{}{}
	}
	return frames, err
}

func liveEventTurnFence(event *Event) (turnID string, terminal, rejectAfterTerminal bool) {
	if event == nil {
		return "", false, false
	}
	switch event.EventType {
	case EventTypeMessageDelta:
		var data MessageDeltaData
		if json.Unmarshal(event.Data, &data) == nil {
			return strings.TrimSpace(data.TurnID), false, true
		}
	case EventTypeTurnUpdate:
		var data TurnUpdateData
		if json.Unmarshal(event.Data, &data) == nil {
			terminal := data.Turn.Phase == "settled"
			return strings.TrimSpace(data.Turn.TurnID), terminal, !terminal
		}
	case EventTypeInteractionUpdate:
		var data InteractionUpdateData
		if json.Unmarshal(event.Data, &data) == nil {
			return strings.TrimSpace(data.Interaction.TurnID), false, false
		}
	}
	return "", false, false
}

func (p *Publisher) Flush() (*Frame, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	frames, err := p.flushLocked()
	if err != nil || len(frames) == 0 {
		return nil, err
	}
	if len(frames) != 1 {
		return nil, fmt.Errorf("%w: flush unexpectedly split into %d frames", ErrFrameTooLarge, len(frames))
	}
	return &frames[0], nil
}

func (p *Publisher) NextFlushDelay() time.Duration {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.pending) == 0 {
		return 0
	}
	remaining := p.config.BatchDelay - p.config.Now().Sub(p.pendingSince)
	if remaining < 0 {
		return 0
	}
	return remaining
}

func (p *Publisher) Resume(request ResumeRequest) ResumeResult {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pruneReplayLocked()
	result := ResumeResult{CurrentEpoch: p.config.Epoch}
	if request.Epoch != p.config.Epoch || request.AfterSeq > p.nextSeq {
		return result
	}
	if len(p.replay) == 0 {
		result.Hit = request.AfterSeq == p.nextSeq
		return result
	}
	oldest := p.replay[0].delivery.Seq
	if request.AfterSeq+1 < oldest {
		return result
	}
	result.Hit = true
	for _, entry := range p.replay {
		if entry.delivery.Seq > request.AfterSeq {
			result.Deliveries = append(result.Deliveries, cloneDelivery(entry.delivery))
		}
	}
	return result
}

func deliveryFromInput(input PublishInput) (Delivery, int, error) {
	count := boolCount(input.Event != nil) + boolCount(input.Discontinuity != nil) +
		boolCount(input.AttachmentChanged != nil) + boolCount(input.GoalChanged != nil) +
		boolCount(input.StreamReady != nil) + boolCount(input.Rejected != nil)
	if count != 1 {
		return Delivery{}, 0, ErrInvalidFrame
	}
	var delivery Delivery
	switch {
	case input.Event != nil:
		raw, err := MarshalEvent(*input.Event)
		if err != nil {
			return Delivery{}, 0, err
		}
		delivery = Delivery{Kind: DeliveryKindEvent, Event: raw}
	case input.Discontinuity != nil:
		delivery = cloneDelivery(Delivery{Kind: DeliveryKindDiscontinuity, Discontinuity: input.Discontinuity})
	case input.AttachmentChanged != nil:
		delivery = cloneDelivery(Delivery{Kind: DeliveryKindAttachmentChanged, AttachmentChanged: input.AttachmentChanged})
	case input.GoalChanged != nil:
		delivery = cloneDelivery(Delivery{Kind: DeliveryKindGoalChanged, GoalChanged: input.GoalChanged})
	case input.StreamReady != nil:
		delivery = cloneDelivery(Delivery{Kind: DeliveryKindStreamReady, StreamReady: input.StreamReady})
	case input.Rejected != nil:
		delivery = cloneDelivery(Delivery{Kind: DeliveryKindRejected, Rejected: input.Rejected})
	}
	size, err := validatedDeliverySize(deliveryWithSeq(delivery))
	if err != nil {
		return Delivery{}, 0, err
	}
	return delivery, size, nil
}

func (p *Publisher) flushLocked() ([]Frame, error) {
	if len(p.pending) == 0 {
		return nil, nil
	}
	frame := Frame{
		ProtocolRevision: ProtocolRevision,
		StreamID:         p.config.StreamID,
		BindingID:        p.config.BindingID,
		Epoch:            p.config.Epoch,
		Deliveries:       cloneDeliveries(p.pending),
	}
	raw, err := EncodeFrame(frame)
	if err != nil {
		p.rollbackPendingLocked()
		return nil, err
	}
	if len(raw) > p.config.FrameMaxBytes {
		p.rollbackPendingLocked()
		return nil, ErrFrameTooLarge
	}
	now := p.config.Now()
	for _, delivery := range p.pending {
		cloned := cloneDelivery(delivery)
		size := estimateDeliverySize(cloned)
		p.replay = append(p.replay, replayEntry{delivery: cloned, size: size, at: now})
		p.replayBytes += size
	}
	p.pending = nil
	p.pendingBytes = 0
	p.pendingSince = time.Time{}
	p.pendingAppendInputs = 0
	p.pruneReplayLocked()
	return []Frame{frame}, nil
}

func (p *Publisher) rollbackPendingLocked() {
	if len(p.pending) == 0 {
		return
	}
	p.nextSeq = p.pending[0].Seq - 1
	clear(p.pending)
	p.pending = nil
	p.pendingBytes = 0
	p.pendingSince = time.Time{}
	p.pendingAppendInputs = 0
}

func (p *Publisher) pruneReplayLocked() {
	cutoff := p.config.Now().Add(-p.config.ReplayTTL)
	remove := 0
	for remove < len(p.replay) &&
		(p.replay[remove].at.Before(cutoff) || p.replayBytes > p.config.ReplayMaxBytes) {
		p.replayBytes -= p.replay[remove].size
		remove++
	}
	if remove > 0 {
		copy(p.replay, p.replay[remove:])
		clear(p.replay[len(p.replay)-remove:])
		p.replay = p.replay[:len(p.replay)-remove]
	}
}

func (p *Publisher) coalesceAppendText(next Delivery) bool {
	if next.Kind != DeliveryKindEvent || len(p.pending) == 0 {
		return false
	}
	last := &p.pending[len(p.pending)-1]
	if last.Kind != DeliveryKindEvent {
		return false
	}
	leftEvent, leftData, leftKind, leftOK := messageAppendFromRawWithKind(last.Event)
	rightEvent, rightData, rightKind, rightOK := messageAppendFromRawWithKind(next.Event)
	if !leftOK || !rightOK || leftKind != rightKind ||
		!isPureAppendTextDelta(leftData, leftKind) || !isPureAppendTextDelta(rightData, rightKind) ||
		leftEvent.WorkspaceID != rightEvent.WorkspaceID ||
		leftEvent.AgentSessionID != rightEvent.AgentSessionID ||
		leftData.MessageID != rightData.MessageID || leftData.TurnID != rightData.TurnID ||
		leftData.Role != rightData.Role || leftData.Kind != rightData.Kind {
		return false
	}
	switch leftKind {
	case messageAppendContent:
		leftData.Content.Text += rightData.Content.Text
	case messageAppendToolOutput:
		if leftData.ToolOutput.OffsetBytes == nil || rightData.ToolOutput.OffsetBytes == nil ||
			*rightData.ToolOutput.OffsetBytes != *leftData.ToolOutput.OffsetBytes+int64(len(leftData.ToolOutput.Text)) {
			return false
		}
		leftData.ToolOutput.Text += rightData.ToolOutput.Text
	default:
		return false
	}
	if rightData.OccurredAtUnixMS > leftData.OccurredAtUnixMS {
		leftData.OccurredAtUnixMS = rightData.OccurredAtUnixMS
	}
	merged, err := NewMessageDeltaEvent(leftData)
	if err != nil {
		return false
	}
	raw, err := MarshalEvent(merged)
	if err != nil {
		return false
	}
	size, err := validatedDeliverySize(Delivery{Seq: last.Seq, Kind: DeliveryKindEvent, Event: raw})
	if err != nil || size > p.deliveryMaxBytes() {
		return false
	}
	last.Event = raw
	return true
}

func isPureAppendTextDelivery(delivery Delivery) bool {
	if delivery.Kind != DeliveryKindEvent {
		return false
	}
	_, data, kind, ok := messageAppendFromRawWithKind(delivery.Event)
	return ok && isPureAppendTextDelta(data, kind)
}

type messageAppendKind uint8

const (
	messageAppendContent messageAppendKind = iota + 1
	messageAppendToolOutput
)

func isPureAppendTextDelta(data MessageDeltaData, kind messageAppendKind) bool {
	pureMutation := len(data.PayloadSet) == 0 &&
		len(data.PayloadUnset) == 0 &&
		data.Status == nil &&
		len(data.Semantics) == 0 &&
		data.StartedAtUnixMS == nil &&
		data.CompletedAtUnixMS == nil
	if !pureMutation {
		return false
	}
	switch kind {
	case messageAppendContent:
		return data.Content != nil &&
			data.Content.Operation == "append_text" &&
			len(data.Content.Value) == 0 &&
			data.ToolOutput == nil
	case messageAppendToolOutput:
		return data.ToolOutput != nil &&
			data.ToolOutput.Operation == "append_text" &&
			data.ToolOutput.OffsetBytes != nil &&
			data.Content == nil
	default:
		return false
	}
}

func messageAppendFromRaw(raw []byte) (Event, MessageDeltaData, bool) {
	event, data, _, ok := messageAppendFromRawWithKind(raw)
	return event, data, ok
}

func messageAppendFromRawWithKind(raw []byte) (Event, MessageDeltaData, messageAppendKind, bool) {
	event, err := DecodeEvent(raw)
	if err != nil || event.EventType != EventTypeMessageDelta {
		return Event{}, MessageDeltaData{}, 0, false
	}
	var data MessageDeltaData
	if err := json.Unmarshal(event.Data, &data); err != nil {
		return Event{}, MessageDeltaData{}, 0, false
	}
	switch {
	case data.Content != nil && data.Content.Operation == "append_text":
		return event, data, messageAppendContent, true
	case data.ToolOutput != nil && data.ToolOutput.Operation == "append_text":
		return event, data, messageAppendToolOutput, true
	default:
		return Event{}, MessageDeltaData{}, 0, false
	}
}

func reconcileKeysForEvent(event *Event) []ReconcileKey {
	if event == nil {
		return nil
	}
	key := ReconcileKey{WorkspaceID: event.WorkspaceID, AgentSessionID: event.AgentSessionID}
	switch event.EventType {
	case EventTypeMessageDelta:
		key.Kind = "message"
		var data MessageDeltaData
		if json.Unmarshal(event.Data, &data) == nil {
			key.MessageID, key.TurnID = data.MessageID, data.TurnID
		}
	case EventTypeTurnUpdate:
		key.Kind = "turn"
	case EventTypeInteractionUpdate:
		key.Kind = "interaction"
	default:
		key.Kind = "audit"
	}
	return []ReconcileKey{key}
}

func applyPublisherDefaults(config *PublisherConfig) {
	if config.BatchDelay <= 0 {
		config.BatchDelay = DefaultBatchDelay
	}
	if config.BatchDeliveries <= 0 {
		config.BatchDeliveries = DefaultBatchDeliveries
	}
	if config.BatchTargetBytes <= 0 {
		config.BatchTargetBytes = DefaultBatchTargetBytes
	}
	if config.DeliveryMaxBytes <= 0 {
		config.DeliveryMaxBytes = DefaultDeliveryMaxBytes
	}
	if config.FrameMaxBytes <= 0 {
		config.FrameMaxBytes = DefaultFrameMaxBytes
	}
	if config.ReplayTTL <= 0 {
		config.ReplayTTL = DefaultReplayTTL
	}
	if config.ReplayMaxBytes <= 0 {
		config.ReplayMaxBytes = DefaultReplayMaxBytes
	}
	if config.Now == nil {
		config.Now = time.Now
	}
}

func estimateDeliverySize(delivery Delivery) int {
	size, err := validatedDeliverySize(deliveryWithSeq(delivery))
	if err == nil {
		return size
	}
	if delivery.Kind == DeliveryKindEvent {
		return len(delivery.Event) + 32
	}
	return 256
}

func validatedDeliverySize(delivery Delivery) (int, error) {
	raw, err := encodeDelivery(deliveryWithSeq(delivery))
	if err == nil {
		return len(raw), nil
	}
	if errors.Is(err, ErrDeliveryTooLarge) {
		return DefaultDeliveryMaxBytes + 1, nil
	}
	return 0, err
}

func (p *Publisher) deliveryMaxBytes() int {
	if p.config.DeliveryMaxBytes < DefaultDeliveryMaxBytes {
		return p.config.DeliveryMaxBytes
	}
	return DefaultDeliveryMaxBytes
}

func estimateDeliveriesSize(deliveries []Delivery) int {
	total := 0
	for _, delivery := range deliveries {
		total += estimateDeliverySize(delivery)
	}
	return total
}

func deliveryWithSeq(delivery Delivery) Delivery {
	if delivery.Seq == 0 {
		delivery.Seq = 1
	}
	return delivery
}

func cloneDelivery(delivery Delivery) Delivery {
	cloned := delivery
	cloned.Event = append([]byte(nil), delivery.Event...)
	if delivery.Discontinuity != nil {
		value := *delivery.Discontinuity
		value.ReconcileKeys = append([]ReconcileKey(nil), delivery.Discontinuity.ReconcileKeys...)
		cloned.Discontinuity = &value
	}
	if delivery.AttachmentChanged != nil {
		value := *delivery.AttachmentChanged
		cloned.AttachmentChanged = &value
	}
	if delivery.GoalChanged != nil {
		value := *delivery.GoalChanged
		cloned.GoalChanged = &value
	}
	if delivery.StreamReady != nil {
		value := *delivery.StreamReady
		cloned.StreamReady = &value
	}
	if delivery.Rejected != nil {
		value := *delivery.Rejected
		cloned.Rejected = &value
	}
	return cloned
}

func cloneDeliveries(deliveries []Delivery) []Delivery {
	cloned := make([]Delivery, len(deliveries))
	for index, delivery := range deliveries {
		cloned[index] = cloneDelivery(delivery)
	}
	return cloned
}
