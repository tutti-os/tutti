package storesqlite

import (
	"context"
	"errors"
	"strings"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/host"
)

func authorizationCompletions(operations []market.Operation) []market.AuthorizationCompletion {
	result := make([]market.AuthorizationCompletion, 0)
	for _, operation := range operations {
		session := operation.Execution.AuthorizationSession
		if operation.Kind != market.OperationKindStartAuthorization || session == nil ||
			session.CompletionAcknowledgedAt != nil {
			continue
		}
		if session.Resolution != market.AuthorizationSessionResolutionProviderConnected &&
			session.Resolution != market.AuthorizationSessionResolutionAccountStateConverged {
			continue
		}
		completedAt := operation.UpdatedAt
		if session.ResolvedAt != nil {
			completedAt = session.ResolvedAt.UTC()
		}
		result = append(result, market.AuthorizationCompletion{
			CompletionID: operation.OperationID,
			ConnectorKey: operation.ConnectorKey,
			CompletedAt:  completedAt,
		})
	}
	return result
}

func listAuthorizationCompletionsOn(
	ctx context.Context,
	database queryer,
	accountID string,
) ([]market.AuthorizationCompletion, error) {
	accountID = strings.TrimSpace(accountID)
	if accountID == "" {
		return []market.AuthorizationCompletion{}, nil
	}
	rows, err := database.QueryContext(ctx, `
SELECT operation_json FROM connector_market_operations
WHERE owner_account_id = ? AND visibility = ? AND kind = ? ORDER BY operation_id`,
		accountID,
		market.OperationVisibilityAccount,
		market.OperationKindStartAuthorization,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	operations := make([]market.Operation, 0)
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return nil, err
		}
		operation, err := decodeOperation(payload)
		if err != nil {
			return nil, err
		}
		operations = append(operations, operation)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return authorizationCompletions(operations), nil
}

func (store *Store) UnresolvedAuthorizationSessionOperations(
	ctx context.Context,
	scope market.OperationScope,
) ([]market.Operation, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT operation_json FROM connector_market_operations
WHERE kind = 'start_authorization' AND state = 'completed'
ORDER BY operation_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	operations := make([]market.Operation, 0)
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return nil, err
		}
		operation, err := decodeOperation(payload)
		if err != nil {
			return nil, err
		}
		if operation.Scope.AccountID != scope.AccountID || operation.Execution.AuthorizationSession == nil ||
			operation.Execution.AuthorizationSession.IsResolved() {
			continue
		}
		operations = append(operations, operation)
	}
	return operations, rows.Err()
}

func (store *Store) ResolveAuthorizationSession(
	ctx context.Context,
	operationID string,
	resolution market.AuthorizationSessionResolution,
) error {
	if !validAuthorizationSessionResolutionTransition(resolution) {
		return errors.New("valid authorization session resolution is required")
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	operation, err := operationOn(ctx, tx, operationID)
	if err != nil {
		return err
	}
	if operation.Execution.AuthorizationSession == nil || operation.Execution.AuthorizationSession.IsResolved() {
		return tx.Commit()
	}
	now := time.Now().UTC()
	operation.Execution.AuthorizationSession.Resolution = resolution
	operation.Execution.AuthorizationSession.ResolvedAt = &now
	operation.UpdatedAt = now
	if err := saveOperationOn(ctx, tx, operation); err != nil {
		return err
	}
	return tx.Commit()
}

func (store *Store) AcknowledgeAuthorizationCompletion(
	ctx context.Context,
	scope market.OperationScope,
	completionID string,
) error {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	operation, err := operationOn(ctx, tx, strings.TrimSpace(completionID))
	if err != nil {
		return err
	}
	session := operation.Execution.AuthorizationSession
	if operation.Scope.AccountID != strings.TrimSpace(scope.AccountID) ||
		operation.Kind != market.OperationKindStartAuthorization || session == nil ||
		(session.Resolution != market.AuthorizationSessionResolutionProviderConnected &&
			session.Resolution != market.AuthorizationSessionResolutionAccountStateConverged) {
		return market.ErrNotFound
	}
	if session.CompletionAcknowledgedAt != nil {
		return tx.Commit()
	}
	now := time.Now().UTC()
	session.CompletionAcknowledgedAt = &now
	operation.UpdatedAt = now
	if err := saveOperationOn(ctx, tx, operation); err != nil {
		return err
	}
	return tx.Commit()
}

func validAuthorizationSessionResolutionTransition(resolution market.AuthorizationSessionResolution) bool {
	switch resolution {
	case market.AuthorizationSessionResolutionCanceling,
		market.AuthorizationSessionResolutionProviderConnected,
		market.AuthorizationSessionResolutionProviderFailed,
		market.AuthorizationSessionResolutionAccountStateConverged,
		market.AuthorizationSessionResolutionSuperseded:
		return true
	default:
		return false
	}
}
