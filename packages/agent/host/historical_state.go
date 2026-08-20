package agenthost

import (
	"context"
	"errors"
	"fmt"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

var (
	ErrHistoricalStateUnavailable = errors.New("historical Agent state is unavailable")
	ErrHistoricalStateConflict    = storesqlite.ErrHistoricalStateConflict
)

type HistoricalSessionGraph = storesqlite.HistoricalSessionGraph
type HistoricalSessionGraphRestoreInput = storesqlite.HistoricalSessionGraphRestoreInput
type HistoricalSession = storesqlite.HistoricalSession
type HistoricalTurn = storesqlite.HistoricalTurn
type HistoricalMessage = storesqlite.HistoricalMessage
type HistoricalInteraction = storesqlite.HistoricalInteraction
type HistoricalGoal = storesqlite.HistoricalGoal

func (h *Host) CaptureHistoricalSessionGraph(
	ctx context.Context,
	ref SessionRef,
) (HistoricalSessionGraph, error) {
	if h == nil || h.historicalState == nil {
		return HistoricalSessionGraph{}, ErrHistoricalStateUnavailable
	}
	if strings.TrimSpace(ref.WorkspaceID) == "" ||
		strings.TrimSpace(ref.AgentSessionID) == "" {
		return HistoricalSessionGraph{}, ErrInvalidArgument
	}
	graph, err := h.historicalState.CaptureHistoricalSessionGraph(
		ctx,
		strings.TrimSpace(ref.WorkspaceID),
		strings.TrimSpace(ref.AgentSessionID),
	)
	if err != nil {
		return HistoricalSessionGraph{}, err
	}
	if err := ValidateHistoricalSessionGraph(graph); err != nil {
		return HistoricalSessionGraph{}, err
	}
	return graph, nil
}

// RestoreHistoricalSessionGraph imports settled canonical history without
// starting or resuming a Provider. Callers invoke it for a fresh isolated
// Replay Workspace before Host recovery.
func (h *Host) RestoreHistoricalSessionGraph(
	ctx context.Context,
	input HistoricalSessionGraphRestoreInput,
) error {
	if h == nil || h.historicalState == nil {
		return ErrHistoricalStateUnavailable
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.UserID = strings.TrimSpace(input.UserID)
	if input.WorkspaceID == "" || input.UserID == "" {
		return ErrInvalidArgument
	}
	if err := ValidateHistoricalSessionGraph(input.Graph); err != nil {
		return err
	}
	return h.historicalState.RestoreHistoricalSessionGraph(ctx, input)
}

func ValidateHistoricalSessionGraph(graph HistoricalSessionGraph) error {
	rootID := strings.TrimSpace(graph.RootSessionID)
	if rootID == "" || len(graph.Sessions) == 0 {
		return ErrInvalidArgument
	}
	sessions := make(map[string]HistoricalSession, len(graph.Sessions))
	for _, session := range graph.Sessions {
		sessionID := strings.TrimSpace(session.ID)
		if sessionID == "" ||
			(session.Kind != "root" && session.Kind != "child") ||
			strings.TrimSpace(session.AgentTargetID) == "" ||
			strings.TrimSpace(session.Provider) == "" ||
			strings.TrimSpace(session.ProviderSessionID) == "" {
			return ErrInvalidArgument
		}
		if session.ActiveTurnID != "" ||
			(session.Goal != nil && session.Goal.PendingOperationID != "") {
			return fmt.Errorf(
				"%w: Session %q history is not settled",
				ErrHistoricalStateConflict,
				sessionID,
			)
		}
		if _, exists := sessions[sessionID]; exists {
			return fmt.Errorf("%w: duplicate Session %q", ErrHistoricalStateConflict, sessionID)
		}
		turns := make(map[string]struct{}, len(session.Turns))
		turnAnchors := make(map[string]string, len(session.Turns))
		for _, turn := range session.Turns {
			turnID := strings.TrimSpace(turn.ID)
			if turnID == "" {
				return ErrInvalidArgument
			}
			if _, exists := turns[turnID]; exists {
				return fmt.Errorf("%w: duplicate Turn %q", ErrHistoricalStateConflict, turnID)
			}
			turns[turnID] = struct{}{}
			turnAnchors[turnID] = strings.TrimSpace(turn.IdentityAnchorTurnID)
		}
		for _, turn := range session.Turns {
			anchorTurnID := strings.TrimSpace(turn.IdentityAnchorTurnID)
			if anchorTurnID == "" {
				continue
			}
			if anchorTurnID == strings.TrimSpace(turn.ID) {
				return fmt.Errorf("%w: Turn %q anchors itself", ErrHistoricalStateConflict, turn.ID)
			}
			if _, exists := turns[anchorTurnID]; !exists {
				return fmt.Errorf(
					"%w: Turn %q references missing identity anchor %q",
					ErrHistoricalStateConflict,
					turn.ID,
					anchorTurnID,
				)
			}
			if turnAnchors[anchorTurnID] != "" {
				return fmt.Errorf(
					"%w: Turn %q identity anchor %q is not ultimate",
					ErrHistoricalStateConflict,
					turn.ID,
					anchorTurnID,
				)
			}
		}
		for _, message := range session.Messages {
			if strings.TrimSpace(message.ID) == "" {
				return ErrInvalidArgument
			}
			if message.TurnID != "" {
				if _, exists := turns[message.TurnID]; !exists {
					return fmt.Errorf(
						"%w: Message %q references missing Turn %q",
						ErrHistoricalStateConflict,
						message.ID,
						message.TurnID,
					)
				}
			}
		}
		sessions[sessionID] = session
	}
	root, exists := sessions[rootID]
	if !exists || (root.Kind != "" && root.Kind != "root") {
		return fmt.Errorf("%w: root Session %q is missing", ErrHistoricalStateConflict, rootID)
	}
	for sessionID, session := range sessions {
		if sessionID == rootID {
			continue
		}
		if session.RootSessionID != rootID ||
			session.ParentSessionID == "" {
			return fmt.Errorf(
				"%w: child Session %q is outside root %q",
				ErrHistoricalStateConflict,
				sessionID,
				rootID,
			)
		}
		if _, exists := sessions[session.ParentSessionID]; !exists {
			return fmt.Errorf(
				"%w: child Session %q references missing parent %q",
				ErrHistoricalStateConflict,
				sessionID,
				session.ParentSessionID,
			)
		}
	}
	return nil
}
