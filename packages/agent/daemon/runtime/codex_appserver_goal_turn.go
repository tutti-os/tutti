package agentruntime

import (
	"context"
	"log/slog"
	"sync"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// adoptServerInitiatedTurn registers a turn that codex started on its own
// (goal auto-continuation) as a first-class tracked turn: it gets a fresh
// turn id, a normalizer, and a session-sink emitter, so its output persists
// and renders exactly like an Exec-driven turn. Settlement is owned by the
// notification path (settleEmits); no goroutine blocks on it. Runs on the
// client read loop, so registration completes before the turn's first item
// notification is processed.
func (a *CodexAppServerAdapter) adoptServerInitiatedTurn(session Session, providerTurnID string, identity goalOperationIdentity) bool {
	appSession := a.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		return false
	}
	turnID := newID()
	normalizer := newACPTurnNormalizer()
	var eventsMu sync.Mutex
	turnClosed := false
	emitEvents := func(next []activityshared.Event) {
		if len(next) == 0 {
			return
		}
		eventsMu.Lock()
		defer eventsMu.Unlock()
		if turnClosed {
			return
		}
		a.emitSessionEvents(session.AgentSessionID, a.stampTurnLifecycleSnapshots(session.AgentSessionID, next))
	}
	emitTerminal := func(next []activityshared.Event) {
		eventsMu.Lock()
		defer eventsMu.Unlock()
		if turnClosed {
			return
		}
		turnClosed = true
		a.emitSessionEvents(session.AgentSessionID, a.stampTurnLifecycleSnapshots(session.AgentSessionID, next))
	}
	appTurn := &codexAppServerActiveTurn{
		turnID:      turnID,
		session:     session,
		ctx:         context.Background(),
		normalizer:  normalizer,
		diagnostics: newCodexAppServerTurnDiagnostics(nil, turnID),
		emit:        emitEvents,
		kind:        codexAppServerTurnKindGoalAdopted,
		phase:       codexAppServerTurnPhaseRunning,
		terminal:    make(chan codexAppServerTurnTerminal, 1),
		terminated:  make(chan struct{}),
		settleEmits: true,
	}
	appTurn.emitTerminal = emitTerminal
	if !a.beginGoalTurnHandoff(session.AgentSessionID, providerTurnID, appTurn, identity) {
		// A registered turn won the race; leave tracking to it.
		return false
	}
	trace := newCodexAppServerTurnTrace(session, turnID, nil)
	appTurn.diagnostics.Start(trace)
	slog.Info("agent session app-server goal turn adopted",
		"event", "agent_session.app_server.goal.turn_adopted",
		"agent_session_id", session.AgentSessionID,
		"provider_turn_id", providerTurnID,
		"turn_id", turnID,
		"provenance_mode", appTurn.goalProvenance,
	)
	emitEvents([]activityshared.Event{
		newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", map[string]any{
			"goalContinuation":      true,
			"turnOrigin":            "goal_continuation",
			"sourceGoalOperationId": identity.operationID,
			"sourceGoalRevision":    identity.revision,
			"sourceGoalRepairEpoch": identity.repairEpoch,
			"goalProvenanceMode":    appTurn.goalProvenance,
		}),
	})
	if a.goalHandoffCommittedHook != nil {
		a.goalHandoffCommittedHook()
	}
	a.drainGoalTurnHandoff(session.AgentSessionID, providerTurnID, appTurn)
	go a.watchTurnExternalTermination(appSession, appTurn)
	return true
}
