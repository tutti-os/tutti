package agentcontext

import (
	"context"
	"fmt"
	"strings"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

const (
	getViewSession              = "session"
	getViewConversation         = "conversation"
	getViewTrace                = "trace"
	defaultConversationTurns    = 3
	defaultConversationMessages = 100
	defaultTraceMessages        = 20
)

type sessionGetResult struct {
	View           string
	Session        agentservice.Session
	Turns          []sessionGetTurnResult
	Trace          *sessionGetTraceResult
	HasMoreTurns   bool
	ImageLocalPath imageLocalPathResolver
}

type sessionGetTurnResult struct {
	Turn            agentactivitybiz.Turn
	Messages        []agentservice.SessionMessage
	FinalMessage    *agentservice.SessionMessage
	HasMoreMessages bool
}

type sessionGetTraceResult struct {
	Turn agentactivitybiz.Turn
	Page agentservice.SessionMessagesPage
}

func (p Provider) getSessionContext(ctx context.Context, workspaceID string, input getSessionInput) (any, error) {
	if err := p.requireSessions(); err != nil {
		return nil, err
	}
	view, err := validateGetSessionInput(input)
	if err != nil {
		return nil, err
	}
	if view == getViewSession {
		session, err := p.sessions.Get(ctx, workspaceID, input.SessionID)
		if err != nil {
			return nil, err
		}
		return sessionGetResult{View: view, Session: session}, nil
	}

	session, err := p.sessions.Get(ctx, workspaceID, input.SessionID)
	if err != nil {
		return nil, err
	}
	allTurns, err := p.sessions.ListTurns(ctx, workspaceID, input.SessionID)
	if err != nil {
		return nil, err
	}
	result := sessionGetResult{
		View:           view,
		Session:        session,
		ImageLocalPath: p.imageLocalPathResolver(ctx, workspaceID),
	}
	if view == getViewTrace {
		trace, err := p.getSessionTrace(ctx, workspaceID, input, allTurns)
		if err != nil {
			return nil, err
		}
		result.Trace = &trace
		return result, nil
	}

	turns, hasMore, err := p.getSessionConversation(ctx, workspaceID, input, allTurns)
	if err != nil {
		return nil, err
	}
	result.Turns = turns
	result.HasMoreTurns = hasMore
	return result, nil
}

func validateGetSessionInput(input getSessionInput) (string, error) {
	view := strings.TrimSpace(input.View)
	if view == "" {
		view = getViewConversation
	}
	turnID := strings.TrimSpace(input.TurnID)
	switch view {
	case getViewSession:
		if input.Turns != nil || turnID != "" || input.Messages != nil || input.BeforeVersion > 0 {
			return "", fmt.Errorf("%w: --view session does not accept turn or message selectors", cliservice.ErrInvalidInput)
		}
	case getViewConversation:
		if turnID != "" && input.Turns != nil {
			return "", fmt.Errorf("%w: --turn-id and --turns are mutually exclusive", cliservice.ErrInvalidInput)
		}
		if input.Messages != nil || input.BeforeVersion > 0 {
			return "", fmt.Errorf("%w: --messages and --before-version require --view trace", cliservice.ErrInvalidInput)
		}
	case getViewTrace:
		if turnID == "" {
			return "", fmt.Errorf("%w: --view trace requires --turn-id", cliservice.ErrInvalidInput)
		}
		if input.Turns != nil {
			return "", fmt.Errorf("%w: --turns is not supported with --view trace", cliservice.ErrInvalidInput)
		}
	default:
		return "", fmt.Errorf("%w: unsupported view %q", cliservice.ErrInvalidInput, view)
	}
	return view, nil
}

func (p Provider) getSessionConversation(
	ctx context.Context,
	workspaceID string,
	input getSessionInput,
	allTurns []agentactivitybiz.Turn,
) ([]sessionGetTurnResult, bool, error) {
	selected, hasMore, err := selectConversationTurns(allTurns, input)
	if err != nil {
		return nil, false, err
	}
	results := make([]sessionGetTurnResult, 0, len(selected))
	for _, turn := range selected {
		page, err := p.sessions.ListMessages(ctx, workspaceID, input.SessionID, agentservice.ListMessagesInput{
			TurnID: turn.TurnID,
			Limit:  defaultConversationMessages,
			Order:  agentactivitybiz.MessageOrderDesc,
		})
		if err != nil {
			return nil, false, err
		}
		reverseSessionGetMessages(page.Messages)
		messages, final := conversationMessages(page.Messages, turn.FinalAssistantMessageID)
		if final == nil && strings.TrimSpace(turn.FinalAssistantMessageID) != "" {
			resolved, err := p.sessions.ListMessages(ctx, workspaceID, input.SessionID, agentservice.ListMessagesInput{
				MessageID: turn.FinalAssistantMessageID,
				Limit:     1,
				Order:     agentactivitybiz.MessageOrderDesc,
			})
			if err != nil {
				return nil, false, err
			}
			if len(resolved.Messages) == 1 && isConversationMessage(resolved.Messages[0]) {
				message := resolved.Messages[0]
				final = &message
			}
		}
		results = append(results, sessionGetTurnResult{
			Turn: turn, Messages: messages, FinalMessage: final, HasMoreMessages: page.HasMore,
		})
	}
	return results, hasMore, nil
}

func selectConversationTurns(allTurns []agentactivitybiz.Turn, input getSessionInput) ([]agentactivitybiz.Turn, bool, error) {
	turnID := strings.TrimSpace(input.TurnID)
	if turnID != "" {
		for _, turn := range allTurns {
			if strings.TrimSpace(turn.TurnID) == turnID {
				return []agentactivitybiz.Turn{turn}, false, nil
			}
		}
		return nil, false, fmt.Errorf("%w: turn %q was not found in session", cliservice.ErrInvalidInput, turnID)
	}
	limit := defaultConversationTurns
	if input.Turns != nil {
		limit = int(*input.Turns)
	}
	selected := make([]agentactivitybiz.Turn, 0, min(limit, len(allTurns)))
	for index := len(allTurns) - 1; index >= 0 && len(selected) < limit; index-- {
		selected = append(selected, allTurns[index])
	}
	return selected, len(allTurns) > len(selected), nil
}

func (p Provider) getSessionTrace(
	ctx context.Context,
	workspaceID string,
	input getSessionInput,
	turns []agentactivitybiz.Turn,
) (sessionGetTraceResult, error) {
	turnID := strings.TrimSpace(input.TurnID)
	turn, ok := findSessionGetTurn(turns, turnID)
	if !ok {
		return sessionGetTraceResult{}, fmt.Errorf("%w: turn %q was not found in session", cliservice.ErrInvalidInput, turnID)
	}
	limit := defaultTraceMessages
	if input.Messages != nil {
		limit = int(*input.Messages)
	}
	page, err := p.sessions.ListMessages(ctx, workspaceID, input.SessionID, agentservice.ListMessagesInput{
		TurnID:        turnID,
		BeforeVersion: uint64(input.BeforeVersion),
		Limit:         limit,
		Order:         agentactivitybiz.MessageOrderDesc,
	})
	if err != nil {
		return sessionGetTraceResult{}, err
	}
	reverseSessionGetMessages(page.Messages)
	return sessionGetTraceResult{Turn: turn, Page: page}, nil
}

func findSessionGetTurn(turns []agentactivitybiz.Turn, turnID string) (agentactivitybiz.Turn, bool) {
	for _, turn := range turns {
		if strings.TrimSpace(turn.TurnID) == turnID {
			return turn, true
		}
	}
	return agentactivitybiz.Turn{}, false
}

func conversationMessages(
	messages []agentservice.SessionMessage,
	finalMessageID string,
) ([]agentservice.SessionMessage, *agentservice.SessionMessage) {
	values := make([]agentservice.SessionMessage, 0, len(messages))
	var final *agentservice.SessionMessage
	finalMessageID = strings.TrimSpace(finalMessageID)
	for _, message := range messages {
		if !isConversationMessage(message) {
			continue
		}
		if finalMessageID != "" && strings.TrimSpace(message.MessageID) == finalMessageID {
			copy := message
			final = &copy
			continue
		}
		values = append(values, message)
	}
	return values, final
}

func isConversationMessage(message agentservice.SessionMessage) bool {
	role := strings.TrimSpace(message.Role)
	if role != "user" && role != "assistant" {
		return false
	}
	if strings.TrimSpace(message.Kind) == "text" {
		return true
	}
	return role == "assistant" && message.Semantics != nil && message.Semantics.UserVisibleAssistantResponse
}

func reverseSessionGetMessages(messages []agentservice.SessionMessage) {
	for left, right := 0, len(messages)-1; left < right; left, right = left+1, right-1 {
		messages[left], messages[right] = messages[right], messages[left]
	}
}

func sessionGetJSONValue(result any) map[string]any {
	got := result.(sessionGetResult)
	value := map[string]any{
		"view":    got.View,
		"session": sessionInspectValue(got.Session),
	}
	switch got.View {
	case getViewConversation:
		value["turns"] = sessionGetTurnValues(got.Turns, got.ImageLocalPath)
		value["hasMoreTurns"] = got.HasMoreTurns
	case getViewTrace:
		trace := got.Trace
		value["turn"] = sessionGetTraceTurnValue(trace.Turn)
		value["messages"] = messageTraceValues(trace.Page.Messages, got.ImageLocalPath)
		value["latestVersion"] = trace.Page.LatestVersion
		value["hasMoreMessages"] = trace.Page.HasMore
	}
	return value
}

func sessionGetTurnValues(turns []sessionGetTurnResult, imageLocalPath imageLocalPathResolver) []any {
	values := make([]any, 0, len(turns))
	for _, turn := range turns {
		value := sessionGetTraceTurnValue(turn.Turn)
		value["messages"] = messageCompactValues(turn.Messages, imageLocalPath)
		value["finalMessage"] = nil
		if turn.FinalMessage != nil {
			value["finalMessage"] = messageCompactValue(*turn.FinalMessage, imageLocalPath)
		}
		value["hasMoreMessages"] = turn.HasMoreMessages
		values = append(values, value)
	}
	return values
}

func sessionGetTraceTurnValue(turn agentactivitybiz.Turn) map[string]any {
	value := turnCompactValue(turn)
	if origin := strings.TrimSpace(turn.Origin); origin != "" {
		value["origin"] = origin
	}
	if turn.StartedAtUnixMS > 0 {
		value["startedAtUnixMs"] = turn.StartedAtUnixMS
	}
	if turn.SettledAtUnixMS > 0 {
		value["settledAtUnixMs"] = turn.SettledAtUnixMS
	}
	return value
}

func messageTraceValues(messages []agentservice.SessionMessage, imageLocalPath imageLocalPathResolver) []any {
	values := make([]any, 0, len(messages))
	for _, message := range messages {
		value := messageCompactValue(message, imageLocalPath)
		if len(message.Payload) > 0 {
			value["payload"] = message.Payload
		}
		if message.Semantics != nil {
			value["semantics"] = message.Semantics
		}
		if message.StartedAtUnixMS > 0 {
			value["startedAtUnixMs"] = message.StartedAtUnixMS
		}
		if message.CompletedAtUnixMS > 0 {
			value["completedAtUnixMs"] = message.CompletedAtUnixMS
		}
		values = append(values, value)
	}
	return values
}
