package agenthost

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
)

type sideConversationRegistration struct {
	sourceID     string
	requestID    string
	status       string
	session      ProviderRuntimeSession
	capabilities SideConversationCapabilities
}

func sideConversationKey(workspaceID, sideAgentSessionID string) string {
	return strings.TrimSpace(workspaceID) + "\x00" +
		strings.TrimSpace(sideAgentSessionID)
}

func (h *Host) ResolveSideConversation(
	ctx context.Context,
	workspaceID string,
	sourceAgentSessionID string,
) (SideConversationCapabilities, error) {
	if h == nil || h.runtime == nil || h.sideRuntime == nil {
		return SideConversationCapabilities{}, ErrSideConversationUnsupported
	}
	workspaceID = strings.TrimSpace(workspaceID)
	sourceAgentSessionID = strings.TrimSpace(sourceAgentSessionID)
	source, err := h.sideSourceRuntime(workspaceID, sourceAgentSessionID)
	if err != nil {
		return SideConversationCapabilities{}, err
	}
	if source.Scope == RuntimeSessionScopeSide {
		return SideConversationCapabilities{}, ErrSideConversationUnsupported
	}
	return h.sideRuntime.ResolveSideConversation(ctx, source)
}

func (h *Host) sideSourceRuntime(
	workspaceID string,
	sourceAgentSessionID string,
) (ProviderRuntimeSession, error) {
	source, found := h.runtime.Session(workspaceID, sourceAgentSessionID)
	if !found {
		return ProviderRuntimeSession{}, ErrRuntimeSessionDisconnected
	}
	return source, nil
}

func (h *Host) OpenSideConversation(
	ctx context.Context,
	input OpenSideConversationInput,
) (OpenSideConversationResult, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	sourceID := strings.TrimSpace(input.SourceAgentSessionID)
	sideID := strings.TrimSpace(input.SideAgentSessionID)
	requestID := strings.TrimSpace(input.RequestID)
	if workspaceID == "" || sourceID == "" || sideID == "" || requestID == "" ||
		sourceID == sideID {
		return OpenSideConversationResult{}, ErrInvalidArgument
	}
	if h == nil || h.runtime == nil || h.sideRuntime == nil {
		return OpenSideConversationResult{}, ErrSideConversationUnsupported
	}
	input.WorkspaceID = workspaceID
	input.SourceAgentSessionID = sourceID
	input.SideAgentSessionID = sideID
	input.RequestID = requestID

	// Open mutates both identities: the source must remain the same live
	// session while the provider snapshots it, and Close/Send for the side
	// must not race the creating -> ready transition.
	sessionIDs := []string{sourceID, sideID}
	sort.Strings(sessionIDs)
	var result OpenSideConversationResult
	err := h.withSessionMutationActors(
		ctx,
		workspaceID,
		sessionIDs,
		func(actorCtx context.Context) error {
			var openErr error
			result, openErr = h.openSideConversation(actorCtx, input)
			return openErr
		},
	)
	return result, err
}

func (h *Host) openSideConversation(
	ctx context.Context,
	input OpenSideConversationInput,
) (OpenSideConversationResult, error) {
	workspaceID := input.WorkspaceID
	sourceID := input.SourceAgentSessionID
	sideID := input.SideAgentSessionID
	requestID := input.RequestID
	key := sideConversationKey(workspaceID, sideID)
	if h.store != nil {
		if _, found, err := h.store.GetSession(ctx, workspaceID, sideID); err != nil {
			return OpenSideConversationResult{}, err
		} else if found {
			return OpenSideConversationResult{}, ErrSideConversationConflict
		}
	}
	h.sideMu.Lock()
	if existing, found := h.sideConversations[key]; found {
		h.sideMu.Unlock()
		if existing.sourceID != sourceID || existing.requestID != requestID {
			return OpenSideConversationResult{}, ErrSideConversationConflict
		}
		if existing.status == "ready" {
			return OpenSideConversationResult{
				Session: existing.session, Capabilities: existing.capabilities,
			}, nil
		}
		return OpenSideConversationResult{}, ErrSideConversationInProgress
	}
	h.sideConversations[key] = sideConversationRegistration{
		sourceID: sourceID, requestID: requestID, status: "creating",
	}
	h.sideMu.Unlock()

	rollback := func() {
		h.sideMu.Lock()
		delete(h.sideConversations, key)
		h.sideMu.Unlock()
	}
	source, err := h.ensureSideSourceRuntimeLocked(ctx, workspaceID, sourceID)
	if err != nil {
		rollback()
		return OpenSideConversationResult{}, err
	}
	if source.Scope == RuntimeSessionScopeSide {
		rollback()
		return OpenSideConversationResult{}, ErrSideConversationUnsupported
	}
	capabilities, err := h.sideRuntime.ResolveSideConversation(ctx, source)
	if err != nil {
		rollback()
		return OpenSideConversationResult{}, err
	}
	if !validRequiredSideCapabilities(capabilities) ||
		(runtimeSessionHasActiveTurn(source) && !capabilities.ActiveSourceTurn) {
		rollback()
		return OpenSideConversationResult{}, ErrSideConversationUnsupported
	}
	result, err := h.sideRuntime.OpenSideConversation(
		ctx,
		RuntimeOpenSideConversationInput{
			Source: source, SideAgentSessionID: sideID, RequestID: requestID,
		},
	)
	if err != nil {
		rollback()
		return OpenSideConversationResult{}, err
	}
	if result.Session.ID != sideID ||
		result.Session.WorkspaceID != workspaceID ||
		result.Session.Scope != RuntimeSessionScopeSide ||
		result.Session.SourceAgentSessionID != sourceID {
		_ = h.runtime.Close(ctx, RuntimeCloseInput{
			WorkspaceID: workspaceID, AgentSessionID: sideID,
		})
		rollback()
		return OpenSideConversationResult{}, fmt.Errorf(
			"runtime returned an invalid side conversation: %w",
			ErrSideConversationConflict,
		)
	}
	if !validRequiredSideCapabilities(result.Capabilities) {
		_ = h.runtime.Close(ctx, RuntimeCloseInput{
			WorkspaceID: workspaceID, AgentSessionID: sideID,
		})
		rollback()
		return OpenSideConversationResult{}, ErrSideConversationUnsupported
	}
	h.sideMu.Lock()
	h.sideConversations[key] = sideConversationRegistration{
		sourceID: sourceID, requestID: requestID, status: "ready",
		session: result.Session, capabilities: result.Capabilities,
	}
	h.sideMu.Unlock()
	return result, nil
}

func (h *Host) ensureSideSourceRuntimeLocked(
	ctx context.Context,
	workspaceID string,
	sourceAgentSessionID string,
) (ProviderRuntimeSession, error) {
	_ = ctx
	return h.sideSourceRuntime(workspaceID, sourceAgentSessionID)
}

func (h *Host) SendSideConversation(
	ctx context.Context,
	input RuntimeExecInput,
) (RuntimeExecResult, error) {
	var result RuntimeExecResult
	err := h.withSessionMutationActor(
		ctx,
		input.WorkspaceID,
		input.AgentSessionID,
		func(actorCtx context.Context) error {
			if err := h.requireSideConversation(
				input.WorkspaceID, input.AgentSessionID,
			); err != nil {
				return err
			}
			if err := h.runtime.ValidatePromptContent(actorCtx, input); err != nil {
				return err
			}
			var execErr error
			result, execErr = h.runtime.Exec(actorCtx, input)
			return execErr
		},
	)
	return result, err
}

func (h *Host) CancelSideConversation(
	ctx context.Context,
	workspaceID string,
	sideAgentSessionID string,
	turnID string,
	reason string,
) (RuntimeCancelResult, error) {
	var result RuntimeCancelResult
	err := h.withSessionMutationActor(
		ctx,
		workspaceID,
		sideAgentSessionID,
		func(actorCtx context.Context) error {
			if err := h.requireSideConversation(workspaceID, sideAgentSessionID); err != nil {
				return err
			}
			var cancelErr error
			result, cancelErr = h.runtime.Cancel(actorCtx, RuntimeCancelInput{
				WorkspaceID: workspaceID, RootAgentSessionID: sideAgentSessionID,
				Targets: []RuntimeCancelTarget{{
					AgentSessionID: sideAgentSessionID, TurnID: turnID,
				}},
				Reason: reason,
			})
			return cancelErr
		},
	)
	return result, err
}

func (h *Host) SubmitSideConversationInteractive(
	ctx context.Context,
	input RuntimeSubmitInteractiveInput,
) (RuntimeSubmitInteractiveResult, error) {
	if input.RootAgentSessionID != input.AgentSessionID {
		return RuntimeSubmitInteractiveResult{}, ErrInvalidArgument
	}
	var result RuntimeSubmitInteractiveResult
	err := h.withSessionMutationActor(
		ctx,
		input.WorkspaceID,
		input.AgentSessionID,
		func(actorCtx context.Context) error {
			if err := h.requireSideConversation(
				input.WorkspaceID, input.AgentSessionID,
			); err != nil {
				return err
			}
			var submitErr error
			result, submitErr = h.runtime.SubmitInteractive(actorCtx, input)
			return submitErr
		},
	)
	return result, err
}

func (h *Host) CloseSideConversation(
	ctx context.Context,
	workspaceID string,
	sideAgentSessionID string,
) error {
	if h == nil {
		return nil
	}
	return h.withSessionMutationActor(
		ctx,
		workspaceID,
		sideAgentSessionID,
		func(actorCtx context.Context) error {
			return h.closeSideConversation(
				actorCtx,
				workspaceID,
				sideAgentSessionID,
			)
		},
	)
}

func (h *Host) closeSideConversation(
	ctx context.Context,
	workspaceID string,
	sideAgentSessionID string,
) error {
	key := sideConversationKey(workspaceID, sideAgentSessionID)
	h.sideMu.Lock()
	registration, found := h.sideConversations[key]
	h.sideMu.Unlock()
	if !found {
		return nil
	}
	session, live := h.runtime.Session(
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(sideAgentSessionID),
	)
	if !live ||
		session.Scope != RuntimeSessionScopeSide ||
		session.SourceAgentSessionID != registration.sourceID ||
		session.SideRequestID != registration.requestID {
		h.sideMu.Lock()
		delete(h.sideConversations, key)
		h.sideMu.Unlock()
		return ErrSideConversationExpired
	}
	err := h.runtime.Close(ctx, RuntimeCloseInput{
		WorkspaceID: workspaceID, AgentSessionID: sideAgentSessionID,
	})
	if err != nil && !errors.Is(err, ErrSideConversationExpired) {
		return err
	}
	h.sideMu.Lock()
	delete(h.sideConversations, key)
	h.sideMu.Unlock()
	return nil
}

func (h *Host) requireSideConversation(workspaceID, sideAgentSessionID string) error {
	if h == nil || h.runtime == nil {
		return ErrSideConversationExpired
	}
	key := sideConversationKey(workspaceID, sideAgentSessionID)
	h.sideMu.Lock()
	registration, found := h.sideConversations[key]
	h.sideMu.Unlock()
	if !found || registration.status != "ready" {
		return ErrSideConversationExpired
	}
	session, live := h.runtime.Session(
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(sideAgentSessionID),
	)
	if !live ||
		session.Scope != RuntimeSessionScopeSide ||
		session.SourceAgentSessionID != registration.sourceID ||
		session.SideRequestID != registration.requestID {
		return ErrSideConversationExpired
	}
	return nil
}

func validRequiredSideCapabilities(capabilities SideConversationCapabilities) bool {
	return capabilities.Supported &&
		capabilities.ActiveSourceTurn &&
		capabilities.Ephemeral &&
		capabilities.HideInheritedTurns &&
		capabilities.ModelBoundaryInjected
}
