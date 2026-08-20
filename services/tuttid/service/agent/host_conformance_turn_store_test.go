package agent

import (
	"context"
	"fmt"
	"sort"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type legacyHostConformanceTurnStore struct {
	sessions     map[string]agentactivitybiz.Session
	turns        map[string]agentactivitybiz.Turn
	interactions map[string][]agentactivitybiz.Interaction
}

func (s *legacyHostConformanceTurnStore) bindTurnIdentityAnchor(
	workspaceID string,
	sessionID string,
	turnID string,
	anchorTurnID string,
) error {
	turnKey := sessionID + ":" + turnID
	turn, turnFound := s.turns[turnKey]
	anchor, anchorFound := s.turns[sessionID+":"+anchorTurnID]
	if !turnFound || !anchorFound ||
		turn.WorkspaceID != workspaceID || anchor.WorkspaceID != workspaceID ||
		turn.AgentSessionID != sessionID || anchor.AgentSessionID != sessionID {
		return fmt.Errorf("bind turn identity anchor: turn or anchor not found")
	}
	if anchor.IdentityAnchorTurnID != "" ||
		(turn.IdentityAnchorTurnID != "" && turn.IdentityAnchorTurnID != anchorTurnID) {
		return agentactivitybiz.ErrTurnIdentityAnchorConflict
	}
	turn.IdentityAnchorTurnID = anchorTurnID
	s.turns[turnKey] = turn
	return nil
}

func (s *legacyHostConformanceTurnStore) GetLatestTurn(_ context.Context, _ string, sessionID string) (agentactivitybiz.Turn, bool, error) {
	for _, turn := range s.turns {
		if turn.AgentSessionID == sessionID {
			return turn, true, nil
		}
	}
	return agentactivitybiz.Turn{}, false, nil
}

func (s *legacyHostConformanceTurnStore) GetTurn(_ context.Context, _ string, sessionID, turnID string) (agentactivitybiz.Turn, bool, error) {
	turn, ok := s.turns[sessionID+":"+turnID]
	return turn, ok, nil
}

func (s *legacyHostConformanceTurnStore) GetSession(_ context.Context, _ string, sessionID string) (agentactivitybiz.Session, bool, error) {
	session, ok := s.sessions[sessionID]
	return session, ok, nil
}

func (s *legacyHostConformanceTurnStore) ListSessionTurns(_ context.Context, _ string, sessionID string) ([]agentactivitybiz.Turn, error) {
	result := make([]agentactivitybiz.Turn, 0)
	for _, turn := range s.turns {
		if turn.AgentSessionID == sessionID {
			result = append(result, turn)
		}
	}
	return result, nil
}

func (s *legacyHostConformanceTurnStore) ListEffectiveSessionTurns(ctx context.Context, workspaceID string, sessionID string) ([]agentactivitybiz.Turn, error) {
	return s.ListSessionTurns(ctx, workspaceID, sessionID)
}

func (s *legacyHostConformanceTurnStore) ListSessionTurnSummaries(_ context.Context, input agentactivitybiz.ListSessionTurnSummariesInput) (agentactivitybiz.SessionTurnSummaryPage, error) {
	turns := make([]agentactivitybiz.SessionTurnSummary, 0)
	for _, turn := range s.turns {
		if turn.WorkspaceID != input.WorkspaceID || turn.AgentSessionID != input.AgentSessionID {
			continue
		}
		turns = append(turns, agentactivitybiz.SessionTurnSummary{
			TurnID: turn.TurnID, Phase: turn.Phase, Outcome: turn.Outcome,
			FinalAssistantMessageID: turn.FinalAssistantMessageID,
			StartedAtUnixMS:         turn.StartedAtUnixMS, SettledAtUnixMS: turn.SettledAtUnixMS, Origin: turn.Origin,
		})
	}
	sort.Slice(turns, func(left, right int) bool {
		if turns[left].StartedAtUnixMS != turns[right].StartedAtUnixMS {
			return turns[left].StartedAtUnixMS > turns[right].StartedAtUnixMS
		}
		return turns[left].TurnID > turns[right].TurnID
	})
	if input.Before != nil {
		filtered := turns[:0]
		for _, turn := range turns {
			if turn.StartedAtUnixMS < input.Before.StartedAtUnixMS ||
				(turn.StartedAtUnixMS == input.Before.StartedAtUnixMS && turn.TurnID < input.Before.TurnID) {
				filtered = append(filtered, turn)
			}
		}
		turns = filtered
	}
	hasMore := len(turns) > input.Limit
	if hasMore {
		turns = turns[:input.Limit]
	}
	return agentactivitybiz.SessionTurnSummaryPage{Turns: turns, HasMore: hasMore}, nil
}

func (s *legacyHostConformanceTurnStore) ListSessionInteractions(_ context.Context, input agentactivitybiz.ListSessionInteractionsInput) ([]agentactivitybiz.Interaction, error) {
	result := make([]agentactivitybiz.Interaction, 0, len(s.interactions[input.AgentSessionID]))
	for _, interaction := range s.interactions[input.AgentSessionID] {
		if input.TurnID != "" && interaction.TurnID != input.TurnID {
			continue
		}
		if input.RequestID != "" && interaction.RequestID != input.RequestID {
			continue
		}
		result = append(result, interaction)
	}
	return result, nil
}

func (s *legacyHostConformanceTurnStore) interaction(sessionID, turnID, requestID string) (agentactivitybiz.Interaction, bool) {
	for _, interaction := range s.interactions[sessionID] {
		if interaction.TurnID == turnID && interaction.RequestID == requestID {
			return interaction, true
		}
	}
	return agentactivitybiz.Interaction{}, false
}

func (s *legacyHostConformanceTurnStore) storeInteraction(updated agentactivitybiz.Interaction) {
	interactions := s.interactions[updated.AgentSessionID]
	for index, interaction := range interactions {
		if interaction.TurnID == updated.TurnID && interaction.RequestID == updated.RequestID {
			interactions[index] = updated
			s.interactions[updated.AgentSessionID] = interactions
			return
		}
	}
	s.interactions[updated.AgentSessionID] = append(interactions, updated)
}

func (s *legacyHostConformanceTurnStore) ListLatestTurns(_ context.Context, _ string, sessionIDs []string) (map[string]agentactivitybiz.Turn, error) {
	result := map[string]agentactivitybiz.Turn{}
	for _, sessionID := range sessionIDs {
		if turn, ok, _ := s.GetLatestTurn(context.Background(), "", sessionID); ok {
			result[sessionID] = turn
		}
	}
	return result, nil
}

func (s *legacyHostConformanceTurnStore) ListLatestTurnInteractions(_ context.Context, _ string, sessionIDs []string) (map[string][]agentactivitybiz.Interaction, error) {
	result := map[string][]agentactivitybiz.Interaction{}
	for _, sessionID := range sessionIDs {
		result[sessionID] = append([]agentactivitybiz.Interaction(nil), s.interactions[sessionID]...)
	}
	return result, nil
}

func (s *legacyHostConformanceTurnStore) ListTurnsBySession(_ context.Context, _ string, activeTurnIDs map[string]string) (map[string]agentactivitybiz.Turn, error) {
	result := map[string]agentactivitybiz.Turn{}
	for sessionID, turnID := range activeTurnIDs {
		if turn, ok := s.turns[sessionID+":"+turnID]; ok {
			result[sessionID] = turn
		}
	}
	return result, nil
}

func (s *legacyHostConformanceTurnStore) ListPendingInteractionsBySession(_ context.Context, _ string, sessionIDs []string) (map[string][]agentactivitybiz.Interaction, error) {
	result := map[string][]agentactivitybiz.Interaction{}
	for _, sessionID := range sessionIDs {
		result[sessionID] = append([]agentactivitybiz.Interaction(nil), s.interactions[sessionID]...)
	}
	return result, nil
}
