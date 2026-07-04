package agentruntime

import (
	"context"
	"errors"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

// appServerReviewTarget maps the `/review` slash-command args onto a codex
// app-server `review/start` target (see ReviewTarget in the app-server schema).
//
// The GUI review picker emits unambiguous colon-delimited forms so a human's
// free-form instructions can never be misread as a structured choice:
//
//	(empty)            -> uncommittedChanges
//	uncommitted        -> uncommittedChanges (review picker default)
//	base:<branch>      -> baseBranch
//	commit:<sha>       -> commit
//	custom:<text>      -> custom
//	<anything else>    -> custom (backward compatible free-form prompt)
//
// Git ref names disallow ':', so "base:"/"commit:"/"custom:" cannot collide
// with a real branch name, and free text such as "base our error handling"
// (no colon) stays a custom review.
func appServerReviewTarget(args string) map[string]any {
	args = strings.TrimSpace(args)
	if args == "" {
		return map[string]any{"type": "uncommittedChanges"}
	}
	if strings.EqualFold(args, "uncommitted") {
		return map[string]any{"type": "uncommittedChanges"}
	}
	if keyword, rest, ok := strings.Cut(args, ":"); ok {
		rest = strings.TrimSpace(rest)
		switch strings.ToLower(strings.TrimSpace(keyword)) {
		case "base":
			if rest != "" {
				return map[string]any{"type": "baseBranch", "branch": rest}
			}
		case "commit":
			if rest != "" {
				return map[string]any{"type": "commit", "sha": rest}
			}
		case "custom":
			if rest != "" {
				return map[string]any{"type": "custom", "instructions": rest}
			}
		}
	}
	return map[string]any{"type": "custom", "instructions": args}
}

func appServerReviewReasoningSummary() string {
	return "auto"
}

// appServerMessageHandler builds the message callback shared by the
// thread-control slash commands (compact, review, undo): every app-server
// message is routed through handleAppServerMessage and its events emitted.
func (a *CodexAppServerAdapter) appServerMessageHandler(
	appSession *codexAppServerSession,
	session Session,
	turnID string,
	normalizer *acpTurnNormalizer,
	emitEvents func([]activityshared.Event),
	emitCommands CommandSnapshotSink,
) func(context.Context, acpMessage) error {
	return func(ctx context.Context, message acpMessage) error {
		next, err := a.handleAppServerMessage(ctx, appSession.client, session, turnID, message, normalizer, emitEvents, emitCommands)
		emitEvents(next)
		return err
	}
}

// execReviewSlashCommand starts a codex review for the parsed target and
// streams the review turn to completion, mirroring a normal turn's terminal
// handling. It always reports the command as handled.
func (a *CodexAppServerAdapter) execReviewSlashCommand(
	ctx context.Context,
	appSession *codexAppServerSession,
	session Session,
	args string,
	turnID string,
	appTurn *codexAppServerActiveTurn,
	normalizer *acpTurnNormalizer,
	emitEvents func([]activityshared.Event),
	emitTerminal func([]activityshared.Event),
	emitCommands CommandSnapshotSink,
) (bool, error) {
	normalizer.SetThinkingPresentation("review-process")
	params := map[string]any{
		"threadId": appSession.threadID,
		"target":   appServerReviewTarget(args),
		"delivery": "inline",
		// Inline review interleaves readable reasoning via summaryTextDelta.
		// Request summaries explicitly so review turns do not inherit a thread
		// configured with model_reasoning_summary=none (for example spark).
		"summary": appServerReviewReasoningSummary(),
	}
	result, err := appSession.client.ReviewStart(ctx, params,
		a.appServerMessageHandler(appSession, session, turnID, normalizer, emitEvents, emitCommands))
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, errPermissionRequestCanceled) {
			terminalEvents := a.pendingRequestFailureEvents(session, turnID, errPermissionRequestCanceled)
			terminalEvents = append(terminalEvents, normalizer.FinishInterrupted(session, turnID, "interrupted")...)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
				"error": err.Error(),
			}))
			emitTerminal(terminalEvents)
		} else {
			terminalEvents := normalizer.FinishFailed(session, turnID)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(err)))
			emitTerminal(terminalEvents)
		}
		return true, nil
	}
	initialTurn := appServerTurnFromResult(result)
	if providerTurnID := asString(initialTurn["id"]); providerTurnID != "" {
		a.setSessionActiveTurnID(session.AgentSessionID, providerTurnID)
	}
	finalTurn, finishErr := a.awaitTurnCompletion(ctx, appSession, appTurn, initialTurn)
	if finishErr != nil {
		if errors.Is(finishErr, context.Canceled) || errors.Is(finishErr, errPermissionRequestCanceled) {
			// User cancellation: resolve any pending approval as failed and
			// report the turn as canceled (not failed), mirroring a normal turn.
			terminalEvents := a.pendingRequestFailureEvents(session, turnID, errPermissionRequestCanceled)
			terminalEvents = append(terminalEvents, normalizer.FinishInterrupted(session, turnID, "interrupted")...)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
				"error": finishErr.Error(),
			}))
			emitTerminal(terminalEvents)
		} else {
			terminalEvents := normalizer.FinishFailed(session, turnID)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(finishErr)))
			emitTerminal(terminalEvents)
		}
		return true, nil
	}
	normalizer.ApplyAssistantFinalText(appServerTurnFinalAssistantText(finalTurn))
	emitTerminal(appServerTurnTerminalEvents(session, turnID, finalTurn, normalizer))
	return true, nil
}
