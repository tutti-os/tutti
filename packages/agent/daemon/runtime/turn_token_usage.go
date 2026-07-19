package agentruntime

import (
	"strings"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// tokenUsageFlushInterval bounds mid-turn tokenUsage turn.updated emissions to
// about 1 Hz per turn. The final flush when the turn ends is unconditional.
const tokenUsageFlushInterval = time.Second

// turnTokenUsageEvent mirrors appendTurnFileChangesEvent for per-turn token
// counters: a mid-turn turn.updated whose metadata carries the cumulative
// input/output split. It rides the same reporter -> state patch ->
// TurnTransition -> token_usage_json path as metadata.fileChanges.
func turnTokenUsageEvent(session Session, turnID string, inputTokens int64, outputTokens int64) (activityshared.Event, bool) {
	turnID = strings.TrimSpace(turnID)
	if turnID == "" {
		return activityshared.Event{}, false
	}
	ctx, ok := activityEventContext(session, newID(), turnID)
	if !ok {
		return activityshared.Event{}, false
	}
	event := activityshared.NewTurnUpdated(ctx, turnID, activityshared.TurnPhaseWorking)
	event.Payload.Metadata = map[string]any{
		"tokenUsage": map[string]any{
			"inputTokens":  inputTokens,
			"outputTokens": outputTokens,
		},
	}
	return event, true
}

// claudeSDKTurnTokenUsage accumulates one canonical turn's cumulative token
// counters across the turn's multiple Anthropic API calls. The sidecar
// reports input tokens once per API call (message_start) and the running
// output total of the current call (message_delta), so each completed call's
// output is folded into outputTotal when the next call starts.
type claudeSDKTurnTokenUsage struct {
	inputTotal        int64
	currentCallOutput int64
	outputTotal       int64
	lastFlushAt       time.Time
}

func (c *claudeSDKTurnTokenUsage) applyMessageStart(inputTokens int64) {
	if c == nil {
		return
	}
	if c.currentCallOutput > 0 {
		c.outputTotal += c.currentCallOutput
		c.currentCallOutput = 0
	}
	if inputTokens > 0 {
		c.inputTotal += inputTokens
	}
}

func (c *claudeSDKTurnTokenUsage) applyMessageDelta(outputTokens int64) {
	if c == nil {
		return
	}
	if outputTokens > c.currentCallOutput {
		c.currentCallOutput = outputTokens
	}
}

func (c *claudeSDKTurnTokenUsage) exposed() (int64, int64) {
	if c == nil {
		return 0, 0
	}
	return c.inputTotal, c.outputTotal + c.currentCallOutput
}

// ensureClaudeSDKTurnTokenUsageLocked returns the turn's token counter,
// creating it on first use. Caller must hold the adapter mutex.
func (s *claudeSDKAdapterSession) ensureClaudeSDKTurnTokenUsageLocked(turnID string) *claudeSDKTurnTokenUsage {
	turnID = strings.TrimSpace(turnID)
	if s == nil || turnID == "" {
		return nil
	}
	if s.turnTokenUsage == nil {
		s.turnTokenUsage = make(map[string]*claudeSDKTurnTokenUsage)
	}
	if counter := s.turnTokenUsage[turnID]; counter != nil {
		return counter
	}
	counter := &claudeSDKTurnTokenUsage{}
	s.turnTokenUsage[turnID] = counter
	return counter
}

// applyClaudeSDKTurnTokenUsage folds one usage_updated payload into the turn's
// cumulative counters and reports the exposed values when the throttle window
// elapsed. Only message_start payloads create a counter: the turn-end result
// usage arrives after the final flush and must not resurrect a settled turn's
// counter, and context-window snapshots carry no input/output split at all.
func (a *ClaudeCodeSDKAdapter) applyClaudeSDKTurnTokenUsage(
	adapterSession *claudeSDKAdapterSession,
	rootTurnID string,
	payload map[string]any,
) (int64, int64, bool) {
	if a == nil || adapterSession == nil {
		return 0, 0, false
	}
	rootTurnID = strings.TrimSpace(rootTurnID)
	usage := payloadMap(payload, "usage")
	if rootTurnID == "" || len(usage) == 0 {
		return 0, 0, false
	}
	messageStart := payloadBoolValue(payload, "messageStart")
	if !messageStart {
		// Result/context-window payloads also carry a usage-shaped body; only
		// stream deltas (no extra keys) feed the per-turn counters.
		if len(payloadMap(payload, "modelUsage")) > 0 || payload["totalCostUsd"] != nil || len(payloadMap(payload, "contextWindow")) > 0 {
			return 0, 0, false
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, settled := adapterSession.settledTurns[rootTurnID]; settled {
		return 0, 0, false
	}
	if messageStart {
		inputTokens, _ := firstInt64Value(usage, "input_tokens", "inputTokens")
		counter := adapterSession.ensureClaudeSDKTurnTokenUsageLocked(rootTurnID)
		if counter == nil {
			return 0, 0, false
		}
		counter.applyMessageStart(inputTokens)
		return claudeSDKTurnTokenUsageFlush(counter, time.Now())
	}
	counter := adapterSession.turnTokenUsage[rootTurnID]
	if counter == nil {
		return 0, 0, false
	}
	outputTokens, _ := firstInt64Value(usage, "output_tokens", "outputTokens")
	counter.applyMessageDelta(outputTokens)
	return claudeSDKTurnTokenUsageFlush(counter, time.Now())
}

func claudeSDKTurnTokenUsageFlush(counter *claudeSDKTurnTokenUsage, now time.Time) (int64, int64, bool) {
	if counter == nil || now.Sub(counter.lastFlushAt) < tokenUsageFlushInterval {
		return 0, 0, false
	}
	counter.lastFlushAt = now
	inputTokens, outputTokens := counter.exposed()
	return inputTokens, outputTokens, true
}

// takeClaudeSDKTurnTokenUsageFinal removes the turn's counter and reports its
// final cumulative values. A settled turn rejects later transitions, so the
// caller must emit this flush before the turn's completing events.
func (a *ClaudeCodeSDKAdapter) takeClaudeSDKTurnTokenUsageFinal(adapterSession *claudeSDKAdapterSession, rootTurnID string) (int64, int64, bool) {
	if a == nil || adapterSession == nil {
		return 0, 0, false
	}
	rootTurnID = strings.TrimSpace(rootTurnID)
	a.mu.Lock()
	defer a.mu.Unlock()
	counter := adapterSession.turnTokenUsage[rootTurnID]
	if counter == nil {
		return 0, 0, false
	}
	delete(adapterSession.turnTokenUsage, rootTurnID)
	inputTokens, outputTokens := counter.exposed()
	return inputTokens, outputTokens, true
}
