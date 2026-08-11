package agentruntime

import (
	"context"
	"log/slog"
	"strings"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

const (
	canonicalTerminalCommitRetryInitialBackoff = 100 * time.Millisecond
	canonicalTerminalCommitRetryMaxBackoff     = 5 * time.Second
)

type rootTurnCompletionAuthority uint8

const (
	rootTurnCompletionAwaitProviderAggregation rootTurnCompletionAuthority = iota
	rootTurnCompletionDirectCanonical
)

// classifyRootTurnCompletion distinguishes a terminal fact for the exact
// canonical Turn from provider-root lifecycle facts. Dispatch disposition is
// deliberately absent: admission and completion are independent contracts.
func classifyRootTurnCompletion(
	turnID string,
	events []activityshared.Event,
) rootTurnCompletionAuthority {
	if turnHasTerminalEvent(events, turnID) {
		return rootTurnCompletionDirectCanonical
	}
	return rootTurnCompletionAwaitProviderAggregation
}

// pendingCanonicalTerminalCommit retains a terminal fact that the Controller
// accepted in memory but could not yet confirm through the durable reporter.
// The owning blocking-exec goroutine keeps the exact active-turn fence until
// this record commits or daemon reconciliation proves the Turn already settled.
type pendingCanonicalTerminalCommit struct {
	session Session
	events  []activityshared.Event
}

func (pending *pendingCanonicalTerminalCommit) merge(
	session Session,
	events []activityshared.Event,
) {
	if pending == nil || len(events) == 0 {
		return
	}
	pending.session = session
	pending.events = append(
		pending.events,
		unemittedActivityEvents(events, pending.events)...,
	)
}

func (pending *pendingCanonicalTerminalCommit) directCanonical(turnID string) bool {
	return pending != nil && classifyRootTurnCompletion(
		turnID,
		pending.events,
	) == rootTurnCompletionDirectCanonical
}

// convergeCanonicalTerminalCommit retries the same idempotent terminal facts
// after the bounded synchronous barrier fails. It intentionally outlives the
// submit caller's context: the submitted Turn is already durable, so only a
// successful terminal commit or an exact daemon reconciliation may release the
// active-turn fence.
func (c *Controller) convergeCanonicalTerminalCommit(
	ctx context.Context,
	turnID string,
	pending *pendingCanonicalTerminalCommit,
) bool {
	if c == nil || pending == nil || len(pending.events) == 0 {
		return false
	}
	retryCtx := context.WithoutCancel(ctx)
	backoff := canonicalTerminalCommitRetryInitialBackoff
	attempt := 1
	for {
		timer := time.NewTimer(backoff)
		<-timer.C

		active, ok := c.activeTurn(
			pending.session.RoomID,
			pending.session.AgentSessionID,
		)
		if !ok || strings.TrimSpace(active.turnID) != strings.TrimSpace(turnID) {
			// ReconcileRootTurnSettlement may win this race after proving the
			// canonical Store is already settled. Never republish after that.
			return false
		}

		session := c.preserveCurrentSessionSettings(pending.session)
		accepted, ok := c.storeTurnSession(session, turnID)
		if !ok {
			return false
		}
		pending.session = accepted
		err := c.reportSessionBeforePublish(retryCtx, accepted, pending.events)
		if err == nil {
			if !c.isProvisionalSession(accepted) {
				c.publish(accepted, pending.events)
			}
			return pending.directCanonical(turnID)
		}
		slog.Warn(
			"agent session terminal activity report remains pending",
			"event", "agent_session.activity_report.terminal_commit_retry",
			"room_id", accepted.RoomID,
			"agent_session_id", accepted.AgentSessionID,
			"turn_id", strings.TrimSpace(turnID),
			"attempt", attempt,
			"retry_backoff", backoff,
			"error", err,
		)

		if backoff < canonicalTerminalCommitRetryMaxBackoff {
			backoff *= 2
			if backoff > canonicalTerminalCommitRetryMaxBackoff {
				backoff = canonicalTerminalCommitRetryMaxBackoff
			}
		}
		attempt++
	}
}

// finalizeBlockingExecTurn owns the active-turn fence transition after a
// blocking adapter invocation exits. Root-provider adapters normally wait for
// canonical provider aggregation. The only providerless exception is an exact
// canonical terminal that already crossed the synchronous durable-report
// barrier; it needs no provider identity to become authoritative.
func (c *Controller) finalizeBlockingExecTurn(
	session Session,
	turnID string,
	rootProviderLifecycle bool,
	directCanonicalTerminalCommitted bool,
) {
	if !rootProviderLifecycle || directCanonicalTerminalCommitted {
		_, _ = c.finishTurn(session, turnID)
		return
	}
	_, _ = c.storeTurnSession(session, turnID)
}
