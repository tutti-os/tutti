package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/packages/agent/daemon/titletext"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
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

func TestServiceCreateInheritsTargetComposerDefaultsAndExplicitOverridesWin(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.AgentComposerDefaultsReader = fakeAgentComposerDefaultsReader{
		agenttargetbiz.IDLocalCodex: {
			Model:            "gpt-5",
			PermissionModeID: "full-access",
			ReasoningEffort:  "high",
			Speed:            "fast",
		},
	}
	explicitModel := "gpt-5-codex"
	if _, err := service.Create(context.Background(), "ws-defaults", CreateSessionInput{
		AgentSessionID: "12121212-1212-4121-8121-121212121212",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Model:          &explicitModel,
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d", len(runtime.startCalls))
	}
	started := runtime.startCalls[0]
	if started.Model != explicitModel || started.PermissionModeID != "full-access" || started.ReasoningEffort != "high" || started.Speed != "fast" {
		t.Fatalf("runtime start = %#v", started)
	}
}

func TestServiceApplicationHostUsesConfiguredSingleton(t *testing.T) {
	service := newTestService(newFakeRuntime())
	host := service.ApplicationHost()

	if got := service.ApplicationHost(); got != host {
		t.Fatalf("ApplicationHost() = %p, want configured host %p", got, host)
	}
	if got := service.ApplicationHost(); got != host {
		t.Fatalf("second ApplicationHost() = %p, want configured host %p", got, host)
	}
}

func TestServiceCreateSynchronouslyPersistsRailSectionKey(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-rail-create", Name: "Rail Create"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	projectPath := t.TempDir()
	if canonical, ok := canonicalExistingDir(projectPath); ok {
		projectPath = canonical
	}
	if _, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:         "project-1",
		Path:       projectPath,
		Label:      "Project",
		SectionKey: userprojectbiz.SectionKeyFromPath(projectPath),
	}); err != nil {
		t.Fatalf("PutUserProject error = %v", err)
	}
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	projection := NewActivityProjection(store)
	service.SessionInitializer = projection
	service.SessionReader = projection

	created, err := service.CreateWithResult(ctx, "ws-rail-create", CreateSessionInput{
		AgentSessionID: "22222222-2222-4222-8222-222222222222",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Provider:       "codex",
		Cwd:            stringRef(projectPath),
		InitialContent: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("CreateWithResult returned error: %v", err)
	}
	session := created.Session
	if created.TurnID == "" {
		t.Fatal("CreateWithResult returned an empty turnId")
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("runtime exec calls = %d, want 1", len(runtime.execCalls))
	}
	if runtime.execCalls[0].TurnID != created.TurnID {
		t.Fatalf("runtime exec turnId = %q, CreateWithResult turnId = %q", runtime.execCalls[0].TurnID, created.TurnID)
	}
	wantKey := userprojectbiz.SectionKeyFromPath(projectPath)
	if session.RailSectionKey != wantKey {
		t.Fatalf("Create railSectionKey = %q, want %q", session.RailSectionKey, wantKey)
	}
	persisted, ok := projection.GetSession("ws-rail-create", session.ID)
	if !ok || persisted.RailSectionKey != wantKey {
		t.Fatalf("persisted session = %#v ok=%v, want rail key %q", persisted, ok, wantKey)
	}
}

func TestServiceCreateClosesRuntimeWhenSessionInitializationFails(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	want := errors.New("persist session shell")
	service.SessionInitializer = fakeSessionInitializer{err: want}

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "33333333-3333-4333-8333-333333333333",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Provider:       "codex",
	})
	if !errors.Is(err, want) {
		t.Fatalf("Create error = %v, want %v", err, want)
	}
	if len(runtime.closeCalls) != 1 || runtime.closeCalls[0].AgentSessionID != "33333333-3333-4333-8333-333333333333" {
		t.Fatalf("runtime close calls = %#v, want failed session closed", runtime.closeCalls)
	}
	if _, ok := runtime.Session("ws-1", "33333333-3333-4333-8333-333333333333"); ok {
		t.Fatal("runtime session still exists after initialization failure")
	}
}

func TestServiceUpdateTitleReturnsPersistedTitleForLiveRuntimeSession(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:              "session-1",
		WorkspaceID:     "ws-1",
		Provider:        "codex",
		Cwd:             "/workspace",
		Status:          "ready",
		Title:           "Old runtime title",
		CreatedAtUnixMS: 1,
		UpdatedAtUnixMS: 10,
	}
	service := newIsolatedAgentService(runtime)
	service.SessionReader = &fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:              "session-1",
				WorkspaceID:     "ws-1",
				Provider:        "codex",
				Cwd:             "/workspace",
				Title:           "Old persisted title",
				CreatedAtUnixMS: 1,
				UpdatedAtUnixMS: 10,
			},
		},
	}

	session, err := service.UpdateTitle(context.Background(), "ws-1", "session-1", " Renamed session ")
	if err != nil {
		t.Fatalf("UpdateTitle returned error: %v", err)
	}
	if value(session.Title) != "Renamed session" {
		t.Fatalf("UpdateTitle title = %q, want persisted renamed title", value(session.Title))
	}
	if session.UpdatedAt == nil || session.UpdatedAt.UnixMilli() <= 10 {
		t.Fatalf("UpdateTitle updatedAt = %v, want persisted update timestamp", session.UpdatedAt)
	}
	runtimeSession, ok := runtime.Session("ws-1", "session-1")
	if !ok {
		t.Fatal("runtime session missing after UpdateTitle")
	}
	if runtimeSession.Title != "Renamed session" {
		t.Fatalf("runtime session title = %q, want renamed title", runtimeSession.Title)
	}
}

func TestServiceUpdateTitleRejectsBlankTitle(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.SessionReader = &fakeSessionReader{}

	_, err := service.UpdateTitle(context.Background(), "ws-1", "session-1", "   ")
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("UpdateTitle error = %v, want ErrInvalidArgument", err)
	}
}

func TestServiceUpdateTitleRejectsOverlongTitle(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.SessionReader = &fakeSessionReader{}

	_, err := service.UpdateTitle(context.Background(), "ws-1", "session-1", strings.Repeat("好", MaxSessionTitleRunes+1))
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("UpdateTitle error = %v, want ErrInvalidArgument", err)
	}
	if !errors.Is(err, ErrSessionTitleTooLong) {
		t.Fatalf("UpdateTitle error = %v, want ErrSessionTitleTooLong", err)
	}
}

func TestServiceCreateResolvesProviderFromAgentTarget(t *testing.T) {
	runtime := newFakeRuntime()
	// Service.Create validates the Claude composer model via a hidden live
	// discovery session (composer_live_model_discovery.go); without a
	// populated RuntimeContext the poll loop never sees model options and
	// spins until the test's own timeout kills it. Supply one immediately so
	// discovery resolves on its first check, matching the pattern used by
	// TestServiceCreateDiscoversClaudeModelsBeforeStartingInvalidModel below.
	runtime.startHook = func(input RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		if input.Visible != nil && !*input.Visible {
			session.RuntimeContext = map[string]any{
				"configOptions": []any{
					map[string]any{
						"id": "model",
						"options": []any{
							map[string]any{"value": "default", "name": "Default"},
						},
					},
				},
			}
		}
		return session
	}
	service := newIsolatedAgentService(runtime)
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
		// Pin the model explicitly so resolveCreateSessionModel never falls
		// through to composerDefaultModel's readClaudeCodeConfiguredDefaultModel,
		// which reads the *real* local Claude Code CLI config file on the
		// machine running the test — making the test's behavior depend on
		// whatever model happens to be configured on the developer's machine.
		Model:          stringPointer("default"),
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
	// Service.Create's Claude composer model validation runs a hidden
	// (Visible=false) discovery session start in addition to the real,
	// user-facing session start — assert against the visible one specifically
	// rather than assuming index/count, so this doesn't re-break if discovery
	// internals change again.
	var visibleStart *RuntimeStartInput
	for i := range runtime.startCalls {
		call := runtime.startCalls[i]
		if call.Visible == nil || *call.Visible {
			visibleStart = &runtime.startCalls[i]
			break
		}
	}
	if visibleStart == nil {
		t.Fatalf("start calls = %#v, want one visible (user-facing) start call", runtime.startCalls)
	}
	if got := visibleStart.Provider; got != "claude-code" {
		t.Fatalf("runtime provider = %q, want claude-code", got)
	}
	if got := visibleStart.AgentTargetID; got != agenttargetbiz.IDLocalClaudeCode {
		t.Fatalf("runtime agent target id = %q, want %s", got, agenttargetbiz.IDLocalClaudeCode)
	}
	ref := visibleStart.ProviderTargetRef
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
			service := newIsolatedAgentService(runtime)
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
	service := newIsolatedAgentService(runtime)
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
	if got := runtime.startCalls[0].ProviderTargetRef["kind"]; got != "builtin_local" {
		t.Fatalf("provider target ref kind = %#v, want builtin_local", got)
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
			service := newIsolatedAgentService(newFakeRuntime())
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
		"model_validated",
		"cwd_resolved",
		"runtime_prepared",
		"runtime_started",
		"session_persisted",
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

func TestServiceCreateDoesNotExecuteDuplicateInitialSubmit(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.SubmitClaimStore = openAgentServiceSQLiteStore(t)
	input := CreateSessionInput{
		AgentSessionID: "session-create-idempotent", AgentTargetID: agenttargetbiz.IDLocalCodex,
		InitialContent: TextPromptContent("hello"), Metadata: map[string]any{"clientSubmitId": "submit-create-1"},
	}
	if _, err := service.Create(context.Background(), "ws-1", input); err != nil {
		t.Fatalf("first Create() error = %v", err)
	}
	if _, err := service.Create(context.Background(), "ws-1", input); err != nil {
		t.Fatalf("duplicate Create() error = %v", err)
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
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
	if legacy.Session.RailSectionKey != "project:"+parentProject {
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
	wantSectionKey := "project:" + nestedProject
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
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
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
	var prepareInput runtimeprep.PrepareInput
	service.RuntimePreparer = fakeRuntimePreparer{
		result: runtimeprep.PreparedRuntime{
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
				{
					ID:                         "gpt-5",
					DisplayName:                "GPT-5",
					DefaultReasoningEffort:     "minimal",
					ReasoningEffortsAdvertised: true,
					SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
						{Value: "minimal"},
						{Value: "high"},
					},
				},
				{ID: "gpt-5.1", DisplayName: "GPT-5.1"},
			},
		},
	}
	var prepareInput runtimeprep.PrepareInput
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
	var prepareInput runtimeprep.PrepareInput
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
	var prepareInput runtimeprep.PrepareInput
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

func TestServiceCreateClampsLegacyMaxToSelectedModelCapability(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{{
				ID:                         "gpt-5.3-codex-spark",
				DefaultReasoningEffort:     "xhigh",
				ReasoningEffortsAdvertised: true,
				SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
					{Value: "low"},
					{Value: "medium"},
					{Value: "high"},
					{Value: "xhigh"},
				},
			}},
		},
	}

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID:  "44444444-4444-4444-8444-444444444444",
		AgentTargetID:   agenttargetbiz.IDLocalCodex,
		Provider:        "codex",
		Model:           stringRef("gpt-5.3-codex-spark"),
		ReasoningEffort: stringRef("max"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if len(runtime.startCalls) != 1 || runtime.startCalls[0].ReasoningEffort != "xhigh" {
		t.Fatalf("runtime start calls = %#v, want Spark reasoning xhigh", runtime.startCalls)
	}
	if session.Settings == nil || session.Settings.ReasoningEffort != "xhigh" {
		t.Fatalf("session settings = %#v, want Spark reasoning xhigh", session.Settings)
	}
}

func TestServiceCreatePreservesAdvertisedReasoningEffort(t *testing.T) {
	for _, effort := range []string{"minimal", "none"} {
		t.Run(effort, func(t *testing.T) {
			runtime := newFakeRuntime()
			service := newTestService(runtime)
			service.ModelCatalog = fakeModelCatalog{
				result: AgentModelCatalogResult{
					Provider: "codex",
					Source:   "codex-cli",
					Models: []AgentModelOption{{
						ID:                         "gpt-catalog",
						DefaultReasoningEffort:     "high",
						ReasoningEffortsAdvertised: true,
						SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
							{Value: "minimal"}, {Value: "none"}, {Value: "high"},
						},
					}},
				},
			}

			session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
				AgentSessionID:  "55555555-5555-4555-8555-555555555555",
				AgentTargetID:   agenttargetbiz.IDLocalCodex,
				Provider:        "codex",
				Model:           stringRef("gpt-catalog"),
				ReasoningEffort: stringRef(effort),
			})
			if err != nil {
				t.Fatalf("Create returned error: %v", err)
			}
			if len(runtime.startCalls) != 1 || runtime.startCalls[0].ReasoningEffort != effort {
				t.Fatalf("runtime start calls = %#v, want reasoning %q", runtime.startCalls, effort)
			}
			if session.Settings == nil || session.Settings.ReasoningEffort != effort {
				t.Fatalf("session settings = %#v, want reasoning %q", session.Settings, effort)
			}
		})
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
		Provider:       "hermes",
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
	checker := &fakeProviderAvailabilityChecker{}
	service.AvailabilityChecker = checker
	cleanupCalls := make([]runtimeprep.CleanupInput, 0)
	service.RuntimePreparer = fakeRuntimePreparer{
		result:       runtimeprep.PreparedRuntime{Cwd: "/prepared/workdir"},
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
	if checker.callCount != 0 {
		t.Fatalf("availability checker calls = %d, want 0", checker.callCount)
	}
	if len(checker.invalidations) != 1 || checker.invalidations[0] != "codex" {
		t.Fatalf("availability invalidations = %#v, want [codex]", checker.invalidations)
	}
}

func TestServiceCreateRejectsInvalidContentBeforePreparingRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	prepareInput := (*runtimeprep.PrepareInput)(nil)
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

func TestServiceCreateDoesNotRunProviderStatusBeforePreparingRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	var prepareInput runtimeprep.PrepareInput
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
		result: runtimeprep.PreparedRuntime{
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
	if err != nil {
		t.Fatalf("Create error = %v, want nil", err)
	}
	if checker.callCount != 0 {
		t.Fatalf("availability checker callCount = %d, want 0", checker.callCount)
	}
	if prepareInput.WorkspaceID != "ws-1" {
		t.Fatalf("runtime preparer input = %#v, want workspace ws-1", prepareInput)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
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
				{Name: "adapter", Passed: true, Detail: "/opt/tutti/claude-sdk-sidecar"},
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

func TestServiceCreateNeverRepeatsApplicationProviderProbe(t *testing.T) {
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
	if checker.callCount != 0 {
		t.Fatalf("availability checker calls = %d, want 0", checker.callCount)
	}
	if len(runtime.startCalls) != 2 {
		t.Fatalf("start calls = %d, want 2", len(runtime.startCalls))
	}
}

func TestServiceSendInputRejectsUnsupportedImageBeforePersistingAttachment(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.validateErr = ErrPromptImageUnsupported
	service := newIsolatedAgentService(runtime)
	tempDir := t.TempDir()
	service.PromptAttachmentStore = PromptAttachmentStore{RootDir: tempDir}
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
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
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "ready",
		Visible:     true,
	}
	service := newIsolatedAgentService(runtime)
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
	cleanupCalls := make([]runtimeprep.CleanupInput, 0)
	service.RuntimePreparer = fakeRuntimePreparer{
		result:       runtimeprep.PreparedRuntime{Cwd: "/prepared/workdir"},
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
	if call.InitialTitle != "Run Automation" {
		t.Fatalf("runtime initial title = %q", call.InitialTitle)
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

func TestServiceCreateClaudeModelValidationUsesOnlyCachedLiveModels(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	service := newTestService(runtime)

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalClaudeCode,
		Provider:       "claude-code",
		Model:          stringRef("custom-claude-model"),
		InitialContent: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create error = %v", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want only real session start", len(runtime.startCalls))
	}
	if got := runtime.startCalls[0].AgentSessionID; got != "session-1" {
		t.Fatalf("started session id = %q, want real session id", got)
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
	service := newIsolatedAgentService(runtime)
	activeTurnID := "turn-1"
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "ready",
		Visible:     true,
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &activeTurnID,
			Phase:        "running",
		},
	}

	_, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{
		Content:        TextPromptContent("real repair prompt"),
		DisplayPrompt:  "Fix the app",
		Guidance:       true,
		ClientSubmitID: "submit-1",
		Metadata: map[string]any{
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
	if !call.Guidance {
		t.Fatal("runtime guidance = false, want true")
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

func TestServiceSendInputDoesNotExecuteDuplicateClientSubmitID(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	store := openAgentServiceSQLiteStore(t)
	service.SubmitClaimStore = store
	if _, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-idempotent", AgentTargetID: agenttargetbiz.IDLocalCodex,
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	input := SendInput{Content: TextPromptContent("hello"), Metadata: map[string]any{"clientSubmitId": "submit-1"}}
	if _, err := service.SendInput(context.Background(), "ws-1", "session-idempotent", input); err != nil {
		t.Fatalf("first SendInput() error = %v", err)
	}
	if _, err := service.SendInput(context.Background(), "ws-1", "session-idempotent", input); !errors.Is(err, ErrSubmitDeliveryUnknown) {
		t.Fatalf("duplicate SendInput() error = %v, want delivery unknown without replay", err)
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
	}
}

func TestServiceSendInputWaitsForClaudeStartupSlotBeforeExec(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "ready",
		Visible:     true,
	}
	service := newIsolatedAgentService(runtime)
	if err := service.claudeStartup().Acquire(context.Background()); err != nil {
		t.Fatalf("acquire startup lock: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		_, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{
			Content: TextPromptContent("hello"),
		})
		done <- err
	}()

	select {
	case err := <-done:
		t.Fatalf("SendInput completed while startup slot held: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if len(runtime.execCalls) != 0 {
		t.Fatalf("exec calls = %d, want blocked while startup slot held", len(runtime.execCalls))
	}
	service.claudeStartup().Release()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("SendInput error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("SendInput did not continue after startup slot release")
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1 after startup slot release", len(runtime.execCalls))
	}
}

func TestServiceCreateGeneratesSessionIDBeforePreparingRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	var prepareInput runtimeprep.PrepareInput
	service := newTestService(runtime)
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
		result: runtimeprep.PreparedRuntime{
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
	var prepareInput runtimeprep.PrepareInput
	service := newTestService(runtime)
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
		result: runtimeprep.PreparedRuntime{
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
	var renderInput runtimeprep.PrepareInput
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	service.RuntimePreparer = fakeSkillBundleRenderer{
		input: &renderInput,
		bundle: runtimeprep.SkillBundle{
			SchemaVersion:  1,
			AgentTargetID:  agenttargetbiz.IDLocalCodex,
			Provider:       "codex",
			AgentSessionID: "run-1",
			CLICommand:     "tutti-dev",
			Skills: []runtimeprep.SkillMaterializationRecord{
				{SkillID: "tutti/tutti-cli", Slug: "tutti-cli", DeliveryMode: "materialized-files"},
			},
		},
	}

	bundle, err := service.GetSkillBundle(context.Background(), "ws-1", SkillBundleInput{
		AgentSessionID: "run-1",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		BrowserUse:     true,
	})
	if err != nil {
		t.Fatalf("GetSkillBundle returned error: %v", err)
	}
	if renderInput.WorkspaceID != "ws-1" ||
		renderInput.AgentSessionID != "run-1" ||
		renderInput.AgentTargetID != agenttargetbiz.IDLocalCodex ||
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
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: map[string]agenttargetbiz.Target{}}
	service.RuntimePreparer = fakeRuntimePreparer{}

	_, err := service.GetSkillBundle(context.Background(), "ws-1", SkillBundleInput{AgentTargetID: "missing:agent"})
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
	installFakeCanonicalSessionStore(service)
	cleanupCalls := make([]runtimeprep.CleanupInput, 0)
	service.RuntimePreparer = fakeRuntimePreparer{
		result:       runtimeprep.PreparedRuntime{Cwd: "/prepared/workdir"},
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
	if !removed.Removed {
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
	service := newIsolatedAgentService(runtime)
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

func TestServiceGetComposerOptionsResolvesProviderFromAgentTargetID(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	service.CapabilityLister = &recordingComposerCapabilityLister{}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		AgentTargetID: agenttargetbiz.IDLocalCodex,
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.Provider != "codex" {
		t.Fatalf("provider = %q, want codex", options.Provider)
	}
	if options.RuntimeContext["agentTargetId"] != agenttargetbiz.IDLocalCodex {
		t.Fatalf("runtimeContext agentTargetId = %#v, want %q", options.RuntimeContext["agentTargetId"], agenttargetbiz.IDLocalCodex)
	}
}

func TestServiceGetComposerOptionsPreservesGenericExtensionTargetAndProjectsSignedLiveComposerData(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.startHook = func(input RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		if input.Visible != nil && !*input.Visible {
			runtimeContext := clonePayload(session.RuntimeContext)
			for key, value := range map[string]any{
				"configOptions": []any{
					map[string]any{
						"currentValue": "example-pro",
						"id":           "model-choice",
						"options": []any{
							map[string]any{"value": "example-pro", "name": "Example Pro"},
						},
					},
					map[string]any{
						"currentValue": "default",
						"id":           "approval-mode",
						"options": []any{
							map[string]any{"value": "default", "name": "Default"},
							map[string]any{"value": "acceptEdits", "name": "Accept edits"},
							map[string]any{"value": "auto", "name": "Auto"},
							map[string]any{"value": "dontAsk", "name": "Don't ask"},
							map[string]any{"value": "bypassPermissions", "name": "Bypass permissions"},
							map[string]any{"value": "fullAccess", "name": "Full access"},
							map[string]any{"value": "plan", "name": "Plan"},
						},
					},
					map[string]any{
						"currentValue": "enabled",
						"id":           "reasoning_effort",
						"runtimeId":    "thought_level",
						"options": []any{
							map[string]any{"value": "disabled", "name": "Off"},
							map[string]any{"value": "enabled", "name": "On"},
							map[string]any{"value": "deep", "name": "Deep"},
						},
					},
					map[string]any{
						"currentValue": "false",
						"id":           "sandbox",
						"options": []any{
							map[string]any{"value": "false", "name": "Off"},
							map[string]any{"value": "true", "name": "On"},
						},
					},
				},
				"capabilities": []any{"compact", "compact", "planMode", "unknown"},
				"availableCommands": []any{
					map[string]any{"name": "compact", "description": "Compact history", "inputHint": "optional focus"},
					map[string]any{"name": "status", "description": "Show status"},
					map[string]any{"name": "goal", "description": "Set goal"},
					map[string]any{"name": "plan", "description": "Toggle plan"},
					map[string]any{"name": "review", "description": "Review code"},
					map[string]any{"name": "effort", "description": "Set thinking effort"},
				},
			} {
				runtimeContext[key] = value
			}
			session.RuntimeContext = runtimeContext
		}
		return session
	}
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: map[string]agenttargetbiz.Target{
		"extension:example": {
			ID:            "extension:example",
			Provider:      "acp:example",
			LaunchRefJSON: `{"type":"agent_extension","extensionInstallationId":"example@1.0.0"}`,
			Name:          "Example Agent",
			Enabled:       true,
			Source:        agenttargetbiz.SourceSystem,
		},
	}}
	service.CapabilityLister = &recordingComposerCapabilityLister{}
	service.ExtensionComposerProfiles = extensionComposerProfileResolverStub{
		profile: ExtensionComposerProfile{
			Capabilities:             []string{"compact", "compact", "planMode", "unknown"},
			ModelConfigOptionID:      "model-choice",
			PermissionConfigOptionID: "approval-mode",
			ReasoningConfigOptionID:  "thought_level",
			PermissionModes: []ExtensionComposerPermissionMode{
				{RuntimeID: "default", Semantic: PermissionModeSemanticAskBeforeWrite},
				{RuntimeID: "acceptEdits", Semantic: PermissionModeSemanticAcceptEdits},
				{RuntimeID: "auto", Semantic: PermissionModeSemanticAuto},
				{RuntimeID: "dontAsk", Semantic: PermissionModeSemanticLockedDown},
				{RuntimeID: "bypassPermissions", Semantic: PermissionModeSemanticFullAccess},
				{RuntimeID: "fullAccess", Semantic: PermissionModeSemanticFullAccess},
			},
			SlashCommandCatalogAuthoritative: true,
			SlashCommands: []ExtensionComposerSlashCommand{
				{Name: "compact", Effect: string(providerregistry.SlashCommandEffectSubmitImmediate)},
				{Name: "status", Effect: string(providerregistry.SlashCommandEffectShowStatus)},
				{Name: "goal", Effect: string(providerregistry.SlashCommandEffectActivateGoalMode)},
				{Name: "plan", Effect: string(providerregistry.SlashCommandEffectTogglePlanMode)},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		AgentTargetID: "extension:example",
		Provider:      "acp:example",
		WorkspaceID:   "workspace-1",
		Cwd:           t.TempDir(),
		Settings: ComposerSettings{
			PermissionModeID: "default",
			ReasoningEffort:  "deep",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.Provider != "acp:example" {
		t.Fatalf("provider = %q, want acp:example", options.Provider)
	}
	if options.RuntimeContext["agentTargetId"] != "extension:example" {
		t.Fatalf("runtimeContext agentTargetId = %#v, want extension:example", options.RuntimeContext["agentTargetId"])
	}
	if !options.ModelConfig.Configurable || len(options.ModelConfig.Options) != 1 || options.ModelConfig.Options[0].Value != "example-pro" {
		t.Fatalf("modelConfig = %#v, want live extension model options", options.ModelConfig)
	}
	if !options.PermissionConfig.Configurable ||
		options.PermissionConfig.DefaultValue != "default" ||
		len(options.PermissionConfig.Modes) != 6 ||
		options.PermissionConfig.Modes[1].Semantic != PermissionModeSemanticAcceptEdits ||
		options.PermissionConfig.Modes[4].Semantic != PermissionModeSemanticFullAccess ||
		options.PermissionConfig.Modes[5].Semantic != PermissionModeSemanticFullAccess {
		t.Fatalf("permissionConfig = %#v, want runtime extension permission modes", options.PermissionConfig)
	}
	permissionModeIDs := make([]string, 0, len(options.PermissionConfig.Modes))
	for _, mode := range options.PermissionConfig.Modes {
		permissionModeIDs = append(permissionModeIDs, mode.ID)
	}
	if !slices.Equal(permissionModeIDs, []string{"default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "fullAccess"}) {
		t.Fatalf("permission mode ids = %#v, want exact runtime ids", permissionModeIDs)
	}
	if !options.ReasoningConfig.Configurable ||
		options.ReasoningConfig.CurrentValue != "enabled" ||
		len(options.ReasoningConfig.Options) != 3 ||
		options.ReasoningConfig.Options[2].Value != "deep" {
		t.Fatalf("reasoningConfig = %#v, want runtime extension thought_level options", options.ReasoningConfig)
	}
	if !slices.Equal(options.Capabilities, []string{"compact", "planMode"}) {
		t.Fatalf("capabilities = %#v, want deduplicated signed/live known capabilities", options.Capabilities)
	}
	if options.SlashCommandPolicy == nil ||
		!options.SlashCommandPolicy.CommandCatalogAuthoritative ||
		!slices.Equal(options.SlashCommandPolicy.FallbackCommands, []string{"compact", "status", "goal", "plan"}) ||
		len(options.SlashCommandPolicy.CommandEffects) != 4 ||
		options.SlashCommandPolicy.CommandEffects[2].Effect != providerregistry.SlashCommandEffectActivateGoalMode {
		t.Fatalf("slashCommandPolicy = %#v, want extension slash command profile", options.SlashCommandPolicy)
	}
	commands := options.Commands
	if len(commands) != 4 || commands[0].Name != "compact" || commands[0].Description != "Compact history" || commands[0].InputHint != "optional focus" || commands[3].Name != "plan" {
		t.Fatalf("commands = %#v, want filtered runtime commands", commands)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) != 5 ||
		configOptions[0]["id"] != "model" ||
		configOptions[1]["id"] != "model-choice" ||
		configOptions[2]["id"] != "approval-mode" ||
		configOptions[3]["id"] != "reasoning_effort" ||
		configOptions[3]["runtimeId"] != "thought_level" ||
		configOptions[4]["id"] != "sandbox" {
		t.Fatalf("configOptions = %#v, want model + runtime extension config options", options.RuntimeContext["configOptions"])
	}
	if len(runtime.startCalls) != 1 || runtime.startCalls[0].ProviderTargetRef["kind"] != "agent_extension" {
		t.Fatalf("runtime start calls = %#v, want one target-scoped extension discovery", runtime.startCalls)
	}
	if runtime.startCalls[0].PermissionModeID != "default" || runtime.startCalls[0].ReasoningEffort != "deep" {
		t.Fatalf("runtime start settings = %#v, want exact runtime permission and requested reasoning", runtime.startCalls[0])
	}
	if len(runtime.closeCalls) != 1 || len(runtime.sessions) != 0 {
		t.Fatalf("runtime cleanup = calls %#v sessions %#v, want hidden discovery closed immediately", runtime.closeCalls, runtime.sessions)
	}
}

func TestServiceGetComposerOptionsDoesNotCarryConversationDetailMode(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)

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
	service := newIsolatedAgentService(runtime)
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
	service := newIsolatedAgentService(runtime)
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
	service := newIsolatedAgentService(runtime)
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
	service := newIsolatedAgentService(runtime)

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
	service := newIsolatedAgentService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{
					ID:                         "gpt-5",
					DisplayName:                "GPT-5",
					DefaultReasoningEffort:     "minimal",
					ReasoningEffortsAdvertised: true,
					SupportedReasoningEfforts:  []AgentModelReasoningEffortOption{{Value: "minimal"}},
				},
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
	modelOptions, ok := configOptions[0]["options"].([]map[string]any)
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
	reasoningProfiles := options.ReasoningOptionsByModel
	gpt5Reasoning, ok := reasoningProfiles["gpt-5"]
	if !ok || gpt5Reasoning.DefaultValue != "minimal" {
		t.Fatalf("gpt-5 reasoning profile = %#v", reasoningProfiles["gpt-5"])
	}
	if len(runtime.sessions) != 0 {
		t.Fatalf("runtime sessions = %d, want no started sessions", len(runtime.sessions))
	}
}

func TestServiceGetsComposerOptionsFromTuttiAgentModelCatalog(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "tutti-agent",
			Source:   "tutti-agent-cli",
			Models: []AgentModelOption{
				{ID: "gpt-5.4", DisplayName: "GPT-5.4", IsDefault: true},
				{ID: "nova-micro", DisplayName: "Nova Micro"},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "tutti-agent",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.Model != "gpt-5.4" {
		t.Fatalf("effectiveSettings.model = %q, want gpt-5.4", options.EffectiveSettings.Model)
	}
	if options.EffectiveSettings.ReasoningEffort != "high" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want high", options.EffectiveSettings.ReasoningEffort)
	}
	if options.ModelConfig.CurrentValue != "gpt-5.4" || len(options.ModelConfig.Options) != 2 {
		t.Fatalf("modelConfig = %#v, want catalog-backed tutti-agent models", options.ModelConfig)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) < 3 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	if configOptions[0]["id"] != "model" || configOptions[0]["currentValue"] != "gpt-5.4" {
		t.Fatalf("model option = %#v", configOptions[0])
	}
	if configOptions[1]["id"] != "reasoning_effort" {
		t.Fatalf("reasoning option = %#v, want reasoning_effort id", configOptions[1])
	}
	if configOptions[2]["id"] != "service_tier" {
		t.Fatalf("speed option = %#v, want service_tier id", configOptions[2])
	}
	if options.RuntimeContext["modelCatalogSource"] != "tutti-agent-cli" {
		t.Fatalf("modelCatalogSource = %#v, want tutti-agent-cli", options.RuntimeContext["modelCatalogSource"])
	}
	if len(runtime.sessions) != 0 {
		t.Fatalf("runtime sessions = %d, want no started sessions", len(runtime.sessions))
	}
}

func TestServiceGetsComposerOptionsFromOpenCodeModelCatalogWithReasoning(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	imageSupported := true
	catalogInputs := []AgentModelCatalogInput{}
	service.ModelCatalog = fakeModelCatalog{
		inputs: &catalogInputs,
		result: AgentModelCatalogResult{
			Provider: "opencode",
			Source:   "opencode-cli",
			Models: []AgentModelOption{
				{
					ID:                         "openai/gpt-5.3-codex-spark",
					DisplayName:                "GPT-5.3 Codex Spark",
					IsDefault:                  true,
					SupportsImageInput:         &imageSupported,
					ReasoningEffortsAdvertised: true,
					SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
						{Value: "low"}, {Value: "medium"}, {Value: "high"}, {Value: "max"},
					},
				},
				{ID: "opencode/big-pickle", DisplayName: "Big Pickle", ReasoningEffortsAdvertised: true},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "opencode",
		Cwd:      "/workspace",
		Settings: ComposerSettings{
			ReasoningEffort: "none",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(catalogInputs) != 1 || catalogInputs[0].Provider != "opencode" || catalogInputs[0].Cwd != "/workspace" {
		t.Fatalf("model catalog inputs = %#v, want one workspace-scoped OpenCode lookup", catalogInputs)
	}
	if options.EffectiveSettings.Model != "openai/gpt-5.3-codex-spark" {
		t.Fatalf("effectiveSettings.model = %q, want openai/gpt-5.3-codex-spark", options.EffectiveSettings.Model)
	}
	if options.EffectiveSettings.ReasoningEffort != "low" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want low", options.EffectiveSettings.ReasoningEffort)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) != 1 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	if configOptions[0]["id"] != "model" || configOptions[0]["currentValue"] != "openai/gpt-5.3-codex-spark" {
		t.Fatalf("model option = %#v", configOptions[0])
	}
	modelOptions, ok := configOptions[0]["options"].([]map[string]any)
	if !ok || len(modelOptions) == 0 || modelOptions[0]["supportsImageInput"] != true {
		t.Fatalf("model options = %#v, want supportsImageInput true", configOptions[0]["options"])
	}
	profiles := options.ReasoningOptionsByModel
	sparkProfile, ok := profiles["openai/gpt-5.3-codex-spark"]
	if !ok || sparkProfile.DefaultValue != "low" {
		t.Fatalf("spark reasoning profile = %#v", sparkProfile)
	}
	bigPickleProfile, ok := profiles["opencode/big-pickle"]
	if !ok {
		t.Fatalf("Big Pickle reasoning profile = %#v", profiles["opencode/big-pickle"])
	}
	if len(bigPickleProfile.Options) != 0 {
		t.Fatalf("Big Pickle reasoning options = %#v, want empty", bigPickleProfile.Options)
	}
	if options.RuntimeContext["modelCatalogSource"] != "opencode-cli" {
		t.Fatalf("modelCatalogSource = %#v, want opencode-cli", options.RuntimeContext["modelCatalogSource"])
	}
	capabilities, ok := options.RuntimeContext["capabilities"].([]string)
	if !ok || !slices.Contains(capabilities, "imageInput") {
		t.Fatalf("capabilities = %#v, want imageInput", options.RuntimeContext["capabilities"])
	}
	if len(runtime.sessions) != 0 {
		t.Fatalf("runtime sessions = %d, want no started sessions", len(runtime.sessions))
	}
}

func TestServiceGetsComposerOptionsWithResolvedCodexDefaultModel(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
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

func TestServiceGetsComposerOptionsPreservesCodexModelCatalogReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{
					ID:                         "gpt-5.6-sol",
					DisplayName:                "GPT-5.6-Sol",
					DefaultReasoningEffort:     "low",
					IsDefault:                  true,
					ReasoningEffortsAdvertised: true,
					SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
						{Value: "low"},
						{Value: "ultra"},
					},
				},
				{
					ID:                         "gpt-5.6-luna",
					DisplayName:                "GPT-5.6-Luna",
					DefaultReasoningEffort:     "medium",
					ReasoningEffortsAdvertised: true,
					SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
						{Value: "low"},
						{Value: "medium"},
						{Value: "high"},
						{Value: "xhigh"},
						{Value: "max"},
					},
				},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
		Settings: ComposerSettings{
			Model:           "gpt-5.6-luna",
			ReasoningEffort: "ultra",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.ReasoningEffort != "medium" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want medium", options.EffectiveSettings.ReasoningEffort)
	}
	values := make([]string, 0, len(options.ReasoningConfig.Options))
	for _, option := range options.ReasoningConfig.Options {
		values = append(values, option.Value)
	}
	if !slices.Equal(values, []string{"low", "medium", "high", "xhigh", "max"}) {
		t.Fatalf("reasoningConfig values = %#v, want selected Luna model capabilities", values)
	}
	profiles := options.ReasoningOptionsByModel
	solProfile := profiles["gpt-5.6-sol"]
	lunaProfile := profiles["gpt-5.6-luna"]
	if len(solProfile.Options) != 2 || len(lunaProfile.Options) != 5 {
		t.Fatalf("reasoning profiles = %#v, want model-specific option counts", profiles)
	}
}

func TestServiceGetsComposerOptionsPreservesAdvertisedEmptyReasoningEfforts(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{
					ID:                         "no-reasoning",
					DisplayName:                "No Reasoning",
					IsDefault:                  true,
					ReasoningEffortsAdvertised: true,
					SupportedReasoningEfforts:  []AgentModelReasoningEffortOption{},
				},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.ReasoningEffort != "" || len(options.ReasoningConfig.Options) != 0 {
		t.Fatalf("reasoningConfig = %#v, want authoritative empty options", options.ReasoningConfig)
	}
	profiles := options.ReasoningOptionsByModel
	profile, ok := profiles["no-reasoning"]
	if !ok {
		t.Fatalf("no-reasoning profile = %#v", profiles["no-reasoning"])
	}
	if len(profile.Options) != 0 {
		t.Fatalf("no-reasoning profile options = %#v, want empty", profile.Options)
	}
}

func TestServiceGetsComposerOptionsPreservesAdvertisedMinimalReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{
					ID:                         "minimal-only",
					DisplayName:                "Minimal Only",
					DefaultReasoningEffort:     "minimal",
					IsDefault:                  true,
					ReasoningEffortsAdvertised: true,
					SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
						{Value: "minimal"},
					},
				},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.ReasoningEffort != "minimal" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want minimal", options.EffectiveSettings.ReasoningEffort)
	}
	if options.ReasoningConfig.CurrentValue != "minimal" {
		t.Fatalf("reasoningConfig.currentValue = %q, want minimal", options.ReasoningConfig.CurrentValue)
	}
	if len(options.ReasoningConfig.Options) != 1 || options.ReasoningConfig.Options[0].Value != "minimal" {
		t.Fatalf("reasoningConfig.options = %#v, want only minimal", options.ReasoningConfig.Options)
	}
}

func TestServiceGetsComposerOptionsPreservesSelectedAdvertisedReasoningEffort(t *testing.T) {
	for _, effort := range []string{"minimal", "none"} {
		t.Run(effort, func(t *testing.T) {
			service := NewService(newFakeRuntime())
			service.ModelCatalog = fakeModelCatalog{
				result: AgentModelCatalogResult{
					Provider: "codex",
					Source:   "codex-cli",
					Models: []AgentModelOption{{
						ID:                         "gpt-catalog",
						DefaultReasoningEffort:     "high",
						IsDefault:                  true,
						ReasoningEffortsAdvertised: true,
						SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
							{Value: "minimal"}, {Value: "none"}, {Value: "high"},
						},
					}},
				},
			}

			options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
				Provider: "codex",
				Settings: ComposerSettings{Model: "gpt-catalog", ReasoningEffort: effort},
			})
			if err != nil {
				t.Fatalf("GetComposerOptions returned error: %v", err)
			}
			if options.EffectiveSettings.ReasoningEffort != effort || options.ReasoningConfig.CurrentValue != effort {
				t.Fatalf("composer reasoning = %#v, want %q", options.ReasoningConfig, effort)
			}
		})
	}
}

func TestServiceGetsComposerOptionsNormalizesCodexMinimalReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
		Settings: ComposerSettings{
			ReasoningEffort: "minimal",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.ReasoningEffort != "minimal" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want minimal", options.EffectiveSettings.ReasoningEffort)
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
	if len(reasoningOptions) != 1 || reasoningOptions[0]["value"] != "minimal" {
		t.Fatalf("reasoning options = %#v, want selected model-catalog value preserved", reasoningOptions)
	}
}

func TestServiceGetsComposerOptionsNormalizesClaudeMinimalReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)

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
	var reasoningOption map[string]any
	for _, option := range configOptions {
		if option["id"] == "effort" {
			reasoningOption = option
			break
		}
	}
	if reasoningOption == nil {
		t.Fatalf("configOptions = %#v, want effort option", configOptions)
	}
	reasoningOptions, ok := reasoningOption["options"].([]map[string]string)
	if !ok {
		t.Fatalf("reasoning options = %#v", reasoningOption["options"])
	}
	for _, option := range reasoningOptions {
		if option["value"] == "minimal" {
			t.Fatalf("reasoning options = %#v, want claude minimal filtered out", reasoningOptions)
		}
	}
}

func TestServiceGetsComposerOptionsUsesClaudeStaticModelsWithoutModelCatalog(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
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
	if options.EffectiveSettings.Model != "default" {
		t.Fatalf("effectiveSettings.model = %q, want static default", options.EffectiveSettings.Model)
	}
	if options.EffectiveSettings.ReasoningEffort != "high" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want high", options.EffectiveSettings.ReasoningEffort)
	}
	if options.RuntimeContext["modelCatalogSource"] != "claude-static" {
		t.Fatalf("modelCatalogSource = %#v, want claude-static", options.RuntimeContext["modelCatalogSource"])
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	if configOptions[0]["id"] != "model" {
		t.Fatalf("configOptions = %#v, want static Claude model option first", configOptions)
	}
	modelOptions, ok := configOptions[0]["options"].([]map[string]any)
	if !ok || len(modelOptions) != 4 {
		t.Fatalf("model options = %#v, want Claude static aliases", configOptions[0]["options"])
	}
	for _, option := range modelOptions {
		if option["value"] == "test-ignored" {
			t.Fatalf("model options = %#v, want no daemon ModelCatalog models for Claude", modelOptions)
		}
	}
}

func TestGetComposerOptionsClaudeCodeWithoutWorkspaceUsesStaticModels(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)

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
	if options.EffectiveSettings.Model != "claude-sonnet-4-20250514" {
		t.Fatalf("effectiveSettings.model = %q, want requested custom model", options.EffectiveSettings.Model)
	}
	if options.RuntimeContext["model"] != "claude-sonnet-4-20250514" {
		t.Fatalf("runtime model = %#v, want requested custom model", options.RuntimeContext["model"])
	}
	if !options.ModelConfig.Configurable || len(options.ModelConfig.Options) != 5 {
		t.Fatalf("modelConfig = %#v, want static Claude models plus requested custom model", options.ModelConfig)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	if configOptions[0]["id"] != "model" {
		t.Fatalf("configOptions = %#v, want static Claude model option first", configOptions)
	}
	if options.RuntimeContext["modelCatalogSource"] != "claude-static" {
		t.Fatalf("modelCatalogSource = %#v, want claude-static", options.RuntimeContext["modelCatalogSource"])
	}
}

func TestGetComposerOptionsClaudeCodeIncludesSettingsJSONModel(t *testing.T) {
	configDir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)
	if err := os.WriteFile(filepath.Join(configDir, "settings.json"), []byte(`{"model":"claude-opus-4-6"}`), 0o600); err != nil {
		t.Fatalf("write Claude settings: %v", err)
	}
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "claude-code",
		Cwd:      "/repo",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.Model != "claude-opus-4-6" {
		t.Fatalf("effectiveSettings.model = %q, want settings.json model", options.EffectiveSettings.Model)
	}
	found := false
	for _, option := range options.ModelConfig.Options {
		if option.Value == "claude-opus-4-6" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("modelConfig options = %#v, want settings.json model included", options.ModelConfig.Options)
	}
	if options.RuntimeContext["modelCatalogSource"] != "claude-static" {
		t.Fatalf("modelCatalogSource = %#v, want claude-static", options.RuntimeContext["modelCatalogSource"])
	}
}

func TestGetComposerOptionsClaudeCodeReusesRunningSessionLiveModels(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "ready",
		RuntimeContext: map[string]any{
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
		},
	}
	service := newIsolatedAgentService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider:    "claude-code",
		WorkspaceID: "ws-1",
		Cwd:         "/repo",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %d, want no hidden discovery", len(runtime.startCalls))
	}
	if len(runtime.closeCalls) != 0 {
		t.Fatalf("close calls = %d, want no hidden discovery cleanup", len(runtime.closeCalls))
	}
	if !options.ModelConfig.Configurable || len(options.ModelConfig.Options) != 2 {
		t.Fatalf("modelConfig = %#v, want discovered model options", options.ModelConfig)
	}
	if options.RuntimeContext["modelCatalogSource"] != runtimeLiveModelCatalogSource {
		t.Fatalf("modelCatalogSource = %#v, want %s", options.RuntimeContext["modelCatalogSource"], runtimeLiveModelCatalogSource)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 || configOptions[0]["id"] != "model" {
		t.Fatalf("configOptions = %#v, want model option merged into runtime context", options.RuntimeContext["configOptions"])
	}
}

func TestGetComposerOptionsClaudeCodeLiveModelsSanitizesUnsupportedSelectedModel(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "ready",
		RuntimeContext: map[string]any{
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
		},
	}
	service := newIsolatedAgentService(runtime)

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
	runtimeModelOptions, ok := configOptions[0]["options"].([]map[string]any)
	if !ok {
		t.Fatalf("runtime model options = %#v", configOptions[0]["options"])
	}
	for _, option := range runtimeModelOptions {
		if option["value"] == "claude-sonnet-4-20250514" {
			t.Fatalf("runtime model options = %#v, want no unsupported selected model", runtimeModelOptions)
		}
	}
}

func TestGetComposerOptionsClaudeCodeSkipsDiscoveryBesideRunningSession(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "ready",
		RuntimeContext: map[string]any{
			"capabilities": []any{"imageInput"},
		},
	}
	service := newIsolatedAgentService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider:    "claude-code",
		WorkspaceID: "ws-1",
		Cwd:         "/repo",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %d, want no hidden discovery next to running session", len(runtime.startCalls))
	}
	if !options.ModelConfig.Configurable || len(options.ModelConfig.Options) != 4 {
		t.Fatalf("modelConfig = %#v, want static Claude model config when running session has no models", options.ModelConfig)
	}
	if options.RuntimeContext["modelCatalogSource"] != "claude-static" {
		t.Fatalf("modelCatalogSource = %#v, want claude-static", options.RuntimeContext["modelCatalogSource"])
	}
}

func TestGetComposerOptionsClaudeCodeSkipsStaleRunningSessionModelsAfterInvalidation(t *testing.T) {
	t.Setenv("TUTTI_STATE_DIR", t.TempDir())
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:              "session-1",
		WorkspaceID:     "ws-1",
		Provider:        "claude-code",
		Status:          "ready",
		CreatedAtUnixMS: 100,
		UpdatedAtUnixMS: 100,
		RuntimeContext: map[string]any{
			"configOptions": []any{
				map[string]any{
					"id":           "model",
					"currentValue": "sonnet",
					"options": []any{
						map[string]any{"name": "Sonnet", "value": "sonnet"},
						map[string]any{"name": "Opus", "value": "opus"},
					},
				},
			},
		},
	}
	runtime.startHook = func(input RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		if input.Provider != "claude-code" {
			t.Fatalf("start provider = %q, want claude-code", input.Provider)
		}
		session.RuntimeContext = map[string]any{
			"configOptions": []any{
				map[string]any{
					"id":           "model",
					"currentValue": "MiniMax-M2.7",
					"options": []any{
						map[string]any{"name": "MiniMax M2.7", "value": "MiniMax-M2.7"},
					},
				},
			},
		}
		return session
	}
	service := newIsolatedAgentService(runtime)
	service.LiveModelDiscoveryDeleteDelay = time.Hour

	service.InvalidateLiveComposerModels("claude-code")
	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider:    "claude-code",
		WorkspaceID: "ws-1",
		Cwd:         "/repo",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want hidden discovery after invalidation", len(runtime.startCalls))
	}
	if got := options.ModelConfig.CurrentValue; got != "MiniMax-M2.7" {
		t.Fatalf("current model = %q, want MiniMax-M2.7", got)
	}
	if len(options.ModelConfig.Options) != 1 || options.ModelConfig.Options[0].Value != "MiniMax-M2.7" {
		t.Fatalf("model options = %#v, want freshly discovered MiniMax model", options.ModelConfig.Options)
	}
}

func TestGetComposerOptionsClaudeCodeStartsHiddenDiscoveryOnceAcrossWorkspacesAndCallerCwds(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("TUTTI_STATE_DIR", stateDir)
	closed := make(chan RuntimeCloseInput, 1)
	runtime := &closeSignalRuntime{
		fakeRuntime: newFakeRuntime(),
		closed:      closed,
	}
	runtime.startHook = func(input RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		if input.Provider != "claude-code" {
			t.Fatalf("start provider = %q, want claude-code", input.Provider)
		}
		if input.Visible == nil || *input.Visible {
			t.Fatalf("visible = %#v, want hidden discovery session", input.Visible)
		}
		if input.RuntimeContext["hiddenLiveModelDiscovery"] != true {
			t.Fatalf("runtime context = %#v, want hidden discovery marker", input.RuntimeContext)
		}
		session.RuntimeContext = map[string]any{
			"configOptions": []any{
				map[string]any{
					"id":           "model",
					"currentValue": "sonnet",
					"options": []any{
						map[string]any{"name": "Sonnet", "value": "sonnet"},
						map[string]any{"name": "Opus", "value": "opus"},
					},
				},
			},
		}
		return session
	}
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	service.LiveModelDiscoveryDeleteDelay = 2 * time.Second

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		AgentTargetID: agenttargetbiz.IDLocalClaudeCode,
		Provider:      "claude-code",
		WorkspaceID:   "ws-1",
		Cwd:           "/",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want one hidden discovery", len(runtime.startCalls))
	}
	wantDiscoveryCwd := filepath.Join(stateDir, "agent", "discovery", "claude-code")
	if runtime.startCalls[0].Cwd != wantDiscoveryCwd {
		t.Fatalf("discovery cwd = %q, want %q", runtime.startCalls[0].Cwd, wantDiscoveryCwd)
	}
	if runtime.startCalls[0].AgentTargetID != agenttargetbiz.IDLocalClaudeCode ||
		runtime.startCalls[0].ProviderTargetRef["targetId"] != agenttargetbiz.IDLocalClaudeCode {
		t.Fatalf("discovery target = %q / %#v", runtime.startCalls[0].AgentTargetID, runtime.startCalls[0].ProviderTargetRef)
	}
	discoverySessionID := runtime.startCalls[0].AgentSessionID
	persisted := &fakeSessionReader{sessions: map[string]PersistedSession{
		"ws-1:" + discoverySessionID: {
			ID: discoverySessionID, WorkspaceID: "ws-1", Provider: "claude-code",
			Metadata:               agentactivitybiz.SessionMetadata{Visible: false},
			InternalRuntimeContext: map[string]any{"hiddenLiveModelDiscovery": true},
		},
	}}
	// Model discovery sessions are reported asynchronously in production. Seed
	// the canonical observation after startup so the delayed cleanup must close
	// the runtime and remove the canonical row through Host.
	service.SessionReader = persisted
	select {
	case input := <-closed:
		t.Fatalf("unexpected immediate hidden discovery cleanup: %#v", input)
	default:
	}
	if !options.ModelConfig.Configurable || len(options.ModelConfig.Options) != 2 {
		t.Fatalf("modelConfig = %#v, want discovered Claude model config", options.ModelConfig)
	}
	if options.RuntimeContext["modelCatalogSource"] != runtimeLiveModelCatalogSource {
		t.Fatalf("modelCatalogSource = %#v, want %s", options.RuntimeContext["modelCatalogSource"], runtimeLiveModelCatalogSource)
	}

	second, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		AgentTargetID: agenttargetbiz.IDLocalClaudeCode,
		Provider:      "claude-code",
		WorkspaceID:   "ws-2",
		Cwd:           "/Users/example/project",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions second returned error: %v", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want hidden discovery only once", len(runtime.startCalls))
	}
	if !second.ModelConfig.Configurable || len(second.ModelConfig.Options) != 2 {
		t.Fatalf("second modelConfig = %#v, want cached discovered model config", second.ModelConfig)
	}

	select {
	case input := <-closed:
		if input.AgentSessionID != runtime.startCalls[0].AgentSessionID {
			t.Fatalf("close input = %#v, want delayed cleanup for hidden discovery session %q", input, runtime.startCalls[0].AgentSessionID)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for delayed hidden discovery cleanup")
	}
	deadline := time.Now().Add(time.Second)
	for {
		if _, exists := persisted.sessions["ws-1:"+discoverySessionID]; !exists {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("hidden discovery session still persisted after delayed cleanup")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestGetComposerOptionsClaudeCodeLiveModelsUsesCache(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "ready",
		RuntimeContext: map[string]any{
			"configOptions": []any{
				map[string]any{
					"id":           "model",
					"currentValue": "default",
					"options": []any{
						map[string]any{"name": "Default", "value": "default"},
					},
				},
			},
		},
	}
	service := newIsolatedAgentService(runtime)

	for index := range 2 {
		options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
			Provider:    "claude-code",
			WorkspaceID: "ws-1",
			Cwd:         "/repo",
		})
		if err != nil {
			t.Fatalf("GetComposerOptions returned error: %v", err)
		}
		if !options.ModelConfig.Configurable || len(options.ModelConfig.Options) != 1 {
			t.Fatalf("modelConfig = %#v, want cached live models", options.ModelConfig)
		}
		if index == 0 {
			delete(runtime.sessions, "ws-1:session-1")
		}
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %d, want no hidden discovery", len(runtime.startCalls))
	}
	if len(runtime.closeCalls) != 0 {
		t.Fatalf("close calls = %d, want no hidden discovery cleanup", len(runtime.closeCalls))
	}
}

func TestServiceGetsComposerOptionsLeavesUnresolvedProviderModelUnset(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)

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

func TestServiceUpdateSettingsPreservesCodexModelCatalogReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		Provider:    "codex",
		WorkspaceID: "ws-1",
		Status:      "working",
		Settings: &ComposerSettings{
			ReasoningEffort: "high",
		},
	}
	service := newIsolatedAgentService(runtime)
	seedPersistedLiveSettingsSession(service, runtime.sessions["ws-1:session-1"])
	reasoningEffort := "minimal"

	session, err := service.UpdateSettings(context.Background(), "ws-1", "session-1", ComposerSettingsPatch{
		ReasoningEffort: &reasoningEffort,
	})
	if err != nil {
		t.Fatalf("UpdateSettings returned error: %v", err)
	}
	if session.Settings == nil || session.Settings.ReasoningEffort != "minimal" {
		t.Fatalf("session settings = %#v, want reasoningEffort minimal", session.Settings)
	}
}

func TestServiceUpdateSettingsPreservesAdvertisedReasoningEffort(t *testing.T) {
	for _, effort := range []string{"minimal", "none"} {
		t.Run(effort, func(t *testing.T) {
			runtime := newFakeRuntime()
			runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
				ID:          "session-1",
				Provider:    "codex",
				WorkspaceID: "ws-1",
				Status:      "working",
				Settings: &ComposerSettings{
					Model:           "gpt-catalog",
					ReasoningEffort: "high",
				},
			}
			service := NewService(runtime)
			seedPersistedLiveSettingsSession(service, runtime.sessions["ws-1:session-1"])
			service.ModelCatalog = fakeModelCatalog{
				result: AgentModelCatalogResult{
					Provider: "codex",
					Source:   "codex-cli",
					Models: []AgentModelOption{{
						ID:                         "gpt-catalog",
						DefaultReasoningEffort:     "high",
						ReasoningEffortsAdvertised: true,
						SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
							{Value: "minimal"}, {Value: "none"}, {Value: "high"},
						},
					}},
				},
			}

			configureTestApplicationHost(service)
			session, err := service.UpdateSettings(context.Background(), "ws-1", "session-1", ComposerSettingsPatch{
				ReasoningEffort: stringRef(effort),
			})
			if err != nil {
				t.Fatalf("UpdateSettings returned error: %v", err)
			}
			if session.Settings == nil || session.Settings.ReasoningEffort != effort {
				t.Fatalf("session settings = %#v, want reasoning %q", session.Settings, effort)
			}
		})
	}
}

func TestServiceUpdateSettingsDefersModelChangeReasoningClampToLiveRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		Provider:    "codex",
		WorkspaceID: "ws-1",
		Status:      "ready",
		Settings: &ComposerSettings{
			Model:           "gpt-5.6-sol",
			ReasoningEffort: "ultra",
		},
	}
	service := NewService(runtime)
	seedPersistedLiveSettingsSession(service, runtime.sessions["ws-1:session-1"])
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{
					ID:                         "gpt-5.6-sol",
					DefaultReasoningEffort:     "high",
					ReasoningEffortsAdvertised: true,
					SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
						{Value: "low"}, {Value: "medium"}, {Value: "high"},
						{Value: "xhigh"}, {Value: "max"}, {Value: "ultra"},
					},
				},
				{
					ID:                         "gpt-5.6-luna",
					DefaultReasoningEffort:     "high",
					ReasoningEffortsAdvertised: true,
					SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
						{Value: "low"}, {Value: "medium"}, {Value: "high"},
						{Value: "xhigh"}, {Value: "max"},
					},
				},
			},
		},
	}
	configureTestApplicationHost(service)
	model := "gpt-5.6-luna"

	session, err := service.UpdateSettings(context.Background(), "ws-1", "session-1", ComposerSettingsPatch{
		Model: &model,
	})
	if err != nil {
		t.Fatalf("UpdateSettings returned error: %v", err)
	}
	// The daemon-side catalog intentionally lacks Luna/ultra, while a live
	// target may advertise it. The service must not downgrade before the live
	// adapter gets a chance to resolve its fresher model/list snapshot.
	if session.Settings == nil || session.Settings.Model != model || session.Settings.ReasoningEffort != "ultra" {
		t.Fatalf("session settings = %#v, want unclamped Luna/ultra runtime input", session.Settings)
	}
}

func TestServiceUpdateSettingsNormalizesClaudeMinimalReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		Provider:    "claude-code",
		WorkspaceID: "ws-1",
		Status:      "working",
		Settings: &ComposerSettings{
			ReasoningEffort: "high",
		},
	}
	service := newIsolatedAgentService(runtime)
	seedPersistedLiveSettingsSession(service, runtime.sessions["ws-1:session-1"])
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

func TestActivityProjectionDerivesActivityOnlyFromActiveTurnReference(t *testing.T) {
	tests := []struct {
		name    string
		session agentactivitybiz.Session
		want    string
	}{
		{
			name:    "active turn",
			session: agentactivitybiz.Session{ActiveTurnID: "turn-1"},
			want:    "running",
		},
		{
			name:    "no active turn",
			session: agentactivitybiz.Session{},
			want:    "ready",
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
				LastEventUnixMS: 200,
			},
		},
	}
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)

	reply, err := projection.ReportSessionState(context.Background(), canonical.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		State: canonical.WorkspaceAgentSessionStateUpdate{
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
	if event.eventType != "session_reconcile_required" {
		t.Fatalf("published event type = %q, want session_reconcile_required", event.eventType)
	}
	if got := event.payload["eventType"]; got != "session_reconcile_required" {
		t.Fatalf("payload eventType = %#v, want session_reconcile_required", got)
	}
	if got := event.payload["lastEventUnixMs"]; got != int64(200) {
		t.Fatalf("payload lastEventUnixMs = %#v, want 200", got)
	}
	if _, ok := event.payload["lifecycleStatus"]; ok {
		t.Fatalf("payload contains stale lifecycleStatus: %#v", event.payload)
	}
}

func TestActivityProjectionUsesExplicitTitle(t *testing.T) {
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

	_, err := projection.ReportSessionState(context.Background(), canonical.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		State: canonical.WorkspaceAgentSessionStateUpdate{
			Title:            "Automation Review",
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
	if got := publisher.events[0].eventType; got != "session_reconcile_required" {
		t.Fatalf("published event type = %q, want reconciliation invalidation", got)
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

	_, err := projection.ReportSessionState(context.Background(), canonical.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Source: canonical.EventSource{
			Provider: "codex",
		},
		State: canonical.WorkspaceAgentSessionStateUpdate{
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

	_, err := projection.ReportSessionState(context.Background(), canonical.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Source: canonical.EventSource{
			Provider: "codex",
		},
		State: canonical.WorkspaceAgentSessionStateUpdate{
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
				TurnID:         "turn-1",
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

	reply, err := projection.ReportSessionMessages(context.Background(), canonical.ReportSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "provider-session-1",
		SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Source: canonical.EventSource{
			Provider:          "codex",
			ProviderSessionID: "provider-session-1",
		},
		Updates: []canonical.WorkspaceAgentSessionMessageUpdate{{
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

func TestActivityProjectionPublishesSessionAuditOutsideMessageUpdate(t *testing.T) {
	repo := &activityProjectionRepoStub{messageResult: agentactivitybiz.MessageReportResult{
		AcceptedCount: 1, LatestVersion: 4,
		Messages: []agentactivitybiz.Message{{
			AgentSessionID: "session-audit", MessageID: "goal-control:op-1", Version: 4,
			Role: "user", Kind: "session_audit", Payload: map[string]any{"text": "/goal clear"}, OccurredAtUnixMS: 123,
		}},
	}}
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)
	reply, err := projection.ReportSessionMessages(context.Background(), canonical.ReportSessionMessagesInput{
		WorkspaceID: "ws-audit", AgentSessionID: "session-audit", SessionOrigin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Source:  canonical.EventSource{Provider: "codex"},
		Updates: []canonical.WorkspaceAgentSessionMessageUpdate{{MessageID: "goal-control:op-1", Role: "user", Kind: "session_audit", OccurredAtUnixMS: 123}},
	})
	if err != nil || reply.AcceptedCount != 1 {
		t.Fatalf("ReportSessionMessages() reply=%#v error=%v", reply, err)
	}
	if len(publisher.events) != 1 || publisher.events[0].eventType != "session_audit" {
		t.Fatalf("published events = %#v", publisher.events)
	}
	if publisher.events[0].payload["eventType"] != "session_audit" {
		t.Fatalf("audit payload = %#v", publisher.events[0].payload)
	}
}

func TestActivityProjectionPreservesMixedMessageAuditOrder(t *testing.T) {
	repo := &activityProjectionRepoStub{messageResult: agentactivitybiz.MessageReportResult{
		AcceptedCount: 3, LatestVersion: 3,
		Messages: []agentactivitybiz.Message{
			{AgentSessionID: "session-order", MessageID: "message-1", Version: 1, TurnID: "turn-1", Role: "assistant", Kind: "text", Payload: map[string]any{}, OccurredAtUnixMS: 1},
			{AgentSessionID: "session-order", MessageID: "audit-1", Version: 2, Role: "user", Kind: "session_audit", Payload: map[string]any{}, OccurredAtUnixMS: 2},
			{AgentSessionID: "session-order", MessageID: "message-2", Version: 3, TurnID: "turn-1", Role: "assistant", Kind: "text", Payload: map[string]any{}, OccurredAtUnixMS: 3},
		},
	}}
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)
	_, err := projection.ReportSessionMessages(context.Background(), canonical.ReportSessionMessagesInput{
		WorkspaceID: "ws-order", AgentSessionID: "session-order", SessionOrigin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Source:  canonical.EventSource{Provider: "codex"},
		Updates: []canonical.WorkspaceAgentSessionMessageUpdate{{MessageID: "message-1", TurnID: "turn-1", Role: "assistant", Kind: "text"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(publisher.events) != 3 || publisher.events[0].eventType != "message_update" || publisher.events[1].eventType != "session_audit" || publisher.events[2].eventType != "message_update" {
		t.Fatalf("published order = %#v", publisher.events)
	}
	if publisher.events[0].payload["latestVersion"] != uint64(1) || publisher.events[2].payload["latestVersion"] != uint64(3) {
		t.Fatalf("message run cursors = %#v", publisher.events)
	}
}

func TestServiceListsSessionMessages(t *testing.T) {
	service := newIsolatedAgentService(newFakeRuntime())
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
	runtime.sessions["ws-1:live-session"] = ProviderRuntimeSession{
		ID:          "live-session",
		WorkspaceID: "ws-1",
		Provider:    "codex",
	}
	service := newIsolatedAgentService(runtime)

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
	service := newIsolatedAgentService(newFakeRuntime())
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
	service := newIsolatedAgentService(newFakeRuntime())
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
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				Metadata:          agentactivitybiz.SessionMetadata{Visible: true, Capabilities: []string{}},
				ProviderSessionID: "provider-session-1",
				ActiveTurnID:      "turn-1",
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

type recordingSessionPageReader struct {
	fakeSessionReader
	inputs []agentactivitybiz.ListSessionsPageInput
	pages  map[string]PersistedSessionListPage
	err    error
}

func (r *recordingSessionPageReader) ListSessionsPage(
	_ context.Context,
	input agentactivitybiz.ListSessionsPageInput,
) (PersistedSessionListPage, bool, error) {
	r.inputs = append(r.inputs, input)
	if r.err != nil {
		return PersistedSessionListPage{}, false, r.err
	}
	return r.pages[input.CursorSessionID], true, nil
}

func TestServiceListPageDelegatesSearchTargetAndCursorToCanonicalReader(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-newer"] = ProviderRuntimeSession{
		ID:              "session-newer",
		WorkspaceID:     "ws-1",
		AgentTargetID:   "local:codex",
		Provider:        "codex",
		Cwd:             "/workspace/newer",
		Status:          "working",
		Visible:         true,
		Title:           "Mention newer",
		CreatedAtUnixMS: time.UnixMilli(1000).UnixMilli(),
		UpdatedAtUnixMS: time.UnixMilli(4000).UnixMilli(),
	}

	service := newIsolatedAgentService(runtime)
	reader := &recordingSessionPageReader{pages: map[string]PersistedSessionListPage{
		"": {
			Sessions: []PersistedSession{{
				ID: "session-newer", WorkspaceID: "ws-1", AgentTargetID: "local:codex",
				Provider: "codex", RailSectionKey: "conversations",
				Metadata: agentactivitybiz.SessionMetadata{Visible: true},
			}},
			HasMore: true, NextCursor: "4000|session-newer",
		},
		"session-newer": {
			Sessions: []PersistedSession{{
				ID: "session-older", WorkspaceID: "ws-1", AgentTargetID: "local:codex",
				Provider: "codex", RailSectionKey: "conversations",
				Metadata: agentactivitybiz.SessionMetadata{Visible: true},
			}},
		},
	}}
	service.SessionReader = reader
	page, err := service.ListPage(context.Background(), "ws-1", ListSessionsInput{
		AgentTargetID: "local:codex",
		SearchQuery:   "mention",
		Limit:         1,
	})
	if err != nil {
		t.Fatalf("ListPage returned error: %v", err)
	}
	if len(page.Sessions) != 1 {
		t.Fatalf("len(page.Sessions) = %d, want 1", len(page.Sessions))
	}
	if page.Sessions[0].ID != "session-newer" || !page.HasMore || page.NextCursor == "" {
		t.Fatalf("first page = %#v, want newer session with next cursor", page)
	}

	nextPage, err := service.ListPage(context.Background(), "ws-1", ListSessionsInput{
		AgentTargetID: "local:codex",
		Cursor:        page.NextCursor,
		SearchQuery:   "mention",
		Limit:         1,
	})
	if err != nil {
		t.Fatalf("ListPage(next) returned error: %v", err)
	}
	if len(nextPage.Sessions) != 1 || nextPage.Sessions[0].ID != "session-older" || nextPage.HasMore {
		t.Fatalf("next page = %#v, want final older session", nextPage)
	}
	if len(reader.inputs) != 2 || reader.inputs[0].AgentTargetID != "local:codex" || reader.inputs[0].SearchQuery != "mention" || reader.inputs[0].Limit != 1 {
		t.Fatalf("canonical reader inputs = %#v", reader.inputs)
	}
	if reader.inputs[1].CursorSortTimeUnixMS != 4000 || reader.inputs[1].CursorSessionID != "session-newer" {
		t.Fatalf("canonical reader cursor = %#v", reader.inputs[1])
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
					CreatedAtUnixMS: 1000,
					UpdatedAtUnixMS: 5000,
				}},
				HasMore:    true,
				TotalCount: 7,
				NextCursor: "5000|project-session",
			},
			"conversations": {
				SectionKey: "conversations",
				Sessions: []agentactivitybiz.Session{{
					ID:              "chat-session",
					WorkspaceID:     "ws-1",
					Provider:        "codex",
					Cwd:             "/scratch/session",
					CreatedAtUnixMS: 1000,
					UpdatedAtUnixMS: 4000,
				}},
			},
			agentactivitybiz.PinnedSessionPageKey: {
				SectionKey: agentactivitybiz.PinnedSessionPageKey,
				Sessions: []agentactivitybiz.Session{{
					ID:              "pinned-session",
					WorkspaceID:     "ws-1",
					Provider:        "codex",
					PinnedAtUnixMS:  6000,
					CreatedAtUnixMS: 1000,
					UpdatedAtUnixMS: 3000,
				}},
				HasMore:    true,
				TotalCount: 3,
				NextCursor: "6000|pinned-session",
			},
		},
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = reader
	latestTurnCalls := 0
	activeTurnCalls := 0
	pendingInteractionCalls := 0
	latestInteractionCalls := 0
	service.TurnStore = failingTurnStore{
		latestListCalls:            &latestTurnCalls,
		activeListCalls:            &activeTurnCalls,
		interactionListCalls:       &pendingInteractionCalls,
		latestInteractionListCalls: &latestInteractionCalls,
	}
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
	if got, want := sessionIDs(page.Pinned.Sessions), []string{"pinned-session"}; !slices.Equal(got, want) {
		t.Fatalf("pinned sessions = %#v, want %#v", got, want)
	}
	if !page.Pinned.HasMore || page.Pinned.NextCursor != "6000|pinned-session" {
		t.Fatalf("pinned page state = hasMore %v cursor %q", page.Pinned.HasMore, page.Pinned.NextCursor)
	}
	if page.Pinned.TotalCount != 3 {
		t.Fatalf("pinned total count = %d, want 3", page.Pinned.TotalCount)
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
	if page.Sections[0].TotalCount != 7 {
		t.Fatalf("project total count = %d, want 7", page.Sections[0].TotalCount)
	}
	if page.Sections[1].Kind != "conversations" || page.Sections[1].SectionKey != "conversations" {
		t.Fatalf("conversations section = %#v", page.Sections[1])
	}
	if reader.sectionBatchCalls != 1 || reader.singleSectionCalls != 0 {
		t.Fatalf("section reader calls = batch %d single %d, want one batch and no per-section reads", reader.sectionBatchCalls, reader.singleSectionCalls)
	}
	if reader.lastSectionsInput.AgentTargetID != "claude-target" || reader.lastSectionsInput.LimitPerSection != 5 {
		t.Fatalf("reader input = %#v, want filtered five-row first pages", reader.lastSectionsInput)
	}
	if latestTurnCalls != 1 || activeTurnCalls != 1 || pendingInteractionCalls != 1 || latestInteractionCalls != 1 {
		t.Fatalf(
			"turn projection reads = latest %d active %d pending-interactions %d latest-interactions %d, want one cross-section batch each",
			latestTurnCalls,
			activeTurnCalls,
			pendingInteractionCalls,
			latestInteractionCalls,
		)
	}
}

func TestServiceListSessionSectionsPropagatesReaderError(t *testing.T) {
	want := errors.New("section store unavailable")
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = &fakeSectionReader{sectionBatchErr: want}
	service.UserProjectReader = fakeUserProjectReader{}

	_, err := service.ListSessionSections(context.Background(), "ws-1", ListSessionSectionsInput{
		LimitPerSection: 5,
	})
	if !errors.Is(err, want) {
		t.Fatalf("ListSessionSections() error = %v, want original store error", err)
	}
}

func TestServiceListSessionSectionsRequiresBatchReader(t *testing.T) {
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{}
	service.UserProjectReader = fakeUserProjectReader{}

	_, err := service.ListSessionSections(context.Background(), "ws-1", ListSessionSectionsInput{
		LimitPerSection: 5,
	})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("ListSessionSections() error = %v, want required batch reader", err)
	}
}

func TestServiceListSessionSectionsProductionReaderCanRetryAfterCancellation(t *testing.T) {
	store := openAgentServiceSQLiteStore(t)
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = NewActivityProjection(store)
	service.UserProjectReader = fakeUserProjectReader{}

	canceledContext, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := service.ListSessionSections(canceledContext, "ws-1", ListSessionSectionsInput{
		LimitPerSection: 5,
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled ListSessionSections() error = %v, want context.Canceled", err)
	}
	if errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("canceled ListSessionSections() error = %v, must not be classified as invalid input", err)
	}

	page, err := service.ListSessionSections(context.Background(), "ws-1", ListSessionSectionsInput{
		LimitPerSection: 5,
	})
	if err != nil {
		t.Fatalf("retry ListSessionSections() error = %v", err)
	}
	if page.WorkspaceID != "ws-1" || len(page.Sections) != 1 || page.Sections[0].SectionKey != sessionSectionKeyConversations {
		t.Fatalf("retry page = %#v, want empty Chats section", page)
	}
}

func TestServiceListSessionPageReadersPropagateStorageErrors(t *testing.T) {
	want := errors.New("section page store unavailable")
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = &fakeSectionReader{singleSectionErr: want}

	t.Run("workspace list", func(t *testing.T) {
		listService := newIsolatedAgentService(newFakeRuntime())
		listService.SessionReader = &recordingSessionPageReader{err: want}
		_, err := listService.ListPage(context.Background(), "ws-1", ListSessionsInput{Limit: 5})
		if !errors.Is(err, want) {
			t.Fatalf("ListPage() error = %v, want original store error", err)
		}
	})

	t.Run("ordinary section", func(t *testing.T) {
		_, err := service.ListSessionSectionPage(context.Background(), "ws-1", ListSessionSectionPageInput{
			SectionKey: sessionSectionKeyConversations,
			Limit:      5,
		})
		if !errors.Is(err, want) {
			t.Fatalf("ListSessionSectionPage() error = %v, want original store error", err)
		}
	})

	t.Run("pinned", func(t *testing.T) {
		_, err := service.ListPinnedSessionPage(context.Background(), "ws-1", ListPinnedSessionPageInput{
			Limit: 5,
		})
		if !errors.Is(err, want) {
			t.Fatalf("ListPinnedSessionPage() error = %v, want original store error", err)
		}
	})
}

func TestServiceListSessionPageProductionReaderCanRetryAfterCancellation(t *testing.T) {
	store := openAgentServiceSQLiteStore(t)
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = NewActivityProjection(store)

	t.Run("ordinary section", func(t *testing.T) {
		canceledContext, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := service.ListSessionSectionPage(canceledContext, "ws-1", ListSessionSectionPageInput{
			SectionKey: sessionSectionKeyConversations,
			Limit:      5,
		})
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled ListSessionSectionPage() error = %v, want context.Canceled", err)
		}
		if errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("canceled ListSessionSectionPage() error = %v, must not be classified as invalid input", err)
		}
		page, err := service.ListSessionSectionPage(context.Background(), "ws-1", ListSessionSectionPageInput{
			SectionKey: sessionSectionKeyConversations,
			Limit:      5,
		})
		if err != nil || page.SectionKey != sessionSectionKeyConversations || len(page.Sessions) != 0 {
			t.Fatalf("retry ListSessionSectionPage() page=%#v error=%v", page, err)
		}
	})

	t.Run("pinned", func(t *testing.T) {
		canceledContext, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := service.ListPinnedSessionPage(canceledContext, "ws-1", ListPinnedSessionPageInput{
			Limit: 5,
		})
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled ListPinnedSessionPage() error = %v, want context.Canceled", err)
		}
		if errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("canceled ListPinnedSessionPage() error = %v, must not be classified as invalid input", err)
		}
		page, err := service.ListPinnedSessionPage(context.Background(), "ws-1", ListPinnedSessionPageInput{
			Limit: 5,
		})
		if err != nil || len(page.Sessions) != 0 {
			t.Fatalf("retry ListPinnedSessionPage() page=%#v error=%v", page, err)
		}
	})
}

func TestServiceListSessionSectionPageForwardsStableCursor(t *testing.T) {
	reader := &fakeSectionReader{}
	service := newIsolatedAgentService(newFakeRuntime())
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
		reader.lastInput.CursorSortTimeUnixMS != 4000 ||
		reader.lastInput.CursorSessionID != "middle" ||
		reader.lastInput.Limit != 2 ||
		reader.lastInput.AgentTargetID != "claude-target" {
		t.Fatalf("reader input = %#v", reader.lastInput)
	}
}

func TestServiceListPinnedSessionPageForwardsStableCursor(t *testing.T) {
	reader := &fakeSectionReader{}
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = reader

	page, err := service.ListPinnedSessionPage(context.Background(), "ws-1", ListPinnedSessionPageInput{
		Cursor:        "6000|pinned-session",
		Limit:         2,
		AgentTargetID: "claude-target",
	})
	if err != nil {
		t.Fatalf("ListPinnedSessionPage returned error: %v", err)
	}
	if page.HasMore {
		t.Fatalf("page = %#v, want empty page without hasMore", page)
	}
	if reader.lastInput.SectionKey != agentactivitybiz.PinnedSessionPageKey ||
		reader.lastInput.CursorSortTimeUnixMS != 6000 ||
		reader.lastInput.CursorSessionID != "pinned-session" ||
		reader.lastInput.Limit != 2 ||
		reader.lastInput.AgentTargetID != "claude-target" {
		t.Fatalf("reader input = %#v", reader.lastInput)
	}
}

func TestServiceListSessionSectionDeletionCandidatesForwardsFilters(t *testing.T) {
	reader := &fakeSectionReader{
		deletionCandidates: agentactivitybiz.SessionSectionDeletionCandidates{
			WorkspaceID: "ws-1", SectionKey: "project:/workspace/project",
			AgentTargetID: "claude-target", ExcludePinned: true,
			SessionIDs: []string{"session-1", "session-2"},
		},
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = reader
	service.UserProjectReader = fakeUserProjectReader{projects: []userprojectbiz.Project{{
		ID: "project-1", Path: "/workspace/project", Label: "Project",
	}}}

	result, err := service.ListSessionSectionDeletionCandidates(context.Background(), "ws-1", ListSessionSectionDeletionCandidatesInput{
		SectionKey: "project:/workspace/project", AgentTargetID: "claude-target", ExcludePinned: true,
	})
	if err != nil {
		t.Fatalf("ListSessionSectionDeletionCandidates() error = %v", err)
	}
	if !slices.Equal(result.SessionIDs, []string{"session-1", "session-2"}) || !result.ExcludePinned {
		t.Fatalf("candidates = %#v", result)
	}
	if reader.lastDeletionCandidatesInput.AgentTargetID != "claude-target" || !reader.lastDeletionCandidatesInput.ExcludePinned {
		t.Fatalf("candidate input = %#v", reader.lastDeletionCandidatesInput)
	}
}

func TestServiceDeleteSessionsBatchClosesAllRuntimesBeforePersistence(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{ID: "session-1", WorkspaceID: "ws-1"}
	runtime.sessions["ws-1:session-2"] = ProviderRuntimeSession{ID: "session-2", WorkspaceID: "ws-1"}
	reader := &fakeSectionReader{batchDeleteResult: agentactivitybiz.DeleteSessionsBatchResult{
		RemovedSessions: 2, RemovedSessionIDs: []string{"session-1", "session-2"},
	}}
	service := newIsolatedAgentService(runtime)
	service.SessionReader = reader
	service.AgentSessionResourceReleaser = &fakeAgentSessionResourceReleaser{err: errors.New("release browser resources")}

	result, err := service.DeleteSessionsBatch(context.Background(), "ws-1", DeleteSessionsBatchInput{
		SessionIDs: []string{" session-1 ", "session-2"},
	})
	if err != nil {
		t.Fatalf("DeleteSessionsBatch() error = %v", err)
	}
	if len(runtime.closeCalls) != 2 || reader.batchDeleteCalls != 1 || !slices.Equal(reader.lastBatchDeleteInput.SessionIDs, []string{"session-1", "session-2"}) {
		t.Fatalf("close calls=%#v batch input=%#v calls=%d", runtime.closeCalls, reader.lastBatchDeleteInput, reader.batchDeleteCalls)
	}
	if result.RemovedSessions != 2 || !slices.Equal(result.CleanupFailedSessionIDs, []string{"session-1", "session-2"}) {
		t.Fatalf("result = %#v", result)
	}
}

func TestServiceDeleteSessionsBatchDoesNotPersistAfterRuntimeCloseFailure(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{ID: "session-1", WorkspaceID: "ws-1"}
	runtime.closeErr = errors.New("close failed")
	reader := &fakeSectionReader{}
	service := newIsolatedAgentService(runtime)
	service.SessionReader = reader

	if _, err := service.DeleteSessionsBatch(context.Background(), "ws-1", DeleteSessionsBatchInput{SessionIDs: []string{"session-1"}}); err == nil {
		t.Fatal("DeleteSessionsBatch() error = nil, want close failure")
	}
	if reader.batchDeleteCalls != 0 {
		t.Fatalf("batch delete calls = %d, want 0", reader.batchDeleteCalls)
	}
}

func TestServiceDeleteSessionsBatchRejectsBlankAndDuplicateIDs(t *testing.T) {
	service := newIsolatedAgentService(newFakeRuntime())
	reader := &fakeSectionReader{}
	service.SessionReader = reader
	for _, sessionIDs := range [][]string{nil, {" "}, {"session-1", " session-1 "}} {
		if _, err := service.DeleteSessionsBatch(context.Background(), "ws-1", DeleteSessionsBatchInput{SessionIDs: sessionIDs}); !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("DeleteSessionsBatch(%#v) error = %v, want invalid argument", sessionIDs, err)
		}
	}
	if reader.batchDeleteCalls != 0 {
		t.Fatalf("batch delete calls = %d, want 0", reader.batchDeleteCalls)
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
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:              "session-1",
				WorkspaceID:     "ws-1",
				UserID:          "user-1",
				Provider:        "codex",
				Metadata:        agentactivitybiz.SessionMetadata{Visible: true, Capabilities: []string{}},
				ActiveTurnID:    "turn-1",
				Title:           "Active work",
				CreatedAtUnixMS: 1000,
				UpdatedAtUnixMS: 2000,
			},
			"ws-1:session-2": {
				ID:              "session-2",
				WorkspaceID:     "ws-1",
				UserID:          "user-2",
				Provider:        "claude",
				Metadata:        agentactivitybiz.SessionMetadata{Visible: true, Capabilities: []string{}},
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
	if len(peers.Agents) != 1 {
		t.Fatalf("peers = %#v", peers)
	}
	if peers.Agents[0].Session.ID != "session-1" || peers.Agents[0].SelfRelation != "unknown" {
		t.Fatalf("peers = %#v", peers)
	}
	if peers.SelfKnown || !peers.MayIncludeSelf || peers.Warning != "SELF_IDENTITY_UNAVAILABLE" {
		t.Fatalf("peer identity metadata = %#v", peers)
	}
}

func TestServiceDeletesPersistedSession(t *testing.T) {
	service := newIsolatedAgentService(newFakeRuntime())
	releaser := &fakeAgentSessionResourceReleaser{}
	service.AgentSessionResourceReleaser = releaser
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
	if !removed.Removed {
		t.Fatal("Delete removed = false, want true")
	}
	if _, err := service.Get(context.Background(), "ws-1", "session-1"); err != ErrSessionNotFound {
		t.Fatalf("Get after delete error = %v, want %v", err, ErrSessionNotFound)
	}
	if !slices.Equal(releaser.released, []string{"session-1"}) {
		t.Fatalf("released Agent resources = %#v", releaser.released)
	}
}

func TestServiceDeleteReportsPostCommitCleanupFailure(t *testing.T) {
	service := newIsolatedAgentService(newFakeRuntime())
	releaser := &fakeAgentSessionResourceReleaser{err: errors.New("release browser resources")}
	service.AgentSessionResourceReleaser = releaser
	service.SessionReader = fakeSessionReader{sessions: map[string]PersistedSession{
		"ws-1:session-1": {ID: "session-1", WorkspaceID: "ws-1", Provider: "codex"},
	}}

	result, err := service.Delete(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Delete returned error: %v", err)
	}
	if !result.Removed || !result.CleanupFailed {
		t.Fatalf("Delete result = %#v, want committed delete with cleanup failure", result)
	}
	if !slices.Equal(releaser.released, []string{"session-1"}) {
		t.Fatalf("released Agent resources = %#v", releaser.released)
	}
}

func TestServiceGetReturnsLiveSessionWithoutLegacySessionReader(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "ws-1", Provider: "codex", Title: "Live session",
	}
	service := newIsolatedAgentService(runtime)
	service.TurnStore = failingTurnStore{sessionMissing: true}

	session, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if session.ID != "session-1" || value(session.Title) != "Live session" {
		t.Fatalf("Get() session = %#v, want live runtime observation", session)
	}
}

func TestServiceDeleteNormalizesWrappedRuntimeSessionNotFound(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{ID: "session-1", WorkspaceID: "ws-1"}
	runtime.closeErr = fmt.Errorf("runtime close: %w", ErrSessionNotFound)
	service := newIsolatedAgentService(runtime)
	service.SessionReader = &fakeSessionReader{sessions: map[string]PersistedSession{
		"ws-1:session-1": {ID: "session-1", WorkspaceID: "ws-1"},
	}}

	_, err := service.Delete(context.Background(), "ws-1", "session-1")
	if err != ErrSessionNotFound {
		t.Fatalf("Delete() error = %v, want canonical ErrSessionNotFound", err)
	}
}

func TestServiceDeleteClosesRuntimeSession(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	installFakeCanonicalSessionStore(service)
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
	if !removed.Removed {
		t.Fatal("Delete removed = false, want true")
	}
	if len(runtime.closeCalls) != 1 || runtime.closeCalls[0].AgentSessionID != session.ID {
		t.Fatalf("close calls = %#v", runtime.closeCalls)
	}
}

func TestServiceClearClosesRuntimeAndClearsPersistedSessions(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
	}
	runtime.sessions["ws-2:session-2"] = ProviderRuntimeSession{
		ID:          "session-2",
		WorkspaceID: "ws-2",
		Provider:    "codex",
	}
	service := newIsolatedAgentService(runtime)
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
	service := newIsolatedAgentService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				ActiveTurnID:      "turn-1",
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

type recordingGoalStateStore struct {
	prepared     []agentactivitybiz.GoalControlOperationPrepare
	dispatched   []string
	acknowledged []agentactivitybiz.GoalControlOperationAcknowledge
	released     []agentactivitybiz.ReleaseGoalControlOperationInput
}

func (s *recordingGoalStateStore) PrepareGoalControlOperation(_ context.Context, input agentactivitybiz.GoalControlOperationPrepare) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error) {
	s.prepared = append(s.prepared, input)
	return agentactivitybiz.GoalControlOperation{
			OperationID: input.OperationID, WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
			GoalRevision: 1, Action: input.Action, Objective: input.Objective, ClientSubmitID: input.ClientSubmitID,
		}, agentactivitybiz.SessionGoalState{
			WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, Revision: 1,
			PendingOperationID: input.OperationID, SyncStatus: agentactivitybiz.GoalSyncStatusPending,
		}, true, nil
}

func (s *recordingGoalStateStore) MarkGoalControlOperationDispatched(_ context.Context, _ string, operationID string, _ int64) (agentactivitybiz.GoalControlOperation, bool, error) {
	s.dispatched = append(s.dispatched, operationID)
	return agentactivitybiz.GoalControlOperation{OperationID: operationID, GoalRevision: 1}, true, nil
}

func (s *recordingGoalStateStore) AcknowledgeGoalControlOperation(_ context.Context, input agentactivitybiz.GoalControlOperationAcknowledge) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error) {
	s.acknowledged = append(s.acknowledged, input)
	return agentactivitybiz.GoalControlOperation{OperationID: input.OperationID, GoalRevision: 1}, agentactivitybiz.SessionGoalState{
		Revision: 1, PendingOperationID: input.OperationID, SyncStatus: agentactivitybiz.GoalSyncStatusApplying,
	}, true, nil
}

func (s *recordingGoalStateStore) GetGoalControlAudit(_ context.Context, workspaceID string, agentSessionID string, operationID string) (agentactivitybiz.Message, bool, error) {
	for index := len(s.prepared) - 1; index >= 0; index-- {
		prepared := s.prepared[index]
		if prepared.WorkspaceID != workspaceID || prepared.AgentSessionID != agentSessionID || prepared.OperationID != operationID {
			continue
		}
		content := "/goal " + prepared.Action
		if prepared.Action == "set" {
			content = "/goal " + prepared.Objective
		}
		return agentactivitybiz.Message{
			AgentSessionID: agentSessionID,
			MessageID:      "goal-control:" + operationID,
			Version:        1,
			Role:           "user",
			Kind:           "session_audit",
			Status:         "completed",
			Payload: map[string]any{
				"action":      prepared.Action,
				"goalControl": true,
				"operationId": operationID,
				"text":        content,
			},
			OccurredAtUnixMS: prepared.OccurredAtUnixMS,
		}, true, nil
	}
	return agentactivitybiz.Message{}, false, nil
}

type recordingGoalAuditPublisher struct {
	audits []agentactivitybiz.Message
}

func (p *recordingGoalAuditPublisher) ObserveCommitted(_ context.Context, delta agenthost.CommittedDelta) error {
	if delta.GoalOperation != nil && delta.GoalOperation.Audit != nil {
		p.audits = append(p.audits, *delta.GoalOperation.Audit)
	}
	return nil
}

func (*recordingGoalStateStore) CompleteGoalControlOperation(context.Context, agentactivitybiz.GoalControlOperationComplete) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error) {
	return agentactivitybiz.GoalControlOperation{}, agentactivitybiz.SessionGoalState{}, false, nil
}

func (s *recordingGoalStateStore) GetSessionGoalState(_ context.Context, workspaceID, agentSessionID string) (agentactivitybiz.SessionGoalState, bool, error) {
	if len(s.prepared) == 0 {
		return agentactivitybiz.SessionGoalState{}, false, nil
	}
	return agentactivitybiz.SessionGoalState{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID, Revision: 1,
		PendingOperationID: s.prepared[len(s.prepared)-1].OperationID,
		SyncStatus:         agentactivitybiz.GoalSyncStatusApplying,
	}, true, nil
}

func (*recordingGoalStateStore) ReconcileSessionGoalObservation(context.Context, agentactivitybiz.GoalObservationReconcile) (agentactivitybiz.SessionGoalState, error) {
	return agentactivitybiz.SessionGoalState{}, nil
}

func (*recordingGoalStateStore) MarkGoalRevisionTerminalIncident(_ context.Context, input agentactivitybiz.GoalTerminalIncidentInput) (agentactivitybiz.SessionGoalState, error) {
	return agentactivitybiz.SessionGoalState{WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, Revision: input.Revision, SyncStatus: agentactivitybiz.GoalSyncStatusUnknown, LastError: input.LastError}, nil
}

func (*recordingGoalStateStore) GetGoalControlOperation(context.Context, string, string) (agentactivitybiz.GoalControlOperation, bool, error) {
	return agentactivitybiz.GoalControlOperation{}, false, nil
}

func (*recordingGoalStateStore) ListClaimableGoalControlOperations(context.Context, agentactivitybiz.ListClaimableGoalControlOperationsInput) ([]agentactivitybiz.GoalControlOperation, error) {
	return nil, nil
}

func (*recordingGoalStateStore) ClaimGoalControlOperation(_ context.Context, input agentactivitybiz.ClaimGoalControlOperationInput) (agentactivitybiz.GoalControlOperation, bool, error) {
	return agentactivitybiz.GoalControlOperation{OperationID: input.OperationID, GoalRevision: 1, LeaseOwner: input.LeaseOwner}, true, nil
}

func (s *recordingGoalStateStore) ReleaseGoalControlOperation(_ context.Context, input agentactivitybiz.ReleaseGoalControlOperationInput) (agentactivitybiz.GoalControlOperation, bool, error) {
	s.released = append(s.released, input)
	return agentactivitybiz.GoalControlOperation{}, true, nil
}

func (*recordingGoalStateStore) RecordGoalControlOperationEvidence(context.Context, agentactivitybiz.GoalControlOperationEvidence) (agentactivitybiz.GoalControlOperation, bool, error) {
	return agentactivitybiz.GoalControlOperation{}, true, nil
}

func (*recordingGoalStateStore) WakeGoalControlOperation(context.Context, agentactivitybiz.WakeGoalControlOperationInput) (agentactivitybiz.GoalControlOperation, bool, error) {
	return agentactivitybiz.GoalControlOperation{}, true, nil
}

func (*recordingGoalStateStore) EnsureGoalRepairOperation(context.Context, agentactivitybiz.EnsureGoalRepairOperationInput) (agentactivitybiz.GoalControlOperation, bool, error) {
	return agentactivitybiz.GoalControlOperation{}, true, nil
}

func (*recordingGoalStateStore) EnsureOrWakeGoalRepairOperation(context.Context, agentactivitybiz.EnsureGoalRepairOperationInput) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error) {
	return agentactivitybiz.GoalControlOperation{}, agentactivitybiz.SessionGoalState{WorkspaceID: "ws-typed", AgentSessionID: "session-typed", Revision: 1}, true, nil
}

func (*recordingGoalStateStore) RequeueLeasedGoalControlOperationsOnStartup(context.Context, int64) (int64, error) {
	return 0, nil
}

func TestServiceTypedGoalUsesDurableSagaBeforeTurnSubmit(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-typed:session-typed"] = ProviderRuntimeSession{
		ID: "session-typed", Provider: "claude-code", ProviderSessionID: "provider-typed", Status: "ready",
	}
	store := &recordingGoalStateStore{}
	publisher := &recordingGoalAuditPublisher{}
	runtime.goalControlHook = func(_ context.Context, input RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
		if len(publisher.audits) != 1 {
			t.Fatalf("goal audit count before provider dispatch = %d, want 1", len(publisher.audits))
		}
		return RuntimeGoalControlResult{
			Goal:          map[string]any{"objective": input.Objective, "status": "active"},
			ProviderPhase: "accepted",
			Evidence:      map[string]any{"phase": "accepted"},
		}, nil
	}
	service := newIsolatedAgentService(runtime)
	service.GoalStateStore = store
	service.CommitObserver = publisher

	result, err := service.SendInput(context.Background(), "ws-typed", "session-typed", SendInput{
		Content:  TextPromptContent("/goal ship it"),
		Metadata: map[string]any{"clientSubmitId": "submit-goal-1"},
	})
	if err != nil {
		t.Fatalf("typed goal: %v", err)
	}
	if result.Kind != "goalControl" || result.TurnID != "" || result.GoalControl == nil {
		t.Fatalf("typed goal result=%#v", result)
	}
	if len(runtime.execCalls) != 0 {
		t.Fatalf("typed goal entered Turn Exec: %#v", runtime.execCalls)
	}
	if len(store.prepared) != 1 || store.prepared[0].Action != "set" || store.prepared[0].Objective != "ship it" {
		t.Fatalf("prepared operations=%#v", store.prepared)
	}
	if len(runtime.goalControlCalls) != 1 || runtime.goalControlCalls[0].OperationID == "" || runtime.goalControlCalls[0].GoalRevision != 1 {
		t.Fatalf("runtime goal calls=%#v", runtime.goalControlCalls)
	}
	if runtime.goalControlCalls[0].SubmissionMetadata["clientSubmitId"] != "submit-goal-1" {
		t.Fatalf("runtime goal submission metadata=%#v", runtime.goalControlCalls[0].SubmissionMetadata)
	}
	if len(store.acknowledged) != 1 || store.acknowledged[0].OperationID != runtime.goalControlCalls[0].OperationID {
		t.Fatalf("acknowledgements=%#v", store.acknowledged)
	}
	if len(publisher.audits) != 1 || publisher.audits[0].MessageID != "goal-control:"+runtime.goalControlCalls[0].OperationID {
		t.Fatalf("published goal audits=%#v", publisher.audits)
	}
}

func TestGoalSessionMutationLaneOrdersSlowSetBeforeClear(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-goal-actor", Name: "Goal Actor"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: "ws-goal-actor", AgentSessionID: "session-goal-actor", Provider: "codex", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	runtime := newFakeRuntime()
	runtime.sessions["ws-goal-actor:session-goal-actor"] = ProviderRuntimeSession{
		ID: "session-goal-actor", Provider: "codex", ProviderSessionID: "thread-goal-actor", Status: "ready",
	}
	setStarted := make(chan struct{})
	releaseSet := make(chan struct{})
	var once sync.Once
	runtime.goalControlHook = func(_ context.Context, input RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
		if input.Action == "set" {
			once.Do(func() { close(setStarted) })
			<-releaseSet
			return RuntimeGoalControlResult{Goal: map[string]any{"objective": input.Objective, "status": "active"}, ProviderPhase: "applied", Evidence: map[string]any{"confidence": "authoritative"}}, nil
		}
		return RuntimeGoalControlResult{ProviderPhase: "applied", Evidence: map[string]any{"confidence": "authoritative"}}, nil
	}
	runtime.goalReconcileHook = func(_ context.Context, input RuntimeGoalControlInput) (RuntimeGoalReconcileResult, error) {
		return RuntimeGoalReconcileResult{AgentSessionID: input.AgentSessionID,
			Goal:     map[string]any{"objective": "ship it", "status": "active"},
			Evidence: map[string]any{"confidence": "authoritative"}}, nil
	}
	service := newIsolatedAgentService(runtime)
	service.GoalStateStore = store
	service.GoalOperationOwner = "goal-worker-test"

	type goalCallResult struct {
		result GoalControlSessionResult
		err    error
	}
	setDone := make(chan goalCallResult, 1)
	go func() {
		result, err := service.GoalControl(ctx, "ws-goal-actor", "session-goal-actor", "set", "ship it")
		setDone <- goalCallResult{result: result, err: err}
	}()
	<-setStarted
	clearDone := make(chan goalCallResult, 1)
	go func() {
		result, err := service.GoalControl(ctx, "ws-goal-actor", "session-goal-actor", "clear", "")
		clearDone <- goalCallResult{result: result, err: err}
	}()
	close(releaseSet)
	setCall := <-setDone
	if setCall.err != nil {
		t.Fatalf("slow set completion: %v", setCall.err)
	}
	clearCall := <-clearDone
	if clearCall.err != nil {
		t.Fatalf("ordered clear: %v", clearCall.err)
	}
	state, found, err := store.GetSessionGoalState(ctx, "ws-goal-actor", "session-goal-actor")
	if err != nil || !found || state.Revision != 2 || !state.Tombstoned || len(state.Desired) != 0 ||
		state.SyncStatus != agentactivitybiz.GoalSyncStatusSynced || state.PendingOperationID != "" {
		t.Fatalf("current state=%#v found=%v error=%v", state, found, err)
	}
	if setCall.result.GoalState == nil || setCall.result.GoalState.Revision != 1 {
		t.Fatalf("set result=%#v, want revision one", setCall.result)
	}
	if clearCall.result.OperationID == "" {
		t.Fatal("clear operation id is empty")
	}
	runtime.mu.Lock()
	calls := append([]RuntimeGoalControlInput(nil), runtime.goalControlCalls...)
	runtime.mu.Unlock()
	if len(calls) != 2 || calls[0].Action != "set" || calls[1].Action != "clear" {
		t.Fatalf("provider calls=%#v, want ordered set then clear", calls)
	}
}

func TestGoalSessionMutationLaneRunsClearAfterAmbiguousSetFailure(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-goal-error", Name: "Goal Error"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: "ws-goal-error", AgentSessionID: "session-goal-error", Provider: "claude-code", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	runtime := newFakeRuntime()
	runtime.sessions["ws-goal-error:session-goal-error"] = ProviderRuntimeSession{
		ID: "session-goal-error", Provider: "claude-code", ProviderSessionID: "claude-goal-error", Status: "ready",
	}
	setStarted := make(chan struct{})
	releaseSet := make(chan struct{})
	var once sync.Once
	runtime.goalControlHook = func(_ context.Context, input RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
		if input.Action == "set" {
			once.Do(func() { close(setStarted) })
			<-releaseSet
			return RuntimeGoalControlResult{}, context.DeadlineExceeded
		}
		return RuntimeGoalControlResult{ProviderPhase: "applied", Evidence: map[string]any{"confidence": "authoritative"}}, nil
	}
	service := newIsolatedAgentService(runtime)
	service.GoalStateStore = store
	service.GoalOperationOwner = "goal-error-worker"
	setDone := make(chan error, 1)
	go func() {
		_, err := service.GoalControl(ctx, "ws-goal-error", "session-goal-error", "set", "old")
		setDone <- err
	}()
	<-setStarted
	close(releaseSet)
	if err := <-setDone; err == nil {
		t.Fatal("ambiguous old provider result unexpectedly succeeded")
	}
	if _, err := service.GoalControl(ctx, "ws-goal-error", "session-goal-error", "clear", ""); err != nil {
		t.Fatalf("clear after failed set: %v", err)
	}
	state, found, err := store.GetSessionGoalState(ctx, "ws-goal-error", "session-goal-error")
	if err != nil || !found || state.Revision != 2 || state.PendingOperationID != "" || state.SyncStatus != agentactivitybiz.GoalSyncStatusSynced || !state.Tombstoned {
		t.Fatalf("cleared state=%#v found=%v err=%v", state, found, err)
	}
	runtime.mu.Lock()
	calls := append([]RuntimeGoalControlInput(nil), runtime.goalControlCalls...)
	runtime.mu.Unlock()
	if len(calls) != 2 || calls[0].Action != "set" || calls[1].Action != "clear" {
		t.Fatalf("provider calls=%#v, want set then clear", calls)
	}
}

func TestGoalRecoveryDoesNotReplayAcceptedClaudeSet(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-goal-recovery", Name: "Goal Recovery"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: "ws-goal-recovery", AgentSessionID: "session-goal-recovery", Provider: "claude-code", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationPrepare{
		OperationID: "goal-unsafe-set", WorkspaceID: "ws-goal-recovery", AgentSessionID: "session-goal-recovery",
		Action: "set", Objective: "ship it", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.MarkGoalControlOperationDispatched(ctx, "ws-goal-recovery", "goal-unsafe-set", 21); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.AcknowledgeGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationAcknowledge{
		WorkspaceID: "ws-goal-recovery", OperationID: "goal-unsafe-set",
		Evidence: map[string]any{"phase": "accepted"}, OccurredAtUnixMS: 22,
	}); err != nil {
		t.Fatal(err)
	}
	runtime := newFakeRuntime()
	runtime.goalRecoveryPolicyHook = func(context.Context, RuntimeGoalControlInput) (RuntimeGoalRecoveryPolicy, error) {
		return RuntimeGoalRecoveryPolicy{QuerySupported: false, ReplaySetAfterRestart: false}, nil
	}
	runtime.sessions["ws-goal-recovery:session-goal-recovery"] = ProviderRuntimeSession{
		ID: "session-goal-recovery", Provider: "claude-code", ProviderSessionID: "claude-session", Status: "ready",
	}
	service := newIsolatedAgentService(runtime)
	service.GoalStateStore = store
	service.GoalOperationOwner = "goal-recovery-worker"
	service.GoalOperationClock = func() time.Time { return time.UnixMilli(6000) }
	if err := service.ApplicationHost().StepGoalOperationWorker(ctx, true); err != nil {
		t.Fatalf("recover accepted Claude set: %v", err)
	}
	if len(runtime.goalControlCalls) != 0 {
		t.Fatalf("unsafe Claude set replayed: %#v", runtime.goalControlCalls)
	}
	op, found, err := store.GetGoalControlOperation(ctx, "ws-goal-recovery", "goal-unsafe-set")
	if err != nil || !found || op.Status != "failed" {
		t.Fatalf("operation=%#v found=%v error=%v", op, found, err)
	}
	state, found, err := store.GetSessionGoalState(ctx, "ws-goal-recovery", "session-goal-recovery")
	if err != nil || !found || state.SyncStatus != agentactivitybiz.GoalSyncStatusFailed || state.PendingOperationID != "" {
		t.Fatalf("state=%#v found=%v error=%v", state, found, err)
	}
}

func TestGoalRecoveryPolicyIsCapabilityDrivenAndMissingResolverFailsClosed(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.goalRecoveryPolicyHook = func(context.Context, RuntimeGoalControlInput) (RuntimeGoalRecoveryPolicy, error) {
		return RuntimeGoalRecoveryPolicy{QuerySupported: true, ReplaySetAfterRestart: true}, nil
	}
	policy, err := agenthost.ResolveRuntimeGoalRecoveryPolicy(context.Background(), runtime, RuntimeGoalControlInput{})
	if err != nil || !policy.QuerySupported || !policy.ReplaySetAfterRestart {
		t.Fatalf("adapter policy=%#v err=%v", policy, err)
	}
	// Embedding only the mandatory controller contract deliberately hides the
	// optional resolver, modeling an unknown/older provider adapter.
	unknown := struct{ RuntimeController }{RuntimeController: runtime}
	policy, err = agenthost.ResolveRuntimeGoalRecoveryPolicy(context.Background(), unknown, RuntimeGoalControlInput{})
	if err != nil || policy.QuerySupported || policy.ReplaySetAfterRestart {
		t.Fatalf("missing-resolver policy must fail closed: %#v err=%v", policy, err)
	}
}

func TestGoalRecoveryTimeoutThenRestartDoesNotReplayClaudeSet(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-goal-timeout", Name: "Goal Timeout"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: "ws-goal-timeout", AgentSessionID: "session-goal-timeout", Provider: "claude-code", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationPrepare{
		OperationID: "goal-timeout-set", WorkspaceID: "ws-goal-timeout", AgentSessionID: "session-goal-timeout",
		Action: "set", Objective: "ship it", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	runtime := newFakeRuntime()
	runtime.goalRecoveryPolicyHook = func(context.Context, RuntimeGoalControlInput) (RuntimeGoalRecoveryPolicy, error) {
		return RuntimeGoalRecoveryPolicy{QuerySupported: false, ReplaySetAfterRestart: false}, nil
	}
	runtime.sessions["ws-goal-timeout:session-goal-timeout"] = ProviderRuntimeSession{
		ID: "session-goal-timeout", Provider: "claude-code", ProviderSessionID: "claude-timeout", Status: "ready",
	}
	runtime.goalControlHook = func(ctx context.Context, _ RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
		<-ctx.Done()
		return RuntimeGoalControlResult{}, ctx.Err()
	}
	nowMS := int64(30)
	service := newIsolatedAgentService(runtime)
	service.GoalStateStore = store
	service.GoalOperationOwner = "goal-timeout-worker"
	service.GoalOperationClock = func() time.Time { return time.UnixMilli(nowMS) }
	service.GoalOperationAttemptTimeout = 25 * time.Millisecond
	service.GoalOperationMaxAttempts = 1
	started := time.Now()
	if err := service.ApplicationHost().StepGoalOperationWorker(ctx, false); err != nil {
		t.Fatalf("timeout attempt: %v", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("timeout attempt took %s", elapsed)
	}
	op, found, err := store.GetGoalControlOperation(ctx, "ws-goal-timeout", "goal-timeout-set")
	if err != nil || !found || op.Status != agentactivitybiz.GoalOperationStatusDispatched ||
		op.ProviderPhase != agentactivitybiz.GoalProviderPhaseDispatched || op.LeaseOwner != "" || op.NextAttemptAtMS <= nowMS {
		t.Fatalf("timed out operation=%#v found=%v err=%v", op, found, err)
	}
	nowMS = op.NextAttemptAtMS
	if err := service.ApplicationHost().StepGoalOperationWorker(ctx, false); err != nil {
		t.Fatalf("startup recovery: %v", err)
	}
	op, found, err = store.GetGoalControlOperation(ctx, "ws-goal-timeout", "goal-timeout-set")
	if err != nil || !found || op.Status != agentactivitybiz.GoalOperationStatusFailed || op.LeaseOwner != "" {
		t.Fatalf("startup operation=%#v found=%v err=%v", op, found, err)
	}
	runtime.mu.Lock()
	callCount := len(runtime.goalControlCalls)
	runtime.mu.Unlock()
	if callCount != 1 {
		t.Fatalf("Claude set provider calls=%d, want exactly one", callCount)
	}
}

func TestGoalRepairSetTimeoutThenRestartDoesNotReplayClaudeSet(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-repair-set-timeout", Name: "Repair Set Timeout"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: "ws-repair-set-timeout", AgentSessionID: "session-repair-set-timeout", Provider: "claude-code", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationPrepare{
		OperationID: "goal-original-set", WorkspaceID: "ws-repair-set-timeout", AgentSessionID: "session-repair-set-timeout",
		Action: "set", Objective: "ship it", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.CompleteGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationComplete{
		WorkspaceID: "ws-repair-set-timeout", OperationID: "goal-original-set", Succeeded: true,
		Observed: map[string]any{"objective": "ship it", "status": "active"}, OccurredAtUnixMS: 21,
	}); err != nil {
		t.Fatal(err)
	}
	repair, _, created, err := store.EnsureOrWakeGoalRepairOperation(ctx, agentactivitybiz.EnsureGoalRepairOperationInput{
		WorkspaceID: "ws-repair-set-timeout", AgentSessionID: "session-repair-set-timeout",
		SourceOperationID: "stale-old-operation", SourceRevision: 0, CurrentRevision: 1, OccurredAtUnixMS: 30,
	})
	if err != nil || !created || repair.Action != "set" {
		t.Fatalf("repair=%#v created=%v err=%v", repair, created, err)
	}
	runtime := newFakeRuntime()
	runtime.goalRecoveryPolicyHook = func(context.Context, RuntimeGoalControlInput) (RuntimeGoalRecoveryPolicy, error) {
		return RuntimeGoalRecoveryPolicy{QuerySupported: false, ReplaySetAfterRestart: false}, nil
	}
	runtime.sessions["ws-repair-set-timeout:session-repair-set-timeout"] = ProviderRuntimeSession{
		ID: "session-repair-set-timeout", Provider: "claude-code", ProviderSessionID: "claude-repair-timeout", Status: "ready",
	}
	runtime.goalControlHook = func(ctx context.Context, _ RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
		<-ctx.Done()
		return RuntimeGoalControlResult{}, ctx.Err()
	}
	nowMS := int64(30)
	service := newIsolatedAgentService(runtime)
	service.GoalStateStore = store
	service.GoalOperationOwner = "goal-repair-timeout-worker"
	service.GoalOperationClock = func() time.Time { return time.UnixMilli(nowMS) }
	service.GoalOperationAttemptTimeout = 25 * time.Millisecond
	service.GoalOperationMaxAttempts = 1
	if err := service.ApplicationHost().StepGoalOperationWorker(ctx, false); err != nil {
		t.Fatal(err)
	}
	repair, found, err := store.GetGoalControlOperation(ctx, "ws-repair-set-timeout", repair.OperationID)
	if err != nil || !found || repair.ProviderPhase != agentactivitybiz.GoalProviderPhaseDispatched || repair.NextAttemptAtMS <= nowMS {
		t.Fatalf("timed out repair=%#v found=%v err=%v", repair, found, err)
	}
	nowMS = repair.NextAttemptAtMS
	if err := service.ApplicationHost().StepGoalOperationWorker(ctx, false); err != nil {
		t.Fatal(err)
	}
	repair, found, err = store.GetGoalControlOperation(ctx, "ws-repair-set-timeout", repair.OperationID)
	if err != nil || !found || repair.Status != agentactivitybiz.GoalOperationStatusFailed {
		t.Fatalf("startup repair=%#v found=%v err=%v", repair, found, err)
	}
	runtime.mu.Lock()
	callCount := len(runtime.goalControlCalls)
	runtime.mu.Unlock()
	if callCount != 1 {
		t.Fatalf("repair set provider calls=%d, want exactly one", callCount)
	}
}

func TestGoalClearRepeatedTimeoutEventuallyFails(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-clear-timeout", Name: "Clear timeout"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{WorkspaceID: "ws-clear-timeout", AgentSessionID: "s", Provider: "claude-code", OccurredAtUnixMS: 10}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationPrepare{OperationID: "clear-timeout", WorkspaceID: "ws-clear-timeout", AgentSessionID: "s", Action: "clear", OccurredAtUnixMS: 20}); err != nil {
		t.Fatal(err)
	}
	runtime := newFakeRuntime()
	runtime.sessions["ws-clear-timeout:s"] = ProviderRuntimeSession{ID: "s", Provider: "claude-code", Status: "ready"}
	runtime.goalControlHook = func(ctx context.Context, _ RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
		<-ctx.Done()
		return RuntimeGoalControlResult{}, ctx.Err()
	}
	now := int64(30)
	service := newIsolatedAgentService(runtime)
	service.GoalStateStore = store
	service.GoalOperationClock = func() time.Time { return time.UnixMilli(now) }
	service.GoalOperationAttemptTimeout = 20 * time.Millisecond
	service.GoalOperationMaxAttempts = 1
	if err := service.ApplicationHost().StepGoalOperationWorker(ctx, false); err != nil {
		t.Fatal(err)
	}
	op, _, _ := store.GetGoalControlOperation(ctx, "ws-clear-timeout", "clear-timeout")
	now = op.NextAttemptAtMS
	if err := service.ApplicationHost().StepGoalOperationWorker(ctx, false); err != nil {
		t.Fatal(err)
	}
	op, _, _ = store.GetGoalControlOperation(ctx, "ws-clear-timeout", "clear-timeout")
	if op.Status != agentactivitybiz.GoalOperationStatusFailed {
		t.Fatalf("clear remained nonterminal: %#v", op)
	}
}

func TestGoalRuntimeUnavailableKeepsPreparedUntilFirstProviderDispatch(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-runtime-late", Name: "Runtime late"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{WorkspaceID: "ws-runtime-late", AgentSessionID: "s", Provider: "claude-code", OccurredAtUnixMS: 10}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationPrepare{OperationID: "late", WorkspaceID: "ws-runtime-late", AgentSessionID: "s", Action: "clear", ClientSubmitID: "submit-late-goal", OccurredAtUnixMS: 20}); err != nil {
		t.Fatal(err)
	}
	runtime := newFakeRuntime()
	runtime.goalControlHook = func(ctx context.Context, _ RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
		<-ctx.Done()
		return RuntimeGoalControlResult{}, ctx.Err()
	}
	now := int64(20)
	service := newIsolatedAgentService(runtime)
	service.GoalStateStore = store
	service.GoalOperationClock = func() time.Time { return time.UnixMilli(now) }
	service.GoalOperationAttemptTimeout = 20 * time.Millisecond
	service.GoalOperationMaxAttempts = 1
	if err := service.ApplicationHost().StepGoalOperationWorker(ctx, false); err != nil {
		t.Fatal(err)
	}
	op, _, _ := store.GetGoalControlOperation(ctx, "ws-runtime-late", "late")
	if op.Status != agentactivitybiz.GoalOperationStatusPrepared || op.ProviderPhase != agentactivitybiz.GoalProviderPhasePrepared || op.FirstDispatchedAtUnixMS != 0 || op.LeaseOwner != "" || op.NextAttemptAtMS <= now || len(runtime.goalControlCalls) != 0 {
		t.Fatalf("unavailable runtime advanced delivery: %#v calls=%#v", op, runtime.goalControlCalls)
	}
	runtime.sessions["ws-runtime-late:s"] = ProviderRuntimeSession{ID: "s", Provider: "claude-code", Status: "ready"}
	now = op.NextAttemptAtMS
	if err := service.ApplicationHost().StepGoalOperationWorker(ctx, false); err != nil {
		t.Fatal(err)
	}
	op, _, _ = store.GetGoalControlOperation(ctx, "ws-runtime-late", "late")
	if op.Status != agentactivitybiz.GoalOperationStatusDispatched || op.FirstDispatchedAtUnixMS != now || len(runtime.goalControlCalls) != 1 {
		t.Fatalf("first dispatch=%#v calls=%#v", op, runtime.goalControlCalls)
	}
	if runtime.goalControlCalls[0].SubmissionMetadata["clientSubmitId"] != "submit-late-goal" {
		t.Fatalf("recovered submission metadata=%#v", runtime.goalControlCalls[0].SubmissionMetadata)
	}
	now = op.NextAttemptAtMS
	if err := service.ApplicationHost().StepGoalOperationWorker(ctx, false); err != nil {
		t.Fatal(err)
	}
	op, _, _ = store.GetGoalControlOperation(ctx, "ws-runtime-late", "late")
	if op.Status != agentactivitybiz.GoalOperationStatusFailed || len(runtime.goalControlCalls) != 1 {
		t.Fatalf("budget terminal=%#v calls=%#v", op, runtime.goalControlCalls)
	}
}

func TestGoalRecoveryProviderQueryAndApplyTimeoutReleaseLease(t *testing.T) {
	for _, phase := range []string{"query", "apply"} {
		t.Run(phase, func(t *testing.T) {
			ctx := context.Background()
			store := openAgentServiceSQLiteStore(t)
			workspaceID := "ws-goal-hang-" + phase
			sessionID := "session-goal-hang-" + phase
			operationID := "goal-hang-" + phase
			if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Goal Hang"}); err != nil {
				t.Fatal(err)
			}
			if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
				WorkspaceID: workspaceID, AgentSessionID: sessionID, Provider: "codex", OccurredAtUnixMS: 10,
			}); err != nil {
				t.Fatal(err)
			}
			if _, _, _, err := store.PrepareGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationPrepare{
				OperationID: operationID, WorkspaceID: workspaceID, AgentSessionID: sessionID,
				Action: "clear", OccurredAtUnixMS: 20,
			}); err != nil {
				t.Fatal(err)
			}
			runtime := newFakeRuntime()
			runtime.sessions[workspaceID+":"+sessionID] = ProviderRuntimeSession{
				ID: sessionID, Provider: "codex", ProviderSessionID: "codex-hang", Status: "ready",
			}
			if phase == "query" {
				runtime.goalReconcileHook = func(ctx context.Context, _ RuntimeGoalControlInput) (RuntimeGoalReconcileResult, error) {
					<-ctx.Done()
					return RuntimeGoalReconcileResult{}, ctx.Err()
				}
			} else {
				runtime.goalReconcileHook = func(_ context.Context, _ RuntimeGoalControlInput) (RuntimeGoalReconcileResult, error) {
					return RuntimeGoalReconcileResult{Evidence: map[string]any{"confidence": "unknown"}}, nil
				}
			}
			runtime.goalControlHook = func(ctx context.Context, _ RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
				<-ctx.Done()
				return RuntimeGoalControlResult{}, ctx.Err()
			}
			service := newIsolatedAgentService(runtime)
			service.GoalStateStore = store
			service.GoalOperationOwner = "goal-hang-worker"
			nowMS := int64(30)
			service.GoalOperationClock = func() time.Time { return time.UnixMilli(nowMS) }
			service.GoalOperationAttemptTimeout = 25 * time.Millisecond
			service.GoalOperationMaxAttempts = 1
			started := time.Now()
			if err := service.ApplicationHost().StepGoalOperationWorker(ctx, false); err != nil {
				t.Fatalf("worker timeout: %v", err)
			}
			if elapsed := time.Since(started); elapsed > time.Second {
				t.Fatalf("worker timeout took %s", elapsed)
			}
			op, found, err := store.GetGoalControlOperation(ctx, workspaceID, operationID)
			expectedPhase := agentactivitybiz.GoalProviderPhaseDispatched
			if err != nil || !found || op.LeaseOwner != "" || op.NextAttemptAtMS <= 30 ||
				op.ProviderPhase != expectedPhase {
				t.Fatalf("released operation=%#v found=%v err=%v", op, found, err)
			}
			if phase == "apply" {
				nowMS = op.NextAttemptAtMS
				if err := service.ApplicationHost().StepGoalOperationWorker(ctx, false); err != nil {
					t.Fatal(err)
				}
				op, _, _ = store.GetGoalControlOperation(ctx, workspaceID, operationID)
				if op.Status != agentactivitybiz.GoalOperationStatusFailed {
					t.Fatalf("codex retry did not terminate: %#v", op)
				}
			}
		})
	}
}

func TestGoalRecoveryStartupBudgetBoundsHangingProvider(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-goal-startup-budget", Name: "Startup Budget"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: "ws-goal-startup-budget", AgentSessionID: "session-goal-startup-budget", Provider: "codex", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationPrepare{
		OperationID: "goal-startup-budget", WorkspaceID: "ws-goal-startup-budget", AgentSessionID: "session-goal-startup-budget",
		Action: "clear", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	runtime := newFakeRuntime()
	runtime.sessions["ws-goal-startup-budget:session-goal-startup-budget"] = ProviderRuntimeSession{
		ID: "session-goal-startup-budget", Provider: "codex", ProviderSessionID: "codex-startup-budget", Status: "ready",
	}
	runtime.goalReconcileHook = func(ctx context.Context, _ RuntimeGoalControlInput) (RuntimeGoalReconcileResult, error) {
		<-ctx.Done()
		return RuntimeGoalReconcileResult{}, ctx.Err()
	}
	service := newIsolatedAgentService(runtime)
	service.GoalStateStore = store
	service.GoalOperationOwner = "goal-startup-budget-worker"
	service.GoalOperationClock = func() time.Time { return time.UnixMilli(30) }
	service.GoalOperationAttemptTimeout = time.Second
	service.GoalOperationRecoveryBudget = 40 * time.Millisecond
	started := time.Now()
	if err := service.ApplicationHost().RecoverGoalOperations(ctx); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("startup recovery exceeded bounded budget: %s", elapsed)
	}
	op, found, err := store.GetGoalControlOperation(ctx, "ws-goal-startup-budget", "goal-startup-budget")
	if err != nil || !found || op.LeaseOwner != "" || op.Status != agentactivitybiz.GoalOperationStatusDispatched && op.Status != agentactivitybiz.GoalOperationStatusPrepared {
		t.Fatalf("startup operation=%#v found=%v err=%v", op, found, err)
	}
}

func TestAcceptedClaudeGoalExpiresWithoutProviderReplay(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-goal-accepted-age", Name: "Accepted Age"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: "ws-goal-accepted-age", AgentSessionID: "session-goal-accepted-age", Provider: "claude-code", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationPrepare{
		OperationID: "goal-accepted-age", WorkspaceID: "ws-goal-accepted-age", AgentSessionID: "session-goal-accepted-age",
		Action: "set", Objective: "ship it", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.MarkGoalControlOperationDispatched(ctx, "ws-goal-accepted-age", "goal-accepted-age", 21); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.AcknowledgeGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationAcknowledge{
		WorkspaceID: "ws-goal-accepted-age", OperationID: "goal-accepted-age", OccurredAtUnixMS: 22,
	}); err != nil {
		t.Fatal(err)
	}
	runtime := newFakeRuntime()
	runtime.sessions["ws-goal-accepted-age:session-goal-accepted-age"] = ProviderRuntimeSession{
		ID: "session-goal-accepted-age", Provider: "claude-code", ProviderSessionID: "claude-accepted", Status: "ready",
	}
	service := newIsolatedAgentService(runtime)
	service.GoalStateStore = store
	service.GoalOperationOwner = "goal-accepted-worker"
	service.GoalOperationClock = func() time.Time { return time.UnixMilli(130_000) }
	if err := service.ApplicationHost().StepGoalOperationWorker(ctx, false); err != nil {
		t.Fatal(err)
	}
	op, found, err := store.GetGoalControlOperation(ctx, "ws-goal-accepted-age", "goal-accepted-age")
	if err != nil || !found || op.Status != agentactivitybiz.GoalOperationStatusFailed {
		t.Fatalf("expired operation=%#v found=%v err=%v", op, found, err)
	}
	if len(runtime.goalControlCalls) != 0 {
		t.Fatalf("expired accepted operation replayed: %#v", runtime.goalControlCalls)
	}
}

func TestAcceptedClaudeClearExpiresWhenLifecycleEvidenceIsLost(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-clear-age", Name: "Clear Age"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{WorkspaceID: "ws-clear-age", AgentSessionID: "session-clear-age", Provider: "claude-code", OccurredAtUnixMS: 10}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationPrepare{OperationID: "clear-age", WorkspaceID: "ws-clear-age", AgentSessionID: "session-clear-age", Action: "clear", OccurredAtUnixMS: 20}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.MarkGoalControlOperationDispatched(ctx, "ws-clear-age", "clear-age", 21); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.AcknowledgeGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationAcknowledge{WorkspaceID: "ws-clear-age", OperationID: "clear-age", OccurredAtUnixMS: 22}); err != nil {
		t.Fatal(err)
	}
	runtime := newFakeRuntime()
	runtime.sessions["ws-clear-age:session-clear-age"] = ProviderRuntimeSession{ID: "session-clear-age", Provider: "claude-code", ProviderSessionID: "claude-clear-age", Status: "ready"}
	service := newIsolatedAgentService(runtime)
	service.GoalStateStore = store
	service.GoalOperationOwner = "clear-age-worker"
	service.GoalOperationClock = func() time.Time { return time.UnixMilli(130_000) }
	if err := service.ApplicationHost().StepGoalOperationWorker(ctx, false); err != nil {
		t.Fatal(err)
	}
	op, found, err := store.GetGoalControlOperation(ctx, "ws-clear-age", "clear-age")
	if err != nil || !found || op.Status != agentactivitybiz.GoalOperationStatusFailed {
		t.Fatalf("op=%#v found=%v err=%v", op, found, err)
	}
	state, found, err := store.GetSessionGoalState(ctx, "ws-clear-age", "session-clear-age")
	if err != nil || !found || state.PendingOperationID != "" || state.SyncStatus != agentactivitybiz.GoalSyncStatusFailed {
		t.Fatalf("state=%#v found=%v err=%v", state, found, err)
	}
	if len(runtime.goalControlCalls) != 0 {
		t.Fatalf("expired clear replayed: %#v", runtime.goalControlCalls)
	}
}

func TestGoalReconcileFenceConflictRequeriesProvider(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-goal-requery", Name: "Goal Requery"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: "ws-goal-requery", AgentSessionID: "session-goal-requery", Provider: "codex", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	runtime := newFakeRuntime()
	runtime.sessions["ws-goal-requery:session-goal-requery"] = ProviderRuntimeSession{
		ID: "session-goal-requery", Provider: "codex", ProviderSessionID: "codex-requery", Status: "ready",
	}
	queryCount := 0
	runtime.goalReconcileHook = func(_ context.Context, input RuntimeGoalControlInput) (RuntimeGoalReconcileResult, error) {
		queryCount++
		if queryCount == 1 {
			if _, _, _, err := store.PrepareGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationPrepare{
				OperationID: "goal-created-during-query", WorkspaceID: "ws-goal-requery", AgentSessionID: "session-goal-requery",
				Action: "set", Objective: "new desired", OccurredAtUnixMS: 20,
			}); err != nil {
				return RuntimeGoalReconcileResult{}, err
			}
			return RuntimeGoalReconcileResult{AgentSessionID: input.AgentSessionID,
				Evidence: map[string]any{"confidence": "authoritative"}}, nil
		}
		return RuntimeGoalReconcileResult{AgentSessionID: input.AgentSessionID,
			Goal:     map[string]any{"objective": "new desired", "status": "active"},
			Evidence: map[string]any{"confidence": "authoritative"}}, nil
	}
	service := newIsolatedAgentService(runtime)
	service.GoalStateStore = store
	service.GoalOperationClock = func() time.Time { return time.UnixMilli(30) }
	result, err := service.ReconcileGoal(ctx, "ws-goal-requery", "session-goal-requery")
	if err != nil {
		t.Fatal(err)
	}
	if queryCount != 2 {
		t.Fatalf("provider query count=%d, want 2 after fence conflict", queryCount)
	}
	if result.State.Revision != 1 || result.State.PendingOperationID != "" ||
		result.State.SyncStatus != agentactivitybiz.GoalSyncStatusSynced || result.State.Observed["objective"] != "new desired" {
		t.Fatalf("reconciled state=%#v", result.State)
	}
}

func TestManualGoalReconcileProviderTimeoutIsBounded(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-timeout:session-timeout"] = ProviderRuntimeSession{ID: "session-timeout", Provider: "codex", Status: "ready"}
	runtime.goalReconcileHook = func(ctx context.Context, _ RuntimeGoalControlInput) (RuntimeGoalReconcileResult, error) {
		<-ctx.Done()
		return RuntimeGoalReconcileResult{}, ctx.Err()
	}
	service := newIsolatedAgentService(runtime)
	service.GoalOperationAttemptTimeout = 25 * time.Millisecond
	started := time.Now()
	_, err := service.ReconcileGoal(context.Background(), "ws-timeout", "session-timeout")
	if err == nil || time.Since(started) > time.Second {
		t.Fatalf("err=%v elapsed=%s", err, time.Since(started))
	}
}

func TestServiceCreateWithTypedGoalCreatesNoInitialTurn(t *testing.T) {
	runtime := newFakeRuntime()
	store := &recordingGoalStateStore{}
	service := newTestService(runtime)
	service.GoalStateStore = store

	session, err := service.Create(context.Background(), "ws-typed", CreateSessionInput{
		AgentSessionID: "session-new-goal",
		AgentTargetID:  agenttargetbiz.IDLocalClaudeCode,
		InitialContent: TextPromptContent("/goal ship it"),
		Metadata:       map[string]any{"clientSubmitId": "submit-new-goal"},
	})
	if err != nil {
		t.Fatalf("Create typed goal: %v", err)
	}
	if session.ID != "session-new-goal" {
		t.Fatalf("session=%#v", session)
	}
	if len(runtime.execCalls) != 0 {
		t.Fatalf("typed Goal create entered Turn Exec: %#v", runtime.execCalls)
	}
	if len(runtime.goalControlCalls) != 1 || runtime.goalControlCalls[0].OperationID == "" {
		t.Fatalf("goal control calls=%#v", runtime.goalControlCalls)
	}
	if runtime.goalControlCalls[0].SubmissionMetadata["clientSubmitId"] != "submit-new-goal" {
		t.Fatalf("goal control submission metadata=%#v", runtime.goalControlCalls[0].SubmissionMetadata)
	}
	if len(store.prepared) != 1 || store.prepared[0].AgentSessionID != "session-new-goal" {
		t.Fatalf("prepared operations=%#v", store.prepared)
	}
}

func TestParseTypedGoalControlUsesSemanticContentAndUnicodeWhitespace(t *testing.T) {
	tests := []struct {
		name          string
		content       string
		displayPrompt string
		want          agenthost.TypedGoalControl
		wantOK        bool
	}{
		{name: "space", content: "/goal clear", want: agenthost.TypedGoalControl{Action: "clear"}, wantOK: true},
		{name: "tab", content: "/goal\tclear", want: agenthost.TypedGoalControl{Action: "clear"}, wantOK: true},
		{name: "newline", content: "/goal\nship it", want: agenthost.TypedGoalControl{Action: "set", Objective: "ship it"}, wantOK: true},
		{name: "unicode space", content: "/goal\u3000ship it", want: agenthost.TypedGoalControl{Action: "set", Objective: "ship it"}, wantOK: true},
		{name: "display cannot hide control", content: "/goal clear", displayPrompt: "clear chip", want: agenthost.TypedGoalControl{Action: "clear"}, wantOK: true},
		{name: "display cannot create control", content: "ordinary prompt", displayPrompt: "/goal clear", wantOK: false},
		{name: "bare goal is not a mutation", content: "/goal", wantOK: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := agenthost.ParseTypedGoalControl(TextPromptContent(test.content), false)
			if ok != test.wantOK || got != test.want {
				t.Fatalf("parseTypedGoalControl()=(%#v,%v), want (%#v,%v)", got, ok, test.want, test.wantOK)
			}
		})
	}
}

func TestServiceSendInputContinuesImportedSession(t *testing.T) {
	// Imported conversations must continue in place: sending resumes (or, when
	// the provider session is missing locally, recreates) the provider session
	// rather than rejecting with ErrSessionNotFound and forcing a new chat.
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-imported": {
				ID:                "session-imported",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "imported-thread-1",
				Origin:            WorkspaceAgentSessionOriginImported,
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
	service := newIsolatedAgentService(runtime)
	exactTurn := agentactivitybiz.Turn{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: agentactivitybiz.TurnPhaseSubmitted, Origin: agentactivitybiz.TurnOriginUserPrompt,
		StartedAtUnixMS: 3000, UpdatedAtUnixMS: 3000,
	}
	service.TurnStore = failingTurnStore{
		session: agentactivitybiz.Session{WorkspaceID: "ws-1", ID: "session-1", ActiveTurnID: "turn-1"},
		turn:    exactTurn, latestTurn: exactTurn,
	}
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Title:             "Persisted session",
				CreatedAtUnixMS:   1000,
				UpdatedAtUnixMS:   2000,
			},
		},
	}

	result, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{
		TurnID: "turn-1", Content: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("SendInput returned error: %v", err)
	}
	if result.Session.EndedAt != nil {
		t.Fatalf("endedAt = %#v, want nil for accepted input", result.Session.EndedAt)
	}
	if result.Turn == nil || result.Turn.TurnID != "turn-1" || result.Turn.Phase != agentactivitybiz.TurnPhaseSubmitted {
		t.Fatalf("turn = %#v, want exact durable submitted turn", result.Turn)
	}
}

func TestServiceSendInputReportsNodeResults(t *testing.T) {
	runtime := newFakeRuntime()
	reporter := &recordingAgentAnalyticsReporter{}
	service := newIsolatedAgentService(runtime)
	service.AnalyticsReporter = reporter
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				ActiveTurnID:      "turn-1",
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
		"content_normalized",
		"runtime_session_ready",
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
	service := newIsolatedAgentService(runtime)
	service.AnalyticsReporter = reporter
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				ActiveTurnID:      "turn-1",
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

func TestServiceDoesNotReconcileStalePersistedTurnWhenRuntimeSessionIsWorking(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:                "session-1",
		WorkspaceID:       "ws-1",
		Provider:          "codex",
		ProviderSessionID: "provider-session-1",
		Status:            "working",
	}
	service := newIsolatedAgentService(runtime)
	service.RuntimeOperationStore = &runtimeOperationMemoryStore{}
	service.RuntimeOperationOwner = "worker-a"
	service.TurnStore = runtimeOperationTurnStore("turn-1", "permission-1")
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				ActiveTurnID:      "turn-1",
			},
		},
	}

	if _, err := service.SubmitInteractive(
		context.Background(),
		agenthost.InteractionRef{WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1", RequestID: "permission-1"},
		agenthost.SubmitInteractiveInput{OptionID: stringRef("approve")},
	); err != nil {
		t.Fatalf("SubmitInteractive returned error: %v", err)
	}
	if len(runtime.submitInteractiveCalls) != 1 {
		t.Fatalf("submit interactive calls = %#v, want live runtime interactive response", runtime.submitInteractiveCalls)
	}
}

func TestServiceGetDoesNotMutateDurableActiveTurn(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				ActiveTurnID:      "turn-1",
			},
		},
	}

	session, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
	if session.ActiveTurnID != "turn-1" {
		t.Fatalf("active turn id = %q, want durable turn reference preserved", session.ActiveTurnID)
	}
}

func TestServiceGetDoesNotReconcileLiveRuntimeWaitingApprovalTurn(t *testing.T) {
	runtime := newFakeRuntime()
	activeTurnID := "synthetic-turn-1"
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "created",
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &activeTurnID,
			Phase:        "waiting_approval",
		},
	}
	service := newIsolatedAgentService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:          "session-1",
				WorkspaceID: "ws-1",
				Provider:    "claude-code",
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

	_, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
}

func TestServiceEnsureRuntimeSessionDoesNotReconcileLiveRuntimeWaitingApprovalTurn(t *testing.T) {
	runtime := newFakeRuntime()
	activeTurnID := "synthetic-turn-1"
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "created",
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &activeTurnID,
			Phase:        "waiting_approval",
		},
	}
	service := newIsolatedAgentService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:          "session-1",
				WorkspaceID: "ws-1",
				Provider:    "claude-code",
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

	_, err := service.ensureRuntimeSessionResult(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("ensureRuntimeSessionResult returned error: %v", err)
	}
}

func TestServiceEnsureRuntimeSessionDeletesStalePersistedHiddenLiveModelDiscoverySession(t *testing.T) {
	reader := fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:hidden": {
				ID:          "hidden",
				WorkspaceID: "ws-1",
				Provider:    "claude-code",
				Cwd:         "/",
				Metadata:    agentactivitybiz.SessionMetadata{Visible: false},
			},
		},
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = reader

	_, err := service.ensureRuntimeSessionResult(context.Background(), "ws-1", "hidden")
	if !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("ensureRuntimeSessionResult error = %v, want %v", err, ErrSessionNotFound)
	}
	if _, ok := reader.sessions["ws-1:hidden"]; ok {
		t.Fatal("hidden discovery session still persisted, want deleted")
	}
}

func TestServiceGetDoesNotReconcileActionableInteractionFromStaleTranscript(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "created",
	}
	service := newIsolatedAgentService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:          "session-1",
				WorkspaceID: "ws-1",
				Provider:    "claude-code",
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

	_, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
}

func TestServiceResumesPersistedSessionWithPreparedRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	var prepareInput runtimeprep.PrepareInput
	service := newIsolatedAgentService(runtime)
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
		result: runtimeprep.PreparedRuntime{
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
				ActiveTurnID:    "turn-1",
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

func TestServiceResumeClampsPersistedReasoningToSelectedModelCatalog(t *testing.T) {
	runtime := newFakeRuntime()
	var prepareInput runtimeprep.PrepareInput
	service := NewService(runtime)
	service.RuntimePreparer = fakeRuntimePreparer{
		input:  &prepareInput,
		result: runtimeprep.PreparedRuntime{Cwd: "/prepared/workdir"},
	}
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{{
				ID:                         "gpt-5.6-luna",
				DefaultReasoningEffort:     "high",
				ReasoningEffortsAdvertised: true,
				SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
					{Value: "low"}, {Value: "medium"}, {Value: "high"},
				},
			}},
		},
	}
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:          "session-1",
				WorkspaceID: "ws-1",
				Provider:    "codex",
				Cwd:         "/persisted/workdir",
				Settings: ComposerSettings{
					Model:           "gpt-5.6-luna",
					ReasoningEffort: "ultra",
				},
			},
		},
	}

	configureTestApplicationHost(service)
	if _, err := service.SendInput(
		context.Background(),
		"ws-1",
		"session-1",
		SendInput{Content: TextPromptContent("hello")},
	); err != nil {
		t.Fatalf("SendInput returned error: %v", err)
	}
	if prepareInput.ReasoningEffort != "high" {
		t.Fatalf("prepare reasoning effort = %q, want selected model default high", prepareInput.ReasoningEffort)
	}
	if len(runtime.resumeCalls) != 1 || runtime.resumeCalls[0].Settings.ReasoningEffort != "high" {
		t.Fatalf("resume calls = %#v, want selected model default high", runtime.resumeCalls)
	}
}

func TestServiceResumesPersistedSessionWithoutProviderSessionID(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:              "session-1",
				WorkspaceID:     "ws-1",
				Provider:        "codex",
				ActiveTurnID:    "turn-1",
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
	service := newIsolatedAgentService(newFakeRuntime())

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
	mu                     sync.Mutex
	nextID                 int
	canResumeCalls         []RuntimeResumeInput
	canResumeHook          func(RuntimeResumeInput) bool
	cancelCalls            []RuntimeCancelInput
	cancelResult           RuntimeCancelResult
	cancelResultSet        bool
	closeErr               error
	closeCalls             []RuntimeCloseInput
	execErr                error
	execHook               func(RuntimeExecInput) (RuntimeExecResult, error)
	execCalls              []RuntimeExecInput
	provenanceErr          error
	provenanceHook         func(RuntimeSubmitProvenanceInput) error
	provenanceCalls        []RuntimeSubmitProvenanceInput
	goalControlCalls       []RuntimeGoalControlInput
	goalControlHook        func(context.Context, RuntimeGoalControlInput) (RuntimeGoalControlResult, error)
	goalReconcileCalls     []RuntimeGoalControlInput
	goalReconcileHook      func(context.Context, RuntimeGoalControlInput) (RuntimeGoalReconcileResult, error)
	goalRecoveryPolicyHook func(context.Context, RuntimeGoalControlInput) (RuntimeGoalRecoveryPolicy, error)
	resumeCalls            []RuntimeResumeInput
	sessions               map[string]ProviderRuntimeSession
	submitInteractiveCalls []RuntimeSubmitInteractiveInput
	submitInteractiveErr   error
	interactiveDisposition RuntimeInteractiveDisposition
	startErr               error
	startCalls             []RuntimeStartInput
	startHook              func(RuntimeStartInput, ProviderRuntimeSession) ProviderRuntimeSession
	updateSettingsCalls    []RuntimeUpdateSettingsInput
	closeHook              func(RuntimeCloseInput)
	validateErr            error
	validateCalls          []RuntimeExecInput
}

type fakeAgentTargetStore struct {
	err     error
	targets map[string]agenttargetbiz.Target
}

type fakeAgentComposerDefaultsReader map[string]preferencesbiz.AgentComposerDefaults

func (f fakeAgentComposerDefaultsReader) GetAgentComposerDefaultsForTarget(_ context.Context, agentTargetID string) (preferencesbiz.AgentComposerDefaults, error) {
	return f[strings.TrimSpace(agentTargetID)], nil
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
	result       runtimeprep.PreparedRuntime
	err          error
	input        *runtimeprep.PrepareInput
	cleanupCalls *[]runtimeprep.CleanupInput
}

func (f fakeRuntimePreparer) Prepare(_ context.Context, input runtimeprep.PrepareInput) (runtimeprep.PreparedRuntime, error) {
	if f.input != nil {
		*f.input = input
	}
	return f.result, f.err
}

func (f fakeRuntimePreparer) Cleanup(_ context.Context, input runtimeprep.CleanupInput) error {
	if f.cleanupCalls != nil {
		*f.cleanupCalls = append(*f.cleanupCalls, input)
	}
	return nil
}

type fakeSkillBundleRenderer struct {
	fakeRuntimePreparer
	bundle runtimeprep.SkillBundle
	err    error
	input  *runtimeprep.PrepareInput
}

func (f fakeSkillBundleRenderer) RenderSkillBundle(_ context.Context, input runtimeprep.PrepareInput) (runtimeprep.SkillBundle, error) {
	if f.input != nil {
		*f.input = input
	}
	return f.bundle, f.err
}

type fakeModelCatalog struct {
	inputs *([]AgentModelCatalogInput)
	result AgentModelCatalogResult
	err    error
}

func (f fakeModelCatalog) ListModels(_ context.Context, input AgentModelCatalogInput) (AgentModelCatalogResult, error) {
	if f.inputs != nil {
		*f.inputs = append(*f.inputs, input)
	}
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

type isolatedComposerCapabilityLister struct{}

func (isolatedComposerCapabilityLister) ListComposerCapabilityOptions(
	context.Context,
	string,
	string,
	[]ComposerSkillOption,
) ([]ComposerCapabilityOption, []string) {
	return nil, nil
}

// newIsolatedAgentService keeps package tests hermetic. Tests that exercise
// capability discovery replace CapabilityLister with an explicit fixture.
func newUnconfiguredIsolatedAgentService(runtime RuntimeController) *Service {
	service := NewService(runtime)
	service.CapabilityLister = isolatedComposerCapabilityLister{}
	installFakeCanonicalSessionStore(service)
	if fake, ok := runtime.(*fakeRuntime); ok {
		reader := service.SessionReader.(*fakeSessionReader)
		for key, session := range fake.sessions {
			settings := ComposerSettings{}
			if session.Settings != nil {
				settings = *session.Settings
			}
			reader.sessions[key] = PersistedSession{
				ID: session.ID, WorkspaceID: session.WorkspaceID, Provider: session.Provider,
				ProviderSessionID: session.ProviderSessionID, AgentTargetID: session.AgentTargetID,
				Cwd: session.Cwd, Title: session.Title, Settings: settings,
			}
		}
	}
	return service
}

func newIsolatedAgentService(runtime RuntimeController) *Service {
	service := newUnconfiguredIsolatedAgentService(runtime)
	configureTestApplicationHost(service)
	return service
}

func newTestService(runtime RuntimeController) *Service {
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	return service
}

func installFakeCanonicalSessionStore(service *Service) {
	reader := &fakeSessionReader{
		sessions:    map[string]PersistedSession{},
		tombstoned:  map[string]bool{},
		deletedAt:   map[string]int64{},
		parentByKey: map[string]string{},
		children:    map[string][]PersistedSession{},
		runtime:     service.Runtime,
	}
	service.SessionInitializer = fakeSessionInitializer{reader: reader}
	service.SessionReader = reader
}

func seedPersistedLiveSettingsSession(service *Service, session ProviderRuntimeSession) {
	settings := ComposerSettings{}
	if session.Settings != nil {
		settings = *session.Settings
	}
	service.SessionReader = &fakeSessionReader{sessions: map[string]PersistedSession{
		session.WorkspaceID + ":" + session.ID: {
			ID: session.ID, WorkspaceID: session.WorkspaceID, Provider: session.Provider,
			ProviderSessionID: session.ProviderSessionID, Cwd: session.Cwd,
			RailSectionKey: "conversations", Settings: settings,
			CreatedAtUnixMS: 1, UpdatedAtUnixMS: 2, LastEventUnixMS: 2,
		},
	}}
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
	err           error
	providers     []string
	result        []ProviderAvailability
	invalidations []string
	callCount     int
}

func (f *fakeProviderAvailabilityChecker) ListProviderAvailability(_ context.Context, providers []string) ([]ProviderAvailability, error) {
	f.callCount++
	f.providers = append([]string(nil), providers...)
	if f.err != nil {
		return nil, f.err
	}
	return append([]ProviderAvailability(nil), f.result...), nil
}

func (f *fakeProviderAvailabilityChecker) InvalidateProviderAvailability(provider string) {
	f.invalidations = append(f.invalidations, provider)
}

type fakeSessionReader struct {
	sessions    map[string]PersistedSession
	tombstoned  map[string]bool
	deletedAt   map[string]int64
	parentByKey map[string]string
	children    map[string][]PersistedSession
	runtime     RuntimeController
}

type fakeSessionInitializer struct {
	err    error
	reader *fakeSessionReader
}

func (f fakeSessionInitializer) InitializeRuntimeSession(
	_ context.Context,
	session ProviderRuntimeSession,
) (PersistedSession, error) {
	if f.err != nil {
		return PersistedSession{}, f.err
	}
	settings := cloneComposerSettingsPointerValue(session.Settings)
	persisted := PersistedSession{
		ID:                     strings.TrimSpace(session.ID),
		WorkspaceID:            strings.TrimSpace(session.WorkspaceID),
		Kind:                   agentactivitybiz.SessionKindRoot,
		UserID:                 strings.TrimSpace(session.UserID),
		AgentTargetID:          strings.TrimSpace(session.AgentTargetID),
		Provider:               strings.TrimSpace(session.Provider),
		ProviderSessionID:      strings.TrimSpace(session.ProviderSessionID),
		Cwd:                    strings.TrimSpace(session.Cwd),
		RailSectionKey:         "conversations",
		Settings:               settings,
		Metadata:               agentactivitybiz.SessionMetadata{Visible: session.Visible, Capabilities: []string{}},
		InternalRuntimeContext: clonePayload(session.RuntimeContext),
		Title:                  strings.TrimSpace(session.Title),
		PinnedAtUnixMS:         session.PinnedAtUnixMS,
		LastEventUnixMS:        session.UpdatedAtUnixMS,
		StartedAtUnixMS:        session.CreatedAtUnixMS,
		CreatedAtUnixMS:        session.CreatedAtUnixMS,
		UpdatedAtUnixMS:        session.UpdatedAtUnixMS,
	}
	if f.reader != nil {
		f.reader.sessions[persisted.WorkspaceID+":"+persisted.ID] = persisted
	}
	return persisted, nil
}

type fakeAgentSessionResourceReleaser struct {
	released []string
	err      error
}

func (f *fakeAgentSessionResourceReleaser) ReleaseAgent(_ context.Context, agentSessionID string) error {
	f.released = append(f.released, agentSessionID)
	return f.err
}

type fakeSectionReader struct {
	fakeSessionReader
	lastInput                   agentactivitybiz.ListSessionSectionInput
	lastSectionsInput           agentactivitybiz.ListSessionSectionsInput
	lastDeletionCandidatesInput agentactivitybiz.ListSessionSectionDeletionCandidatesInput
	deletionCandidates          agentactivitybiz.SessionSectionDeletionCandidates
	lastBatchDeleteInput        agentactivitybiz.DeleteSessionsBatchInput
	batchDeleteResult           agentactivitybiz.DeleteSessionsBatchResult
	batchDeleteErr              error
	batchDeleteCalls            int
	sectionBatchCalls           int
	singleSectionCalls          int
	sectionBatchErr             error
	singleSectionErr            error
	pages                       map[string]agentactivitybiz.SessionSectionPage
}

func (f *fakeSectionReader) ListSessionSection(_ context.Context, input agentactivitybiz.ListSessionSectionInput) (agentactivitybiz.SessionSectionPage, bool, error) {
	f.singleSectionCalls++
	f.lastInput = input
	if f.singleSectionErr != nil {
		return agentactivitybiz.SessionSectionPage{}, false, f.singleSectionErr
	}
	if f.pages == nil {
		return agentactivitybiz.SessionSectionPage{
			WorkspaceID: input.WorkspaceID,
			SectionKey:  input.SectionKey,
		}, true, nil
	}
	page, ok := f.pages[input.SectionKey]
	if !ok {
		return agentactivitybiz.SessionSectionPage{
			WorkspaceID: input.WorkspaceID,
			SectionKey:  input.SectionKey,
		}, true, nil
	}
	page.WorkspaceID = input.WorkspaceID
	page.SectionKey = input.SectionKey
	return page, true, nil
}

func (f *fakeSectionReader) ListSessionSections(_ context.Context, input agentactivitybiz.ListSessionSectionsInput) (agentactivitybiz.SessionSectionsPage, bool, error) {
	f.sectionBatchCalls++
	f.lastSectionsInput = input
	if f.sectionBatchErr != nil {
		return agentactivitybiz.SessionSectionsPage{}, false, f.sectionBatchErr
	}
	sections := make([]agentactivitybiz.SessionSectionPage, 0, len(input.SectionKeys))
	for _, sectionKey := range input.SectionKeys {
		page, ok := f.pages[sectionKey]
		if !ok {
			page = agentactivitybiz.SessionSectionPage{}
		}
		page.WorkspaceID = input.WorkspaceID
		page.SectionKey = sectionKey
		sections = append(sections, page)
	}
	return agentactivitybiz.SessionSectionsPage{
		WorkspaceID: input.WorkspaceID,
		Sections:    sections,
	}, true, nil
}

func (f *fakeSectionReader) ListSessionSectionDeletionCandidates(_ context.Context, input agentactivitybiz.ListSessionSectionDeletionCandidatesInput) (agentactivitybiz.SessionSectionDeletionCandidates, bool) {
	f.lastDeletionCandidatesInput = input
	result := f.deletionCandidates
	result.WorkspaceID = input.WorkspaceID
	result.SectionKey = input.SectionKey
	result.AgentTargetID = input.AgentTargetID
	result.ExcludePinned = input.ExcludePinned
	return result, true
}

func (f *fakeSectionReader) DeleteSessionsBatch(_ context.Context, input agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsBatchResult, error) {
	f.batchDeleteCalls++
	f.lastBatchDeleteInput = input
	return f.batchDeleteResult, f.batchDeleteErr
}

func (*fakeSectionReader) PlanDeleteSessions(_ context.Context, input agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsPlan, error) {
	return agentactivitybiz.DeleteSessionsPlan{WorkspaceID: input.WorkspaceID, SessionIDs: input.SessionIDs}, nil
}

func (*fakeSectionReader) PlanClearSessions(_ context.Context, workspaceID string) (agentactivitybiz.DeleteSessionsPlan, error) {
	return agentactivitybiz.DeleteSessionsPlan{WorkspaceID: workspaceID}, nil
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
		sessions: make(map[string]ProviderRuntimeSession),
	}
}

func (f *fakeRuntime) Cancel(_ context.Context, input RuntimeCancelInput) (RuntimeCancelResult, error) {
	f.cancelCalls = append(f.cancelCalls, input)
	targetAgentSessionID := input.RootAgentSessionID
	if len(input.Targets) > 0 {
		targetAgentSessionID = input.Targets[len(input.Targets)-1].AgentSessionID
	}
	if f.cancelResultSet {
		if f.cancelResult.AgentSessionID == "" {
			f.cancelResult.AgentSessionID = targetAgentSessionID
		}
		return f.cancelResult, nil
	}
	return RuntimeCancelResult{
		AgentSessionID:   targetAgentSessionID,
		Canceled:         true,
		ConfirmedTargets: append([]RuntimeCancelTarget(nil), input.Targets...),
	}, nil
}

func (f *fakeRuntime) GoalControl(ctx context.Context, input RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
	f.mu.Lock()
	f.goalControlCalls = append(f.goalControlCalls, input)
	hook := f.goalControlHook
	f.mu.Unlock()
	if hook != nil {
		return hook(ctx, input)
	}
	goal := map[string]any(nil)
	if input.Action == "set" {
		goal = map[string]any{"objective": input.Objective, "status": "active"}
	}
	return RuntimeGoalControlResult{
		AgentSessionID: input.AgentSessionID, Goal: goal, ProviderPhase: "accepted",
		Evidence: map[string]any{"phase": "accepted"},
	}, nil
}

func (f *fakeRuntime) ReconcileGoal(ctx context.Context, input RuntimeGoalControlInput) (RuntimeGoalReconcileResult, error) {
	f.mu.Lock()
	f.goalReconcileCalls = append(f.goalReconcileCalls, input)
	hook := f.goalReconcileHook
	f.mu.Unlock()
	if hook != nil {
		return hook(ctx, input)
	}
	return RuntimeGoalReconcileResult{AgentSessionID: input.AgentSessionID,
		Evidence: map[string]any{"confidence": "unknown"}}, nil
}

func (f *fakeRuntime) GoalRecoveryPolicy(ctx context.Context, input RuntimeGoalControlInput) (RuntimeGoalRecoveryPolicy, error) {
	f.mu.Lock()
	hook := f.goalRecoveryPolicyHook
	f.mu.Unlock()
	if hook != nil {
		return hook(ctx, input)
	}
	return RuntimeGoalRecoveryPolicy{QuerySupported: true, ReplaySetAfterRestart: true}, nil
}

func (f *fakeRuntime) Close(_ context.Context, input RuntimeCloseInput) error {
	f.closeCalls = append(f.closeCalls, input)
	err := f.closeErr
	if err == nil {
		delete(f.sessions, input.WorkspaceID+":"+input.AgentSessionID)
	}
	// Hooks observe completion, so publish them only after the fake's state is
	// fully updated. Tests use this callback as the synchronization boundary.
	if f.closeHook != nil {
		f.closeHook(input)
	}
	return err
}

func (f *fakeRuntime) CanResume(input RuntimeResumeInput) bool {
	f.canResumeCalls = append(f.canResumeCalls, input)
	if f.canResumeHook != nil {
		return f.canResumeHook(input)
	}
	return strings.TrimSpace(input.Provider) != ""
}

func (f *fakeRuntime) Exec(_ context.Context, input RuntimeExecInput) (RuntimeExecResult, error) {
	f.execCalls = append(f.execCalls, input)
	if f.execHook != nil {
		return f.execHook(input)
	}
	if f.execErr != nil {
		return RuntimeExecResult{}, f.execErr
	}
	key := input.WorkspaceID + ":" + input.AgentSessionID
	if session, ok := f.sessions[key]; ok {
		session.Status = "working"
		if strings.TrimSpace(input.InitialTitle) != "" &&
			!session.InitialTitleEstablished {
			session.Title = strings.TrimSpace(input.InitialTitle)
			session.InitialTitleEstablished = true
		}
		session.UpdatedAtUnixMS = time.Now().UnixMilli()
		f.sessions[key] = session
	}
	turnID := strings.TrimSpace(input.TurnID)
	if turnID == "" {
		turnID = "turn-1"
	}
	return RuntimeExecResult{
		AgentSessionID: input.AgentSessionID,
		Status:         "started",
		Accepted:       true,
		SessionStatus:  "working",
		TurnID:         turnID,
		TurnLifecycle:  TurnLifecycle{Phase: "submitted"},
	}, nil
}

func (f *fakeRuntime) DurablyReportSubmitProvenance(_ context.Context, input RuntimeSubmitProvenanceInput) error {
	f.provenanceCalls = append(f.provenanceCalls, input)
	if f.provenanceHook != nil {
		return f.provenanceHook(input)
	}
	return f.provenanceErr
}

func (f *fakeRuntime) ValidatePromptContent(_ context.Context, input RuntimeExecInput) error {
	f.validateCalls = append(f.validateCalls, input)
	return f.validateErr
}

func (f *fakeRuntime) SubmitInteractive(_ context.Context, input RuntimeSubmitInteractiveInput) (RuntimeSubmitInteractiveResult, error) {
	f.submitInteractiveCalls = append(f.submitInteractiveCalls, input)
	disposition := f.interactiveDisposition
	if disposition == "" && f.submitInteractiveErr == nil {
		disposition = RuntimeInteractiveDispositionAnswered
	}
	if f.submitInteractiveErr != nil {
		return RuntimeSubmitInteractiveResult{Disposition: disposition}, f.submitInteractiveErr
	}
	return RuntimeSubmitInteractiveResult{Disposition: disposition}, nil
}

func (f *fakeRuntime) InteractiveDisposition(string, string, string, string, string) RuntimeInteractiveDisposition {
	if f.interactiveDisposition == "" {
		return RuntimeInteractiveDispositionUnknown
	}
	return f.interactiveDisposition
}

func (f *fakeRuntime) UpdateSettings(_ context.Context, input RuntimeUpdateSettingsInput) error {
	f.updateSettingsCalls = append(f.updateSettingsCalls, input)
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

func (f *fakeRuntime) Resume(_ context.Context, input RuntimeResumeInput) (ProviderRuntimeSession, error) {
	f.resumeCalls = append(f.resumeCalls, input)
	session := ProviderRuntimeSession{
		ID:                input.AgentSessionID,
		AgentTargetID:     input.AgentTargetID,
		Provider:          input.Provider,
		ProviderSessionID: input.ProviderSessionID,
		Cwd:               input.Cwd,
		Env:               append([]string(nil), input.Env...),
		Settings:          cloneComposerSettingsPointer(&input.Settings),
		Status:            input.Status,
		Title:             input.Title,
		InitialTitleEstablished: initialTitleEstablishedForFakeRuntime(
			input.RuntimeContext,
			input.Title,
		),
		WorkspaceID:     input.WorkspaceID,
		CreatedAtUnixMS: input.CreatedAtUnixMS,
		UpdatedAtUnixMS: input.UpdatedAtUnixMS,
	}
	f.sessions[input.WorkspaceID+":"+input.AgentSessionID] = session
	return session, nil
}

func (f *fakeRuntime) Session(workspaceID string, agentSessionID string) (ProviderRuntimeSession, bool) {
	session, ok := f.sessions[workspaceID+":"+agentSessionID]
	return session, ok
}

func (f *fakeRuntime) SetVisible(_ context.Context, input RuntimeSetVisibleInput) (ProviderRuntimeSession, error) {
	key := input.WorkspaceID + ":" + input.AgentSessionID
	session, ok := f.sessions[key]
	if !ok {
		return ProviderRuntimeSession{}, ErrSessionNotFound
	}
	session.Visible = input.Visible
	session.UpdatedAtUnixMS = time.Now().UnixMilli()
	f.sessions[key] = session
	return session, nil
}

func (f *fakeRuntime) SetTitle(_ context.Context, input RuntimeSetTitleInput) (ProviderRuntimeSession, error) {
	key := input.WorkspaceID + ":" + input.AgentSessionID
	session, ok := f.sessions[key]
	if !ok {
		return ProviderRuntimeSession{}, ErrSessionNotFound
	}
	session.Title = strings.TrimSpace(input.Title)
	session.UpdatedAtUnixMS = time.Now().UnixMilli()
	f.sessions[key] = session
	return session, nil
}

func (f *fakeRuntime) Sessions(workspaceID string) []ProviderRuntimeSession {
	result := make([]ProviderRuntimeSession, 0)
	for _, session := range f.sessions {
		if session.WorkspaceID == workspaceID {
			result = append(result, session)
		}
	}
	return result
}

func (f fakeSessionReader) GetSession(workspaceID string, agentSessionID string) (PersistedSession, bool) {
	key := workspaceID + ":" + agentSessionID
	session, ok := f.sessions[key]
	if !ok && f.runtime != nil {
		if runtimeSession, found := f.runtime.Session(workspaceID, agentSessionID); found {
			session = persistedSessionFromTestRuntime(runtimeSession)
			if canonicalReader, supported := f.runtime.(interface {
				GetSession(context.Context, string, string) (agentactivitybiz.Session, bool, error)
			}); supported {
				canonicalSession, canonicalFound, err := canonicalReader.GetSession(context.Background(), workspaceID, agentSessionID)
				if err == nil && canonicalFound {
					session.Kind = canonicalSession.Kind
					session.RootAgentSessionID = canonicalSession.RootAgentSessionID
				}
			}
			f.sessions[key] = session
			ok = true
		}
	}
	if ok && strings.TrimSpace(session.RailSectionKey) == "" {
		session.RailSectionKey = "conversations"
	}
	return session, ok
}

func persistedSessionFromTestRuntime(session ProviderRuntimeSession) PersistedSession {
	settings := ComposerSettings{}
	if session.Settings != nil {
		settings = *session.Settings
	}
	return PersistedSession{
		ID: session.ID, WorkspaceID: session.WorkspaceID, Kind: agentactivitybiz.SessionKindRoot,
		Provider: session.Provider, ProviderSessionID: session.ProviderSessionID,
		AgentTargetID: session.AgentTargetID, Cwd: session.Cwd, RailSectionKey: "conversations",
		Title: session.Title, Settings: settings, CreatedAtUnixMS: session.CreatedAtUnixMS,
		UpdatedAtUnixMS: session.UpdatedAtUnixMS, LastEventUnixMS: session.UpdatedAtUnixMS,
	}
}

func (f fakeSessionReader) SessionDeleted(_ context.Context, workspaceID string, agentSessionID string) (bool, error) {
	return f.tombstoned[workspaceID+":"+agentSessionID], nil
}

func (f fakeSessionReader) ListSessions(workspaceID string) ([]PersistedSession, bool) {
	result := make([]PersistedSession, 0)
	for _, session := range f.sessions {
		if session.WorkspaceID == workspaceID {
			if strings.TrimSpace(session.RailSectionKey) == "" {
				session.RailSectionKey = "conversations"
			}
			result = append(result, session)
		}
	}
	return result, len(result) > 0
}

func (f fakeSessionReader) ListSessionsPage(
	_ context.Context,
	input agentactivitybiz.ListSessionsPageInput,
) (PersistedSessionListPage, bool, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	if workspaceID == "" {
		return PersistedSessionListPage{}, false, nil
	}
	targetID := strings.TrimSpace(input.AgentTargetID)
	searchTokens := strings.Fields(strings.ToLower(input.SearchQuery))
	sessions := make([]PersistedSession, 0, len(f.sessions))
	for key, session := range f.sessions {
		if strings.TrimSpace(session.WorkspaceID) != workspaceID || f.tombstoned[key] {
			continue
		}
		if kind := strings.TrimSpace(session.Kind); kind != "" && kind != agentactivitybiz.SessionKindRoot {
			continue
		}
		if !session.Metadata.Visible || (targetID != "" && strings.TrimSpace(session.AgentTargetID) != targetID) {
			continue
		}
		title := strings.ToLower(strings.TrimSpace(session.Title))
		matches := true
		for _, token := range searchTokens {
			if !strings.Contains(title, token) {
				matches = false
				break
			}
		}
		if matches {
			if strings.TrimSpace(session.RailSectionKey) == "" {
				session.RailSectionKey = "conversations"
			}
			sessions = append(sessions, session)
		}
	}
	sort.SliceStable(sessions, func(left, right int) bool {
		leftSortTime := fakePersistedSessionConversationSortTime(sessions[left])
		rightSortTime := fakePersistedSessionConversationSortTime(sessions[right])
		if leftSortTime == rightSortTime {
			return strings.TrimSpace(sessions[left].ID) < strings.TrimSpace(sessions[right].ID)
		}
		return leftSortTime > rightSortTime
	})
	if cursorID := strings.TrimSpace(input.CursorSessionID); cursorID != "" {
		start := len(sessions)
		for index, session := range sessions {
			sortTime := fakePersistedSessionConversationSortTime(session)
			if sortTime < input.CursorSortTimeUnixMS ||
				(sortTime == input.CursorSortTimeUnixMS && strings.TrimSpace(session.ID) > cursorID) {
				start = index
				break
			}
		}
		sessions = sessions[start:]
	}
	hasMore := input.Limit > 0 && len(sessions) > input.Limit
	if hasMore {
		sessions = sessions[:input.Limit]
	}
	nextCursor := ""
	if hasMore && len(sessions) > 0 {
		last := sessions[len(sessions)-1]
		nextCursor = strconv.FormatInt(fakePersistedSessionConversationSortTime(last), 10) + "|" + strings.TrimSpace(last.ID)
	}
	return PersistedSessionListPage{Sessions: sessions, HasMore: hasMore, NextCursor: nextCursor}, true, nil
}

func fakePersistedSessionConversationSortTime(session PersistedSession) int64 {
	if session.StartedAtUnixMS > 0 {
		return session.StartedAtUnixMS
	}
	return session.CreatedAtUnixMS
}

func (f fakeSessionReader) ListChildSessions(_ context.Context, workspaceID string, rootAgentSessionID string) ([]PersistedSession, error) {
	return append([]PersistedSession(nil), f.children[workspaceID+":"+rootAgentSessionID]...), nil
}

func (f *fakeSessionReader) UpdateSessionTitle(_ context.Context, workspaceID string, agentSessionID string, title string) (PersistedSession, bool, error) {
	key := workspaceID + ":" + agentSessionID
	session, ok := f.sessions[key]
	if !ok {
		return PersistedSession{}, false, nil
	}
	session.Title = strings.TrimSpace(title)
	session.UpdatedAtUnixMS = time.Now().UnixMilli()
	f.sessions[key] = session
	return session, true, nil
}

func (f *fakeSessionReader) UpdateSessionSettings(_ context.Context, workspaceID string, agentSessionID string, settings ComposerSettings) (PersistedSession, bool, error) {
	key := workspaceID + ":" + agentSessionID
	session, ok := f.sessions[key]
	if !ok {
		return PersistedSession{}, false, nil
	}
	session.Settings = settings
	session.UpdatedAtUnixMS = time.Now().UnixMilli()
	f.sessions[key] = session
	return session, true, nil
}

func (f *fakeSessionReader) UpdateSessionPinned(_ context.Context, workspaceID string, agentSessionID string, pinned bool) (PersistedSession, bool, error) {
	key := workspaceID + ":" + agentSessionID
	session, ok := f.sessions[key]
	if !ok {
		return PersistedSession{}, false, nil
	}
	session.PinnedAtUnixMS = 0
	if pinned {
		session.PinnedAtUnixMS = time.Now().UnixMilli()
	}
	session.UpdatedAtUnixMS = time.Now().UnixMilli()
	f.sessions[key] = session
	return session, true, nil
}

func (f fakeSessionReader) PlanDeleteSessions(_ context.Context, input agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsPlan, error) {
	ids := make([]string, 0, len(input.SessionIDs))
	for _, sessionID := range input.SessionIDs {
		if _, ok := f.sessions[input.WorkspaceID+":"+sessionID]; ok {
			ids = append(ids, sessionID)
		}
	}
	slices.Sort(ids)
	return agentactivitybiz.DeleteSessionsPlan{WorkspaceID: input.WorkspaceID, SessionIDs: ids}, nil
}

func (f fakeSessionReader) PlanClearSessions(_ context.Context, workspaceID string) (agentactivitybiz.DeleteSessionsPlan, error) {
	ids := make([]string, 0)
	for _, session := range f.sessions {
		if session.WorkspaceID == workspaceID {
			ids = append(ids, session.ID)
		}
	}
	slices.Sort(ids)
	return agentactivitybiz.DeleteSessionsPlan{WorkspaceID: workspaceID, SessionIDs: ids}, nil
}

func (f fakeSessionReader) DeleteSessionsBatch(_ context.Context, input agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsBatchResult, error) {
	removed := make([]string, 0, len(input.ExpectedSessionIDs))
	for _, sessionID := range input.ExpectedSessionIDs {
		key := input.WorkspaceID + ":" + sessionID
		if _, ok := f.sessions[key]; !ok {
			continue
		}
		delete(f.sessions, key)
		removed = append(removed, sessionID)
	}
	return agentactivitybiz.DeleteSessionsBatchResult{RemovedSessions: len(removed), RemovedSessionIDs: removed}, nil
}

func (f fakeSessionReader) PurgeDeletedSessions(_ context.Context, input agentactivitybiz.PurgeDeletedSessionsInput) (agentactivitybiz.PurgeDeletedSessionsResult, error) {
	result := agentactivitybiz.PurgeDeletedSessionsResult{}
	limit := input.MaxSessions
	if limit <= 0 {
		limit = 25
	}
	candidateKeys := make([]string, 0)
	for key, deleted := range f.tombstoned {
		if !deleted || input.CutoffUnixMS <= 0 {
			continue
		}
		deletedAt := f.deletedAt[key]
		if deletedAt <= 0 {
			deletedAt = 1
		}
		if deletedAt > input.CutoffUnixMS {
			continue
		}
		blocked := false
		for childKey := range f.sessions {
			if f.parentByKey[childKey] == key {
				blocked = true
				break
			}
		}
		if blocked {
			continue
		}
		candidateKeys = append(candidateKeys, key)
	}
	slices.Sort(candidateKeys)
	if len(candidateKeys) > limit {
		candidateKeys = candidateKeys[:limit]
	}
	for _, key := range candidateKeys {
		session := f.sessions[key]
		deletedAt := f.deletedAt[key]
		if deletedAt <= 0 {
			deletedAt = 1
		}
		delete(f.sessions, key)
		delete(f.tombstoned, key)
		delete(f.deletedAt, key)
		delete(f.parentByKey, key)
		result.Sessions = append(result.Sessions, agentactivitybiz.PurgedSession{
			WorkspaceID: session.WorkspaceID, AgentSessionID: session.ID,
			DeletedAtUnixMS: deletedAt,
		})
	}
	for key, deleted := range f.tombstoned {
		deletedAt := f.deletedAt[key]
		if deletedAt <= 0 {
			deletedAt = 1
		}
		if !deleted || deletedAt > input.CutoffUnixMS {
			continue
		}
		blocked := false
		for childKey := range f.sessions {
			if f.parentByKey[childKey] == key {
				blocked = true
				break
			}
		}
		if !blocked {
			result.HasMore = true
			break
		}
	}
	return result, nil
}

func (f *fakeRuntime) Start(_ context.Context, input RuntimeStartInput) (ProviderRuntimeSession, error) {
	f.startCalls = append(f.startCalls, input)
	if f.startErr != nil {
		return ProviderRuntimeSession{}, f.startErr
	}
	f.nextID++
	now := time.Now().UnixMilli()
	id := strings.TrimSpace(input.AgentSessionID)
	if id == "" {
		id = "session-" + string(rune('0'+f.nextID))
	}
	if existing, ok := f.sessions[input.WorkspaceID+":"+id]; ok {
		return existing, nil
	}
	session := ProviderRuntimeSession{
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
		Status: "ready",
		Title:  input.Title,
		InitialTitleEstablished: input.InitialTitleEstablished ||
			titletext.Normalize(input.Title) != "",
		Visible:         input.Visible == nil || *input.Visible,
		RuntimeContext:  clonePayload(input.RuntimeContext),
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

func initialTitleEstablishedForFakeRuntime(
	runtimeContext map[string]any,
	title string,
) bool {
	if strings.TrimSpace(title) != "" {
		return true
	}
	if established, ok := runtimeContext["tuttiInitialTitleEstablished"].(bool); ok {
		return established
	}
	return true
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
	clearResult    agentactivitybiz.ClearSessionsResult
	settleStaleErr error
	settlements    []agentactivitybiz.StaleTurnSettlement
	stateResult    agentactivitybiz.StateReportResult
	stateInput     agentactivitybiz.SessionStateReport
	messageInput   agentactivitybiz.SessionMessageReport
	messageResult  agentactivitybiz.MessageReportResult
	messagePage    agentactivitybiz.MessagePage
	messagePageOK  bool
	messagePageErr error
	turnResult     agentactivitybiz.Turn
	turnResults    map[string]agentactivitybiz.Turn
	turnFound      bool
	turnErr        error
	sectionsPage   agentactivitybiz.SessionSectionsPage
	sectionsOK     bool
	sectionsErr    error
}

func (r *activityProjectionRepoStub) ClearSessions(context.Context, string) (agentactivitybiz.ClearSessionsResult, error) {
	return r.clearResult, nil
}

func (*activityProjectionRepoStub) GetSession(context.Context, string, string) (agentactivitybiz.Session, bool, error) {
	return agentactivitybiz.Session{}, false, nil
}

func (*activityProjectionRepoStub) ListChildSessions(context.Context, string, string) ([]agentactivitybiz.Session, error) {
	return nil, nil
}

func (*activityProjectionRepoStub) SessionDeleted(context.Context, string, string) (bool, error) {
	return false, nil
}

func (*activityProjectionRepoStub) ListSessions(context.Context, string) ([]agentactivitybiz.Session, bool, error) {
	return nil, false, nil
}

func (*activityProjectionRepoStub) ListSessionsPage(context.Context, agentactivitybiz.ListSessionsPageInput) (agentactivitybiz.SessionListPage, bool, error) {
	return agentactivitybiz.SessionListPage{}, false, nil
}

func (*activityProjectionRepoStub) ListSessionSection(context.Context, agentactivitybiz.ListSessionSectionInput) (agentactivitybiz.SessionSectionPage, bool, error) {
	return agentactivitybiz.SessionSectionPage{}, false, nil
}

func (r *activityProjectionRepoStub) ListSessionSections(context.Context, agentactivitybiz.ListSessionSectionsInput) (agentactivitybiz.SessionSectionsPage, bool, error) {
	return r.sectionsPage, r.sectionsOK, r.sectionsErr
}

func (*activityProjectionRepoStub) ListSessionSectionDeletionCandidates(context.Context, agentactivitybiz.ListSessionSectionDeletionCandidatesInput) (agentactivitybiz.SessionSectionDeletionCandidates, bool, error) {
	return agentactivitybiz.SessionSectionDeletionCandidates{}, false, nil
}

func (*activityProjectionRepoStub) DeleteSessionsBatch(context.Context, agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsBatchResult, error) {
	return agentactivitybiz.DeleteSessionsBatchResult{}, nil
}

func (*activityProjectionRepoStub) PlanDeleteSessions(_ context.Context, input agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsPlan, error) {
	return agentactivitybiz.DeleteSessionsPlan{WorkspaceID: input.WorkspaceID, SessionIDs: input.SessionIDs}, nil
}

func (*activityProjectionRepoStub) PlanClearSessions(_ context.Context, workspaceID string) (agentactivitybiz.DeleteSessionsPlan, error) {
	return agentactivitybiz.DeleteSessionsPlan{WorkspaceID: workspaceID}, nil
}

func (r *activityProjectionRepoStub) ListSessionMessages(context.Context, agentactivitybiz.ListSessionMessagesInput) (agentactivitybiz.MessagePage, bool, error) {
	return r.messagePage, r.messagePageOK, r.messagePageErr
}

func (*activityProjectionRepoStub) ListWorkspaceGeneratedFileTurns(context.Context, agentactivitybiz.ListWorkspaceGeneratedFileTurnsInput) (agentactivitybiz.GeneratedFileTurnList, bool, error) {
	return agentactivitybiz.GeneratedFileTurnList{}, false, nil
}

func (r *activityProjectionRepoStub) ReportSessionMessages(_ context.Context, input agentactivitybiz.SessionMessageReport) (agentactivitybiz.MessageReportResult, error) {
	r.messageInput = input
	return r.messageResult, nil
}

func (r *activityProjectionRepoStub) ReportSessionState(_ context.Context, input agentactivitybiz.SessionStateReport) (agentactivitybiz.StateReportResult, error) {
	r.stateInput = input
	return r.stateResult, nil
}

func (r *activityProjectionRepoStub) ReportActivityState(_ context.Context, input agentactivitybiz.ActivityStateReport) (agentactivitybiz.ActivityStateReportResult, error) {
	r.stateInput = input.Session
	result := agentactivitybiz.ActivityStateReportResult{State: r.stateResult}
	if input.Turn != nil {
		result.Turn = agentactivitybiz.Turn{
			WorkspaceID:    input.Turn.WorkspaceID,
			AgentSessionID: input.Turn.AgentSessionID,
			TurnID:         input.Turn.TurnID,
			Phase:          input.Turn.Phase,
			Outcome:        input.Turn.Outcome,
		}
		result.TurnAccepted = true
	}
	if input.Interaction != nil {
		result.Interaction = agentactivitybiz.Interaction{
			WorkspaceID:    input.Interaction.WorkspaceID,
			AgentSessionID: input.Interaction.AgentSessionID,
			RequestID:      input.Interaction.RequestID,
			TurnID:         input.Interaction.TurnID,
			Kind:           input.Interaction.Kind,
			Status:         input.Interaction.Status,
		}
		result.InteractionResult = agentactivitybiz.InteractionTransitionApplied
	}
	return result, nil
}

func (*activityProjectionRepoStub) UpdateSessionPinned(context.Context, string, string, bool) (agentactivitybiz.Session, bool, error) {
	return agentactivitybiz.Session{}, false, nil
}

func (*activityProjectionRepoStub) UpdateSessionSettings(context.Context, string, string, string, map[string]any) (agentactivitybiz.Session, bool, error) {
	return agentactivitybiz.Session{}, false, nil
}

func (*activityProjectionRepoStub) UpdateSessionTitle(context.Context, string, string, string) (agentactivitybiz.Session, bool, error) {
	return agentactivitybiz.Session{}, false, nil
}

func (r *activityProjectionRepoStub) GetTurn(_ context.Context, _ string, agentSessionID string, turnID string) (agentactivitybiz.Turn, bool, error) {
	if r.turnResults != nil {
		turn, ok := r.turnResults[agentSessionID+"\x00"+turnID]
		return turn, ok, r.turnErr
	}
	return r.turnResult, r.turnFound, r.turnErr
}

func (*activityProjectionRepoStub) GetLatestTurn(context.Context, string, string) (agentactivitybiz.Turn, bool, error) {
	return agentactivitybiz.Turn{}, false, nil
}

func (*activityProjectionRepoStub) ListLatestTurns(context.Context, string, []string) (map[string]agentactivitybiz.Turn, error) {
	return map[string]agentactivitybiz.Turn{}, nil
}

func (*activityProjectionRepoStub) ListTurnsBySession(context.Context, string, map[string]string) (map[string]agentactivitybiz.Turn, error) {
	return map[string]agentactivitybiz.Turn{}, nil
}

func (*activityProjectionRepoStub) ListPendingInteractionsBySession(context.Context, string, []string) (map[string][]agentactivitybiz.Interaction, error) {
	return map[string][]agentactivitybiz.Interaction{}, nil
}

func (*activityProjectionRepoStub) ListLatestTurnInteractions(context.Context, string, []string) (map[string][]agentactivitybiz.Interaction, error) {
	return map[string][]agentactivitybiz.Interaction{}, nil
}

func (*activityProjectionRepoStub) PrepareRuntimeOperation(context.Context, agentactivitybiz.RuntimeOperationPrepare) (agentactivitybiz.RuntimeOperation, bool, error) {
	return agentactivitybiz.RuntimeOperation{}, false, nil
}

func (*activityProjectionRepoStub) PrepareInteractiveRuntimeOperation(context.Context, agentactivitybiz.RuntimeOperationPrepare) (agentactivitybiz.RuntimeOperation, agentactivitybiz.Interaction, agentactivitybiz.InteractionTransitionResult, error) {
	return agentactivitybiz.RuntimeOperation{}, agentactivitybiz.Interaction{}, agentactivitybiz.InteractionTransitionConflict, nil
}

func (*activityProjectionRepoStub) GetRuntimeOperation(context.Context, string, string) (agentactivitybiz.RuntimeOperation, bool, error) {
	return agentactivitybiz.RuntimeOperation{}, false, nil
}

func (*activityProjectionRepoStub) ListClaimableRuntimeOperations(context.Context, agentactivitybiz.ListClaimableRuntimeOperationsInput) ([]agentactivitybiz.RuntimeOperation, error) {
	return nil, nil
}

func (*activityProjectionRepoStub) ClaimRuntimeOperationLease(context.Context, agentactivitybiz.ClaimRuntimeOperationLeaseInput) (agentactivitybiz.RuntimeOperation, bool, error) {
	return agentactivitybiz.RuntimeOperation{}, false, nil
}

func (*activityProjectionRepoStub) ReleaseOrFailRuntimeOperation(context.Context, agentactivitybiz.ReleaseOrFailRuntimeOperationInput) (agentactivitybiz.RuntimeOperation, bool, error) {
	return agentactivitybiz.RuntimeOperation{}, false, nil
}

func (*activityProjectionRepoStub) RequeueLeasedRuntimeOperationsOnStartup(context.Context, int64) (int64, error) {
	return 0, nil
}

func (*activityProjectionRepoStub) CompleteInteractiveRuntimeOperation(context.Context, agentactivitybiz.CompleteInteractiveRuntimeOperationInput) (agentactivitybiz.RuntimeOperationCompletion, bool, error) {
	return agentactivitybiz.RuntimeOperationCompletion{}, false, nil
}

func (*activityProjectionRepoStub) CompleteCancelRuntimeOperation(context.Context, agentactivitybiz.CompleteCancelRuntimeOperationInput) (agentactivitybiz.RuntimeOperationCompletion, bool, error) {
	return agentactivitybiz.RuntimeOperationCompletion{}, false, nil
}

func (*activityProjectionRepoStub) ListPendingRuntimeOperationEvents(context.Context, string, int) ([]agentactivitybiz.RuntimeOperationEvent, error) {
	return nil, nil
}

func (*activityProjectionRepoStub) MarkRuntimeOperationEventPublished(context.Context, string, int64, int64) (bool, error) {
	return false, nil
}

func (*activityProjectionRepoStub) ListSessionTurns(context.Context, string, string) ([]agentactivitybiz.Turn, error) {
	return nil, nil
}

func (*activityProjectionRepoStub) RecordTurnTransition(_ context.Context, transition agentactivitybiz.TurnTransition) (agentactivitybiz.Turn, bool, error) {
	return agentactivitybiz.Turn{
		WorkspaceID:    transition.WorkspaceID,
		AgentSessionID: transition.AgentSessionID,
		TurnID:         transition.TurnID,
		Phase:          transition.Phase,
		Outcome:        transition.Outcome,
	}, true, nil
}

func (r *activityProjectionRepoStub) SettleStaleTurns(context.Context) ([]agentactivitybiz.StaleTurnSettlement, error) {
	return append([]agentactivitybiz.StaleTurnSettlement(nil), r.settlements...), r.settleStaleErr
}

func (*activityProjectionRepoStub) UpsertInteraction(_ context.Context, upsert agentactivitybiz.InteractionUpsert) (agentactivitybiz.Interaction, agentactivitybiz.InteractionTransitionResult, error) {
	return agentactivitybiz.Interaction{
		WorkspaceID:    upsert.WorkspaceID,
		AgentSessionID: upsert.AgentSessionID,
		RequestID:      upsert.RequestID,
		TurnID:         upsert.TurnID,
		Kind:           upsert.Kind,
		Status:         upsert.Status,
	}, agentactivitybiz.InteractionTransitionApplied, nil
}

func (*activityProjectionRepoStub) ListSessionInteractions(context.Context, agentactivitybiz.ListSessionInteractionsInput) ([]agentactivitybiz.Interaction, error) {
	return nil, nil
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
