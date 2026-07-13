package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

const (
	runtimeOperationLeaseDuration  = 30 * time.Second
	runtimeOperationWorkerInterval = time.Second
	runtimeOperationBatchSize      = 64
	runtimeOperationLogPrefix      = "[agent-runtime-operation]"
)

var ErrRuntimeOperationInProgress = errors.New("agent runtime operation is already in progress")
var ErrRuntimeOperationFailed = errors.New("agent runtime operation failed")

type RuntimeOperationStore interface {
	PrepareRuntimeOperation(context.Context, agentactivitybiz.RuntimeOperationPrepare) (agentactivitybiz.RuntimeOperation, bool, error)
	GetRuntimeOperation(context.Context, string, string) (agentactivitybiz.RuntimeOperation, bool, error)
	ListClaimableRuntimeOperations(context.Context, agentactivitybiz.ListClaimableRuntimeOperationsInput) ([]agentactivitybiz.RuntimeOperation, error)
	ClaimRuntimeOperationLease(context.Context, agentactivitybiz.ClaimRuntimeOperationLeaseInput) (agentactivitybiz.RuntimeOperation, bool, error)
	ReleaseOrFailRuntimeOperation(context.Context, agentactivitybiz.ReleaseOrFailRuntimeOperationInput) (agentactivitybiz.RuntimeOperation, bool, error)
	RequeueLeasedRuntimeOperationsOnStartup(context.Context, int64) (int64, error)
	CompleteInteractiveRuntimeOperation(context.Context, agentactivitybiz.CompleteInteractiveRuntimeOperationInput) (agentactivitybiz.RuntimeOperationCompletion, bool, error)
	CompleteCancelRuntimeOperation(context.Context, agentactivitybiz.CompleteCancelRuntimeOperationInput) (agentactivitybiz.RuntimeOperationCompletion, bool, error)
	ListPendingRuntimeOperationEvents(context.Context, string, int) ([]agentactivitybiz.RuntimeOperationEvent, error)
	MarkRuntimeOperationEventPublished(context.Context, string, int64, int64) (bool, error)
}

type RuntimeOperationEventPublisher interface {
	PublishRuntimeOperationEvent(context.Context, agentactivitybiz.RuntimeOperationEvent) error
}

func (s *Service) runtimeOperationNow() time.Time {
	if s.RuntimeOperationClock != nil {
		return s.RuntimeOperationClock().UTC()
	}
	return time.Now().UTC()
}

func runtimeOperationID(workspaceID string, agentSessionID string, kind string, subjectID string) string {
	name := strings.Join([]string{
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(agentSessionID),
		strings.TrimSpace(kind),
		strings.TrimSpace(subjectID),
	}, "\x00")
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte(name)).String()
}

func (s *Service) prepareInteractiveRuntimeOperation(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	requestID string,
	input SubmitInteractiveInput,
) (agentactivitybiz.RuntimeOperation, error) {
	if s.RuntimeOperationStore == nil || s.TurnStore == nil {
		return agentactivitybiz.RuntimeOperation{}, errors.New("agent runtime operation store is unavailable")
	}
	expectedTurnID := strings.TrimSpace(input.TurnID)
	operationSubjectID := requestID
	if expectedTurnID != "" {
		operationSubjectID = expectedTurnID + "\x00" + requestID
	}
	operationID := runtimeOperationID(workspaceID, agentSessionID, agentactivitybiz.RuntimeOperationKindInteractiveResponse, operationSubjectID)
	payload := map[string]any{
		"action":   optionalInputString(input.Action),
		"optionId": optionalInputString(input.OptionID),
		"payload":  clonePayload(input.Payload),
		"turnId":   expectedTurnID,
	}
	// A completed response no longer has a pending interaction. Resolve the
	// deterministic operation first so an API retry remains idempotent after
	// the atomic interaction transition.
	if existing, found, err := s.RuntimeOperationStore.GetRuntimeOperation(ctx, workspaceID, operationID); err != nil {
		return agentactivitybiz.RuntimeOperation{}, err
	} else if found {
		if existing.WorkspaceID != workspaceID || existing.AgentSessionID != agentSessionID ||
			existing.Kind != agentactivitybiz.RuntimeOperationKindInteractiveResponse ||
			existing.RequestID != requestID || (expectedTurnID != "" && existing.TurnID != expectedTurnID) || !runtimeOperationPayloadEqual(existing.Payload, payload) {
			return agentactivitybiz.RuntimeOperation{}, agentactivitybiz.ErrRuntimeOperationConflict
		}
		return existing, nil
	}
	pending, err := s.TurnStore.ListSessionInteractions(ctx, agentactivitybiz.ListSessionInteractionsInput{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
		Status: agentactivitybiz.InteractionStatusPending,
	})
	if err != nil {
		return agentactivitybiz.RuntimeOperation{}, err
	}
	turnID := ""
	for _, interaction := range pending {
		if strings.TrimSpace(interaction.RequestID) == requestID && (expectedTurnID == "" || strings.TrimSpace(interaction.TurnID) == expectedTurnID) {
			turnID = strings.TrimSpace(interaction.TurnID)
			break
		}
	}
	if turnID == "" {
		return agentactivitybiz.RuntimeOperation{}, fmt.Errorf("%w: pending interaction %q was not found", ErrInvalidArgument, requestID)
	}
	now := s.runtimeOperationNow().UnixMilli()
	operation, _, err := s.RuntimeOperationStore.PrepareRuntimeOperation(ctx, agentactivitybiz.RuntimeOperationPrepare{
		OperationID: operationID,
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
		Kind:   agentactivitybiz.RuntimeOperationKindInteractiveResponse,
		TurnID: turnID, RequestID: requestID,
		Payload:      payload,
		OccurredAtMS: now,
	})
	return operation, err
}

func (s *Service) prepareCancelRuntimeOperation(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	turnID string,
) (agentactivitybiz.RuntimeOperation, error) {
	if s.RuntimeOperationStore == nil {
		return agentactivitybiz.RuntimeOperation{}, errors.New("agent runtime operation store is unavailable")
	}
	now := s.runtimeOperationNow().UnixMilli()
	operation, _, err := s.RuntimeOperationStore.PrepareRuntimeOperation(ctx, agentactivitybiz.RuntimeOperationPrepare{
		OperationID: runtimeOperationID(workspaceID, agentSessionID, agentactivitybiz.RuntimeOperationKindCancelTurn, turnID),
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
		Kind:         agentactivitybiz.RuntimeOperationKindCancelTurn,
		TurnID:       turnID,
		Payload:      map[string]any{"reason": "user requested turn cancellation"},
		OccurredAtMS: now,
	})
	return operation, err
}

func (s *Service) processRuntimeOperation(
	ctx context.Context,
	operation agentactivitybiz.RuntimeOperation,
	recovering bool,
) (agentactivitybiz.RuntimeOperation, error) {
	if operation.Status == agentactivitybiz.RuntimeOperationStatusCompleted {
		return operation, nil
	}
	if operation.Status == agentactivitybiz.RuntimeOperationStatusFailed {
		return operation, fmt.Errorf("%w: %s", ErrRuntimeOperationFailed, strings.TrimSpace(operation.LastError))
	}
	if s.RuntimeOperationStore == nil {
		return agentactivitybiz.RuntimeOperation{}, errors.New("agent runtime operation store is unavailable")
	}
	now := s.runtimeOperationNow()
	owner := strings.TrimSpace(s.RuntimeOperationOwner)
	if owner == "" {
		owner = uuid.NewString()
	}
	leased, claimed, err := s.RuntimeOperationStore.ClaimRuntimeOperationLease(ctx, agentactivitybiz.ClaimRuntimeOperationLeaseInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
		LeaseOwner: owner, NowUnixMS: now.UnixMilli(),
		LeaseExpiresAtMS: now.Add(runtimeOperationLeaseDuration).UnixMilli(),
	})
	if err != nil {
		return agentactivitybiz.RuntimeOperation{}, err
	}
	if !claimed {
		current, ok, err := s.RuntimeOperationStore.GetRuntimeOperation(ctx, operation.WorkspaceID, operation.OperationID)
		if err != nil {
			return agentactivitybiz.RuntimeOperation{}, err
		}
		if ok && current.Status == agentactivitybiz.RuntimeOperationStatusCompleted {
			return current, nil
		}
		if ok {
			return current, ErrRuntimeOperationInProgress
		}
		return agentactivitybiz.RuntimeOperation{}, ErrRuntimeOperationInProgress
	}
	switch leased.Kind {
	case agentactivitybiz.RuntimeOperationKindInteractiveResponse:
		return s.executeInteractiveRuntimeOperation(ctx, leased, owner, recovering)
	case agentactivitybiz.RuntimeOperationKindCancelTurn:
		return s.executeCancelRuntimeOperation(ctx, leased, owner, recovering)
	case agentactivitybiz.RuntimeOperationKindPlanDecision:
		return s.executePlanDecisionRuntimeOperation(ctx, leased, owner, recovering)
	default:
		return s.releaseRuntimeOperation(ctx, leased, owner, fmt.Errorf("unsupported runtime operation kind %q", leased.Kind), true)
	}
}

func (s *Service) executeInteractiveRuntimeOperation(
	ctx context.Context,
	operation agentactivitybiz.RuntimeOperation,
	owner string,
	recovering bool,
) (agentactivitybiz.RuntimeOperation, error) {
	disposition := agentactivitybiz.InteractionStatusAnswered
	runtimeSession, runtimeSessionFound := s.controller().Session(operation.WorkspaceID, operation.AgentSessionID)
	if recovering && !runtimeSessionFound {
		disposition = agentactivitybiz.InteractionStatusSuperseded
	} else {
		err := s.controller().SubmitInteractive(ctx, RuntimeSubmitInteractiveInput{
			WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID,
			RequestID: operation.RequestID,
			Action:    payloadText(operation.Payload, "action"),
			OptionID:  payloadText(operation.Payload, "optionId"),
			Payload:   payloadMap(operation.Payload, "payload"),
		})
		if err != nil {
			if !isInteractiveAlreadyAppliedError(err) {
				return s.releaseRuntimeOperation(ctx, operation, owner, err, !isRetryableRuntimeOperationError(err))
			}
			evidence, evidenceErr := s.interactiveAlreadyAppliedEvidence(ctx, operation, runtimeSession, runtimeSessionFound)
			if evidenceErr != nil {
				return operation, evidenceErr
			}
			if evidence == "" {
				return s.releaseRuntimeOperation(ctx, operation, owner, err, false)
			}
			disposition = evidence
		}
	}
	completion, _, err := s.RuntimeOperationStore.CompleteInteractiveRuntimeOperation(ctx, agentactivitybiz.CompleteInteractiveRuntimeOperationInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
		LeaseOwner: owner, Disposition: disposition,
		Output:    map[string]any{"action": payloadText(operation.Payload, "action"), "optionId": payloadText(operation.Payload, "optionId")},
		NowUnixMS: s.runtimeOperationNow().UnixMilli(),
	})
	if err != nil {
		return operation, err
	}
	if err := s.publishRuntimeOperationEvents(ctx, operation.WorkspaceID); err != nil {
		logRuntimeOperationFailure(completion.Operation, fmt.Errorf("publish completed interactive runtime operation: %w", err))
	}
	return completion.Operation, nil
}

func (s *Service) interactiveAlreadyAppliedEvidence(
	ctx context.Context,
	operation agentactivitybiz.RuntimeOperation,
	runtimeSession ProviderRuntimeSession,
	runtimeSessionFound bool,
) (string, error) {
	turn, ok, err := s.TurnStore.GetTurn(ctx, operation.WorkspaceID, operation.AgentSessionID, operation.TurnID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", nil
	}
	if turn.Phase == agentactivitybiz.TurnPhaseSettled {
		return agentactivitybiz.InteractionStatusSuperseded, nil
	}
	if !runtimeSessionFound {
		return "", nil
	}
	if runtimeSession.PendingInteractive != nil &&
		strings.TrimSpace(runtimeSession.PendingInteractive.RequestID) == operation.RequestID {
		return "", nil
	}
	return agentactivitybiz.InteractionStatusAnswered, nil
}

func (s *Service) executeCancelRuntimeOperation(
	ctx context.Context,
	operation agentactivitybiz.RuntimeOperation,
	owner string,
	recovering bool,
) (agentactivitybiz.RuntimeOperation, error) {
	alreadyApplied := recovering
	if !recovering {
		result, err := s.controller().Cancel(ctx, RuntimeCancelInput{
			WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID,
			TurnID: operation.TurnID, Reason: payloadText(operation.Payload, "reason"),
		})
		if err != nil {
			return s.releaseRuntimeOperation(ctx, operation, owner, err, !isRetryableRuntimeOperationError(err))
		}
		alreadyApplied = result.Canceled || result.TargetAbsent
		if !alreadyApplied {
			turn, found, lookupErr := s.TurnStore.GetTurn(ctx, operation.WorkspaceID, operation.AgentSessionID, operation.TurnID)
			if lookupErr != nil {
				return operation, lookupErr
			}
			alreadyApplied = !found || turn.Phase == agentactivitybiz.TurnPhaseSettled
		}
	}
	if !alreadyApplied {
		return s.releaseRuntimeOperation(ctx, operation, owner, errors.New("runtime still owns the exact cancel target"), true)
	}
	completion, _, err := s.RuntimeOperationStore.CompleteCancelRuntimeOperation(ctx, agentactivitybiz.CompleteCancelRuntimeOperationInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
		LeaseOwner: owner, NowUnixMS: s.runtimeOperationNow().UnixMilli(),
	})
	if err != nil {
		return operation, err
	}
	if err := s.publishRuntimeOperationEvents(ctx, operation.WorkspaceID); err != nil {
		logRuntimeOperationFailure(completion.Operation, fmt.Errorf("publish completed cancel runtime operation: %w", err))
	}
	return completion.Operation, nil
}

func (s *Service) releaseRuntimeOperation(
	ctx context.Context,
	operation agentactivitybiz.RuntimeOperation,
	owner string,
	cause error,
	fail bool,
) (agentactivitybiz.RuntimeOperation, error) {
	released, _, releaseErr := s.RuntimeOperationStore.ReleaseOrFailRuntimeOperation(ctx, agentactivitybiz.ReleaseOrFailRuntimeOperationInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
		LeaseOwner: owner, LastError: cause.Error(), NowUnixMS: s.runtimeOperationNow().UnixMilli(), Fail: fail,
		NextAttemptAtMS: runtimeOperationNextAttemptAt(s.runtimeOperationNow(), operation.Attempt, fail),
	})
	if releaseErr != nil {
		return operation, releaseErr
	}
	if !fail {
		return released, fmt.Errorf("%w: %v", ErrRuntimeOperationInProgress, cause)
	}
	return released, cause
}

func (s *Service) StepRuntimeOperationWorker(ctx context.Context, recovering bool) error {
	if s.RuntimeOperationStore == nil {
		return nil
	}
	now := s.runtimeOperationNow().UnixMilli()
	operations, err := s.RuntimeOperationStore.ListClaimableRuntimeOperations(ctx, agentactivitybiz.ListClaimableRuntimeOperationsInput{
		NowUnixMS: now, Limit: runtimeOperationBatchSize,
	})
	if err != nil {
		return err
	}
	var processErrors []error
	for _, operation := range operations {
		if _, err := s.processRuntimeOperation(ctx, operation, recovering); err != nil && !errors.Is(err, ErrRuntimeOperationInProgress) {
			logRuntimeOperationFailure(operation, err)
			processErrors = append(processErrors, fmt.Errorf("process runtime operation %s: %w", operation.OperationID, err))
		}
	}
	if err := s.publishRuntimeOperationEvents(ctx, ""); err != nil {
		processErrors = append(processErrors, fmt.Errorf("publish runtime operation outbox: %w", err))
	}
	return errors.Join(processErrors...)
}

func (s *Service) RecoverRuntimeOperations(ctx context.Context) error {
	if s.RuntimeOperationStore == nil {
		return nil
	}
	if _, err := s.RuntimeOperationStore.RequeueLeasedRuntimeOperationsOnStartup(ctx, s.runtimeOperationNow().UnixMilli()); err != nil {
		return fmt.Errorf("requeue leased runtime operations on startup: %w", err)
	}
	for {
		if err := s.StepRuntimeOperationWorker(ctx, true); err != nil {
			return err
		}
		remaining, err := s.RuntimeOperationStore.ListClaimableRuntimeOperations(ctx, agentactivitybiz.ListClaimableRuntimeOperationsInput{
			NowUnixMS: s.runtimeOperationNow().UnixMilli(), Limit: 1,
		})
		if err != nil {
			return err
		}
		if len(remaining) == 0 {
			return nil
		}
	}
}

func (s *Service) RunRuntimeOperationWorker(ctx context.Context) {
	ticker := time.NewTicker(runtimeOperationWorkerInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.StepRuntimeOperationWorker(ctx, false); err != nil {
				logRuntimeOperationFailure(agentactivitybiz.RuntimeOperation{}, err)
			}
		}
	}
}

func (s *Service) publishRuntimeOperationEvents(ctx context.Context, workspaceID string) error {
	if s.RuntimeOperationStore == nil || s.RuntimeOperationEventPublisher == nil {
		return nil
	}
	events, err := s.RuntimeOperationStore.ListPendingRuntimeOperationEvents(ctx, workspaceID, runtimeOperationBatchSize)
	if err != nil {
		return err
	}
	for _, event := range events {
		if err := s.RuntimeOperationEventPublisher.PublishRuntimeOperationEvent(ctx, event); err != nil {
			return err
		}
		if _, err := s.RuntimeOperationStore.MarkRuntimeOperationEventPublished(ctx, event.WorkspaceID, event.ID, s.runtimeOperationNow().UnixMilli()); err != nil {
			return err
		}
	}
	return nil
}

func logRuntimeOperationFailure(operation agentactivitybiz.RuntimeOperation, err error) {
	payload, _ := json.Marshal(map[string]any{
		"event":          "runtime_operation_failed",
		"operationId":    operation.OperationID,
		"workspaceId":    operation.WorkspaceID,
		"agentSessionId": operation.AgentSessionID,
		"kind":           operation.Kind,
		"error":          err.Error(),
	})
	slog.Error(runtimeOperationLogPrefix + " " + string(payload))
}

func isInteractiveAlreadyAppliedError(err error) bool {
	return errors.Is(err, ErrInteractiveRequestNotLive) || errors.Is(err, ErrInteractiveAlreadyAnswered)
}

func isRetryableRuntimeOperationError(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, context.Canceled) ||
		errors.Is(err, context.DeadlineExceeded) ||
		errors.Is(err, ErrSessionNotFound) ||
		errors.Is(err, ErrRuntimeSessionDisconnected)
}

func runtimeOperationNextAttemptAt(now time.Time, attempt int, failed bool) int64 {
	if failed {
		return 0
	}
	if attempt < 1 {
		attempt = 1
	}
	shift := attempt - 1
	if shift > 8 {
		shift = 8
	}
	delay := time.Second * time.Duration(1<<shift)
	return now.Add(delay).UnixMilli()
}

func runtimeOperationPayloadEqual(left map[string]any, right map[string]any) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftJSON, rightJSON)
}

func payloadText(payload map[string]any, key string) string {
	value, _ := payload[key].(string)
	return strings.TrimSpace(value)
}

func payloadMap(payload map[string]any, key string) map[string]any {
	value, _ := payload[key].(map[string]any)
	return clonePayload(value)
}
