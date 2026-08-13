package agent

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

func TestServiceImportExternalSessionsOmitsProjectsWithoutValidSessions(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Workspace One"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	root := t.TempDir()
	emptyProject := filepath.Join(root, "empty-project")
	if err := os.MkdirAll(emptyProject, 0o755); err != nil {
		t.Fatalf("create empty project error = %v", err)
	}
	if canonical, ok := canonicalExistingDir(emptyProject); ok {
		emptyProject = canonical
	}
	// No Codex/Claude history exists under these homes, so the selected project
	// has no valid session.
	t.Setenv("CODEX_HOME", filepath.Join(root, "codex-home"))
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(root, "claude-home"))

	service := newIsolatedAgentService(newFakeRuntime())
	projection := NewActivityProjection(store)
	service.SessionReader = projection
	service.MessageReader = projection
	service.ExternalImportStore = store

	result, err := service.ImportExternalSessions(ctx, "ws-1", ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: emptyProject}},
	})
	if err != nil {
		t.Fatalf("ImportExternalSessions error = %v", err)
	}
	if len(result.ProjectPaths) != 0 {
		t.Fatalf("project paths = %#v, want none for project without valid sessions", result.ProjectPaths)
	}
	if result.ImportedSessions != 0 || result.ImportedProjects != 0 {
		t.Fatalf("import result = %#v, want nothing imported", result)
	}
}

func TestServiceImportExternalSessionsRepairsSelectedNestedProjectRailMembership(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Workspace One"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	root := t.TempDir()
	parentProject := filepath.Join(root, "dev")
	nestedProject := filepath.Join(parentProject, "kage")
	if err := os.MkdirAll(nestedProject, 0o755); err != nil {
		t.Fatalf("create nested project error = %v", err)
	}
	if canonical, ok := canonicalExistingDir(parentProject); ok {
		parentProject = canonical
	}
	if canonical, ok := canonicalExistingDir(nestedProject); ok {
		nestedProject = canonical
	}
	if _, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "parent-project",
		Path:  parentProject,
		Label: "dev",
	}); err != nil {
		t.Fatalf("PutUserProject(parent) error = %v", err)
	}

	codexHome := filepath.Join(root, "codex-home")
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(root, "claude-home"))
	now := time.Now().UTC().Format(time.RFC3339Nano)
	writeAgentServiceJSONL(t, filepath.Join(codexHome, "sessions", "nested.jsonl"),
		map[string]any{
			"timestamp": now,
			"type":      "session_meta",
			"payload":   map[string]any{"id": "nested-session", "cwd": nestedProject},
		},
		map[string]any{"timestamp": now, "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "nested-message", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "Nested prompt"}},
		}},
	)
	legacy, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-1",
		AgentSessionID:   externalImportedSessionID("codex", "nested-session"),
		Origin:           WorkspaceAgentSessionOriginImported,
		Provider:         "codex",
		RuntimeContext:   map[string]any{"imported": true},
		Cwd:              nestedProject,
		Title:            "Nested prompt",
		Status:           "completed",
		CurrentPhase:     "completed",
		OccurredAtUnixMS: time.Now().UTC().UnixMilli(),
	})
	if err != nil {
		t.Fatalf("ReportSessionState(legacy parent membership) error = %v", err)
	}
	if legacy.Session.RailSectionKey != agentactivitybiz.RailSectionKeyForProject(parentProject) {
		t.Fatalf("legacy railSectionKey = %q, want parent before reimport", legacy.Session.RailSectionKey)
	}

	service := newIsolatedAgentService(newFakeRuntime())
	projection := NewActivityProjection(store)
	service.SessionReader = projection
	service.MessageReader = projection
	service.ExternalImportStore = store

	result, err := service.ImportExternalSessions(ctx, "ws-1", ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: nestedProject}},
	})
	if err != nil {
		t.Fatalf("ImportExternalSessions error = %v", err)
	}
	if result.ImportedSessions != 1 {
		t.Fatalf("import result = %#v, want one imported session", result)
	}
	persisted, ok, err := store.GetSession(ctx, "ws-1", externalImportedSessionID("codex", "nested-session"))
	if err != nil || !ok {
		t.Fatalf("GetSession() ok=%v error=%v", ok, err)
	}
	wantSectionKey := agentactivitybiz.RailSectionKeyForProject(nestedProject)
	if persisted.RailSectionKey != wantSectionKey {
		t.Fatalf("railSectionKey = %q, want selected nested project %q", persisted.RailSectionKey, wantSectionKey)
	}
}

// TestServiceImportExternalSessionsOmitsProjectWhenOnlySessionFailsToImport
// covers the case where a project's only session is a real, valid import
// candidate but the store write itself fails (a transient error, a write
// timeout, etc.). Previously ImportExternalSessions recorded the project path
// as "valid" before attempting the import, so a failed write still surfaced
// the project in ProjectPaths — and since registerExternalImportUserProjects
// registers every path ProjectPaths contains, that produced a folder card
// with no chats under it. The project must only be reported once at least one
// of its sessions actually lands in the store without error.
func TestServiceImportExternalSessionsOmitsProjectWhenOnlySessionFailsToImport(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Workspace One"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	root := t.TempDir()
	project := filepath.Join(root, "project-a")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatalf("create project error = %v", err)
	}
	if canonical, ok := canonicalExistingDir(project); ok {
		project = canonical
	}
	codexHome := filepath.Join(root, "codex-home")
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(root, "claude-home"))
	now := time.Now().UTC().Format(time.RFC3339Nano)
	writeAgentServiceJSONL(t, filepath.Join(codexHome, "sessions", "codex-a.jsonl"),
		map[string]any{
			"timestamp": now,
			"type":      "session_meta",
			"payload":   map[string]any{"id": "codex-a", "cwd": project},
		},
		map[string]any{"timestamp": now, "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "codex-a-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "A prompt"}},
		}},
	)

	service := newIsolatedAgentService(newFakeRuntime())
	projection := NewActivityProjection(store)
	service.SessionReader = projection
	service.MessageReader = projection
	service.ExternalImportStore = failingReportSessionMessagesStore{Repository: store}

	result, err := service.ImportExternalSessions(ctx, "ws-1", ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: project}},
	})
	if err != nil {
		t.Fatalf("ImportExternalSessions error = %v", err)
	}
	if len(result.ProjectPaths) != 0 || result.ImportedProjects != 0 {
		t.Fatalf("import result = %#v, want no registered project paths when the only session fails to import", result)
	}
	if result.ImportedSessions != 0 || result.ImportedMessages != 0 {
		t.Fatalf("import result = %#v, want nothing counted as imported", result)
	}
	if len(result.Errors) == 0 {
		t.Fatalf("import result = %#v, want the store failure recorded as an import error", result)
	}
}

// failingReportSessionMessagesStore wraps a real agentactivitybiz.Repository
// but forces ReportSessionMessages to fail, simulating a transient store
// error (write timeout, disk full, etc.) after the session shell itself may
// already have been created by ReportSessionState.
type failingReportSessionMessagesStore struct {
	agentactivitybiz.Repository
}

func (failingReportSessionMessagesStore) ReportSessionMessages(context.Context, agentactivitybiz.SessionMessageReport) (agentactivitybiz.MessageReportResult, error) {
	return agentactivitybiz.MessageReportResult{}, errors.New("simulated store failure")
}

func TestServiceExternalImportValidProjectPaths(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	project := filepath.Join(root, "project-a")
	empty := filepath.Join(root, "empty-project")
	for _, dir := range []string{project, empty} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("create dir error = %v", err)
		}
	}
	if canonical, ok := canonicalExistingDir(project); ok {
		project = canonical
	}
	codexHome := filepath.Join(root, "codex-home")
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(root, "claude-home"))
	writeAgentServiceJSONL(t, filepath.Join(codexHome, "sessions", "codex-a.jsonl"),
		map[string]any{
			"timestamp": time.Now().Add(-time.Hour).Format(time.RFC3339),
			"type":      "session_meta",
			"payload":   map[string]any{"id": "codex-a", "cwd": project},
		},
		map[string]any{"timestamp": time.Now().Add(-time.Hour).Format(time.RFC3339), "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "codex-a-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "A prompt"}},
		}},
	)

	service := newIsolatedAgentService(newFakeRuntime())
	paths, err := service.ExternalImportValidProjectPaths(ctx, ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: project}, {Path: empty}},
	})
	if err != nil {
		t.Fatalf("ExternalImportValidProjectPaths error = %v", err)
	}
	if len(paths) != 1 || paths[0] != project {
		t.Fatalf("valid paths = %#v, want only the project with a session (%s)", paths, project)
	}
}

func TestServiceExternalImportValidProjectPathsOrdersByLatestSession(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	olderProject := filepath.Join(root, "older-project")
	newerProject := filepath.Join(root, "newer-project")
	for _, dir := range []string{olderProject, newerProject} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("create dir error = %v", err)
		}
	}
	if canonical, ok := canonicalExistingDir(olderProject); ok {
		olderProject = canonical
	}
	if canonical, ok := canonicalExistingDir(newerProject); ok {
		newerProject = canonical
	}
	codexHome := filepath.Join(root, "codex-home")
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(root, "claude-home"))
	olderTimestamp := time.Now().Add(-2 * time.Hour).UTC().Format(time.RFC3339Nano)
	newerTimestamp := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	writeAgentServiceJSONL(t, filepath.Join(codexHome, "sessions", "older.jsonl"),
		map[string]any{
			"timestamp": olderTimestamp,
			"type":      "session_meta",
			"payload":   map[string]any{"id": "older", "cwd": olderProject},
		},
		map[string]any{"timestamp": olderTimestamp, "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "older-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "Older prompt"}},
		}},
	)
	writeAgentServiceJSONL(t, filepath.Join(codexHome, "sessions", "newer.jsonl"),
		map[string]any{
			"timestamp": newerTimestamp,
			"type":      "session_meta",
			"payload":   map[string]any{"id": "newer", "cwd": newerProject},
		},
		map[string]any{"timestamp": newerTimestamp, "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "newer-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "Newer prompt"}},
		}},
	)

	service := newIsolatedAgentService(newFakeRuntime())
	paths, err := service.ExternalImportValidProjectPaths(ctx, ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: olderProject}, {Path: newerProject}},
	})
	if err != nil {
		t.Fatalf("ExternalImportValidProjectPaths error = %v", err)
	}
	if len(paths) != 2 || paths[0] != newerProject || paths[1] != olderProject {
		t.Fatalf("valid paths = %#v, want newer then older", paths)
	}
}

func TestMatchingExternalImportProjectPrefersExactSelection(t *testing.T) {
	root := t.TempDir()
	parent := filepath.Join(root, "project")
	child := filepath.Join(parent, "packages", "app")
	if err := os.MkdirAll(child, 0o755); err != nil {
		t.Fatalf("create child project error = %v", err)
	}
	if canonical, ok := canonicalExistingDir(parent); ok {
		parent = canonical
	}
	if canonical, ok := canonicalExistingDir(child); ok {
		child = canonical
	}

	got, ok := matchingExternalImportProject(
		externalImportedSession{
			Provider: "codex",
			Cwd:      child,
		},
		[]ExternalImportProjectSelection{
			{Path: parent, Providers: []string{"codex"}},
			{Path: child, Providers: []string{"codex"}},
		},
	)
	if !ok || got != child {
		t.Fatalf("matchingExternalImportProject() = %q, %v; want exact child path %q", got, ok, child)
	}
	if runtime.GOOS == "windows" {
		got, ok = matchingExternalImportProject(
			externalImportedSession{
				Provider: "codex",
				Cwd:      strings.ToLower(child),
			},
			[]ExternalImportProjectSelection{
				{Path: strings.ToUpper(parent), Providers: []string{"codex"}},
				{Path: strings.ToUpper(child), Providers: []string{"codex"}},
			},
		)
		if !ok || !agentactivitybiz.AreProjectPathsEqual(got, child) {
			t.Fatalf("Windows identity matching = %q, %v; want child path equivalent to %q", got, ok, child)
		}
	}
}

func TestUpsertExternalImportProjectUsesWindowsPathIdentity(t *testing.T) {
	t.Parallel()

	if runtime.GOOS != "windows" {
		t.Skip("Windows filesystem identity is platform-specific")
	}
	projectPath := t.TempDir()
	projects := map[string]*ExternalImportProject{}
	upsertExternalImportProject(projects, ExternalImportProject{
		Path:         strings.ToUpper(projectPath),
		SessionCount: 1,
	}, "codex")
	upsertExternalImportProject(projects, ExternalImportProject{
		Path:         strings.ToLower(projectPath),
		SessionCount: 1,
	}, "claude-code")
	if len(projects) != 1 {
		t.Fatalf("project identity map has %d entries, want one: %#v", len(projects), projects)
	}
	for _, project := range projects {
		if project.SessionCount != 2 {
			t.Fatalf("merged project session count = %d, want 2", project.SessionCount)
		}
	}
}

func TestExternalSessionProjectPathUsesGitRoot(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "repo")
	child := filepath.Join(project, "packages", "app")
	if err := os.MkdirAll(filepath.Join(project, ".git"), 0o755); err != nil {
		t.Fatalf("create git dir error = %v", err)
	}
	if err := os.MkdirAll(child, 0o755); err != nil {
		t.Fatalf("create child dir error = %v", err)
	}
	if canonical, ok := canonicalExistingDir(project); ok {
		project = canonical
	}
	if canonical, ok := canonicalExistingDir(child); ok {
		child = canonical
	}

	got, ok := externalSessionProjectPath(externalImportedSession{
		Provider: "codex",
		Cwd:      child,
	})
	if !ok || got != project {
		t.Fatalf("externalSessionProjectPath() = %q, %v; want git root %q", got, ok, project)
	}
}

// writeExternalImportGitWorktreeFixture creates a fake main git checkout and
// a linked worktree of it, matching the on-disk layout `git worktree add`
// produces (a `.git` *file* at the worktree root pointing at
// "<main>/.git/worktrees/<name>", whose own `commondir` file points back at
// the shared/main .git directory), so tests can exercise worktree-to-main
// resolution without shelling out to a real git binary.
func writeExternalImportGitWorktreeFixture(t *testing.T, root string, name string) (mainRoot string, worktreeRoot string) {
	t.Helper()
	mainRoot = filepath.Join(root, "main-checkout")
	worktreeRoot = filepath.Join(root, "worktrees", name)
	worktreeMetaDir := filepath.Join(mainRoot, ".git", "worktrees", name)
	if err := os.MkdirAll(filepath.Join(mainRoot, ".git"), 0o755); err != nil {
		t.Fatalf("create main .git dir error = %v", err)
	}
	if err := os.MkdirAll(worktreeMetaDir, 0o755); err != nil {
		t.Fatalf("create worktree metadata dir error = %v", err)
	}
	if err := os.MkdirAll(worktreeRoot, 0o755); err != nil {
		t.Fatalf("create worktree root error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(worktreeMetaDir, "commondir"), []byte("../..\n"), 0o644); err != nil {
		t.Fatalf("write commondir error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(worktreeMetaDir, "gitdir"), []byte(filepath.Join(worktreeRoot, ".git")+"\n"), 0o644); err != nil {
		t.Fatalf("write gitdir error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(worktreeRoot, ".git"), []byte("gitdir: "+worktreeMetaDir+"\n"), 0o644); err != nil {
		t.Fatalf("write worktree .git pointer error = %v", err)
	}
	if canonical, ok := canonicalExistingDir(mainRoot); ok {
		mainRoot = canonical
	}
	if canonical, ok := canonicalExistingDir(worktreeRoot); ok {
		worktreeRoot = canonical
	}
	return mainRoot, worktreeRoot
}

func TestResolveExternalImportWorktreeCwdResolvesToMainCheckout(t *testing.T) {
	root := t.TempDir()
	mainRoot, worktreeRoot := writeExternalImportGitWorktreeFixture(t, root, "8db5-tsh")
	nested := filepath.Join(worktreeRoot, "apps", "foo")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("create nested worktree dir error = %v", err)
	}

	resolvedRoot, ok := resolveExternalImportWorktreeCwd(worktreeRoot)
	if !ok || resolvedRoot != mainRoot {
		t.Fatalf("resolveExternalImportWorktreeCwd(root) = %q, %v; want main checkout %q", resolvedRoot, ok, mainRoot)
	}

	resolvedNested, ok := resolveExternalImportWorktreeCwd(nested)
	wantNested := filepath.Join(mainRoot, "apps", "foo")
	if !ok || resolvedNested != wantNested {
		t.Fatalf("resolveExternalImportWorktreeCwd(nested) = %q, %v; want %q", resolvedNested, ok, wantNested)
	}

	// A normal (non-worktree) checkout must be left unresolved: its `.git`
	// is a real directory, not a worktree pointer file.
	normalRoot := filepath.Join(root, "normal-repo")
	if err := os.MkdirAll(filepath.Join(normalRoot, ".git"), 0o755); err != nil {
		t.Fatalf("create normal repo .git dir error = %v", err)
	}
	if _, ok := resolveExternalImportWorktreeCwd(normalRoot); ok {
		t.Fatalf("resolveExternalImportWorktreeCwd(normalRoot) resolved a normal checkout, want unresolved")
	}
}

func TestExternalSessionProjectPathResolvesLinkedWorktreeToMainCheckout(t *testing.T) {
	root := t.TempDir()
	mainRoot, worktreeRoot := writeExternalImportGitWorktreeFixture(t, root, "8db5-tsh")

	got, ok := externalSessionProjectPath(externalImportedSession{
		Provider: "codex",
		Cwd:      worktreeRoot,
	})
	if !ok || got != mainRoot {
		t.Fatalf(
			"externalSessionProjectPath() = %q, %v; want the main checkout root %q, not the ephemeral worktree path %q",
			got, ok, mainRoot, worktreeRoot,
		)
	}
}

// TestServiceImportedCodexWorktreeSessionGroupsUnderExistingMainCheckoutProject
// reproduces the reported bug: a Codex session that ran inside a per-task
// worktree of the user's "tsh" project (e.g.
// ~/.codex/worktrees/8db5/tsh, a linked worktree of ~/Documents/New
// project/tsh) got imported and stranded in the ungrouped "对话" bucket
// instead of being grouped under the already-registered "tsh" project,
// because the worktree checkout's own `.git` file made it look like an
// independent project root distinct from the main checkout. Once resolved,
// the imported session's project path — and its persisted cwd, which the
// GUI uses to group conversations under project folders — must match the
// main checkout, not the worktree.
func TestServiceImportedCodexWorktreeSessionGroupsUnderExistingMainCheckoutProject(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Workspace One"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	root := t.TempDir()
	mainRoot, worktreeRoot := writeExternalImportGitWorktreeFixture(t, root, "8db5-tsh")

	home := filepath.Join(root, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatalf("create home error = %v", err)
	}
	codexHome := filepath.Join(root, "codex-home")
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(root, "claude-home"))
	now := time.Now().UTC().Format(time.RFC3339Nano)
	writeAgentServiceJSONL(t, filepath.Join(codexHome, "sessions", "worktree-session.jsonl"),
		map[string]any{
			"timestamp": now,
			"type":      "session_meta",
			"payload":   map[string]any{"id": "worktree-session", "cwd": worktreeRoot},
		},
		map[string]any{"timestamp": now, "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "worktree-session-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "Send greeting"}},
		}},
	)

	service := newIsolatedAgentService(newFakeRuntime())
	projection := NewActivityProjection(store)
	service.SessionReader = projection
	service.MessageReader = projection
	service.ExternalImportStore = store

	// The user already has "tsh" registered as a project at the main
	// checkout — the same setup as the report, where the real project
	// existed and stayed empty ("暂无对话") while the worktree-run session
	// surfaced in the general conversations list instead.
	result, err := service.ImportExternalSessions(ctx, "ws-1", ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: mainRoot}},
	})
	if err != nil {
		t.Fatalf("ImportExternalSessions error = %v", err)
	}
	if result.ImportedSessions != 1 {
		t.Fatalf("import result = %#v, want one imported session", result)
	}
	if len(result.ProjectPaths) != 1 || result.ProjectPaths[0] != mainRoot {
		t.Fatalf(
			"import result ProjectPaths = %#v, want [%q] (the main checkout), not the ephemeral worktree path %q",
			result.ProjectPaths, mainRoot, worktreeRoot,
		)
	}
	session, err := service.Get(ctx, "ws-1", externalImportedSessionID("codex", "worktree-session"))
	if err != nil {
		t.Fatalf("Get imported worktree session error = %v", err)
	}
	if session.Cwd != mainRoot {
		t.Fatalf(
			"session.Cwd = %q, want it resolved to the main checkout %q before durable rail classification",
			session.Cwd, mainRoot,
		)
	}
}

func TestServiceImportsHomeCwdAsNoProjectWithoutRegisteringUserHome(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Workspace One"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	root := t.TempDir()
	home := filepath.Join(root, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatalf("create home error = %v", err)
	}
	if canonical, ok := canonicalExistingDir(home); ok {
		home = canonical
	}
	codexHome := filepath.Join(root, "codex-home")
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(root, "claude-home"))
	now := time.Now().UTC().Format(time.RFC3339Nano)
	writeAgentServiceJSONL(t, filepath.Join(codexHome, "sessions", "no-project.jsonl"),
		map[string]any{
			"timestamp": now,
			"type":      "session_meta",
			"payload":   map[string]any{"id": "no-project", "cwd": home},
		},
		map[string]any{"timestamp": now, "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "no-project-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "Scratch question"}},
		}},
	)

	service := newIsolatedAgentService(newFakeRuntime())
	projection := NewActivityProjection(store)
	service.SessionReader = projection
	service.MessageReader = projection
	service.ExternalImportStore = store

	result, err := service.ImportExternalSessions(ctx, "ws-1", ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: home}},
	})
	if err != nil {
		t.Fatalf("ImportExternalSessions error = %v", err)
	}
	if result.ImportedSessions != 1 || result.ImportedMessages != 1 {
		t.Fatalf("import result = %#v, want one imported no-project session", result)
	}
	if len(result.ProjectPaths) != 0 || result.ImportedProjects != 0 {
		t.Fatalf("import result = %#v, want no registered project paths for home cwd", result)
	}
	_, err = service.Get(ctx, "ws-1", externalImportedSessionID("codex", "no-project"))
	if err != nil {
		t.Fatalf("Get imported no-project session error = %v", err)
	}
}

func TestServiceImportsCodexScratchCwdAsNoProjectWithoutRegisteringIt(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Workspace One"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	root := t.TempDir()
	home := filepath.Join(root, "home")
	scratchCwd := filepath.Join(home, "Documents", "Codex", "2026-06-26", "ge")
	if err := os.MkdirAll(scratchCwd, 0o755); err != nil {
		t.Fatalf("create codex scratch cwd error = %v", err)
	}
	if canonical, ok := canonicalExistingDir(home); ok {
		home = canonical
	}
	if canonical, ok := canonicalExistingDir(scratchCwd); ok {
		scratchCwd = canonical
	}
	codexHome := filepath.Join(root, "codex-home")
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(root, "claude-home"))
	now := time.Now().UTC().Format(time.RFC3339Nano)
	writeAgentServiceJSONL(t, filepath.Join(codexHome, "sessions", "codex-scratch.jsonl"),
		map[string]any{
			"timestamp": now,
			"type":      "session_meta",
			"payload":   map[string]any{"id": "codex-scratch", "cwd": scratchCwd},
		},
		map[string]any{"timestamp": now, "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "codex-scratch-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "Scratch question"}},
		}},
	)

	service := newIsolatedAgentService(newFakeRuntime())
	projection := NewActivityProjection(store)
	service.SessionReader = projection
	service.MessageReader = projection
	service.ExternalImportStore = store

	result, err := service.ImportExternalSessions(ctx, "ws-1", ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: scratchCwd}},
	})
	if err != nil {
		t.Fatalf("ImportExternalSessions error = %v", err)
	}
	if result.ImportedSessions != 1 || result.ImportedMessages != 1 {
		t.Fatalf("import result = %#v, want one imported no-project session", result)
	}
	if len(result.ProjectPaths) != 0 || result.ImportedProjects != 0 {
		t.Fatalf("import result = %#v, want no registered project paths for Codex scratch cwd", result)
	}
	session, err := service.Get(ctx, "ws-1", externalImportedSessionID("codex", "codex-scratch"))
	if err != nil {
		t.Fatalf("Get imported Codex scratch session error = %v", err)
	}
	if session.Cwd != scratchCwd {
		t.Fatalf("session cwd = %q, want imported scratch cwd %q", session.Cwd, scratchCwd)
	}
}

func TestServiceImportPreservesLocalCodexModelAndReasoningEffort(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Workspace One"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	root := t.TempDir()
	project := filepath.Join(root, "project")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatalf("create project error = %v", err)
	}
	if canonical, ok := canonicalExistingDir(project); ok {
		project = canonical
	}
	codexHome := filepath.Join(root, "codex-home")
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(root, "claude-home"))
	now := time.Now().UTC().Format(time.RFC3339Nano)
	writeAgentServiceJSONL(t, filepath.Join(codexHome, "sessions", "codex-model.jsonl"),
		map[string]any{
			"timestamp": now,
			"type":      "session_meta",
			"payload":   map[string]any{"id": "codex-model", "cwd": project},
		},
		map[string]any{
			"timestamp": now,
			"type":      "turn_context",
			"payload":   map[string]any{"turn_id": "turn-1", "cwd": project, "model": "gpt-5.4", "effort": "minimal"},
		},
		map[string]any{"timestamp": now, "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "codex-model-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "Use my usual settings"}},
		}},
	)

	service := newIsolatedAgentService(newFakeRuntime())
	projection := NewActivityProjection(store)
	service.SessionReader = projection
	service.MessageReader = projection
	service.ExternalImportStore = store

	result, err := service.ImportExternalSessions(ctx, "ws-1", ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: project}},
	})
	if err != nil {
		t.Fatalf("ImportExternalSessions error = %v", err)
	}
	if result.ImportedSessions != 1 {
		t.Fatalf("import result = %#v, want one imported session", result)
	}
	session, err := service.Get(ctx, "ws-1", externalImportedSessionID("codex", "codex-model"))
	if err != nil {
		t.Fatalf("Get imported Codex session error = %v", err)
	}
	if session.Settings.Model != "gpt-5.4" {
		t.Fatalf("settings.Model = %q, want imported turn_context model", session.Settings.Model)
	}
	if session.Settings.ReasoningEffort != "minimal" {
		t.Fatalf("settings.ReasoningEffort = %q, want raw catalog-backed turn_context effort", session.Settings.ReasoningEffort)
	}
}

func TestServiceScanCountsAndImportsSessionWithDeletedWorkingDirectory(t *testing.T) {
	// Regression: a session whose recorded cwd no longer exists (a deleted
	// git worktree, a cleaned-up temp dir) used to be silently dropped from
	// the scan entirely — not counted in ScannedSessions, not offered for
	// import, and not appearing in SkippedSessions either (it never got that
	// far). That both undercounts what scan reports (eW5WPl sub-issue 1) and
	// can make a substantial real conversation look empty/vanished (uOivri),
	// since it never surfaces anywhere for the user to see or import.
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Workspace One"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	root := t.TempDir()
	deletedCwd := filepath.Join(root, "deleted-project")
	if err := os.MkdirAll(deletedCwd, 0o755); err != nil {
		t.Fatalf("create then delete cwd error = %v", err)
	}
	if canonical, ok := canonicalExistingDir(deletedCwd); ok {
		deletedCwd = canonical
	}
	if err := os.RemoveAll(deletedCwd); err != nil {
		t.Fatalf("remove cwd error = %v", err)
	}
	codexHome := filepath.Join(root, "codex-home")
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(root, "claude-home"))
	now := time.Now().UTC().Format(time.RFC3339Nano)
	writeAgentServiceJSONL(t, filepath.Join(codexHome, "sessions", "deleted-cwd.jsonl"),
		map[string]any{
			"timestamp": now,
			"type":      "session_meta",
			"payload":   map[string]any{"id": "deleted-cwd", "cwd": deletedCwd},
		},
		map[string]any{"timestamp": now, "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "deleted-cwd-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "Still real content"}},
		}},
	)

	service := newIsolatedAgentService(newFakeRuntime())
	scan, err := service.ScanExternalImports(ctx, ExternalImportScanInput{})
	if err != nil {
		t.Fatalf("ScanExternalImports error = %v", err)
	}
	if scan.ScannedSessions != 1 || scan.SkippedSessions != 0 {
		t.Fatalf("scan = %#v, want the deleted-cwd session counted as scanned, not skipped", scan)
	}
	if len(scan.Sessions) != 1 || scan.Sessions[0].ProjectPath != deletedCwd {
		t.Fatalf("scan sessions = %#v, want one session grouped under its original deleted cwd %q", scan.Sessions, deletedCwd)
	}

	projection := NewActivityProjection(store)
	service.SessionReader = projection
	service.MessageReader = projection
	service.ExternalImportStore = store
	result, err := service.ImportExternalSessions(ctx, "ws-1", ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: root}},
	})
	if err != nil {
		t.Fatalf("ImportExternalSessions error = %v", err)
	}
	if result.ImportedSessions != 1 || result.ImportedMessages != 1 {
		t.Fatalf("import result = %#v, want the deleted-cwd session imported", result)
	}
	session, err := service.Get(ctx, "ws-1", externalImportedSessionID("codex", "deleted-cwd"))
	if err != nil {
		t.Fatalf("Get imported deleted-cwd session error = %v", err)
	}
	if session.Cwd != deletedCwd {
		t.Fatalf("session cwd = %q, want original deleted cwd %q preserved", session.Cwd, deletedCwd)
	}
}

func TestServiceListsImportedSessionsByExternalActivityTime(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Workspace One"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	root := t.TempDir()
	project := filepath.Join(root, "project")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatalf("create project error = %v", err)
	}
	if canonical, ok := canonicalExistingDir(project); ok {
		project = canonical
	}
	codexHome := filepath.Join(root, "codex-home")
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(root, "claude-home"))
	older := time.Date(2026, 6, 20, 10, 0, 0, 0, time.UTC)
	newer := time.Date(2026, 6, 21, 10, 0, 0, 0, time.UTC)
	writeAgentServiceJSONL(t, filepath.Join(codexHome, "sessions", "a-newer.jsonl"),
		map[string]any{
			"timestamp": newer.Format(time.RFC3339Nano),
			"type":      "session_meta",
			"payload":   map[string]any{"id": "newer", "cwd": project},
		},
		map[string]any{"timestamp": newer.Format(time.RFC3339Nano), "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "newer-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "Newer imported title"}},
		}},
	)
	writeAgentServiceJSONL(t, filepath.Join(codexHome, "sessions", "z-older.jsonl"),
		map[string]any{
			"timestamp": older.Format(time.RFC3339Nano),
			"type":      "session_meta",
			"payload":   map[string]any{"id": "older", "cwd": project},
		},
		map[string]any{"timestamp": older.Format(time.RFC3339Nano), "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "older-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "Older imported title"}},
		}},
	)

	service := newIsolatedAgentService(newFakeRuntime())
	projection := NewActivityProjection(store)
	service.SessionReader = projection
	service.MessageReader = projection
	service.ExternalImportStore = store

	result, err := service.ImportExternalSessions(ctx, "ws-1", ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: project}},
	})
	if err != nil {
		t.Fatalf("ImportExternalSessions error = %v", err)
	}
	if result.ImportedSessions != 2 {
		t.Fatalf("imported sessions = %d, want 2", result.ImportedSessions)
	}
	sessions, err := service.List(ctx, "ws-1")
	if err != nil {
		t.Fatalf("List error = %v", err)
	}
	if len(sessions) != 2 {
		t.Fatalf("len(sessions) = %d, want 2", len(sessions))
	}
	if value(sessions[0].Title) != "Newer imported title" {
		t.Fatalf("sessions = %#v, want newer title first", sessions)
	}
	if sessions[0].UpdatedAt == nil || sessions[0].UpdatedAt.UnixMilli() != newer.UnixMilli() {
		t.Fatalf("first imported session updatedAt = %#v, want %d", sessions[0].UpdatedAt, newer.UnixMilli())
	}
	if sessions[0].CreatedAt.UnixMilli() != newer.UnixMilli() {
		t.Fatalf("first imported session createdAt = %d, want %d", sessions[0].CreatedAt.UnixMilli(), newer.UnixMilli())
	}
}
