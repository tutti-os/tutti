package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	agentsessionreplay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

func (s *SQLiteStore) PutRecording(
	ctx context.Context,
	recording agentsessionreplay.Recording,
) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	if err := putAgentSessionRecording(ctx, s.writeDB, recording); err != nil {
		return fmt.Errorf("put Agent Session Recording: %w", err)
	}
	return nil
}

func (s *SQLiteStore) DeleteRecording(ctx context.Context, recordingID string) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	if _, err := s.writeDB.ExecContext(
		ctx,
		`DELETE FROM agent_session_recordings WHERE recording_id = ?`,
		strings.TrimSpace(recordingID),
	); err != nil {
		return fmt.Errorf("delete Agent Session Recording: %w", err)
	}
	return nil
}

func (s *SQLiteStore) PublishCassette(
	ctx context.Context,
	recording agentsessionreplay.Recording,
	cassette agentsessionreplay.Cassette,
) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin publish Agent Session Cassette: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := putAgentSessionCassette(ctx, tx, cassette); err != nil {
		return fmt.Errorf("put Agent Session Cassette: %w", err)
	}
	if err := putAgentSessionRecording(ctx, tx, recording); err != nil {
		return fmt.Errorf("link Agent Session Recording to Cassette: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Agent Session Cassette: %w", err)
	}
	return nil
}

func (s *SQLiteStore) UpdateCassette(
	ctx context.Context,
	recording agentsessionreplay.Recording,
	cassette agentsessionreplay.Cassette,
) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin update Agent Session Cassette: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := putAgentSessionCassette(ctx, tx, cassette); err != nil {
		return fmt.Errorf("update Agent Session Cassette: %w", err)
	}
	if err := putAgentSessionRecording(ctx, tx, recording); err != nil {
		return fmt.Errorf("update Agent Session Recording: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Agent Session Cassette update: %w", err)
	}
	return nil
}

func putAgentSessionCassette(
	ctx context.Context,
	execer agentSessionReplayExecer,
	cassette agentsessionreplay.Cassette,
) error {
	_, err := execer.ExecContext(ctx, `
INSERT INTO agent_session_cassettes (
  cassette_id, name, source_recording_id, workspace_id, agent_target_id,
  root_agent_session_id, mode, total_bytes, manifest_sha256, created_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(cassette_id) DO UPDATE SET
  name = excluded.name,
  source_recording_id = excluded.source_recording_id,
  workspace_id = excluded.workspace_id,
  agent_target_id = excluded.agent_target_id,
  root_agent_session_id = excluded.root_agent_session_id,
  mode = excluded.mode,
  total_bytes = excluded.total_bytes,
  manifest_sha256 = excluded.manifest_sha256,
  created_at_unix_ms = excluded.created_at_unix_ms
`, cassette.ID, cassette.Name, cassette.SourceRecordingID, cassette.ScopeID,
		cassette.AgentTargetID, cassette.RootAgentSessionID, cassette.Mode,
		cassette.TotalBytes, cassette.ManifestSHA256, cassette.CreatedAtUnixMS,
	)
	return err
}

type agentSessionReplayExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func putAgentSessionRecording(
	ctx context.Context,
	execer agentSessionReplayExecer,
	recording agentsessionreplay.Recording,
) error {
	_, err := execer.ExecContext(ctx, `
INSERT INTO agent_session_recordings (
  recording_id, name, workspace_id, agent_target_id, mode, root_agent_session_id,
  status, cassette_id, error_code, error_message, created_at_unix_ms,
  recording_at_unix_ms, stopped_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(recording_id) DO UPDATE SET
  name = excluded.name,
  workspace_id = excluded.workspace_id,
  agent_target_id = excluded.agent_target_id,
  mode = excluded.mode,
  root_agent_session_id = excluded.root_agent_session_id,
  status = excluded.status,
  cassette_id = excluded.cassette_id,
  error_code = excluded.error_code,
  error_message = excluded.error_message,
  recording_at_unix_ms = excluded.recording_at_unix_ms,
  stopped_at_unix_ms = excluded.stopped_at_unix_ms,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, recording.ID, recording.Name, recording.ScopeID, recording.AgentTargetID, recording.Mode,
		recording.RootAgentSessionID, recording.Status, recording.CassetteID,
		recording.ErrorCode, recording.ErrorMessage, recording.CreatedAtUnixMS,
		recording.RecordingAtUnixMS, recording.StoppedAtUnixMS, recording.UpdatedAtUnixMS,
	)
	return err
}

func (s *SQLiteStore) GetRecording(
	ctx context.Context,
	recordingID string,
) (agentsessionreplay.Recording, error) {
	if s == nil || s.readDB == nil {
		return agentsessionreplay.Recording{}, errors.New("workspace database is not initialized")
	}
	recording, err := scanAgentSessionRecording(s.readDB.QueryRowContext(ctx, `
SELECT recording_id, name, workspace_id, agent_target_id, mode, root_agent_session_id,
       status, cassette_id, error_code, error_message, created_at_unix_ms,
       recording_at_unix_ms, stopped_at_unix_ms, updated_at_unix_ms
FROM agent_session_recordings
WHERE recording_id = ?
`, strings.TrimSpace(recordingID)))
	if errors.Is(err, sql.ErrNoRows) {
		return agentsessionreplay.Recording{}, agentsessionreplay.ErrRecordingNotFound
	}
	return recording, err
}

func (s *SQLiteStore) ListRecordings(
	ctx context.Context,
	workspaceID string,
) ([]agentsessionreplay.Recording, error) {
	if s == nil || s.readDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	query := `
SELECT recording_id, name, workspace_id, agent_target_id, mode, root_agent_session_id,
       status, cassette_id, error_code, error_message, created_at_unix_ms,
       recording_at_unix_ms, stopped_at_unix_ms, updated_at_unix_ms
FROM agent_session_recordings`
	var args []any
	if workspaceID != "" {
		query += ` WHERE workspace_id = ?`
		args = append(args, workspaceID)
	}
	query += ` ORDER BY updated_at_unix_ms DESC, recording_id`
	rows, err := s.readDB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []agentsessionreplay.Recording{}
	for rows.Next() {
		recording, err := scanAgentSessionRecording(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, recording)
	}
	return result, rows.Err()
}

type agentSessionReplayScanner interface {
	Scan(...any) error
}

func scanAgentSessionRecording(scanner agentSessionReplayScanner) (agentsessionreplay.Recording, error) {
	var recording agentsessionreplay.Recording
	err := scanner.Scan(
		&recording.ID,
		&recording.Name,
		&recording.ScopeID,
		&recording.AgentTargetID,
		&recording.Mode,
		&recording.RootAgentSessionID,
		&recording.Status,
		&recording.CassetteID,
		&recording.ErrorCode,
		&recording.ErrorMessage,
		&recording.CreatedAtUnixMS,
		&recording.RecordingAtUnixMS,
		&recording.StoppedAtUnixMS,
		&recording.UpdatedAtUnixMS,
	)
	return recording, err
}

func (s *SQLiteStore) GetCassette(
	ctx context.Context,
	cassetteID string,
) (agentsessionreplay.Cassette, error) {
	if s == nil || s.readDB == nil {
		return agentsessionreplay.Cassette{}, errors.New("workspace database is not initialized")
	}
	cassette, err := scanAgentSessionCassette(s.readDB.QueryRowContext(ctx, `
SELECT cassette_id, name, source_recording_id, workspace_id, agent_target_id,
       root_agent_session_id, mode, total_bytes, manifest_sha256, created_at_unix_ms
FROM agent_session_cassettes
WHERE cassette_id = ?
`, strings.TrimSpace(cassetteID)))
	if errors.Is(err, sql.ErrNoRows) {
		return agentsessionreplay.Cassette{}, agentsessionreplay.ErrCassetteNotFound
	}
	return cassette, err
}

func (s *SQLiteStore) ListCassettes(
	ctx context.Context,
	workspaceID string,
) ([]agentsessionreplay.Cassette, error) {
	if s == nil || s.readDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	query := `
SELECT cassette_id, name, source_recording_id, workspace_id, agent_target_id,
       root_agent_session_id, mode, total_bytes, manifest_sha256, created_at_unix_ms
FROM agent_session_cassettes`
	var args []any
	if workspaceID != "" {
		query += ` WHERE workspace_id = ?`
		args = append(args, workspaceID)
	}
	query += ` ORDER BY created_at_unix_ms DESC, cassette_id`
	rows, err := s.readDB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []agentsessionreplay.Cassette{}
	for rows.Next() {
		cassette, err := scanAgentSessionCassette(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, cassette)
	}
	return result, rows.Err()
}

func scanAgentSessionCassette(scanner agentSessionReplayScanner) (agentsessionreplay.Cassette, error) {
	var cassette agentsessionreplay.Cassette
	err := scanner.Scan(
		&cassette.ID,
		&cassette.Name,
		&cassette.SourceRecordingID,
		&cassette.ScopeID,
		&cassette.AgentTargetID,
		&cassette.RootAgentSessionID,
		&cassette.Mode,
		&cassette.TotalBytes,
		&cassette.ManifestSHA256,
		&cassette.CreatedAtUnixMS,
	)
	return cassette, err
}

func (s *SQLiteStore) PutReplayRun(
	ctx context.Context,
	run agentsessionreplay.ReplayRun,
) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	_, err := s.writeDB.ExecContext(ctx, `
INSERT INTO agent_session_replay_runs (
  replay_run_id, cassette_id, status, checkpoint, error_code, error_message,
  created_at_unix_ms, started_at_unix_ms, completed_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(replay_run_id) DO UPDATE SET
  status = excluded.status,
  checkpoint = excluded.checkpoint,
  error_code = excluded.error_code,
  error_message = excluded.error_message,
  started_at_unix_ms = excluded.started_at_unix_ms,
  completed_at_unix_ms = excluded.completed_at_unix_ms,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, run.ID, run.CassetteID, run.Status, run.Checkpoint, run.ErrorCode,
		run.ErrorMessage, run.CreatedAtUnixMS, run.StartedAtUnixMS,
		run.CompletedAtUnixMS, run.UpdatedAtUnixMS,
	)
	if err != nil {
		return fmt.Errorf("put Agent Session Replay Run: %w", err)
	}
	return nil
}

func (s *SQLiteStore) GetReplayRun(
	ctx context.Context,
	runID string,
) (agentsessionreplay.ReplayRun, error) {
	if s == nil || s.readDB == nil {
		return agentsessionreplay.ReplayRun{}, errors.New("workspace database is not initialized")
	}
	run, err := scanAgentSessionReplayRun(s.readDB.QueryRowContext(ctx, `
SELECT replay_run_id, cassette_id, status, checkpoint, error_code, error_message,
       created_at_unix_ms, started_at_unix_ms, completed_at_unix_ms, updated_at_unix_ms
FROM agent_session_replay_runs
WHERE replay_run_id = ?
`, strings.TrimSpace(runID)))
	if errors.Is(err, sql.ErrNoRows) {
		return agentsessionreplay.ReplayRun{}, agentsessionreplay.ErrReplayRunNotFound
	}
	return run, err
}

func (s *SQLiteStore) ListReplayRuns(
	ctx context.Context,
	cassetteID string,
) ([]agentsessionreplay.ReplayRun, error) {
	if s == nil || s.readDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	query := `
SELECT replay_run_id, cassette_id, status, checkpoint, error_code, error_message,
       created_at_unix_ms, started_at_unix_ms, completed_at_unix_ms, updated_at_unix_ms
FROM agent_session_replay_runs
`
	args := []any{}
	if cassetteID = strings.TrimSpace(cassetteID); cassetteID != "" {
		query += "WHERE cassette_id = ?\n"
		args = append(args, cassetteID)
	}
	query += "ORDER BY created_at_unix_ms DESC, replay_run_id"
	rows, err := s.readDB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []agentsessionreplay.ReplayRun{}
	for rows.Next() {
		run, err := scanAgentSessionReplayRun(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, run)
	}
	return result, rows.Err()
}

func scanAgentSessionReplayRun(scanner agentSessionReplayScanner) (agentsessionreplay.ReplayRun, error) {
	var run agentsessionreplay.ReplayRun
	err := scanner.Scan(
		&run.ID,
		&run.CassetteID,
		&run.Status,
		&run.Checkpoint,
		&run.ErrorCode,
		&run.ErrorMessage,
		&run.CreatedAtUnixMS,
		&run.StartedAtUnixMS,
		&run.CompletedAtUnixMS,
		&run.UpdatedAtUnixMS,
	)
	return run, err
}
