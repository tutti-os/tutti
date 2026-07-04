package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentsidecarservice "github.com/tutti-os/tutti/services/tuttid/service/agentsidecar"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
)

func TestServiceCreatesAndListsSessions(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "11111111-1111-4111-8111-111111111111",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Provider:       "codex",
		Title:          stringRef("Migration smoke"),
		InitialContent: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if session.ID != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("session ID = %q, want frontend UUID", session.ID)
	}
	if session.Status != "running" {
		t.Fatalf("status = %q, want running", session.Status)
	}
	if !session.Resumable {
		t.Fatal("created session resumable = false, want true")
	}

	list, err := service.List(context.Background(), "ws-1")
	if err != nil {
		t.Fatalf("List returned error: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("len(list) = %d, want 1", len(list))
	}
	if list[0].ID != session.ID {
		t.Fatalf("listed session ID = %q, want %q", list[0].ID, session.ID)
	}

	got, err := service.Get(context.Background(), "ws-1", session.ID)
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
	if got.ID != session.ID {
		t.Fatalf("got session ID = %q, want %q", got.ID, session.ID)
	}
}

func TestServiceCreateResolvesProviderFromAgentTarget(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{
		targets: map[string]agenttargetbiz.Target{
			agenttargetbiz.IDLocalClaudeCode: {
				ID:            agenttargetbiz.IDLocalClaudeCode,
				Provider:      "claude-code",
				LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("claude-code"),
				Name:          "Claude Code",
				Enabled:       true,
				Source:        agenttargetbiz.SourceSystem,
			},
		},
	}

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "target-session-1",
		AgentTargetID:  agenttargetbiz.IDLocalClaudeCode,
		InitialContent: TextPromptContent("hello target"),
		ProviderTargetRef: map[string]any{
			"kind":     "local_cli",
			"provider": "codex",
			"targetId": "wrong-target",
		},
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if session.Provider != "claude-code" || session.AgentTargetID != agenttargetbiz.IDLocalClaudeCode {
		t.Fatalf("session provider/target = %q/%q, want claude-code/%s", session.Provider, session.AgentTargetID, agenttargetbiz.IDLocalClaudeCode)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
	if got := runtime.startCalls[0].Provider; got != "claude-code" {
		t.Fatalf("runtime provider = %q, want claude-code", got)
	}
	if got := runtime.startCalls[0].AgentTargetID; got != agenttargetbiz.IDLocalClaudeCode {
		t.Fatalf("runtime agent target id = %q, want %s", got, agenttargetbiz.IDLocalClaudeCode)
	}
	ref := runtime.startCalls[0].ProviderTargetRef
	if ref["kind"] != agenttargetbiz.LaunchRefTypeLocalCLI ||
		ref["provider"] != "claude-code" ||
		ref["targetId"] != agenttargetbiz.IDLocalClaudeCode {
		t.Fatalf("runtime provider target ref = %#v, want daemon-derived local_cli claude target", ref)
	}
}

func TestServiceCreateRejectsInvalidAgentTargetInputs(t *testing.T) {
	for _, tc := range []struct {
		name        string
		input       CreateSessionInput
		targets     map[string]agenttargetbiz.Target
		errContains string
	}{
		{
			name: "missing target",
			input: CreateSessionInput{
				AgentSessionID: "target-session-missing",
				AgentTargetID:  "missing-target",
				Provider:       "codex",
				InitialContent: TextPromptContent("hello"),
			},
			errContains: "agent target not found",
		},
		{
			name: "disabled target",
			input: CreateSessionInput{
				AgentSessionID: "target-session-disabled",
				AgentTargetID:  "disabled-codex",
				Provider:       "codex",
				InitialContent: TextPromptContent("hello"),
			},
			targets: map[string]agenttargetbiz.Target{
				"disabled-codex": {
					ID:            "disabled-codex",
					Provider:      "codex",
					LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
					Name:          "Disabled Codex",
					Enabled:       false,
					Source:        agenttargetbiz.SourceUser,
				},
			},
			errContains: "agent target is disabled",
		},
		{
			name: "provider mismatch",
			input: CreateSessionInput{
				AgentSessionID: "target-session-mismatch",
				AgentTargetID:  agenttargetbiz.IDLocalCodex,
				Provider:       "claude-code",
				InitialContent: TextPromptContent("hello"),
			},
			targets: map[string]agenttargetbiz.Target{
				agenttargetbiz.IDLocalCodex: {
					ID:            agenttargetbiz.IDLocalCodex,
					Provider:      "codex",
					LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
					Name:          "Codex",
					Enabled:       true,
					Source:        agenttargetbiz.SourceSystem,
				},
			},
			errContains: "provider does not match agent target",
		},
		{
			name: "missing launch authority",
			input: CreateSessionInput{
				AgentSessionID: "target-session-no-authority",
				InitialContent: TextPromptContent("hello"),
			},
			errContains: ErrInvalidArgument.Error(),
		},
		{
			name: "provider target ref without agent target",
			input: CreateSessionInput{
				AgentSessionID: "target-session-provider-ref",
				Provider:       "codex",
				ProviderTargetRef: map[string]any{
					"kind":     "shared-agent",
					"provider": "codex",
					"targetId": "shared-agent:codex-1",
				},
				InitialContent: TextPromptContent("hello"),
			},
			errContains: "agent target id is required",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runtime := newFakeRuntime()
			service := NewService(runtime)
			service.AgentTargetStore = fakeAgentTargetStore{targets: tc.targets}

			_, err := service.Create(context.Background(), "ws-1", tc.input)
			if !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), tc.errContains) {
				t.Fatalf("Create error = %v, want ErrInvalidArgument containing %q", err, tc.errContains)
			}
			if len(runtime.startCalls) != 0 {
				t.Fatalf("start calls = %d, want 0", len(runtime.startCalls))
			}
		})
	}
}

func TestServiceCreatePassesNormalizedConversationDetailModeToRuntime(t *testing.T) {
	for _, tc := range []struct {
		name string
		mode string
		want string
	}{
		{name: "empty defaults to coding", mode: "", want: "coding"},
		{name: "general is preserved", mode: "general", want: "general"},
		{name: "invalid defaults to coding", mode: "daily", want: "coding"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runtime := newFakeRuntime()
			service := newTestService(runtime)

			_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
				AgentSessionID:         "session-" + strings.ReplaceAll(tc.name, " ", "-"),
				AgentTargetID:          agenttargetbiz.IDLocalCodex,
				Provider:               "codex",
				ConversationDetailMode: tc.mode,
				InitialContent:         TextPromptContent("hello"),
			})
			if err != nil {
				t.Fatalf("Create returned error: %v", err)
			}
			if len(runtime.startCalls) != 1 {
				t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
			}
			if got := runtime.startCalls[0].ConversationDetailMode; got != tc.want {
				t.Fatalf("runtime conversationDetailMode = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestServiceCreateResolvesAgentTargetID(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	service.AgentTargetStore = fakeAgentTargetLookup{
		targets: map[string]agenttargetbiz.Target{
			"local-codex": {
				ID:            "local-codex",
				Provider:      "codex",
				LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
				Name:          "Codex",
				Enabled:       true,
				Source:        agenttargetbiz.SourceSystem,
			},
		},
	}

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "target-session-1",
		AgentTargetID:  "local-codex",
		Provider:       "codex",
		ProviderTargetRef: map[string]any{
			"kind":     "client-supplied",
			"provider": "codex",
			"targetId": "ignored-client-ref",
		},
		InitialContent: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if got := runtime.startCalls[0].Provider; got != "codex" {
		t.Fatalf("runtime provider = %q, want codex", got)
	}
	if got := runtime.startCalls[0].ProviderTargetRef["kind"]; got != "local_cli" {
		t.Fatalf("provider target ref kind = %#v, want local_cli", got)
	}
	if got := runtime.startCalls[0].ProviderTargetRef["targetId"]; got != "local-codex" {
		t.Fatalf("provider target ref targetId = %#v, want local-codex", got)
	}
}

func TestServiceCreateRejectsInvalidAgentTargets(t *testing.T) {
	for _, tc := range []struct {
		name            string
		agentTargetID   string
		requestProvider string
		target          agenttargetbiz.Target
	}{
		{
			name:            "disabled target",
			agentTargetID:   "local-codex",
			requestProvider: "codex",
			target: agenttargetbiz.Target{
				ID:            "local-codex",
				Provider:      "codex",
				LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
				Name:          "Codex",
				Enabled:       false,
				Source:        agenttargetbiz.SourceSystem,
			},
		},
		{
			name:            "request provider mismatch",
			agentTargetID:   "local-codex",
			requestProvider: "claude-code",
			target: agenttargetbiz.Target{
				ID:            "local-codex",
				Provider:      "codex",
				LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
				Name:          "Codex",
				Enabled:       true,
				Source:        agenttargetbiz.SourceSystem,
			},
		},
		{
			name:            "target not found",
			agentTargetID:   "missing-target",
			requestProvider: "codex",
			target: agenttargetbiz.Target{
				ID:            "local-codex",
				Provider:      "codex",
				LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
				Name:          "Codex",
				Enabled:       true,
				Source:        agenttargetbiz.SourceSystem,
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service := NewService(newFakeRuntime())
			service.AgentTargetStore = fakeAgentTargetLookup{
				targets: map[string]agenttargetbiz.Target{
					tc.target.ID: tc.target,
				},
			}

			_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
				AgentSessionID: "target-session-invalid",
				AgentTargetID:  tc.agentTargetID,
				Provider:       tc.requestProvider,
				InitialContent: TextPromptContent("hello"),
			})
			if !errors.Is(err, ErrInvalidArgument) {
				t.Fatalf("Create error = %v, want ErrInvalidArgument", err)
			}
		})
	}
}

func TestServiceCreateReportsNodeResults(t *testing.T) {
	runtime := newFakeRuntime()
	reporter := &recordingAgentAnalyticsReporter{}
	service := newTestService(runtime)
	service.AnalyticsReporter = reporter

	if _, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
	}); err != nil {
		t.Fatalf("Create returned error: %v", err)
	}

	assertAgentNodeSequence(t, reporter.events, []string{
		"content_normalized",
		"provider_runtime_checked",
		"model_validated",
		"cwd_resolved",
		"runtime_prepared",
		"runtime_started",
		"prompt_validated",
		"prompt_prepared",
		"runtime_exec",
	})
	for _, event := range reporter.events {
		if event.Name != "agent.node_result" {
			continue
		}
		if got := event.Params["flow"]; got != "session_create" {
			t.Fatalf("flow = %#v, want session_create in %#v", got, event.Params)
		}
		if got := event.Params["status"]; got != "success" {
			t.Fatalf("status = %#v, want success in %#v", got, event.Params)
		}
		if got := event.Params["error_code"]; got != "agent_error_none" {
			t.Fatalf("error_code = %#v, want agent_error_none in %#v", got, event.Params)
		}
		if got := event.Params["error_message"]; got != "" {
			t.Fatalf("error_message = %#v, want empty in %#v", got, event.Params)
		}
	}
}

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

	service := NewService(newFakeRuntime())
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

	service := NewService(newFakeRuntime())
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

	service := NewService(newFakeRuntime())
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

	service := NewService(newFakeRuntime())
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
	session, err := service.Get(ctx, "ws-1", externalImportedSessionID("codex", "no-project"))
	if err != nil {
		t.Fatalf("Get imported no-project session error = %v", err)
	}
	if session.RuntimeContext["externalImportNoProject"] != true {
		t.Fatalf("runtime context = %#v, want externalImportNoProject true", session.RuntimeContext)
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

	service := NewService(newFakeRuntime())
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
	if session.RuntimeContext["externalImportNoProject"] != true {
		t.Fatalf("runtime context = %#v, want externalImportNoProject true", session.RuntimeContext)
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

	service := NewService(newFakeRuntime())
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

func TestServiceImportsExternalAgentSessionsByProject(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Workspace One"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	root := t.TempDir()
	projectA := filepath.Join(root, "project-a")
	projectB := filepath.Join(root, "project-b")
	if err := os.MkdirAll(projectA, 0o755); err != nil {
		t.Fatalf("create project A error = %v", err)
	}
	if err := os.MkdirAll(projectB, 0o755); err != nil {
		t.Fatalf("create project B error = %v", err)
	}
	if canonical, ok := canonicalExistingDir(projectA); ok {
		projectA = canonical
	}
	if canonical, ok := canonicalExistingDir(projectB); ok {
		projectB = canonical
	}
	codexHome := filepath.Join(root, "codex-home")
	claudeHome := filepath.Join(root, "claude-home")
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("CLAUDE_CONFIG_DIR", claudeHome)
	recent := time.Now().Add(-24 * time.Hour)
	timestamp := func(offset time.Duration) string {
		return recent.Add(offset).UTC().Format(time.RFC3339Nano)
	}
	oldTimestamp := time.Now().Add(-45 * 24 * time.Hour).UTC().Format(time.RFC3339Nano)

	writeAgentServiceJSONL(t, filepath.Join(codexHome, "sessions", "2026", "codex-a.jsonl"),
		map[string]any{
			"timestamp": timestamp(0),
			"type":      "session_meta",
			"payload":   map[string]any{"id": "codex-a", "cwd": projectA},
		},
		map[string]any{"timestamp": timestamp(time.Second), "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "codex-a-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "Plan the import"}},
		}},
		map[string]any{"timestamp": timestamp(2 * time.Second), "type": "response_item", "payload": map[string]any{
			"type":      "function_call",
			"id":        "codex-a-tool-1",
			"name":      "exec_command",
			"call_id":   "call-codex-a-status",
			"arguments": `{"cmd":"git status --short","workdir":"/repo"}`,
		}},
		map[string]any{"timestamp": timestamp(3 * time.Second), "type": "response_item", "payload": map[string]any{
			"type":    "function_call_output",
			"call_id": "call-codex-a-status",
			"output":  "Chunk ID: abc\nOutput:\n M file.go\n",
		}},
		map[string]any{"timestamp": timestamp(4 * time.Second), "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "codex-a-2", "role": "assistant",
			"content": []any{map[string]any{"type": "output_text", "text": "Import planned"}},
		}},
	)
	writeAgentServiceJSONL(t, filepath.Join(codexHome, "archived_sessions", "codex-b.jsonl"),
		map[string]any{
			"timestamp": timestamp(time.Hour),
			"type":      "session_meta",
			"payload":   map[string]any{"id": "codex-b", "cwd": projectB},
		},
		map[string]any{"timestamp": timestamp(time.Hour + time.Second), "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "codex-b-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "Other project"}},
		}},
	)
	writeAgentServiceJSONL(t, filepath.Join(codexHome, "sessions", "old", "codex-old.jsonl"),
		map[string]any{
			"timestamp": oldTimestamp,
			"type":      "session_meta",
			"payload":   map[string]any{"id": "codex-old", "cwd": projectA},
		},
		map[string]any{"timestamp": oldTimestamp, "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "codex-old-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "Old project"}},
		}},
	)
	writeAgentServiceJSONL(t, filepath.Join(claudeHome, "projects", "project-a", "claude-a.jsonl"),
		map[string]any{
			"timestamp": timestamp(2 * time.Hour), "sessionId": "claude-a", "cwd": projectA, "uuid": "claude-a-1",
			"message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "Claude question"}}},
		},
		map[string]any{
			"timestamp": timestamp(2*time.Hour + time.Second), "sessionId": "claude-a", "cwd": projectA, "uuid": "claude-a-2",
			"message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "Claude answer"}}},
		},
	)

	runtime := newFakeRuntime()
	service := NewService(runtime)
	projection := NewActivityProjection(store)
	service.SessionReader = projection
	service.MessageReader = projection
	service.ExternalImportStore = store

	scan, err := service.ScanExternalImports(ctx, ExternalImportScanInput{})
	if err != nil {
		t.Fatalf("ScanExternalImports error = %v", err)
	}
	if scan.ScannedSessions != 3 || scan.ScannedMessages != 7 || len(scan.Projects) != 2 {
		t.Fatalf("scan = %#v, want 3 sessions, 7 messages, 2 projects", scan)
	}
	codexAID := externalImportedSessionID("codex", "codex-a")
	if !slices.ContainsFunc(scan.Sessions, func(session ExternalImportSession) bool {
		return session.ID == codexAID && session.ProjectPath == projectA && session.Provider == "codex"
	}) {
		t.Fatalf("scan sessions = %#v, want codex-a summary", scan.Sessions)
	}

	result, err := service.ImportExternalSessions(ctx, "ws-1", ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: projectA, SessionIDs: []string{codexAID}}},
	})
	if err != nil {
		t.Fatalf("ImportExternalSessions error = %v", err)
	}
	if result.ImportedProjects != 1 || result.ImportedSessions != 1 || result.ImportedMessages != 4 {
		t.Fatalf("import result = %#v, want one project, one session, four message updates", result)
	}
	if len(result.ProjectPaths) != 1 || result.ProjectPaths[0] != projectA {
		t.Fatalf("project paths = %#v, want [%s]", result.ProjectPaths, projectA)
	}
	importedSession, err := service.Get(ctx, "ws-1", codexAID)
	if err != nil {
		t.Fatalf("Get imported session error = %v", err)
	}
	if value(importedSession.Title) != "Plan the import" {
		t.Fatalf("imported session title = %q, want first user message", value(importedSession.Title))
	}
	if importedSession.AgentTargetID != agenttargetbiz.IDLocalCodex {
		t.Fatalf("imported Codex agent target id = %q, want %s", importedSession.AgentTargetID, agenttargetbiz.IDLocalCodex)
	}
	importedMessages, err := service.ListMessages(ctx, "ws-1", codexAID, ListMessagesInput{Limit: 10})
	if err != nil {
		t.Fatalf("ListMessages imported session error = %v", err)
	}
	if !slices.ContainsFunc(importedMessages.Messages, func(message SessionMessage) bool {
		input, _ := message.Payload["input"].(map[string]any)
		output, _ := message.Payload["output"].(map[string]any)
		return message.Kind == "tool_call" &&
			message.Role == "assistant" &&
			message.Status == "completed" &&
			message.Payload["toolName"] == "exec_command" &&
			input["cmd"] == "git status --short" &&
			output["output"] == "Chunk ID: abc\nOutput:\n M file.go"
	}) {
		t.Fatalf("imported messages = %#v, want structured Codex tool call", importedMessages.Messages)
	}
	sessions, err := service.List(ctx, "ws-1")
	if err != nil {
		t.Fatalf("List error = %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("len(sessions) = %d, want 1", len(sessions))
	}
	for _, session := range sessions {
		if session.Cwd != projectA {
			t.Fatalf("session cwd = %q, want %q", session.Cwd, projectA)
		}
		if !session.Resumable {
			t.Fatalf("imported session %s resumable = false, want continuable in place", session.ID)
		}
	}

	// Importing the whole project (no explicit session ids) now covers all
	// available history rather than only the discovery window, so an explicitly
	// imported project also pulls the 45-day-old codex-old session that the
	// 30-day scan deliberately hides. claude-a (2 messages) + codex-old (1).
	rerun, err := service.ImportExternalSessions(ctx, "ws-1", ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: projectA}},
	})
	if err != nil {
		t.Fatalf("ImportExternalSessions rerun error = %v", err)
	}
	if rerun.ImportedSessions != 2 || rerun.ImportedMessages != 3 {
		t.Fatalf("second import = %#v, want remaining project sessions and messages", rerun)
	}
	claudeSession, err := service.Get(ctx, "ws-1", externalImportedSessionID("claude-code", "claude-a"))
	if err != nil {
		t.Fatalf("Get imported Claude Code session error = %v", err)
	}
	if claudeSession.AgentTargetID != agenttargetbiz.IDLocalClaudeCode {
		t.Fatalf("imported Claude Code agent target id = %q, want %s", claudeSession.AgentTargetID, agenttargetbiz.IDLocalClaudeCode)
	}
	finalRerun, err := service.ImportExternalSessions(ctx, "ws-1", ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: projectA}},
	})
	if err != nil {
		t.Fatalf("ImportExternalSessions final rerun error = %v", err)
	}
	if finalRerun.ImportedSessions != 0 || finalRerun.ImportedMessages != 0 {
		t.Fatalf("final rerun import = %#v, want no new sessions or messages", finalRerun)
	}
	writeAgentServiceJSONL(t, filepath.Join(codexHome, "sessions", "2026", "codex-a.jsonl"),
		map[string]any{
			"timestamp": timestamp(0),
			"type":      "session_meta",
			"payload":   map[string]any{"id": "codex-a", "cwd": projectA},
		},
		map[string]any{"timestamp": timestamp(time.Second), "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "codex-a-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "Updated first prompt"}},
		}},
		map[string]any{"timestamp": timestamp(2 * time.Second), "type": "response_item", "payload": map[string]any{
			"type":      "function_call",
			"id":        "codex-a-tool-1",
			"name":      "exec_command",
			"call_id":   "call-codex-a-status",
			"arguments": `{"cmd":"git status --short","workdir":"/repo"}`,
		}},
		map[string]any{"timestamp": timestamp(3 * time.Second), "type": "response_item", "payload": map[string]any{
			"type":    "function_call_output",
			"call_id": "call-codex-a-status",
			"output":  "Chunk ID: abc\nOutput:\n M file.go\n",
		}},
		map[string]any{"timestamp": timestamp(4 * time.Second), "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "codex-a-2", "role": "assistant",
			"content": []any{map[string]any{"type": "output_text", "text": "Import planned"}},
		}},
	)
	titleRefresh, err := service.ImportExternalSessions(ctx, "ws-1", ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: projectA, SessionIDs: []string{codexAID}}},
	})
	if err != nil {
		t.Fatalf("ImportExternalSessions title refresh error = %v", err)
	}
	if titleRefresh.ImportedSessions != 0 || titleRefresh.ImportedMessages != 0 {
		t.Fatalf("title refresh import = %#v, want no new sessions or messages", titleRefresh)
	}
	refreshedSession, err := service.Get(ctx, "ws-1", codexAID)
	if err != nil {
		t.Fatalf("Get refreshed imported session error = %v", err)
	}
	if value(refreshedSession.Title) != "Updated first prompt" {
		t.Fatalf("refreshed title = %q, want updated first user message", value(refreshedSession.Title))
	}
}

func TestServiceCreateUsesRuntimePreparerResult(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	var prepareInput agentsidecarservice.PrepareInput
	service.RuntimePreparer = fakeRuntimePreparer{
		result: agentsidecarservice.PreparedRuntime{
			Cwd: "/prepared/workdir",
			Env: []string{"CODEX_HOME=/prepared/codex-home"},
		},
		input: &prepareInput,
	}
	cwd := "/user/workdir"

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID:         "11111111-1111-4111-8111-111111111111",
		AgentTargetID:          agenttargetbiz.IDLocalCodex,
		Cwd:                    &cwd,
		Provider:               "codex",
		ConversationDetailMode: "general",
		InitialContent:         TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if session.Cwd != "/prepared/workdir" {
		t.Fatalf("session cwd = %q, want prepared cwd", session.Cwd)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
	start := runtime.startCalls[0]
	if start.Cwd != "/prepared/workdir" {
		t.Fatalf("runtime cwd = %q, want prepared cwd", start.Cwd)
	}
	if len(start.Env) != 1 || start.Env[0] != "CODEX_HOME=/prepared/codex-home" {
		t.Fatalf("runtime env = %#v, want prepared env", start.Env)
	}
	if prepareInput.ConversationDetailMode != "general" {
		t.Fatalf("prepare conversationDetailMode = %q, want general", prepareInput.ConversationDetailMode)
	}
}

func TestServiceCreateRejectsInvalidCatalogModelBeforePreparingRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{ID: "gpt-5", DisplayName: "GPT-5"},
				{ID: "gpt-5.1", DisplayName: "GPT-5.1"},
			},
		},
	}
	var prepareInput agentsidecarservice.PrepareInput
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
	}

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentTargetID: agenttargetbiz.IDLocalCodex,
		Provider:      "codex",
		Model:         stringRef("gpt-6"),
		Cwd:           stringRef("/repo"),
	})
	if err == nil {
		t.Fatal("Create returned nil error, want invalid model error")
	}
	var invalidModel *InvalidModelError
	if !errors.As(err, &invalidModel) {
		t.Fatalf("Create error = %T %[1]v, want InvalidModelError", err)
	}
	if invalidModel.Model != "gpt-6" || !slices.Equal(invalidModel.AvailableModels, []string{"gpt-5", "gpt-5.1"}) {
		t.Fatalf("invalid model error = %#v", invalidModel)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %d, want 0", len(runtime.startCalls))
	}
	if prepareInput.Provider != "" {
		t.Fatalf("runtime preparer was called: %#v", prepareInput)
	}
}

func TestServiceCreateRejectsInvalidCachedClaudeModelBeforePreparingRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.setLiveComposerModelOptions("claude-code", "ws-1", "/repo", time.Now().UTC(), []ComposerConfigOptionValue{
		{Value: "default", Label: "Default"},
		{Value: "sonnet", Label: "Sonnet"},
	})
	var prepareInput agentsidecarservice.PrepareInput
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
	}

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentTargetID: agenttargetbiz.IDLocalClaudeCode,
		Provider:      "claude-code",
		Model:         stringRef("not-a-claude-model"),
		Cwd:           stringRef("/repo"),
	})
	if err == nil {
		t.Fatal("Create returned nil error, want invalid model error")
	}
	var invalidModel *InvalidModelError
	if !errors.As(err, &invalidModel) {
		t.Fatalf("Create error = %T %[1]v, want InvalidModelError", err)
	}
	if invalidModel.Provider != "claude-code" || !slices.Equal(invalidModel.AvailableModels, []string{"default", "sonnet"}) {
		t.Fatalf("invalid model error = %#v", invalidModel)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %d, want 0", len(runtime.startCalls))
	}
	if prepareInput.Provider != "" {
		t.Fatalf("runtime preparer was called: %#v", prepareInput)
	}
}

func TestServiceCreateDiscoversClaudeModelsBeforeStartingInvalidModel(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.startHook = func(input RuntimeStartInput, session RuntimeSession) RuntimeSession {
		if input.Visible == nil || *input.Visible {
			t.Fatalf("discovery start visible = %#v, want hidden draft session", input.Visible)
		}
		if input.Model != "" {
			t.Fatalf("discovery start model = %q, want empty model", input.Model)
		}
		session.RuntimeContext = map[string]any{
			"configOptions": []any{
				map[string]any{
					"id": "model",
					"options": []any{
						map[string]any{"value": "default", "name": "Default"},
						map[string]any{"value": "sonnet", "name": "Sonnet"},
						map[string]any{"value": "mimo-v2.5-pro", "name": "MIMO V2.5 Pro"},
					},
				},
			},
		}
		return session
	}
	service := newTestService(runtime)
	var prepareInput agentsidecarservice.PrepareInput
	var cleanupCalls []agentsidecarservice.CleanupInput
	service.RuntimePreparer = fakeRuntimePreparer{
		input:        &prepareInput,
		cleanupCalls: &cleanupCalls,
	}

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentTargetID: agenttargetbiz.IDLocalClaudeCode,
		Provider:      "claude-code",
		Model:         stringRef("MiniMax-M2.7"),
		Cwd:           stringRef("/repo"),
	})
	if err == nil {
		t.Fatal("Create returned nil error, want invalid model error")
	}
	var invalidModel *InvalidModelError
	if !errors.As(err, &invalidModel) {
		t.Fatalf("Create error = %T %[1]v, want InvalidModelError", err)
	}
	if invalidModel.Provider != "claude-code" ||
		invalidModel.Model != "MiniMax-M2.7" ||
		!slices.Equal(invalidModel.AvailableModels, []string{"default", "sonnet", "mimo-v2.5-pro"}) {
		t.Fatalf("invalid model error = %#v", invalidModel)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want only hidden discovery session", len(runtime.startCalls))
	}
	if prepareInput.Provider != "claude-code" || prepareInput.Model != "" {
		t.Fatalf("discovery prepare input = %#v, want claude-code without requested model", prepareInput)
	}
	if len(cleanupCalls) == 0 {
		t.Fatal("cleanup calls = 0, want discovery runtime cleanup")
	}
}

func TestServiceCreateUsesProviderDefaultModelWhenModelOmitted(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{ID: "gpt-5", DisplayName: "GPT-5", IsDefault: true},
				{ID: "gpt-5.1", DisplayName: "GPT-5.1"},
			},
		},
	}
	var prepareInput agentsidecarservice.PrepareInput
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
	}

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "33333333-3333-4333-8333-333333333333",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
	if runtime.startCalls[0].Model != "gpt-5" {
		t.Fatalf("runtime model = %q, want default gpt-5", runtime.startCalls[0].Model)
	}
	if prepareInput.Model != "gpt-5" {
		t.Fatalf("prepare model = %q, want default gpt-5", prepareInput.Model)
	}
	if session.Settings == nil || session.Settings.Model != "gpt-5" {
		t.Fatalf("session settings = %#v, want default model", session.Settings)
	}
}

func TestServiceCreatePassesPlanModeToRuntime(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	planMode := true

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "11111111-1111-4111-8111-111111111111",
		AgentTargetID:  agenttargetbiz.IDLocalClaudeCode,
		InitialContent: TextPromptContent("hello"),
		PlanMode:       &planMode,
		Provider:       "claude-code",
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
	if !runtime.startCalls[0].PlanMode {
		t.Fatal("runtime start plan mode = false, want true")
	}
	if session.Settings == nil || !session.Settings.PlanMode {
		t.Fatalf("session settings = %#v, want plan mode true", session.Settings)
	}
}

func TestServiceCreateClampsPlanModeForProvidersWithoutCapability(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	planMode := true

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "22222222-2222-4222-8222-222222222222",
		InitialContent: TextPromptContent("hello"),
		PlanMode:       &planMode,
		Provider:       "gemini",
	})
	if !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), "agent target id is required") {
		t.Fatalf("Create error = %v, want missing agent target ErrInvalidArgument", err)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %d, want 0", len(runtime.startCalls))
	}
}

func TestServiceCreateCleansPreparedRuntimeWhenStartFails(t *testing.T) {
	startErr := errors.New("start failed")
	runtime := newFakeRuntime()
	runtime.startErr = startErr
	service := newTestService(runtime)
	cleanupCalls := make([]agentsidecarservice.CleanupInput, 0)
	service.RuntimePreparer = fakeRuntimePreparer{
		result:       agentsidecarservice.PreparedRuntime{Cwd: "/prepared/workdir"},
		cleanupCalls: &cleanupCalls,
	}

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		InitialContent: TextPromptContent("hello"),
		Provider:       "codex",
	})
	if !errors.Is(err, startErr) {
		t.Fatalf("Create error = %v, want %v", err, startErr)
	}
	if len(cleanupCalls) != 1 ||
		cleanupCalls[0].WorkspaceID != "ws-1" ||
		cleanupCalls[0].AgentSessionID != "session-1" {
		t.Fatalf("cleanup calls = %#v", cleanupCalls)
	}
}

func TestServiceCreateRejectsInvalidContentBeforePreparingRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	prepareInput := (*agentsidecarservice.PrepareInput)(nil)
	service.RuntimePreparer = fakeRuntimePreparer{
		input: prepareInput,
	}

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		InitialContent: []PromptContentBlock{{
			Type:     "image",
			MimeType: "image/png",
			Data:     "not-base64",
		}},
		Provider: "codex",
	})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("Create error = %v, want ErrInvalidArgument", err)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %d, want 0", len(runtime.startCalls))
	}
}

func TestServiceCreateChecksProviderAdapterBeforePreparingRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	var prepareInput agentsidecarservice.PrepareInput
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
		result: agentsidecarservice.PreparedRuntime{
			Cwd: "/prepared/workdir",
		},
	}
	checker := &fakeProviderAvailabilityChecker{
		result: []ProviderAvailability{{
			Provider: "claude-code",
			Status:   ProviderAvailabilityUnavailable,
			Checks: []ProviderAvailabilityCheck{
				{Name: "cli", Passed: true, Detail: "/usr/local/bin/claude"},
				{Name: "adapter", Passed: false, Detail: "ACP adapter not found"},
				{Name: "auth", Passed: true, Detail: "authenticated"},
			},
			LastError: &ProviderAvailabilityError{
				Code:    "acp_adapter_not_found",
				Message: "ACP adapter not found",
			},
		}},
	}
	service.AvailabilityChecker = checker

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalClaudeCode,
		InitialContent: TextPromptContent("hello"),
		Provider:       "claude-code",
	})
	var unavailable *ProviderUnavailableError
	if !errors.As(err, &unavailable) {
		t.Fatalf("Create error = %v, want ProviderUnavailableError", err)
	}
	if unavailable.Provider != "claude-code" ||
		unavailable.ReasonCode != "acp_adapter_not_found" ||
		unavailable.Message != "ACP adapter not found" {
		t.Fatalf("provider unavailable error = %#v", unavailable)
	}
	if checker.callCount != 1 ||
		len(checker.providers) != 1 ||
		checker.providers[0] != "claude-code" {
		t.Fatalf("availability checker providers = %#v, callCount = %d", checker.providers, checker.callCount)
	}
	if prepareInput.WorkspaceID != "" {
		t.Fatalf("runtime preparer input = %#v, want not called", prepareInput)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %d, want 0", len(runtime.startCalls))
	}
	if len(runtime.execCalls) != 0 {
		t.Fatalf("exec calls = %d, want 0", len(runtime.execCalls))
	}
}

func TestServiceCreateDoesNotTreatAuthRequiredAsInstallNeeded(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	checker := &fakeProviderAvailabilityChecker{
		result: []ProviderAvailability{{
			Provider: "claude-code",
			Status:   ProviderAvailabilityUnavailable,
			Checks: []ProviderAvailabilityCheck{
				{Name: "cli", Passed: true, Detail: "/usr/local/bin/claude"},
				{Name: "adapter", Passed: true, Detail: "/usr/local/bin/claude-agent-acp"},
				{Name: "auth", Passed: false, Detail: "authentication required"},
			},
			LastError: &ProviderAvailabilityError{
				Code:    "auth_required",
				Message: "authentication required",
			},
		}},
	}
	service.AvailabilityChecker = checker

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalClaudeCode,
		InitialContent: TextPromptContent("hello"),
		Provider:       "claude-code",
	})
	if err != nil {
		t.Fatalf("Create error = %v, want nil", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
}

func TestServiceCreateCachesProviderAvailabilityCheck(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	checker := &fakeProviderAvailabilityChecker{
		result: []ProviderAvailability{{
			Provider: "codex",
			Status:   ProviderAvailabilityAvailable,
		}},
	}
	service.AvailabilityChecker = checker

	for _, sessionID := range []string{"session-1", "session-2"} {
		_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
			AgentSessionID: sessionID,
			AgentTargetID:  agenttargetbiz.IDLocalCodex,
			InitialContent: TextPromptContent("hello"),
			Provider:       "codex",
		})
		if err != nil {
			t.Fatalf("Create(%s) error = %v, want nil", sessionID, err)
		}
	}
	if checker.callCount != 1 {
		t.Fatalf("availability checker calls = %d, want 1", checker.callCount)
	}
	if len(runtime.startCalls) != 2 {
		t.Fatalf("start calls = %d, want 2", len(runtime.startCalls))
	}
}

func TestServiceSendInputRejectsUnsupportedImageBeforePersistingAttachment(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.validateErr = ErrPromptImageUnsupported
	service := NewService(runtime)
	tempDir := t.TempDir()
	service.PromptAttachmentStore = PromptAttachmentStore{RootDir: tempDir}
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "ready",
		Visible:     true,
	}

	_, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{
		Content: []PromptContentBlock{{
			Type:     "image",
			MimeType: "image/png",
			Data:     "aGVsbG8=",
		}},
	})
	if !errors.Is(err, ErrPromptImageUnsupported) {
		t.Fatalf("SendInput error = %v, want ErrPromptImageUnsupported", err)
	}
	if len(runtime.execCalls) != 0 {
		t.Fatalf("exec calls = %d, want 0", len(runtime.execCalls))
	}
	if entries, err := os.ReadDir(filepath.Join(tempDir, "agent", "attachments")); err == nil && len(entries) > 0 {
		t.Fatalf("attachment entries = %#v, want none", entries)
	}
}

func TestServiceLocalAttachmentPathRequiresWorkspaceSession(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "ready",
		Visible:     true,
	}
	service := NewService(runtime)
	tempDir := t.TempDir()
	service.PromptAttachmentStore = PromptAttachmentStore{RootDir: tempDir}
	path, err := service.PromptAttachmentStore.attachmentPath("ws-1", "session-1", "attachment-1", "image/png")
	if err != nil {
		t.Fatalf("attachmentPath() error = %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte("png"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	got, err := service.LocalAttachmentPath(context.Background(), "ws-1", "session-1", "attachment-1", "image/png")
	if err != nil {
		t.Fatalf("LocalAttachmentPath() error = %v", err)
	}
	if got != path {
		t.Fatalf("LocalAttachmentPath() = %q, want %q", got, path)
	}
	if _, err := service.LocalAttachmentPath(context.Background(), "ws-2", "session-1", "attachment-1", "image/png"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("LocalAttachmentPath() cross-workspace error = %v, want ErrSessionNotFound", err)
	}
}

func TestServiceCreateCleansPreparedRuntimeWhenInitialPromptFails(t *testing.T) {
	execErr := errors.New("exec failed")
	runtime := newFakeRuntime()
	runtime.execErr = execErr
	service := newTestService(runtime)
	cleanupCalls := make([]agentsidecarservice.CleanupInput, 0)
	service.RuntimePreparer = fakeRuntimePreparer{
		result:       agentsidecarservice.PreparedRuntime{Cwd: "/prepared/workdir"},
		cleanupCalls: &cleanupCalls,
	}

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
	})
	if !errors.Is(err, execErr) {
		t.Fatalf("Create error = %v, want %v", err, execErr)
	}
	if len(runtime.closeCalls) != 1 || runtime.closeCalls[0].AgentSessionID != "session-1" {
		t.Fatalf("close calls = %#v", runtime.closeCalls)
	}
	if len(cleanupCalls) != 1 ||
		cleanupCalls[0].WorkspaceID != "ws-1" ||
		cleanupCalls[0].AgentSessionID != "session-1" {
		t.Fatalf("cleanup calls = %#v", cleanupCalls)
	}
	if _, ok := runtime.Session("ws-1", "session-1"); ok {
		t.Fatal("runtime session still exists after failed initial prompt")
	}
}

func TestServiceCreatePassesInitialDisplayPromptToRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID:       "session-1",
		AgentTargetID:        agenttargetbiz.IDLocalCodex,
		Provider:             "codex",
		InitialContent:       TextPromptContent("real automation prompt"),
		InitialDisplayPrompt: "Run Automation",
		Metadata: map[string]any{
			"":                        "drop",
			"clientSubmitId":          "submit-create-1",
			"clientSubmittedAtUnixMs": int64(12345),
			" spacedDiagnosticKey ":   "trimmed",
		},
	})
	if err != nil {
		t.Fatalf("Create error = %v", err)
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
	}
	call := runtime.execCalls[0]
	if len(call.Content) != 1 || call.Content[0].Text != "real automation prompt" {
		t.Fatalf("runtime content = %#v", call.Content)
	}
	if call.DisplayPrompt != "Run Automation" {
		t.Fatalf("runtime display prompt = %q", call.DisplayPrompt)
	}
	if call.Metadata["clientSubmitId"] != "submit-create-1" || call.Metadata["spacedDiagnosticKey"] != "trimmed" {
		t.Fatalf("runtime metadata = %#v", call.Metadata)
	}
	if _, ok := call.Metadata[""]; ok {
		t.Fatalf("runtime metadata includes blank key: %#v", call.Metadata)
	}
}

func TestServiceCreateEmptySessionDoesNotExec(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	visible := false

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalClaudeCode,
		Provider:       "claude-code",
		Visible:        &visible,
	})
	if err != nil {
		t.Fatalf("Create error = %v", err)
	}
	if session.ID != "session-1" {
		t.Fatalf("session id = %q, want session-1", session.ID)
	}
	if session.Visible {
		t.Fatal("session visible = true, want false")
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
	if len(runtime.validateCalls) != 0 {
		t.Fatalf("validate calls = %d, want 0", len(runtime.validateCalls))
	}
	if len(runtime.execCalls) != 0 {
		t.Fatalf("exec calls = %d, want 0", len(runtime.execCalls))
	}
}

func TestServiceCreateDoesNotPassDerivedPromptToRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Provider:       "codex",
		InitialContent: TextPromptContent("ordinary prompt"),
	})
	if err != nil {
		t.Fatalf("Create error = %v", err)
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
	}
	if runtime.execCalls[0].DisplayPrompt != "" {
		t.Fatalf("runtime display prompt = %q, want empty explicit display prompt", runtime.execCalls[0].DisplayPrompt)
	}
}

func TestServiceUpdateVisibleUpdatesRuntimeSession(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	visible := false
	created, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalClaudeCode,
		Provider:       "claude-code",
		Visible:        &visible,
	})
	if err != nil {
		t.Fatalf("Create error = %v", err)
	}
	if created.Visible {
		t.Fatal("created visible = true, want false")
	}

	session, err := service.UpdateVisible(context.Background(), "ws-1", "session-1", true)
	if err != nil {
		t.Fatalf("UpdateVisible error = %v", err)
	}
	if !session.Visible {
		t.Fatal("updated visible = false, want true")
	}
	runtimeSession, ok := runtime.Session("ws-1", "session-1")
	if !ok || !runtimeSession.Visible {
		t.Fatalf("runtime session = %#v, ok=%v; want visible true", runtimeSession, ok)
	}
}

func TestServiceSendInputPassesDisplayPromptToRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "ready",
		Visible:     true,
	}

	_, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{
		Content:       TextPromptContent("real repair prompt"),
		DisplayPrompt: "Fix the app",
		Metadata: map[string]any{
			"clientSubmitId":             "submit-1",
			"clientSubmittedAtUnixMs":    int64(1234),
			" ignoredBlankKeyIsRemoved ": true,
			"":                           "drop",
		},
	})
	if err != nil {
		t.Fatalf("SendInput error = %v", err)
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
	}
	call := runtime.execCalls[0]
	if len(call.Content) != 1 || call.Content[0].Text != "real repair prompt" {
		t.Fatalf("runtime content = %#v", call.Content)
	}
	if call.DisplayPrompt != "Fix the app" {
		t.Fatalf("runtime display prompt = %q", call.DisplayPrompt)
	}
	if call.Metadata["clientSubmitId"] != "submit-1" ||
		call.Metadata["clientSubmittedAtUnixMs"] != int64(1234) ||
		call.Metadata["ignoredBlankKeyIsRemoved"] != true {
		t.Fatalf("runtime metadata = %#v", call.Metadata)
	}
	if _, ok := call.Metadata[""]; ok {
		t.Fatalf("runtime metadata includes blank key: %#v", call.Metadata)
	}
}

func TestServiceCreateGeneratesSessionIDBeforePreparingRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	var prepareInput agentsidecarservice.PrepareInput
	service := newTestService(runtime)
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
		result: agentsidecarservice.PreparedRuntime{
			Cwd: "/prepared/workdir",
		},
	}
	cwd := "/user/workdir"

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Cwd:            &cwd,
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if session.ID == "" {
		t.Fatal("session ID is empty, want generated ID")
	}
	if prepareInput.AgentSessionID != session.ID {
		t.Fatalf("prepare agentSessionID = %q, want %q", prepareInput.AgentSessionID, session.ID)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
	if runtime.startCalls[0].AgentSessionID != session.ID {
		t.Fatalf("runtime agentSessionID = %q, want %q", runtime.startCalls[0].AgentSessionID, session.ID)
	}
}

func TestServiceCreatePassesExtraSkillsToRuntimePreparer(t *testing.T) {
	runtime := newFakeRuntime()
	var prepareInput agentsidecarservice.PrepareInput
	service := newTestService(runtime)
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
		result: agentsidecarservice.PreparedRuntime{
			Cwd: "/prepared/workdir",
		},
	}
	cwd := "/user/workdir"

	if _, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Cwd:            &cwd,
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
		ExtraSkills: []SessionSkillBundle{
			{
				Name: "app-factory",
				Files: map[string]string{
					"SKILL.md":                  "skill body",
					"references/contract.md":    "contract",
					"references/demos/demo.txt": "demo",
				},
			},
		},
	}); err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if len(prepareInput.ExtraSkills) != 1 {
		t.Fatalf("prepare extra skills = %#v", prepareInput.ExtraSkills)
	}
	if prepareInput.ExtraSkills[0].Name != "app-factory" {
		t.Fatalf("prepare extra skill name = %q", prepareInput.ExtraSkills[0].Name)
	}
	if prepareInput.ExtraSkills[0].Files["references/contract.md"] != "contract" {
		t.Fatalf("prepare extra skill files = %#v", prepareInput.ExtraSkills[0].Files)
	}
}

func TestServiceGetSkillBundleUsesRuntimeRenderer(t *testing.T) {
	runtime := newFakeRuntime()
	var renderInput agentsidecarservice.PrepareInput
	service := NewService(runtime)
	service.RuntimePreparer = fakeSkillBundleRenderer{
		input: &renderInput,
		bundle: agentsidecarservice.SkillBundle{
			SchemaVersion:  1,
			Provider:       "codex",
			AgentSessionID: "run-1",
			CLICommand:     "tutti-dev",
			Skills: []agentsidecarservice.SkillMaterializationRecord{
				{SkillID: "tutti/tutti-cli", Slug: "tutti-cli", DeliveryMode: "materialized-files"},
			},
		},
	}

	bundle, err := service.GetSkillBundle(context.Background(), "ws-1", SkillBundleInput{
		AgentSessionID: "run-1",
		BrowserUse:     true,
		Provider:       " codex ",
	})
	if err != nil {
		t.Fatalf("GetSkillBundle returned error: %v", err)
	}
	if renderInput.WorkspaceID != "ws-1" ||
		renderInput.AgentSessionID != "run-1" ||
		renderInput.Provider != "codex" ||
		!renderInput.BrowserUse ||
		renderInput.ComputerUse {
		t.Fatalf("render input = %#v", renderInput)
	}
	if bundle.CLICommand != "tutti-dev" || len(bundle.Skills) != 1 || bundle.Skills[0].SkillID != "tutti/tutti-cli" {
		t.Fatalf("bundle = %#v", bundle)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("runtime start calls = %d, want 0", len(runtime.startCalls))
	}
}

func TestServiceGetSkillBundleRequiresRenderer(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	service.RuntimePreparer = fakeRuntimePreparer{}

	_, err := service.GetSkillBundle(context.Background(), "ws-1", SkillBundleInput{Provider: "codex"})
	if !errors.Is(err, ErrSkillBundleUnavailable) {
		t.Fatalf("GetSkillBundle error = %v, want ErrSkillBundleUnavailable", err)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("runtime start calls = %d, want 0", len(runtime.startCalls))
	}
}

func TestServiceDeleteCleansPreparedRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	cleanupCalls := make([]agentsidecarservice.CleanupInput, 0)
	service.RuntimePreparer = fakeRuntimePreparer{
		result:       agentsidecarservice.PreparedRuntime{Cwd: "/prepared/workdir"},
		cleanupCalls: &cleanupCalls,
	}
	cwd := "/user/workdir"
	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "11111111-1111-4111-8111-111111111111",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Cwd:            &cwd,
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}

	removed, err := service.Delete(context.Background(), "ws-1", session.ID)
	if err != nil {
		t.Fatalf("Delete returned error: %v", err)
	}
	if !removed {
		t.Fatal("Delete removed = false, want true")
	}
	if len(cleanupCalls) != 1 {
		t.Fatalf("cleanup calls = %d, want 1", len(cleanupCalls))
	}
	if cleanupCalls[0].WorkspaceID != "ws-1" || cleanupCalls[0].AgentSessionID != session.ID {
		t.Fatalf("cleanup call = %#v", cleanupCalls[0])
	}
}

func TestServiceGetsComposerOptionsWithoutStartingRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	service.CapabilityLister = &recordingComposerCapabilityLister{}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
		Settings: ComposerSettings{
			Model:            " gpt-5 ",
			PermissionModeID: " auto ",
			ReasoningEffort:  " high ",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(runtime.sessions) != 0 {
		t.Fatalf("runtime sessions = %d, want no started sessions", len(runtime.sessions))
	}
	if options.Provider != "codex" {
		t.Fatalf("provider = %q, want codex", options.Provider)
	}
	if options.EffectiveSettings.Model != "gpt-5" || options.EffectiveSettings.PermissionModeID != "auto" || options.EffectiveSettings.ReasoningEffort != "high" {
		t.Fatalf("effectiveSettings = %#v", options.EffectiveSettings)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	if len(configOptions) != 3 {
		t.Fatalf("len(configOptions) = %d, want 3", len(configOptions))
	}
	if configOptions[0]["id"] != "model" || configOptions[0]["currentValue"] != "gpt-5" {
		t.Fatalf("model option = %#v", configOptions[0])
	}
	if configOptions[1]["id"] != "reasoning_effort" || configOptions[1]["currentValue"] != "high" {
		t.Fatalf("reasoning option = %#v", configOptions[1])
	}
	if configOptions[2]["id"] != "service_tier" || configOptions[2]["currentValue"] != "standard" {
		t.Fatalf("speed option = %#v", configOptions[2])
	}
	if options.SpeedConfig.CurrentValue != "standard" || len(options.SpeedConfig.Options) != 2 {
		t.Fatalf("speedConfig = %#v", options.SpeedConfig)
	}
	if options.ModelConfig.CurrentValue != "gpt-5" || len(options.ModelConfig.Options) != 1 {
		t.Fatalf("modelConfig = %#v", options.ModelConfig)
	}
	if options.ReasoningConfig.CurrentValue != "high" || len(options.ReasoningConfig.Options) == 0 {
		t.Fatalf("reasoningConfig = %#v", options.ReasoningConfig)
	}
	if options.PermissionConfig.DefaultValue != "auto" || len(options.PermissionConfig.Modes) != 3 {
		t.Fatalf("permissionConfig = %#v", options.PermissionConfig)
	}
	if options.PermissionConfig.Modes[1].Label != "Approve for me" {
		t.Fatalf("permission label = %#v, want Approve for me", options.PermissionConfig.Modes[1])
	}
	capabilities, ok := options.RuntimeContext["capabilities"].([]string)
	if !ok || !slices.Contains(capabilities, "imageInput") {
		t.Fatalf("capabilities = %#v, want imageInput", options.RuntimeContext["capabilities"])
	}
}

func TestServiceGetComposerOptionsDoesNotCarryConversationDetailMode(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
		Settings: ComposerSettings{
			ConversationDetailMode: "general",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if got := options.EffectiveSettings.ConversationDetailMode; got != "" {
		t.Fatalf("effectiveSettings.conversationDetailMode = %q, want empty", got)
	}
	payload := ComposerSettingsToMap(options.EffectiveSettings)
	if _, ok := payload["conversationDetailMode"]; ok {
		t.Fatalf("effectiveSettings payload includes conversationDetailMode: %#v", payload)
	}
}

type recordingComposerCapabilityLister struct {
	callCount int
}

func (l *recordingComposerCapabilityLister) ListComposerCapabilityOptions(
	_ context.Context,
	_ string,
	_ string,
	_ []ComposerSkillOption,
) ([]ComposerCapabilityOption, []string) {
	l.callCount++
	return []ComposerCapabilityOption{{
		ID:         "connector:github",
		Kind:       "connector",
		Name:       "github",
		Label:      "GitHub",
		Status:     "available",
		Invocation: "promptItem",
	}}, nil
}

func TestServiceGetComposerOptionsSkipsCapabilityCatalogWhenDisabled(t *testing.T) {
	runtime := newFakeRuntime()
	lister := &recordingComposerCapabilityLister{}
	service := NewService(runtime)
	service.CapabilityLister = lister
	includeCapabilityCatalog := false

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider:                 "codex",
		IncludeCapabilityCatalog: &includeCapabilityCatalog,
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if lister.callCount != 0 {
		t.Fatalf("capability lister calls = %d, want 0", lister.callCount)
	}
	if len(options.CapabilityCatalog) != 0 {
		t.Fatalf("capability catalog = %#v, want empty when disabled", options.CapabilityCatalog)
	}
}

func TestServiceGetComposerOptionsIncludesCapabilityCatalogByDefault(t *testing.T) {
	runtime := newFakeRuntime()
	lister := &recordingComposerCapabilityLister{}
	service := NewService(runtime)
	service.CapabilityLister = lister

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if lister.callCount != 1 {
		t.Fatalf("capability lister calls = %d, want 1", lister.callCount)
	}
	if len(options.CapabilityCatalog) != 1 || options.CapabilityCatalog[0].ID != "connector:github" {
		t.Fatalf("capability catalog = %#v", options.CapabilityCatalog)
	}
}

func TestServiceGetComposerOptionsCachesCapabilityCatalog(t *testing.T) {
	runtime := newFakeRuntime()
	lister := &recordingComposerCapabilityLister{}
	service := NewService(runtime)
	service.CapabilityLister = lister

	first, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions first returned error: %v", err)
	}
	first.CapabilityCatalog[0].ID = "mutated"
	second, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions second returned error: %v", err)
	}
	if lister.callCount != 1 {
		t.Fatalf("capability lister calls = %d, want 1", lister.callCount)
	}
	if len(second.CapabilityCatalog) != 1 || second.CapabilityCatalog[0].ID != "connector:github" {
		t.Fatalf("cached capability catalog = %#v, want unmutated github connector", second.CapabilityCatalog)
	}
}

func TestServiceGetsComposerOptionsLocalizesDisplayLabels(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Locale:   "zh-CN",
		Provider: "claude-code",
		Settings: ComposerSettings{
			PermissionModeID: "dontAsk",
			ReasoningEffort:  "xhigh",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.ReasoningConfig.Options[len(options.ReasoningConfig.Options)-1].Label != "超高" {
		t.Fatalf("reasoningConfig = %#v, want zh-CN xhigh label", options.ReasoningConfig)
	}
	var dontAsk PermissionModeOption
	for _, mode := range options.PermissionConfig.Modes {
		if mode.ID == "dontAsk" {
			dontAsk = mode
		}
	}
	if dontAsk.Label != "不再询问" || dontAsk.Description == "" {
		t.Fatalf("dontAsk = %#v, want localized label and description", dontAsk)
	}
	capabilities, ok := options.RuntimeContext["capabilities"].([]string)
	if !ok || !slices.Contains(capabilities, "imageInput") {
		t.Fatalf("capabilities = %#v, want imageInput", options.RuntimeContext["capabilities"])
	}
}

func TestServiceGetsComposerOptionsFromCodexModelCatalog(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{ID: "gpt-5", DisplayName: "GPT-5"},
				{ID: "gpt-5.1", DisplayName: "GPT-5.1"},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
		Settings: ComposerSettings{
			Model:           "gpt-5.2-custom",
			ReasoningEffort: "medium",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	modelOptions, ok := configOptions[0]["options"].([]map[string]string)
	if !ok {
		t.Fatalf("model options = %#v", configOptions[0]["options"])
	}
	if len(modelOptions) != 3 {
		t.Fatalf("len(modelOptions) = %d, want catalog models plus selected custom model", len(modelOptions))
	}
	if modelOptions[0]["value"] != "gpt-5" || modelOptions[1]["value"] != "gpt-5.1" || modelOptions[2]["value"] != "gpt-5.2-custom" {
		t.Fatalf("modelOptions = %#v", modelOptions)
	}
	if options.RuntimeContext["modelCatalogSource"] != "codex-cli" {
		t.Fatalf("modelCatalogSource = %#v, want codex-cli", options.RuntimeContext["modelCatalogSource"])
	}
	if len(runtime.sessions) != 0 {
		t.Fatalf("runtime sessions = %d, want no started sessions", len(runtime.sessions))
	}
}

func TestServiceGetsComposerOptionsWithResolvedCodexDefaultModel(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{ID: "gpt-5.5", DisplayName: "GPT-5.5", IsDefault: true},
				{ID: "gpt-5.4", DisplayName: "GPT-5.4"},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.Model != "gpt-5.5" {
		t.Fatalf("effectiveSettings.model = %q, want gpt-5.5", options.EffectiveSettings.Model)
	}
	if options.EffectiveSettings.ReasoningEffort != "high" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want high", options.EffectiveSettings.ReasoningEffort)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	if configOptions[0]["currentValue"] != "gpt-5.5" {
		t.Fatalf("model option = %#v", configOptions[0])
	}
	if len(configOptions) < 2 || configOptions[1]["currentValue"] != "high" {
		t.Fatalf("reasoning option = %#v", configOptions)
	}
}

func TestServiceGetsComposerOptionsNormalizesCodexMinimalReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
		Settings: ComposerSettings{
			ReasoningEffort: "minimal",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.ReasoningEffort != "high" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want high", options.EffectiveSettings.ReasoningEffort)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) < 1 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	var reasoningOption map[string]any
	for _, option := range configOptions {
		if option["id"] == "reasoning_effort" {
			reasoningOption = option
			break
		}
	}
	if reasoningOption == nil {
		t.Fatalf("configOptions = %#v, want reasoning_effort option", configOptions)
	}
	reasoningOptions, ok := reasoningOption["options"].([]map[string]string)
	if !ok {
		t.Fatalf("reasoning options = %#v", reasoningOption["options"])
	}
	for _, option := range reasoningOptions {
		if option["value"] == "minimal" {
			t.Fatalf("reasoning options = %#v, want codex minimal filtered out", reasoningOptions)
		}
	}
}

func TestServiceGetsComposerOptionsNormalizesClaudeMinimalReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "claude-code",
		Settings: ComposerSettings{
			ReasoningEffort: "minimal",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.ReasoningEffort != "high" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want high", options.EffectiveSettings.ReasoningEffort)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) < 1 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	if configOptions[0]["id"] != "effort" {
		t.Fatalf("first config option = %#v, want effort", configOptions[0])
	}
	reasoningOptions, ok := configOptions[0]["options"].([]map[string]string)
	if !ok {
		t.Fatalf("reasoning options = %#v", configOptions[0]["options"])
	}
	for _, option := range reasoningOptions {
		if option["value"] == "minimal" {
			t.Fatalf("reasoning options = %#v, want claude minimal filtered out", reasoningOptions)
		}
	}
}

func TestServiceGetsComposerOptionsSkipsClaudeStaticModelCatalog(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "claude-code",
			Source:   "test-ignored",
			Models: []AgentModelOption{
				{ID: "sonnet", DisplayName: "sonnet"},
				{ID: "default", DisplayName: "default", IsDefault: true},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "claude-code",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.Model != "" {
		t.Fatalf("effectiveSettings.model = %q, want empty", options.EffectiveSettings.Model)
	}
	if options.EffectiveSettings.ReasoningEffort != "high" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want high", options.EffectiveSettings.ReasoningEffort)
	}
	if options.RuntimeContext["modelCatalogSource"] != nil {
		t.Fatalf("modelCatalogSource = %#v, want nil", options.RuntimeContext["modelCatalogSource"])
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	for _, option := range configOptions {
		if option["id"] == "model" {
			t.Fatalf("configOptions = %#v, want no static Claude model option", configOptions)
		}
	}
}

func TestGetComposerOptionsClaudeCodeWithoutWorkspaceClearsUnverifiedSelectedModel(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "claude-code",
		Cwd:      "/repo",
		Settings: ComposerSettings{
			Model: "claude-sonnet-4-20250514",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.Model != "" {
		t.Fatalf("effectiveSettings.model = %q, want empty without live model verification", options.EffectiveSettings.Model)
	}
	if options.RuntimeContext["model"] != nil {
		t.Fatalf("runtime model = %#v, want nil without live model verification", options.RuntimeContext["model"])
	}
	if options.ModelConfig.Configurable || len(options.ModelConfig.Options) != 0 {
		t.Fatalf("modelConfig = %#v, want no unverified Claude model config", options.ModelConfig)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	for _, option := range configOptions {
		if option["id"] == "model" {
			t.Fatalf("configOptions = %#v, want no unverified Claude model option", configOptions)
		}
	}
}

func TestGetComposerOptionsClaudeCodeDiscoversLiveModels(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	runtime.startHook = func(input RuntimeStartInput, session RuntimeSession) RuntimeSession {
		if input.Provider != "claude-code" {
			return session
		}
		session.RuntimeContext = map[string]any{
			"configOptions": []any{
				map[string]any{
					"id":           "model",
					"currentValue": "default",
					"options": []any{
						map[string]any{"name": "Default", "value": "default"},
						map[string]any{"name": "Sonnet", "value": "sonnet"},
					},
				},
				map[string]any{
					"id":           "effort",
					"currentValue": "high",
					"options": []any{
						map[string]any{"name": "High", "value": "high"},
					},
				},
			},
		}
		return session
	}
	service := NewService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider:    "claude-code",
		WorkspaceID: "ws-1",
		Cwd:         "/repo",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
	if len(runtime.closeCalls) != 1 {
		t.Fatalf("close calls = %d, want 1", len(runtime.closeCalls))
	}
	if !options.ModelConfig.Configurable || len(options.ModelConfig.Options) != 2 {
		t.Fatalf("modelConfig = %#v, want discovered model options", options.ModelConfig)
	}
	if options.RuntimeContext["modelCatalogSource"] != "acp-live-discovery" {
		t.Fatalf("modelCatalogSource = %#v, want acp-live-discovery", options.RuntimeContext["modelCatalogSource"])
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 || configOptions[0]["id"] != "model" {
		t.Fatalf("configOptions = %#v, want model option merged into runtime context", options.RuntimeContext["configOptions"])
	}
}

func TestGetComposerOptionsClaudeCodeLiveModelsSanitizesUnsupportedSelectedModel(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	runtime.startHook = func(input RuntimeStartInput, session RuntimeSession) RuntimeSession {
		if input.Provider != "claude-code" {
			return session
		}
		if input.Model != "" {
			t.Fatalf("discovery start model = %q, want empty model", input.Model)
		}
		session.RuntimeContext = map[string]any{
			"configOptions": []any{
				map[string]any{
					"id":           "model",
					"currentValue": "default",
					"options": []any{
						map[string]any{"name": "Default", "value": "default"},
						map[string]any{"name": "Sonnet", "value": "sonnet"},
						map[string]any{"name": "Opus", "value": "opus"},
						map[string]any{"name": "Haiku", "value": "haiku"},
					},
				},
			},
		}
		return session
	}
	service := NewService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider:    "claude-code",
		WorkspaceID: "ws-1",
		Cwd:         "/repo",
		Settings: ComposerSettings{
			Model: "claude-sonnet-4-20250514",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.Model != "default" {
		t.Fatalf("effectiveSettings.model = %q, want default", options.EffectiveSettings.Model)
	}
	if options.ModelConfig.CurrentValue != "default" || options.ModelConfig.DefaultValue != "default" {
		t.Fatalf("modelConfig = %#v, want default current/default", options.ModelConfig)
	}
	for _, option := range options.ModelConfig.Options {
		if option.Value == "claude-sonnet-4-20250514" {
			t.Fatalf("modelConfig options = %#v, want no unsupported selected model", options.ModelConfig.Options)
		}
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 || configOptions[0]["id"] != "model" {
		t.Fatalf("configOptions = %#v, want model option merged into runtime context", options.RuntimeContext["configOptions"])
	}
	if configOptions[0]["currentValue"] != "default" {
		t.Fatalf("model runtime option = %#v, want default currentValue", configOptions[0])
	}
	runtimeModelOptions, ok := configOptions[0]["options"].([]map[string]string)
	if !ok {
		t.Fatalf("runtime model options = %#v", configOptions[0]["options"])
	}
	for _, option := range runtimeModelOptions {
		if option["value"] == "claude-sonnet-4-20250514" {
			t.Fatalf("runtime model options = %#v, want no unsupported selected model", runtimeModelOptions)
		}
	}
}

func TestGetComposerOptionsClaudeCodeDeletesHiddenDiscoverySession(t *testing.T) {
	runtime := newFakeRuntime()
	persisted := fakeSessionReader{sessions: map[string]PersistedSession{}}
	runtime.startHook = func(input RuntimeStartInput, session RuntimeSession) RuntimeSession {
		if input.Provider != "claude-code" {
			return session
		}
		session.RuntimeContext = map[string]any{
			"configOptions": []any{
				map[string]any{
					"id":           "model",
					"currentValue": "default",
					"options": []any{
						map[string]any{"name": "Default", "value": "default"},
					},
				},
			},
		}
		persisted.sessions[input.WorkspaceID+":"+session.ID] = PersistedSession{
			ID:          session.ID,
			WorkspaceID: input.WorkspaceID,
			Provider:    input.Provider,
			Visible:     session.Visible,
		}
		return session
	}
	service := NewService(runtime)
	service.SessionReader = persisted

	if _, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider:    "claude-code",
		WorkspaceID: "ws-1",
		Cwd:         "/repo",
	}); err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(runtime.closeCalls) != 1 {
		t.Fatalf("close calls = %d, want 1", len(runtime.closeCalls))
	}
	if len(persisted.sessions) != 0 {
		t.Fatalf("persisted sessions = %#v, want hidden discovery session deleted", persisted.sessions)
	}
}

func TestGetComposerOptionsClaudeCodeLiveModelsUsesCache(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.startHook = func(input RuntimeStartInput, session RuntimeSession) RuntimeSession {
		if input.Provider != "claude-code" {
			return session
		}
		session.RuntimeContext = map[string]any{
			"configOptions": []any{
				map[string]any{
					"id":           "model",
					"currentValue": "default",
					"options": []any{
						map[string]any{"name": "Default", "value": "default"},
					},
				},
			},
		}
		return session
	}
	service := NewService(runtime)

	for range 2 {
		_, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
			Provider:    "claude-code",
			WorkspaceID: "ws-1",
			Cwd:         "/repo",
		})
		if err != nil {
			t.Fatalf("GetComposerOptions returned error: %v", err)
		}
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1 with cache", len(runtime.startCalls))
	}
	if len(runtime.closeCalls) != 1 {
		t.Fatalf("close calls = %d, want 1 with cache", len(runtime.closeCalls))
	}
}

func TestGetComposerOptionsClaudeCodeLiveModelsFailedStartupReturnsQuickly(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.startHook = func(input RuntimeStartInput, session RuntimeSession) RuntimeSession {
		if input.Provider != "claude-code" {
			return session
		}
		session.Status = "failed"
		session.LastError = "auth failed"
		return session
	}
	service := NewService(runtime)
	startedAt := time.Now()

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider:    "claude-code",
		WorkspaceID: "ws-failed",
		Cwd:         "/repo",
		Settings: ComposerSettings{
			Model: "claude-sonnet-4-20250514",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if elapsed := time.Since(startedAt); elapsed >= 400*time.Millisecond {
		t.Fatalf("GetComposerOptions elapsed = %s, want failed discovery to return quickly", elapsed)
	}
	if len(runtime.closeCalls) != 1 {
		t.Fatalf("close calls = %d, want 1", len(runtime.closeCalls))
	}
	if options.ModelConfig.Configurable || len(options.ModelConfig.Options) != 0 {
		t.Fatalf("modelConfig = %#v, want no unverified Claude model config after failed discovery", options.ModelConfig)
	}
	if options.EffectiveSettings.Model != "" {
		t.Fatalf("effectiveSettings.model = %q, want empty after failed live model verification", options.EffectiveSettings.Model)
	}
	if options.RuntimeContext["model"] != nil {
		t.Fatalf("runtime model = %#v, want nil after failed live model verification", options.RuntimeContext["model"])
	}
}

func TestGetComposerOptionsClaudeCodeLiveModelsPropagatesCallerCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runtime := newFakeRuntime()
	closed := make(chan struct{})
	runtime.closeHook = func(RuntimeCloseInput) {
		select {
		case <-closed:
		default:
			close(closed)
		}
	}
	runtime.startHook = func(input RuntimeStartInput, session RuntimeSession) RuntimeSession {
		if input.Provider == "claude-code" {
			cancel()
		}
		return session
	}
	service := NewService(runtime)

	_, err := service.GetComposerOptions(ctx, ComposerOptionsInput{
		Provider:    "claude-code",
		WorkspaceID: "ws-canceled",
		Cwd:         "/repo",
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("GetComposerOptions error = %v, want context canceled", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("runtime close was not called after caller cancellation")
	}
	if len(runtime.closeCalls) != 1 {
		t.Fatalf("close calls = %d, want 1 even on caller cancellation", len(runtime.closeCalls))
	}
}

func TestGetComposerOptionsClaudeCodeLiveModelsSharedDiscoveryHonorsCallerCancellation(t *testing.T) {
	runtime := newFakeRuntime()
	firstStarted := make(chan struct{})
	firstClosed := make(chan struct{})
	runtime.closeHook = func(RuntimeCloseInput) {
		select {
		case <-firstClosed:
		default:
			close(firstClosed)
		}
	}
	runtime.startHook = func(input RuntimeStartInput, session RuntimeSession) RuntimeSession {
		if input.Provider == "claude-code" {
			select {
			case <-firstStarted:
			default:
				close(firstStarted)
			}
		}
		return session
	}
	service := NewService(runtime)
	firstCtx, cancelFirst := context.WithCancel(context.Background())
	defer cancelFirst()
	firstDone := make(chan error, 1)
	go func() {
		_, err := service.GetComposerOptions(firstCtx, ComposerOptionsInput{
			Provider:    "claude-code",
			WorkspaceID: "ws-shared-canceled",
			Cwd:         "/repo",
		})
		firstDone <- err
	}()

	select {
	case <-firstStarted:
	case <-time.After(time.Second):
		t.Fatal("first live model discovery did not start")
	}

	secondCtx, cancelSecond := context.WithCancel(context.Background())
	cancelSecond()
	_, err := service.GetComposerOptions(secondCtx, ComposerOptionsInput{
		Provider:    "claude-code",
		WorkspaceID: "ws-shared-canceled",
		Cwd:         "/repo",
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("GetComposerOptions error = %v, want context canceled for shared caller", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1 shared live model discovery", len(runtime.startCalls))
	}

	cancelFirst()
	select {
	case err := <-firstDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("first GetComposerOptions error = %v, want context canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("first live model discovery did not stop after cancellation")
	}
	select {
	case <-firstClosed:
	case <-time.After(time.Second):
		t.Fatal("shared live model discovery did not close after cancellation")
	}
}

func TestServiceGetsComposerOptionsLeavesUnresolvedProviderModelUnset(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "openclaw",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.Model != "" {
		t.Fatalf("effectiveSettings.model = %q, want empty", options.EffectiveSettings.Model)
	}
	if options.EffectiveSettings.ReasoningEffort != "" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want empty", options.EffectiveSettings.ReasoningEffort)
	}
	if capabilities, ok := options.RuntimeContext["capabilities"].([]string); ok &&
		slices.Contains(capabilities, "imageInput") {
		t.Fatalf("capabilities = %#v, want no imageInput", options.RuntimeContext["capabilities"])
	}
}

func TestServiceSessionNormalizesStaleClaudeSDKImageCapability(t *testing.T) {
	session := serviceSession(RuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Settings: &ComposerSettings{
			Model: "haiku",
		},
		RuntimeContext: map[string]any{
			"adapter":      "claude-agent-sdk",
			"capabilities": []any{"compact", "tokenUsage", "rateLimits", "planMode", "interrupt", "review"},
		},
		Status:          "ready",
		CreatedAtUnixMS: 100,
		UpdatedAtUnixMS: 200,
	}, true)

	capabilities, ok := session.RuntimeContext["capabilities"].([]any)
	hasImageInput := false
	for _, capability := range capabilities {
		if capability == "imageInput" {
			hasImageInput = true
			break
		}
	}
	if !ok || !hasImageInput {
		t.Fatalf("capabilities = %#v, want imageInput", session.RuntimeContext["capabilities"])
	}
}

func TestServiceUpdateSettingsNormalizesCodexMinimalReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:          "session-1",
		Provider:    "codex",
		WorkspaceID: "ws-1",
		Status:      "working",
		Settings: &ComposerSettings{
			ReasoningEffort: "high",
		},
	}
	service := NewService(runtime)
	reasoningEffort := "minimal"

	session, err := service.UpdateSettings(context.Background(), "ws-1", "session-1", ComposerSettingsPatch{
		ReasoningEffort: &reasoningEffort,
	})
	if err != nil {
		t.Fatalf("UpdateSettings returned error: %v", err)
	}
	if session.Settings == nil || session.Settings.ReasoningEffort != "high" {
		t.Fatalf("session settings = %#v, want reasoningEffort high", session.Settings)
	}
}

func TestServiceUpdateSettingsNormalizesClaudeMinimalReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:          "session-1",
		Provider:    "claude-code",
		WorkspaceID: "ws-1",
		Status:      "working",
		Settings: &ComposerSettings{
			ReasoningEffort: "high",
		},
	}
	service := NewService(runtime)
	reasoningEffort := "minimal"

	session, err := service.UpdateSettings(context.Background(), "ws-1", "session-1", ComposerSettingsPatch{
		ReasoningEffort: &reasoningEffort,
	})
	if err != nil {
		t.Fatalf("UpdateSettings returned error: %v", err)
	}
	if session.Settings == nil || session.Settings.ReasoningEffort != "high" {
		t.Fatalf("session settings = %#v, want reasoningEffort high", session.Settings)
	}
}

func TestServiceMapsRuntimeSessionLastError(t *testing.T) {
	now := time.Now().UnixMilli()
	session := serviceSession(RuntimeSession{
		ID:              "session-1",
		Provider:        "codex",
		Status:          "failed",
		Title:           "Smoke",
		LastError:       "codex-acp: executable file not found",
		WorkspaceID:     "ws-1",
		CreatedAtUnixMS: now,
		UpdatedAtUnixMS: now,
	}, true)

	if session.LastError == nil || *session.LastError != "codex-acp: executable file not found" {
		t.Fatalf("last error = %#v, want runtime failure detail", session.LastError)
	}
}

func TestServiceGetDoesNotDiscoverComposerSkills(t *testing.T) {
	tempDir := t.TempDir()
	homeDir := filepath.Join(tempDir, "home")
	cwd := filepath.Join(tempDir, "repo")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	writeSkill(t, filepath.Join(cwd, ".codex", "skills", "project-skill", "SKILL.md"), `---
description: Project skill.
---
`)
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:          "session-1",
		Provider:    "codex",
		WorkspaceID: "ws-1",
		Cwd:         cwd,
		Status:      "working",
	}
	service := NewService(runtime)

	session, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
	if _, ok := session.RuntimeContext["skills"]; ok {
		t.Fatalf("runtime context skills = %#v, want not discovered on get", session.RuntimeContext["skills"])
	}
}

func TestServiceSessionNormalizesReasoningRuntimeConfigOptions(t *testing.T) {
	session := serviceSession(RuntimeSession{
		ID:          "session-1",
		Provider:    "claude-code",
		WorkspaceID: "ws-1",
		Status:      "working",
		Settings: &ComposerSettings{
			ReasoningEffort: "low",
		},
		RuntimeContext: map[string]any{
			"configOptions": []any{
				map[string]any{
					"id":           "effort",
					"currentValue": "low",
					"options": []any{
						map[string]any{"name": "Default", "value": "default"},
						map[string]any{"name": "Low", "value": "low"},
						map[string]any{"name": "Medium", "value": "medium"},
						map[string]any{"name": "High", "value": "high"},
						map[string]any{"name": "Max", "value": "max"},
					},
				},
			},
			"reasoningEffort": "low",
		},
	}, true)

	configOptions, ok := session.RuntimeContext["configOptions"].([]any)
	if !ok || len(configOptions) != 1 {
		t.Fatalf("configOptions = %#v", session.RuntimeContext["configOptions"])
	}
	option, ok := configOptions[0].(map[string]any)
	if !ok {
		t.Fatalf("option = %#v", configOptions[0])
	}
	if option["currentValue"] != "low" {
		t.Fatalf("currentValue = %#v, want low", option["currentValue"])
	}
	options, ok := option["options"].([]map[string]string)
	if !ok {
		t.Fatalf("options = %#v", option["options"])
	}
	values := make([]string, 0, len(options))
	for _, entry := range options {
		values = append(values, entry["value"])
	}
	if strings.Join(values, ",") != "low,medium,high,xhigh" {
		t.Fatalf("values = %#v, want [low medium high xhigh]", values)
	}
}

func TestActivityProjectionMapsLifecycleAndPhaseToServiceStatus(t *testing.T) {
	tests := []struct {
		name    string
		session agentactivitybiz.Session
		want    string
	}{
		{
			name:    "active working phase",
			session: agentactivitybiz.Session{Status: "active", CurrentPhase: "working"},
			want:    "working",
		},
		{
			name:    "active waiting input phase",
			session: agentactivitybiz.Session{Status: "active", CurrentPhase: "waiting_input"},
			want:    "waiting",
		},
		{
			name:    "completed lifecycle wins",
			session: agentactivitybiz.Session{Status: "completed", CurrentPhase: "working"},
			want:    "completed",
		},
		{
			name:    "failed lifecycle wins",
			session: agentactivitybiz.Session{Status: "failed", CurrentPhase: "idle"},
			want:    "failed",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := agentActivitySessionStatus(tt.session); got != tt.want {
				t.Fatalf("agentActivitySessionStatus() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestActivityProjectionPublishesSessionUpdateForUnappliedStatePatch(t *testing.T) {
	repo := &activityProjectionRepoStub{
		stateResult: agentactivitybiz.StateReportResult{
			Accepted:        true,
			StateApplied:    false,
			LastEventUnixMS: 200,
			Session: agentactivitybiz.Session{
				ID:              "session-1",
				WorkspaceID:     "ws-1",
				Status:          "completed",
				CurrentPhase:    "idle",
				LastEventUnixMS: 200,
			},
		},
	}
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)

	reply, err := projection.ReportSessionState(context.Background(), agentsessionstore.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			LifecycleStatus:  "active",
			CurrentPhase:     "working",
			OccurredAtUnixMS: 150,
		},
	})
	if err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	if !reply.Accepted || reply.StateApplied {
		t.Fatalf("reply = %#v, want accepted unapplied state", reply)
	}
	if len(publisher.events) != 1 {
		t.Fatalf("published events = %d, want 1", len(publisher.events))
	}
	event := publisher.events[0]
	if event.eventType != "session_update" {
		t.Fatalf("published event type = %q, want session_update", event.eventType)
	}
	if got := event.payload["eventType"]; got != "session_update" {
		t.Fatalf("payload eventType = %#v, want session_update", got)
	}
	if got := event.payload["lastEventUnixMs"]; got != int64(200) {
		t.Fatalf("payload lastEventUnixMs = %#v, want 200", got)
	}
	if _, ok := event.payload["lifecycleStatus"]; ok {
		t.Fatalf("payload contains stale lifecycleStatus: %#v", event.payload)
	}
}

func TestActivityProjectionUsesRuntimeContextTitleFallback(t *testing.T) {
	repo := &activityProjectionRepoStub{
		stateResult: agentactivitybiz.StateReportResult{
			Accepted:        true,
			StateApplied:    true,
			LastEventUnixMS: 200,
		},
	}
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)

	_, err := projection.ReportSessionState(context.Background(), agentsessionstore.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			RuntimeContext: map[string]any{
				"title": "Automation Review",
			},
			LifecycleStatus:  "failed",
			CurrentPhase:     "failed",
			OccurredAtUnixMS: 150,
		},
	})
	if err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	if got := repo.stateInput.Title; got != "Automation Review" {
		t.Fatalf("reported title = %q, want runtime context title", got)
	}
	if len(publisher.events) != 1 {
		t.Fatalf("published events = %d, want 1", len(publisher.events))
	}
	if got := publisher.events[0].payload["title"]; got != "Automation Review" {
		t.Fatalf("published title = %#v, want runtime context title", got)
	}
}

func TestActivityProjectionReportsFailedRuntimeNodeResult(t *testing.T) {
	repo := &activityProjectionRepoStub{
		stateResult: agentactivitybiz.StateReportResult{
			Accepted:        true,
			StateApplied:    true,
			LastEventUnixMS: 200,
		},
	}
	reporter := &recordingAgentAnalyticsReporter{}
	projection := NewActivityProjection(repo)
	projection.SetAnalyticsReporter(reporter)

	_, err := projection.ReportSessionState(context.Background(), agentsessionstore.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Source: agentsessionstore.EventSource{
			Provider: "codex",
		},
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			LifecycleStatus: "failed",
			LastError:       "network connection disconnected",
		},
	})
	if err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	if len(reporter.events) != 1 {
		t.Fatalf("analytics events = %d, want 1", len(reporter.events))
	}
	event := reporter.events[0]
	if event.Name != "agent.node_result" {
		t.Fatalf("event name = %q, want agent.node_result", event.Name)
	}
	for key, want := range map[string]any{
		"agent_session_id": "session-1",
		"flow":             "runtime_activity",
		"node":             "runtime_exec",
		"error_code":       "agent_runtime_network_disconnected",
		"error_message":    "network connection disconnected",
		"node_name":        "runtime_exec",
		"provider":         "codex",
		"status":           "failure",
		"success":          false,
	} {
		if got := event.Params[key]; got != want {
			t.Fatalf("params[%q] = %#v, want %#v in %#v", key, got, want, event.Params)
		}
	}
}

func TestActivityProjectionSkipsFailedRuntimeNodeResultWhenStateNotApplied(t *testing.T) {
	repo := &activityProjectionRepoStub{
		stateResult: agentactivitybiz.StateReportResult{
			Accepted:        true,
			StateApplied:    false,
			LastEventUnixMS: 200,
		},
	}
	reporter := &recordingAgentAnalyticsReporter{}
	projection := NewActivityProjection(repo)
	projection.SetAnalyticsReporter(reporter)

	_, err := projection.ReportSessionState(context.Background(), agentsessionstore.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Source: agentsessionstore.EventSource{
			Provider: "codex",
		},
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			LifecycleStatus:  "failed",
			LastError:        "network connection disconnected",
			OccurredAtUnixMS: 150,
		},
	})
	if err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	if len(reporter.events) != 0 {
		t.Fatalf("analytics events = %d, want 0: %#v", len(reporter.events), reporter.events)
	}
}

func TestActivityProjectionPublishesCanonicalSessionIDForMessageUpdates(t *testing.T) {
	repo := &activityProjectionRepoStub{
		messageResult: agentactivitybiz.MessageReportResult{
			AcceptedCount: 1,
			LatestVersion: 1,
			Messages: []agentactivitybiz.Message{{
				AgentSessionID: "session-1",
				MessageID:      "message-1",
				Version:        1,
				Role:           "assistant",
				Kind:           "text",
				Status:         "completed",
				Payload:        map[string]any{"text": "hello"},
			}},
		},
	}
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)

	reply, err := projection.ReportSessionMessages(context.Background(), agentsessionstore.ReportSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "provider-session-1",
		SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Source: agentsessionstore.EventSource{
			Provider:          "codex",
			ProviderSessionID: "provider-session-1",
		},
		Updates: []agentsessionstore.WorkspaceAgentSessionMessageUpdate{{
			MessageID: "message-1",
			Role:      "assistant",
			Kind:      "text",
			Status:    "completed",
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
	if reply.AcceptedCount != 1 {
		t.Fatalf("reply = %#v, want accepted message", reply)
	}
	if repo.messageInput.Provider != "codex" {
		t.Fatalf("repo message provider = %q, want codex", repo.messageInput.Provider)
	}
	if len(publisher.events) != 1 {
		t.Fatalf("published events = %d, want 1", len(publisher.events))
	}
	event := publisher.events[0]
	if event.agentSessionID != "session-1" {
		t.Fatalf("published agentSessionID = %q, want session-1", event.agentSessionID)
	}
	if event.payload["agentSessionId"] != "session-1" {
		t.Fatalf("payload agentSessionId = %#v, want session-1", event.payload["agentSessionId"])
	}
}

func TestActivityProjectionPublishesDeletedEventsForClearedSessions(t *testing.T) {
	repo := &activityProjectionRepoStub{
		clearResult: agentactivitybiz.ClearSessionsResult{
			RemovedMessages:   5,
			RemovedSessions:   2,
			RemovedSessionIDs: []string{"session-1", "session-2"},
		},
	}
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)

	result, err := projection.ClearSessions(context.Background(), " ws-1 ")
	if err != nil {
		t.Fatalf("ClearSessions() error = %v", err)
	}
	if result.RemovedSessions != 2 || result.RemovedMessages != 5 {
		t.Fatalf("ClearSessions() = %#v, want clear result", result)
	}
	if len(publisher.events) != 2 {
		t.Fatalf("published events = %d, want 2", len(publisher.events))
	}
	for _, event := range publisher.events {
		if event.workspaceID != "ws-1" || event.eventType != "session_deleted" {
			t.Fatalf("published event = %#v, want workspace session_deleted", event)
		}
		if !slices.Contains([]string{"session-1", "session-2"}, event.agentSessionID) {
			t.Fatalf("published agentSessionID = %q, want cleared session id", event.agentSessionID)
		}
		if event.payload["agentSessionId"] != event.agentSessionID {
			t.Fatalf("payload agentSessionId = %#v, want %q", event.payload["agentSessionId"], event.agentSessionID)
		}
	}
}

func TestStaleResumeMessageUpdatesFailOpenToolCallsForLatestTurn(t *testing.T) {
	updates := staleResumeMessageUpdates([]SessionMessage{
		{
			MessageID: "approval-2",
			TurnID:    "turn-2",
			Role:      "assistant",
			Kind:      "tool_call",
			Status:    "waiting_approval",
			Payload: map[string]any{
				"input":  map[string]any{"requestId": "permission-2"},
				"status": "waiting_approval",
			},
		},
		{
			MessageID: "approval-1",
			TurnID:    "turn-1",
			Role:      "assistant",
			Kind:      "tool_call",
			Status:    "waiting_approval",
			Payload:   map[string]any{"status": "waiting_approval"},
		},
	}, 1234)

	if len(updates) != 1 {
		t.Fatalf("updates = %#v, want latest turn open tool call", updates)
	}
	update := updates[0]
	if update.MessageID != "approval-2" || update.TurnID != "turn-2" || update.Status != "failed" {
		t.Fatalf("update = %#v, want failed latest approval", update)
	}
	if update.CompletedAtUnixMS != 1234 {
		t.Fatalf("completed at = %d, want 1234", update.CompletedAtUnixMS)
	}
	errorPayload, ok := update.Payload["error"].(map[string]any)
	if !ok || errorPayload["requestId"] != "permission-2" {
		t.Fatalf("error payload = %#v, want permission request id", update.Payload["error"])
	}
}

func TestHasStaleResumeOpenToolCall(t *testing.T) {
	if hasStaleResumeOpenToolCall([]SessionMessage{{
		MessageID: "text-1",
		TurnID:    "turn-1",
		Kind:      "text",
		Status:    "waiting_approval",
	}}) {
		t.Fatal("text message reported as open tool call")
	}
	if hasStaleResumeOpenToolCall([]SessionMessage{{
		MessageID: "approval-1",
		TurnID:    "turn-1",
		Kind:      "tool_call",
		Status:    "completed",
	}}) {
		t.Fatal("completed tool call reported as open")
	}
	if !hasStaleResumeOpenToolCall([]SessionMessage{{
		MessageID: "approval-2",
		TurnID:    "turn-2",
		Kind:      "tool_call",
		Status:    "waiting_approval",
	}}) {
		t.Fatal("waiting approval tool call was not reported as open")
	}
}

func TestServiceListsSessionMessages(t *testing.T) {
	service := NewService(newFakeRuntime())
	lastLimit := 0
	lastTurnID := ""
	service.MessageReader = fakeMessageReader{
		lastLimit:  &lastLimit,
		lastTurnID: &lastTurnID,
		page: SessionMessagesPage{
			AgentSessionID: "session-1",
			Messages: []SessionMessage{
				{
					AgentSessionID: "session-1",
					MessageID:      "msg-1",
					Payload:        map[string]any{"content": "done"},
					Version:        3,
				},
			},
			LatestVersion: 3,
			HasMore:       false,
		},
	}

	page, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"session-1",
		ListMessagesInput{TurnID: "turn-1", AfterVersion: 1, Limit: 20},
	)
	if err != nil {
		t.Fatalf("ListMessages returned error: %v", err)
	}
	if page.AgentSessionID != "session-1" {
		t.Fatalf("agent session id = %q, want session-1", page.AgentSessionID)
	}
	if len(page.Messages) != 1 {
		t.Fatalf("len(page.Messages) = %d, want 1", len(page.Messages))
	}
	if lastTurnID != "turn-1" {
		t.Fatalf("turn id = %q, want turn-1", lastTurnID)
	}
	page.Messages[0].Payload["content"] = "mutated"
	nextPage, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"session-1",
		ListMessagesInput{},
	)
	if err != nil {
		t.Fatalf("ListMessages second read returned error: %v", err)
	}
	if got := nextPage.Messages[0].Payload["content"]; got != "done" {
		t.Fatalf("payload content = %#v, want done", got)
	}
	if lastLimit != defaultListMessagesLimit {
		t.Fatalf("default limit = %d, want %d", lastLimit, defaultListMessagesLimit)
	}
}

func TestServiceListMessagesReturnsEmptyPageForLiveSessionWithoutProjection(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:live-session"] = RuntimeSession{
		ID:          "live-session",
		WorkspaceID: "ws-1",
		Provider:    "codex",
	}
	service := NewService(runtime)

	page, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"live-session",
		ListMessagesInput{AfterVersion: 7, Limit: 20},
	)
	if err != nil {
		t.Fatalf("ListMessages returned error: %v", err)
	}
	if page.AgentSessionID != "live-session" {
		t.Fatalf("agent session id = %q, want live-session", page.AgentSessionID)
	}
	if len(page.Messages) != 0 || page.LatestVersion != 7 || page.HasMore {
		t.Fatalf("page = %#v, want empty page preserving after version", page)
	}
}

func TestServiceListMessagesReturnsEmptyPageForPersistedSessionWithoutProjectionMessages(t *testing.T) {
	service := NewService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:persisted-session": {
				ID:          "persisted-session",
				WorkspaceID: "ws-1",
				Provider:    "codex",
			},
		},
	}
	service.MessageReader = fakeMessageReader{}

	page, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"persisted-session",
		ListMessagesInput{Order: agentactivitybiz.MessageOrderDesc, Limit: 20},
	)
	if err != nil {
		t.Fatalf("ListMessages returned error: %v", err)
	}
	if page.AgentSessionID != "persisted-session" {
		t.Fatalf("agent session id = %q, want persisted-session", page.AgentSessionID)
	}
	if len(page.Messages) != 0 || page.LatestVersion != 0 || page.HasMore {
		t.Fatalf("page = %#v, want empty desc page", page)
	}
}

func TestServiceListMessagesReturnsNotFoundForUnknownSession(t *testing.T) {
	service := NewService(newFakeRuntime())
	service.MessageReader = fakeMessageReader{}

	if _, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"missing-session",
		ListMessagesInput{},
	); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("ListMessages error = %v, want ErrSessionNotFound", err)
	}
}

func TestServiceFallsBackToPersistedSessions(t *testing.T) {
	service := NewService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Status:            "working",
				Title:             "Persisted session",
				CreatedAtUnixMS:   1000,
				UpdatedAtUnixMS:   2000,
			},
		},
	}

	list, err := service.List(context.Background(), "ws-1")
	if err != nil {
		t.Fatalf("List returned error: %v", err)
	}
	if len(list) != 1 || list[0].ID != "session-1" {
		t.Fatalf("persisted list = %#v", list)
	}

	got, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
	if got.ID != "session-1" {
		t.Fatalf("persisted get id = %q", got.ID)
	}
	if !got.Resumable {
		t.Fatal("persisted session resumable = false, want true")
	}
}

func TestServiceListFilteredMatchesSearchVisibilityLimitAndUpdatedOrder(t *testing.T) {
	runtime := newFakeRuntime()
	olderUpdatedAt := time.UnixMilli(2000)
	newerUpdatedAt := time.UnixMilli(4000)
	hiddenUpdatedAt := time.UnixMilli(5000)
	runtime.sessions["ws-1:session-hidden"] = RuntimeSession{
		ID:              "session-hidden",
		WorkspaceID:     "ws-1",
		Provider:        "codex",
		Cwd:             "/workspace/hidden",
		Status:          "completed",
		Visible:         false,
		Title:           "Hidden",
		CreatedAtUnixMS: time.UnixMilli(1000).UnixMilli(),
		UpdatedAtUnixMS: hiddenUpdatedAt.UnixMilli(),
	}
	runtime.sessions["ws-1:session-older"] = RuntimeSession{
		ID:              "session-older",
		WorkspaceID:     "ws-1",
		Provider:        "codex",
		Cwd:             "/workspace/older",
		Status:          "completed",
		Visible:         true,
		Title:           "Mention older",
		CreatedAtUnixMS: time.UnixMilli(1000).UnixMilli(),
		UpdatedAtUnixMS: olderUpdatedAt.UnixMilli(),
	}
	runtime.sessions["ws-1:session-newer"] = RuntimeSession{
		ID:              "session-newer",
		WorkspaceID:     "ws-1",
		Provider:        "codex",
		Cwd:             "/workspace/newer",
		Status:          "working",
		Visible:         true,
		Title:           "Mention newer",
		CreatedAtUnixMS: time.UnixMilli(1000).UnixMilli(),
		UpdatedAtUnixMS: newerUpdatedAt.UnixMilli(),
	}

	service := NewService(runtime)
	list, err := service.ListFiltered(context.Background(), "ws-1", ListSessionsInput{
		SearchQuery: "mention",
		Limit:       1,
	})
	if err != nil {
		t.Fatalf("ListFiltered returned error: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("len(list) = %d, want 1", len(list))
	}
	if list[0].ID != "session-newer" {
		t.Fatalf("list[0].ID = %q, want session-newer", list[0].ID)
	}
}

func TestServiceListSessionSectionsUsesCurrentProjectsAndConversations(t *testing.T) {
	reader := &fakeSectionReader{
		pages: map[string]agentactivitybiz.SessionSectionPage{
			"project:/workspace/project": {
				SectionKey: "project:/workspace/project",
				Sessions: []agentactivitybiz.Session{{
					ID:              "project-session",
					WorkspaceID:     "ws-1",
					Provider:        "codex",
					Cwd:             "/workspace/project",
					Status:          "completed",
					CreatedAtUnixMS: 1000,
					UpdatedAtUnixMS: 5000,
				}},
				HasMore:    true,
				NextCursor: "5000|project-session",
			},
			"conversations": {
				SectionKey: "conversations",
				Sessions: []agentactivitybiz.Session{{
					ID:              "chat-session",
					WorkspaceID:     "ws-1",
					Provider:        "codex",
					Cwd:             "/scratch/session",
					Status:          "completed",
					CreatedAtUnixMS: 1000,
					UpdatedAtUnixMS: 4000,
				}},
			},
		},
	}
	service := NewService(newFakeRuntime())
	service.SessionReader = reader
	service.UserProjectReader = fakeUserProjectReader{projects: []userprojectbiz.Project{{
		ID:    "project-1",
		Path:  "/workspace/project",
		Label: "Project",
	}}}

	page, err := service.ListSessionSections(context.Background(), "ws-1", ListSessionSectionsInput{
		LimitPerSection: 5,
		AgentTargetID:   "claude-target",
	})
	if err != nil {
		t.Fatalf("ListSessionSections returned error: %v", err)
	}
	if len(page.Sections) != 2 {
		t.Fatalf("sections = %d, want 2", len(page.Sections))
	}
	if page.Sections[0].Kind != "project" || page.Sections[0].SectionKey != "project:/workspace/project" {
		t.Fatalf("project section = %#v", page.Sections[0])
	}
	if got, want := sessionIDs(page.Sections[0].Sessions), []string{"project-session"}; !slices.Equal(got, want) {
		t.Fatalf("project sessions = %#v, want %#v", got, want)
	}
	if !page.Sections[0].HasMore || page.Sections[0].NextCursor != "5000|project-session" {
		t.Fatalf("project page state = hasMore %v cursor %q", page.Sections[0].HasMore, page.Sections[0].NextCursor)
	}
	if page.Sections[1].Kind != "conversations" || page.Sections[1].SectionKey != "conversations" {
		t.Fatalf("conversations section = %#v", page.Sections[1])
	}
	if reader.lastInput.AgentTargetID != "claude-target" {
		t.Fatalf("reader agentTargetID = %q, want claude-target", reader.lastInput.AgentTargetID)
	}
}

func TestServiceListSessionSectionPageForwardsStableCursor(t *testing.T) {
	reader := &fakeSectionReader{}
	service := NewService(newFakeRuntime())
	service.SessionReader = reader
	service.UserProjectReader = fakeUserProjectReader{projects: []userprojectbiz.Project{{
		ID:         "project-1",
		Path:       "/workspace/project",
		Label:      "Project",
		SectionKey: "project:/workspace/project",
	}}}

	section, err := service.ListSessionSectionPage(context.Background(), "ws-1", ListSessionSectionPageInput{
		SectionKey:    "project:/workspace/project",
		Cursor:        "4000|middle",
		Limit:         2,
		AgentTargetID: "claude-target",
	})
	if err != nil {
		t.Fatalf("ListSessionSectionPage returned error: %v", err)
	}
	if section.Kind != "project" || section.SectionKey != "project:/workspace/project" {
		t.Fatalf("section = %#v", section)
	}
	if reader.lastInput.SectionKey != "project:/workspace/project" ||
		reader.lastInput.CursorUpdatedAtMS != 4000 ||
		reader.lastInput.CursorSessionID != "middle" ||
		reader.lastInput.Limit != 2 ||
		reader.lastInput.AgentTargetID != "claude-target" {
		t.Fatalf("reader input = %#v", reader.lastInput)
	}
}

func sessionIDs(sessions []Session) []string {
	ids := make([]string, 0, len(sessions))
	for _, session := range sessions {
		ids = append(ids, session.ID)
	}
	return ids
}

func TestServiceListsActivePeersFromCanonicalSessionStatus(t *testing.T) {
	service := NewService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:              "session-1",
				WorkspaceID:     "ws-1",
				Provider:        "codex",
				Status:          "working",
				Title:           "Active work",
				CreatedAtUnixMS: 1000,
				UpdatedAtUnixMS: 2000,
			},
			"ws-1:session-2": {
				ID:              "session-2",
				WorkspaceID:     "ws-1",
				Provider:        "claude",
				Status:          "completed",
				Title:           "Done",
				CreatedAtUnixMS: 2000,
				UpdatedAtUnixMS: 3000,
			},
		},
	}

	peers, err := service.ListActivePeers(context.Background(), "ws-1")
	if err != nil {
		t.Fatalf("ListActivePeers returned error: %v", err)
	}
	if len(peers.Agents) != 1 || peers.Agents[0].Session.ID != "session-1" {
		t.Fatalf("peers = %#v", peers)
	}
	if peers.Agents[0].SelfRelation != "unknown" {
		t.Fatalf("self relation = %q", peers.Agents[0].SelfRelation)
	}
	if peers.SelfKnown || !peers.MayIncludeSelf || peers.Warning != "SELF_IDENTITY_UNAVAILABLE" {
		t.Fatalf("peer identity metadata = %#v", peers)
	}
}

func TestServiceDeletesPersistedSession(t *testing.T) {
	service := NewService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:          "session-1",
				WorkspaceID: "ws-1",
				Provider:    "codex",
			},
		},
	}

	removed, err := service.Delete(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Delete returned error: %v", err)
	}
	if !removed {
		t.Fatal("Delete removed = false, want true")
	}
	if _, err := service.Get(context.Background(), "ws-1", "session-1"); err != ErrSessionNotFound {
		t.Fatalf("Get after delete error = %v, want %v", err, ErrSessionNotFound)
	}
}

func TestServiceDeleteClosesRuntimeSession(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}

	removed, err := service.Delete(context.Background(), "ws-1", session.ID)
	if err != nil {
		t.Fatalf("Delete returned error: %v", err)
	}
	if !removed {
		t.Fatal("Delete removed = false, want true")
	}
	if len(runtime.closeCalls) != 1 || runtime.closeCalls[0].AgentSessionID != session.ID {
		t.Fatalf("close calls = %#v", runtime.closeCalls)
	}
}

func TestServiceClearClosesRuntimeAndClearsPersistedSessions(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
	}
	runtime.sessions["ws-2:session-2"] = RuntimeSession{
		ID:          "session-2",
		WorkspaceID: "ws-2",
		Provider:    "codex",
	}
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {ID: "session-1", WorkspaceID: "ws-1"},
			"ws-2:session-2": {ID: "session-2", WorkspaceID: "ws-2"},
		},
	}

	result, err := service.Clear(context.Background(), "ws-1")
	if err != nil {
		t.Fatalf("Clear returned error: %v", err)
	}
	if result.RemovedSessions != 1 {
		t.Fatalf("Clear removed sessions = %d, want 1", result.RemovedSessions)
	}
	if len(runtime.closeCalls) != 1 || runtime.closeCalls[0].AgentSessionID != "session-1" {
		t.Fatalf("close calls = %#v", runtime.closeCalls)
	}
	if _, ok := runtime.Session("ws-2", "session-2"); !ok {
		t.Fatal("runtime session for another workspace was closed")
	}
}

func TestServiceResumesPersistedSessionBeforeInput(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Status:            "working",
				Title:             "Persisted session",
				CreatedAtUnixMS:   1000,
				UpdatedAtUnixMS:   2000,
			},
		},
	}

	result, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{Content: TextPromptContent("hello")})
	if err != nil {
		t.Fatalf("SendInput returned error: %v", err)
	}
	session := result.Session
	if session.ID != "session-1" {
		t.Fatalf("session id = %q", session.ID)
	}
	if len(runtime.resumeCalls) != 1 {
		t.Fatalf("resume calls = %d, want 1", len(runtime.resumeCalls))
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
	}
}

func TestServiceSendInputContinuesImportedSession(t *testing.T) {
	// Imported conversations must continue in place: sending resumes (or, when
	// the provider session is missing locally, recreates) the provider session
	// rather than rejecting with ErrSessionNotFound and forcing a new chat.
	runtime := newFakeRuntime()
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-imported": {
				ID:                "session-imported",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "imported-thread-1",
				Origin:            WorkspaceAgentSessionOriginImported,
				Status:            "completed",
				Title:             "Imported chat",
				CreatedAtUnixMS:   1000,
				UpdatedAtUnixMS:   2000,
			},
		},
	}

	if _, err := service.SendInput(context.Background(), "ws-1", "session-imported", SendInput{Content: TextPromptContent("continue")}); err != nil {
		t.Fatalf("SendInput imported error = %v, want continue in place", err)
	}
	if len(runtime.resumeCalls) != 1 {
		t.Fatalf("resume calls = %d, want 1", len(runtime.resumeCalls))
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
	}
}

func TestServiceSendInputReturnsRuntimeExecStatusOverStalePersistedStatus(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Status:            "completed",
				Title:             "Persisted session",
				CreatedAtUnixMS:   1000,
				UpdatedAtUnixMS:   2000,
			},
		},
	}

	result, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{Content: TextPromptContent("hello")})
	if err != nil {
		t.Fatalf("SendInput returned error: %v", err)
	}
	session := result.Session
	if session.Status != "running" {
		t.Fatalf("session status = %q, want running", session.Status)
	}
	if session.EndedAt != nil {
		t.Fatalf("endedAt = %#v, want nil for accepted input", session.EndedAt)
	}
}

func TestServiceSendInputReportsNodeResults(t *testing.T) {
	runtime := newFakeRuntime()
	reporter := &recordingAgentAnalyticsReporter{}
	service := NewService(runtime)
	service.AnalyticsReporter = reporter
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Status:            "waiting",
				Title:             "Persisted session",
				CreatedAtUnixMS:   1000,
				UpdatedAtUnixMS:   2000,
			},
		},
	}

	if _, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{Content: TextPromptContent("hello")}); err != nil {
		t.Fatalf("SendInput returned error: %v", err)
	}

	assertAgentNodeSequence(t, reporter.events, []string{
		"runtime_session_ready",
		"content_normalized",
		"prompt_validated",
		"prompt_prepared",
		"runtime_exec",
		"session_refreshed",
	})
	for _, event := range reporter.events {
		if event.Name != "agent.node_result" {
			continue
		}
		if got := event.Params["flow"]; got != "message_send" {
			t.Fatalf("flow = %#v, want message_send in %#v", got, event.Params)
		}
		if got := event.Params["status"]; got != "success" {
			t.Fatalf("status = %#v, want success in %#v", got, event.Params)
		}
		if got := event.Params["error_code"]; got != "agent_error_none" {
			t.Fatalf("error_code = %#v, want agent_error_none in %#v", got, event.Params)
		}
		if got := event.Params["error_message"]; got != "" {
			t.Fatalf("error_message = %#v, want empty in %#v", got, event.Params)
		}
		if got := event.Params["node_name"]; got != event.Params["node"] {
			t.Fatalf("node_name = %#v, want node alias %#v", got, event.Params["node"])
		}
	}
}

func TestServiceSendInputReportsRuntimeExecFailure(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.execErr = errors.New("network connection disconnected")
	reporter := &recordingAgentAnalyticsReporter{}
	service := NewService(runtime)
	service.AnalyticsReporter = reporter
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Status:            "waiting",
				Title:             "Persisted session",
				CreatedAtUnixMS:   1000,
				UpdatedAtUnixMS:   2000,
			},
		},
	}

	if _, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{Content: TextPromptContent("hello")}); err == nil {
		t.Fatal("SendInput returned nil error, want runtime exec error")
	}

	var failure reporterservice.Event
	for _, event := range reporter.events {
		if event.Name == "agent.node_result" && event.Params["node"] == "runtime_exec" {
			failure = event
			break
		}
	}
	if failure.Name == "" {
		t.Fatalf("runtime_exec failure event not found in %#v", reporter.events)
	}
	for key, want := range map[string]any{
		"flow":          "message_send",
		"status":        "failure",
		"error_code":    "agent_runtime_network_disconnected",
		"error_message": "network connection disconnected",
		"success":       false,
	} {
		if got := failure.Params[key]; got != want {
			t.Fatalf("params[%q] = %#v, want %#v in %#v", key, got, want, failure.Params)
		}
	}
}

func TestServiceReconcilesStalePersistedTurnBeforeSubmittingInteractive(t *testing.T) {
	runtime := newFakeRuntime()
	reconciled := make([]PersistedSession, 0)
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		reconciled: &reconciled,
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Cwd:               "/workspace",
				Status:            "waiting",
				Title:             "Waiting",
			},
		},
	}

	session, err := service.SubmitInteractive(
		context.Background(),
		"ws-1",
		"session-1",
		"permission-1",
		SubmitInteractiveInput{OptionID: stringRef("approve")},
	)
	if err != nil {
		t.Fatalf("SubmitInteractive returned error: %v", err)
	}
	if session.ID != "session-1" {
		t.Fatalf("session ID = %q, want session-1", session.ID)
	}
	if len(reconciled) != 1 || reconciled[0].ID != "session-1" {
		t.Fatalf("reconciled = %#v, want stale persisted session", reconciled)
	}
	if len(runtime.submitInteractiveCalls) != 0 {
		t.Fatalf("submit interactive calls = %#v, want skipped stale live request", runtime.submitInteractiveCalls)
	}
}

func TestServiceReconcilesOpenToolCallBeforeSubmittingInteractive(t *testing.T) {
	runtime := newFakeRuntime()
	reconciled := make([]PersistedSession, 0)
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		reconciled: &reconciled,
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Cwd:               "/workspace",
				Status:            "created",
				Title:             "Created",
			},
		},
	}
	service.MessageReader = fakeMessageReader{
		page: SessionMessagesPage{
			AgentSessionID: "session-1",
			Messages: []SessionMessage{{
				MessageID: "approval-1",
				TurnID:    "turn-1",
				Role:      "assistant",
				Kind:      "tool_call",
				Status:    "waiting_approval",
				Payload: map[string]any{
					"input":  map[string]any{"requestId": "permission-1"},
					"status": "waiting_approval",
				},
			}},
		},
	}

	session, err := service.SubmitInteractive(
		context.Background(),
		"ws-1",
		"session-1",
		"permission-1",
		SubmitInteractiveInput{OptionID: stringRef("approve")},
	)
	if err != nil {
		t.Fatalf("SubmitInteractive returned error: %v", err)
	}
	if session.ID != "session-1" {
		t.Fatalf("session ID = %q, want session-1", session.ID)
	}
	if len(reconciled) != 1 || reconciled[0].ID != "session-1" {
		t.Fatalf("reconciled = %#v, want open tool call session", reconciled)
	}
	if len(runtime.submitInteractiveCalls) != 0 {
		t.Fatalf("submit interactive calls = %#v, want skipped stale live request", runtime.submitInteractiveCalls)
	}
}

func TestServiceReconcilesGhostOpenApprovalWhileBackgroundAgentsAreLive(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "ready",
		RuntimeContext: map[string]any{
			"backgroundAgents": map[string]any{
				"count": float64(1),
				"items": []any{
					map[string]any{
						"agentId":         "agent-1",
						"parentToolUseId": "toolu-agent",
						"status":          "running",
					},
				},
			},
		},
	}
	reconciled := make([]PersistedSession, 0)
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		reconciled: &reconciled,
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:           "session-1",
				WorkspaceID:  "ws-1",
				Provider:     "claude-code",
				Status:       "active",
				CurrentPhase: "idle",
			},
		},
	}
	service.MessageReader = fakeMessageReader{
		page: SessionMessagesPage{
			AgentSessionID: "session-1",
			Messages: []SessionMessage{{
				MessageID: "approval-1",
				TurnID:    "turn-1",
				Role:      "assistant",
				Kind:      "tool_call",
				Status:    "waiting_approval",
				Payload: map[string]any{
					"input":  map[string]any{"requestId": "permission-1"},
					"status": "waiting_approval",
				},
			}},
		},
	}

	session, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
	if session.ID != "session-1" {
		t.Fatalf("session ID = %q, want session-1", session.ID)
	}
	if len(reconciled) != 1 || reconciled[0].ID != "session-1" {
		t.Fatalf("reconciled = %#v, want ghost open approval cleared", reconciled)
	}
}

func TestServiceSubmitInteractiveReconcilesStaleLiveRequestError(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.submitInteractiveErr = errors.New(`interactive request "permission-1" is no longer live`)
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "ready",
	}
	reconciled := make([]PersistedSession, 0)
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		reconciled: &reconciled,
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:          "session-1",
				WorkspaceID: "ws-1",
				Provider:    "claude-code",
				Status:      "active",
			},
		},
	}
	service.MessageReader = fakeMessageReader{
		page: SessionMessagesPage{
			AgentSessionID: "session-1",
			Messages: []SessionMessage{{
				MessageID: "approval-1",
				TurnID:    "turn-1",
				Role:      "assistant",
				Kind:      "tool_call",
				Status:    "waiting_approval",
				Payload: map[string]any{
					"input":  map[string]any{"requestId": "permission-1"},
					"status": "waiting_approval",
				},
			}},
		},
	}

	session, err := service.SubmitInteractive(
		context.Background(),
		"ws-1",
		"session-1",
		"permission-1",
		SubmitInteractiveInput{OptionID: stringRef("allow")},
	)
	if err != nil {
		t.Fatalf("SubmitInteractive returned error: %v", err)
	}
	if session.ID != "session-1" {
		t.Fatalf("session ID = %q, want session-1", session.ID)
	}
	if len(reconciled) != 1 || reconciled[0].ID != "session-1" {
		t.Fatalf("reconciled = %#v, want stale approval cleared after no-longer-live", reconciled)
	}
}

func TestServiceDoesNotReconcileStalePersistedTurnWhenRuntimeSessionIsWorking(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:                "session-1",
		WorkspaceID:       "ws-1",
		Provider:          "codex",
		ProviderSessionID: "provider-session-1",
		Status:            "working",
	}
	reconciled := make([]PersistedSession, 0)
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		reconciled: &reconciled,
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Status:            "waiting",
			},
		},
	}

	if _, err := service.SubmitInteractive(
		context.Background(),
		"ws-1",
		"session-1",
		"permission-1",
		SubmitInteractiveInput{OptionID: stringRef("approve")},
	); err != nil {
		t.Fatalf("SubmitInteractive returned error: %v", err)
	}
	if len(reconciled) != 0 {
		t.Fatalf("reconciled = %#v, want live working runtime session left alone", reconciled)
	}
	if len(runtime.submitInteractiveCalls) != 1 {
		t.Fatalf("submit interactive calls = %#v, want live runtime interactive response", runtime.submitInteractiveCalls)
	}
}

func TestServiceGetReconcilesStalePersistedTurn(t *testing.T) {
	runtime := newFakeRuntime()
	reconciled := make([]PersistedSession, 0)
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		reconciled: &reconciled,
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Status:            "waiting",
			},
		},
	}

	session, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
	if len(reconciled) != 1 {
		t.Fatalf("reconciled = %#v, want stale persisted session reconciled on get", reconciled)
	}
	if session.Status == "waiting" {
		t.Fatalf("session status = %q, want stale waiting cleared", session.Status)
	}
}

func TestServiceGetReconcilesRuntimeWaitingWithoutLivePendingInteractive(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "waiting",
	}
	reconciled := make([]PersistedSession, 0)
	service := NewService(runtime)
	reader := fakeSessionReader{
		reconciled: &reconciled,
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:           "session-1",
				WorkspaceID:  "ws-1",
				Provider:     "claude-code",
				Status:       "active",
				CurrentPhase: "waiting_approval",
			},
		},
	}
	service.SessionReader = reader
	service.MessageReader = fakeMessageReader{
		page: SessionMessagesPage{
			Messages: []SessionMessage{{
				TurnID: "synthetic-turn-1",
				Kind:   "tool_call",
				Status: "waiting_approval",
				Payload: map[string]any{
					"input": map[string]any{
						"requestId": "plan-1",
						"toolName":  "ExitPlanMode",
					},
				},
			}},
		},
	}

	_, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
	if len(reconciled) != 1 {
		t.Fatalf("reconciled = %#v, want stale waiting runtime session reconciled", reconciled)
	}
	persisted := reader.sessions["ws-1:session-1"]
	if persisted.Status == "waiting" || persisted.CurrentPhase == "waiting_approval" {
		t.Fatalf("persisted session = %#v, want stale waiting cleared", persisted)
	}
}

func TestServiceReconcilesStalePersistedTurnBeforeCanceling(t *testing.T) {
	runtime := newFakeRuntime()
	reconciled := make([]PersistedSession, 0)
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		reconciled: &reconciled,
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Status:            "working",
			},
		},
	}

	result, err := service.Cancel(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Cancel returned error: %v", err)
	}
	if result.Canceled || result.Reason != CancelReasonStaleTurnReconciled {
		t.Fatalf("cancel result = %#v, want stale turn reconciled without cancel", result)
	}
	if len(reconciled) != 1 || reconciled[0].ID != "session-1" {
		t.Fatalf("reconciled = %#v, want stale persisted session", reconciled)
	}
	if len(runtime.cancelCalls) != 0 {
		t.Fatalf("cancel calls = %#v, want skipped stale runtime cancel", runtime.cancelCalls)
	}
}

func TestServiceReconcilesPhaseOnlyStalePersistedTurnBeforeCanceling(t *testing.T) {
	runtime := newFakeRuntime()
	reconciled := make([]PersistedSession, 0)
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		reconciled: &reconciled,
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Status:            "created",
				CurrentPhase:      "running",
			},
		},
	}

	result, err := service.Cancel(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Cancel returned error: %v", err)
	}
	if result.Canceled || result.Reason != CancelReasonStaleTurnReconciled {
		t.Fatalf("cancel result = %#v, want phase-only stale turn reconciled without cancel", result)
	}
	if len(reconciled) != 1 || reconciled[0].CurrentPhase != "running" {
		t.Fatalf("reconciled = %#v, want phase-only stale persisted session", reconciled)
	}
	if len(runtime.cancelCalls) != 0 {
		t.Fatalf("cancel calls = %#v, want skipped stale runtime cancel", runtime.cancelCalls)
	}
}

func TestServiceGetDoesNotReconcileLiveRuntimeWaitingApprovalTurn(t *testing.T) {
	runtime := newFakeRuntime()
	activeTurnID := "synthetic-turn-1"
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "created",
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &activeTurnID,
			Phase:        "waiting_approval",
		},
	}
	reconciled := make([]PersistedSession, 0)
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		reconciled: &reconciled,
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:          "session-1",
				WorkspaceID: "ws-1",
				Provider:    "claude-code",
				Status:      "ready",
			},
		},
	}
	service.MessageReader = fakeMessageReader{
		page: SessionMessagesPage{
			Messages: []SessionMessage{{
				TurnID: "synthetic-turn-1",
				Kind:   "tool_call",
				Status: "waiting_approval",
				Payload: map[string]any{
					"input": map[string]any{"toolName": "ExitPlanMode"},
				},
			}},
		},
	}

	session, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
	if session.TurnLifecycle == nil || session.TurnLifecycle.Phase != "waiting_approval" {
		t.Fatalf("turn lifecycle = %#v, want live waiting approval", session.TurnLifecycle)
	}
	if len(reconciled) != 0 {
		t.Fatalf("reconciled = %#v, want no stale reconcile for live runtime turn", reconciled)
	}
}

func TestServiceEnsureRuntimeSessionDoesNotReconcileLiveRuntimeWaitingApprovalTurn(t *testing.T) {
	runtime := newFakeRuntime()
	activeTurnID := "synthetic-turn-1"
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "created",
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &activeTurnID,
			Phase:        "waiting_approval",
		},
	}
	reconciled := make([]PersistedSession, 0)
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		reconciled: &reconciled,
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:          "session-1",
				WorkspaceID: "ws-1",
				Provider:    "claude-code",
				Status:      "ready",
			},
		},
	}
	service.MessageReader = fakeMessageReader{
		page: SessionMessagesPage{
			Messages: []SessionMessage{{
				TurnID: "synthetic-turn-1",
				Kind:   "tool_call",
				Status: "waiting_approval",
				Payload: map[string]any{
					"input": map[string]any{"toolName": "ExitPlanMode"},
				},
			}},
		},
	}

	ensured, err := service.ensureRuntimeSessionResult(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("ensureRuntimeSessionResult returned error: %v", err)
	}
	if ensured.StaleTurnReconciled {
		t.Fatal("stale turn reconciled = true, want false for live waiting approval turn")
	}
	if len(reconciled) != 0 {
		t.Fatalf("reconciled = %#v, want no stale reconcile for live runtime turn", reconciled)
	}
}

func TestServiceGetDoesNotReconcileLiveRuntimePendingInteractive(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "created",
		PendingInteractive: &RuntimeInteractivePrompt{
			Kind:      "exit-plan",
			RequestID: "plan-1",
			ToolName:  "ExitPlanMode",
			Status:    "waiting",
		},
	}
	reconciled := make([]PersistedSession, 0)
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		reconciled: &reconciled,
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:           "session-1",
				WorkspaceID:  "ws-1",
				Provider:     "claude-code",
				Status:       "ready",
				CurrentPhase: "idle",
			},
		},
	}
	service.MessageReader = fakeMessageReader{
		page: SessionMessagesPage{
			Messages: []SessionMessage{{
				TurnID: "synthetic-turn-1",
				Kind:   "tool_call",
				Status: "waiting_approval",
				Payload: map[string]any{
					"input": map[string]any{
						"requestId": "plan-1",
						"toolName":  "ExitPlanMode",
					},
				},
			}},
		},
	}

	session, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
	if session.Status != "created" {
		t.Fatalf("session status = %q, want live runtime status", session.Status)
	}
	if len(reconciled) != 0 {
		t.Fatalf("reconciled = %#v, want no stale reconcile for live pending interactive", reconciled)
	}
}

func TestServiceGetDoesNotReconcileLiveRuntimeBackgroundAgent(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "created",
		RuntimeContext: map[string]any{
			"backgroundAgents": map[string]any{
				"count": 1,
				"items": []any{map[string]any{
					"parentToolUseId": "call-agent-1",
					"status":          "running",
				}},
			},
		},
	}
	reconciled := make([]PersistedSession, 0)
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		reconciled: &reconciled,
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:          "session-1",
				WorkspaceID: "ws-1",
				Provider:    "claude-code",
				Status:      "ready",
			},
		},
	}
	service.MessageReader = fakeMessageReader{
		page: SessionMessagesPage{
			Messages: []SessionMessage{{
				TurnID: "synthetic-turn-1",
				Kind:   "tool_call",
				Status: "streaming",
				Payload: map[string]any{
					"input": map[string]any{"toolName": "Read"},
				},
			}},
		},
	}

	session, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
	if session.RuntimeContext["backgroundAgents"] == nil {
		t.Fatalf("runtime context = %#v, want backgroundAgents preserved", session.RuntimeContext)
	}
	if len(reconciled) != 0 {
		t.Fatalf("reconciled = %#v, want no stale reconcile while background agent is running", reconciled)
	}
}

func TestServiceCancelReportsActiveTurnCanceled(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:              "session-1",
		WorkspaceID:     "ws-1",
		Provider:        "codex",
		Status:          "working",
		CreatedAtUnixMS: 100,
		UpdatedAtUnixMS: 200,
	}
	service := NewService(runtime)

	result, err := service.Cancel(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Cancel returned error: %v", err)
	}
	if !result.Canceled || result.Reason != CancelReasonActiveTurnCanceled {
		t.Fatalf("cancel result = %#v, want active turn canceled", result)
	}
	if result.Session.ID != "session-1" || result.Session.Status != "running" {
		t.Fatalf("session = %#v, want running session-1", result.Session)
	}
}

func TestServiceCancelReportsNoActiveTurn(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.cancelResult = RuntimeCancelResult{AgentSessionID: "session-1", Canceled: false}
	runtime.cancelResultSet = true
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:              "session-1",
		WorkspaceID:     "ws-1",
		Provider:        "codex",
		Status:          "ready",
		CreatedAtUnixMS: 100,
		UpdatedAtUnixMS: 200,
	}
	service := NewService(runtime)

	result, err := service.Cancel(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Cancel returned error: %v", err)
	}
	if result.Canceled || result.Reason != CancelReasonNoActiveTurn {
		t.Fatalf("cancel result = %#v, want no active turn", result)
	}
	if result.Session.ID != "session-1" || result.Session.Status != "created" {
		t.Fatalf("session = %#v, want created session-1", result.Session)
	}
}

func TestServiceResumesPersistedSessionWithPreparedRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	var prepareInput agentsidecarservice.PrepareInput
	service := NewService(runtime)
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
		result: agentsidecarservice.PreparedRuntime{
			Cwd: "/prepared/workdir",
			Env: []string{"CODEX_HOME=/prepared/codex-home"},
		},
	}
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Cwd:               "/persisted/workdir",
				Settings: ComposerSettings{
					Model:            "gpt-5",
					PermissionModeID: "auto",
					ReasoningEffort:  "high",
				},
				Status:          "working",
				Title:           "Persisted session",
				CreatedAtUnixMS: 1000,
				UpdatedAtUnixMS: 2000,
			},
		},
	}

	if _, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{Content: TextPromptContent("hello")}); err != nil {
		t.Fatalf("SendInput returned error: %v", err)
	}
	if prepareInput.WorkspaceID != "ws-1" ||
		prepareInput.AgentSessionID != "session-1" ||
		prepareInput.Provider != "codex" ||
		prepareInput.Cwd != "/persisted/workdir" ||
		prepareInput.Model != "gpt-5" ||
		prepareInput.PermissionModeID != "auto" ||
		prepareInput.ReasoningEffort != "high" {
		t.Fatalf("prepare input = %#v, want persisted session metadata", prepareInput)
	}
	if len(runtime.resumeCalls) != 1 {
		t.Fatalf("resume calls = %d, want 1", len(runtime.resumeCalls))
	}
	resume := runtime.resumeCalls[0]
	if resume.Cwd != "/prepared/workdir" {
		t.Fatalf("resume cwd = %q, want prepared cwd", resume.Cwd)
	}
	if len(resume.Env) != 1 || resume.Env[0] != "CODEX_HOME=/prepared/codex-home" {
		t.Fatalf("resume env = %#v, want prepared env", resume.Env)
	}
	if resume.Settings.Model != "gpt-5" ||
		resume.Settings.PermissionModeID != "auto" ||
		resume.Settings.ReasoningEffort != "high" {
		t.Fatalf("resume settings = %#v, want persisted settings", resume.Settings)
	}
}

func TestServiceResumesPersistedSessionWithoutProviderSessionID(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:              "session-1",
				WorkspaceID:     "ws-1",
				Provider:        "codex",
				Status:          "working",
				Title:           "Persisted session",
				CreatedAtUnixMS: 1000,
				UpdatedAtUnixMS: 2000,
			},
		},
	}

	if _, err := service.SendInput(
		context.Background(),
		"ws-1",
		"session-1",
		SendInput{Content: TextPromptContent("hello")},
	); err != nil {
		t.Fatalf("SendInput returned error: %v", err)
	}
	if len(runtime.resumeCalls) != 1 {
		t.Fatalf("resume calls = %d, want 1", len(runtime.resumeCalls))
	}
	if runtime.resumeCalls[0].ProviderSessionID != "" {
		t.Fatalf("provider session id = %q, want empty", runtime.resumeCalls[0].ProviderSessionID)
	}
}

func TestServiceListMessagesValidatesInputs(t *testing.T) {
	service := NewService(newFakeRuntime())

	if _, err := service.ListMessages(
		context.Background(),
		"",
		"session-1",
		ListMessagesInput{},
	); err != ErrInvalidArgument {
		t.Fatalf("workspace validation error = %v, want %v", err, ErrInvalidArgument)
	}
	if _, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"",
		ListMessagesInput{},
	); err != ErrInvalidArgument {
		t.Fatalf("session validation error = %v, want %v", err, ErrInvalidArgument)
	}
	if _, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"session-1",
		ListMessagesInput{Limit: -1},
	); err != ErrInvalidArgument {
		t.Fatalf("limit validation error = %v, want %v", err, ErrInvalidArgument)
	}
}

type fakeRuntime struct {
	nextID                 int
	cancelCalls            []RuntimeCancelInput
	cancelResult           RuntimeCancelResult
	cancelResultSet        bool
	closeErr               error
	closeCalls             []RuntimeCloseInput
	execErr                error
	execCalls              []RuntimeExecInput
	resumeCalls            []RuntimeResumeInput
	sessions               map[string]RuntimeSession
	submitInteractiveCalls []RuntimeSubmitInteractiveInput
	submitInteractiveErr   error
	startErr               error
	startCalls             []RuntimeStartInput
	startHook              func(RuntimeStartInput, RuntimeSession) RuntimeSession
	closeHook              func(RuntimeCloseInput)
	validateErr            error
	validateCalls          []RuntimeExecInput
}

type fakeAgentTargetStore struct {
	err     error
	targets map[string]agenttargetbiz.Target
}

func (f fakeAgentTargetStore) GetAgentTarget(_ context.Context, id string) (agenttargetbiz.Target, error) {
	if f.err != nil {
		return agenttargetbiz.Target{}, f.err
	}
	target, ok := f.targets[strings.TrimSpace(id)]
	if !ok {
		return agenttargetbiz.Target{}, workspacedata.ErrAgentTargetNotFound
	}
	return target, nil
}

type fakeRuntimePreparer struct {
	result       agentsidecarservice.PreparedRuntime
	err          error
	input        *agentsidecarservice.PrepareInput
	cleanupCalls *[]agentsidecarservice.CleanupInput
}

func (f fakeRuntimePreparer) Prepare(_ context.Context, input agentsidecarservice.PrepareInput) (agentsidecarservice.PreparedRuntime, error) {
	if f.input != nil {
		*f.input = input
	}
	return f.result, f.err
}

func (f fakeRuntimePreparer) Cleanup(_ context.Context, input agentsidecarservice.CleanupInput) error {
	if f.cleanupCalls != nil {
		*f.cleanupCalls = append(*f.cleanupCalls, input)
	}
	return nil
}

type fakeSkillBundleRenderer struct {
	fakeRuntimePreparer
	bundle agentsidecarservice.SkillBundle
	err    error
	input  *agentsidecarservice.PrepareInput
}

func (f fakeSkillBundleRenderer) RenderSkillBundle(_ context.Context, input agentsidecarservice.PrepareInput) (agentsidecarservice.SkillBundle, error) {
	if f.input != nil {
		*f.input = input
	}
	return f.bundle, f.err
}

type fakeModelCatalog struct {
	result AgentModelCatalogResult
	err    error
}

func (f fakeModelCatalog) ListModels(context.Context, string) (AgentModelCatalogResult, error) {
	return f.result, f.err
}

func openAgentServiceSQLiteStore(t *testing.T) *workspacedata.SQLiteStore {
	t.Helper()
	store, err := workspacedata.OpenSQLiteStore(filepath.Join(t.TempDir(), "tutti.sqlite"))
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	return store
}

func writeAgentServiceJSONL(t *testing.T, path string, items ...map[string]any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("create jsonl dir error = %v", err)
	}
	lines := make([]string, 0, len(items))
	for _, item := range items {
		encoded, err := json.Marshal(item)
		if err != nil {
			t.Fatalf("marshal jsonl item error = %v", err)
		}
		lines = append(lines, string(encoded))
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatalf("write jsonl error = %v", err)
	}
}

func newTestService(runtime RuntimeController) *Service {
	service := NewService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	return service
}

func defaultTestAgentTargets() map[string]agenttargetbiz.Target {
	targets := make(map[string]agenttargetbiz.Target)
	for _, target := range agenttargetbiz.DefaultSystemTargets(0) {
		targets[target.ID] = target
	}
	return targets
}

type fakeMessageReader struct {
	lastLimit  *int
	lastTurnID *string
	page       SessionMessagesPage
}

type fakeProviderAvailabilityChecker struct {
	err       error
	providers []string
	result    []ProviderAvailability
	callCount int
}

func (f *fakeProviderAvailabilityChecker) ListProviderAvailability(_ context.Context, providers []string) ([]ProviderAvailability, error) {
	f.callCount++
	f.providers = append([]string(nil), providers...)
	if f.err != nil {
		return nil, f.err
	}
	return append([]ProviderAvailability(nil), f.result...), nil
}

type fakeSessionReader struct {
	reconciled *[]PersistedSession
	sessions   map[string]PersistedSession
}

type fakeSectionReader struct {
	fakeSessionReader
	lastInput agentactivitybiz.ListSessionSectionInput
	pages     map[string]agentactivitybiz.SessionSectionPage
}

func (f *fakeSectionReader) ListSessionSection(_ context.Context, input agentactivitybiz.ListSessionSectionInput) (agentactivitybiz.SessionSectionPage, bool) {
	f.lastInput = input
	if f.pages == nil {
		return agentactivitybiz.SessionSectionPage{
			WorkspaceID: input.WorkspaceID,
			SectionKey:  input.SectionKey,
		}, true
	}
	page, ok := f.pages[input.SectionKey]
	if !ok {
		return agentactivitybiz.SessionSectionPage{
			WorkspaceID: input.WorkspaceID,
			SectionKey:  input.SectionKey,
		}, true
	}
	page.WorkspaceID = input.WorkspaceID
	page.SectionKey = input.SectionKey
	return page, true
}

type fakeUserProjectReader struct {
	projects []userprojectbiz.Project
}

func (f fakeUserProjectReader) List(context.Context) ([]userprojectbiz.Project, error) {
	return f.projects, nil
}

func (f fakeMessageReader) ListSessionMessages(
	input agentactivitybiz.ListSessionMessagesInput,
) (SessionMessagesPage, bool) {
	if f.lastLimit != nil {
		*f.lastLimit = input.Limit
	}
	if f.lastTurnID != nil {
		*f.lastTurnID = input.TurnID
	}
	if input.AgentSessionID != "session-1" {
		return SessionMessagesPage{}, false
	}
	return f.page, true
}

func newFakeRuntime() *fakeRuntime {
	return &fakeRuntime{
		sessions: make(map[string]RuntimeSession),
	}
}

func (f *fakeRuntime) Cancel(_ context.Context, input RuntimeCancelInput) (RuntimeCancelResult, error) {
	f.cancelCalls = append(f.cancelCalls, input)
	if f.cancelResultSet {
		if f.cancelResult.AgentSessionID == "" {
			f.cancelResult.AgentSessionID = input.AgentSessionID
		}
		return f.cancelResult, nil
	}
	return RuntimeCancelResult{AgentSessionID: input.AgentSessionID, Canceled: true}, nil
}

func (f *fakeRuntime) Close(_ context.Context, input RuntimeCloseInput) error {
	f.closeCalls = append(f.closeCalls, input)
	if f.closeHook != nil {
		f.closeHook(input)
	}
	if f.closeErr != nil {
		return f.closeErr
	}
	delete(f.sessions, input.WorkspaceID+":"+input.AgentSessionID)
	return nil
}

func (*fakeRuntime) CanResume(input RuntimeResumeInput) bool {
	return strings.TrimSpace(input.Provider) != ""
}

func (f *fakeRuntime) Exec(_ context.Context, input RuntimeExecInput) (RuntimeExecResult, error) {
	f.execCalls = append(f.execCalls, input)
	if f.execErr != nil {
		return RuntimeExecResult{}, f.execErr
	}
	key := input.WorkspaceID + ":" + input.AgentSessionID
	if session, ok := f.sessions[key]; ok {
		session.Status = "working"
		session.UpdatedAtUnixMS = time.Now().UnixMilli()
		f.sessions[key] = session
	}
	return RuntimeExecResult{
		AgentSessionID: input.AgentSessionID,
		Status:         "started",
		Accepted:       true,
		SessionStatus:  "working",
	}, nil
}

func (f *fakeRuntime) ValidatePromptContent(_ context.Context, input RuntimeExecInput) error {
	f.validateCalls = append(f.validateCalls, input)
	return f.validateErr
}

func (f *fakeRuntime) SubmitInteractive(_ context.Context, input RuntimeSubmitInteractiveInput) error {
	f.submitInteractiveCalls = append(f.submitInteractiveCalls, input)
	if f.submitInteractiveErr != nil {
		return f.submitInteractiveErr
	}
	return nil
}

func (f *fakeRuntime) UpdateSettings(_ context.Context, input RuntimeUpdateSettingsInput) error {
	key := input.WorkspaceID + ":" + input.AgentSessionID
	session, ok := f.sessions[key]
	if !ok {
		return ErrSessionNotFound
	}
	settings := ComposerSettings{}
	if session.Settings != nil {
		settings = *session.Settings
	}
	if input.Settings.Model != nil {
		settings.Model = strings.TrimSpace(*input.Settings.Model)
	}
	if input.Settings.PermissionModeID != nil {
		settings.PermissionModeID = strings.TrimSpace(*input.Settings.PermissionModeID)
	}
	if input.Settings.PlanMode != nil {
		settings.PlanMode = *input.Settings.PlanMode
	}
	if input.Settings.ReasoningEffort != nil {
		settings.ReasoningEffort = strings.TrimSpace(*input.Settings.ReasoningEffort)
	}
	session.Settings = &settings
	session.UpdatedAtUnixMS = time.Now().UnixMilli()
	f.sessions[key] = session
	return nil
}

func (f *fakeRuntime) Resume(_ context.Context, input RuntimeResumeInput) (RuntimeSession, error) {
	f.resumeCalls = append(f.resumeCalls, input)
	session := RuntimeSession{
		ID:                input.AgentSessionID,
		AgentTargetID:     input.AgentTargetID,
		Provider:          input.Provider,
		ProviderSessionID: input.ProviderSessionID,
		Cwd:               input.Cwd,
		Env:               append([]string(nil), input.Env...),
		Settings:          cloneComposerSettingsPointer(&input.Settings),
		Status:            input.Status,
		Title:             input.Title,
		WorkspaceID:       input.WorkspaceID,
		CreatedAtUnixMS:   input.CreatedAtUnixMS,
		UpdatedAtUnixMS:   input.UpdatedAtUnixMS,
	}
	f.sessions[input.WorkspaceID+":"+input.AgentSessionID] = session
	return session, nil
}

func (f *fakeRuntime) Session(workspaceID string, agentSessionID string) (RuntimeSession, bool) {
	session, ok := f.sessions[workspaceID+":"+agentSessionID]
	return session, ok
}

func (f *fakeRuntime) SetVisible(_ context.Context, input RuntimeSetVisibleInput) (RuntimeSession, error) {
	key := input.WorkspaceID + ":" + input.AgentSessionID
	session, ok := f.sessions[key]
	if !ok {
		return RuntimeSession{}, ErrSessionNotFound
	}
	session.Visible = input.Visible
	session.UpdatedAtUnixMS = time.Now().UnixMilli()
	f.sessions[key] = session
	return session, nil
}

func (f *fakeRuntime) Sessions(workspaceID string) []RuntimeSession {
	result := make([]RuntimeSession, 0)
	for _, session := range f.sessions {
		if session.WorkspaceID == workspaceID {
			result = append(result, session)
		}
	}
	return result
}

func (f fakeSessionReader) GetSession(workspaceID string, agentSessionID string) (PersistedSession, bool) {
	session, ok := f.sessions[workspaceID+":"+agentSessionID]
	return session, ok
}

func (f fakeSessionReader) ListSessions(workspaceID string) ([]PersistedSession, bool) {
	result := make([]PersistedSession, 0)
	for _, session := range f.sessions {
		if session.WorkspaceID == workspaceID {
			result = append(result, session)
		}
	}
	return result, len(result) > 0
}

func (f fakeSessionReader) DeleteSession(_ context.Context, workspaceID string, agentSessionID string) (bool, error) {
	key := workspaceID + ":" + agentSessionID
	if _, ok := f.sessions[key]; !ok {
		return false, nil
	}
	delete(f.sessions, key)
	return true, nil
}

func (f fakeSessionReader) ClearSessions(_ context.Context, workspaceID string) (ClearSessionsResult, error) {
	removed := 0
	removedIDs := make([]string, 0)
	for key, session := range f.sessions {
		if session.WorkspaceID == workspaceID {
			delete(f.sessions, key)
			removed++
			removedIDs = append(removedIDs, session.ID)
		}
	}
	return ClearSessionsResult{RemovedSessions: removed, RemovedSessionIDs: removedIDs}, nil
}

func (f fakeSessionReader) ReconcileStaleTurnOnResume(_ context.Context, session PersistedSession) error {
	if f.reconciled != nil {
		*f.reconciled = append(*f.reconciled, session)
	}
	key := strings.TrimSpace(session.WorkspaceID) + ":" + strings.TrimSpace(session.ID)
	if persisted, ok := f.sessions[key]; ok {
		persisted.Status = "ready"
		persisted.CurrentPhase = "idle"
		f.sessions[key] = persisted
	}
	return nil
}

func (f *fakeRuntime) Start(_ context.Context, input RuntimeStartInput) (RuntimeSession, error) {
	f.startCalls = append(f.startCalls, input)
	if f.startErr != nil {
		return RuntimeSession{}, f.startErr
	}
	f.nextID++
	now := time.Now().UnixMilli()
	id := strings.TrimSpace(input.AgentSessionID)
	if id == "" {
		id = "session-" + string(rune('0'+f.nextID))
	}
	session := RuntimeSession{
		ID:            id,
		AgentTargetID: input.AgentTargetID,
		Provider:      input.Provider,
		Cwd:           input.Cwd,
		Settings: &ComposerSettings{
			Model:                  input.Model,
			PermissionModeID:       input.PermissionModeID,
			PlanMode:               input.PlanMode,
			ReasoningEffort:        input.ReasoningEffort,
			ConversationDetailMode: input.ConversationDetailMode,
		},
		Status:          "ready",
		Title:           input.Title,
		Visible:         input.Visible == nil || *input.Visible,
		WorkspaceID:     input.WorkspaceID,
		CreatedAtUnixMS: now,
		UpdatedAtUnixMS: now,
	}
	if f.startHook != nil {
		session = f.startHook(input, session)
	}
	f.sessions[input.WorkspaceID+":"+session.ID] = session
	return session, nil
}

func (*fakeRuntime) Subscribe(string, string) (<-chan RuntimeStreamEvent, func(), bool) {
	events := make(chan RuntimeStreamEvent)
	close(events)
	return events, func() {}, true
}

type fakeAgentTargetLookup struct {
	targets map[string]agenttargetbiz.Target
}

func (f fakeAgentTargetLookup) GetAgentTarget(_ context.Context, id string) (agenttargetbiz.Target, error) {
	target, ok := f.targets[strings.TrimSpace(id)]
	if !ok {
		return agenttargetbiz.Target{}, workspacedata.ErrAgentTargetNotFound
	}
	return target, nil
}

type activityProjectionRepoStub struct {
	clearResult   agentactivitybiz.ClearSessionsResult
	stateResult   agentactivitybiz.StateReportResult
	stateInput    agentactivitybiz.SessionStateReport
	messageInput  agentactivitybiz.SessionMessageReport
	messageResult agentactivitybiz.MessageReportResult
}

func (r *activityProjectionRepoStub) ClearSessions(context.Context, string) (agentactivitybiz.ClearSessionsResult, error) {
	return r.clearResult, nil
}

func (*activityProjectionRepoStub) DeleteSession(context.Context, string, string) (bool, error) {
	return false, nil
}

func (*activityProjectionRepoStub) GetSession(context.Context, string, string) (agentactivitybiz.Session, bool, error) {
	return agentactivitybiz.Session{}, false, nil
}

func (*activityProjectionRepoStub) ListSessions(context.Context, string) ([]agentactivitybiz.Session, bool, error) {
	return nil, false, nil
}

func (*activityProjectionRepoStub) ListSessionSection(context.Context, agentactivitybiz.ListSessionSectionInput) (agentactivitybiz.SessionSectionPage, bool, error) {
	return agentactivitybiz.SessionSectionPage{}, false, nil
}

func (*activityProjectionRepoStub) ListSessionMessages(context.Context, agentactivitybiz.ListSessionMessagesInput) (agentactivitybiz.MessagePage, bool, error) {
	return agentactivitybiz.MessagePage{}, false, nil
}

func (*activityProjectionRepoStub) ListWorkspaceGeneratedFiles(context.Context, agentactivitybiz.ListWorkspaceGeneratedFilesInput) (agentactivitybiz.GeneratedFileList, bool, error) {
	return agentactivitybiz.GeneratedFileList{}, false, nil
}

func (r *activityProjectionRepoStub) ReportSessionMessages(_ context.Context, input agentactivitybiz.SessionMessageReport) (agentactivitybiz.MessageReportResult, error) {
	r.messageInput = input
	return r.messageResult, nil
}

func (r *activityProjectionRepoStub) ReportSessionState(_ context.Context, input agentactivitybiz.SessionStateReport) (agentactivitybiz.StateReportResult, error) {
	r.stateInput = input
	return r.stateResult, nil
}

func (*activityProjectionRepoStub) UpdateSessionPinned(context.Context, string, string, bool) (agentactivitybiz.Session, bool, error) {
	return agentactivitybiz.Session{}, false, nil
}

type publishedActivityUpdate struct {
	workspaceID    string
	agentSessionID string
	eventType      string
	payload        map[string]any
}

type activityUpdatePublisherStub struct {
	events []publishedActivityUpdate
}

func (p *activityUpdatePublisherStub) PublishAgentActivityUpdated(_ context.Context, workspaceID string, agentSessionID string, eventType string, payload map[string]any) error {
	p.events = append(p.events, publishedActivityUpdate{
		workspaceID:    workspaceID,
		agentSessionID: agentSessionID,
		eventType:      eventType,
		payload:        payload,
	})
	return nil
}

type recordingAgentAnalyticsReporter struct {
	events []reporterservice.Event
}

func (r *recordingAgentAnalyticsReporter) Track(_ context.Context, events ...reporterservice.Event) {
	r.events = append(r.events, events...)
}

func (*recordingAgentAnalyticsReporter) Close() error {
	return nil
}

func assertAgentNodeSequence(t *testing.T, events []reporterservice.Event, want []string) {
	t.Helper()
	got := make([]string, 0, len(events))
	for _, event := range events {
		if event.Name != "agent.node_result" {
			continue
		}
		if node, ok := event.Params["node"].(string); ok {
			got = append(got, node)
		}
	}
	if !slices.Equal(got, want) {
		t.Fatalf("agent node sequence = %#v, want %#v; events = %#v", got, want, events)
	}
}

func stringRef(value string) *string {
	return &value
}
