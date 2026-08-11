package storesqlite

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestRepairImportedProjectRailSectionsRepairsRowsCreatedBeforeProjectRegistration(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	projectPath := filepath.Join(t.TempDir(), "project")
	if err := os.MkdirAll(projectPath, 0o755); err != nil {
		t.Fatalf("create project: %v", err)
	}
	cwd := filepath.Join(projectPath, "src")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatalf("create project cwd: %v", err)
	}
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:    "ws-imported-rail-repair",
		AgentSessionID: "imported-before-project",
		Origin:         "runtime",
		Provider:       "codex",
		Cwd:            cwd,
		RuntimeContext: map[string]any{"imported": true},
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	initial, found, err := store.getAgentSessionRailSection(ctx, "ws-imported-rail-repair", "imported-before-project")
	if err != nil || !found || initial.Key != RailSectionKeyConversations {
		t.Fatalf("initial rail = %#v found=%v err=%v, want conversations", initial, found, err)
	}
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:    "ws-imported-rail-repair",
		AgentSessionID: "ordinary-before-project",
		Origin:         "runtime",
		Provider:       "codex",
		Cwd:            cwd,
	}); err != nil {
		t.Fatalf("ReportSessionState(ordinary) error = %v", err)
	}
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:    "ws-imported-rail-repair",
		AgentSessionID: "no-project-before-project",
		Origin:         "runtime",
		Provider:       "codex",
		Cwd:            cwd,
		RuntimeContext: map[string]any{"imported": true, "externalImportNoProject": true},
	}); err != nil {
		t.Fatalf("ReportSessionState(no-project) error = %v", err)
	}

	repaired, err := store.RepairImportedProjectRailSections(ctx, projectPath)
	if err != nil {
		t.Fatalf("RepairImportedProjectRailSections() error = %v", err)
	}
	if repaired != 1 {
		t.Fatalf("repaired = %d, want 1", repaired)
	}
	final, found, err := store.getAgentSessionRailSection(ctx, "ws-imported-rail-repair", "imported-before-project")
	if err != nil || !found {
		t.Fatalf("repaired rail = %#v found=%v err=%v", final, found, err)
	}
	wantPath := NormalizeProjectPath(projectPath)
	if final.Kind != RailSectionKindProject || final.ProjectPath != wantPath || final.Key != RailSectionKeyForProject(wantPath) {
		t.Fatalf("repaired rail = %#v, want project %q", final, wantPath)
	}
	ordinary, found, err := store.getAgentSessionRailSection(ctx, "ws-imported-rail-repair", "ordinary-before-project")
	if err != nil || !found {
		t.Fatalf("ordinary rail = %#v found=%v err=%v", ordinary, found, err)
	}
	if ordinary.Kind != RailSectionKindConversations || ordinary.Key != RailSectionKeyConversations {
		t.Fatalf("ordinary rail = %#v, want conversations", ordinary)
	}
	noProject, found, err := store.getAgentSessionRailSection(ctx, "ws-imported-rail-repair", "no-project-before-project")
	if err != nil || !found {
		t.Fatalf("no-project rail = %#v found=%v err=%v", noProject, found, err)
	}
	if noProject.Kind != RailSectionKindConversations || noProject.Key != RailSectionKeyConversations {
		t.Fatalf("no-project rail = %#v, want conversations", noProject)
	}
}

func TestRepairImportedProjectRailSectionsUsesRegisteredProjectsLongestFirst(t *testing.T) {
	t.Parallel()

	projects := &staticProjectPaths{}
	store := openTestStore(t, testOptions(projects))
	ctx := context.Background()
	parentPath := filepath.Join(t.TempDir(), "project")
	childPath := filepath.Join(parentPath, "nested")
	cwd := filepath.Join(childPath, "src")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatalf("create nested project cwd: %v", err)
	}
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:    "ws-nested-imported-rail-repair",
		AgentSessionID: "nested-imported-before-project",
		Origin:         "runtime",
		Provider:       "codex",
		Cwd:            cwd,
		RuntimeContext: map[string]any{"imported": true},
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}

	projects.paths = []string{parentPath, childPath}
	repaired, err := store.RepairImportedProjectRailSections(ctx, parentPath)
	if err != nil {
		t.Fatalf("RepairImportedProjectRailSections() error = %v", err)
	}
	if repaired != 1 {
		t.Fatalf("repaired = %d, want 1", repaired)
	}
	final, found, err := store.getAgentSessionRailSection(ctx, "ws-nested-imported-rail-repair", "nested-imported-before-project")
	if err != nil || !found {
		t.Fatalf("repaired nested rail = %#v found=%v err=%v", final, found, err)
	}
	wantPath := NormalizeProjectPath(childPath)
	if final.Kind != RailSectionKindProject || final.ProjectPath != wantPath || final.Key != RailSectionKeyForProject(wantPath) {
		t.Fatalf("repaired nested rail = %#v, want project %q", final, wantPath)
	}
}

func TestWorkspaceAgentActivityRailV2RepairsHistoricalImportedRows(t *testing.T) {
	t.Parallel()

	projects := &staticProjectPaths{}
	store := openTestStore(t, testOptions(projects))
	ctx := context.Background()
	projectPath := filepath.Join(t.TempDir(), "historical-project")
	if err := os.MkdirAll(filepath.Join(projectPath, "src"), 0o755); err != nil {
		t.Fatalf("create historical project: %v", err)
	}
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:    "ws-historical-rail-repair",
		AgentSessionID: "historical-import",
		Origin:         "runtime",
		Provider:       "codex",
		Cwd:            filepath.Join(projectPath, "src"),
		RuntimeContext: map[string]any{"imported": true},
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	projects.paths = []string{projectPath}
	if _, err := store.db.ExecContext(ctx, `DELETE FROM agent_store_schema_migrations WHERE id = ?`, schemaMigrationWorkspaceAgentActivityRailV2); err != nil {
		t.Fatalf("remove rail v2 marker: %v", err)
	}
	if err := store.applyWorkspaceAgentActivityRailV2(ctx); err != nil {
		t.Fatalf("applyWorkspaceAgentActivityRailV2() error = %v", err)
	}
	section, found, err := store.getAgentSessionRailSection(ctx, "ws-historical-rail-repair", "historical-import")
	if err != nil || !found {
		t.Fatalf("historical rail = %#v found=%v err=%v", section, found, err)
	}
	wantPath := NormalizeProjectPath(projectPath)
	if section.Kind != RailSectionKindProject || section.ProjectPath != wantPath || section.Key != RailSectionKeyForProject(wantPath) {
		t.Fatalf("historical rail = %#v, want project %q", section, wantPath)
	}
}
