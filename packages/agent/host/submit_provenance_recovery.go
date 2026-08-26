package agenthost

import (
	"context"
	"errors"
	"strings"
	"time"
)

// cleanupFailedRuntimeResume releases live resources created by a failed
// resume attempt without deleting the provider state needed by a later retry.
func (h *Host) cleanupFailedRuntimeResume(
	ctx context.Context,
	ref SessionRef,
	provider string,
	cause error,
) error {
	if h.preparation == nil {
		return cause
	}
	return h.cleanupPreparedRuntime(
		ctx,
		cause,
		ref.WorkspaceID,
		ref.AgentSessionID,
		provider,
		true,
	)
}

func (h *Host) discardRejectedPreparedRuntime(
	ctx context.Context,
	cause error,
	workspaceID string,
	agentSessionID string,
	provider string,
) error {
	return h.cleanupPreparedRuntime(ctx, cause, workspaceID, agentSessionID, provider, false)
}

func (h *Host) cleanupPreparedRuntime(
	ctx context.Context,
	cause error,
	workspaceID string,
	agentSessionID string,
	provider string,
	preserveRecoverableState bool,
) error {
	cleanupBaseCtx := context.WithoutCancel(ctx)
	cleanupErrs := []error{cause}
	if h.runtime != nil {
		closeCtx, cancelClose := context.WithTimeout(cleanupBaseCtx, 10*time.Second)
		cleanupErrs = append(cleanupErrs, h.runtime.Close(closeCtx, RuntimeCloseInput{
			WorkspaceID:            workspaceID,
			AgentSessionID:         agentSessionID,
			PreserveCanonicalState: true,
		}))
		cancelClose()
	}
	if h.preparation != nil {
		preparationCtx, cancelPreparation := context.WithTimeout(cleanupBaseCtx, 10*time.Second)
		cleanupErrs = append(cleanupErrs, h.preparation.Cleanup(preparationCtx, RuntimeCleanupInput{
			WorkspaceID: workspaceID, AgentSessionID: agentSessionID, Provider: provider,
			PreserveRecoverableState: preserveRecoverableState,
		}))
		cancelPreparation()
	}
	return errors.Join(cleanupErrs...)
}

func (h *Host) persistRuntimeSubmitOutcome(
	ctx context.Context,
	ref SessionRef,
	result RuntimeExecResult,
	clientSubmitID string,
	occurredAtUnixMS int64,
	prepared preparedPromptContent,
	displayPrompt string,
	capabilityRefs []CapabilityReference,
	metadata map[string]any,
	tuttiModeSnapshot *TuttiModeTurnSnapshot,
) error {
	return h.persistSubmitAfterRuntimeOutcome(
		ctx,
		ref.WorkspaceID,
		ref.AgentSessionID,
		result.TurnID,
		clientSubmitID,
		occurredAtUnixMS,
		prepared.Hydrated,
		prepared.Persisted,
		displayPrompt,
		false,
		capabilityRefs,
		metadata,
		tuttiModeSnapshot,
	)
}

// persistSubmitAfterRuntimeOutcome records the user-owned submit facts after
// Exec has returned a delivery error. The runtime may have kept working on an
// independent context, so the caller's cancellation must not erase the prompt
// or its replay envelope while the outcome is being reconciled.
func (h *Host) persistSubmitAfterRuntimeOutcome(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	turnID string,
	clientSubmitID string,
	occurredAtUnixMS int64,
	hydratedContent []PromptContentBlock,
	persistedContent []PromptContentBlock,
	displayPrompt string,
	guidance bool,
	capabilityRefs []CapabilityReference,
	metadata map[string]any,
	tuttiModeSnapshot *TuttiModeTurnSnapshot,
) error {
	if h == nil || strings.TrimSpace(turnID) == "" {
		return nil
	}
	if occurredAtUnixMS <= 0 {
		occurredAtUnixMS = h.now().UnixMilli()
	}
	persistCtx, cancel := context.WithTimeout(
		context.WithoutCancel(ctx),
		10*time.Second,
	)
	defer cancel()

	if reporter, ok := h.runtime.(RuntimeSubmitProvenanceReporter); ok {
		if err := reporter.DurablyReportSubmitProvenance(persistCtx, RuntimeSubmitProvenanceInput{
			WorkspaceID:                     workspaceID,
			AgentSessionID:                  agentSessionID,
			TurnID:                          turnID,
			ClientSubmitID:                  clientSubmitID,
			CanonicalSubmitOccurredAtUnixMS: occurredAtUnixMS,
			Content:                         hydratedContent,
			DisplayPrompt:                   displayPrompt,
			Guidance:                        guidance,
		}); err != nil {
			return err
		}
	}
	return h.recordTurnSubmission(
		persistCtx,
		SessionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID},
		turnID,
		clientSubmitID,
		persistedContent,
		displayPrompt,
		capabilityRefs,
		metadata,
		tuttiModeSnapshot,
	)
}
