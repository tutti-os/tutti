package agentruntime

import (
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type agentSubmitRuntimeEventSummary struct {
	batchCount         int
	activityEventCount int
	eventTypeCounts    map[string]int
	lastSessionStatus  string
	lastTurnPhase      string
}

func (s *agentSubmitRuntimeEventSummary) observe(events []activityshared.Event, session Session) {
	if len(events) == 0 {
		return
	}
	s.batchCount++
	s.activityEventCount += len(events)
	if s.eventTypeCounts == nil {
		s.eventTypeCounts = make(map[string]int)
	}
	for _, event := range events {
		eventType := strings.TrimSpace(string(event.Type))
		if eventType == "" {
			eventType = "unknown"
		}
		s.eventTypeCounts[eventType]++
	}
	s.lastSessionStatus = strings.TrimSpace(string(session.Status))
	s.lastTurnPhase = strings.TrimSpace(turnLifecyclePhaseFromEvents(events))
}

func (s agentSubmitRuntimeEventSummary) log(event string, session Session, turnID string, metadata map[string]any) {
	if s.batchCount == 0 {
		return
	}
	logAgentSubmitTrace(event, session, turnID, metadata, map[string]any{
		"activity_event_count": s.activityEventCount,
		"emit_batch_count":     s.batchCount,
		"event_type_counts":    s.eventTypeCounts,
		"session_status":       s.lastSessionStatus,
		"turn_phase":           s.lastTurnPhase,
	})
}
