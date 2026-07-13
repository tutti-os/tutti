package agent

import (
	"context"
	"errors"
	"strings"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

var ErrSubmitDeliveryUnknown = errors.New("agent submit delivery is still being confirmed")

func clientSubmitID(metadata map[string]any) string {
	value, _ := metadata["clientSubmitId"].(string)
	return strings.TrimSpace(value)
}

func (s *Service) prepareSubmitClaim(ctx context.Context, workspaceID, agentSessionID string, metadata map[string]any) (agentactivitybiz.SubmitClaim, bool, error) {
	clientSubmitID := clientSubmitID(metadata)
	if s.SubmitClaimStore == nil || clientSubmitID == "" {
		return agentactivitybiz.SubmitClaim{}, false, nil
	}
	claim, created, err := s.SubmitClaimStore.PrepareSubmitClaim(ctx, agentactivitybiz.SubmitClaimPrepare{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
		ClientSubmitID: clientSubmitID, NowUnixMS: time.Now().UnixMilli(),
	})
	return claim, created, err
}

func (s *Service) abandonSubmitClaim(workspaceID, agentSessionID, clientSubmitID string) {
	if s.SubmitClaimStore == nil || strings.TrimSpace(clientSubmitID) == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = s.SubmitClaimStore.DeleteSubmitClaim(ctx, workspaceID, agentSessionID, clientSubmitID)
}

func (s *Service) acceptSubmitClaim(workspaceID, agentSessionID, clientSubmitID, turnID string) error {
	if s.SubmitClaimStore == nil || strings.TrimSpace(clientSubmitID) == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err := s.SubmitClaimStore.AcceptSubmitClaim(ctx, workspaceID, agentSessionID, clientSubmitID, turnID, time.Now().UnixMilli())
	return err
}

func turnLifecycleFromEntity(turn *agentactivitybiz.Turn) TurnLifecycle {
	if turn == nil {
		return TurnLifecycle{}
	}
	turnID := strings.TrimSpace(turn.TurnID)
	lifecycle := TurnLifecycle{Phase: turn.Phase}
	if turnID != "" && turn.Phase != agentactivitybiz.TurnPhaseSettled {
		lifecycle.ActiveTurnID = &turnID
	}
	if turn.Outcome != "" {
		outcome := turn.Outcome
		lifecycle.Outcome = &outcome
	}
	if turn.CompletedCommandKind != "" || turn.CompletedCommandStatus != "" {
		lifecycle.CompletedCommand = &CompletedCommand{Kind: turn.CompletedCommandKind, Status: turn.CompletedCommandStatus}
	}
	return lifecycle
}

func (s *Service) acceptedSubmitResult(ctx context.Context, workspaceID, agentSessionID string, claim agentactivitybiz.SubmitClaim) (SendInputResult, error) {
	session, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		return SendInputResult{}, err
	}
	var turn *agentactivitybiz.Turn
	if session.ActiveTurn != nil && session.ActiveTurn.TurnID == claim.TurnID {
		turn = session.ActiveTurn
	}
	if session.LatestTurn != nil && session.LatestTurn.TurnID == claim.TurnID {
		turn = session.LatestTurn
	}
	if turn == nil && s.TurnStore != nil {
		persisted, ok, err := s.TurnStore.GetTurn(ctx, workspaceID, agentSessionID, claim.TurnID)
		if err != nil {
			return SendInputResult{}, err
		}
		if ok {
			turn = &persisted
		}
	}
	if turn == nil {
		return SendInputResult{}, ErrSubmitDeliveryUnknown
	}
	availability := SubmitAvailability{State: "available"}
	if session.ActiveTurnID != "" {
		availability = SubmitAvailability{State: "blocked", Reason: "active_turn"}
	}
	return SendInputResult{Session: session, TurnID: claim.TurnID, TurnLifecycle: turnLifecycleFromEntity(turn), SubmitAvailability: availability}, nil
}
