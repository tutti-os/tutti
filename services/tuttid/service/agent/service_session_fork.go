package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

var (
	ErrSessionForkUnsupported       = agenthost.ErrSessionForkUnsupported
	ErrSessionForkInProgress        = agenthost.ErrSessionForkInProgress
	ErrSessionForkDeliveryUnknown   = agenthost.ErrSessionForkDeliveryUnknown
	ErrSessionForkFailed            = agenthost.ErrSessionForkFailed
	ErrSessionForkConflict          = errors.New("agent session fork conflicts with canonical state")
	ErrSessionForkOperationNotFound = errors.New("agent session fork operation was not found")
)

type ForkSessionInput struct {
	TargetAgentSessionID string
	RequestID            string
	ThroughTurnID        string
}

type SessionForkOperationStatus string

const (
	SessionForkOperationAccepted  SessionForkOperationStatus = "accepted"
	SessionForkOperationCommitted SessionForkOperationStatus = "committed"
	SessionForkOperationFailed    SessionForkOperationStatus = "failed"
	SessionForkOperationUnknown   SessionForkOperationStatus = "unknown"
)

type SessionForkPoint struct {
	Type   string
	TurnID string
}

type SessionForkOperation struct {
	OperationID          string
	RequestID            string
	SourceAgentSessionID string
	TargetAgentSessionID string
	Point                SessionForkPoint
	Status               SessionForkOperationStatus
	Phase                string
	Session              *Session
	Lineage              *SessionForkLineage
	Error                *string
}

// Fork delegates the durable fork saga to Agent Host and projects the
// committed child through the same public Session boundary as other commands.
// Once Host freezes an operation, Fork returns its accepted phase immediately;
// later durable phases are read through GetSessionForkOperation. Only
// validation and pre-creation failures remain request errors.
func (s *Service) Fork(
	ctx context.Context,
	workspaceID, sourceAgentSessionID string,
	input ForkSessionInput,
) (SessionForkOperation, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	sourceAgentSessionID = strings.TrimSpace(sourceAgentSessionID)
	input.TargetAgentSessionID = strings.TrimSpace(input.TargetAgentSessionID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	input.ThroughTurnID = strings.TrimSpace(input.ThroughTurnID)
	if workspaceID == "" || sourceAgentSessionID == "" ||
		input.TargetAgentSessionID == "" || input.RequestID == "" ||
		input.ThroughTurnID == "" ||
		sourceAgentSessionID == input.TargetAgentSessionID {
		return SessionForkOperation{}, ErrInvalidArgument
	}

	result, err := s.ApplicationHost().ForkSession(ctx, agenthost.ForkSessionInput{
		WorkspaceID:          workspaceID,
		SourceAgentSessionID: sourceAgentSessionID,
		TargetAgentSessionID: input.TargetAgentSessionID,
		RequestID:            input.RequestID,
		Asynchronous:         true,
		Point: agenthost.SessionForkPoint{
			Kind:   agenthost.SessionForkPointThroughTurn,
			TurnID: input.ThroughTurnID,
		},
	})
	if err != nil &&
		(result.Operation.OperationID == "" ||
			errors.Is(err, storesqlite.ErrSessionForkRequestConflict)) {
		return SessionForkOperation{}, normalizeSessionForkError(err)
	}
	return s.projectSessionForkOperation(ctx, result)
}

func (s *Service) GetSessionForkOperation(
	ctx context.Context,
	workspaceID, operationID string,
) (SessionForkOperation, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	operationID = strings.TrimSpace(operationID)
	if workspaceID == "" || operationID == "" {
		return SessionForkOperation{}, ErrInvalidArgument
	}
	result, found, err := s.ApplicationHost().GetSessionForkOperation(
		ctx,
		workspaceID,
		operationID,
	)
	if err != nil {
		return SessionForkOperation{}, normalizeSessionForkError(err)
	}
	if !found {
		return SessionForkOperation{}, ErrSessionForkOperationNotFound
	}
	return s.projectSessionForkOperation(ctx, result)
}

func (s *Service) AcknowledgeSessionForkOperation(
	ctx context.Context,
	workspaceID, operationID string,
) (SessionForkOperation, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	operationID = strings.TrimSpace(operationID)
	if workspaceID == "" || operationID == "" {
		return SessionForkOperation{}, ErrInvalidArgument
	}
	result, found, err := s.ApplicationHost().AcknowledgeSessionForkOperation(
		ctx,
		workspaceID,
		operationID,
	)
	if err != nil {
		return SessionForkOperation{}, normalizeSessionForkError(err)
	}
	if !found {
		return SessionForkOperation{}, ErrSessionForkOperationNotFound
	}
	return s.projectSessionForkOperation(ctx, result)
}

func (s *Service) projectSessionForkOperation(
	ctx context.Context,
	result agenthost.ForkSessionResult,
) (SessionForkOperation, error) {
	status, err := publicSessionForkOperationStatus(result.Operation.Status)
	if err != nil {
		return SessionForkOperation{}, err
	}
	if status == SessionForkOperationCommitted {
		if err := validateCommittedSessionForkResult(result); err != nil {
			return SessionForkOperation{}, err
		}
	}
	operation := SessionForkOperation{
		OperationID:          strings.TrimSpace(result.Operation.OperationID),
		RequestID:            strings.TrimSpace(result.Operation.RequestID),
		SourceAgentSessionID: strings.TrimSpace(result.Operation.SourceAgentSessionID),
		TargetAgentSessionID: strings.TrimSpace(result.Operation.TargetAgentSessionID),
		Point: SessionForkPoint{
			Type:   "throughTurn",
			TurnID: strings.TrimSpace(result.Operation.SourceTurnID),
		},
		Status: status,
		Phase:  publicSessionForkOperationPhase(result.Operation.Status),
	}
	if lastError := strings.TrimSpace(result.Operation.LastError); lastError != "" {
		operation.Error = &lastError
	}
	if result.Lineage != nil {
		operation.Lineage = &SessionForkLineage{
			SourceAgentSessionID: strings.TrimSpace(result.Lineage.SourceAgentSessionID),
			SourceTurnID:         strings.TrimSpace(result.Lineage.SourceTurnID),
			TargetTurnID:         strings.TrimSpace(result.Lineage.TargetTurnID),
			OperationID:          strings.TrimSpace(result.Lineage.OperationID),
			ForkedAtUnixMS:       result.Lineage.ForkedAtUnixMS,
		}
	}
	if status == SessionForkOperationCommitted {
		session, err := s.projectHostSessionResult(
			ctx,
			result.Session,
			ProviderRuntimeSession{},
			false,
			true,
			true,
		)
		if err != nil {
			return SessionForkOperation{}, err
		}
		// A committed operation owns an immutable lineage snapshot. The
		// canonical lineage row may already have been cascade-deleted by hard
		// purge, so it cannot be the authority for this response projection.
		lineage := *operation.Lineage
		session.ForkedFrom = &lineage
		operation.Session = &session
	}
	return operation, nil
}

func publicSessionForkOperationPhase(status string) string {
	switch strings.TrimSpace(status) {
	case storesqlite.SessionForkStatusPrepared:
		return "frozen"
	case storesqlite.SessionForkStatusDispatching:
		return "dispatching"
	case storesqlite.SessionForkStatusProviderAccepted:
		return "materializing"
	case storesqlite.SessionForkStatusCommitted:
		return "committed"
	case storesqlite.SessionForkStatusFailed:
		return "failed"
	case storesqlite.SessionForkStatusUnknown:
		return "deliveryUnknown"
	default:
		return ""
	}
}

func validateCommittedSessionForkResult(result agenthost.ForkSessionResult) error {
	operation := result.Operation
	if result.Lineage == nil {
		return fmt.Errorf(
			"%w: committed session fork operation %q omitted immutable lineage",
			ErrSessionForkConflict,
			strings.TrimSpace(operation.OperationID),
		)
	}
	if strings.TrimSpace(result.Session.WorkspaceID) != strings.TrimSpace(operation.WorkspaceID) ||
		strings.TrimSpace(result.Session.ID) != strings.TrimSpace(operation.TargetAgentSessionID) ||
		strings.TrimSpace(result.Lineage.WorkspaceID) != strings.TrimSpace(operation.WorkspaceID) ||
		strings.TrimSpace(result.Lineage.TargetAgentSessionID) != strings.TrimSpace(operation.TargetAgentSessionID) ||
		strings.TrimSpace(result.Lineage.SourceAgentSessionID) != strings.TrimSpace(operation.SourceAgentSessionID) ||
		strings.TrimSpace(result.Lineage.SourceTurnID) != strings.TrimSpace(operation.SourceTurnID) ||
		strings.TrimSpace(result.Lineage.TargetTurnID) == "" ||
		strings.TrimSpace(result.Lineage.TargetTurnID) != strings.TrimSpace(operation.TargetTurnID) ||
		strings.TrimSpace(result.Lineage.OperationID) != strings.TrimSpace(operation.OperationID) {
		return fmt.Errorf(
			"%w: committed session fork operation %q has inconsistent immutable identity",
			ErrSessionForkConflict,
			strings.TrimSpace(operation.OperationID),
		)
	}
	return nil
}

func publicSessionForkOperationStatus(
	status string,
) (SessionForkOperationStatus, error) {
	switch strings.TrimSpace(status) {
	case storesqlite.SessionForkStatusPrepared,
		storesqlite.SessionForkStatusDispatching,
		storesqlite.SessionForkStatusProviderAccepted:
		return SessionForkOperationAccepted, nil
	case storesqlite.SessionForkStatusCommitted:
		return SessionForkOperationCommitted, nil
	case storesqlite.SessionForkStatusFailed:
		return SessionForkOperationFailed, nil
	case storesqlite.SessionForkStatusUnknown:
		return SessionForkOperationUnknown, nil
	default:
		return "", fmt.Errorf(
			"unsupported agent session fork operation status %q",
			strings.TrimSpace(status),
		)
	}
}

// withSessionForkCapabilities is fail-closed. This is a provider/session-level
// capability shared by provider-bound Turn actions; boundary-specific
// validation is repeated transactionally when the selected Turn is forked.
func (s *Service) withSessionForkCapabilities(
	ctx context.Context,
	workspaceID string,
	session Session,
) Session {
	session.LifecycleCapabilities.ForkThroughTurn = false
	session.LifecycleCapabilities.Fork = false
	if s == nil || strings.TrimSpace(workspaceID) == "" ||
		strings.TrimSpace(session.ID) == "" ||
		strings.TrimSpace(session.Kind) != storesqlite.SessionKindRoot {
		return session
	}
	capabilities, err := s.ApplicationHost().GetSessionForkCapabilities(
		ctx,
		agenthost.SessionForkCapabilityInput{
			WorkspaceID:          strings.TrimSpace(workspaceID),
			SourceAgentSessionID: strings.TrimSpace(session.ID),
		},
	)
	if err == nil {
		session.LifecycleCapabilities.Fork = capabilities.FullSession
		session.LifecycleCapabilities.ForkThroughTurn = capabilities.ThroughTurn
	}
	return session
}

func normalizeSessionForkError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, agenthost.ErrInvalidArgument):
		return ErrInvalidArgument
	case errors.Is(err, agenthost.ErrSessionNotFound):
		return ErrSessionNotFound
	case errors.Is(err, storesqlite.ErrSessionForkInProgress):
		return ErrSessionForkInProgress
	case errors.Is(err, storesqlite.ErrSessionForkRequestConflict),
		errors.Is(err, storesqlite.ErrSessionForkSourceState),
		errors.Is(err, storesqlite.ErrSessionForkTurnState),
		errors.Is(err, storesqlite.ErrSessionForkTargetReserved),
		errors.Is(err, storesqlite.ErrSessionForkTransition):
		return fmt.Errorf("%w: %w", ErrSessionForkConflict, err)
	default:
		return err
	}
}
