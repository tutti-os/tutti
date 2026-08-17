package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/host"
)

func (store *Store) AuthorizationProjection(
	ctx context.Context,
	accountID, connectorKey string,
) (market.AuthorizationProjection, error) {
	var payload string
	if err := store.db.QueryRowContext(ctx, `
SELECT projection_json FROM connector_market_authorization_projections
WHERE account_id = ? AND connector_key = ?`, accountID, connectorKey).Scan(&payload); err != nil {
		return market.AuthorizationProjection{}, mapNotFound(err)
	}
	var projection market.AuthorizationProjection
	if err := json.Unmarshal([]byte(payload), &projection); err != nil {
		return market.AuthorizationProjection{}, fmt.Errorf("decode connector authorization projection: %w", err)
	}
	return projection, nil
}

func overlayAuthorizationProjectionsOn(
	ctx context.Context,
	tx *sql.Tx,
	accountID string,
	connectors []market.Connector,
) ([]market.Connector, error) {
	rows, err := tx.QueryContext(ctx, `SELECT connector_key, projection_json FROM connector_market_authorization_projections WHERE account_id = ?`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	projections := make(map[string]market.AuthorizationProjection)
	for rows.Next() {
		var connectorKey, payload string
		if err := rows.Scan(&connectorKey, &payload); err != nil {
			return nil, err
		}
		var projection market.AuthorizationProjection
		if err := json.Unmarshal([]byte(payload), &projection); err != nil {
			return nil, fmt.Errorf("decode connector authorization projection: %w", err)
		}
		projections[connectorKey] = projection
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for index := range connectors {
		projection, ok := projections[connectors[index].Key]
		if !ok {
			continue
		}
		connectors[index].Authorization = market.Authorization{
			State: projection.State, FailureCode: projection.FailureCode,
		}
	}
	return connectors, nil
}

func (store *Store) SaveAuthorizationProjection(
	ctx context.Context,
	projection market.AuthorizationProjection,
) error {
	payload, err := json.Marshal(projection)
	if err != nil {
		return fmt.Errorf("encode connector authorization projection: %w", err)
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var currentPayload string
	publicChanged := true
	currentErr := tx.QueryRowContext(ctx, `SELECT projection_json FROM connector_market_authorization_projections
WHERE account_id = ? AND connector_key = ?`, projection.AccountID, projection.ConnectorKey).Scan(&currentPayload)
	if currentErr == nil {
		var current market.AuthorizationProjection
		if err := json.Unmarshal([]byte(currentPayload), &current); err != nil {
			return fmt.Errorf("decode connector authorization projection: %w", err)
		}
		if current.ServerSynchronized && !projection.ServerSynchronized ||
			current.ServerSynchronized && projection.ServerSynchronized && current.ServerRevision > projection.ServerRevision {
			return tx.Commit()
		}
		publicChanged = !samePublicAuthorizationProjection(current, projection)
	} else if !errors.Is(currentErr, sql.ErrNoRows) {
		return currentErr
	}
	if _, err = tx.ExecContext(ctx, `
INSERT INTO connector_market_authorization_projections (account_id, connector_key, projection_json)
VALUES (?, ?, ?)
ON CONFLICT(account_id, connector_key) DO UPDATE SET projection_json = excluded.projection_json`,
		projection.AccountID, projection.ConnectorKey, string(payload)); err != nil {
		return err
	}
	if publicChanged {
		if err := bumpAuthorizationProjectionRevisionOn(ctx, tx, projection.ConnectorKey); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (store *Store) ApplyAuthorizationSnapshot(
	ctx context.Context,
	accountID string,
	snapshot market.AuthorizationSnapshot,
) (market.AuthorizationSnapshotApplyResult, error) {
	accountID = strings.TrimSpace(accountID)
	if accountID == "" {
		return market.AuthorizationSnapshotApplyResult{}, errors.New("authorization snapshot account is required")
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return market.AuthorizationSnapshotApplyResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var currentRevision uint64
	err = tx.QueryRowContext(ctx, `SELECT revision FROM connector_market_authorization_snapshot_revisions WHERE account_id = ?`, accountID).Scan(&currentRevision)
	hasRevision := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return market.AuthorizationSnapshotApplyResult{}, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT connector_key, projection_json FROM connector_market_authorization_projections WHERE account_id = ?`, accountID)
	if err != nil {
		return market.AuthorizationSnapshotApplyResult{}, err
	}
	existing := make(map[string]market.AuthorizationProjection)
	for rows.Next() {
		var connectorKey, payload string
		if err := rows.Scan(&connectorKey, &payload); err != nil {
			_ = rows.Close()
			return market.AuthorizationSnapshotApplyResult{}, err
		}
		var projection market.AuthorizationProjection
		if err := json.Unmarshal([]byte(payload), &projection); err != nil {
			_ = rows.Close()
			return market.AuthorizationSnapshotApplyResult{}, fmt.Errorf("decode connector authorization projection: %w", err)
		}
		existing[connectorKey] = projection
	}
	if err := rows.Close(); err != nil {
		return market.AuthorizationSnapshotApplyResult{}, err
	}
	now := time.Now().UTC()
	result := market.AuthorizationSnapshotApplyResult{}
	effective := existing
	if !hasRevision || snapshot.Revision > currentRevision {
		incoming := make(map[string]market.AuthorizationProjection, len(snapshot.Connectors))
		for _, projection := range snapshot.Connectors {
			projection.AccountID = accountID
			projection.ConnectorKey = strings.TrimSpace(projection.ConnectorKey)
			if projection.ConnectorKey == "" {
				return market.AuthorizationSnapshotApplyResult{}, errors.New("authorization snapshot contains an empty connector key")
			}
			projection.ServerRevision = snapshot.Revision
			projection.ServerSynchronized = true
			projection.UpdatedAt = now
			incoming[projection.ConnectorKey] = projection
		}
		for connectorKey, previous := range existing {
			if _, ok := incoming[connectorKey]; ok {
				continue
			}
			if !previous.ServerSynchronized {
				continue
			}
			incoming[connectorKey] = market.AuthorizationProjection{
				AccountID: accountID, ConnectorKey: connectorKey, ServerRevision: snapshot.Revision,
				ServerSynchronized: true, State: market.AuthorizationStateDisconnected, UpdatedAt: now,
			}
		}
		result.ChangedConnectorKeys = make([]string, 0, len(incoming))
		for connectorKey, projection := range incoming {
			previous, exists := existing[connectorKey]
			if !exists || previous.State != projection.State || previous.ConnectionID != projection.ConnectionID ||
				previous.ConnectionVersion != projection.ConnectionVersion || previous.ConnectorVersion != projection.ConnectorVersion {
				result.ChangedConnectorKeys = append(result.ChangedConnectorKeys, connectorKey)
			}
			payload, err := json.Marshal(projection)
			if err != nil {
				return market.AuthorizationSnapshotApplyResult{}, fmt.Errorf("encode connector authorization projection: %w", err)
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO connector_market_authorization_projections (account_id, connector_key, projection_json)
VALUES (?, ?, ?) ON CONFLICT(account_id,connector_key) DO UPDATE SET projection_json = excluded.projection_json`, accountID, connectorKey, string(payload)); err != nil {
				return market.AuthorizationSnapshotApplyResult{}, err
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO connector_market_authorization_snapshot_revisions (account_id, revision) VALUES (?, ?)
ON CONFLICT(account_id) DO UPDATE SET revision = excluded.revision`, accountID, snapshot.Revision); err != nil {
			return market.AuthorizationSnapshotApplyResult{}, err
		}
		sort.Strings(result.ChangedConnectorKeys)
		for _, connectorKey := range result.ChangedConnectorKeys {
			if err := bumpAuthorizationProjectionRevisionOn(ctx, tx, connectorKey); err != nil {
				return market.AuthorizationSnapshotApplyResult{}, err
			}
		}
		effective = incoming
	}
	pending, err := connectedAuthorizationReceiptConnectorKeys(ctx, tx, accountID, effective)
	if err != nil {
		return market.AuthorizationSnapshotApplyResult{}, err
	}
	result.PendingReceiptConnectorKeys = pending
	sort.Strings(result.ChangedConnectorKeys)
	sort.Strings(result.PendingReceiptConnectorKeys)
	if err := tx.Commit(); err != nil {
		return market.AuthorizationSnapshotApplyResult{}, err
	}
	return result, nil
}

func samePublicAuthorizationProjection(left, right market.AuthorizationProjection) bool {
	return left.State == right.State && left.ConnectionID == right.ConnectionID &&
		left.FailureCode == right.FailureCode && left.ConnectionVersion == right.ConnectionVersion &&
		left.ConnectorVersion == right.ConnectorVersion && left.ServerSynchronized == right.ServerSynchronized
}

func bumpAuthorizationProjectionRevisionOn(ctx context.Context, tx *sql.Tx, connectorKey string) error {
	var connectorPayload string
	if err := tx.QueryRowContext(ctx, `SELECT connector_json FROM connector_market_connectors WHERE connector_key = ?`, connectorKey).Scan(&connectorPayload); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	connector, err := decodeConnector(connectorPayload)
	if err != nil {
		return err
	}
	var revision uint64
	if err := tx.QueryRowContext(ctx, `UPDATE connector_market_metadata SET revision = revision + 1 WHERE id = ? RETURNING revision`, metadataID).Scan(&revision); err != nil {
		return err
	}
	connector.Revision = revision
	payload, err := json.Marshal(connector)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE connector_market_connectors SET connector_json = ? WHERE connector_key = ?`, string(payload), connectorKey); err != nil {
		return err
	}
	eventPayload, err := json.Marshal(market.ChangedEvent{ConnectorKey: connectorKey, Revision: revision})
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO connector_market_outbox (revision, event_json, published_at_unix_ms) VALUES (?, ?, NULL)`, revision, string(eventPayload))
	return err
}

func connectedAuthorizationReceiptConnectorKeys(
	ctx context.Context,
	tx *sql.Tx,
	accountID string,
	projections map[string]market.AuthorizationProjection,
) ([]string, error) {
	connected := make(map[string]struct{})
	for connectorKey, projection := range projections {
		if projection.ServerSynchronized && projection.State == market.AuthorizationStateConnected {
			connected[connectorKey] = struct{}{}
		}
	}
	if len(connected) == 0 {
		return nil, nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT operation_json FROM connector_market_operations
WHERE kind = 'start_authorization' AND state = 'completed' ORDER BY operation_id`)
	if err != nil {
		return nil, err
	}
	pending := make(map[string]struct{})
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			_ = rows.Close()
			return nil, err
		}
		operation, err := decodeOperation(payload)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		if operation.Scope.AccountID != accountID || operation.Execution.AuthorizationSession == nil ||
			operation.Execution.AuthorizationSession.IsResolved() {
			continue
		}
		if _, ok := connected[operation.ConnectorKey]; !ok {
			continue
		}
		pending[operation.ConnectorKey] = struct{}{}
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(pending))
	for connectorKey := range pending {
		keys = append(keys, connectorKey)
	}
	return keys, nil
}
