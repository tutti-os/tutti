package agent

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentturnanalyticsbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentturnanalytics"
	agentturnterminal "github.com/tutti-os/tutti/services/tuttid/service/reporter/events/agent/turn_terminal"
)

const (
	terminalAnalyticsPollInterval = time.Second
	terminalAnalyticsLease        = 30 * time.Second
	terminalAnalyticsDrainLimit   = 128
	terminalAnalyticsStoreTimeout = 5 * time.Second
)

type turnTerminalAnalyticsStore interface {
	PutAgentTurnTerminalAnalytics(context.Context, agentturnanalyticsbiz.Settlement, int64) (bool, error)
	ClaimAgentTurnTerminalAnalytics(context.Context, string, int64, int64) (agentturnanalyticsbiz.Delivery, bool, error)
	CompleteAgentTurnTerminalAnalytics(context.Context, string, string, string, string, int64) (bool, error)
	IgnoreAgentTurnTerminalAnalytics(context.Context, string, string, string, string, string, int64) (bool, error)
	RequeueAgentTurnTerminalAnalytics(context.Context, int64) (int64, error)
}

func (p *ActivityProjection) reportRootTurnTerminalEvent(ctx context.Context, settled agenthost.RootTurnSettled) {
	if p == nil || settled.IsChildSession {
		return
	}
	turn := settled.Turn
	if turn.Backfilled || strings.TrimSpace(turn.Origin) != agentactivitybiz.TurnOriginUserPrompt {
		return
	}
	if store, ok := p.repo.(turnTerminalAnalyticsStore); ok {
		persistCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), terminalAnalyticsStoreTimeout)
		_, err := store.PutAgentTurnTerminalAnalytics(persistCtx, terminalAnalyticsSettlement(settled), time.Now().UnixMilli())
		cancel()
		if err != nil {
			// Canonical production writes already inserted this marker through the
			// transaction participant. This post-commit put supports adapter tests
			// and old callers and is never the durability boundary.
			slog.WarnContext(ctx, "agent turn terminal analytics wake failed",
				"event", "agent.turn_terminal_analytics.marker_unavailable",
				"agent_session_id", strings.TrimSpace(settled.AgentSessionID),
				"turn_id", strings.TrimSpace(turn.TurnID),
				"error", err,
			)
			return
		}
		p.wakeTurnTerminalAnalytics()
		p.drainTurnTerminalAnalytics(ctx, store)
		return
	}
	p.reportRootTurnTerminalEventDirect(ctx, settled)
}

func terminalAnalyticsSettlement(settled agenthost.RootTurnSettled) agentturnanalyticsbiz.Settlement {
	turn := settled.Turn
	return agentturnanalyticsbiz.Settlement{
		WorkspaceID:       strings.TrimSpace(settled.WorkspaceID),
		AgentSessionID:    strings.TrimSpace(settled.AgentSessionID),
		TurnID:            strings.TrimSpace(turn.TurnID),
		EventID:           agentturnanalyticsbiz.StableEventID(settled.WorkspaceID, settled.AgentSessionID, turn.TurnID),
		Provider:          strings.TrimSpace(settled.Provider),
		Origin:            strings.TrimSpace(turn.Origin),
		Outcome:           strings.TrimSpace(turn.Outcome),
		ErrorCode:         strings.TrimSpace(turn.ErrorCode),
		StartupReconciled: settled.StartupReconciled,
		StartedAtUnixMS:   turn.StartedAtUnixMS,
		SettledAtUnixMS:   turn.SettledAtUnixMS,
	}
}

func (p *ActivityProjection) reportRootTurnTerminalEventDirect(ctx context.Context, settled agenthost.RootTurnSettled) {
	if p.analyticsReporter == nil {
		return
	}
	reader, ok := p.repo.(agentactivitybiz.TurnSubmissionReader)
	if !ok {
		logSkippedTurnTerminalEvent(ctx, settled, "submission_reader_unavailable")
		return
	}
	submission, found, err := reader.GetTurnSubmission(ctx, settled.WorkspaceID, settled.AgentSessionID, settled.Turn.TurnID)
	if err != nil {
		logSkippedTurnTerminalEvent(ctx, settled, "submission_read_failed")
		return
	}
	if !found {
		logSkippedTurnTerminalEvent(ctx, settled, "submission_missing")
		return
	}
	tracked, reason := p.trackTurnTerminalAnalytics(ctx, agentturnanalyticsbiz.Delivery{
		Settlement:     terminalAnalyticsSettlement(settled),
		ClientSubmitID: submission.ClientSubmitID,
		MetadataJSON:   submission.MetadataJSON,
	})
	if !tracked {
		logSkippedTurnTerminalEvent(ctx, settled, reason)
	}
}

// RunTurnTerminalAnalytics drains the durable ledger on startup, wake hints,
// and a bounded polling interval. Startup requeues abandoned leases because
// tuttid has a single process owner for this database.
func (p *ActivityProjection) RunTurnTerminalAnalytics(ctx context.Context) {
	if p == nil {
		return
	}
	store, ok := p.repo.(turnTerminalAnalyticsStore)
	if !ok {
		return
	}
	now := time.Now().UnixMilli()
	// Requeue shares the drain critical section. Otherwise startup can reset a
	// lease held by a synchronous observer drain whose Track call is in flight,
	// making the same local owner deliver the event twice.
	p.terminalAnalyticsDrainMu.Lock()
	if _, err := store.RequeueAgentTurnTerminalAnalytics(ctx, now); err != nil && ctx.Err() == nil {
		slog.WarnContext(ctx, "agent turn terminal analytics lease recovery failed",
			"event", "agent.turn_terminal_analytics.lease_recovery_failed", "error", err)
	}
	p.terminalAnalyticsDrainMu.Unlock()
	p.drainTurnTerminalAnalytics(ctx, store)

	ticker := time.NewTicker(terminalAnalyticsPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-p.terminalAnalyticsWake:
			p.drainTurnTerminalAnalytics(ctx, store)
		case <-ticker.C:
			p.drainTurnTerminalAnalytics(ctx, store)
		}
	}
}

func (p *ActivityProjection) wakeTurnTerminalAnalytics() {
	if p == nil || p.terminalAnalyticsWake == nil {
		return
	}
	select {
	case p.terminalAnalyticsWake <- struct{}{}:
	default:
	}
}

func (p *ActivityProjection) drainTurnTerminalAnalytics(ctx context.Context, store turnTerminalAnalyticsStore) {
	if p == nil || p.analyticsReporter == nil || store == nil {
		return
	}
	// Observer wakeups and the periodic worker may race. Serializing drains
	// prevents one owner from reclaiming an expired lease while an earlier
	// Track call is still in flight and then completing the newer claim.
	p.terminalAnalyticsDrainMu.Lock()
	defer p.terminalAnalyticsDrainMu.Unlock()
	for index := 0; index < terminalAnalyticsDrainLimit && ctx.Err() == nil; index++ {
		now := time.Now().UnixMilli()
		delivery, found, err := store.ClaimAgentTurnTerminalAnalytics(
			ctx, p.terminalAnalyticsOwner, now, now+terminalAnalyticsLease.Milliseconds(),
		)
		if err != nil {
			if ctx.Err() == nil {
				slog.WarnContext(ctx, "agent turn terminal analytics claim failed",
					"event", "agent.turn_terminal_analytics.claim_failed", "error", err)
			}
			return
		}
		if !found {
			return
		}
		tracked, reason := p.trackTurnTerminalAnalytics(ctx, delivery)
		finishNow := time.Now().UnixMilli()
		var finished bool
		if !tracked {
			finished, err = store.IgnoreAgentTurnTerminalAnalytics(
				ctx, delivery.WorkspaceID, delivery.AgentSessionID, delivery.TurnID,
				p.terminalAnalyticsOwner, reason, finishNow,
			)
		} else {
			finished, err = store.CompleteAgentTurnTerminalAnalytics(
				ctx, delivery.WorkspaceID, delivery.AgentSessionID, delivery.TurnID,
				p.terminalAnalyticsOwner, finishNow,
			)
		}
		if err != nil {
			if ctx.Err() == nil {
				slog.WarnContext(ctx, "agent turn terminal analytics completion failed",
					"event", "agent.turn_terminal_analytics.completion_failed",
					"agent_session_id", delivery.AgentSessionID,
					"turn_id", delivery.TurnID,
					"error", err,
				)
			}
			return
		}
		if !finished {
			if ctx.Err() == nil {
				slog.WarnContext(ctx, "agent turn terminal analytics lease lost before completion",
					"event", "agent.turn_terminal_analytics.lease_lost",
					"agent_session_id", delivery.AgentSessionID,
					"turn_id", delivery.TurnID,
				)
			}
			return
		}
	}
	p.wakeTurnTerminalAnalytics()
}

func (p *ActivityProjection) trackTurnTerminalAnalytics(
	ctx context.Context,
	delivery agentturnanalyticsbiz.Delivery,
) (bool, string) {
	mode, ok := terminalSubmissionMode(delivery.MetadataJSON)
	if !ok {
		return false, "submission_mode_invalid"
	}
	eventName, params, ok := agentturnterminal.Build(agentturnterminal.Input{
		AgentSessionID:    delivery.AgentSessionID,
		ClientSubmitID:    delivery.ClientSubmitID,
		ErrorCode:         delivery.ErrorCode,
		Mode:              mode,
		Origin:            delivery.Origin,
		Outcome:           delivery.Outcome,
		Provider:          delivery.Provider,
		SettledAtUnixMS:   delivery.SettledAtUnixMS,
		StartedAtUnixMS:   delivery.StartedAtUnixMS,
		StartupReconciled: delivery.StartupReconciled,
		TurnID:            delivery.TurnID,
	})
	if !ok {
		return false, "terminal_event_invalid"
	}
	params["event_id"] = delivery.EventID
	agentturnterminal.Track(ctx, p.analyticsReporter, eventName, params)
	return true, ""
}

func terminalSubmissionMode(metadataJSON string) (string, bool) {
	var metadata map[string]any
	if err := json.Unmarshal([]byte(metadataJSON), &metadata); err != nil || metadata == nil {
		return "", false
	}
	mode, ok := metadata["uiMode"].(string)
	if !ok || (mode != "os" && mode != "agent") {
		return "", false
	}
	return mode, true
}

func logSkippedTurnTerminalEvent(ctx context.Context, settled agenthost.RootTurnSettled, reason string) {
	slog.DebugContext(
		ctx,
		"agent turn terminal analytics skipped",
		"reason", reason,
		"agent_session_id", strings.TrimSpace(settled.AgentSessionID),
		"turn_id", strings.TrimSpace(settled.Turn.TurnID),
	)
}
