package agenthost

import (
	"context"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func (s *SQLiteWorkspaceStore) GetSessionForkSource(
	ctx context.Context,
	workspaceID, sourceSessionID string,
) (storesqlite.Session, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.Session{}, false, err
	}
	return store.GetSessionForkSource(ctx, workspaceID, sourceSessionID)
}

func (s *SQLiteWorkspaceStore) CheckSessionForkThroughTurn(
	ctx context.Context,
	workspaceID, sourceSessionID, throughTurnID string,
) (storesqlite.SessionForkBoundary, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkBoundary{}, false, err
	}
	return store.CheckSessionForkThroughTurn(ctx, workspaceID, sourceSessionID, throughTurnID)
}

func (s *SQLiteWorkspaceStore) ListSessionForkTurnIdentities(
	ctx context.Context,
	workspaceID, sourceSessionID string,
) ([]storesqlite.SessionForkTurnIdentity, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return nil, err
	}
	return store.ListSessionForkTurnIdentities(ctx, workspaceID, sourceSessionID)
}

func (s *SQLiteWorkspaceStore) PrepareSessionFork(
	ctx context.Context,
	input storesqlite.SessionForkPrepare,
) (storesqlite.SessionForkOperation, bool, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, err
	}
	operation, changed, err := store.PrepareSessionFork(ctx, input)
	if err == nil && changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(operation.CommitDelta))
	}
	return operation, changed, err
}

func (s *SQLiteWorkspaceStore) GetSessionForkOperation(
	ctx context.Context,
	workspaceID, operationID string,
) (storesqlite.SessionForkOperation, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, err
	}
	return store.GetSessionForkOperation(ctx, workspaceID, operationID)
}

func (s *SQLiteWorkspaceStore) GetSessionForkOperationByRequest(
	ctx context.Context,
	workspaceID, requestID string,
) (storesqlite.SessionForkOperation, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, err
	}
	return store.GetSessionForkOperationByRequest(ctx, workspaceID, requestID)
}

func (s *SQLiteWorkspaceStore) GetUnknownSessionForkOperation(
	ctx context.Context,
	workspaceID, sourceSessionID, pointKind, sourceTurnID string,
) (storesqlite.SessionForkOperation, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, err
	}
	return store.GetUnknownSessionForkOperation(
		ctx,
		workspaceID,
		sourceSessionID,
		pointKind,
		sourceTurnID,
	)
}

func (s *SQLiteWorkspaceStore) GetBlockingSessionForkOperation(
	ctx context.Context,
	workspaceID, sourceSessionID, pointKind, sourceTurnID string,
) (storesqlite.SessionForkOperation, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, err
	}
	return store.GetBlockingSessionForkOperation(
		ctx,
		workspaceID,
		sourceSessionID,
		pointKind,
		sourceTurnID,
	)
}

func (s *SQLiteWorkspaceStore) MarkSessionForkDispatching(
	ctx context.Context,
	workspaceID, operationID string,
	now int64,
) (storesqlite.SessionForkOperation, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, err
	}
	operation, changed, err := store.MarkSessionForkDispatching(ctx, workspaceID, operationID, now)
	if err == nil && changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(operation.CommitDelta))
	}
	return operation, changed, err
}

func (s *SQLiteWorkspaceStore) RetryUnknownSessionFork(
	ctx context.Context,
	workspaceID, operationID string,
	now int64,
) (storesqlite.SessionForkOperation, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, err
	}
	operation, changed, err := store.RetryUnknownSessionFork(
		ctx,
		workspaceID,
		operationID,
		now,
	)
	if err == nil && changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(operation.CommitDelta))
	}
	return operation, changed, err
}

func (s *SQLiteWorkspaceStore) FailPreparedSessionFork(
	ctx context.Context,
	workspaceID, operationID, lastError string,
	now int64,
) (storesqlite.SessionForkOperation, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, err
	}
	operation, changed, err := store.FailPreparedSessionFork(
		ctx, workspaceID, operationID, lastError, now,
	)
	if err == nil && changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(operation.CommitDelta))
	}
	return operation, changed, err
}

func (s *SQLiteWorkspaceStore) FailAcceptedSessionFork(
	ctx context.Context,
	workspaceID, operationID, lastError string,
	now int64,
) (storesqlite.SessionForkOperation, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, err
	}
	operation, changed, err := store.FailAcceptedSessionFork(
		ctx, workspaceID, operationID, lastError, now,
	)
	if err == nil && changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(operation.CommitDelta))
	}
	return operation, changed, err
}

func (s *SQLiteWorkspaceStore) RecordSessionForkProviderResult(
	ctx context.Context,
	input storesqlite.SessionForkProviderResult,
) (storesqlite.SessionForkOperation, bool, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, err
	}
	operation, changed, err := store.RecordSessionForkProviderResult(ctx, input)
	if err == nil && changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(operation.CommitDelta))
	}
	return operation, changed, err
}

func (s *SQLiteWorkspaceStore) CommitSessionFork(
	ctx context.Context,
	workspaceID, operationID string,
	now int64,
) (storesqlite.SessionForkCommitResult, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkCommitResult{}, err
	}
	result, err := store.CommitSessionFork(ctx, workspaceID, operationID, now)
	if err == nil && result.Changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(result.CommitDelta))
	}
	return result, err
}

func (s *SQLiteWorkspaceStore) AcknowledgeSessionForkOperation(
	ctx context.Context,
	workspaceID, operationID string,
	now int64,
) (storesqlite.SessionForkOperation, bool, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, false, err
	}
	operation, found, changed, err := store.AcknowledgeSessionForkOperation(
		ctx,
		workspaceID,
		operationID,
		now,
	)
	if err == nil && changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(operation.CommitDelta))
	}
	return operation, found, changed, err
}

func (s *SQLiteWorkspaceStore) GetSessionForkLineage(
	ctx context.Context,
	workspaceID, targetSessionID string,
) (storesqlite.SessionForkLineage, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkLineage{}, false, err
	}
	return store.GetSessionForkLineage(ctx, workspaceID, targetSessionID)
}
