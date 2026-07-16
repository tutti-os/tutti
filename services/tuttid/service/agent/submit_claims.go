package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

var (
	ErrSubmitDeliveryUnknown          = errors.New("agent submit delivery is still being confirmed")
	ErrSubmitRejectedBeforeAcceptance = errors.New("agent submit was rejected before acceptance")
)

func (s *Service) canonicalTurnIDForSubmit(ctx context.Context, workspaceID, agentSessionID string, guidance bool) (string, error) {
	if !guidance {
		return uuid.NewString(), nil
	}
	if runtimeSession, ok := s.controller().Session(workspaceID, agentSessionID); ok {
		if turnID := activeRuntimeTurnID(runtimeSession); turnID != "" {
			return turnID, nil
		}
	}
	turnID, err := s.persistedActiveTurnID(ctx, workspaceID, agentSessionID)
	if err != nil {
		return "", err
	}
	if turnID == "" {
		return "", ErrSessionNoActiveTurn
	}
	return turnID, nil
}

func (s *Service) prepareSubmitClaimForDispatch(ctx context.Context, workspaceID, agentSessionID string, guidance bool, clientSubmitID string) (string, agentactivitybiz.SubmitClaim, bool, error) {
	clientID := strings.TrimSpace(clientSubmitID)
	if s.SubmitClaimStore != nil && clientID != "" {
		existing, found, err := s.SubmitClaimStore.GetSubmitClaim(ctx, workspaceID, agentSessionID, clientID)
		if err != nil {
			return "", agentactivitybiz.SubmitClaim{}, false, err
		}
		if found {
			return strings.TrimSpace(existing.CanonicalTurnID), existing, false, nil
		}
	}
	canonicalTurnID, err := s.canonicalTurnIDForSubmit(ctx, workspaceID, agentSessionID, guidance)
	if err != nil {
		return "", agentactivitybiz.SubmitClaim{}, false, err
	}
	claim, created, err := s.prepareSubmitClaim(ctx, workspaceID, agentSessionID, canonicalTurnID, clientID)
	if err != nil {
		return "", agentactivitybiz.SubmitClaim{}, false, err
	}
	if claim.CanonicalTurnID != "" {
		canonicalTurnID = claim.CanonicalTurnID
	}
	return canonicalTurnID, claim, created, nil
}

func (s *Service) prepareSubmitClaim(ctx context.Context, workspaceID, agentSessionID, canonicalTurnID string, clientSubmitID string) (agentactivitybiz.SubmitClaim, bool, error) {
	clientSubmitID = strings.TrimSpace(clientSubmitID)
	if s.SubmitClaimStore == nil || clientSubmitID == "" {
		return agentactivitybiz.SubmitClaim{}, false, nil
	}
	claim, created, err := s.SubmitClaimStore.PrepareSubmitClaim(ctx, agentactivitybiz.SubmitClaimPrepare{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
		ClientSubmitID: clientSubmitID, CanonicalTurnID: strings.TrimSpace(canonicalTurnID),
		NowUnixMS: time.Now().UnixMilli(),
	})
	return claim, created, err
}

// execAndDurablyReportSubmitProvenance owns the accepted-submit sequence at
// the service layer. Runtime Exec may start provider work; only the required
// provenance barrier makes that exact client submit safe to acknowledge.
func (s *Service) execAndDurablyReportSubmitProvenance(
	ctx context.Context,
	input RuntimeExecInput,
) (RuntimeExecResult, error) {
	result, err := s.controller().Exec(ctx, input)
	if err != nil || !result.Accepted {
		return result, err
	}
	if strings.TrimSpace(result.TurnID) != strings.TrimSpace(input.TurnID) {
		return result, ErrSubmitDeliveryUnknown
	}
	if strings.TrimSpace(input.ClientSubmitID) == "" {
		return result, nil
	}
	if err := s.controller().DurablyReportSubmitProvenance(ctx, RuntimeSubmitProvenanceInput{
		WorkspaceID:    input.WorkspaceID,
		AgentSessionID: input.AgentSessionID,
		TurnID:         result.TurnID,
		ClientSubmitID: strings.TrimSpace(input.ClientSubmitID),
		Content:        append([]PromptContentBlock(nil), input.Content...),
		DisplayPrompt:  input.DisplayPrompt,
		Guidance:       input.Guidance,
	}); err != nil {
		return result, deliveryUnknownError(err)
	}
	return result, nil
}

// reconcilePreparedSubmitClaim only trusts durable per-submit provenance. The
// turn itself (or an accepted Tutti snapshot) is insufficient for guidance,
// because multiple client submissions may legitimately target one active turn.
func (s *Service) reconcilePreparedSubmitClaim(ctx context.Context, workspaceID, agentSessionID string, claim agentactivitybiz.SubmitClaim) (bool, error) {
	if s.SubmitClaimStore == nil || strings.TrimSpace(claim.ClientSubmitID) == "" || claim.Status != "prepared" {
		return false, nil
	}
	canonicalTurnID := strings.TrimSpace(claim.CanonicalTurnID)
	if canonicalTurnID == "" {
		// Legacy prepared claims have no immutable dispatch identity. They must
		// remain unknown forever rather than risk a duplicate provider submit.
		return false, nil
	}
	evidenceTurnID, found, err := s.SubmitClaimStore.FindTurnByClientSubmitID(
		ctx,
		workspaceID,
		agentSessionID,
		claim.ClientSubmitID,
	)
	if err != nil {
		return false, err
	}
	if !found {
		return false, nil
	}
	if strings.TrimSpace(evidenceTurnID) != canonicalTurnID {
		return false, fmt.Errorf(
			"durable submit provenance violates canonical turn binding: client submit %q canonical=%q evidence=%q",
			claim.ClientSubmitID,
			canonicalTurnID,
			evidenceTurnID,
		)
	}
	if s.TuttiModeActivations != nil {
		if _, err := s.TuttiModeActivations.AcceptTurnSnapshot(ctx, workspaceID, agentSessionID, canonicalTurnID); err != nil {
			return false, err
		}
	}
	if err := s.acceptSubmitClaim(workspaceID, agentSessionID, claim.ClientSubmitID, canonicalTurnID); err != nil {
		return false, err
	}
	return true, nil
}

func deliveryUnknownError(cause error) error {
	if cause == nil {
		return ErrSubmitDeliveryUnknown
	}
	if errors.Is(cause, ErrSubmitDeliveryUnknown) {
		return cause
	}
	return errors.Join(ErrSubmitDeliveryUnknown, cause)
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

// confirmAndAcceptSubmitClaim promotes a prepared claim only after the exact
// client-submit message can be queried back from durable storage and is bound
// to the immutable canonical turn. Runtime Accepted=true alone is not a
// durability receipt: the provider may have started while persistence failed.
func (s *Service) confirmAndAcceptSubmitClaim(
	ctx context.Context,
	workspaceID, agentSessionID, clientSubmitID, canonicalTurnID string,
) error {
	if s.SubmitClaimStore == nil || strings.TrimSpace(clientSubmitID) == "" {
		return nil
	}
	canonicalTurnID = strings.TrimSpace(canonicalTurnID)
	evidenceTurnID, found, err := s.SubmitClaimStore.FindTurnByClientSubmitID(
		ctx,
		workspaceID,
		agentSessionID,
		clientSubmitID,
	)
	if err != nil {
		return err
	}
	if !found {
		return ErrSubmitDeliveryUnknown
	}
	if strings.TrimSpace(evidenceTurnID) != canonicalTurnID {
		return fmt.Errorf(
			"durable submit provenance violates canonical turn binding: client submit %q canonical=%q evidence=%q",
			clientSubmitID,
			canonicalTurnID,
			evidenceTurnID,
		)
	}
	return s.acceptSubmitClaim(workspaceID, agentSessionID, clientSubmitID, canonicalTurnID)
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
