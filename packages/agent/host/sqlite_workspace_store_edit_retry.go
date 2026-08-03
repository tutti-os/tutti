package agenthost

import (
	"context"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func (s *SQLiteWorkspaceStore) editRetryStore(workspaceID string) (*storesqlite.Store, error) {
	return s.store(workspaceID)
}
func (s *SQLiteWorkspaceStore) MarkEditRetryRollbackDispatched(ctx context.Context, in storesqlite.MarkEditRetryRollbackDispatchedInput) (storesqlite.RuntimeOperation, bool, error) {
	st, e := s.editRetryStore(in.WorkspaceID)
	if e != nil {
		return storesqlite.RuntimeOperation{}, false, e
	}
	return st.MarkEditRetryRollbackDispatched(ctx, in)
}
func (s *SQLiteWorkspaceStore) PrepareEditRetry(ctx context.Context, in storesqlite.RuntimeOperationPrepare) (storesqlite.RuntimeOperation, bool, error) {
	st, e := s.editRetryStore(in.WorkspaceID)
	if e != nil {
		return storesqlite.RuntimeOperation{}, false, e
	}
	return st.PrepareEditRetry(ctx, in)
}
func (s *SQLiteWorkspaceStore) ConfirmEditRetryRollback(ctx context.Context, in storesqlite.ConfirmEditRetryRollbackInput) (storesqlite.RuntimeOperation, bool, error) {
	st, e := s.editRetryStore(in.WorkspaceID)
	if e != nil {
		return storesqlite.RuntimeOperation{}, false, e
	}
	return st.ConfirmEditRetryRollback(ctx, in)
}
func (s *SQLiteWorkspaceStore) AbortEditRetryRollback(ctx context.Context, in storesqlite.AbortEditRetryRollbackInput) (storesqlite.RuntimeOperation, bool, error) {
	st, e := s.editRetryStore(in.WorkspaceID)
	if e != nil {
		return storesqlite.RuntimeOperation{}, false, e
	}
	return st.AbortEditRetryRollback(ctx, in)
}
func (s *SQLiteWorkspaceStore) AuthorizeEditRetryReplacementRetry(ctx context.Context, in storesqlite.AuthorizeEditRetryReplacementRetryInput) (storesqlite.RuntimeOperation, bool, error) {
	st, e := s.editRetryStore(in.WorkspaceID)
	if e != nil {
		return storesqlite.RuntimeOperation{}, false, e
	}
	return st.AuthorizeEditRetryReplacementRetry(ctx, in)
}
func (s *SQLiteWorkspaceStore) ReconcileBlockedEditRetry(ctx context.Context, in storesqlite.ReconcileBlockedEditRetryInput) (storesqlite.RuntimeOperation, bool, error) {
	st, e := s.editRetryStore(in.WorkspaceID)
	if e != nil {
		return storesqlite.RuntimeOperation{}, false, e
	}
	return st.ReconcileBlockedEditRetry(ctx, in)
}
func (s *SQLiteWorkspaceStore) CompleteEditRetryRuntimeOperation(ctx context.Context, in storesqlite.CompleteEditRetryRuntimeOperationInput) (storesqlite.RuntimeOperationCompletion, bool, error) {
	st, e := s.editRetryStore(in.WorkspaceID)
	if e != nil {
		return storesqlite.RuntimeOperationCompletion{}, false, e
	}
	return st.CompleteEditRetryRuntimeOperation(ctx, in)
}
func (s *SQLiteWorkspaceStore) FailEditRetryRecovery(ctx context.Context, in storesqlite.FailEditRetryRecoveryInput) (storesqlite.RuntimeOperation, bool, error) {
	st, e := s.editRetryStore(in.WorkspaceID)
	if e != nil {
		return storesqlite.RuntimeOperation{}, false, e
	}
	return st.FailEditRetryRecovery(ctx, in)
}
func (s *SQLiteWorkspaceStore) BlockEditRetry(ctx context.Context, in storesqlite.BlockEditRetryInput) (storesqlite.RuntimeOperation, bool, error) {
	st, e := s.editRetryStore(in.WorkspaceID)
	if e != nil {
		return storesqlite.RuntimeOperation{}, false, e
	}
	return st.BlockEditRetry(ctx, in)
}
func (s *SQLiteWorkspaceStore) DeferEditRetry(ctx context.Context, in storesqlite.DeferEditRetryInput) (storesqlite.RuntimeOperation, bool, error) {
	st, e := s.editRetryStore(in.WorkspaceID)
	if e != nil {
		return storesqlite.RuntimeOperation{}, false, e
	}
	return st.DeferEditRetry(ctx, in)
}

func (s *SQLiteWorkspaceStore) CaptureEditRetryPreEffectSnapshot(ctx context.Context, in storesqlite.CaptureEditRetryPreEffectSnapshotInput) (storesqlite.RuntimeOperation, bool, error) {
	st, err := s.store(in.WorkspaceID)
	if err != nil {
		return storesqlite.RuntimeOperation{}, false, err
	}
	return st.CaptureEditRetryPreEffectSnapshot(ctx, in)
}
func (s *SQLiteWorkspaceStore) AbandonEditRetry(ctx context.Context, in storesqlite.AbandonEditRetryInput) (storesqlite.RuntimeOperation, bool, error) {
	st, e := s.editRetryStore(in.WorkspaceID)
	if e != nil {
		return storesqlite.RuntimeOperation{}, false, e
	}
	return st.AbandonEditRetry(ctx, in)
}
func (s *SQLiteWorkspaceStore) WakeDeferredEditRetry(ctx context.Context, in storesqlite.WakeDeferredEditRetryInput) (storesqlite.RuntimeOperation, bool, error) {
	st, e := s.editRetryStore(in.WorkspaceID)
	if e != nil {
		return storesqlite.RuntimeOperation{}, false, e
	}
	return st.WakeDeferredEditRetry(ctx, in)
}
func (s *SQLiteWorkspaceStore) GetRuntimeOperationRecoveryAction(ctx context.Context, workspaceID, operationID, clientActionID string) (storesqlite.RuntimeOperationRecoveryAction, bool, error) {
	st, e := s.editRetryStore(workspaceID)
	if e != nil {
		return storesqlite.RuntimeOperationRecoveryAction{}, false, e
	}
	return st.GetRuntimeOperationRecoveryAction(ctx, workspaceID, operationID, clientActionID)
}
func (s *SQLiteWorkspaceStore) ClearAbandonedEditRetryFence(ctx context.Context, in storesqlite.ClearAbandonedEditRetryFenceInput) (bool, error) {
	st, e := s.editRetryStore(in.WorkspaceID)
	if e != nil {
		return false, e
	}
	return st.ClearAbandonedEditRetryFence(ctx, in)
}
