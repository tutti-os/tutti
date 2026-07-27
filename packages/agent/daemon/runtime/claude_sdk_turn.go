package agentruntime

import (
	"sort"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// ensureClaudeSDKTurnNormalizerLocked returns the turn lifecycle owner for
// turnID, creating it on first use. Caller must hold the adapter mutex.
func (s *claudeSDKAdapterSession) ensureClaudeSDKTurnNormalizerLocked(turnID string) *acpTurnNormalizer {
	turnID = strings.TrimSpace(turnID)
	if s == nil || turnID == "" {
		return nil
	}
	if s.turnNormalizers == nil {
		s.turnNormalizers = make(map[string]*acpTurnNormalizer)
	}
	if normalizer := s.turnNormalizers[turnID]; normalizer != nil {
		return normalizer
	}
	normalizer := newACPTurnNormalizer()
	s.turnNormalizers[turnID] = normalizer
	return normalizer
}

// projectClaudeSDKTurnCallEvents gives Claude the same turn-owned call merge,
// file-change accumulation, and dangling-call settlement path as ACP/Codex.
// A completed call is merged with its started snapshot before canonical
// fileChanges are derived, so input-only Write/Edit details are not lost.
func (a *ClaudeCodeSDKAdapter) projectClaudeSDKTurnCallEvents(
	adapterSession *claudeSDKAdapterSession,
	events []activityshared.Event,
) []activityshared.Event {
	if a == nil || adapterSession == nil || len(events) == 0 {
		return events
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	projected := make([]activityshared.Event, 0, len(events)*2)
	for index := range events {
		event := events[index]
		switch event.Type {
		case activityshared.EventCallStarted,
			activityshared.EventCallCompleted,
			activityshared.EventCallFailed:
			turnID := strings.TrimSpace(event.Payload.TurnID)
			if turnID == "" {
				continue
			}
			normalizer := adapterSession.ensureClaudeSDKTurnNormalizerLocked(turnID)
			if normalizer == nil {
				continue
			}
			if event.Type == activityshared.EventCallCompleted {
				normalizer.mergePendingToolCallSnapshot(&event)
			}
			normalizer.trackToolCallEvent(event)
			projected = append(projected, event)
			projected = appendTurnFileChangesEvent(normalizer, projected, event)
			continue
		}
		projected = append(projected, event)
	}
	return projected
}

// claudeSDKThinkingEvents routes Claude thinking snapshots through the shared
// turn normalizer so cancel/fail/complete can settle an in-flight "thinking"
// row the same way Codex/ACP do.
func (a *ClaudeCodeSDKAdapter) claudeSDKThinkingEvents(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	turnID string,
	messageID string,
	content string,
	completed bool,
) []activityshared.Event {
	if a == nil || adapterSession == nil {
		return nil
	}
	turnID = strings.TrimSpace(turnID)
	if turnID == "" {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	normalizer := adapterSession.ensureClaudeSDKTurnNormalizerLocked(turnID)
	if normalizer == nil {
		return nil
	}
	var events []activityshared.Event
	if completed {
		events = normalizer.CompleteThinkingSnapshot(session, turnID, content, messageID)
	} else {
		events = normalizer.ApplyStreamingThinkingSnapshot(session, turnID, content, messageID)
	}
	return stampClaudeSDKAdapterMetadata(events)
}

// claudeSDKAssistantEvents routes Claude assistant snapshots through the shared
// turn normalizer so interrupt can close a half-streamed assistant bubble.
func (a *ClaudeCodeSDKAdapter) claudeSDKAssistantEvents(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	turnID string,
	messageID string,
	content string,
	completed bool,
) []activityshared.Event {
	if a == nil || adapterSession == nil {
		return nil
	}
	turnID = strings.TrimSpace(turnID)
	if turnID == "" {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	normalizer := adapterSession.ensureClaudeSDKTurnNormalizerLocked(turnID)
	if normalizer == nil {
		return nil
	}
	var events []activityshared.Event
	if completed {
		events = normalizer.CompleteAssistantSnapshot(session, turnID, content, messageID)
	} else {
		events = normalizer.ApplyStreamingAssistantSnapshot(session, turnID, content, messageID)
	}
	return stampClaudeSDKAdapterMetadata(events)
}

func (a *ClaudeCodeSDKAdapter) claudeSDKAssistantFailedEvents(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	turnID string,
	messageID string,
	content string,
) []activityshared.Event {
	if a == nil || adapterSession == nil {
		return nil
	}
	turnID = strings.TrimSpace(turnID)
	if turnID == "" {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	normalizer := adapterSession.ensureClaudeSDKTurnNormalizerLocked(turnID)
	if normalizer == nil {
		return nil
	}
	return stampClaudeSDKAdapterMetadata(
		normalizer.FailAssistantSnapshot(session, turnID, content, messageID),
	)
}

func stampClaudeSDKAdapterMetadata(events []activityshared.Event) []activityshared.Event {
	if len(events) == 0 {
		return events
	}
	for index := range events {
		if events[index].Payload.Metadata == nil {
			events[index].Payload.Metadata = map[string]any{}
		}
		events[index].Payload.Metadata["adapter"] = claudeSDKSidecarAdapterName
	}
	return events
}

// takeClaudeSDKTurnNormalizerLocked removes and returns the turn lifecycle
// owner for turnID. Caller must hold the adapter mutex.
func (s *claudeSDKAdapterSession) takeClaudeSDKTurnNormalizerLocked(turnID string) *acpTurnNormalizer {
	turnID = strings.TrimSpace(turnID)
	if s == nil || turnID == "" || len(s.turnNormalizers) == 0 {
		return nil
	}
	normalizer := s.turnNormalizers[turnID]
	delete(s.turnNormalizers, turnID)
	return normalizer
}

type claudeSDKTurnFinishKind string

const (
	claudeSDKTurnFinishCompleted   claudeSDKTurnFinishKind = "completed"
	claudeSDKTurnFinishFailed      claudeSDKTurnFinishKind = "failed"
	claudeSDKTurnFinishInterrupted claudeSDKTurnFinishKind = "interrupted"
)

// finishClaudeSDKTurnLifecycle closes the Claude turn's event lifecycle:
// dangling tool calls plus any normalizer-owned thinking/assistant streams are
// settled before the caller emits the turn terminal event. Idempotent once the
// normalizer is taken.
func (a *ClaudeCodeSDKAdapter) finishClaudeSDKTurnLifecycle(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	turnID string,
	kind claudeSDKTurnFinishKind,
	reason string,
) []activityshared.Event {
	if a == nil || adapterSession == nil {
		return nil
	}
	turnID = strings.TrimSpace(turnID)
	if turnID == "" {
		return nil
	}
	streamState := messageStreamStateFailed
	noticeStatus := "failed"
	switch kind {
	case claudeSDKTurnFinishCompleted:
		streamState = messageStreamStateCompleted
		noticeStatus = "completed"
	case claudeSDKTurnFinishInterrupted:
		noticeStatus = "canceled"
	}
	a.mu.Lock()
	normalizer := adapterSession.takeClaudeSDKTurnNormalizerLocked(turnID)
	compact, hasActiveCompact := adapterSession.compactMessages[turnID]
	if hasActiveCompact && compact.active && compact.terminalStatus == "" {
		compact.active = false
		compact.terminalStatus = noticeStatus
		adapterSession.compactMessages[turnID] = compact
	} else {
		hasActiveCompact = false
	}
	a.mu.Unlock()
	events := make([]activityshared.Event, 0, 2)
	if hasActiveCompact {
		events = append(events, claudeSDKCompactMessageEvent(
			session,
			turnID,
			compact.messageID,
			streamState,
			noticeStatus,
			"",
		))
	}
	if normalizer == nil {
		return events
	}
	switch kind {
	case claudeSDKTurnFinishCompleted:
		return append(events, normalizer.FinishCompleted(session, turnID)...)
	case claudeSDKTurnFinishFailed:
		return append(events, normalizer.FinishFailed(session, turnID)...)
	default:
		return append(events, normalizer.FinishInterrupted(session, turnID, firstNonEmpty(strings.TrimSpace(reason), "interrupted"))...)
	}
}

// finishAllClaudeSDKTurnLifecycles settles every still-open Claude turn
// lifecycle (for example when the sidecar reader dies).
func (a *ClaudeCodeSDKAdapter) finishAllClaudeSDKTurnLifecycles(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	kind claudeSDKTurnFinishKind,
	reason string,
) []activityshared.Event {
	if a == nil || adapterSession == nil {
		return nil
	}
	a.mu.Lock()
	turnIDSet := make(map[string]struct{}, len(adapterSession.turnNormalizers)+len(adapterSession.compactMessages))
	for turnID := range adapterSession.turnNormalizers {
		turnIDSet[turnID] = struct{}{}
	}
	for turnID, compact := range adapterSession.compactMessages {
		if compact.active && compact.terminalStatus == "" {
			turnIDSet[turnID] = struct{}{}
		}
	}
	a.mu.Unlock()
	turnIDs := make([]string, 0, len(turnIDSet))
	for turnID := range turnIDSet {
		turnIDs = append(turnIDs, turnID)
	}
	if len(turnIDs) == 0 {
		return nil
	}
	sort.Strings(turnIDs)
	events := make([]activityshared.Event, 0, len(turnIDs))
	for _, turnID := range turnIDs {
		events = append(events, a.finishClaudeSDKTurnLifecycle(adapterSession, session, turnID, kind, reason)...)
	}
	return events
}
