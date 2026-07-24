package liveprotocol

import (
	"encoding/json"
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

	config       PublisherConfig
	nextSeq      uint64
	pending      []Delivery
	pendingBytes int
	pendingSince time.Time
	replay       []replayEntry
	replayBytes  int
	settledTurns map[string]struct{}
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

	turnID, terminal := liveEventTurnFence(input.Event)
	if turnID != "" {
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
			return p.flushLocked()
		}
	}
	delivery, size, err := deliveryFromInput(input)
	if err != nil {
		return nil, err
	}
	if p.coalesceAppendText(delivery) {
		p.pendingBytes = estimateDeliveriesSize(p.pending)
		if p.pendingBytes < p.config.BatchTargetBytes && len(p.pending) < p.config.BatchDeliveries && !input.Immediate {
			return nil, nil
		}
		return p.flushLocked()
	}
	p.nextSeq++
	delivery.Seq = p.nextSeq
	if size > p.config.DeliveryMaxBytes {
		delivery = Delivery{
			Seq:  p.nextSeq,
			Kind: DeliveryKindDiscontinuity,
			Discontinuity: &Discontinuity{
				Reason:        "delivery_too_large",
				ReconcileKeys: reconcileKeysForEvent(input.Event),
			},
		}
		size = estimateDeliverySize(delivery)
	}
	if len(p.pending) == 0 {
		p.pendingSince = p.config.Now()
	}
	p.pending = append(p.pending, delivery)
	p.pendingBytes += size
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

func liveEventTurnFence(event *Event) (turnID string, terminal bool) {
	if event == nil {
		return "", false
	}
	switch event.EventType {
	case EventTypeMessageDelta:
		var data MessageDeltaData
		if json.Unmarshal(event.Data, &data) == nil {
			return strings.TrimSpace(data.TurnID), false
		}
	case EventTypeTurnUpdate:
		var data TurnUpdateData
		if json.Unmarshal(event.Data, &data) == nil {
			return strings.TrimSpace(data.Turn.TurnID), data.Turn.Phase == "settled"
		}
	case EventTypeInteractionUpdate:
		var data InteractionUpdateData
		if json.Unmarshal(event.Data, &data) == nil {
			return strings.TrimSpace(data.Interaction.TurnID), false
		}
	}
	return "", false
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
		delivery = Delivery{Kind: DeliveryKindDiscontinuity, Discontinuity: input.Discontinuity}
	case input.AttachmentChanged != nil:
		delivery = Delivery{Kind: DeliveryKindAttachmentChanged, AttachmentChanged: input.AttachmentChanged}
	case input.GoalChanged != nil:
		delivery = Delivery{Kind: DeliveryKindGoalChanged, GoalChanged: input.GoalChanged}
	case input.StreamReady != nil:
		delivery = Delivery{Kind: DeliveryKindStreamReady, StreamReady: input.StreamReady}
	case input.Rejected != nil:
		delivery = Delivery{Kind: DeliveryKindRejected, Rejected: input.Rejected}
	}
	return delivery, estimateDeliverySize(delivery), nil
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
		Deliveries:       append([]Delivery(nil), p.pending...),
	}
	raw, err := EncodeFrame(frame)
	if err != nil {
		return nil, err
	}
	if len(raw) > p.config.FrameMaxBytes {
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
	p.pruneReplayLocked()
	return []Frame{frame}, nil
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
	leftEvent, leftData, leftOK := messageAppendFromRaw(last.Event)
	rightEvent, rightData, rightOK := messageAppendFromRaw(next.Event)
	if !leftOK || !rightOK || leftEvent.WorkspaceID != rightEvent.WorkspaceID ||
		leftEvent.AgentSessionID != rightEvent.AgentSessionID ||
		leftData.MessageID != rightData.MessageID || leftData.TurnID != rightData.TurnID ||
		leftData.Role != rightData.Role || leftData.Kind != rightData.Kind {
		return false
	}
	leftData.Content.Text += rightData.Content.Text
	if rightData.OccurredAtUnixMS > leftData.OccurredAtUnixMS {
		leftData.OccurredAtUnixMS = rightData.OccurredAtUnixMS
	}
	merged, err := NewMessageDeltaEvent(leftData)
	if err != nil {
		return false
	}
	raw, err := MarshalEvent(merged)
	if err != nil || len(raw) > p.config.DeliveryMaxBytes {
		return false
	}
	last.Event = raw
	return true
}

func messageAppendFromRaw(raw []byte) (Event, MessageDeltaData, bool) {
	event, err := DecodeEvent(raw)
	if err != nil || event.EventType != EventTypeMessageDelta {
		return Event{}, MessageDeltaData{}, false
	}
	var data MessageDeltaData
	if err := json.Unmarshal(event.Data, &data); err != nil || data.Content == nil ||
		data.Content.Operation != "append_text" {
		return Event{}, MessageDeltaData{}, false
	}
	return event, data, true
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
	raw, err := encodeDelivery(deliveryWithSeq(delivery))
	if err == nil {
		return len(raw)
	}
	if delivery.Kind == DeliveryKindEvent {
		return len(delivery.Event) + 32
	}
	return 256
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
