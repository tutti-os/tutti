package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestSQLiteStorePutUserProjectRepairsImportedSessionRail(t *testing.T) {
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-project-rail", Name: "Project rail"}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	projectPath := filepath.Join(t.TempDir(), "project")
	cwd := filepath.Join(projectPath, "src")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:    "ws-project-rail",
		AgentSessionID: "imported-before-registration",
		Origin:         "runtime",
		Provider:       "codex",
		Cwd:            cwd,
		RuntimeContext: map[string]any{"imported": true},
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	initial := getTestAgentSessionRailSection(t, store, "ws-project-rail", "imported-before-registration")
	if initial.Key != agentactivitybiz.RailSectionKeyConversations {
		t.Fatalf("initial rail = %#v, want conversations", initial)
	}

	if _, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "project-rail",
		Path:  projectPath,
		Label: "project",
	}); err != nil {
		t.Fatalf("PutUserProject() error = %v", err)
	}
	final := getTestAgentSessionRailSection(t, store, "ws-project-rail", "imported-before-registration")
	wantPath := agentactivitybiz.NormalizeProjectPath(projectPath)
	if final.Kind != agentactivitybiz.RailSectionKindProject || final.ProjectPath != wantPath || final.Key != agentactivitybiz.RailSectionKeyForProject(wantPath) {
		t.Fatalf("final rail = %#v, want project path=%q", final, wantPath)
	}
}

func TestSQLiteStoreFinalizeProjectRemovalKeepsPinnedSessionAndRehomesTombstones(t *testing.T) {
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	const workspaceID = "ws-remove-project"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Remove project"}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	projectPath := filepath.Join(t.TempDir(), "project")
	if err := os.MkdirAll(projectPath, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if _, err := store.PutUserProject(ctx, userprojectbiz.Project{ID: "remove-project", Path: projectPath, Label: "project"}); err != nil {
		t.Fatalf("PutUserProject() error = %v", err)
	}
	for index, sessionID := range []string{"unpinned", "pinned"} {
		if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
			WorkspaceID: workspaceID, AgentSessionID: sessionID, Kind: "root",
			Origin: "runtime", Provider: "codex", Cwd: projectPath,
			Title: sessionID, OccurredAtUnixMS: int64(100 + index),
		}); err != nil {
			t.Fatalf("ReportSessionState(%s) error = %v", sessionID, err)
		}
	}
	if _, ok, err := store.UpdateSessionPinned(ctx, workspaceID, "pinned", true); err != nil || !ok {
		t.Fatalf("UpdateSessionPinned() ok=%v error=%v", ok, err)
	}
	var pinnedAt, createdAt, updatedAt int64
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT pinned_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_sessions WHERE workspace_id = ? AND agent_session_id = 'pinned'
`, workspaceID).Scan(&pinnedAt, &createdAt, &updatedAt); err != nil {
		t.Fatalf("read pinned session before removal: %v", err)
	}

	plan, err := store.TryFinalizeUserProjectRemovalByPath(ctx, projectPath)
	if err != nil {
		t.Fatalf("TryFinalizeUserProjectRemovalByPath(plan) error = %v", err)
	}
	if plan.Finalized || len(plan.SessionIDsByWorkspace[workspaceID]) != 1 || plan.SessionIDsByWorkspace[workspaceID][0] != "unpinned" {
		t.Fatalf("removal plan = %#v, want only unpinned session", plan)
	}
	if _, err := store.DeleteSessionsBatch(ctx, agentactivitybiz.DeleteSessionsBatchInput{
		WorkspaceID: workspaceID, SessionIDs: []string{"unpinned"},
	}); err != nil {
		t.Fatalf("DeleteSessionsBatch() error = %v", err)
	}
	finalized, err := store.TryFinalizeUserProjectRemovalByPath(ctx, projectPath)
	if err != nil || !finalized.Finalized {
		t.Fatalf("TryFinalizeUserProjectRemovalByPath(finalize) = %#v, error=%v", finalized, err)
	}
	projects, err := store.ListUserProjects(ctx)
	if err != nil || len(projects) != 0 {
		t.Fatalf("ListUserProjects() = %#v, error=%v, want empty", projects, err)
	}

	var sectionKind, railPath, sectionKey string
	var finalPinnedAt, finalCreatedAt, finalUpdatedAt, deletedAt int64
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT rail_section_kind, rail_project_path, rail_section_key,
       pinned_at_unix_ms, created_at_unix_ms, updated_at_unix_ms, deleted_at_unix_ms
FROM workspace_agent_sessions WHERE workspace_id = ? AND agent_session_id = 'pinned'
`, workspaceID).Scan(&sectionKind, &railPath, &sectionKey, &finalPinnedAt, &finalCreatedAt, &finalUpdatedAt, &deletedAt); err != nil {
		t.Fatalf("read pinned session after removal: %v", err)
	}
	if sectionKind != agentactivitybiz.RailSectionKindConversations || railPath != "" || sectionKey != agentactivitybiz.RailSectionKeyConversations || deletedAt != 0 {
		t.Fatalf("pinned session rail = kind=%q path=%q key=%q deleted=%d", sectionKind, railPath, sectionKey, deletedAt)
	}
	if finalPinnedAt != pinnedAt || finalCreatedAt != createdAt || finalUpdatedAt != updatedAt {
		t.Fatalf("pinned session metadata changed: before=(%d,%d,%d) after=(%d,%d,%d)", pinnedAt, createdAt, updatedAt, finalPinnedAt, finalCreatedAt, finalUpdatedAt)
	}

	if err := store.writeDB.QueryRowContext(ctx, `
SELECT rail_section_key, deleted_at_unix_ms
FROM workspace_agent_sessions WHERE workspace_id = ? AND agent_session_id = 'unpinned'
`, workspaceID).Scan(&sectionKey, &deletedAt); err != nil {
		t.Fatalf("read deleted unpinned session after removal: %v", err)
	}
	if sectionKey != agentactivitybiz.RailSectionKeyConversations || deletedAt == 0 {
		t.Fatalf("deleted unpinned session key=%q deleted=%d, want Chats tombstone", sectionKey, deletedAt)
	}

	// A create request may have selected its placement immediately before the
	// removal transaction committed. The canonical write must reject that
	// stale project owner instead of recreating an orphan rail section.
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: workspaceID, AgentSessionID: "late-session", Kind: "root",
		Origin: "runtime", Provider: "codex", Cwd: projectPath,
		RailPlacement: &agentactivitybiz.RailSection{
			Kind:        agentactivitybiz.RailSectionKindProject,
			ProjectPath: projectPath,
			Key:         agentactivitybiz.RailSectionKeyForProject(projectPath),
		},
		OccurredAtUnixMS: 200,
	}); err != nil {
		t.Fatalf("ReportSessionState(late stale placement) error = %v", err)
	}
	lateRail := getTestAgentSessionRailSection(t, store, workspaceID, "late-session")
	if lateRail.Kind != agentactivitybiz.RailSectionKindConversations || lateRail.Key != agentactivitybiz.RailSectionKeyConversations {
		t.Fatalf("late session rail = %#v, want Chats", lateRail)
	}
}

func TestSQLiteStoreUserProjectPathIdentityTreatsWindowsVariantsAsOneProject(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows filesystem identity is platform-specific")
	}

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	projectPath := agentactivitybiz.NormalizeProjectPath(t.TempDir())
	variantPath := strings.ToLower(filepath.ToSlash(projectPath))
	first, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "windows-project",
		Path:  projectPath,
		Label: "Windows project",
	})
	if err != nil {
		t.Fatalf("PutUserProject(first) error = %v", err)
	}
	second, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "windows-project-variant",
		Path:  variantPath,
		Label: "Windows project variant",
	})
	if err != nil {
		t.Fatalf("PutUserProject(variant) error = %v", err)
	}
	if second.ID != first.ID || second.Path != first.Path {
		t.Fatalf("variant project = %#v, want existing project %#v", second, first)
	}
	projects, err := store.ListUserProjects(ctx)
	if err != nil {
		t.Fatalf("ListUserProjects() error = %v", err)
	}
	if len(projects) != 1 {
		t.Fatalf("ListUserProjects() len = %d, want 1", len(projects))
	}
	if err := store.DeleteUserProjectByPath(ctx, variantPath); err != nil {
		t.Fatalf("DeleteUserProjectByPath(variant) error = %v", err)
	}
	projects, err = store.ListUserProjects(ctx)
	if err != nil {
		t.Fatalf("ListUserProjects() after delete error = %v", err)
	}
	if len(projects) != 0 {
		t.Fatalf("ListUserProjects() after delete len = %d, want 0", len(projects))
	}
}

func TestSQLiteStorePutUserProjectKeepsDurableOrderWhenReused(t *testing.T) {
	ctx := context.Background()
	store := openTestSQLiteStore(t)

	first, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "user_project_first",
		Path:  "/workspace/first",
		Label: "first",
	})
	if err != nil {
		t.Fatalf("PutUserProject(first) error = %v", err)
	}
	time.Sleep(2 * time.Millisecond)
	second, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "user_project_second",
		Path:  "/workspace/second",
		Label: "second",
	})
	if err != nil {
		t.Fatalf("PutUserProject(second) error = %v", err)
	}

	projects, err := store.ListUserProjects(ctx)
	if err != nil {
		t.Fatalf("ListUserProjects() error = %v", err)
	}
	if len(projects) != 2 {
		t.Fatalf("ListUserProjects() len = %d, want 2", len(projects))
	}
	if projects[0].ID != second.ID || projects[1].ID != first.ID {
		t.Fatalf("ListUserProjects() order = [%q, %q], want second then first", projects[0].ID, projects[1].ID)
	}

	time.Sleep(2 * time.Millisecond)
	usedFirst, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    first.ID,
		Path:  first.Path,
		Label: first.Label,
	})
	if err != nil {
		t.Fatalf("PutUserProject(first again) error = %v", err)
	}
	if usedFirst.CreatedAtUnixMS != first.CreatedAtUnixMS {
		t.Fatalf("PutUserProject(first again) createdAt = %d, want %d", usedFirst.CreatedAtUnixMS, first.CreatedAtUnixMS)
	}
	if usedFirst.LastUsedAtUnixMS <= first.LastUsedAtUnixMS {
		t.Fatalf("PutUserProject(first again) lastUsedAt = %d, want > %d", usedFirst.LastUsedAtUnixMS, first.LastUsedAtUnixMS)
	}

	projects, err = store.ListUserProjects(ctx)
	if err != nil {
		t.Fatalf("ListUserProjects() after reuse error = %v", err)
	}
	if projects[0].ID != second.ID || projects[1].ID != first.ID {
		t.Fatalf("ListUserProjects() after reuse order = [%q, %q], want second then first", projects[0].ID, projects[1].ID)
	}
}

func TestSQLiteStoreUserProjectOrderMigrationPreservesLegacyVisualOrder(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "legacy-user-projects.writeDB")
	store, err := OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if _, err := store.writeDB.ExecContext(ctx, `
CREATE TABLE tuttid_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at_unix_ms INTEGER NOT NULL
);
CREATE TABLE user_projects (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  last_used_at_unix_ms INTEGER NOT NULL DEFAULT 0
);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms) VALUES ('user_projects_v1', 1);
INSERT INTO user_projects (id, path, label, created_at_unix_ms, updated_at_unix_ms, last_used_at_unix_ms) VALUES
  ('beta', '/workspace/beta', 'Beta', 1, 20, 100),
  ('alpha', '/workspace/alpha', 'Alpha', 1, 10, 100),
  ('gamma', '/workspace/gamma', 'Gamma', 1, 30, 90);
`); err != nil {
		t.Fatalf("seed legacy user projects: %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	projects, err := store.ListUserProjects(ctx)
	if err != nil {
		t.Fatalf("ListUserProjects() error = %v", err)
	}
	assertUserProjectOrder(t, projects, []string{"beta", "alpha", "gamma"})
	for _, project := range projects {
		if project.PinnedAtUnixMS != 0 {
			t.Fatalf("project %s pinnedAtUnixMS = %d, want 0", project.ID, project.PinnedAtUnixMS)
		}
	}
}

func TestSQLiteStoreUserProjectPinMigrationPreservesDurableOrder(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "ordered-user-projects.writeDB")
	store, err := OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if _, err := store.writeDB.ExecContext(ctx, `
CREATE TABLE tuttid_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at_unix_ms INTEGER NOT NULL
);
CREATE TABLE user_projects (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  last_used_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms) VALUES
  ('user_projects_v1', 1),
  ('user_projects_v2', 2);
INSERT INTO user_projects (id, path, label, created_at_unix_ms, updated_at_unix_ms, last_used_at_unix_ms, sort_order) VALUES
  ('older', '/workspace/older', 'Older', 1, 10, 10, 1),
  ('newer', '/workspace/newer', 'Newer', 1, 20, 20, 0);
`); err != nil {
		t.Fatalf("seed ordered user projects: %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	projects, err := store.ListUserProjects(ctx)
	if err != nil {
		t.Fatalf("ListUserProjects() error = %v", err)
	}
	assertUserProjectOrder(t, projects, []string{"newer", "older"})
	for _, project := range projects {
		if project.PinnedAtUnixMS != 0 {
			t.Fatalf("project %s pinnedAtUnixMS = %d, want 0", project.ID, project.PinnedAtUnixMS)
		}
	}
}

func TestSQLiteStorePinsAndMovesUserProjectsWithinPartitions(t *testing.T) {
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	for _, project := range []userprojectbiz.Project{
		{ID: "alpha", Path: "/workspace/alpha", Label: "alpha"},
		{ID: "beta", Path: "/workspace/beta", Label: "beta"},
		{ID: "gamma", Path: "/workspace/gamma", Label: "gamma"},
	} {
		if _, err := store.PutUserProject(ctx, project); err != nil {
			t.Fatalf("PutUserProject(%s) error = %v", project.ID, err)
		}
	}

	projects, changed, err := store.PinUserProject(ctx, "beta", true)
	if err != nil || !changed {
		t.Fatalf("PinUserProject(beta) changed=%v error=%v", changed, err)
	}
	assertUserProjectOrder(t, projects, []string{"beta", "gamma", "alpha"})
	betaPinnedAt := projects[0].PinnedAtUnixMS
	betaUpdatedAt := projects[0].UpdatedAtUnixMS
	betaLastUsedAt := projects[0].LastUsedAtUnixMS
	if betaPinnedAt <= 0 {
		t.Fatalf("beta pinnedAtUnixMS = %d, want > 0", betaPinnedAt)
	}

	projects, changed, err = store.PinUserProject(ctx, "beta", true)
	if err != nil || changed {
		t.Fatalf("PinUserProject(beta idempotent) changed=%v error=%v", changed, err)
	}
	assertUserProjectOrder(t, projects, []string{"beta", "gamma", "alpha"})
	if projects[0].PinnedAtUnixMS != betaPinnedAt || projects[0].UpdatedAtUnixMS != betaUpdatedAt || projects[0].LastUsedAtUnixMS != betaLastUsedAt {
		t.Fatalf("idempotent pin changed beta: %#v", projects[0])
	}
	usedBeta, err := store.PutUserProject(ctx, userprojectbiz.Project{ID: "beta", Path: "/workspace/beta", Label: "beta"})
	if err != nil {
		t.Fatalf("PutUserProject(beta reused) error = %v", err)
	}
	if usedBeta.PinnedAtUnixMS != betaPinnedAt || usedBeta.SortOrder != 0 {
		t.Fatalf("reused beta = %#v, want pin and order preserved", usedBeta)
	}

	projects, changed, err = store.PinUserProject(ctx, "alpha", true)
	if err != nil || !changed {
		t.Fatalf("PinUserProject(alpha) changed=%v error=%v", changed, err)
	}
	assertUserProjectOrder(t, projects, []string{"alpha", "beta", "gamma"})
	projects, err = store.MoveUserProject(ctx, "alpha", nil)
	if err != nil {
		t.Fatalf("MoveUserProject(alpha to pinned end) error = %v", err)
	}
	assertUserProjectOrder(t, projects, []string{"beta", "alpha", "gamma"})

	beforeAlpha := "alpha"
	if _, err := store.MoveUserProject(ctx, "gamma", &beforeAlpha); !errors.Is(err, ErrUserProjectPartitionMismatch) {
		t.Fatalf("MoveUserProject(cross partition) error = %v, want ErrUserProjectPartitionMismatch", err)
	}
	projects, err = store.ListUserProjects(ctx)
	if err != nil {
		t.Fatalf("ListUserProjects() error = %v", err)
	}
	assertUserProjectOrder(t, projects, []string{"beta", "alpha", "gamma"})

	if _, err := store.PutUserProject(ctx, userprojectbiz.Project{ID: "delta", Path: "/workspace/delta", Label: "delta"}); err != nil {
		t.Fatalf("PutUserProject(delta) error = %v", err)
	}
	projects, err = store.ListUserProjects(ctx)
	if err != nil {
		t.Fatalf("ListUserProjects() error = %v", err)
	}
	assertUserProjectOrder(t, projects, []string{"beta", "alpha", "delta", "gamma"})
	projects, err = store.MoveUserProject(ctx, "delta", nil)
	if err != nil {
		t.Fatalf("MoveUserProject(delta to unpinned end) error = %v", err)
	}
	assertUserProjectOrder(t, projects, []string{"beta", "alpha", "gamma", "delta"})

	alphaLastUsedAt := projects[1].LastUsedAtUnixMS
	projects, changed, err = store.PinUserProject(ctx, "alpha", false)
	if err != nil || !changed {
		t.Fatalf("PinUserProject(alpha false) changed=%v error=%v", changed, err)
	}
	assertUserProjectOrder(t, projects, []string{"beta", "alpha", "gamma", "delta"})
	if projects[1].PinnedAtUnixMS != 0 || projects[1].LastUsedAtUnixMS != alphaLastUsedAt {
		t.Fatalf("unpin alpha = %#v, want cleared pin and unchanged lastUsed", projects[1])
	}
	if err := store.DeleteUserProject(ctx, "alpha"); err != nil {
		t.Fatalf("DeleteUserProject(alpha) error = %v", err)
	}
	readded, err := store.PutUserProject(ctx, userprojectbiz.Project{ID: "alpha", Path: "/workspace/alpha", Label: "alpha"})
	if err != nil {
		t.Fatalf("PutUserProject(alpha readded) error = %v", err)
	}
	if readded.PinnedAtUnixMS != 0 {
		t.Fatalf("readded alpha pinnedAtUnixMS = %d, want 0", readded.PinnedAtUnixMS)
	}
	projects, err = store.ListUserProjects(ctx)
	if err != nil {
		t.Fatalf("ListUserProjects() error = %v", err)
	}
	assertUserProjectOrder(t, projects, []string{"beta", "alpha", "gamma", "delta"})
	if _, _, err := store.PinUserProject(ctx, "unknown", true); !errors.Is(err, ErrUserProjectNotFound) {
		t.Fatalf("PinUserProject(unknown) error = %v, want ErrUserProjectNotFound", err)
	}
}

func TestSQLiteStoreMoveAndDeleteUserProjectsRewriteContinuousOrder(t *testing.T) {
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	for _, project := range []userprojectbiz.Project{
		{ID: "alpha", Path: "/workspace/alpha", Label: "alpha"},
		{ID: "beta", Path: "/workspace/beta", Label: "beta"},
		{ID: "gamma", Path: "/workspace/gamma", Label: "gamma"},
	} {
		if _, err := store.PutUserProject(ctx, project); err != nil {
			t.Fatalf("PutUserProject(%s) error = %v", project.ID, err)
		}
	}

	beforeAlpha := "alpha"
	projects, err := store.MoveUserProject(ctx, "beta", &beforeAlpha)
	if err != nil {
		t.Fatalf("MoveUserProject() error = %v", err)
	}
	assertUserProjectOrder(t, projects, []string{"gamma", "beta", "alpha"})

	beforeBeta := "beta"
	projects, err = store.MoveUserProject(ctx, "beta", &beforeBeta)
	if err != nil {
		t.Fatalf("MoveUserProject(self) error = %v", err)
	}
	assertUserProjectOrder(t, projects, []string{"gamma", "beta", "alpha"})

	projects, err = store.MoveUserProject(ctx, "gamma", nil)
	if err != nil {
		t.Fatalf("MoveUserProject(to end) error = %v", err)
	}
	assertUserProjectOrder(t, projects, []string{"beta", "alpha", "gamma"})

	unknownBefore := "unknown"
	if _, err := store.MoveUserProject(ctx, "beta", &unknownBefore); !errors.Is(err, ErrUserProjectNotFound) {
		t.Fatalf("MoveUserProject(unknown before) error = %v, want ErrUserProjectNotFound", err)
	}
	projects, err = store.ListUserProjects(ctx)
	if err != nil {
		t.Fatalf("ListUserProjects() after rejected move error = %v", err)
	}
	assertUserProjectOrder(t, projects, []string{"beta", "alpha", "gamma"})

	if err := store.DeleteUserProject(ctx, "beta"); err != nil {
		t.Fatalf("DeleteUserProject() error = %v", err)
	}
	projects, err = store.ListUserProjects(ctx)
	if err != nil {
		t.Fatalf("ListUserProjects() error = %v", err)
	}
	assertUserProjectOrder(t, projects, []string{"alpha", "gamma"})
	for index, project := range projects {
		if project.SortOrder != index {
			t.Fatalf("project %s sort order = %d, want %d", project.ID, project.SortOrder, index)
		}
	}

	if _, err := store.MoveUserProject(ctx, "unknown", nil); !errors.Is(err, ErrUserProjectNotFound) {
		t.Fatalf("MoveUserProject(unknown) error = %v, want ErrProjectNotFound", err)
	}
}

func assertUserProjectOrder(t *testing.T, projects []userprojectbiz.Project, want []string) {
	t.Helper()
	if len(projects) != len(want) {
		t.Fatalf("projects length = %d, want %d", len(projects), len(want))
	}
	for index, id := range want {
		if projects[index].ID != id || projects[index].SortOrder != index {
			t.Fatalf("project[%d] = %#v, want id=%s sortOrder=%d", index, projects[index], id, index)
		}
	}
}

func TestSQLiteStoreDeleteUserProjectRemovesRecentProject(t *testing.T) {
	ctx := context.Background()
	store := openTestSQLiteStore(t)

	project, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "user_project_deleted",
		Path:  "/workspace/deleted",
		Label: "deleted",
	})
	if err != nil {
		t.Fatalf("PutUserProject() error = %v", err)
	}

	if err := store.DeleteUserProject(ctx, project.ID); err != nil {
		t.Fatalf("DeleteUserProject() error = %v", err)
	}
	projects, err := store.ListUserProjects(ctx)
	if err != nil {
		t.Fatalf("ListUserProjects() error = %v", err)
	}
	if len(projects) != 0 {
		t.Fatalf("ListUserProjects() len = %d, want 0", len(projects))
	}
}

// TestSQLiteStoreDeleteUserProjectByPathRemovesRowWithMismatchedID guards
// against the "remove project" no-op regression: the `path` column is the
// table's UNIQUE key (see applyUserProjectsV1), so deleting by path must
// still remove the row even if the stored `id` doesn't match whatever a
// caller would recompute from the path. Deleting by a recomputed id instead
// is exactly the bug this store method exists to avoid.
func TestSQLiteStoreDeleteUserProjectByPathRemovesRowWithMismatchedID(t *testing.T) {
	ctx := context.Background()
	store := openTestSQLiteStore(t)

	_, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "user_project_stale-mismatched-id",
		Path:  "/workspace/mismatched",
		Label: "mismatched",
	})
	if err != nil {
		t.Fatalf("PutUserProject() error = %v", err)
	}

	if err := store.DeleteUserProjectByPath(ctx, "/workspace/mismatched"); err != nil {
		t.Fatalf("DeleteUserProjectByPath() error = %v", err)
	}
	projects, err := store.ListUserProjects(ctx)
	if err != nil {
		t.Fatalf("ListUserProjects() error = %v", err)
	}
	if len(projects) != 0 {
		t.Fatalf("ListUserProjects() len = %d, want 0", len(projects))
	}
}
