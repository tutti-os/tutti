package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

type importedTranscriptMessage struct {
	id                int64
	workspaceID       string
	agentSessionID    string
	messageID         string
	turnID            string
	role              string
	kind              string
	occurredAtUnixMS  int64
	startedAtUnixMS   int64
	completedAtUnixMS int64
}

type importedTranscriptTurnAssignment struct {
	message importedTranscriptMessage
	turnID  string
}

func (s *Store) applyWorkspaceAgentImportedTurnsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentImportedTurnsV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent imported turns v1: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	messages, err := readImportedTranscriptMessagesTx(ctx, tx)
	if err != nil {
		return err
	}
	assignments := importedTranscriptTurnAssignments(messages)
	for _, sessionAssignments := range assignments {
		if len(sessionAssignments) == 0 {
			continue
		}
		first := sessionAssignments[0]
		updates := make([]MessageUpdate, 0, len(sessionAssignments))
		for _, assignment := range sessionAssignments {
			updates = append(updates, MessageUpdate{
				MessageID:         assignment.message.messageID,
				TurnID:            assignment.turnID,
				Role:              assignment.message.role,
				Kind:              assignment.message.kind,
				OccurredAtUnixMS:  assignment.message.occurredAtUnixMS,
				StartedAtUnixMS:   assignment.message.startedAtUnixMS,
				CompletedAtUnixMS: assignment.message.completedAtUnixMS,
			})
		}
		turnIDs, err := ensureHistoricalImportTurnsTx(
			ctx, tx, first.message.workspaceID, first.message.agentSessionID, updates, first.message.occurredAtUnixMS,
		)
		if err != nil {
			return err
		}
		for _, assignment := range sessionAssignments {
			if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_messages
SET turn_id = ?
WHERE id = ? AND workspace_id = ? AND agent_session_id = ? AND turn_id IS NULL
`, assignment.turnID, assignment.message.id,
				assignment.message.workspaceID, assignment.message.agentSessionID); err != nil {
				return fmt.Errorf("assign imported message %q turn: %w", assignment.message.messageID, err)
			}
		}
		if _, err := refreshHistoricalImportTurnsTx(
			ctx, tx, first.message.workspaceID, first.message.agentSessionID, turnIDs,
		); err != nil {
			return err
		}
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentImportedTurnsV1); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent imported turns v1: %w", err)
	}
	return nil
}

func readImportedTranscriptMessagesTx(ctx context.Context, tx *sql.Tx) ([]importedTranscriptMessage, error) {
	rows, err := tx.QueryContext(ctx, `
SELECT
  m.id, m.workspace_id, m.agent_session_id, m.message_id, m.turn_id,
  m.role, m.kind, m.occurred_at_unix_ms, m.started_at_unix_ms, m.completed_at_unix_ms
FROM workspace_agent_messages m
INNER JOIN workspace_agent_sessions s
  ON s.workspace_id = m.workspace_id
 AND s.agent_session_id = m.agent_session_id
WHERE s.deleted_at_unix_ms = 0
  AND m.deleted_at_unix_ms = 0
  AND json_extract(s.session_metadata_json, '$.imported') = 1
  AND m.message_id LIKE 'imported-%'
ORDER BY m.workspace_id, m.agent_session_id, m.id
`)
	if err != nil {
		return nil, fmt.Errorf("list imported transcript messages: %w", err)
	}
	defer rows.Close()

	messages := make([]importedTranscriptMessage, 0)
	for rows.Next() {
		var message importedTranscriptMessage
		var turnID sql.NullString
		if err := rows.Scan(
			&message.id,
			&message.workspaceID,
			&message.agentSessionID,
			&message.messageID,
			&turnID,
			&message.role,
			&message.kind,
			&message.occurredAtUnixMS,
			&message.startedAtUnixMS,
			&message.completedAtUnixMS,
		); err != nil {
			return nil, fmt.Errorf("scan imported transcript message: %w", err)
		}
		message.turnID = strings.TrimSpace(turnID.String)
		messages = append(messages, message)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate imported transcript messages: %w", err)
	}
	return messages, nil
}

func importedTranscriptTurnAssignments(
	messages []importedTranscriptMessage,
) map[string][]importedTranscriptTurnAssignment {
	assignments := map[string][]importedTranscriptTurnAssignment{}
	currentSession := ""
	currentTurnID := ""
	for _, message := range messages {
		sessionKey := message.workspaceID + "\x00" + message.agentSessionID
		if sessionKey != currentSession {
			currentSession = sessionKey
			currentTurnID = ""
		}
		if !strings.HasPrefix(strings.TrimSpace(message.messageID), "imported-") {
			currentTurnID = ""
			continue
		}
		if message.turnID != "" {
			currentTurnID = message.turnID
			continue
		}
		if strings.EqualFold(strings.TrimSpace(message.role), "user") &&
			strings.EqualFold(strings.TrimSpace(message.kind), "text") {
			currentTurnID = importedTranscriptTurnID(message.messageID)
		}
		if currentTurnID == "" {
			continue
		}
		assignments[sessionKey] = append(assignments[sessionKey], importedTranscriptTurnAssignment{
			message: message,
			turnID:  currentTurnID,
		})
	}
	return assignments
}

func importedTranscriptTurnID(userMessageID string) string {
	const messagePrefix = "imported-"
	userMessageID = strings.TrimSpace(userMessageID)
	if !strings.HasPrefix(userMessageID, messagePrefix) || len(userMessageID) == len(messagePrefix) {
		return ""
	}
	return "imported-turn-" + strings.TrimPrefix(userMessageID, messagePrefix)
}
