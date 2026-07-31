package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
)

type sessionForkTurnSnapshot struct {
	Sequence int64 `json:"sequence"`
	Turn     Turn  `json:"turn"`
}

type sessionForkSnapshot struct {
	Version              int                       `json:"version"`
	BoundaryMessageID    int64                     `json:"boundaryMessageId"`
	TargetCwd            string                    `json:"targetCwd,omitempty"`
	TargetRuntimeContext map[string]any            `json:"targetRuntimeContext,omitempty"`
	TargetSettings       map[string]any            `json:"targetSettings,omitempty"`
	TargetTitle          string                    `json:"targetTitle,omitempty"`
	Session              Session                   `json:"session"`
	Turns                []sessionForkTurnSnapshot `json:"turns"`
	Messages             []Message                 `json:"messages"`
	Interactions         []Interaction             `json:"interactions"`
}

const sessionForkOperationSelectSQL = `
SELECT operation_id, workspace_id, request_id, request_hash,
       source_agent_session_id, target_agent_session_id,
       source_provider_session_id, source_turn_id, source_provider_turn_id,
       source_provider_turn_binding_json,
       COALESCE(target_turn_id, ''),
       point_kind, driver_kind, driver_version, status,
       COALESCE(target_provider_session_id, ''),
       target_title, target_provider_turn_bindings_json,
       provider_state_binding_mode, provider_state_binding_receipt,
       snapshot_hash, last_error,
       created_at_unix_ms, updated_at_unix_ms,
       COALESCE(dispatched_at_unix_ms, 0), COALESCE(accepted_at_unix_ms, 0),
       COALESCE(completed_at_unix_ms, 0),
       COALESCE(client_observed_at_unix_ms, 0)
FROM workspace_agent_session_fork_operations`

func (s *Store) PrepareSessionFork(ctx context.Context, input SessionForkPrepare) (SessionForkOperation, bool, error) {
	if s == nil || s.db == nil {
		return SessionForkOperation{}, false, errors.New("workspace database is not initialized")
	}
	normalizeSessionForkPrepare(&input)
	if input.OperationID == "" || input.WorkspaceID == "" || input.RequestID == "" ||
		input.RequestHash == "" || input.SourceAgentSessionID == "" ||
		input.TargetAgentSessionID == "" || input.SourceTurnID == "" ||
		input.PointKind != SessionForkPointThroughTurn ||
		input.DriverKind == "" || input.DriverVersion == "" || input.OccurredAtUnixMS <= 0 ||
		input.SourceAgentSessionID == input.TargetAgentSessionID {
		return SessionForkOperation{}, false, errors.New("valid session fork prepare input is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SessionForkOperation{}, false, fmt.Errorf("begin prepare session fork: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if existing, found, err := getSessionForkOperationByRequestTx(ctx, tx, input.WorkspaceID, input.RequestID); err != nil {
		return SessionForkOperation{}, false, err
	} else if found {
		if existing.RequestHash != input.RequestHash {
			return SessionForkOperation{}, false, ErrSessionForkRequestConflict
		}
		if _, err := s.commitTransaction(ctx, tx, input.WorkspaceID, nil); err != nil {
			return SessionForkOperation{}, false, err
		}
		return existing, false, nil
	}
	source, found, err := getSessionForkSourceTx(ctx, tx, input.WorkspaceID, input.SourceAgentSessionID)
	if err != nil {
		return SessionForkOperation{}, false, err
	}
	if !found || source.Kind != SessionKindRoot ||
		strings.TrimSpace(source.ProviderSessionID) == "" {
		return SessionForkOperation{}, false, ErrSessionForkSourceState
	}
	var selectedSequence int64
	selected, found, err := getAgentTurnTx(ctx, tx, input.WorkspaceID, input.SourceAgentSessionID, input.SourceTurnID)
	if err != nil {
		return SessionForkOperation{}, false, err
	}
	if !found {
		return SessionForkOperation{}, false, newSessionForkBoundaryError(
			SessionForkBoundaryReasonTurnNotFound,
			"selected turn does not exist in the source session",
		)
	}
	if selected.Phase != TurnPhaseSettled {
		return SessionForkOperation{}, false, newSessionForkBoundaryError(
			SessionForkBoundaryReasonTurnNotSettled,
			fmt.Sprintf("selected turn phase is %q, want %q", selected.Phase, TurnPhaseSettled),
		)
	}
	if err := tx.QueryRowContext(ctx, `
SELECT turn_sequence
FROM workspace_agent_turn_sequences
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, input.WorkspaceID, input.SourceAgentSessionID, input.SourceTurnID).Scan(&selectedSequence); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return SessionForkOperation{}, false, newSessionForkBoundaryError(
				SessionForkBoundaryReasonTurnSequenceMissing,
				"selected turn has no canonical turn sequence",
			)
		}
		return SessionForkOperation{}, false, fmt.Errorf("read session fork turn sequence: %w", err)
	}
	if !HasPersistedProviderTurnBinding(selected) {
		return SessionForkOperation{}, false, newSessionForkBoundaryError(
			SessionForkBoundaryReasonProviderTurnMissing,
			"selected turn has no usable provider turn binding",
		)
	}
	var boundaryBusy int
	if err := tx.QueryRowContext(ctx, `
SELECT EXISTS(
  SELECT 1
  FROM workspace_agent_session_fork_operations
  WHERE workspace_id = ?
    AND source_agent_session_id = ?
    AND point_kind = ?
    AND source_turn_id = ?
    AND status IN ('prepared','dispatching','provider_accepted')
)
`, input.WorkspaceID, input.SourceAgentSessionID, input.PointKind, input.SourceTurnID).Scan(&boundaryBusy); err != nil {
		return SessionForkOperation{}, false, fmt.Errorf("read active session fork boundary: %w", err)
	}
	if boundaryBusy != 0 {
		return SessionForkOperation{}, false, ErrSessionForkInProgress
	}
	snapshot, err := loadSessionForkSnapshotTx(ctx, tx, source, selectedSequence, 0)
	if err != nil {
		return SessionForkOperation{}, false, err
	}
	identityOperation := SessionForkOperation{
		OperationID:          input.OperationID,
		WorkspaceID:          input.WorkspaceID,
		SourceAgentSessionID: input.SourceAgentSessionID,
		TargetAgentSessionID: input.TargetAgentSessionID,
	}
	if _, err := buildSessionForkCanonicalIdentityMap(identityOperation, snapshot); err != nil {
		return SessionForkOperation{}, false, errors.Join(ErrSessionForkTurnState, err)
	}
	snapshot.TargetCwd = strings.TrimSpace(input.TargetCwd)
	snapshot.TargetRuntimeContext = cloneJSONMap(input.TargetRuntimeContext)
	snapshot.TargetSettings = cloneJSONMap(input.TargetSettings)
	snapshot.TargetTitle, err = nextSessionForkTargetTitleTx(
		ctx,
		tx,
		input.WorkspaceID,
		input.SourceAgentSessionID,
		source.Title,
	)
	if err != nil {
		return SessionForkOperation{}, false, err
	}
	snapshot.Version = 2
	snapshotJSON, err := json.Marshal(snapshot)
	if err != nil {
		return SessionForkOperation{}, false, fmt.Errorf("encode session fork snapshot: %w", err)
	}
	snapshotHash := hashSessionForkBytes(snapshotJSON)
	if len(snapshot.Turns) == 0 || snapshot.Turns[len(snapshot.Turns)-1].Turn.TurnID != input.SourceTurnID {
		return SessionForkOperation{}, false, newSessionForkBoundaryError(
			SessionForkBoundaryReasonProviderTurnBoundaryMismatch,
			"canonical snapshot does not end at the selected turn",
		)
	}

	var targetExists int
	if err := tx.QueryRowContext(ctx, `
SELECT EXISTS(
  SELECT 1 FROM workspace_agent_sessions
  WHERE workspace_id = ? AND agent_session_id = ?
  UNION ALL
  SELECT 1 FROM workspace_agent_session_fork_target_reservations
  WHERE workspace_id = ? AND target_agent_session_id = ?
)
`, input.WorkspaceID, input.TargetAgentSessionID, input.WorkspaceID, input.TargetAgentSessionID).Scan(&targetExists); err != nil {
		return SessionForkOperation{}, false, fmt.Errorf("read session fork target identity: %w", err)
	}
	if targetExists != 0 {
		return SessionForkOperation{}, false, ErrSessionForkTargetReserved
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_session_fork_operations (
  operation_id, workspace_id, request_id, request_hash,
  source_agent_session_id, target_agent_session_id,
  source_provider_session_id, source_turn_id, source_provider_turn_id,
  source_provider_turn_binding_json,
  point_kind, driver_kind, driver_version, status, target_title,
  snapshot_json, snapshot_hash,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, input.OperationID, input.WorkspaceID, input.RequestID, input.RequestHash,
		input.SourceAgentSessionID, input.TargetAgentSessionID,
		source.ProviderSessionID, input.SourceTurnID, selected.RootProviderTurnID,
		string(firstNonEmptyJSON(selected.ProviderTurnBindingJSON)),
		input.PointKind, input.DriverKind, input.DriverVersion, SessionForkStatusPrepared,
		snapshot.TargetTitle, string(snapshotJSON), snapshotHash,
		input.OccurredAtUnixMS, input.OccurredAtUnixMS); err != nil {
		return SessionForkOperation{}, false, fmt.Errorf("insert session fork operation: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_session_fork_target_reservations (
  workspace_id, target_agent_session_id, operation_id, request_id, request_hash, created_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?)
`, input.WorkspaceID, input.TargetAgentSessionID, input.OperationID,
		input.RequestID, input.RequestHash, input.OccurredAtUnixMS); err != nil {
		return SessionForkOperation{}, false, fmt.Errorf("reserve session fork target: %w", err)
	}
	op, _, err := getSessionForkOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil {
		return SessionForkOperation{}, false, err
	}
	delta, err := s.commitTransaction(ctx, tx, input.WorkspaceID, []TransactionMutation{
		transactionMutation(input.WorkspaceID, input.SourceAgentSessionID, MutationEntitySessionForkOperation, input.OperationID, "prepare", input.OccurredAtUnixMS),
	})
	if err != nil {
		return SessionForkOperation{}, false, fmt.Errorf("commit prepare session fork: %w", err)
	}
	op.CommitTransactionID, op.CommitDelta = delta.TransactionID, delta
	return op, true, nil
}

func (s *Store) GetSessionForkOperation(ctx context.Context, workspaceID, operationID string) (SessionForkOperation, bool, error) {
	if s == nil || s.db == nil {
		return SessionForkOperation{}, false, errors.New("workspace database is not initialized")
	}
	return getSessionForkOperation(ctx, s.db, strings.TrimSpace(workspaceID), strings.TrimSpace(operationID))
}

func (s *Store) ListSessionForkAttachmentBindings(
	ctx context.Context,
	workspaceID, operationID string,
) ([]SessionForkAttachmentBinding, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	op, found, err := s.GetSessionForkOperation(ctx, workspaceID, operationID)
	if err != nil || !found {
		return nil, err
	}
	var snapshotJSON string
	if err := s.db.QueryRowContext(ctx, `
SELECT snapshot_json
FROM workspace_agent_session_fork_operations
WHERE workspace_id = ? AND operation_id = ?
`, strings.TrimSpace(workspaceID), strings.TrimSpace(operationID)).Scan(&snapshotJSON); err != nil {
		return nil, fmt.Errorf("read session fork attachment snapshot: %w", err)
	}
	var snapshot sessionForkSnapshot
	if err := json.Unmarshal([]byte(snapshotJSON), &snapshot); err != nil {
		return nil, fmt.Errorf("decode session fork attachment snapshot: %w", err)
	}
	identityMap, err := buildSessionForkCanonicalIdentityMap(op, snapshot)
	if err != nil {
		return nil, err
	}
	bindings := make([]SessionForkAttachmentBinding, 0, len(identityMap.AttachmentIDs))
	for sourceID, targetID := range identityMap.AttachmentIDs {
		bindings = append(bindings, SessionForkAttachmentBinding{
			SourceAttachmentID: sourceID,
			TargetAttachmentID: targetID,
		})
	}
	slices.SortFunc(bindings, func(a, b SessionForkAttachmentBinding) int {
		return strings.Compare(a.SourceAttachmentID, b.SourceAttachmentID)
	})
	return bindings, nil
}

func (s *Store) GetSessionForkSource(
	ctx context.Context,
	workspaceID, sourceSessionID string,
) (Session, bool, error) {
	if s == nil || s.db == nil {
		return Session{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	sourceSessionID = strings.TrimSpace(sourceSessionID)
	if workspaceID == "" || sourceSessionID == "" {
		return Session{}, false, nil
	}
	session, found, err := s.GetSession(ctx, workspaceID, sourceSessionID)
	if err != nil || !found {
		return Session{}, found, err
	}
	if session.Kind != SessionKindRoot || strings.TrimSpace(session.ProviderSessionID) == "" {
		return Session{}, false, nil
	}
	return session, true, nil
}

func (s *Store) GetSessionForkOperationByRequest(
	ctx context.Context,
	workspaceID, requestID string,
) (SessionForkOperation, bool, error) {
	if s == nil || s.db == nil {
		return SessionForkOperation{}, false, errors.New("workspace database is not initialized")
	}
	op, err := scanSessionForkOperation(s.db.QueryRowContext(ctx, sessionForkOperationSelectSQL+`
WHERE workspace_id = ? AND request_id = ?`,
		strings.TrimSpace(workspaceID), strings.TrimSpace(requestID)))
	if errors.Is(err, sql.ErrNoRows) {
		return SessionForkOperation{}, false, nil
	}
	return op, err == nil, err
}

func (s *Store) GetUnknownSessionForkOperation(
	ctx context.Context,
	workspaceID, sourceSessionID, pointKind, sourceTurnID string,
) (SessionForkOperation, bool, error) {
	if s == nil || s.db == nil {
		return SessionForkOperation{}, false, errors.New(
			"workspace database is not initialized",
		)
	}
	workspaceID = strings.TrimSpace(workspaceID)
	sourceSessionID = strings.TrimSpace(sourceSessionID)
	pointKind = strings.TrimSpace(pointKind)
	sourceTurnID = strings.TrimSpace(sourceTurnID)
	if workspaceID == "" || sourceSessionID == "" ||
		pointKind != SessionForkPointThroughTurn || sourceTurnID == "" {
		return SessionForkOperation{}, false, errors.New(
			"valid unknown session fork lookup is required",
		)
	}
	op, err := scanSessionForkOperation(s.db.QueryRowContext(
		ctx,
		sessionForkOperationSelectSQL+`
WHERE workspace_id = ?
  AND source_agent_session_id = ?
  AND point_kind = ?
  AND source_turn_id = ?
  AND status = ?
ORDER BY created_at_unix_ms DESC, operation_id DESC
LIMIT 1`,
		workspaceID,
		sourceSessionID,
		pointKind,
		sourceTurnID,
		SessionForkStatusUnknown,
	))
	if errors.Is(err, sql.ErrNoRows) {
		return SessionForkOperation{}, false, nil
	}
	return op, err == nil, err
}

func (s *Store) GetBlockingSessionForkOperation(
	ctx context.Context,
	workspaceID, sourceSessionID, pointKind, sourceTurnID string,
) (SessionForkOperation, bool, error) {
	if s == nil || s.db == nil {
		return SessionForkOperation{}, false, errors.New(
			"workspace database is not initialized",
		)
	}
	workspaceID = strings.TrimSpace(workspaceID)
	sourceSessionID = strings.TrimSpace(sourceSessionID)
	pointKind = strings.TrimSpace(pointKind)
	sourceTurnID = strings.TrimSpace(sourceTurnID)
	if workspaceID == "" || sourceSessionID == "" ||
		pointKind != SessionForkPointThroughTurn || sourceTurnID == "" {
		return SessionForkOperation{}, false, errors.New(
			"valid session fork boundary barrier lookup is required",
		)
	}
	var operationID string
	err := s.db.QueryRowContext(ctx, `
SELECT operation_id
FROM workspace_agent_session_fork_boundary_barriers
WHERE workspace_id = ?
  AND source_agent_session_id = ?
  AND point_kind = ?
  AND source_turn_id = ?
`, workspaceID, sourceSessionID, pointKind, sourceTurnID).Scan(&operationID)
	if errors.Is(err, sql.ErrNoRows) {
		return SessionForkOperation{}, false, nil
	}
	if err != nil {
		return SessionForkOperation{}, false, fmt.Errorf(
			"read session fork boundary barrier: %w",
			err,
		)
	}
	return getSessionForkOperation(ctx, s.db, workspaceID, operationID)
}

// CheckSessionForkThroughTurn performs the fail-closed, read-only half of
// PrepareSessionFork. PrepareSessionFork repeats every check transactionally.
func (s *Store) CheckSessionForkThroughTurn(
	ctx context.Context,
	workspaceID, sourceSessionID, throughTurnID string,
) (SessionForkBoundary, bool, error) {
	if s == nil || s.db == nil {
		return SessionForkBoundary{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	sourceSessionID = strings.TrimSpace(sourceSessionID)
	throughTurnID = strings.TrimSpace(throughTurnID)
	if workspaceID == "" || sourceSessionID == "" || throughTurnID == "" {
		return SessionForkBoundary{}, false, nil
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return SessionForkBoundary{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	session, found, err := getSessionForkSourceTx(ctx, tx, workspaceID, sourceSessionID)
	if err != nil || !found {
		return SessionForkBoundary{}, false, err
	}
	if session.Kind != SessionKindRoot {
		return rejectedSessionForkBoundary(
			SessionForkBoundaryReasonSourceNotRoot,
			fmt.Sprintf("source session kind is %q, want %q", session.Kind, SessionKindRoot),
		), false, nil
	}
	if strings.TrimSpace(session.ProviderSessionID) == "" {
		return rejectedSessionForkBoundary(
			SessionForkBoundaryReasonProviderSessionMissing,
			"source session has no provider session id",
		), false, nil
	}
	turn, found, err := getAgentTurnTx(ctx, tx, workspaceID, sourceSessionID, throughTurnID)
	if err != nil {
		return SessionForkBoundary{}, false, err
	}
	if !found {
		return rejectedSessionForkBoundary(
			SessionForkBoundaryReasonTurnNotFound,
			"selected turn does not exist in the source session",
		), false, nil
	}
	if turn.Phase != TurnPhaseSettled {
		return rejectedSessionForkBoundary(
			SessionForkBoundaryReasonTurnNotSettled,
			fmt.Sprintf("selected turn phase is %q, want %q", turn.Phase, TurnPhaseSettled),
		), false, nil
	}
	var sequence int64
	if err := tx.QueryRowContext(ctx, `
SELECT turn_sequence FROM workspace_agent_turn_sequences
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, workspaceID, sourceSessionID, throughTurnID).Scan(&sequence); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return rejectedSessionForkBoundary(
				SessionForkBoundaryReasonTurnSequenceMissing,
				"selected turn has no canonical turn sequence",
			), false, nil
		}
		return SessionForkBoundary{}, false, err
	}
	providerTurnID := strings.TrimSpace(turn.RootProviderTurnID)
	if !HasPersistedProviderTurnBinding(turn) {
		return rejectedSessionForkBoundary(
			SessionForkBoundaryReasonProviderTurnMissing,
			"selected turn has no usable provider turn binding",
		), false, nil
	}
	return SessionForkBoundary{
		Session:             session,
		Turn:                turn,
		RootProviderTurnIDs: []string{providerTurnID},
	}, true, nil
}

// ListSessionForkTurnIdentities returns the canonical/provider Turn identity
// sequence used to intersect provider-native thread history with UI actions.
// Final boundary eligibility is still rechecked transactionally by
// CheckSessionForkThroughTurn and PrepareSessionFork.
func (s *Store) ListSessionForkTurnIdentities(
	ctx context.Context,
	workspaceID, sourceSessionID string,
) ([]SessionForkTurnIdentity, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	sourceSessionID = strings.TrimSpace(sourceSessionID)
	if workspaceID == "" || sourceSessionID == "" {
		return nil, nil
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT t.turn_id, COALESCE(t.root_provider_turn_id, ''), t.phase
FROM workspace_agent_turn_sequences AS sequence
JOIN workspace_agent_turns AS t
  ON t.workspace_id = sequence.workspace_id
 AND t.agent_session_id = sequence.agent_session_id
 AND t.turn_id = sequence.turn_id
WHERE sequence.workspace_id = ? AND sequence.agent_session_id = ?
ORDER BY sequence.turn_sequence ASC
`, workspaceID, sourceSessionID)
	if err != nil {
		return nil, fmt.Errorf("list session fork turn identities: %w", err)
	}
	defer rows.Close()
	identities := make([]SessionForkTurnIdentity, 0)
	for rows.Next() {
		var identity SessionForkTurnIdentity
		if err := rows.Scan(
			&identity.TurnID,
			&identity.ProviderTurnID,
			&identity.Phase,
		); err != nil {
			return nil, fmt.Errorf("scan session fork turn identity: %w", err)
		}
		if strings.TrimSpace(identity.ProviderTurnID) ==
			strings.TrimSpace(identity.TurnID) {
			identity.ProviderTurnID = ""
		}
		identities = append(identities, identity)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate session fork turn identities: %w", err)
	}
	return identities, nil
}
