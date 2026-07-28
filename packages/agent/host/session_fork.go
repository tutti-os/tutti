package agenthost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

const sessionForkCheckpointTimeout = 10 * time.Second

// ForkSession forks provider state through an inclusive canonical Turn and
// then atomically installs the corresponding canonical child root session.
// RequestID is the replay key; TargetAgentSessionID is reserved at prepare.
func (h *Host) ForkSession(
	ctx context.Context,
	input ForkSessionInput,
) (ForkSessionResult, error) {
	normalizeForkSessionInput(&input)
	if h == nil || h.sessionForks == nil || h.sessionForkRuntime == nil ||
		input.WorkspaceID == "" || input.SourceAgentSessionID == "" ||
		input.TargetAgentSessionID == "" || input.RequestID == "" ||
		input.Point.Kind != SessionForkPointThroughTurn ||
		input.Point.TurnID == "" ||
		input.SourceAgentSessionID == input.TargetAgentSessionID {
		return ForkSessionResult{}, ErrInvalidArgument
	}
	var result ForkSessionResult
	err := h.withSessionMutationActor(
		ctx,
		input.WorkspaceID,
		input.SourceAgentSessionID,
		func(actorCtx context.Context) error {
			var forkErr error
			result, forkErr = h.forkSessionSerialized(actorCtx, input)
			return forkErr
		},
	)
	return result, err
}

func (h *Host) forkSessionSerialized(
	ctx context.Context,
	input ForkSessionInput,
) (ForkSessionResult, error) {
	requestHash, err := hashForkSessionInput(input)
	if err != nil {
		return ForkSessionResult{}, err
	}
	release, err := h.acquireSession(ctx, SessionRef{
		WorkspaceID: input.WorkspaceID, AgentSessionID: input.SourceAgentSessionID,
	})
	if err != nil {
		return ForkSessionResult{}, err
	}
	defer release()

	if existing, found, err := h.sessionForks.GetSessionForkOperationByRequest(
		ctx, input.WorkspaceID, input.RequestID,
	); err != nil {
		return ForkSessionResult{}, err
	} else if found {
		if existing.RequestHash != requestHash {
			return ForkSessionResult{Operation: existing}, storesqlite.ErrSessionForkRequestConflict
		}
		return h.processSessionForkOperation(ctx, existing)
	}
	blocking, found, err := h.sessionForks.GetBlockingSessionForkOperation(
		ctx,
		input.WorkspaceID,
		input.SourceAgentSessionID,
		string(input.Point.Kind),
		input.Point.TurnID,
	)
	if err != nil {
		return ForkSessionResult{}, err
	}
	if found {
		return h.processSessionForkOperation(ctx, blocking)
	}

	if _, found, err := h.sessionForks.GetSessionForkSource(
		ctx, input.WorkspaceID, input.SourceAgentSessionID,
	); err != nil {
		return ForkSessionResult{}, err
	} else if !found {
		return ForkSessionResult{}, ErrSessionNotFound
	}
	boundary, supported, err := h.sessionForks.CheckSessionForkThroughTurn(
		ctx, input.WorkspaceID, input.SourceAgentSessionID, input.Point.TurnID,
	)
	if err != nil {
		return ForkSessionResult{}, err
	}
	if !supported {
		return ForkSessionResult{}, storesqlite.ErrSessionForkTurnState
	}
	runtimeSource, err := h.sessionForkRuntimeSource(ctx, boundary.Session)
	if err != nil {
		return ForkSessionResult{}, err
	}
	if strings.TrimSpace(runtimeSource.ProviderSessionID) !=
		strings.TrimSpace(boundary.Session.ProviderSessionID) {
		return ForkSessionResult{}, ErrSessionForkFailed
	}
	descriptor, err := h.sessionForkRuntime.ResolveSessionFork(
		ctx,
		cloneSessionForkRuntimeSource(runtimeSource),
	)
	if err != nil {
		return ForkSessionResult{}, err
	}
	normalizeSessionForkDriverDescriptor(&descriptor)
	if !descriptor.ThroughTurn || descriptor.Kind == "" || descriptor.Version == "" ||
		!validSessionForkStateBindingMode(
			descriptor.StateBindingMode,
			h.sessionForkState,
			runtimeSource.Provider,
		) {
		return ForkSessionResult{}, ErrSessionForkUnsupported
	}
	targetContext, err := h.prepareSessionForkTargetContext(
		ctx, boundary.Session, runtimeSource,
	)
	if err != nil {
		return ForkSessionResult{}, err
	}
	expectedSourceHash, err := storesqlite.SessionForkSourceHash(boundary.Session)
	if err != nil {
		return ForkSessionResult{}, err
	}
	operation, _, err := h.sessionForks.PrepareSessionFork(ctx, storesqlite.SessionForkPrepare{
		OperationID:          uuid.NewString(),
		WorkspaceID:          input.WorkspaceID,
		RequestID:            input.RequestID,
		RequestHash:          requestHash,
		SourceAgentSessionID: input.SourceAgentSessionID,
		TargetAgentSessionID: input.TargetAgentSessionID,
		SourceTurnID:         input.Point.TurnID,
		PointKind:            string(input.Point.Kind),
		DriverKind:           descriptor.Kind,
		DriverVersion:        descriptor.Version,
		ExpectedSourceHash:   expectedSourceHash,
		TargetCwd:            targetContext.Cwd,
		TargetRuntimeContext: targetContext.RuntimeContext,
		TargetSettings: preparedSessionForkSettings(
			boundary.Session.Settings,
			runtimeSource.Settings,
		),
		OccurredAtUnixMS: h.now().UnixMilli(),
	})
	if err != nil {
		return ForkSessionResult{}, err
	}
	return h.processSessionForkOperationWithSource(
		ctx,
		operation,
		&runtimeSource,
		false,
	)
}

func (h *Host) GetSessionForkOperation(
	ctx context.Context,
	workspaceID, operationID string,
) (ForkSessionResult, bool, error) {
	if h == nil || h.sessionForks == nil {
		return ForkSessionResult{}, false, nil
	}
	op, found, err := h.sessionForks.GetSessionForkOperation(
		ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(operationID),
	)
	if err != nil || !found {
		return ForkSessionResult{}, found, err
	}
	if op.Status == storesqlite.SessionForkStatusPrepared ||
		op.Status == storesqlite.SessionForkStatusDispatching ||
		op.Status == storesqlite.SessionForkStatusUnknown ||
		op.Status == storesqlite.SessionForkStatusProviderAccepted {
		var result ForkSessionResult
		err = h.withSessionMutationActor(
			ctx,
			op.WorkspaceID,
			op.SourceAgentSessionID,
			func(actorCtx context.Context) error {
				current, currentFound, currentErr := h.sessionForks.GetSessionForkOperation(
					actorCtx, op.WorkspaceID, op.OperationID,
				)
				if currentErr != nil {
					return currentErr
				}
				if !currentFound {
					return fmt.Errorf(
						"session fork operation %s disappeared during reconciliation",
						op.OperationID,
					)
				}
				if current.Status == storesqlite.SessionForkStatusPrepared {
					failed, _, failErr := h.sessionForks.FailPreparedSessionFork(
						actorCtx,
						current.WorkspaceID,
						current.OperationID,
						"prepared session fork was abandoned before provider dispatch",
						h.now().UnixMilli(),
					)
					result = ForkSessionResult{Operation: failed}
					return failErr
				}
				if current.Status != storesqlite.SessionForkStatusDispatching &&
					current.Status != storesqlite.SessionForkStatusUnknown &&
					current.Status != storesqlite.SessionForkStatusProviderAccepted {
					var resultErr error
					result, resultErr = h.sessionForkResult(actorCtx, current)
					return resultErr
				}
				result, currentErr = h.processSessionForkOperation(actorCtx, current)
				if currentErr == nil {
					return nil
				}

				// The provider result is already durable, so a local commit
				// failure is safe to retry. Return the latest accepted
				// snapshot instead of turning an observable operation into a
				// transport failure; the next GET will reconcile it again.
				current, currentFound, readErr := h.sessionForks.GetSessionForkOperation(
					actorCtx, op.WorkspaceID, op.OperationID,
				)
				if readErr != nil {
					return errors.Join(currentErr, readErr)
				}
				if !currentFound {
					return currentErr
				}
				result, readErr = h.sessionForkResult(actorCtx, current)
				return readErr
			},
		)
		return result, true, err
	}
	result, err := h.sessionForkResult(ctx, op)
	return result, true, err
}

func (h *Host) AcknowledgeSessionForkOperation(
	ctx context.Context,
	workspaceID, operationID string,
) (ForkSessionResult, bool, error) {
	if h == nil || h.sessionForks == nil {
		return ForkSessionResult{}, false, nil
	}
	workspaceID = strings.TrimSpace(workspaceID)
	operationID = strings.TrimSpace(operationID)
	if workspaceID == "" || operationID == "" {
		return ForkSessionResult{}, false, ErrInvalidArgument
	}
	initial, found, err := h.sessionForks.GetSessionForkOperation(
		ctx,
		workspaceID,
		operationID,
	)
	if err != nil || !found {
		return ForkSessionResult{}, found, err
	}
	var result ForkSessionResult
	err = h.withSessionMutationActor(
		ctx,
		workspaceID,
		initial.SourceAgentSessionID,
		func(actorCtx context.Context) error {
			operation, currentFound, _, ackErr :=
				h.sessionForks.AcknowledgeSessionForkOperation(
					actorCtx,
					workspaceID,
					operationID,
					h.now().UnixMilli(),
				)
			if ackErr != nil {
				return ackErr
			}
			if !currentFound {
				found = false
				return nil
			}
			result, ackErr = h.sessionForkResult(actorCtx, operation)
			return ackErr
		},
	)
	return result, found, err
}

func (h *Host) processSessionForkOperation(
	ctx context.Context,
	operation storesqlite.SessionForkOperation,
) (ForkSessionResult, error) {
	return h.processSessionForkOperationWithSource(
		ctx,
		operation,
		nil,
		operation.Status == storesqlite.SessionForkStatusDispatching ||
			operation.Status == storesqlite.SessionForkStatusUnknown,
	)
}

// processSessionForkOperationWithSource reuses one prepared historical runtime
// identity across the pre-prepare capability attestation, the dispatch-time
// attestation, and provider dispatch. Live sources are already authoritative
// runtime observations and enter through the same frozen value.
func (h *Host) processSessionForkOperationWithSource(
	ctx context.Context,
	operation storesqlite.SessionForkOperation,
	preparedSource *ProviderRuntimeSession,
	allowDeterministicReplay bool,
) (ForkSessionResult, error) {
	replaying := operation.Status == storesqlite.SessionForkStatusDispatching ||
		operation.Status == storesqlite.SessionForkStatusUnknown
	switch operation.Status {
	case storesqlite.SessionForkStatusCommitted:
		return h.sessionForkResult(ctx, operation)
	case storesqlite.SessionForkStatusProviderAccepted:
		commit, err := h.sessionForks.CommitSessionFork(
			ctx, operation.WorkspaceID, operation.OperationID, h.now().UnixMilli(),
		)
		if err != nil {
			return ForkSessionResult{Operation: operation}, err
		}
		lineage := commit.Lineage
		return ForkSessionResult{
			Operation: commit.Operation, Session: commit.Session, Lineage: &lineage,
		}, nil
	case storesqlite.SessionForkStatusDispatching:
		if !allowDeterministicReplay {
			return ForkSessionResult{Operation: operation}, ErrSessionForkInProgress
		}
	case storesqlite.SessionForkStatusFailed:
		return ForkSessionResult{Operation: operation}, ErrSessionForkFailed
	case storesqlite.SessionForkStatusUnknown:
		if !allowDeterministicReplay {
			return ForkSessionResult{Operation: operation}, ErrSessionForkDeliveryUnknown
		}
	case storesqlite.SessionForkStatusPrepared:
	default:
		return ForkSessionResult{Operation: operation}, storesqlite.ErrSessionForkTransition
	}
	failBeforeDispatch := func(
		message string,
		cause error,
	) (ForkSessionResult, error) {
		if !replaying {
			return h.failPreparedSessionFork(ctx, operation, message, cause)
		}
		if operation.Status == storesqlite.SessionForkStatusUnknown {
			return ForkSessionResult{Operation: operation},
				errors.Join(ErrSessionForkDeliveryUnknown, cause)
		}
		recorded, _, recordErr := h.sessionForks.RecordSessionForkProviderResult(
			ctx,
			storesqlite.SessionForkProviderResult{
				WorkspaceID:      operation.WorkspaceID,
				OperationID:      operation.OperationID,
				Status:           storesqlite.SessionForkStatusUnknown,
				LastError:        message,
				OccurredAtUnixMS: h.now().UnixMilli(),
			},
		)
		return ForkSessionResult{Operation: recorded},
			errors.Join(ErrSessionForkDeliveryUnknown, cause, recordErr)
	}

	boundary, supported, err := h.sessionForks.CheckSessionForkThroughTurn(
		ctx, operation.WorkspaceID, operation.SourceAgentSessionID, operation.SourceTurnID,
	)
	if err != nil {
		return failBeforeDispatch(
			"canonical through-turn boundary could not be verified before dispatch",
			err,
		)
	}
	if !supported {
		return failBeforeDispatch(
			"canonical through-turn boundary is no longer forkable",
			storesqlite.ErrSessionForkTurnState,
		)
	}
	var source ProviderRuntimeSession
	if preparedSource != nil {
		source = *preparedSource
	} else {
		source, err = h.sessionForkRuntimeSource(ctx, boundary.Session)
		if err != nil {
			return failBeforeDispatch(
				"source runtime could not be prepared before dispatch",
				err,
			)
		}
	}
	if strings.TrimSpace(source.ProviderSessionID) !=
		strings.TrimSpace(operation.SourceProviderSessionID) {
		return failBeforeDispatch(
			"source provider session identity changed before dispatch",
			ErrSessionForkFailed,
		)
	}
	descriptor, err := h.sessionForkRuntime.ResolveSessionFork(
		ctx,
		cloneSessionForkRuntimeSource(source),
	)
	if err != nil {
		if errors.Is(err, ErrSessionForkUnsupported) {
			return failBeforeDispatch(
				"provider no longer supports the prepared session fork",
				ErrSessionForkUnsupported,
			)
		}
		return failBeforeDispatch(
			"provider fork capability could not be verified before dispatch",
			err,
		)
	}
	normalizeSessionForkDriverDescriptor(&descriptor)
	if !descriptor.ThroughTurn || descriptor.Kind != operation.DriverKind ||
		descriptor.Version != operation.DriverVersion ||
		(replaying && !descriptor.DeterministicTargetSessionID) ||
		!validSessionForkStateBindingMode(
			descriptor.StateBindingMode,
			h.sessionForkState,
			source.Provider,
		) {
		return failBeforeDispatch(
			"provider session fork driver changed before dispatch",
			ErrSessionForkUnsupported,
		)
	}
	switch operation.Status {
	case storesqlite.SessionForkStatusUnknown:
		operation, _, err = h.sessionForks.RetryUnknownSessionFork(
			ctx,
			operation.WorkspaceID,
			operation.OperationID,
			h.now().UnixMilli(),
		)
		if err != nil {
			return failBeforeDispatch(
				"provider replay marker could not be persisted",
				err,
			)
		}
	case storesqlite.SessionForkStatusPrepared:
		var dispatchChanged bool
		operation, dispatchChanged, err = h.sessionForks.MarkSessionForkDispatching(
			ctx, operation.WorkspaceID, operation.OperationID, h.now().UnixMilli(),
		)
		if err != nil {
			return failBeforeDispatch(
				"provider dispatch marker could not be persisted",
				err,
			)
		}
		if !dispatchChanged {
			return h.processSessionForkOperation(ctx, operation)
		}
	}
	targetProviderSessionIDRequest := ""
	if descriptor.DeterministicTargetSessionID {
		targetProviderSessionIDRequest = operation.OperationID
	}
	providerResult, dispatchErr := h.sessionForkRuntime.ForkSession(
		ctx, RuntimeSessionForkInput{
			Source:                  cloneSessionForkRuntimeSource(source),
			SourceProviderTurnID:    operation.SourceProviderTurnID,
			SourceProviderTurnIDs:   append([]string(nil), boundary.RootProviderTurnIDs...),
			TargetProviderSessionID: targetProviderSessionIDRequest,
			TargetTitle:             operation.TargetTitle,
			RequestID:               operation.RequestID,
			Driver:                  descriptor,
		},
	)
	targetProviderSessionID := strings.TrimSpace(providerResult.ProviderSessionID)
	if providerResult.StateBindingMode == "" {
		providerResult.StateBindingMode = SessionForkStateBindingHostCopy
	}
	providerResult.StateBindingReceipt = strings.TrimSpace(providerResult.StateBindingReceipt)
	checkpointCtx, checkpointCancel := context.WithTimeout(
		context.WithoutCancel(ctx),
		sessionForkCheckpointTimeout,
	)
	defer checkpointCancel()
	if dispatchErr != nil ||
		providerResult.DeliveryDisposition != SessionForkDeliveryAccepted ||
		targetProviderSessionID == "" ||
		targetProviderSessionID == operation.SourceProviderSessionID ||
		(targetProviderSessionIDRequest != "" &&
			targetProviderSessionID != targetProviderSessionIDRequest) ||
		providerResult.StateBindingMode != descriptor.StateBindingMode ||
		!validSessionForkProviderResult(providerResult, boundary.RootProviderTurnIDs) {
		message := "provider fork result was invalid"
		status := storesqlite.SessionForkStatusUnknown
		if dispatchErr != nil {
			message = dispatchErr.Error()
			if !replaying && (errors.Is(dispatchErr, ErrSessionForkUnsupported) ||
				providerResult.DeliveryDisposition == SessionForkDeliveryNotStarted ||
				providerResult.DeliveryDisposition == SessionForkDeliveryRejected) {
				status = storesqlite.SessionForkStatusFailed
			}
		} else if !replaying &&
			(providerResult.DeliveryDisposition == SessionForkDeliveryNotStarted ||
				providerResult.DeliveryDisposition == SessionForkDeliveryRejected) {
			status = storesqlite.SessionForkStatusFailed
		}
		recorded, _, recordErr := h.sessionForks.RecordSessionForkProviderResult(
			checkpointCtx, storesqlite.SessionForkProviderResult{
				WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
				Status: status, LastError: message,
				OccurredAtUnixMS: h.now().UnixMilli(),
			},
		)
		if recordErr != nil {
			return ForkSessionResult{Operation: operation},
				errors.Join(ErrSessionForkDeliveryUnknown, dispatchErr, recordErr)
		}
		if status == storesqlite.SessionForkStatusFailed {
			return ForkSessionResult{Operation: recorded},
				errors.Join(ErrSessionForkFailed, dispatchErr)
		}
		return ForkSessionResult{Operation: recorded},
			errors.Join(ErrSessionForkDeliveryUnknown, dispatchErr)
	}
	if providerResult.StateBindingMode == SessionForkStateBindingHostCopy &&
		h.sessionForkState == nil {
		bindErr := errors.New("provider child state binding is unavailable")
		recorded, _, recordErr := h.sessionForks.RecordSessionForkProviderResult(
			checkpointCtx,
			storesqlite.SessionForkProviderResult{
				WorkspaceID:             operation.WorkspaceID,
				OperationID:             operation.OperationID,
				Status:                  storesqlite.SessionForkStatusUnknown,
				TargetProviderSessionID: targetProviderSessionID,
				LastError:               bindErr.Error(),
				OccurredAtUnixMS:        h.now().UnixMilli(),
			},
		)
		if recordErr != nil {
			return ForkSessionResult{Operation: operation},
				errors.Join(ErrSessionForkDeliveryUnknown, bindErr, recordErr)
		}
		return ForkSessionResult{Operation: recorded},
			errors.Join(ErrSessionForkDeliveryUnknown, bindErr)
	}
	if providerResult.StateBindingMode == SessionForkStateBindingHostCopy {
		bindErr := h.sessionForkState.BindSessionForkProviderState(
			checkpointCtx,
			SessionForkProviderStateBinding{
				WorkspaceID:             operation.WorkspaceID,
				Provider:                source.Provider,
				SourceAgentSessionID:    operation.SourceAgentSessionID,
				TargetAgentSessionID:    operation.TargetAgentSessionID,
				SourceProviderSessionID: operation.SourceProviderSessionID,
				TargetProviderSessionID: targetProviderSessionID,
			},
		)
		if bindErr != nil {
			recorded, _, recordErr := h.sessionForks.RecordSessionForkProviderResult(
				checkpointCtx,
				storesqlite.SessionForkProviderResult{
					WorkspaceID:             operation.WorkspaceID,
					OperationID:             operation.OperationID,
					Status:                  storesqlite.SessionForkStatusUnknown,
					TargetProviderSessionID: targetProviderSessionID,
					LastError:               "provider child state could not be bound to target runtime: " + bindErr.Error(),
					OccurredAtUnixMS:        h.now().UnixMilli(),
				},
			)
			if recordErr != nil {
				return ForkSessionResult{Operation: operation},
					errors.Join(ErrSessionForkDeliveryUnknown, bindErr, recordErr)
			}
			return ForkSessionResult{Operation: recorded},
				errors.Join(ErrSessionForkDeliveryUnknown, bindErr)
		}
	}
	operation, _, err = h.sessionForks.RecordSessionForkProviderResult(
		checkpointCtx, storesqlite.SessionForkProviderResult{
			WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
			Status:                  storesqlite.SessionForkStatusProviderAccepted,
			TargetProviderSessionID: targetProviderSessionID,
			TargetProviderTurnIDs:   append([]string(nil), providerResult.TargetProviderTurnIDs...),
			StateBindingMode:        string(providerResult.StateBindingMode),
			StateBindingReceipt:     providerResult.StateBindingReceipt,
			OccurredAtUnixMS:        h.now().UnixMilli(),
		},
	)
	if err != nil {
		return ForkSessionResult{Operation: operation},
			errors.Join(ErrSessionForkDeliveryUnknown, err)
	}
	return h.processSessionForkOperation(checkpointCtx, operation)
}

func (h *Host) prepareSessionForkTargetContext(
	ctx context.Context,
	source storesqlite.Session,
	runtimeSource ProviderRuntimeSession,
) (SessionForkTargetContext, error) {
	if h != nil && h.sessionForkContext != nil {
		target, err := h.sessionForkContext.PrepareSessionForkTargetContext(
			ctx, source, cloneSessionForkRuntimeSource(runtimeSource),
		)
		if err != nil {
			return SessionForkTargetContext{}, err
		}
		target.Cwd = strings.TrimSpace(target.Cwd)
		target.RuntimeContext = cloneMap(target.RuntimeContext)
		return target, nil
	}
	return SessionForkTargetContext{
		Cwd:            strings.TrimSpace(runtimeSource.Cwd),
		RuntimeContext: cloneMap(runtimeSource.RuntimeContext),
	}, nil
}

func preparedSessionForkSettings(
	source map[string]any,
	prepared *ComposerSettings,
) map[string]any {
	result := cloneMap(source)
	if result == nil {
		result = make(map[string]any)
	}
	if prepared == nil {
		return result
	}
	result["model"] = prepared.Model
	result["modelPlanId"] = prepared.ModelPlanID
	result["permissionModeId"] = prepared.PermissionModeID
	result["planMode"] = prepared.PlanMode
	if prepared.BrowserUse != nil {
		result["browserUse"] = *prepared.BrowserUse
	} else {
		delete(result, "browserUse")
	}
	if prepared.ComputerUse != nil {
		result["computerUse"] = *prepared.ComputerUse
	} else {
		delete(result, "computerUse")
	}
	result["reasoningEffort"] = prepared.ReasoningEffort
	result["speed"] = prepared.Speed
	result["conversationDetailMode"] = prepared.ConversationDetailMode
	return result
}

func (h *Host) failPreparedSessionFork(
	ctx context.Context,
	operation storesqlite.SessionForkOperation,
	message string,
	cause error,
) (ForkSessionResult, error) {
	failed, _, err := h.sessionForks.FailPreparedSessionFork(
		ctx,
		operation.WorkspaceID,
		operation.OperationID,
		message,
		h.now().UnixMilli(),
	)
	if err != nil {
		return ForkSessionResult{Operation: operation}, errors.Join(cause, err)
	}
	return ForkSessionResult{Operation: failed}, cause
}

func (h *Host) sessionForkResult(
	ctx context.Context,
	operation storesqlite.SessionForkOperation,
) (ForkSessionResult, error) {
	result := ForkSessionResult{Operation: operation}
	if operation.Status != storesqlite.SessionForkStatusCommitted {
		return result, nil
	}
	committed, err := h.sessionForks.CommitSessionFork(
		ctx,
		operation.WorkspaceID,
		operation.OperationID,
		h.now().UnixMilli(),
	)
	if err != nil {
		return result, err
	}
	result.Session = committed.Session
	lineage := committed.Lineage
	result.Lineage = &lineage
	return result, nil
}

func (h *Host) sessionForkRuntimeSource(
	ctx context.Context,
	session storesqlite.Session,
) (ProviderRuntimeSession, error) {
	if h != nil && h.runtime != nil {
		if live, found := h.runtime.Session(session.WorkspaceID, session.ID); found {
			return cloneSessionForkRuntimeSource(live), nil
		}
	}
	settings := composerSettingsFromMap(session.Settings)
	prepared := PreparedRuntime{Cwd: strings.TrimSpace(session.Cwd)}
	if h != nil && h.preparation != nil {
		var err error
		prepared, err = h.preparation.Prepare(
			ctx,
			resumePreparationInput(session, settings),
		)
		if err != nil {
			return ProviderRuntimeSession{}, err
		}
	}
	if prepared.Settings != nil {
		settings = *prepared.Settings
	}
	return ProviderRuntimeSession{
		ID: session.ID, WorkspaceID: session.WorkspaceID, UserID: session.UserID,
		AgentTargetID: session.AgentTargetID, Provider: session.Provider,
		ProviderSessionID: session.ProviderSessionID, Resumable: true,
		Cwd: prepared.Cwd, Env: append([]string(nil), prepared.Env...),
		ProviderTargetRef: cloneMap(prepared.ProviderTargetRef), Settings: &settings,
		RuntimeContext: cloneMap(firstMap(
			prepared.RuntimeContext,
			session.InternalRuntimeContext,
		)),
		Status: persistedRuntimeStatus(session.ActiveTurnID), Title: session.Title,
		PinnedAtUnixMS: session.PinnedAtUnixMS, CreatedAtUnixMS: session.CreatedAtUnixMS,
		UpdatedAtUnixMS: session.UpdatedAtUnixMS,
	}, nil
}

func cloneSessionForkRuntimeSource(source ProviderRuntimeSession) ProviderRuntimeSession {
	source.Env = append([]string(nil), source.Env...)
	source.ProviderTargetRef = cloneMap(source.ProviderTargetRef)
	source.RuntimeContext = cloneMap(source.RuntimeContext)
	if source.Settings != nil {
		settings := *source.Settings
		source.Settings = &settings
	}
	return source
}

func normalizeForkSessionInput(input *ForkSessionInput) {
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.SourceAgentSessionID = strings.TrimSpace(input.SourceAgentSessionID)
	input.TargetAgentSessionID = strings.TrimSpace(input.TargetAgentSessionID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	input.Point.Kind = SessionForkPointKind(strings.TrimSpace(string(input.Point.Kind)))
	input.Point.TurnID = strings.TrimSpace(input.Point.TurnID)
	input.ThroughTurnID = strings.TrimSpace(input.ThroughTurnID)
	if input.Point.Kind == "" && input.ThroughTurnID != "" {
		input.Point = SessionForkPoint{
			Kind:   SessionForkPointThroughTurn,
			TurnID: input.ThroughTurnID,
		}
	}
	input.ThroughTurnID = input.Point.TurnID
}

func normalizeSessionForkCapabilityInput(input *SessionForkCapabilityInput) {
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.SourceAgentSessionID = strings.TrimSpace(input.SourceAgentSessionID)
}

func hashForkSessionInput(input ForkSessionInput) (string, error) {
	value, err := json.Marshal(struct {
		WorkspaceID          string           `json:"workspaceId"`
		SourceAgentSessionID string           `json:"sourceAgentSessionId"`
		TargetAgentSessionID string           `json:"targetAgentSessionId"`
		Point                SessionForkPoint `json:"point"`
	}{
		WorkspaceID: input.WorkspaceID, SourceAgentSessionID: input.SourceAgentSessionID,
		TargetAgentSessionID: input.TargetAgentSessionID, Point: input.Point,
	})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:]), nil
}
