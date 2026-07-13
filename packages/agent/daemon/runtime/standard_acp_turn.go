package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (a *standardACPAdapter) Exec(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	emitCommands CommandSnapshotSink,
) ([]activityshared.Event, error) {
	acpSession := a.getSession(session.AgentSessionID)
	if acpSession == nil || acpSession.client == nil {
		return nil, ErrSessionDisconnected
	}
	session.ProviderSessionID = acpSession.providerSessionID
	a.rememberSessionTurn(session.AgentSessionID, turnID)
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, displayPrompt)
	mentionRoutingApplied, mentionRoutingSkills := tuttiMentionRoutingSkills(visibleText)
	acpPromptContent := promptContentForACP(content)
	if mentionRoutingApplied {
		acpPromptContent = appendTuttiMentionRoutingPrompt(acpPromptContent, mentionRoutingSkills)
	}
	normalizer := newACPTurnNormalizer()
	var events []activityshared.Event
	emitEvents := func(next []activityshared.Event) {
		if len(next) == 0 {
			return
		}
		events = append(events, next...)
		if emit != nil {
			emit(next)
		}
	}

	startEvents := make([]activityshared.Event, 0, 3)
	if fallbackTitle := fallbackStandardSessionTitle(a.config, session.Title, visibleText); fallbackTitle != "" {
		startEvents = append(startEvents, newSessionTitleActivityEvent(session, fallbackTitle))
		session.Title = fallbackTitle
	}
	startEvents = append(startEvents,
		newTurnActivityEvent(session, EventMessage, turnID, "", RoleUser, visibleText, userPromptActivityPayload(content, explicitDisplayPrompt, userPromptActivityPayloadExtraFromExecMetadata(ctx, nil))),
		newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", nil),
	)
	emitEvents(startEvents)
	slog.Info("agent session ACP exec started",
		"event", "agent_session.acp.exec.start",
		"provider", a.config.provider,
		"adapter", a.config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"turn_id", turnID,
		"prompt_length", len(visibleText),
		"mention_uri_count", len(extractMentionURIs(visibleText)),
		"mention_routing_applied", mentionRoutingApplied,
		"mention_routing_skills", mentionRoutingSkills,
	)
	if mentionRoutingApplied {
		slog.Info("agent session ACP mention routing applied",
			"event", "agent_session.acp.mention_routing.applied",
			"provider", a.config.provider,
			"adapter", a.config.adapterName,
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", session.ProviderSessionID,
			"turn_id", turnID,
			"mention_routing_skills", mentionRoutingSkills,
			"prompt_length", len(visibleText),
		)
	}

	promptParams := acpPromptContent
	autoContinueAttempts := 0
execLoop:
	for {
		result, err := acpSession.client.Call(ctx, acpMethodPrompt, map[string]any{
			"sessionId": acpSession.providerSessionID,
			"prompt":    promptParams,
		}, func(ctx context.Context, message acpMessage) error {
			slog.Info("agent session ACP exec received message",
				"event", "agent_session.acp.exec.message",
				"provider", a.config.provider,
				"adapter", a.config.adapterName,
				"room_id", session.RoomID,
				"agent_session_id", session.AgentSessionID,
				"provider_session_id", session.ProviderSessionID,
				"turn_id", turnID,
				"message_method", message.Method,
				"message_id", rawMessageLogValue(message.ID),
			)
			next, err := a.handleACPMessage(ctx, acpSession.client, session, turnID, message, normalizer, emitEvents, emitCommands)
			slog.Info("agent session ACP exec handled message",
				"event", "agent_session.acp.exec.message_handled",
				"provider", a.config.provider,
				"adapter", a.config.adapterName,
				"room_id", session.RoomID,
				"agent_session_id", session.AgentSessionID,
				"provider_session_id", session.ProviderSessionID,
				"turn_id", turnID,
				"message_method", message.Method,
				"event_count", len(next),
				"event_type_counts", activityEventTypeCounts(next),
				"error", errString(err),
			)
			emitEvents(next)
			if err != nil {
				return err
			}
			return nil
		})
		if err != nil {
			slog.Warn("agent session ACP exec call failed",
				"event", "agent_session.acp.exec.call_failed",
				"provider", a.config.provider,
				"adapter", a.config.adapterName,
				"room_id", session.RoomID,
				"agent_session_id", session.AgentSessionID,
				"provider_session_id", session.ProviderSessionID,
				"turn_id", turnID,
				"emitted_event_count", len(events),
				"emitted_event_type_counts", activityEventTypeCounts(events),
				"error", err.Error(),
			)
			if errors.Is(err, context.Canceled) || errors.Is(err, errPermissionRequestCanceled) {
				terminalEvents := normalizer.FinishInterrupted(session, turnID, "interrupted")
				terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
					"error": err.Error(),
				}))
				emitEvents(terminalEvents)
			} else {
				terminalEvents := normalizer.FinishFailed(session, turnID)
				terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", map[string]any{
					"error": err.Error(),
				}))
				emitEvents(terminalEvents)
			}
			return events, nil
		}

		stopReason := acpStopReason(result)
		normalizer.ApplyAssistantFinalText(acpPromptResultAssistantText(result))
		slog.Info("agent session ACP exec call completed",
			"event", "agent_session.acp.exec.call_completed",
			"provider", a.config.provider,
			"adapter", a.config.adapterName,
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", session.ProviderSessionID,
			"turn_id", turnID,
			"stop_reason", firstNonEmpty(stopReason, "end_turn"),
			"auto_continue_attempts", autoContinueAttempts,
			"emitted_event_count", len(events),
			"emitted_event_type_counts", activityEventTypeCounts(events),
		)
		if a.config.autoContinueRetriableTurnError && acpStopReasonEndsTurnNormally(stopReason) {
			if errLine, ok := acpRetriableTurnTailError(normalizer.CurrentAssistantText()); ok {
				if autoContinueAttempts < acpAutoContinueMaxAttempts {
					autoContinueAttempts++
					// Close out the error-text segment so the continuation
					// streams into a fresh message instead of appending to it.
					emitEvents(normalizer.Finish(session, turnID, messageStreamStateCompleted))
					if notice, ok := acpAutoContinueNoticeEvent(session, turnID, errLine, autoContinueAttempts); ok {
						emitEvents([]activityshared.Event{notice})
					}
					slog.Warn("agent session ACP auto-continue after retriable turn error",
						"event", "agent_session.acp.exec.auto_continue",
						"provider", a.config.provider,
						"adapter", a.config.adapterName,
						"room_id", session.RoomID,
						"agent_session_id", session.AgentSessionID,
						"provider_session_id", session.ProviderSessionID,
						"turn_id", turnID,
						"attempt", autoContinueAttempts,
						"max_attempts", acpAutoContinueMaxAttempts,
						"error_line", errLine,
					)
					promptParams = acpAutoContinuePromptContent()
					continue execLoop
				}
				// The retries were cut short too: surface the turn as failed
				// instead of a silent "completed" that strands the conversation.
				terminalEvents := normalizer.FinishFailed(session, turnID)
				terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", map[string]any{
					"error":      errLine,
					"stopReason": firstNonEmpty(stopReason, "end_turn"),
				}))
				emitEvents(terminalEvents)
				slog.Warn("agent session ACP auto-continue attempts exhausted",
					"event", "agent_session.acp.exec.auto_continue_exhausted",
					"provider", a.config.provider,
					"adapter", a.config.adapterName,
					"room_id", session.RoomID,
					"agent_session_id", session.AgentSessionID,
					"provider_session_id", session.ProviderSessionID,
					"turn_id", turnID,
					"attempts", autoContinueAttempts,
					"error_line", errLine,
				)
				break execLoop
			}
		}
		switch stopReason {
		case "canceled":
			terminalEvents := normalizer.FinishInterrupted(session, turnID, stopReason)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
				"stopReason": stopReason,
			}))
			emitEvents(terminalEvents)
		case "refusal", "max_tokens", "max_turn_requests":
			terminalEvents := normalizer.FinishFailed(session, turnID)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", map[string]any{
				"stopReason": stopReason,
			}))
			emitEvents(terminalEvents)
		default:
			terminalEvents := normalizer.FinishCompleted(session, turnID)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", map[string]any{
				"stopReason": firstNonEmpty(stopReason, "end_turn"),
			}))
			emitEvents(terminalEvents)
		}
		break execLoop
	}
	slog.Info("agent session ACP exec finished",
		"event", "agent_session.acp.exec.finished",
		"provider", a.config.provider,
		"adapter", a.config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"turn_id", turnID,
		"final_event_count", len(events),
		"final_event_type_counts", activityEventTypeCounts(events),
	)
	return events, nil
}

func (a *standardACPAdapter) Cancel(ctx context.Context, session Session, _ string) ([]activityshared.Event, error) {
	acpSession := a.getSession(session.AgentSessionID)
	if acpSession != nil && acpSession.client != nil {
		_ = acpSession.client.Notify(ctx, acpMethodCancel, map[string]any{
			"sessionId": acpSession.providerSessionID,
		})
	}
	a.rejectPendingApprovals(session.AgentSessionID, errPermissionRequestCanceled)
	return nil, nil
}

func (a *standardACPAdapter) submitPermissionOption(ctx context.Context, session Session, input PermissionOptionInput) (string, error) {
	requestID := strings.TrimSpace(input.RequestID)
	optionID := strings.TrimSpace(input.OptionID)
	if requestID == "" {
		return "", errors.New("permission request id is required")
	}
	if optionID == "" {
		return "", errors.New("permission option id is required")
	}
	pending := a.getPendingApproval(session.AgentSessionID, requestID)
	if pending == nil {
		return "", fmt.Errorf("%w: permission request %q", ErrInteractiveRequestNotLive, requestID)
	}
	if pending.callType != "approval" {
		return "", fmt.Errorf("request %q requires interactive submission", requestID)
	}
	resolvedOptionID, ok := pending.resolvePermissionOptionID(optionID)
	if !ok {
		return "", fmt.Errorf("permission option %q is not available for request %q", optionID, requestID)
	}
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case pending.response <- pendingInteractiveResponse{
		optionID: resolvedOptionID,
		result:   acpPermissionResponseResult(resolvedOptionID),
	}:
		return resolvedOptionID, nil
	default:
		return "", fmt.Errorf("%w: permission request %q", ErrInteractiveAlreadyAnswered, requestID)
	}
}

func (a *standardACPAdapter) SubmitInteractive(ctx context.Context, session Session, input SubmitInteractiveInput) (SubmitInteractiveResult, error) {
	requestID := strings.TrimSpace(input.RequestID)
	if requestID == "" {
		return SubmitInteractiveResult{}, errors.New("interactive request id is required")
	}
	pending := a.getPendingApproval(session.AgentSessionID, requestID)
	if pending == nil {
		return SubmitInteractiveResult{}, fmt.Errorf("%w: %q", ErrInteractiveRequestNotLive, requestID)
	}
	if pending.callType == "approval" {
		optionID := strings.TrimSpace(input.OptionID)
		if optionID == "" && input.Payload != nil {
			optionID = strings.TrimSpace(asString(input.Payload["optionId"]))
		}
		if optionID == "" {
			return SubmitInteractiveResult{}, errors.New("interactive option id is required")
		}
		resolvedOptionID, err := a.submitPermissionOption(ctx, session, PermissionOptionInput{
			RoomID:         input.RoomID,
			AgentSessionID: input.AgentSessionID,
			RequestID:      requestID,
			OptionID:       optionID,
		})
		if err != nil {
			return SubmitInteractiveResult{}, err
		}
		return SubmitInteractiveResult{
			AgentSessionID: session.AgentSessionID,
			RequestID:      requestID,
			Accepted:       true,
			OptionID:       resolvedOptionID,
		}, nil
	}
	optionID := strings.TrimSpace(input.OptionID)
	action := strings.TrimSpace(input.Action)
	payload := clonePayload(input.Payload)
	result := acpInteractiveResponseResult(action, optionID, payload)
	select {
	case <-ctx.Done():
		return SubmitInteractiveResult{}, ctx.Err()
	case pending.response <- pendingInteractiveResponse{
		optionID: optionID,
		action:   action,
		payload:  payload,
		result:   result,
	}:
	default:
		return SubmitInteractiveResult{}, fmt.Errorf("%w: %q", ErrInteractiveAlreadyAnswered, requestID)
	}
	return SubmitInteractiveResult{
		AgentSessionID: session.AgentSessionID,
		RequestID:      requestID,
		Accepted:       true,
	}, nil
}
