package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
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

// SessionForkSourceHash fingerprints the complete canonical source row read by
// Host before product context policy and provider capability resolution. The
// Store compares it again inside Prepare's transaction, before installing the
// source fence, so provider identity and host-owned context cannot drift
// across that gap.
func SessionForkSourceHash(session Session) (string, error) {
	encoded, err := json.Marshal(session)
	if err != nil {
		return "", fmt.Errorf("encode session fork source proof: %w", err)
	}
	return hashSessionForkBytes(encoded), nil
}

const sessionForkOperationSelectSQL = `
SELECT operation_id, workspace_id, request_id, request_hash,
       source_agent_session_id, target_agent_session_id,
       source_provider_session_id, source_turn_id, source_provider_turn_id,
       COALESCE(target_turn_id, ''),
       point_kind, driver_kind, driver_version, status,
       COALESCE(target_provider_session_id, ''),
       target_title, target_provider_turn_ids_json,
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
		input.ExpectedSourceHash == "" ||
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
	if existing, found, err := getSessionForkBoundaryBarrierTx(
		ctx,
		tx,
		input.WorkspaceID,
		input.SourceAgentSessionID,
		input.PointKind,
		input.SourceTurnID,
	); err != nil {
		return SessionForkOperation{}, false, err
	} else if found {
		if _, err := s.commitTransaction(ctx, tx, input.WorkspaceID, nil); err != nil {
			return SessionForkOperation{}, false, err
		}
		return existing, false, nil
	}
	if err := requireSessionForkSourceWritableTx(
		ctx, tx, input.WorkspaceID, input.SourceAgentSessionID,
	); err != nil {
		return SessionForkOperation{}, false, err
	}

	source, found, err := getSessionForkSourceTx(ctx, tx, input.WorkspaceID, input.SourceAgentSessionID)
	if err != nil {
		return SessionForkOperation{}, false, err
	}
	if !found || source.Kind != SessionKindRoot || source.ActiveTurnID != "" ||
		strings.TrimSpace(source.ProviderSessionID) == "" {
		return SessionForkOperation{}, false, ErrSessionForkSourceState
	}
	sourceHash, err := SessionForkSourceHash(source)
	if err != nil {
		return SessionForkOperation{}, false, err
	}
	if sourceHash != input.ExpectedSourceHash {
		return SessionForkOperation{}, false, ErrSessionForkSourceState
	}
	var pendingInteractions int
	if err := tx.QueryRowContext(ctx, `
SELECT EXISTS(
  SELECT 1 FROM workspace_agent_interactions
  WHERE workspace_id = ? AND agent_session_id = ? AND status = ?
)
`, input.WorkspaceID, input.SourceAgentSessionID, InteractionStatusPending).Scan(&pendingInteractions); err != nil {
		return SessionForkOperation{}, false, fmt.Errorf("read pending session fork interactions: %w", err)
	}
	if pendingInteractions != 0 {
		return SessionForkOperation{}, false, ErrSessionForkSourceState
	}
	if err := requireSessionForkSourceQuiescentTx(
		ctx, tx, input.WorkspaceID, input.SourceAgentSessionID,
	); err != nil {
		return SessionForkOperation{}, false, err
	}
	var selectedSequence int64
	var selectedProvenance string
	selected, found, err := getAgentTurnTx(ctx, tx, input.WorkspaceID, input.SourceAgentSessionID, input.SourceTurnID)
	if err != nil {
		return SessionForkOperation{}, false, err
	}
	if !found {
		return SessionForkOperation{}, false, ErrSessionForkTurnState
	}
	if err := tx.QueryRowContext(ctx, `
SELECT turn_sequence, provenance
FROM workspace_agent_turn_sequences
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, input.WorkspaceID, input.SourceAgentSessionID, input.SourceTurnID).Scan(&selectedSequence, &selectedProvenance); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return SessionForkOperation{}, false, ErrSessionForkTurnState
		}
		return SessionForkOperation{}, false, fmt.Errorf("read session fork turn sequence: %w", err)
	}
	if selected.Phase != TurnPhaseSettled || !isVerifiedSessionForkSequence(selectedProvenance) ||
		strings.TrimSpace(selected.RootProviderTurnID) == "" {
		return SessionForkOperation{}, false, ErrSessionForkTurnState
	}
	if descendants, err := hasSessionForkDescendantsTx(
		ctx, tx, input.WorkspaceID, input.SourceAgentSessionID, selectedSequence,
	); err != nil {
		return SessionForkOperation{}, false, err
	} else if descendants {
		return SessionForkOperation{}, false, ErrSessionForkTurnState
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
	if sessionForkSnapshotHasAttachmentReference(snapshot) {
		// Session-scoped local attachments do not yet have an immutable,
		// through-Turn resource manifest. Never copy the whole source
		// namespace because it can contain resources created after the
		// selected boundary.
		return SessionForkOperation{}, false, ErrSessionForkTurnState
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
		return SessionForkOperation{}, false, ErrSessionForkTurnState
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
  point_kind, driver_kind, driver_version, status, target_title,
  snapshot_json, snapshot_hash,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, input.OperationID, input.WorkspaceID, input.RequestID, input.RequestHash,
		input.SourceAgentSessionID, input.TargetAgentSessionID,
		source.ProviderSessionID, input.SourceTurnID, selected.RootProviderTurnID,
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
	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_session_fork_boundary_barriers (
  workspace_id, source_agent_session_id, point_kind, source_turn_id,
  operation_id, created_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?)
`, input.WorkspaceID, input.SourceAgentSessionID, input.PointKind,
		input.SourceTurnID, input.OperationID, input.OccurredAtUnixMS); err != nil {
		return SessionForkOperation{}, false, fmt.Errorf(
			"install session fork boundary barrier: %w",
			err,
		)
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
	if session.Kind != SessionKindRoot || session.ActiveTurnID != "" ||
		strings.TrimSpace(session.ProviderSessionID) == "" {
		return SessionForkBoundary{}, false, nil
	}
	var pendingInteractions int
	if err := tx.QueryRowContext(ctx, `
SELECT EXISTS(
  SELECT 1 FROM workspace_agent_interactions
  WHERE workspace_id = ? AND agent_session_id = ? AND status = ?
)
`, workspaceID, sourceSessionID, InteractionStatusPending).Scan(&pendingInteractions); err != nil {
		return SessionForkBoundary{}, false, err
	}
	if pendingInteractions != 0 {
		return SessionForkBoundary{}, false, nil
	}
	if err := requireSessionForkSourceQuiescentTx(ctx, tx, workspaceID, sourceSessionID); err != nil {
		if errors.Is(err, ErrSessionForkSourceState) {
			return SessionForkBoundary{}, false, nil
		}
		return SessionForkBoundary{}, false, err
	}
	turn, found, err := getAgentTurnTx(ctx, tx, workspaceID, sourceSessionID, throughTurnID)
	if err != nil || !found {
		return SessionForkBoundary{}, false, err
	}
	var sequence int64
	var provenance string
	if err := tx.QueryRowContext(ctx, `
SELECT turn_sequence, provenance FROM workspace_agent_turn_sequences
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, workspaceID, sourceSessionID, throughTurnID).Scan(&sequence, &provenance); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return SessionForkBoundary{}, false, nil
		}
		return SessionForkBoundary{}, false, err
	}
	if turn.Phase != TurnPhaseSettled || !isVerifiedSessionForkSequence(provenance) ||
		strings.TrimSpace(turn.RootProviderTurnID) == "" {
		return SessionForkBoundary{}, false, nil
	}
	var invalidPrefix int
	if err := tx.QueryRowContext(ctx, `
SELECT EXISTS(
  SELECT 1
  FROM workspace_agent_turn_sequences sequence
  LEFT JOIN workspace_agent_turns turn
    ON turn.workspace_id = sequence.workspace_id
   AND turn.agent_session_id = sequence.agent_session_id
   AND turn.turn_id = sequence.turn_id
  WHERE sequence.workspace_id = ?
    AND sequence.agent_session_id = ?
    AND sequence.turn_sequence <= ?
    AND (
      sequence.provenance NOT IN ('verified','fork_clone_verified')
      OR turn.turn_id IS NULL
      OR turn.phase <> ?
      OR COALESCE(turn.root_provider_turn_id, '') = ''
    )
)
`, workspaceID, sourceSessionID, sequence, TurnPhaseSettled).Scan(&invalidPrefix); err != nil {
		return SessionForkBoundary{}, false, err
	}
	if invalidPrefix != 0 {
		return SessionForkBoundary{}, false, nil
	}
	providerTurnRows, err := tx.QueryContext(ctx, `
SELECT turn.root_provider_turn_id
FROM workspace_agent_turn_sequences sequence
JOIN workspace_agent_turns turn
  ON turn.workspace_id = sequence.workspace_id
 AND turn.agent_session_id = sequence.agent_session_id
 AND turn.turn_id = sequence.turn_id
WHERE sequence.workspace_id = ?
  AND sequence.agent_session_id = ?
  AND sequence.turn_sequence <= ?
ORDER BY sequence.turn_sequence
`, workspaceID, sourceSessionID, sequence)
	if err != nil {
		return SessionForkBoundary{}, false, err
	}
	rootProviderTurnIDs := make([]string, 0)
	seenRootProviderTurnIDs := make(map[string]struct{})
	for providerTurnRows.Next() {
		var providerTurnID string
		if err := providerTurnRows.Scan(&providerTurnID); err != nil {
			providerTurnRows.Close()
			return SessionForkBoundary{}, false, err
		}
		providerTurnID = strings.TrimSpace(providerTurnID)
		if providerTurnID == "" {
			providerTurnRows.Close()
			return SessionForkBoundary{}, false, nil
		}
		if _, exists := seenRootProviderTurnIDs[providerTurnID]; exists {
			providerTurnRows.Close()
			return SessionForkBoundary{}, false, nil
		}
		seenRootProviderTurnIDs[providerTurnID] = struct{}{}
		rootProviderTurnIDs = append(rootProviderTurnIDs, providerTurnID)
	}
	if err := providerTurnRows.Err(); err != nil {
		providerTurnRows.Close()
		return SessionForkBoundary{}, false, err
	}
	if err := providerTurnRows.Close(); err != nil {
		return SessionForkBoundary{}, false, err
	}
	if len(rootProviderTurnIDs) == 0 ||
		rootProviderTurnIDs[len(rootProviderTurnIDs)-1] != strings.TrimSpace(turn.RootProviderTurnID) {
		return SessionForkBoundary{}, false, nil
	}
	if descendants, err := hasSessionForkDescendantsTx(
		ctx, tx, workspaceID, sourceSessionID, sequence,
	); err != nil {
		return SessionForkBoundary{}, false, err
	} else if descendants {
		return SessionForkBoundary{}, false, nil
	}
	var boundaryMessageID int64
	if err := tx.QueryRowContext(ctx, `
SELECT COALESCE(MAX(message.id), 0)
FROM workspace_agent_messages message
JOIN workspace_agent_turn_sequences sequence
  ON sequence.workspace_id = message.workspace_id
 AND sequence.agent_session_id = message.agent_session_id
 AND sequence.turn_id = message.turn_id
WHERE message.workspace_id = ?
  AND message.agent_session_id = ?
  AND message.deleted_at_unix_ms = 0
  AND sequence.turn_sequence <= ?
`, workspaceID, sourceSessionID, sequence).Scan(&boundaryMessageID); err != nil {
		return SessionForkBoundary{}, false, err
	}
	if boundaryMessageID <= 0 {
		return SessionForkBoundary{}, false, nil
	}
	var unsupportedTurnless int
	if err := tx.QueryRowContext(ctx, `
SELECT EXISTS(
  SELECT 1
  FROM workspace_agent_messages
  WHERE workspace_id = ?
    AND agent_session_id = ?
    AND deleted_at_unix_ms = 0
    AND id <= ?
    AND turn_id IS NULL
    AND kind <> 'session_audit'
)
`, workspaceID, sourceSessionID, boundaryMessageID).Scan(&unsupportedTurnless); err != nil {
		return SessionForkBoundary{}, false, err
	}
	if unsupportedTurnless != 0 {
		return SessionForkBoundary{}, false, nil
	}
	var attachmentReferences int
	if err := tx.QueryRowContext(ctx, `
SELECT EXISTS(
  SELECT 1
  FROM workspace_agent_messages message
  JOIN json_tree(message.payload_json) payload_node
  WHERE message.workspace_id = ?
    AND message.agent_session_id = ?
    AND message.deleted_at_unix_ms = 0
    AND (
      (
        message.turn_id IS NULL
        AND message.kind = 'session_audit'
        AND message.id <= ?
      )
      OR EXISTS (
        SELECT 1
        FROM workspace_agent_turn_sequences sequence
        WHERE sequence.workspace_id = message.workspace_id
          AND sequence.agent_session_id = message.agent_session_id
          AND sequence.turn_id = message.turn_id
          AND sequence.turn_sequence <= ?
      )
    )
    AND payload_node.key = 'attachmentId'
    AND payload_node.type = 'text'
    AND TRIM(CAST(payload_node.value AS TEXT)) <> ''
)
`, workspaceID, sourceSessionID, boundaryMessageID, sequence).Scan(&attachmentReferences); err != nil {
		return SessionForkBoundary{}, false, err
	}
	if attachmentReferences != 0 {
		return SessionForkBoundary{}, false, nil
	}
	return SessionForkBoundary{
		Session:             session,
		Turn:                turn,
		RootProviderTurnIDs: rootProviderTurnIDs,
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
		identities = append(identities, identity)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate session fork turn identities: %w", err)
	}
	return identities, nil
}

func hasSessionForkDescendantsTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID, sourceSessionID string,
	throughSequence int64,
) (bool, error) {
	var descendants int
	if err := tx.QueryRowContext(ctx, `
SELECT EXISTS(
  SELECT 1
  FROM workspace_agent_sessions child
  JOIN workspace_agent_turn_sequences root_sequence
    ON root_sequence.workspace_id = child.workspace_id
   AND root_sequence.agent_session_id = child.root_agent_session_id
   AND root_sequence.turn_id = child.root_turn_id
  WHERE child.workspace_id = ?
    AND child.session_kind = ?
    AND child.root_agent_session_id = ?
    AND child.deleted_at_unix_ms = 0
    AND root_sequence.turn_sequence <= ?
)
`, workspaceID, SessionKindChild, sourceSessionID, throughSequence).Scan(&descendants); err != nil {
		return false, fmt.Errorf("read session fork descendant lanes: %w", err)
	}
	return descendants != 0, nil
}

func sessionForkSnapshotHasAttachmentReference(snapshot sessionForkSnapshot) bool {
	for _, message := range snapshot.Messages {
		if sessionForkValueHasAttachmentReference(message.Payload) {
			return true
		}
	}
	return false
}

func sessionForkValueHasAttachmentReference(value any) bool {
	switch typed := value.(type) {
	case map[string]any:
		if attachmentID, ok := typed["attachmentId"].(string); ok &&
			strings.TrimSpace(attachmentID) != "" {
			return true
		}
		for _, nested := range typed {
			if sessionForkValueHasAttachmentReference(nested) {
				return true
			}
		}
	case []any:
		for _, nested := range typed {
			if sessionForkValueHasAttachmentReference(nested) {
				return true
			}
		}
	}
	return false
}
