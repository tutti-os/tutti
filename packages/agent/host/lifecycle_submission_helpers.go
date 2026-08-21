package agenthost

import (
	"context"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func (h *Host) requireSendAllowedByEffectiveHistory(ctx context.Context, ref SessionRef) error {
	if h == nil || h.effectiveHistory == nil {
		return nil
	}
	history, found, err := h.effectiveHistory.GetSessionHistory(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil || !found || history.RecoveryState == storesqlite.SessionHistoryRecoveryReady {
		return err
	}
	if h.editRetryDisabled {
		// Durable edit-retry is neutralized, so a fence whose owning operation is
		// no longer in flight can never clear through the saga (recovery only
		// quarantines claimable operations; a previously failed one is invisible
		// to it). Heal it here so the session is not send-blocked forever; if the
		// clear does not apply (operation still in flight), fall through to the
		// normal fence error.
		if cleared, clearErr := h.effectiveHistory.ClearAbandonedEditRetryFence(ctx, storesqlite.ClearAbandonedEditRetryFenceInput{
			WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID, NowUnixMS: h.now().UnixMilli(),
		}); clearErr == nil && cleared {
			return nil
		}
	}
	switch history.RecoveryState {
	case storesqlite.SessionHistoryRecoveryRollbackPending:
		return ErrEditRetryInProgress
	case storesqlite.SessionHistoryRecoveryRequired:
		return ErrEditRetryRecoveryRequired
	default:
		return ErrEditRetryResendPending
	}
}
