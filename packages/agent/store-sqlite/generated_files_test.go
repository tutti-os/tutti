package storesqlite

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestListWorkspaceGeneratedFileTurnsScopesAndOrdersSettledTurns(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{paths: []string{
		"/workspace/project-a",
		"/workspace/project-b",
	}}))
	ctx := context.Background()
	const workspaceID = "workspace-generated-files"
	seedGeneratedFileSession(t, ctx, store, workspaceID, "older", testTargetIDCodex, "/workspace/project-a/apps/web")
	seedGeneratedFileSession(t, ctx, store, workspaceID, "newer", testTargetIDClaude, "/workspace/project-a")
	seedGeneratedFileSession(t, ctx, store, workspaceID, "other-project", testTargetIDCodex, "/workspace/project-b")

	recordGeneratedFileTurn(t, ctx, store, workspaceID, "older", "turn-older", 100, []any{
		map[string]any{"path": "src/report.md", "change": "added"},
	})
	recordGeneratedFileTurn(t, ctx, store, workspaceID, "newer", "turn-newer", 200, []any{
		map[string]any{"path": "report.md", "change": "deleted"},
	})
	recordGeneratedFileTurn(t, ctx, store, workspaceID, "other-project", "turn-other", 300, []any{
		map[string]any{"path": "other.md", "change": "added"},
	})
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: workspaceID, AgentSessionID: "newer", TurnID: "turn-active",
		Phase: TurnPhaseRunning, Origin: TurnOriginLegacyUnknown, OccurredAtUnixMS: 400,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(active) accepted=%v error=%v", accepted, err)
	}

	result, ok, err := store.ListWorkspaceGeneratedFileTurns(ctx, ListWorkspaceGeneratedFileTurnsInput{
		WorkspaceID: workspaceID,
		SectionKey:  RailSectionKeyForProject("/workspace/project-a"),
	})
	if err != nil || !ok {
		t.Fatalf("ListWorkspaceGeneratedFileTurns() ok=%v error=%v", ok, err)
	}
	if len(result.Turns) != 2 {
		t.Fatalf("turns = %#v, want two settled project-a turns", result.Turns)
	}
	if result.Turns[0].TurnID != "turn-newer" || result.Turns[1].TurnID != "turn-older" {
		t.Fatalf("turn order = %q, %q", result.Turns[0].TurnID, result.Turns[1].TurnID)
	}
	if result.Turns[0].AgentTargetID != testTargetIDClaude || len(result.Turns[0].Changes) != 1 || result.Turns[0].Changes[0].Change != "deleted" {
		t.Fatalf("newer turn = %#v", result.Turns[0])
	}
}

func TestListWorkspaceGeneratedFileTurnsCapsSectionAtOneHundred(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{paths: []string{"/workspace/project"}}))
	ctx := context.Background()
	const workspaceID = "workspace-generated-file-limit"
	const sessionID = "session-1"
	seedGeneratedFileSession(t, ctx, store, workspaceID, sessionID, testTargetIDCodex, "/workspace/project")
	for index := 0; index < sectionGeneratedFileTurnLimit+1; index++ {
		recordGeneratedFileTurn(t, ctx, store, workspaceID, sessionID, fmt.Sprintf("turn-%03d", index), int64(100+index), []any{
			map[string]any{"path": fmt.Sprintf("file-%03d.md", index), "change": "added"},
		})
	}
	result, ok, err := store.ListWorkspaceGeneratedFileTurns(ctx, ListWorkspaceGeneratedFileTurnsInput{
		WorkspaceID: workspaceID,
		SectionKey:  RailSectionKeyForProject("/workspace/project"),
	})
	if err != nil || !ok {
		t.Fatalf("ListWorkspaceGeneratedFileTurns() ok=%v error=%v", ok, err)
	}
	if len(result.Turns) != sectionGeneratedFileTurnLimit || result.Turns[0].TurnID != "turn-100" || result.Turns[len(result.Turns)-1].TurnID != "turn-001" {
		t.Fatalf("bounded turns = %#v", result.Turns)
	}
}

func TestListWorkspaceGeneratedFileTurnsAllowsSparseQuietSections(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{paths: []string{
		"/workspace/quiet",
		"/workspace/noisy",
	}}))
	ctx := context.Background()
	const workspaceID = "workspace-generated-file-sparse"
	seedGeneratedFileSession(t, ctx, store, workspaceID, "quiet", testTargetIDCodex, "/workspace/quiet")
	seedGeneratedFileSession(t, ctx, store, workspaceID, "noisy", testTargetIDCodex, "/workspace/noisy")
	recordGeneratedFileTurn(t, ctx, store, workspaceID, "quiet", "turn-quiet", 100, []any{
		map[string]any{"path": "quiet.md", "change": "added"},
	})
	for index := 0; index < workspaceGeneratedFileTurnCandidateLimit; index++ {
		recordGeneratedFileTurn(t, ctx, store, workspaceID, "noisy", fmt.Sprintf("turn-noisy-%04d", index), int64(1000+index), nil)
	}
	result, ok, err := store.ListWorkspaceGeneratedFileTurns(ctx, ListWorkspaceGeneratedFileTurnsInput{
		WorkspaceID: workspaceID,
		SectionKey:  RailSectionKeyForProject("/workspace/quiet"),
	})
	if err != nil || !ok {
		t.Fatalf("ListWorkspaceGeneratedFileTurns() ok=%v error=%v", ok, err)
	}
	if len(result.Turns) != 0 {
		t.Fatalf("quiet section turns = %#v, want sparse empty result outside candidate window", result.Turns)
	}
}

func TestListWorkspaceGeneratedFileTurnsPlanUsesRecentSettledIndex(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	rows, err := store.db.Query(`
EXPLAIN QUERY PLAN
WITH recent_workspace_turns AS MATERIALIZED (
  SELECT agent_session_id, turn_id, settled_at_unix_ms
  FROM workspace_agent_turns INDEXED BY idx_workspace_agent_turns_workspace_settled_recent
  WHERE workspace_id = ? AND phase = 'settled' AND settled_at_unix_ms IS NOT NULL
  ORDER BY settled_at_unix_ms DESC, agent_session_id DESC, turn_id DESC
  LIMIT ?
),
scoped_turns AS MATERIALIZED (
  SELECT turns.agent_session_id, turns.turn_id, turns.settled_at_unix_ms
  FROM recent_workspace_turns turns
  JOIN workspace_agent_sessions sessions
    ON sessions.workspace_id = ? AND sessions.agent_session_id = turns.agent_session_id
  WHERE sessions.rail_section_key = ? AND sessions.deleted_at_unix_ms = 0
  ORDER BY turns.settled_at_unix_ms DESC, turns.agent_session_id DESC, turns.turn_id DESC
  LIMIT ?
)
SELECT source.file_changes_json
FROM scoped_turns scoped
JOIN workspace_agent_turns source
  ON source.workspace_id = ?
 AND source.agent_session_id = scoped.agent_session_id
 AND source.turn_id = scoped.turn_id
`, "workspace", workspaceGeneratedFileTurnCandidateLimit, "workspace", RailSectionKeyConversations, sectionGeneratedFileTurnLimit, "workspace")
	if err != nil {
		t.Fatalf("EXPLAIN QUERY PLAN error = %v", err)
	}
	defer rows.Close()
	var plan strings.Builder
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatalf("scan query plan: %v", err)
		}
		plan.WriteString(detail)
		plan.WriteByte('\n')
	}
	if !strings.Contains(plan.String(), "idx_workspace_agent_turns_workspace_settled_recent") {
		t.Fatalf("query plan does not use settled index:\n%s", plan.String())
	}
}

func seedGeneratedFileSession(
	t *testing.T,
	ctx context.Context,
	store *Store,
	workspaceID string,
	sessionID string,
	agentTargetID string,
	cwd string,
) {
	t.Helper()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:      workspaceID,
		AgentSessionID:   sessionID,
		Origin:           "runtime",
		AgentTargetID:    agentTargetID,
		Provider:         "codex",
		Cwd:              cwd,
		Status:           "active",
		OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatalf("ReportSessionState(%s) error = %v", sessionID, err)
	}
}

func recordGeneratedFileTurn(
	t *testing.T,
	ctx context.Context,
	store *Store,
	workspaceID string,
	sessionID string,
	turnID string,
	occurredAt int64,
	files []any,
) {
	t.Helper()
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID:      workspaceID,
		AgentSessionID:   sessionID,
		TurnID:           turnID,
		Phase:            TurnPhaseSettled,
		Outcome:          TurnOutcomeCompleted,
		Origin:           TurnOriginLegacyUnknown,
		FileChanges:      map[string]any{"files": files},
		OccurredAtUnixMS: occurredAt,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(%s) accepted=%v error=%v", turnID, accepted, err)
	}
}
