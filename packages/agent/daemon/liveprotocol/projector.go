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

// Project rewrites only AgentGUI identity fields. Typed projection keeps
// arbitrary business payloads in json.RawMessage fields so numeric values and
// nested content are not coerced while the closed identities are rewritten.
func (p *RecipientProjector) Project(event Event) (Event, error) {
	if p == nil {
		return Event{}, fmt.Errorf("%w: nil projector", ErrInvalidLiveEvent)
	}
	if err := validateEvent(event); err != nil {
		return Event{}, err
	}
	if owner := strings.TrimSpace(p.context.OwnerWorkspaceID); owner != "" && event.WorkspaceID != owner {
		return Event{}, fmt.Errorf("%w: unexpected owner workspace", ErrInvalidLiveEvent)
	}
	if owner := strings.TrimSpace(p.context.OwnerAgentSessionID); owner != "" && event.AgentSessionID != owner {
		return Event{}, fmt.Errorf("%w: unexpected owner session", ErrInvalidLiveEvent)
	}
	raw, err := projectEventData(event, p.context)
	if err != nil {
		return Event{}, err
	}
	event.WorkspaceID = p.context.RecipientWorkspaceID
	event.AgentSessionID = p.context.RecipientAgentSessionID
	event.Data = raw
	if err := validateEvent(event); err != nil {
		return Event{}, err
	}
	return event, nil
}

func projectEventData(event Event, context ProjectionContext) ([]byte, error) {
	canonicalTurnIDs := context.canonicalTurnIDs()
	var data any
	switch event.EventType {
	case EventTypeRuntimeActivityUpdate:
		var value RuntimeActivityUpdateData
		if err := json.Unmarshal(event.Data, &value); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidLiveEvent, err)
		}
		value.WorkspaceID = projectedString(value.WorkspaceID, context.OwnerWorkspaceID, context.RecipientWorkspaceID)
		value.AgentSessionID = projectedString(value.AgentSessionID, context.OwnerAgentSessionID, context.RecipientAgentSessionID)
		data = value
	case EventTypeMessageDelta:
		var value MessageDeltaData
		if err := json.Unmarshal(event.Data, &value); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidLiveEvent, err)
		}
		if !canonicalTurnIDAllowed(value.TurnID, canonicalTurnIDs) {
			return nil, fmt.Errorf("%w: message delta Turn is not authorized", ErrInvalidLiveEvent)
		}
		value.WorkspaceID = projectedString(value.WorkspaceID, context.OwnerWorkspaceID, context.RecipientWorkspaceID)
		value.AgentSessionID = projectedString(value.AgentSessionID, context.OwnerAgentSessionID, context.RecipientAgentSessionID)
		value.TurnID = projectedCanonicalString(
			value.TurnID, canonicalTurnIDs, context.CallerTurnID,
		)
		data = value
	case EventTypeTurnUpdate:
		var value TurnUpdateData
		if err := json.Unmarshal(event.Data, &value); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidLiveEvent, err)
		}
		if !canonicalTurnIDAllowed(value.Turn.TurnID, canonicalTurnIDs) ||
			(value.ActiveTurnID != nil && !canonicalTurnIDAllowed(*value.ActiveTurnID, canonicalTurnIDs)) {
			return nil, fmt.Errorf("%w: turn update contains an unauthorized Turn", ErrInvalidLiveEvent)
		}
		value.WorkspaceID = projectedString(value.WorkspaceID, context.OwnerWorkspaceID, context.RecipientWorkspaceID)
		value.AgentSessionID = projectedString(value.AgentSessionID, context.OwnerAgentSessionID, context.RecipientAgentSessionID)
		value.ActiveTurnID = projectedCanonicalStringPointer(
			value.ActiveTurnID, canonicalTurnIDs, context.CallerTurnID,
		)
		value.Turn.AgentSessionID = projectedString(value.Turn.AgentSessionID, context.OwnerAgentSessionID, context.RecipientAgentSessionID)
		value.Turn.TurnID = projectedCanonicalString(
			value.Turn.TurnID, canonicalTurnIDs, context.CallerTurnID,
		)
		data = value
	case EventTypeInteractionUpdate:
		var value InteractionUpdateData
		if err := json.Unmarshal(event.Data, &value); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidLiveEvent, err)
		}
		if !canonicalTurnIDAllowed(value.Interaction.TurnID, canonicalTurnIDs) {
			return nil, fmt.Errorf("%w: interaction update contains an unauthorized Turn", ErrInvalidLiveEvent)
		}
		value.WorkspaceID = projectedString(value.WorkspaceID, context.OwnerWorkspaceID, context.RecipientWorkspaceID)
		value.AgentSessionID = projectedString(value.AgentSessionID, context.OwnerAgentSessionID, context.RecipientAgentSessionID)
		value.Interaction.AgentSessionID = projectedString(value.Interaction.AgentSessionID, context.OwnerAgentSessionID, context.RecipientAgentSessionID)
		value.Interaction.TurnID = projectedCanonicalString(value.Interaction.TurnID, canonicalTurnIDs, context.CallerTurnID)
		data = value
	case EventTypeInteractionSnapshot:
		var value InteractionSnapshotData
		if err := json.Unmarshal(event.Data, &value); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidLiveEvent, err)
		}
		if !canonicalTurnIDAllowed(value.RootTurnID, canonicalTurnIDs) {
			return nil, fmt.Errorf("%w: interaction snapshot root Turn is not authorized", ErrInvalidLiveEvent)
		}
		for _, interaction := range value.Interactions {
			if !canonicalTurnIDAllowed(interaction.TurnID, canonicalTurnIDs) {
				return nil, fmt.Errorf("%w: interaction snapshot contains an unauthorized Turn", ErrInvalidLiveEvent)
			}
		}
		value.WorkspaceID = projectedString(value.WorkspaceID, context.OwnerWorkspaceID, context.RecipientWorkspaceID)
		value.AgentSessionID = projectedString(value.AgentSessionID, context.OwnerAgentSessionID, context.RecipientAgentSessionID)
		value.RootTurnID = projectedCanonicalString(value.RootTurnID, canonicalTurnIDs, context.CallerTurnID)
		for index := range value.Interactions {
			interaction := &value.Interactions[index]
			interaction.AgentSessionID = projectedString(interaction.AgentSessionID, context.OwnerAgentSessionID, context.RecipientAgentSessionID)
			interaction.TurnID = projectedCanonicalString(interaction.TurnID, canonicalTurnIDs, context.CallerTurnID)
		}
		data = value
	case EventTypeSessionAudit:
		var value SessionAuditData
		if err := json.Unmarshal(event.Data, &value); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidLiveEvent, err)
		}
		value.WorkspaceID = projectedString(value.WorkspaceID, context.OwnerWorkspaceID, context.RecipientWorkspaceID)
		value.AgentSessionID = projectedString(value.AgentSessionID, context.OwnerAgentSessionID, context.RecipientAgentSessionID)
		data = value
	default:
		return nil, fmt.Errorf("%w: unsupported event type %q", ErrInvalidLiveEvent, event.EventType)
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidLiveEvent, err)
	}
	return raw, nil
}

func projectedString(current, expected, replacement string) string {
	if replacement == "" || (expected != "" && current != expected) {
		return current
	}
	return replacement
}

func (context ProjectionContext) canonicalTurnIDs() []string {
	if len(context.CanonicalTurnIDs) > 0 {
		return context.CanonicalTurnIDs
	}
	if strings.TrimSpace(context.CanonicalTurnID) == "" {
		return nil
	}
	return []string{context.CanonicalTurnID}
}

func projectedCanonicalString(current string, expected []string, replacement string) string {
	if replacement == "" {
		return current
	}
	for _, candidate := range expected {
		if candidate != "" && current == candidate {
			return replacement
		}
	}
	return current
}

func projectedCanonicalStringPointer(current *string, expected []string, replacement string) *string {
	if current == nil {
		return nil
	}
	projected := projectedCanonicalString(*current, expected, replacement)
	if projected == *current {
		return current
	}
	return &projected
}

func canonicalTurnIDAllowed(turnID string, expected []string) bool {
	turnID = strings.TrimSpace(turnID)
	if turnID == "" {
		return false
	}
	for _, candidate := range expected {
		if strings.TrimSpace(candidate) == turnID {
			return true
		}
	}
	return false
}
