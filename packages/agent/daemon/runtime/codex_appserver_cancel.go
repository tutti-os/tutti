package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sort"
	"strings"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (a *CodexAppServerAdapter) Cancel(ctx context.Context, session Session, reason string) ([]activityshared.Event, error) {
	reason = strings.TrimSpace(reason)
	appSession := a.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		return nil, ErrSessionDisconnected
	}
	childEvents := a.interruptLinkedChildThreads(session, appSession, a.sessionMarkerTurnID(session.AgentSessionID), reason)
	activeTurnID, queued := a.requestActiveTurnCancel(session.AgentSessionID)
	// Unblock any handler waiting on an approval answer first: the message
	// read loop is parked inside that handler, so the interrupt response
	// could never be dispatched otherwise.
	a.rejectPendingRequests(session.AgentSessionID, errPermissionRequestCanceled)
	// Stop pauses an active goal BEFORE interrupting the turn: otherwise codex
	// would immediately auto-start the next goal turn and the stop would be a
	// no-op from the user's perspective. Pause failures fall through to the
	// interrupt (the reducer additionally interrupts unowned turns for paused
	// goals as defense-in-depth).
	childEvents = append(a.pauseActiveGoalForCancel(session), childEvents...)
	if activeTurnID == "" {
		if queued {
			return childEvents, nil
		}
		if len(childEvents) > 0 {
			return childEvents, nil
		}
		return nil, ErrSessionNoActiveTurn
	}
	appTurn := a.sessionActiveTurn(session.AgentSessionID)
	return childEvents, a.interruptActiveTurn(ctx, appSession, session, appTurn, activeTurnID, reason)
}

// pauseActiveGoalForCancel sets an active goal to paused so codex stops
// auto-continuing after the interrupted turn. Best-effort: on failure the
// interrupt still proceeds and the reducer's paused-goal defense interrupts
// any turn codex starts anyway.
func (a *CodexAppServerAdapter) pauseActiveGoalForCancel(session Session) []activityshared.Event {
	agentSessionID := session.AgentSessionID
	appSession := a.getSession(agentSessionID)
	if appSession == nil || appSession.client == nil {
		return nil
	}
	if strings.TrimSpace(asString(a.sessionGoal(agentSessionID)["status"])) != "active" {
		return nil
	}
	client := appSession.client
	// Cancel's own ctx can be short-lived; bound the pause independently.
	// NoHandler: the turn being canceled is still streaming, so this RPC must
	// not claim the message handler slot (or serialize behind turn/start).
	pauseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := client.ThreadGoalSetNoHandler(pauseCtx, map[string]any{
		"threadId": appSession.threadID,
		"status":   "paused",
	})
	if err != nil {
		slog.Warn("agent session app-server goal pause on cancel failed",
			"event", "agent_session.app_server.goal.pause_failed",
			"agent_session_id", agentSessionID,
			"error", err.Error(),
		)
		return nil
	}
	if goal := appServerGoalFromResult(result); len(goal) > 0 {
		a.applyGoalUpdate(agentSessionID, goal)
	} else if goal := a.sessionGoal(agentSessionID); len(goal) > 0 {
		// Status-only set may return an empty goal payload; mirror the pause
		// locally so the reducer's paused-goal defense engages.
		goal["status"] = "paused"
		a.applyGoalUpdate(agentSessionID, goal)
	}
	// No transcript notice: pausing is a deliberate action and the banner
	// already reflects the paused state; repeated stops would spam the
	// timeline.
	events := []activityshared.Event{}
	if event, ok := normalizedGoalUpdatedEvent(session, "thread_goal_update"); ok {
		events = append(events, event)
	}
	return events
}

// interruptActiveTurn stops the active turn. It first asks codex to cancel
// gracefully via turn/interrupt; if the turn has not terminated within the
// grace window it force-closes the app-server process so the turn can never
// hang forever. It returns only after the turn has actually terminated
// (terminate-then-respond), so the caller's UI can clear its stopping state
// against a real outcome.
func (a *CodexAppServerAdapter) interruptActiveTurn(
	ctx context.Context,
	appSession *codexAppServerSession,
	session Session,
	appTurn *codexAppServerActiveTurn,
	activeTurnID string,
	reason string,
) error {
	// Best-effort graceful interrupt, sent asynchronously: a wedged codex may
	// never answer turn/interrupt, and a synchronous call would burn the whole
	// acpPermissionModeTimeout before the grace window even starts. Firing it in
	// the background keeps time-to-force bounded by cancelGraceWindow.
	go a.sendTurnInterrupt(appSession, session, activeTurnID, reason)

	// Without a turn handle we cannot wait for termination or force-close.
	if appTurn == nil {
		return nil
	}

	grace := a.cancelGraceWindow
	if grace <= 0 {
		grace = defaultCodexAppServerCancelGraceWindow
	}
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case <-appTurn.terminated:
		// codex honored the interrupt; the turn finished gracefully.
		return nil
	case <-timer.C:
	}

	// codex did not stop in time — force-close the app-server process. The torn
	// down connection unblocks awaitTurnCompletion via client.Done(), and the
	// force-canceled flag makes Exec surface the outcome as canceled.
	a.markTurnForceCanceled(appTurn)
	slog.Warn("agent session app-server force-closing wedged turn",
		"event", "agent_session.app_server.interrupt.forced",
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", appSession.threadID,
		"turn_id", activeTurnID,
		"reason", reason,
		"grace_ms", grace.Milliseconds(),
	)
	_ = appSession.client.Close()

	// Wait for the turn goroutine to finalize so we respond after it stopped.
	select {
	case <-appTurn.terminated:
	case <-ctx.Done():
	}
	return nil
}

// sendTurnInterrupt issues a best-effort turn/interrupt. It is called in the
// background so a hung interrupt RPC cannot delay the force-close grace window.
func (a *CodexAppServerAdapter) sendTurnInterrupt(
	appSession *codexAppServerSession,
	session Session,
	activeTurnID string,
	reason string,
) {
	a.sendThreadInterrupt(appSession.client, session, appSession.threadID, activeTurnID, reason)
}

// scheduleChildNicknameFetches resolves spawned sub-agents' display names.
// codex assigns each spawned agent an agentNickname on its Thread object but
// never pushes it (no thread/name/updated for children), so - like traycer -
// we fetch it asynchronously via thread/read and emit a subAgentName marker.
func (a *CodexAppServerAdapter) scheduleChildNicknameFetches(session Session, childThreadIDs []string) {
	if a == nil || len(childThreadIDs) == 0 {
		return
	}
	appSession := a.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		return
	}
	client := appSession.client
	for _, childThreadID := range childThreadIDs {
		go a.fetchChildThreadNickname(client, session, childThreadID)
	}
}

func (a *CodexAppServerAdapter) fetchChildThreadNickname(client *codexAppServerClient, session Session, childThreadID string) {
	childThreadID = strings.TrimSpace(childThreadID)
	if client == nil || childThreadID == "" {
		return
	}
	// The nickname can be assigned slightly after the spawn item announces the
	// thread; retry a few times before giving up (numbered fallback remains).
	for attempt := 0; attempt < 5; attempt++ {
		if attempt > 0 {
			select {
			case <-client.Done():
				return
			case <-time.After(2 * time.Second):
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), acpStartCallTimeout)
		raw, err := client.ThreadReadNoHandler(ctx, acpStartCallTimeout, map[string]any{
			"threadId": childThreadID,
		})
		cancel()
		if err != nil {
			continue
		}
		result := map[string]any{}
		_ = json.Unmarshal(raw, &result)
		thread := payloadObject(result["thread"])
		nickname := firstNonEmpty(asString(thread["agentNickname"]), asString(thread["name"]))
		if nickname == "" {
			continue
		}
		event := appServerSubAgentNameEvent(session, childThreadID, nickname)
		if event.Type == "" {
			return
		}
		if child, ok := a.appServerChildThread(session.AgentSessionID, childThreadID); ok {
			event.OwnerCallID = child.parentItemID
		}
		if event.Payload.TurnID == "" {
			// The activity store rejects turnless message updates.
			event.Payload.TurnID = a.sessionMarkerTurnID(session.AgentSessionID)
		}
		a.emitSessionEvents(session.AgentSessionID, []activityshared.Event{event})
		return
	}
}

func (*CodexAppServerAdapter) sendThreadInterrupt(
	client *codexAppServerClient,
	session Session,
	threadID string,
	turnID string,
	reason string,
) {
	threadID = strings.TrimSpace(threadID)
	if client == nil || threadID == "" {
		return
	}
	turnID = strings.TrimSpace(turnID)
	err := codexSendTurnInterruptOnce(client, threadID, turnID)
	if err != nil {
		// Our own turn bookkeeping settles a turn locally as soon as its Go
		// context is canceled (see Cancel/interruptActiveTurn), without
		// waiting for the app-server to actually confirm the turn stopped.
		// When a slow-to-terminate tool call (for example wait_agent on
		// several dispatched sub-agents) keeps the app-server's real turn
		// alive past that point, a subsequent interrupt aimed at the turn id
		// we *think* is active gets rejected with "expected active turn id X
		// but found Y". Retry once against Y so the real, still-running turn
		// actually gets interrupted instead of being abandoned to die on its
		// own — which otherwise can leave it running for minutes.
		if foundTurnID, ok := codexExpectedActiveTurnIDMismatch(err); ok && foundTurnID != turnID {
			slog.Warn("agent session app-server interrupt turn id stale, retrying",
				"event", "agent_session.app_server.interrupt.turn_id_stale",
				"agent_session_id", session.AgentSessionID,
				"provider_session_id", threadID,
				"requested_turn_id", turnID,
				"actual_turn_id", foundTurnID,
				"reason", reason,
			)
			err = codexSendTurnInterruptOnce(client, threadID, foundTurnID)
		}
	}
	if err != nil {
		slog.Warn("agent session app-server interrupt failed",
			"event", "agent_session.app_server.interrupt.failed",
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", threadID,
			"turn_id", turnID,
			"reason", reason,
			"error", err.Error(),
		)
	}
}

func codexSendTurnInterruptOnce(client *codexAppServerClient, threadID, turnID string) error {
	interruptCtx, cancel := context.WithTimeout(context.Background(), acpPermissionModeTimeout)
	defer cancel()
	_, err := client.TurnInterruptNoHandler(interruptCtx, acpPermissionModeTimeout, map[string]any{
		"threadId": threadID,
		"turnId":   turnID,
	})
	return err
}

// codexExpectedActiveTurnIDMismatch recognizes the codex app-server's
// turn/interrupt rejection for a stale expected turn id: "expected active
// turn id <requested> but found <actual>". It reports actual so the caller
// can retry against the turn codex itself considers active. JSON-RPC -32600
// is the generic "invalid request" code the app-server reuses for several
// distinct rejections (see isACPProviderSessionNotFound), so this keys off
// the distinctive message text rather than the code.
func codexExpectedActiveTurnIDMismatch(err error) (string, bool) {
	var callErr *acpCallError
	if !errors.As(err, &callErr) || callErr == nil {
		return "", false
	}
	message := strings.TrimSpace(callErr.Err.Message)
	lower := strings.ToLower(message)
	if !strings.Contains(lower, "expected active turn id") {
		return "", false
	}
	const marker = "but found "
	idx := strings.LastIndex(lower, marker)
	if idx < 0 {
		return "", false
	}
	rest := strings.TrimSpace(message[idx+len(marker):])
	if sp := strings.IndexAny(rest, " \t\n"); sp >= 0 {
		rest = rest[:sp]
	}
	rest = strings.Trim(rest, ".,;")
	if rest == "" {
		return "", false
	}
	return rest, true
}

func (a *CodexAppServerAdapter) interruptLinkedChildThreads(
	session Session,
	appSession *codexAppServerSession,
	markerTurnID string,
	reason string,
) []activityshared.Event {
	if a == nil || appSession == nil || appSession.client == nil {
		return nil
	}
	linkedChildren := a.takeLinkedChildThreads(session.AgentSessionID)
	if len(linkedChildren) == 0 {
		return nil
	}
	events := make([]activityshared.Event, 0, len(linkedChildren))
	for _, child := range linkedChildren {
		go a.sendThreadInterrupt(appSession.client, session, child.threadID, "", reason)
		event := appServerSubAgentLifecycleEvent(session, child.threadID, markerTurnID, "canceled", reason)
		if event.Type != "" {
			event.OwnerCallID = child.parentItemID
			events = append(events, event)
		}
	}
	return events
}

type linkedChildThread struct {
	threadID     string
	parentItemID string
}

func (a *CodexAppServerAdapter) takeLinkedChildThreads(agentSessionID string) []linkedChildThread {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil || len(appSession.childThreads) == 0 {
		return nil
	}
	children := make([]linkedChildThread, 0, len(appSession.childThreads))
	for childThreadID, child := range appSession.childThreads {
		trimmed := strings.TrimSpace(childThreadID)
		if trimmed == "" {
			continue
		}
		linked := linkedChildThread{threadID: trimmed}
		if child != nil {
			linked.parentItemID = child.parentItemID
		}
		children = append(children, linked)
	}
	sort.Slice(children, func(left, right int) bool {
		return children[left].threadID < children[right].threadID
	})
	appSession.childThreads = nil
	return children
}

func (a *CodexAppServerAdapter) markTurnForceCanceled(turn *codexAppServerActiveTurn) {
	if a == nil || turn == nil {
		return
	}
	a.mu.Lock()
	turn.forceCanceled = true
	agentSessionID := turn.session.AgentSessionID
	emits := turn.settleEmits && !turn.phase.terminal()
	turn.phase = codexAppServerTurnPhaseCanceled
	a.mu.Unlock()
	terminal := codexAppServerTurnTerminal{err: errPermissionRequestCanceled, phase: codexAppServerTurnPhaseCanceled}
	select {
	case turn.terminal <- terminal:
	default:
	}
	// Force-cancel is a first-class terminal transition: finalize from here
	// so terminal events do not depend on the (possibly wedged) shell.
	if emits {
		a.finalizeSettledTurn(agentSessionID, turn, terminal)
	}
}

func (a *CodexAppServerAdapter) turnForceCanceled(turn *codexAppServerActiveTurn) bool {
	if a == nil || turn == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return turn.forceCanceled
}

func (a *CodexAppServerAdapter) interruptActiveTurnAsync(
	appSession *codexAppServerSession,
	session Session,
	appTurn *codexAppServerActiveTurn,
	activeTurnID string,
	reason string,
) {
	go func() {
		if err := a.interruptActiveTurn(context.Background(), appSession, session, appTurn, activeTurnID, reason); err != nil {
			slog.Warn("agent session app-server queued interrupt failed",
				"event", "agent_session.app_server.interrupt.queued_failed",
				"agent_session_id", session.AgentSessionID,
				"provider_session_id", appSession.threadID,
				"turn_id", activeTurnID,
				"reason", reason,
				"error", err.Error(),
			)
		}
	}()
}
