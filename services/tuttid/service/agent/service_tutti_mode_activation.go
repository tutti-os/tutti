package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	tuttimodeactivationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
	tuttimodeactivationservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeactivation"
)

type submitDeliveryDisposition string

var ErrSubmitRejectedBeforeAcceptance = errors.New("agent submit was rejected before acceptance")

const (
	submitDeliveryRejectedBeforeAcceptance submitDeliveryDisposition = "rejected_before_acceptance"
	submitDeliveryAcceptedExact            submitDeliveryDisposition = "accepted_exact"
	submitDeliveryUnknown                  submitDeliveryDisposition = "delivery_unknown"
)

func deliveryUnknownError(cause error) error {
	if cause == nil {
		return ErrSubmitDeliveryUnknown
	}
	if errors.Is(cause, ErrSubmitDeliveryUnknown) {
		return cause
	}
	return errors.Join(ErrSubmitDeliveryUnknown, cause)
}

func (s *Service) applyInitialTuttiModeActivation(ctx context.Context, workspaceID, agentSessionID string, intent *TuttiModeActivationIntent) error {
	if intent == nil {
		return nil
	}
	if s.TuttiModeActivations == nil {
		return fmt.Errorf("%w: Tutti mode activation service is unavailable", ErrInvalidArgument)
	}
	_, err := s.TuttiModeActivations.Set(ctx, tuttimodeactivationservice.SetInput{
		WorkspaceID:            workspaceID,
		AgentSessionID:         agentSessionID,
		State:                  tuttimodeactivationbiz.State(strings.TrimSpace(intent.State)),
		Source:                 tuttimodeactivationbiz.Source(strings.TrimSpace(intent.Source)),
		OrchestrationIntensity: intent.OrchestrationIntensity,
	})
	return err
}

func (s *Service) tuttiModeSnapshotForExec(ctx context.Context, workspaceID, agentSessionID string, guidance bool, runtimeSession ProviderRuntimeSession) (tuttimodeactivationbiz.TurnSnapshot, error) {
	if s.TuttiModeActivations == nil {
		return tuttimodeactivationbiz.SnapshotFromActivation(nil), nil
	}
	if !guidance {
		return s.TuttiModeActivations.SnapshotForNewTurn(ctx, workspaceID, agentSessionID)
	}
	turnID := activeRuntimeTurnID(runtimeSession)
	if turnID == "" {
		var err error
		turnID, err = s.persistedActiveTurnID(ctx, workspaceID, agentSessionID)
		if err != nil {
			return tuttimodeactivationbiz.TurnSnapshot{}, err
		}
	}
	if turnID == "" {
		return tuttimodeactivationbiz.TurnSnapshot{}, ErrSessionNoActiveTurn
	}
	return s.TuttiModeActivations.ExistingTurnSnapshot(ctx, workspaceID, agentSessionID, turnID)
}

// prepareTuttiModeExec freezes the selected activation revision before a new
// canonical turn is dispatched. Guidance reuses the existing frozen row.
func (s *Service) prepareTuttiModeExec(ctx context.Context, workspaceID, agentSessionID string, guidance bool, runtimeSession ProviderRuntimeSession, canonicalTurnID string) (string, tuttimodeactivationbiz.TurnSnapshot, error) {
	snapshot, err := s.tuttiModeSnapshotForExec(ctx, workspaceID, agentSessionID, guidance, runtimeSession)
	if err != nil {
		return "", tuttimodeactivationbiz.TurnSnapshot{}, err
	}
	if guidance {
		turnID := activeRuntimeTurnID(runtimeSession)
		if turnID == "" {
			turnID, err = s.persistedActiveTurnID(ctx, workspaceID, agentSessionID)
		}
		if err != nil || turnID == "" {
			if err == nil {
				err = ErrSessionNoActiveTurn
			}
			return "", tuttimodeactivationbiz.TurnSnapshot{}, err
		}
		if expectedTurnID := strings.TrimSpace(canonicalTurnID); expectedTurnID != "" && expectedTurnID != turnID {
			return "", tuttimodeactivationbiz.TurnSnapshot{}, fmt.Errorf(
				"%w: active turn changed from %q to %q before guidance dispatch",
				ErrSubmitRejectedBeforeAcceptance,
				expectedTurnID,
				turnID,
			)
		}
		return turnID, snapshot, nil
	}
	turnID := strings.TrimSpace(canonicalTurnID)
	if turnID == "" {
		turnID = uuid.NewString()
	}
	if s.TuttiModeActivations == nil {
		return turnID, snapshot, nil
	}
	bound, _, err := s.TuttiModeActivations.BindTurnSnapshot(ctx, workspaceID, agentSessionID, turnID, snapshot)
	if err != nil {
		return "", tuttimodeactivationbiz.TurnSnapshot{}, err
	}
	return turnID, bound, nil
}

// existingSubmitCanonicalTurnID returns the canonical turn already claimed for
// a client submit, so a retry reuses the claimed turn instead of allocating a
// fresh one that would conflict with the durable claim.
func (s *Service) existingSubmitCanonicalTurnID(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	typedClientSubmitID string,
	metadata map[string]any,
) (string, error) {
	if s == nil || s.SubmitClaimStore == nil {
		return "", nil
	}
	clientSubmitID := strings.TrimSpace(typedClientSubmitID)
	if clientSubmitID == "" {
		legacy, _ := metadata["clientSubmitId"].(string)
		clientSubmitID = strings.TrimSpace(legacy)
	}
	if clientSubmitID == "" {
		return "", nil
	}
	claim, found, err := s.SubmitClaimStore.GetSubmitClaim(
		ctx,
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(agentSessionID),
		clientSubmitID,
	)
	if err != nil || !found {
		return "", err
	}
	return strings.TrimSpace(claim.CanonicalTurnID), nil
}

func (s *Service) execWithTuttiModeSnapshot(
	ctx context.Context,
	workspaceID, agentSessionID string,
	guidance bool,
	runtimeSession ProviderRuntimeSession,
	canonicalTurnID string,
	execute func(string, *TuttiModeTurnSnapshot) (RuntimeExecResult, error),
) (RuntimeExecResult, submitDeliveryDisposition, error) {
	turnID, snapshot, err := s.prepareTuttiModeExec(ctx, workspaceID, agentSessionID, guidance, runtimeSession, canonicalTurnID)
	if err != nil {
		return RuntimeExecResult{}, submitDeliveryRejectedBeforeAcceptance, err
	}
	result, err := execute(turnID, runtimeTuttiModeTurnSnapshot(snapshot))
	if err != nil {
		if errors.Is(err, ErrSubmitDeliveryUnknown) {
			return RuntimeExecResult{}, submitDeliveryUnknown, deliveryUnknownError(err)
		}
		if guidance {
			return RuntimeExecResult{}, submitDeliveryUnknown, deliveryUnknownError(err)
		}
		abandonErr := s.abandonPreparedTuttiModeExec(ctx, workspaceID, agentSessionID, turnID, snapshot, false)
		return RuntimeExecResult{}, submitDeliveryRejectedBeforeAcceptance, errors.Join(err, abandonErr)
	}
	if !result.Accepted {
		if guidance {
			return RuntimeExecResult{}, submitDeliveryUnknown, ErrSubmitDeliveryUnknown
		}
		abandonErr := s.abandonPreparedTuttiModeExec(ctx, workspaceID, agentSessionID, turnID, snapshot, false)
		return RuntimeExecResult{}, submitDeliveryRejectedBeforeAcceptance, errors.Join(ErrSubmitRejectedBeforeAcceptance, abandonErr)
	}
	if strings.TrimSpace(result.TurnID) != turnID {
		return RuntimeExecResult{}, submitDeliveryUnknown, ErrSubmitDeliveryUnknown
	}
	if !guidance && s.TuttiModeActivations != nil {
		if _, err := s.TuttiModeActivations.AcceptTurnSnapshot(ctx, workspaceID, agentSessionID, turnID); err != nil {
			return RuntimeExecResult{}, submitDeliveryUnknown, deliveryUnknownError(err)
		}
	}
	return result, submitDeliveryAcceptedExact, nil
}

func (s *Service) abandonPreparedTuttiModeExec(ctx context.Context, workspaceID, agentSessionID, turnID string, snapshot tuttimodeactivationbiz.TurnSnapshot, guidance bool) error {
	if guidance || s.TuttiModeActivations == nil {
		return nil
	}
	_, err := s.TuttiModeActivations.AbandonTurnSnapshot(ctx, workspaceID, agentSessionID, turnID, snapshot)
	return err
}

func (s *Service) deleteTuttiModeActivationSessionState(ctx context.Context, workspaceID, agentSessionID string) error {
	if s == nil || s.TuttiModeActivations == nil {
		return nil
	}
	return s.TuttiModeActivations.DeleteSessionState(ctx, workspaceID, agentSessionID)
}

func runtimeTuttiModeTurnSnapshot(snapshot tuttimodeactivationbiz.TurnSnapshot) *TuttiModeTurnSnapshot {
	return &TuttiModeTurnSnapshot{
		ActivationID:           strings.TrimSpace(snapshot.ActivationID),
		RevisionID:             strings.TrimSpace(snapshot.RevisionID),
		Revision:               snapshot.Revision,
		State:                  string(snapshot.State),
		Source:                 string(snapshot.Source),
		OrchestrationIntensity: snapshot.OrchestrationIntensity,
	}
}

func activeRuntimeTurnID(session ProviderRuntimeSession) string {
	if session.TurnLifecycle == nil || session.TurnLifecycle.ActiveTurnID == nil {
		return ""
	}
	return strings.TrimSpace(*session.TurnLifecycle.ActiveTurnID)
}

func (s *Service) withTuttiModeActivation(ctx context.Context, workspaceID string, session Session) (Session, error) {
	if s == nil || s.TuttiModeActivations == nil || strings.TrimSpace(session.ID) == "" {
		return session, nil
	}
	activation, err := s.TuttiModeActivations.Get(ctx, workspaceID, session.ID)
	if err != nil {
		return Session{}, err
	}
	session.TuttiModeActivation = activation
	return session, nil
}

func (s *Service) withTuttiModeActivations(ctx context.Context, workspaceID string, sessions []Session) ([]Session, error) {
	if s == nil || s.TuttiModeActivations == nil || len(sessions) == 0 {
		return sessions, nil
	}
	ids := make([]string, 0, len(sessions))
	for _, session := range sessions {
		if id := strings.TrimSpace(session.ID); id != "" {
			ids = append(ids, id)
		}
	}
	activations, err := s.TuttiModeActivations.List(ctx, workspaceID, ids)
	if err != nil {
		return nil, err
	}
	result := make([]Session, len(sessions))
	for index, session := range sessions {
		if activation, ok := activations[strings.TrimSpace(session.ID)]; ok {
			value := activation
			session.TuttiModeActivation = &value
		}
		result[index] = session
	}
	return result, nil
}
