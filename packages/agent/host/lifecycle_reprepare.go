package agenthost

import (
	"context"
	"errors"
	"strings"
	"time"
)

// ReprepareRuntimeSession replaces the live provider connection and its MCP
// bindings while preserving the canonical Session, history, and provider
// session identity. The operation is admitted only while both durable and
// runtime lifecycle state prove that the Session is idle.
func (h *Host) ReprepareRuntimeSession(
	ctx context.Context,
	input ReprepareRuntimeSessionInput,
) (ProviderRuntimeSession, error) {
	var result ProviderRuntimeSession
	err := h.withSessionMutationActor(ctx, input.WorkspaceID, input.AgentSessionID, func(actorCtx context.Context) error {
		var reprepareErr error
		result, reprepareErr = h.reprepareRuntimeSession(actorCtx, input)
		return reprepareErr
	})
	return result, err
}

func (h *Host) reprepareRuntimeSession(
	ctx context.Context,
	input ReprepareRuntimeSessionInput,
) (ProviderRuntimeSession, error) {
	ref := SessionRef{
		WorkspaceID:    strings.TrimSpace(input.WorkspaceID),
		AgentSessionID: strings.TrimSpace(input.AgentSessionID),
	}
	if h == nil || h.runtime == nil || h.store == nil || h.preparation == nil ||
		ref.WorkspaceID == "" || ref.AgentSessionID == "" {
		return ProviderRuntimeSession{}, ErrInvalidArgument
	}
	release, err := h.acquireSession(ctx, ref)
	if err != nil {
		return ProviderRuntimeSession{}, err
	}
	defer release()

	deleted, err := h.store.SessionDeleted(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return ProviderRuntimeSession{}, err
	}
	if deleted {
		return ProviderRuntimeSession{}, ErrSessionNotFound
	}
	canonicalSession, found, err := h.store.GetSession(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return ProviderRuntimeSession{}, err
	}
	if !found || ResolveResumePolicy(canonicalSession).Mode == ResumeModeReject ||
		strings.TrimSpace(canonicalSession.ProviderSessionID) == "" {
		return ProviderRuntimeSession{}, ErrSessionNotFound
	}
	if strings.TrimSpace(canonicalSession.ActiveTurnID) != "" {
		return ProviderRuntimeSession{}, ErrRuntimeSessionActive
	}
	live, runtimeFound := h.runtime.Session(ref.WorkspaceID, ref.AgentSessionID)
	if runtimeFound && runtimeSessionHasActiveTurn(live) {
		return ProviderRuntimeSession{}, ErrRuntimeSessionActive
	}
	var repreparer RuntimeSessionRepreparer
	if runtimeFound {
		var ok bool
		repreparer, ok = h.runtime.(RuntimeSessionRepreparer)
		if !ok {
			return ProviderRuntimeSession{}, ErrRuntimeSessionReprepareUnavailable
		}
	}
	evidence, err := h.store.GetProviderSessionResumeEvidence(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return ProviderRuntimeSession{}, err
	}
	if !evidence.Established {
		return ProviderRuntimeSession{}, ErrProviderSessionNotEstablished
	}

	settings := composerSettingsFromMap(canonicalSession.Settings)
	preparationInput := resumePreparationInput(canonicalSession, settings)
	preparationInput.RuntimeContext = overlayRuntimeContext(
		canonicalSession.InternalRuntimeContext,
		input.RuntimeContextOverlay,
	)
	prepared, err := h.preparation.Prepare(ctx, preparationInput)
	if err != nil {
		return ProviderRuntimeSession{}, err
	}
	if prepared.Settings != nil {
		settings = *prepared.Settings
	}
	goalGenerationFences, err := h.listRuntimeGoalGenerationFences(ctx, ref)
	if err != nil {
		return ProviderRuntimeSession{}, h.cleanupFailedReprepare(ctx, ref, canonicalSession.Provider, err)
	}
	releaseStartup, err := h.acquireStartup(ctx, canonicalSession.Provider)
	if err != nil {
		return ProviderRuntimeSession{}, h.cleanupFailedReprepare(ctx, ref, canonicalSession.Provider, err)
	}
	defer releaseStartup()
	resumeInput := RuntimeResumeInput{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		AgentTargetID: strings.TrimSpace(canonicalSession.AgentTargetID), Provider: strings.TrimSpace(canonicalSession.Provider),
		ProviderSessionID: strings.TrimSpace(canonicalSession.ProviderSessionID), Resumable: true, Cwd: prepared.Cwd,
		Env: append([]string(nil), prepared.Env...), MCPServers: cloneHostMCPServerBindings(prepared.MCPServers), Title: strings.TrimSpace(canonicalSession.Title),
		Status: persistedRuntimeStatus(""), Settings: settings,
		CreatedAtUnixMS: canonicalSession.CreatedAtUnixMS, UpdatedAtUnixMS: canonicalSession.UpdatedAtUnixMS,
		Visible: boolPointer(canonicalSession.Metadata.Visible), RuntimeContext: cloneMap(canonicalSession.InternalRuntimeContext),
		ProviderLaunchRuntimeContext: cloneMap(firstMap(prepared.RuntimeContext, preparationInput.RuntimeContext)),
		ProviderTargetRef:            cloneMap(prepared.ProviderTargetRef), Metadata: canonicalSession.Metadata,
		InternalRuntimeContext: cloneMap(canonicalSession.InternalRuntimeContext),
		GoalGenerationFences:   append([]RuntimeGoalGenerationFenceInput(nil), goalGenerationFences...),
		RecreateIfMissing:      ResolveResumePolicy(canonicalSession).Mode == ResumeModeRecreate,
	}
	var result ProviderRuntimeSession
	if runtimeFound {
		result, err = repreparer.Reprepare(ctx, resumeInput)
	} else {
		result, err = h.runtime.Resume(ctx, resumeInput)
	}
	if err != nil {
		return ProviderRuntimeSession{}, h.cleanupFailedReprepare(ctx, ref, canonicalSession.Provider, err)
	}
	return result, nil
}

// ReprepareRuntimeSessionAndSendInput holds the canonical Session mutation
// actor across both provider replacement and Turn admission. The request-
// scoped provider binding therefore cannot be consumed by a competing Host
// mutation between those two operations.
func (h *Host) ReprepareRuntimeSessionAndSendInput(
	ctx context.Context,
	input ReprepareRuntimeSessionAndSendInputInput,
) (SendInputResult, error) {
	ref := SessionRef{
		WorkspaceID:    strings.TrimSpace(input.Reprepare.WorkspaceID),
		AgentSessionID: strings.TrimSpace(input.Reprepare.AgentSessionID),
	}
	if h == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" || input.Send.Guidance {
		return SendInputResult{}, ErrInvalidArgument
	}
	normalized, promptText, err := normalizePromptContent(input.Send.Content)
	if err != nil {
		return SendInputResult{}, err
	}
	if _, goalControl := ParseTypedGoalControl(normalized, false); goalControl {
		return SendInputResult{}, ErrInvalidArgument
	}
	metadata := submissionMetadata(input.Send.Metadata, input.Send.ClientSubmitID)
	var result SendInputResult
	err = h.withSessionMutationActor(ctx, ref.WorkspaceID, ref.AgentSessionID, func(actorCtx context.Context) error {
		if _, reprepareErr := h.reprepareRuntimeSession(actorCtx, input.Reprepare); reprepareErr != nil {
			return reprepareErr
		}
		var sendErr error
		result, sendErr = h.sendInputSerialized(actorCtx, ref, input.Send, normalized, promptText, metadata)
		if sendErr != nil && !errors.Is(sendErr, ErrSubmitDeliveryUnknown) {
			live, found := h.runtime.Session(ref.WorkspaceID, ref.AgentSessionID)
			if !found || !runtimeSessionHasActiveTurn(live) {
				cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(actorCtx), 10*time.Second)
				defer cancel()
				closeErr := h.runtime.Close(cleanupCtx, RuntimeCloseInput{
					WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
					PreserveCanonicalState: true,
				})
				sendErr = errors.Join(sendErr, closeErr)
			}
		}
		return sendErr
	})
	return result, err
}

func (h *Host) cleanupFailedReprepare(ctx context.Context, ref SessionRef, provider string, cause error) error {
	if h == nil || h.preparation == nil {
		return cause
	}
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	cleanupErr := h.preparation.Cleanup(cleanupCtx, RuntimeCleanupInput{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID, Provider: provider,
		PreserveRecoverableState: true,
	})
	return errors.Join(cause, cleanupErr)
}
