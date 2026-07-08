package agentruntime

import (
	"fmt"
	"log/slog"
	"strings"
)

type codexAppServerTurnKind string

const (
	codexAppServerTurnKindNormal  codexAppServerTurnKind = "normal"
	codexAppServerTurnKindCompact codexAppServerTurnKind = "compact"
	// codexAppServerTurnKindGoalAdopted marks a turn that codex started on its
	// own to continue an active goal, adopted by the reducer so its output is
	// tracked like any Exec-driven turn.
	codexAppServerTurnKindGoalAdopted codexAppServerTurnKind = "goal-adopted"
)

type codexAppServerTurnPhase string

const (
	codexAppServerTurnPhaseIdle         codexAppServerTurnPhase = "idle"
	codexAppServerTurnPhaseRunning      codexAppServerTurnPhase = "running"
	codexAppServerTurnPhaseCompacting   codexAppServerTurnPhase = "compacting"
	codexAppServerTurnPhaseInterrupting codexAppServerTurnPhase = "interrupting"
	codexAppServerTurnPhaseCompleted    codexAppServerTurnPhase = "completed"
	codexAppServerTurnPhaseFailed       codexAppServerTurnPhase = "failed"
	codexAppServerTurnPhaseCanceled     codexAppServerTurnPhase = "canceled"
)

type codexAppServerTurnTerminal struct {
	turn  map[string]any
	err   error
	phase codexAppServerTurnPhase
}

func (phase codexAppServerTurnPhase) terminal() bool {
	switch phase {
	case codexAppServerTurnPhaseCompleted,
		codexAppServerTurnPhaseFailed,
		codexAppServerTurnPhaseCanceled:
		return true
	default:
		return false
	}
}

func (a *CodexAppServerAdapter) transitionActiveTurnPhase(
	agentSessionID string,
	turn *codexAppServerActiveTurn,
	phase codexAppServerTurnPhase,
) {
	if a == nil || turn == nil || phase == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil || appSession.activeTurn != turn || turn.phase.terminal() {
		return
	}
	if phase == codexAppServerTurnPhaseCompacting {
		turn.kind = codexAppServerTurnKindCompact
	}
	turn.phase = phase
}

// completeActiveTurn transitions the reducer-owned turn projection to a
// terminal phase after the `turn/completed` notification or an already-terminal
// initial turn snapshot. The blocking Exec wrapper observes the terminal
// channel; it no longer owns terminal classification.
func (a *CodexAppServerAdapter) completeActiveTurn(agentSessionID string, turn map[string]any) {
	a.settleActiveTurn(agentSessionID, asString(turn["id"]), func(activeTurn *codexAppServerActiveTurn) codexAppServerTurnTerminal {
		phase := appServerProjectedTurnTerminalPhase(turn, activeTurn.forceCanceled)
		appServerLogTurnTerminalShadowMismatch(agentSessionID, turn, phase)
		return codexAppServerTurnTerminal{turn: turn, phase: phase}
	})
}

func (a *CodexAppServerAdapter) failActiveTurnFromAppServerError(agentSessionID string, params map[string]any) {
	err := appServerNotificationError(params)
	a.settleActiveTurn(agentSessionID, asString(params["turnId"]), func(*codexAppServerActiveTurn) codexAppServerTurnTerminal {
		return codexAppServerTurnTerminal{err: err, phase: codexAppServerTurnPhaseFailed}
	})
}

// settleActiveTurn owns the shared settle sequence — lock, session lookup,
// provider-turn-id match, phase transition, activeTurnID clear, non-blocking
// terminal send — so the completion and failure paths cannot diverge on the
// guards. terminalFor runs under the adapter lock with the matched active turn.
//
// A mismatched non-empty provider turn id settles anyway when the recorded id
// was never confirmed by turn/started: a turn/start issued while another turn
// is already running responds with a stub id that codex never starts — the
// input is steered into the running turn, so that turn's same-thread terminal
// is this turn's terminal (live-verified against codex 0.142.5,
// TestLiveProtocolTurnStartDuringActiveTurn). Requiring an exact match there
// wedged awaitTurnCompletion forever. Goal-adopted turns are the only active
// turns allowed to settle from an empty terminal id because their ownership was
// established by the preceding turn/started notification.
func (a *CodexAppServerAdapter) settleActiveTurn(
	agentSessionID string,
	providerTurnID string,
	terminalFor func(*codexAppServerActiveTurn) codexAppServerTurnTerminal,
) {
	if a == nil {
		return
	}
	var activeTurn *codexAppServerActiveTurn
	var terminal codexAppServerTurnTerminal
	steerAdoptedTurnID := ""
	droppedTurnID := ""
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession != nil {
		activeTurn = appSession.activeTurn
		if activeTurn != nil {
			expected := strings.TrimSpace(appSession.activeTurnID)
			actual := strings.TrimSpace(providerTurnID)
			switch {
			case expected == "" || actual == expected:
			case actual == "" && activeTurn.kind == codexAppServerTurnKindGoalAdopted:
			case actual != "" && !appSession.activeTurnStartConfirmed:
				steerAdoptedTurnID = expected
			default:
				droppedTurnID = expected
				activeTurn = nil
			}
		}
		if activeTurn != nil {
			terminal = terminalFor(activeTurn)
			activeTurn.phase = terminal.phase
			appSession.activeTurnID = ""
			appSession.activeTurnStartConfirmed = false
		}
	}
	emits := activeTurn != nil && activeTurn.settleEmits
	a.mu.Unlock()
	if droppedTurnID != "" {
		slog.Warn("agent session app-server turn terminal dropped on provider turn id mismatch",
			"event", "agent_session.app_server.turn.terminal_id_mismatch",
			"agent_session_id", agentSessionID,
			"recorded_turn_id", droppedTurnID,
			"terminal_turn_id", providerTurnID,
		)
	}
	if activeTurn == nil {
		return
	}
	if steerAdoptedTurnID != "" {
		slog.Warn("agent session app-server steered turn adopted running turn terminal",
			"event", "agent_session.app_server.turn.steer_terminal_adopted",
			"agent_session_id", agentSessionID,
			"stub_turn_id", steerAdoptedTurnID,
			"terminal_turn_id", providerTurnID,
		)
	}
	select {
	case activeTurn.terminal <- terminal:
	default:
	}
	if emits {
		a.finalizeSettledTurn(agentSessionID, activeTurn, terminal)
	}
}

func appServerProjectedTurnTerminalPhase(turn map[string]any, forceCanceled bool) codexAppServerTurnPhase {
	if forceCanceled {
		return codexAppServerTurnPhaseCanceled
	}
	switch strings.TrimSpace(asString(turn["status"])) {
	case "failed":
		return codexAppServerTurnPhaseFailed
	case "interrupted", "canceled":
		return codexAppServerTurnPhaseCanceled
	default:
		return codexAppServerTurnPhaseCompleted
	}
}

func appServerLegacyTurnTerminalPhase(turn map[string]any) codexAppServerTurnPhase {
	switch strings.TrimSpace(asString(turn["status"])) {
	case "failed":
		return codexAppServerTurnPhaseFailed
	case "interrupted", "canceled":
		return codexAppServerTurnPhaseCanceled
	default:
		return codexAppServerTurnPhaseCompleted
	}
}

func appServerLogTurnTerminalShadowMismatch(
	agentSessionID string,
	turn map[string]any,
	projected codexAppServerTurnPhase,
) {
	legacy := appServerLegacyTurnTerminalPhase(turn)
	if projected == legacy {
		return
	}
	slog.Warn("agent session app-server turn projection terminal mismatch",
		"event", "agent_session.app_server.turn_projection.shadow_mismatch",
		"agent_session_id", agentSessionID,
		"provider_turn_id", asString(turn["id"]),
		"status", asString(turn["status"]),
		"projected_phase", string(projected),
		"legacy_phase", string(legacy),
	)
}

func appServerNotificationError(params map[string]any) error {
	turnError := payloadObject(params["error"])
	message := strings.TrimSpace(asStringRaw(turnError["message"]))
	if message == "" {
		message = strings.TrimSpace(asStringRaw(params["message"]))
	}
	if message == "" {
		return fmt.Errorf("codex app-server turn failed")
	}
	return fmt.Errorf("%s", message)
}
