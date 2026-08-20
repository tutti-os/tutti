package storesqlite

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"testing"
	"time"
)

func TestRecoverableDeletePreservesGraphAndRestoresWholeTree(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedChildSessionTree(t, store)
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET title='Recover me', rail_section_key='project:/projects/removed', rail_project_path='/projects/removed', cwd='/managed/root', updated_at_unix_ms=3000
WHERE workspace_id='ws-1' AND agent_session_id='root';
UPDATE workspace_agent_sessions SET cwd='/managed/child-1' WHERE workspace_id='ws-1' AND agent_session_id='child-1';
UPDATE workspace_agent_sessions SET cwd='/managed/child-2' WHERE workspace_id='ws-1' AND agent_session_id='child-2';
INSERT INTO workspace_agent_messages (
 workspace_id,agent_session_id,message_id,version,turn_id,role,kind,status,
 semantics_json,payload_json,deleted_at_unix_ms,created_at_unix_ms,updated_at_unix_ms
) VALUES ('ws-1','root','message-root',1,'root-turn','user','text','completed','null','{"text":"keep"}',0,10,10);
INSERT INTO workspace_agent_turn_submissions (
 workspace_id,agent_session_id,turn_id,content_json,display_prompt,created_at_unix_ms,updated_at_unix_ms
) VALUES ('ws-1','root','root-turn','[{"type":"text","text":"keep"}]','keep',10,10);
`); err != nil {
		t.Fatal(err)
	}
	if _, transition, err := store.UpsertInteraction(ctx, InteractionUpsert{
		WorkspaceID: "ws-1", AgentSessionID: "root", TurnID: "root-turn", RequestID: "question",
		Kind: InteractionKindQuestion, Status: InteractionStatusPending, OccurredAtUnixMS: 20,
	}); err != nil || transition != InteractionTransitionApplied {
		t.Fatalf("seed interaction transition=%q err=%v", transition, err)
	}

	deleted, err := store.DeleteSessionWithCommit(ctx, "ws-1", "root")
	if err != nil || deleted.RemovedSessions != 3 || deleted.RemovedMessages != 1 {
		t.Fatalf("DeleteSessionWithCommit()=%#v err=%v", deleted, err)
	}
	var updatedAt, deletedAt, version int64
	var treeSize int
	if err := store.db.QueryRowContext(ctx, `
SELECT updated_at_unix_ms,deleted_at_unix_ms,recoverable_delete_version,recoverable_delete_tree_size
FROM workspace_agent_sessions WHERE workspace_id='ws-1' AND agent_session_id='root'
`).Scan(&updatedAt, &deletedAt, &version, &treeSize); err != nil {
		t.Fatal(err)
	}
	if updatedAt != 3000 || deletedAt <= 0 || version != recoverableDeleteVersionCurrent || treeSize != 3 {
		t.Fatalf("root tombstone updated=%d deleted=%d version=%d treeSize=%d", updatedAt, deletedAt, version, treeSize)
	}
	var messageTurnID string
	var messageDeletedAt int64
	if err := store.db.QueryRowContext(ctx, `SELECT turn_id,deleted_at_unix_ms FROM workspace_agent_messages WHERE message_id='message-root'`).Scan(&messageTurnID, &messageDeletedAt); err != nil || messageTurnID != "root-turn" || messageDeletedAt != 0 {
		t.Fatalf("preserved message turn=%q deleted=%d err=%v", messageTurnID, messageDeletedAt, err)
	}
	for table, want := range map[string]int{
		"workspace_agent_turns":            3,
		"workspace_agent_turn_submissions": 1,
		"workspace_agent_interactions":     1,
	} {
		var count int
		if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table+` WHERE workspace_id='ws-1'`).Scan(&count); err != nil || count != want {
			t.Fatalf("%s count=%d err=%v want=%d", table, count, err, want)
		}
	}
	var interactionStatus string
	if err := store.db.QueryRowContext(ctx, `SELECT status FROM workspace_agent_interactions WHERE request_id='question'`).Scan(&interactionStatus); err != nil || interactionStatus != InteractionStatusSuperseded {
		t.Fatalf("interaction status=%q err=%v", interactionStatus, err)
	}

	page, err := store.ListDeletedSessions(ctx, ListDeletedSessionsInput{WorkspaceID: "ws-1"})
	if err != nil || len(page.Sessions) != 1 || !page.Sessions[0].Restorable ||
		page.Sessions[0].Title != "Recover me" || page.Sessions[0].ProjectPath != "/projects/removed" ||
		page.Sessions[0].RailSectionKey != "project:/projects/removed" ||
		page.Sessions[0].UpdatedAtUnixMS != 3000 || page.TotalCount != 1 || page.WorkspaceTotalCount != 1 ||
		!reflect.DeepEqual(page.RailSections, []DeletedSessionRailSection{{
			RailSectionKey: "project:/projects/removed", ProjectPath: "/projects/removed",
		}}) {
		t.Fatalf("ListDeletedSessions()=%#v err=%v", page, err)
	}
	resources, err := store.ListRecoverableDeletedSessionResources(ctx)
	if err != nil || len(resources) != 3 {
		t.Fatalf("ListRecoverableDeletedSessionResources()=%#v err=%v", resources, err)
	}

	restored, err := store.RestoreDeletedSession(ctx, RestoreDeletedSessionInput{WorkspaceID: "ws-1", AgentSessionID: "root"})
	if err != nil || !restored.Restored || !reflect.DeepEqual(restored.RestoredSessionIDs, []string{"child-1", "child-2", "root"}) {
		t.Fatalf("RestoreDeletedSession()=%#v err=%v", restored, err)
	}
	for _, sessionID := range restored.RestoredSessionIDs {
		if deleted, err := store.SessionDeleted(ctx, "ws-1", sessionID); err != nil || deleted {
			t.Fatalf("restored SessionDeleted(%s)=%v err=%v", sessionID, deleted, err)
		}
	}
	if page, err := store.ListDeletedSessions(ctx, ListDeletedSessionsInput{WorkspaceID: "ws-1"}); err != nil || len(page.Sessions) != 0 {
		t.Fatalf("deleted page after restore=%#v err=%v", page, err)
	}
	if _, err := store.RestoreDeletedSession(ctx, RestoreDeletedSessionInput{WorkspaceID: "ws-1", AgentSessionID: "root"}); !errors.Is(err, ErrDeletedSessionNotFound) {
		t.Fatalf("replayed restore error=%v", err)
	}

	time.Sleep(2 * time.Millisecond)
	if removed, err := store.DeleteSession(ctx, "ws-1", "root"); err != nil || !removed {
		t.Fatalf("second deletion removed=%v err=%v", removed, err)
	}
	var secondDeletedAt int64
	if err := store.db.QueryRowContext(ctx, `SELECT deleted_at_unix_ms FROM workspace_agent_sessions WHERE workspace_id='ws-1' AND agent_session_id='root'`).Scan(&secondDeletedAt); err != nil || secondDeletedAt <= deletedAt {
		t.Fatalf("second deleted_at=%d first=%d err=%v", secondDeletedAt, deletedAt, err)
	}
	if removed, err := store.DeleteSession(ctx, "ws-1", "root"); err != nil || removed {
		t.Fatalf("idempotent delete removed=%v err=%v", removed, err)
	}
	var replayedDeletedAt int64
	if err := store.db.QueryRowContext(ctx, `SELECT deleted_at_unix_ms FROM workspace_agent_sessions WHERE workspace_id='ws-1' AND agent_session_id='root'`).Scan(&replayedDeletedAt); err != nil || replayedDeletedAt != secondDeletedAt {
		t.Fatalf("idempotent deleted_at=%d want=%d err=%v", replayedDeletedAt, secondDeletedAt, err)
	}
}

func TestRecoverableChildSubtreeIsListedAndRestoredAsTopmostDeletedComponent(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedChildSessionTree(t, store)
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET title='Recover child subtree', rail_section_key='project:/project/child', rail_project_path='/project/child'
WHERE workspace_id='ws-1' AND agent_session_id='child-1'
`); err != nil {
		t.Fatal(err)
	}

	deleted, err := store.DeleteSessionWithCommit(ctx, "ws-1", "child-1")
	if err != nil || deleted.RemovedSessions != 2 ||
		!reflect.DeepEqual(deleted.RemovedSessionIDs, []string{"child-2", "child-1"}) {
		t.Fatalf("DeleteSessionWithCommit(child)=%#v error=%v", deleted, err)
	}
	if rootDeleted, err := store.SessionDeleted(ctx, "ws-1", "root"); err != nil || rootDeleted {
		t.Fatalf("root deleted=%v error=%v", rootDeleted, err)
	}
	for _, sessionID := range []string{"child-1", "child-2"} {
		var componentSize int
		if err := store.db.QueryRowContext(ctx, `
SELECT recoverable_delete_tree_size FROM workspace_agent_sessions
WHERE workspace_id='ws-1' AND agent_session_id=?
`, sessionID).Scan(&componentSize); err != nil || componentSize != 2 {
			t.Fatalf("%s component size=%d error=%v, want 2", sessionID, componentSize, err)
		}
	}

	page, err := store.ListDeletedSessions(ctx, ListDeletedSessionsInput{WorkspaceID: "ws-1"})
	if err != nil || len(page.Sessions) != 1 || page.Sessions[0].AgentSessionID != "child-1" ||
		!page.Sessions[0].Restorable || page.Sessions[0].Title != "Recover child subtree" ||
		page.Sessions[0].ProjectPath != "/project/child" {
		t.Fatalf("ListDeletedSessions(child subtree)=%#v error=%v", page, err)
	}
	restored, err := store.RestoreDeletedSession(ctx, RestoreDeletedSessionInput{
		WorkspaceID: "ws-1", AgentSessionID: "child-1",
	})
	if err != nil || !restored.Restored ||
		!reflect.DeepEqual(restored.RestoredSessionIDs, []string{"child-1", "child-2"}) {
		t.Fatalf("RestoreDeletedSession(child subtree)=%#v error=%v", restored, err)
	}
}

func TestDeletingLiveAncestorAbsorbsCompleteRecoverableChildComponent(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedChildSessionTree(t, store)
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET title='Root metadata', rail_section_key='project:/project/root', rail_project_path='/project/root', cwd='/cwd/root', updated_at_unix_ms=101
WHERE workspace_id='ws-1' AND agent_session_id='root';
UPDATE workspace_agent_sessions
SET title='Child metadata', rail_section_key='project:/project/child', rail_project_path='/project/child', cwd='/cwd/child', updated_at_unix_ms=202
WHERE workspace_id='ws-1' AND agent_session_id='child-1';
UPDATE workspace_agent_sessions
SET title='Leaf metadata', rail_section_key='project:/project/leaf', rail_project_path='/project/leaf', cwd='/cwd/leaf', updated_at_unix_ms=303
WHERE workspace_id='ws-1' AND agent_session_id='child-2';
INSERT INTO workspace_agent_messages (
 workspace_id,agent_session_id,message_id,version,turn_id,role,kind,status,
 semantics_json,payload_json,deleted_at_unix_ms,created_at_unix_ms,updated_at_unix_ms
) VALUES ('ws-1','child-1','message-child',1,'child-turn-1','user','text','completed','null','{"text":"preserve me"}',0,40,40);
`); err != nil {
		t.Fatal(err)
	}

	type sessionMetadata struct {
		title, projectPath, cwd, provider string
		updatedAt                         int64
	}
	readMetadata := func(sessionID string) sessionMetadata {
		t.Helper()
		var metadata sessionMetadata
		if err := store.db.QueryRowContext(ctx, `
SELECT title,rail_project_path,cwd,provider,updated_at_unix_ms
FROM workspace_agent_sessions
WHERE workspace_id='ws-1' AND agent_session_id=?
`, sessionID).Scan(
			&metadata.title, &metadata.projectPath, &metadata.cwd, &metadata.provider, &metadata.updatedAt,
		); err != nil {
			t.Fatal(err)
		}
		return metadata
	}
	originalMetadata := make(map[string]sessionMetadata)
	for _, sessionID := range []string{"root", "child-1", "child-2"} {
		originalMetadata[sessionID] = readMetadata(sessionID)
	}

	childDeletion, err := store.DeleteSessionWithCommit(ctx, "ws-1", "child-1")
	if err != nil || childDeletion.RemovedSessions != 2 || childDeletion.RemovedMessages != 1 {
		t.Fatalf("DeleteSessionWithCommit(child)=%#v error=%v", childDeletion, err)
	}
	var childDeletedAt, childTurnUpdatedAt, childHistoryUpdatedAt int64
	if err := store.db.QueryRowContext(ctx, `
SELECT deleted_at_unix_ms FROM workspace_agent_sessions
WHERE workspace_id='ws-1' AND agent_session_id='child-1'
`).Scan(&childDeletedAt); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRowContext(ctx, `
SELECT updated_at_unix_ms FROM workspace_agent_turns
WHERE workspace_id='ws-1' AND agent_session_id='child-1' AND turn_id='child-turn-1'
`).Scan(&childTurnUpdatedAt); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRowContext(ctx, `
SELECT updated_at_unix_ms FROM workspace_agent_session_history
WHERE workspace_id='ws-1' AND agent_session_id='child-1'
`).Scan(&childHistoryUpdatedAt); err != nil {
		t.Fatal(err)
	}

	time.Sleep(3 * time.Millisecond)
	ancestorDeletion, err := store.DeleteSessionWithCommit(ctx, "ws-1", "root")
	if err != nil || ancestorDeletion.RemovedSessions != 1 || ancestorDeletion.RemovedMessages != 0 ||
		!reflect.DeepEqual(ancestorDeletion.RemovedSessionIDs, []string{"root"}) {
		t.Fatalf("DeleteSessionWithCommit(root)=%#v error=%v", ancestorDeletion, err)
	}
	var mergedDeletedAt int64
	for _, sessionID := range []string{"root", "child-1", "child-2"} {
		var deletedAt, version int64
		var treeSize int
		if err := store.db.QueryRowContext(ctx, `
SELECT deleted_at_unix_ms,recoverable_delete_version,recoverable_delete_tree_size
FROM workspace_agent_sessions
WHERE workspace_id='ws-1' AND agent_session_id=?
`, sessionID).Scan(&deletedAt, &version, &treeSize); err != nil {
			t.Fatal(err)
		}
		if mergedDeletedAt == 0 {
			mergedDeletedAt = deletedAt
		}
		if deletedAt != mergedDeletedAt || deletedAt <= childDeletedAt ||
			version != recoverableDeleteVersionCurrent || treeSize != 3 {
			t.Fatalf("%s merged tombstone deleted=%d version=%d size=%d, child deletion=%d merged=%d", sessionID, deletedAt, version, treeSize, childDeletedAt, mergedDeletedAt)
		}
	}
	var childTurnUpdatedAfterMerge, childHistoryUpdatedAfterMerge int64
	if err := store.db.QueryRowContext(ctx, `
SELECT updated_at_unix_ms FROM workspace_agent_turns
WHERE workspace_id='ws-1' AND agent_session_id='child-1' AND turn_id='child-turn-1'
`).Scan(&childTurnUpdatedAfterMerge); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRowContext(ctx, `
SELECT updated_at_unix_ms FROM workspace_agent_session_history
WHERE workspace_id='ws-1' AND agent_session_id='child-1'
`).Scan(&childHistoryUpdatedAfterMerge); err != nil {
		t.Fatal(err)
	}
	if childTurnUpdatedAfterMerge != childTurnUpdatedAt || childHistoryUpdatedAfterMerge != childHistoryUpdatedAt {
		t.Fatalf(
			"existing tombstone work was settled again: turn %d -> %d, history %d -> %d",
			childTurnUpdatedAt, childTurnUpdatedAfterMerge, childHistoryUpdatedAt, childHistoryUpdatedAfterMerge,
		)
	}

	if removed, err := store.DeleteSession(ctx, "ws-1", "root"); err != nil || removed {
		t.Fatalf("repeated merged deletion removed=%v error=%v", removed, err)
	}
	var repeatedDeletedAt int64
	if err := store.db.QueryRowContext(ctx, `
SELECT deleted_at_unix_ms FROM workspace_agent_sessions
WHERE workspace_id='ws-1' AND agent_session_id='root'
`).Scan(&repeatedDeletedAt); err != nil || repeatedDeletedAt != mergedDeletedAt {
		t.Fatalf("repeated merged deleted_at=%d want=%d error=%v", repeatedDeletedAt, mergedDeletedAt, err)
	}

	page, err := store.ListDeletedSessions(ctx, ListDeletedSessionsInput{WorkspaceID: "ws-1"})
	if err != nil || len(page.Sessions) != 1 || page.Sessions[0].AgentSessionID != "root" || !page.Sessions[0].Restorable {
		t.Fatalf("merged deleted page=%#v error=%v", page, err)
	}
	restored, err := store.RestoreDeletedSession(ctx, RestoreDeletedSessionInput{
		WorkspaceID: "ws-1", AgentSessionID: "root",
	})
	if err != nil || !reflect.DeepEqual(restored.RestoredSessionIDs, []string{"child-1", "child-2", "root"}) {
		t.Fatalf("RestoreDeletedSession(merged root)=%#v error=%v", restored, err)
	}
	for sessionID, expected := range originalMetadata {
		if actual := readMetadata(sessionID); !reflect.DeepEqual(actual, expected) {
			t.Fatalf("%s metadata after restore=%#v want=%#v", sessionID, actual, expected)
		}
	}
	var payload string
	var messageDeletedAt int64
	if err := store.db.QueryRowContext(ctx, `
SELECT payload_json,deleted_at_unix_ms FROM workspace_agent_messages
WHERE workspace_id='ws-1' AND agent_session_id='child-1' AND message_id='message-child'
`).Scan(&payload, &messageDeletedAt); err != nil || payload != `{"text":"preserve me"}` || messageDeletedAt != 0 {
		t.Fatalf("restored child message payload=%q deleted=%d error=%v", payload, messageDeletedAt, err)
	}
}

func TestDeletingLiveAncestorDoesNotUpgradeLegacyChildComponent(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedChildSessionTree(t, store)
	if _, err := store.DeleteSession(ctx, "ws-1", "child-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET recoverable_delete_version=0,recoverable_delete_tree_size=0
WHERE workspace_id='ws-1' AND agent_session_id IN ('child-1','child-2');
DELETE FROM workspace_agent_turns
WHERE workspace_id='ws-1' AND agent_session_id='child-2';
`); err != nil {
		t.Fatal(err)
	}

	deleted, err := store.DeleteSessionWithCommit(ctx, "ws-1", "root")
	if err != nil || deleted.RemovedSessions != 1 || !reflect.DeepEqual(deleted.RemovedSessionIDs, []string{"root"}) {
		t.Fatalf("DeleteSessionWithCommit(root with legacy child)=%#v error=%v", deleted, err)
	}
	for _, childID := range []string{"child-1", "child-2"} {
		var version int64
		if err := store.db.QueryRowContext(ctx, `
SELECT recoverable_delete_version FROM workspace_agent_sessions
WHERE workspace_id='ws-1' AND agent_session_id=?
`, childID).Scan(&version); err != nil || version != 0 {
			t.Fatalf("legacy child %s version=%d error=%v", childID, version, err)
		}
	}
	page, err := store.ListDeletedSessions(ctx, ListDeletedSessionsInput{WorkspaceID: "ws-1"})
	if err != nil || len(page.Sessions) != 1 || page.Sessions[0].AgentSessionID != "root" ||
		page.Sessions[0].Restorable || page.Sessions[0].UnavailableReason != DeletedSessionUnavailableIncompleteTree {
		t.Fatalf("legacy descendant page=%#v error=%v", page, err)
	}
	if _, err := store.RestoreDeletedSession(ctx, RestoreDeletedSessionInput{
		WorkspaceID: "ws-1", AgentSessionID: "root",
	}); !errors.Is(err, ErrDeletedSessionNotRestorable) {
		t.Fatalf("restore root with legacy child error=%v", err)
	}
	purged, err := store.PurgeDeletedSessionTrees(ctx, PurgeDeletedSessionTreesInput{
		WorkspaceID: "ws-1", RootSessionIDs: []string{"root"},
	})
	if err != nil || purged.RemovedSessions != 3 ||
		!reflect.DeepEqual(purged.PurgedSessionIDs, []string{"child-1", "child-2", "root"}) {
		t.Fatalf("purge root with legacy child=%#v error=%v", purged, err)
	}
}

func TestRecoverableDeletePreservesStableGoalAndHistoryAcrossRestore(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-stable-goal", AgentSessionID: "session", Provider: "codex", OccurredAtUnixMS: 10,
	}, "turn", 10)
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_session_goals (
 workspace_id,agent_session_id,desired_json,observed_json,revision,tombstoned,
 sync_status,pending_operation_id,last_evidence_json,last_error,
 observed_at_unix_ms,created_at_unix_ms,updated_at_unix_ms
) VALUES (
 'ws-stable-goal','session',
 '{"objective":"keep this goal","status":"active"}',
 '{"objective":"keep this goal","status":"active"}',
 7,0,'synced',NULL,'{"source":"stable"}','',90,80,100
)
`); err != nil {
		t.Fatal(err)
	}
	goalBefore, found, err := store.GetSessionGoalState(ctx, "ws-stable-goal", "session")
	if err != nil || !found {
		t.Fatalf("GetSessionGoalState(before)=%#v found=%v error=%v", goalBefore, found, err)
	}
	type historySnapshot struct {
		revision  int64
		state     string
		operation string
		updatedAt int64
	}
	readHistory := func() historySnapshot {
		t.Helper()
		var snapshot historySnapshot
		if err := store.db.QueryRowContext(ctx, `
SELECT history_revision,recovery_state,operation_id,updated_at_unix_ms
FROM workspace_agent_session_history
WHERE workspace_id='ws-stable-goal' AND agent_session_id='session'
`).Scan(&snapshot.revision, &snapshot.state, &snapshot.operation, &snapshot.updatedAt); err != nil {
			t.Fatal(err)
		}
		return snapshot
	}
	historyBefore := readHistory()

	if removed, err := store.DeleteSession(ctx, "ws-stable-goal", "session"); err != nil || !removed {
		t.Fatalf("DeleteSession(stable goal) removed=%v error=%v", removed, err)
	}
	if _, err := store.RestoreDeletedSession(ctx, RestoreDeletedSessionInput{
		WorkspaceID: "ws-stable-goal", AgentSessionID: "session",
	}); err != nil {
		t.Fatalf("RestoreDeletedSession(stable goal) error=%v", err)
	}
	goalAfter, found, err := store.GetSessionGoalState(ctx, "ws-stable-goal", "session")
	if err != nil || !found || !reflect.DeepEqual(goalAfter, goalBefore) {
		t.Fatalf("stable goal after restore=%#v found=%v error=%v want=%#v", goalAfter, found, err, goalBefore)
	}
	if historyAfter := readHistory(); !reflect.DeepEqual(historyAfter, historyBefore) {
		t.Fatalf("stable history after restore=%#v want=%#v", historyAfter, historyBefore)
	}
}

func TestRecoverableDeleteTerminatesPendingGoalWithoutClearingGoalSemantics(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-pending-goal", AgentSessionID: "session", Provider: "codex", OccurredAtUnixMS: 10,
	}, "turn", 10)
	opBefore, goalBefore, created, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "goal-operation", WorkspaceID: "ws-pending-goal", AgentSessionID: "session",
		Action: "set", Objective: "preserve this objective", OccurredAtUnixMS: 20,
	})
	if err != nil || !created || goalBefore.SyncStatus != GoalSyncStatusPending || goalBefore.PendingOperationID != opBefore.OperationID {
		t.Fatalf("PrepareGoalControlOperation() op=%#v goal=%#v created=%v error=%v", opBefore, goalBefore, created, err)
	}
	if removed, err := store.DeleteSession(ctx, "ws-pending-goal", "session"); err != nil || !removed {
		t.Fatalf("DeleteSession(pending goal) removed=%v error=%v", removed, err)
	}
	if _, err := store.RestoreDeletedSession(ctx, RestoreDeletedSessionInput{
		WorkspaceID: "ws-pending-goal", AgentSessionID: "session",
	}); err != nil {
		t.Fatalf("RestoreDeletedSession(pending goal) error=%v", err)
	}

	goalAfter, found, err := store.GetSessionGoalState(ctx, "ws-pending-goal", "session")
	if err != nil || !found {
		t.Fatalf("GetSessionGoalState(after)=%#v found=%v error=%v", goalAfter, found, err)
	}
	if !reflect.DeepEqual(goalAfter.Desired, goalBefore.Desired) ||
		!reflect.DeepEqual(goalAfter.Observed, goalBefore.Observed) ||
		goalAfter.Revision != goalBefore.Revision || goalAfter.Tombstoned != goalBefore.Tombstoned ||
		!reflect.DeepEqual(goalAfter.LastEvidence, goalBefore.LastEvidence) ||
		goalAfter.ObservedAtUnixMS != goalBefore.ObservedAtUnixMS ||
		goalAfter.CreatedAtUnixMS != goalBefore.CreatedAtUnixMS {
		t.Fatalf("pending goal semantics changed: after=%#v before=%#v", goalAfter, goalBefore)
	}
	if goalAfter.SyncStatus != GoalSyncStatusFailed || goalAfter.PendingOperationID != "" ||
		goalAfter.LastError != "session deleted" || goalAfter.UpdatedAtUnixMS <= goalBefore.UpdatedAtUnixMS {
		t.Fatalf("pending goal terminal state=%#v", goalAfter)
	}
	opAfter, found, err := store.GetGoalControlOperation(ctx, "ws-pending-goal", opBefore.OperationID)
	if err != nil || !found || opAfter.Status != GoalOperationStatusFailed ||
		opAfter.LastError != "session deleted" || opAfter.CompletedAtUnixMS <= 0 {
		t.Fatalf("pending goal operation after restore=%#v found=%v error=%v", opAfter, found, err)
	}
}

func TestSiblingChildBatchCreatesIndependentDeletedComponents(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-siblings", AgentSessionID: "root", Kind: SessionKindRoot,
		Provider: "codex", OccurredAtUnixMS: 10,
	}, "root-turn", 10)
	for index, childID := range []string{"child-a", "child-b"} {
		reportSessionWithTurn(t, store, SessionStateReport{
			WorkspaceID: "ws-siblings", AgentSessionID: childID, Kind: SessionKindChild,
			RootAgentSessionID: "root", RootTurnID: "root-turn",
			ParentAgentSessionID: "root", ParentTurnID: "root-turn",
			ParentToolCallID: "call-" + childID, Provider: "codex",
			Title: "Sibling " + childID, OccurredAtUnixMS: int64(20 + index),
		}, "turn-"+childID, int64(20+index))
	}

	deleted, err := store.DeleteSessionsBatch(ctx, DeleteSessionsBatchInput{
		WorkspaceID: "ws-siblings", SessionIDs: []string{"child-a", "child-b"},
	})
	if err != nil || deleted.RemovedSessions != 2 {
		t.Fatalf("DeleteSessionsBatch(siblings)=%#v error=%v", deleted, err)
	}
	for _, childID := range []string{"child-a", "child-b"} {
		var componentSize int
		if err := store.db.QueryRowContext(ctx, `
SELECT recoverable_delete_tree_size FROM workspace_agent_sessions
WHERE workspace_id='ws-siblings' AND agent_session_id=?
`, childID).Scan(&componentSize); err != nil || componentSize != 1 {
			t.Fatalf("%s component size=%d error=%v, want 1", childID, componentSize, err)
		}
	}
	page, err := store.ListDeletedSessions(ctx, ListDeletedSessionsInput{WorkspaceID: "ws-siblings"})
	if err != nil || len(page.Sessions) != 2 || !page.Sessions[0].Restorable || !page.Sessions[1].Restorable {
		t.Fatalf("ListDeletedSessions(siblings)=%#v error=%v", page, err)
	}
	listed := []string{page.Sessions[0].AgentSessionID, page.Sessions[1].AgentSessionID}
	sort.Strings(listed)
	if !reflect.DeepEqual(listed, []string{"child-a", "child-b"}) {
		t.Fatalf("listed sibling components=%#v", listed)
	}

	restored, err := store.RestoreDeletedSession(ctx, RestoreDeletedSessionInput{
		WorkspaceID: "ws-siblings", AgentSessionID: "child-a",
	})
	if err != nil || !reflect.DeepEqual(restored.RestoredSessionIDs, []string{"child-a"}) {
		t.Fatalf("RestoreDeletedSession(child-a)=%#v error=%v", restored, err)
	}
	purged, err := store.PurgeDeletedSessionTrees(ctx, PurgeDeletedSessionTreesInput{
		WorkspaceID: "ws-siblings", RootSessionIDs: []string{"child-b"},
	})
	if err != nil || purged.RemovedSessions != 1 ||
		!reflect.DeepEqual(purged.PurgedRootSessionIDs, []string{"child-b"}) ||
		!reflect.DeepEqual(purged.PurgedSessionIDs, []string{"child-b"}) {
		t.Fatalf("PurgeDeletedSessionTrees(child-b)=%#v error=%v", purged, err)
	}
	for _, sessionID := range []string{"root", "child-a"} {
		if _, found, err := store.GetSession(ctx, "ws-siblings", sessionID); err != nil || !found {
			t.Fatalf("surviving session %s found=%v error=%v", sessionID, found, err)
		}
	}
	if _, found, err := store.GetSession(ctx, "ws-siblings", "child-b"); err != nil || found {
		t.Fatalf("purged child-b found=%v error=%v", found, err)
	}
}

func TestPartiallyPurgedRecoverableTreeIsNotRestorable(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedChildSessionTree(t, store)
	if _, err := store.DeleteSession(ctx, "ws-1", "root"); err != nil {
		t.Fatal(err)
	}
	var deletedAt int64
	if err := store.db.QueryRowContext(ctx, `SELECT deleted_at_unix_ms FROM workspace_agent_sessions WHERE workspace_id='ws-1' AND agent_session_id='root'`).Scan(&deletedAt); err != nil {
		t.Fatal(err)
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, removed, err := purgeDeletedSessionTx(ctx, tx, PurgedSession{
		WorkspaceID: "ws-1", AgentSessionID: "child-2", DeletedAtUnixMS: deletedAt,
	})
	if err != nil || !removed {
		_ = tx.Rollback()
		t.Fatalf("simulate legacy partial purge removed=%v err=%v", removed, err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	page, err := store.ListDeletedSessions(ctx, ListDeletedSessionsInput{WorkspaceID: "ws-1"})
	if err != nil || len(page.Sessions) != 1 || page.Sessions[0].Restorable || page.Sessions[0].UnavailableReason != DeletedSessionUnavailableIncompleteTree {
		t.Fatalf("partially purged page=%#v err=%v", page, err)
	}
	if _, err := store.RestoreDeletedSession(ctx, RestoreDeletedSessionInput{WorkspaceID: "ws-1", AgentSessionID: "root"}); !errors.Is(err, ErrDeletedSessionNotRestorable) {
		t.Fatalf("partial restore error=%v", err)
	}
}

func TestDeletedSessionListFiltersAndUsesStableUpdatedCursor(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	for _, row := range []struct {
		id, title, project string
		updated            int64
	}{
		{id: "alpha", title: "Find Alpha", project: "/project/a", updated: 3000},
		{id: "beta", title: "Find Beta", project: "", updated: 3000},
		{id: "gamma", title: "Other", project: "/project/b", updated: 2000},
	} {
		if _, err := store.ReportSessionState(ctx, SessionStateReport{WorkspaceID: "ws-list", AgentSessionID: row.id, Provider: "codex", Title: row.title, OccurredAtUnixMS: row.updated}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.db.ExecContext(ctx, `UPDATE workspace_agent_sessions SET rail_section_key=?,rail_project_path=?,updated_at_unix_ms=? WHERE workspace_id='ws-list' AND agent_session_id=?`, RailSectionKeyForProject(row.project), row.project, row.updated, row.id); err != nil {
			t.Fatal(err)
		}
		if _, err := store.DeleteSession(ctx, "ws-list", row.id); err != nil {
			t.Fatal(err)
		}
	}
	first, err := store.ListDeletedSessions(ctx, ListDeletedSessionsInput{WorkspaceID: "ws-list", SearchQuery: "find", Limit: 1})
	if err != nil || len(first.Sessions) != 1 || first.Sessions[0].AgentSessionID != "alpha" || !first.HasMore || first.NextCursor != "3000|alpha" || first.TotalCount != 2 || first.WorkspaceTotalCount != 3 {
		t.Fatalf("first page=%#v err=%v", first, err)
	}
	second, err := store.ListDeletedSessions(ctx, ListDeletedSessionsInput{
		WorkspaceID: "ws-list", SearchQuery: "find", Limit: 1,
		CursorUpdatedAtUnixMS: 3000, CursorAgentSessionID: "alpha",
	})
	if err != nil || len(second.Sessions) != 1 || second.Sessions[0].AgentSessionID != "beta" || second.HasMore {
		t.Fatalf("second page=%#v err=%v", second, err)
	}
	unscoped := RailSectionKeyConversations
	filtered, err := store.ListDeletedSessions(ctx, ListDeletedSessionsInput{WorkspaceID: "ws-list", RailSectionKey: &unscoped})
	if err != nil || len(filtered.Sessions) != 1 || filtered.Sessions[0].AgentSessionID != "beta" || filtered.TotalCount != 1 {
		t.Fatalf("unscoped page=%#v err=%v", filtered, err)
	}
}

func TestDeletedSessionListUsesRailSectionKeyWhenPersistedPathsDisagree(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	projectSectionKey := RailSectionKeyForProject("/project/right")
	for _, sessionID := range []string{"project-session", "conversation-session"} {
		if _, err := store.ReportSessionState(ctx, SessionStateReport{
			WorkspaceID: "ws-key-authority", AgentSessionID: sessionID,
			Provider: "codex", Title: sessionID, OccurredAtUnixMS: 100,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET rail_section_key=?, rail_project_path='/project/wrong', cwd='/project/wrong/.tutti/agent/worktrees/project-session'
WHERE workspace_id='ws-key-authority' AND agent_session_id='project-session';
UPDATE workspace_agent_sessions
SET rail_section_key='conversations', rail_project_path='/project/wrong', cwd='/project/right'
WHERE workspace_id='ws-key-authority' AND agent_session_id='conversation-session';
`, projectSectionKey); err != nil {
		t.Fatal(err)
	}
	for _, sessionID := range []string{"project-session", "conversation-session"} {
		if _, err := store.DeleteSession(ctx, "ws-key-authority", sessionID); err != nil {
			t.Fatal(err)
		}
	}

	projectPage, err := store.ListDeletedSessions(ctx, ListDeletedSessionsInput{
		WorkspaceID: "ws-key-authority", RailSectionKey: &projectSectionKey,
	})
	if err != nil || len(projectPage.Sessions) != 1 ||
		projectPage.Sessions[0].AgentSessionID != "project-session" ||
		projectPage.Sessions[0].RailSectionKey != projectSectionKey ||
		projectPage.Sessions[0].ProjectPath != "/project/wrong" ||
		!reflect.DeepEqual(projectPage.RailSections, []DeletedSessionRailSection{{
			RailSectionKey: projectSectionKey, ProjectPath: "/project/wrong",
		}}) {
		t.Fatalf("project page=%#v error=%v", projectPage, err)
	}
	wrongPathKey := RailSectionKeyForProject("/project/wrong")
	wrongPathPage, err := store.ListDeletedSessions(ctx, ListDeletedSessionsInput{
		WorkspaceID: "ws-key-authority", RailSectionKey: &wrongPathKey,
	})
	if err != nil || len(wrongPathPage.Sessions) != 0 {
		t.Fatalf("wrong-path page=%#v error=%v", wrongPathPage, err)
	}
	conversations := RailSectionKeyConversations
	conversationPage, err := store.ListDeletedSessions(ctx, ListDeletedSessionsInput{
		WorkspaceID: "ws-key-authority", RailSectionKey: &conversations,
	})
	if err != nil || len(conversationPage.Sessions) != 1 ||
		conversationPage.Sessions[0].AgentSessionID != "conversation-session" {
		t.Fatalf("conversation page=%#v error=%v", conversationPage, err)
	}
}

func TestLegacyDeletedSessionIsListedButCannotRestoreAndCanPurge(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{WorkspaceID: "ws-legacy", AgentSessionID: "legacy", Provider: "codex", Title: "Legacy", OccurredAtUnixMS: 100}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE workspace_agent_sessions SET deleted_at_unix_ms=200,recoverable_delete_version=0 WHERE workspace_id='ws-legacy'`); err != nil {
		t.Fatal(err)
	}
	page, err := store.ListDeletedSessions(ctx, ListDeletedSessionsInput{WorkspaceID: "ws-legacy"})
	if err != nil || len(page.Sessions) != 1 || page.Sessions[0].Restorable || page.Sessions[0].UnavailableReason != DeletedSessionUnavailableLegacyData {
		t.Fatalf("legacy page=%#v err=%v", page, err)
	}
	if _, err := store.RestoreDeletedSession(ctx, RestoreDeletedSessionInput{WorkspaceID: "ws-legacy", AgentSessionID: "legacy"}); !errors.Is(err, ErrDeletedSessionNotRestorable) {
		t.Fatalf("legacy restore error=%v", err)
	}
	purged, err := store.PurgeDeletedSessionTrees(ctx, PurgeDeletedSessionTreesInput{WorkspaceID: "ws-legacy", RootSessionIDs: []string{"legacy"}})
	if err != nil || purged.RemovedSessions != 1 || !reflect.DeepEqual(purged.PurgedRootSessionIDs, []string{"legacy"}) {
		t.Fatalf("legacy purge=%#v err=%v", purged, err)
	}
	var count int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM workspace_agent_sessions WHERE workspace_id='ws-legacy'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("legacy session count=%d err=%v", count, err)
	}
}

func TestPurgeDeletedSessionTreesIsWorkspaceScopedAndRemovesWholeTree(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedChildSessionTree(t, store)
	if _, err := store.DeleteSession(ctx, "ws-1", "root"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-other", AgentSessionID: "other", Provider: "codex", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.DeleteSession(ctx, "ws-other", "other"); err != nil {
		t.Fatal(err)
	}

	purged, err := store.PurgeDeletedSessionTrees(ctx, PurgeDeletedSessionTreesInput{WorkspaceID: "ws-1"})
	if err != nil || purged.RemovedSessions != 3 ||
		!reflect.DeepEqual(purged.PurgedRootSessionIDs, []string{"root"}) ||
		!reflect.DeepEqual(purged.PurgedSessionIDs, []string{"child-1", "child-2", "root"}) {
		t.Fatalf("workspace purge=%#v err=%v", purged, err)
	}
	var workspaceCount, otherCount int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM workspace_agent_sessions WHERE workspace_id='ws-1'`).Scan(&workspaceCount); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM workspace_agent_sessions WHERE workspace_id='ws-other'`).Scan(&otherCount); err != nil {
		t.Fatal(err)
	}
	if workspaceCount != 0 || otherCount != 1 {
		t.Fatalf("post-purge counts workspace=%d other=%d", workspaceCount, otherCount)
	}
}

func TestPurgeDeletedSessionTreesTxLeavesCommitAndRollbackToCaller(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedChildSessionTree(t, store)
	if _, err := store.DeleteSession(ctx, "ws-1", "root"); err != nil {
		t.Fatal(err)
	}

	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := store.PurgeDeletedSessionTreesTx(ctx, tx, PurgeDeletedSessionTreesInput{
		WorkspaceID: "ws-1", RootSessionIDs: []string{"root"},
	})
	if err != nil || result.RemovedSessions != 3 {
		_ = tx.Rollback()
		t.Fatalf("PurgeDeletedSessionTreesTx()=%#v error=%v", result, err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	assertPurgeRowCount(t, store.db, "workspace_agent_sessions", "root", 1)
	assertPurgeRowCount(t, store.db, "workspace_agent_sessions", "child-1", 1)
	assertPurgeRowCount(t, store.db, "workspace_agent_sessions", "child-2", 1)

	tx, err = store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err = store.PurgeDeletedSessionTreesTx(ctx, tx, PurgeDeletedSessionTreesInput{
		WorkspaceID: "ws-1", RootSessionIDs: []string{"root"},
	})
	if err != nil || result.RemovedSessions != 3 {
		_ = tx.Rollback()
		t.Fatalf("PurgeDeletedSessionTreesTx(commit)=%#v error=%v", result, err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	assertPurgeRowCount(t, store.db, "workspace_agent_sessions", "root", 0)
	assertPurgeRowCount(t, store.db, "workspace_agent_sessions", "child-1", 0)
	assertPurgeRowCount(t, store.db, "workspace_agent_sessions", "child-2", 0)
}
