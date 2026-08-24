package agenthost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
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
	return h.forkSessionSerialized(ctx, input)
}

func (h *Host) forkSessionSerialized(
	ctx context.Context,
	input ForkSessionInput,
) (ForkSessionResult, error) {
	requestHash, err := hashForkSessionInput(input)
	if err != nil {
		return ForkSessionResult{}, err
	}
	if existing, found, err := h.sessionForks.GetSessionForkOperationByRequest(
		ctx, input.WorkspaceID, input.RequestID,
	); err != nil {
		return ForkSessionResult{}, err
	} else if found {
		if existing.RequestHash != requestHash {
			return ForkSessionResult{Operation: existing}, storesqlite.ErrSessionForkRequestConflict
		}
		if input.Asynchronous &&
			existing.Status != storesqlite.SessionForkStatusCommitted {
			return ForkSessionResult{Operation: existing}, nil
		}
		return h.processSessionForkOperation(ctx, existing)
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
	if !supported &&
		boundary.RejectionReason == storesqlite.SessionForkBoundaryReasonProviderTurnMissing {
		if err := h.recoverSessionForkTurnBinding(
			ctx,
			input.WorkspaceID,
			input.SourceAgentSessionID,
			input.Point.TurnID,
		); err != nil {
			slog.Warn(
				"agent session fork provider turn binding recovery failed",
				"workspace_id", input.WorkspaceID,
				"agent_session_id", input.SourceAgentSessionID,
				"turn_id", input.Point.TurnID,
				"boundary_reason", boundary.RejectionReason,
				"error", err,
			)
			if rejectionErr := boundary.RejectionError(); rejectionErr != nil {
				return ForkSessionResult{}, rejectionErr
			}
			return ForkSessionResult{}, storesqlite.ErrSessionForkTurnState
		}
		boundary, supported, err = h.sessionForks.CheckSessionForkThroughTurn(
			ctx,
			input.WorkspaceID,
			input.SourceAgentSessionID,
			input.Point.TurnID,
		)
		if err != nil {
			return ForkSessionResult{}, err
		}
	}
	if !supported {
		if rejectionErr := boundary.RejectionError(); rejectionErr != nil {
			return ForkSessionResult{}, rejectionErr
		}
		return ForkSessionResult{}, fmt.Errorf(
			"resolve selected provider fork binding for turn %q: %w",
			input.Point.TurnID,
			storesqlite.ErrSessionForkTurnState,
		)
	}
	runtimeSource, err := h.sessionForkRuntimeSource(ctx, boundary.Session)
	if err != nil {
		return ForkSessionResult{}, err
	}
	if strings.TrimSpace(runtimeSource.ProviderSessionID) !=
		strings.TrimSpace(boundary.Session.ProviderSessionID) {
		return ForkSessionResult{}, ErrSessionForkFailed
	}
	forkable, err := h.sessionForkRuntime.CanForkProviderTurn(
		ctx,
		RuntimeProviderTurnForkabilityInput{
			Source:                  cloneSessionForkRuntimeSource(runtimeSource),
			CanonicalTurnID:         boundary.Turn.TurnID,
			ProviderTurnID:          boundary.Turn.RootProviderTurnID,
			ProviderTurnBindingJSON: append([]byte(nil), boundary.Turn.ProviderTurnBindingJSON...),
		},
	)
	if err != nil {
		return ForkSessionResult{}, err
	}
	if !forkable {
		if recoveryErr := h.recoverSessionForkTurnBinding(
			ctx,
			input.WorkspaceID,
			input.SourceAgentSessionID,
			input.Point.TurnID,
		); recoveryErr == nil {
			boundary, supported, err = h.sessionForks.CheckSessionForkThroughTurn(
				ctx,
				input.WorkspaceID,
				input.SourceAgentSessionID,
				input.Point.TurnID,
			)
			if err != nil {
				return ForkSessionResult{}, err
			}
			if supported {
				forkable, err = h.sessionForkRuntime.CanForkProviderTurn(
					ctx,
					RuntimeProviderTurnForkabilityInput{
						Source:                  cloneSessionForkRuntimeSource(runtimeSource),
						CanonicalTurnID:         boundary.Turn.TurnID,
						ProviderTurnID:          boundary.Turn.RootProviderTurnID,
						ProviderTurnBindingJSON: append([]byte(nil), boundary.Turn.ProviderTurnBindingJSON...),
					},
				)
				if err != nil {
					return ForkSessionResult{}, err
				}
			}
		}
		if !forkable {
			return ForkSessionResult{}, storesqlite.ErrSessionForkTurnState
		}
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
		TargetCwd:            targetContext.Cwd,
		TargetRuntimeContext: targetContext.RuntimeContext,
		TargetSettings: preparedSessionForkSettings(
			boundary.Session.Settings,
			runtimeSource.Settings,
		),
		OccurredAtUnixMS: h.now().UnixMilli(),
	})
	if err != nil {
		return ForkSessionResult{}, fmt.Errorf("freeze session fork snapshot: %w", err)
	}
	if attachmentStore, ok := h.sessionForks.(SessionForkAttachmentStore); ok {
		bindings, bindingErr := attachmentStore.ListSessionForkAttachmentBindings(
			ctx,
			operation.WorkspaceID,
			operation.OperationID,
		)
		if bindingErr != nil {
			return h.failPreparedSessionFork(
				ctx,
				operation,
				"session fork attachment manifest could not be read",
				bindingErr,
			)
		}
		if len(bindings) != 0 {
			if h.sessionForkAttachments == nil {
				return h.failPreparedSessionFork(
					ctx,
					operation,
					"session fork attachments cannot be staged",
					errors.New("session fork attachment stager is unavailable"),
				)
			}
			if stageErr := h.sessionForkAttachments.StageSessionForkAttachments(
				ctx,
				operation.WorkspaceID,
				operation.SourceAgentSessionID,
				operation.TargetAgentSessionID,
				bindings,
			); stageErr != nil {
				return h.failPreparedSessionFork(
					ctx,
					operation,
					"session fork attachments could not be staged",
					stageErr,
				)
			}
		}
	}
	if input.Asynchronous {
		backgroundCtx := context.WithoutCancel(ctx)
		source := cloneSessionForkRuntimeSource(runtimeSource)
		go func() {
			_, _ = h.processSessionForkOperationWithSource(
				backgroundCtx,
				operation,
				&source,
			)
		}()
		return ForkSessionResult{Operation: operation}, nil
	}
	result, err := h.processSessionForkOperationWithSource(
		ctx,
		operation,
		&runtimeSource,
	)
	if err != nil {
		return result, fmt.Errorf("execute session fork operation: %w", err)
	}
	return result, nil
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
		op.Status == storesqlite.SessionForkStatusUnknown {
		return ForkSessionResult{Operation: op}, true, nil
	}
	if op.Status == storesqlite.SessionForkStatusProviderAccepted {
		result, processErr := h.processSessionForkOperation(ctx, op)
		if processErr == nil {
			return result, true, nil
		}

		// The provider result is already durable, so a local commit failure is
		// safe to retry. Return the latest accepted snapshot instead of turning
		// an observable operation into a transport failure; the next GET will
		// reconcile it again.
		current, currentFound, readErr := h.sessionForks.GetSessionForkOperation(
			ctx, op.WorkspaceID, op.OperationID,
		)
		if readErr != nil {
			return ForkSessionResult{}, true, errors.Join(processErr, readErr)
		}
		if !currentFound {
			return ForkSessionResult{}, false, processErr
		}
		result, readErr = h.sessionForkResult(ctx, current)
		return result, true, readErr
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
	operation, found, _, err := h.sessionForks.AcknowledgeSessionForkOperation(
		ctx,
		workspaceID,
		operationID,
		h.now().UnixMilli(),
	)
	if err != nil || !found {
		return ForkSessionResult{}, found, err
	}
	result, err := h.sessionForkResult(ctx, operation)
	return result, true, err
}

func (h *Host) processSessionForkOperation(
	ctx context.Context,
	operation storesqlite.SessionForkOperation,
) (ForkSessionResult, error) {
	return h.processSessionForkOperationWithSource(
		ctx,
		operation,
		nil,
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
) (ForkSessionResult, error) {
	switch operation.Status {
	case storesqlite.SessionForkStatusCommitted:
		return h.sessionForkResult(ctx, operation)
	case storesqlite.SessionForkStatusProviderAccepted:
		if operation.StateBindingMode == string(SessionForkStateBindingHostCopy) {
			sourceSession, found, err := h.sessionForks.GetSessionForkSource(
				ctx, operation.WorkspaceID, operation.SourceAgentSessionID,
			)
			if err != nil || !found {
				return ForkSessionResult{Operation: operation}, errors.Join(
					ErrSessionForkFailed, err,
				)
			}
			if h.sessionForkState == nil {
				return ForkSessionResult{Operation: operation},
					errors.New("provider child state binding is unavailable")
			}
			if err := h.sessionForkState.BindSessionForkProviderState(
				ctx,
				SessionForkProviderStateBinding{
					WorkspaceID:             operation.WorkspaceID,
					Provider:                sourceSession.Provider,
					SourceAgentSessionID:    operation.SourceAgentSessionID,
					TargetAgentSessionID:    operation.TargetAgentSessionID,
					SourceProviderSessionID: operation.SourceProviderSessionID,
					TargetProviderSessionID: operation.TargetProviderSessionID,
				},
			); err != nil {
				return ForkSessionResult{Operation: operation}, fmt.Errorf(
					"bind accepted provider child state: %w",
					err,
				)
			}
		}
		now := h.now().UnixMilli()
		commit, err := h.sessionForks.CommitSessionFork(
			ctx, operation.WorkspaceID, operation.OperationID, now,
		)
		if err != nil {
			if errors.Is(err, storesqlite.ErrSessionForkMaterializationInconsistent) {
				failed, _, failErr := h.sessionForks.FailAcceptedSessionFork(
					ctx,
					operation.WorkspaceID,
					operation.OperationID,
					err.Error(),
					now,
				)
				if failErr != nil {
					return ForkSessionResult{Operation: operation}, fmt.Errorf(
						"quarantine permanently inconsistent accepted session fork: %w",
						failErr,
					)
				}
				logQuarantinedSessionFork(ctx, failed, err)
				return ForkSessionResult{Operation: failed}, errors.Join(
					ErrSessionForkFailed,
					fmt.Errorf("materialize accepted session fork: %w", err),
				)
			}
			return ForkSessionResult{Operation: operation}, fmt.Errorf(
				"materialize accepted session fork: %w",
				err,
			)
		}
		lineage := commit.Lineage
		return ForkSessionResult{
			Operation: commit.Operation, Session: commit.Session, Lineage: &lineage,
		}, nil
	case storesqlite.SessionForkStatusDispatching:
		return ForkSessionResult{Operation: operation}, ErrSessionForkInProgress
	case storesqlite.SessionForkStatusFailed:
		return ForkSessionResult{Operation: operation}, ErrSessionForkFailed
	case storesqlite.SessionForkStatusUnknown:
		return ForkSessionResult{Operation: operation}, ErrSessionForkDeliveryUnknown
	case storesqlite.SessionForkStatusPrepared:
	default:
		return ForkSessionResult{Operation: operation}, storesqlite.ErrSessionForkTransition
	}
	failBeforeDispatch := func(
		message string,
		cause error,
	) (ForkSessionResult, error) {
		return h.failPreparedSessionFork(ctx, operation, message, cause)
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
		cause := storesqlite.ErrSessionForkTurnState
		if rejectionErr := boundary.RejectionError(); rejectionErr != nil {
			cause = rejectionErr
		}
		return failBeforeDispatch(
			"canonical through-turn boundary is no longer forkable",
			cause,
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
	providerResult, dispatchErr := h.sessionForkRuntime.ForkSession(
		ctx, RuntimeSessionForkInput{
			Source:                        cloneSessionForkRuntimeSource(source),
			SourceProviderTurnID:          operation.SourceProviderTurnID,
			SourceProviderTurnBindingJSON: append([]byte(nil), operation.SourceProviderTurnBindingJSON...),
			TargetTitle:                   operation.TargetTitle,
			RequestID:                     operation.RequestID,
			Driver:                        descriptor,
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
		providerResult.StateBindingMode != descriptor.StateBindingMode ||
		!validSessionForkProviderResult(providerResult) {
		message := "provider fork result was invalid"
		status := storesqlite.SessionForkStatusUnknown
		if dispatchErr != nil {
			message = dispatchErr.Error()
			if errors.Is(dispatchErr, ErrSessionForkUnsupported) ||
				providerResult.DeliveryDisposition == SessionForkDeliveryNotStarted ||
				providerResult.DeliveryDisposition == SessionForkDeliveryRejected {
				status = storesqlite.SessionForkStatusFailed
			}
		} else if providerResult.DeliveryDisposition == SessionForkDeliveryNotStarted ||
			providerResult.DeliveryDisposition == SessionForkDeliveryRejected {
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
	operation, _, err = h.sessionForks.RecordSessionForkProviderResult(
		checkpointCtx, storesqlite.SessionForkProviderResult{
			WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
			Status:                  storesqlite.SessionForkStatusProviderAccepted,
			TargetProviderSessionID: targetProviderSessionID,
			TargetProviderTurnBindings: storeSessionForkProviderTurnBindings(
				providerResult.TargetProviderTurnBindings,
			),
			StateBindingMode:    string(providerResult.StateBindingMode),
			StateBindingReceipt: providerResult.StateBindingReceipt,
			OccurredAtUnixMS:    h.now().UnixMilli(),
		},
	)
	if err != nil {
		return ForkSessionResult{Operation: operation},
			errors.Join(ErrSessionForkDeliveryUnknown, err)
	}
	return h.processSessionForkOperation(checkpointCtx, operation)
}

func storeSessionForkProviderTurnBindings(
	bindings []SessionForkProviderTurnBinding,
) []storesqlite.SessionForkProviderTurnBinding {
	result := make(
		[]storesqlite.SessionForkProviderTurnBinding,
		0,
		len(bindings),
	)
	for _, binding := range bindings {
		result = append(result, storesqlite.SessionForkProviderTurnBinding{
			ProviderTurnID: strings.TrimSpace(binding.ProviderTurnID),
			ProviderTurnBindingJSON: append(
				[]byte(nil),
				binding.ProviderTurnBindingJSON...,
			),
		})
	}
	return result
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
			cloned := cloneSessionForkRuntimeSource(live)
			var err error
			cloned.Env, err = runtimeEnvironmentForCanonicalSession(cloned.Env, cloned.Cwd, session)
			if err != nil {
				return ProviderRuntimeSession{}, err
			}
			return cloned, nil
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
	runtimeEnv, err := runtimeEnvironmentForCanonicalSession(prepared.Env, prepared.Cwd, session)
	if err != nil {
		return ProviderRuntimeSession{}, err
	}
	prepared.Env = runtimeEnv
	return ProviderRuntimeSession{
		ID: session.ID, WorkspaceID: session.WorkspaceID, UserID: session.UserID,
		AgentTargetID: session.AgentTargetID, Provider: session.Provider,
		ProviderSessionID: session.ProviderSessionID, Resumable: true,
		Cwd: prepared.Cwd, Env: append([]string(nil), prepared.Env...), MCPServers: cloneHostMCPServerBindings(prepared.MCPServers),
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
	source.MCPServers = cloneHostMCPServerBindings(source.MCPServers)
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
