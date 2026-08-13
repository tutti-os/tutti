package agenthost

import (
	"context"
	"errors"
	"time"
)

const (
	runtimeSessionPublishTimeout    = 5 * time.Second
	failedCreateLockTimeout         = 2 * time.Second
	failedCreateRuntimeCloseTimeout = 5 * time.Second
	failedCreateRollbackTimeout     = 3 * time.Second
	failedCreatePreparationTimeout  = 2 * time.Second
)

type failedCreateCleanupState struct {
	RuntimeStarted   bool
	CanonicalCreated bool
	SessionLockHeld  bool
}

func publishRuntimeSessionInitialization(
	ctx context.Context,
	publisher RuntimeSessionInitializationPublisher,
	input RuntimeSessionInitializationPublishInput,
) (ProviderRuntimeSession, error) {
	publishCtx, cancel := detachedPhaseContext(ctx, runtimeSessionPublishTimeout)
	defer cancel()
	return publisher.PublishSessionInitialization(publishCtx, input)
}

func (h *Host) cleanupFailedCreate(
	ctx context.Context,
	ref SessionRef,
	provider string,
	cause error,
	state failedCreateCleanupState,
) error {
	errs := []error{cause}
	closeRuntime := state.RuntimeStarted
	if closeRuntime && !state.SessionLockHeld {
		startedAt := h.now()
		lockCtx, cancel := detachedPhaseContext(ctx, failedCreateLockTimeout)
		release, err := h.acquireSession(lockCtx, ref)
		h.observeStep(lockCtx, "session_create_cleanup", "lifecycle_lock_acquired", ref.WorkspaceID, ref.AgentSessionID, provider, startedAt, err)
		cancel()
		if err != nil {
			errs = append(errs, err)
			closeRuntime = false
		} else {
			defer release()
		}
	}
	if closeRuntime {
		startedAt := h.now()
		closeCtx, cancel := detachedPhaseContext(ctx, failedCreateRuntimeCloseTimeout)
		err := h.runtime.Close(closeCtx, RuntimeCloseInput{
			WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		})
		h.observeStep(closeCtx, "session_create_cleanup", "runtime_closed", ref.WorkspaceID, ref.AgentSessionID, provider, startedAt, err)
		cancel()
		errs = append(errs, err)
	}
	if state.CanonicalCreated {
		startedAt := h.now()
		rollbackCtx, cancel := detachedPhaseContext(ctx, failedCreateRollbackTimeout)
		_, err := h.store.RollbackRuntimeSessionInitialization(
			rollbackCtx,
			ref.WorkspaceID,
			ref.AgentSessionID,
		)
		h.observeStep(rollbackCtx, "session_create_cleanup", "canonical_rolled_back", ref.WorkspaceID, ref.AgentSessionID, provider, startedAt, err)
		cancel()
		errs = append(errs, err)
	}
	if h.preparation != nil {
		startedAt := h.now()
		cleanupCtx, cancel := detachedPhaseContext(ctx, failedCreatePreparationTimeout)
		err := h.preparation.Cleanup(cleanupCtx, RuntimeCleanupInput{
			WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID, Provider: provider,
		})
		h.observeStep(cleanupCtx, "session_create_cleanup", "preparation_cleaned", ref.WorkspaceID, ref.AgentSessionID, provider, startedAt, err)
		cancel()
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

func detachedPhaseContext(parent context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(parent), timeout)
}
