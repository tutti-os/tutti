package liveprotocol

import (
	"encoding/json"
	"fmt"
	"strings"
)

type RecipientProjector struct {
	context ProjectionContext
}

func NewRecipientProjector(context ProjectionContext) (*RecipientProjector, error) {
	if strings.TrimSpace(context.RecipientWorkspaceID) == "" ||
		strings.TrimSpace(context.RecipientAgentSessionID) == "" {
		return nil, fmt.Errorf("%w: recipient projection identity", ErrInvalidLiveEvent)
	}
	return &RecipientProjector{context: context}, nil
}

// Project rewrites only AgentGUI identity fields. Business payload, paths and
// arbitrary nested content remain byte-for-byte equivalent after JSON
// round-tripping; no transport policy leaks into renderer state.
func (p *RecipientProjector) Project(event Event) (Event, error) {
	if p == nil {
		return Event{}, fmt.Errorf("%w: nil projector", ErrInvalidLiveEvent)
	}
	if owner := strings.TrimSpace(p.context.OwnerWorkspaceID); owner != "" && event.WorkspaceID != owner {
		return Event{}, fmt.Errorf("%w: unexpected owner workspace", ErrInvalidLiveEvent)
	}
	if owner := strings.TrimSpace(p.context.OwnerAgentSessionID); owner != "" && event.AgentSessionID != owner {
		return Event{}, fmt.Errorf("%w: unexpected owner session", ErrInvalidLiveEvent)
	}
	var data map[string]any
	if err := json.Unmarshal(event.Data, &data); err != nil {
		return Event{}, fmt.Errorf("%w: %v", ErrInvalidLiveEvent, err)
	}
	rewriteClosedEventIdentity(event.EventType, data, p.context)
	event.WorkspaceID = p.context.RecipientWorkspaceID
	event.AgentSessionID = p.context.RecipientAgentSessionID
	raw, err := json.Marshal(data)
	if err != nil {
		return Event{}, fmt.Errorf("%w: %v", ErrInvalidLiveEvent, err)
	}
	event.Data = raw
	if err := validateEvent(event); err != nil {
		return Event{}, err
	}
	return event, nil
}

func rewriteClosedEventIdentity(eventType EventType, data map[string]any, context ProjectionContext) {
	rewriteDirectIdentity(data, context)
	rewriteTurn := func(record map[string]any) {
		rewriteDirectIdentity(record, context)
		rewriteExactString(record, "turnId", context.CanonicalTurnID, context.CallerTurnID)
	}
	switch eventType {
	case EventTypeMessageDelta:
		rewriteExactString(data, "turnId", context.CanonicalTurnID, context.CallerTurnID)
	case EventTypeTurnUpdate:
		rewriteExactString(data, "activeTurnId", context.CanonicalTurnID, context.CallerTurnID)
		if turn, ok := data["turn"].(map[string]any); ok {
			rewriteTurn(turn)
		}
	case EventTypeInteractionUpdate:
		if interaction, ok := data["interaction"].(map[string]any); ok {
			rewriteTurn(interaction)
			// Turn-scoped provider requests may use the canonical turn identity
			// itself. Only that exact identity is projected.
			rewriteExactString(interaction, "requestId", context.CanonicalTurnID, context.CallerTurnID)
		}
	case EventTypeSessionAudit:
		// Audit payload is business content; only direct data identity is
		// projected.
	}
}

func rewriteDirectIdentity(record map[string]any, context ProjectionContext) {
	rewriteExactString(record, "workspaceId", context.OwnerWorkspaceID, context.RecipientWorkspaceID)
	rewriteExactString(record, "agentSessionId", context.OwnerAgentSessionID, context.RecipientAgentSessionID)
}

func rewriteExactString(record map[string]any, key, expected, replacement string) {
	if replacement == "" {
		return
	}
	current, ok := record[key].(string)
	if !ok || (expected != "" && current != expected) {
		return
	}
	record[key] = replacement
}
