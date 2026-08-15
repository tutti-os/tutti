package agent

import (
	"context"
	"errors"
	"strings"
	"testing"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
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

func TestServiceCreateAppliesCodexSaverModeWithoutChangingMainModel(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.AgentComposerDefaultsReader = fakeAgentComposerDefaultsReader{
		agenttargetbiz.IDLocalCodex: {CodexSaverMode: true},
	}
	mainModel := "gpt-5.6-sol"
	if _, err := service.Create(context.Background(), "ws-saver", CreateSessionInput{
		AgentSessionID:        "13131313-1313-4131-8131-131313131313",
		AgentTargetID:         agenttargetbiz.IDLocalCodex,
		Model:                 &mainModel,
		CodexSaverModeAllowed: true,
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if len(runtime.startCalls) != 1 || !runtime.startCalls[0].CodexSaverMode || runtime.startCalls[0].Model != mainModel {
		t.Fatalf("runtime starts = %#v", runtime.startCalls)
	}

	enabled := true
	if _, err := service.Create(context.Background(), "ws-saver", CreateSessionInput{
		AgentSessionID: "14141414-1414-4141-8141-141414141414",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		CodexSaverMode: &enabled,
	}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("Create() error = %v, want gated invalid argument", err)
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

// TestServiceCreateGeneratesClientSubmitIDForSubmitProvenance 守住 agent start
// 的回归：调用方未提供 ClientSubmitID 时，service 层必须兜底生成一个，否则下游
// submit provenance（要求 ClientSubmitID 非空，见 controller_submit_provenance.go）
// 会让已创建的会话误报 ErrSubmitDeliveryUnknown。provenanceHook 复刻真实 Controller
// 的四元组非空校验。
func TestServiceCreateGeneratesClientSubmitIDForSubmitProvenance(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-provenance", Name: "Provenance"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	projectPath := t.TempDir()
	if canonical, ok := canonicalExistingDir(projectPath); ok {
		projectPath = canonical
	}
	if _, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:         "project-provenance",
		Path:       projectPath,
		Label:      "Project",
		SectionKey: userprojectbiz.SectionKeyFromPath(projectPath),
	}); err != nil {
		t.Fatalf("PutUserProject error = %v", err)
	}
	runtime := newFakeRuntime()
	runtime.provenanceHook = func(input RuntimeSubmitProvenanceInput) error {
		if input.WorkspaceID == "" || input.AgentSessionID == "" || input.TurnID == "" || input.ClientSubmitID == "" {
			return errors.New("workspace id, agent session id, turn id, and client submit id are required")
		}
		return nil
	}
	service := newTestService(runtime)
	projection := NewActivityProjection(store)
	service.SessionInitializer = projection
	service.SessionReader = projection
	service.SubmitClaimStore = store

	created, err := service.CreateWithResult(ctx, "ws-provenance", CreateSessionInput{
		AgentSessionID: "33333333-3333-4333-8333-333333333333",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Provider:       "codex",
		Cwd:            stringRef(projectPath),
		InitialContent: TextPromptContent("hello"),
		// 故意不传 ClientSubmitID，也不传 legacy metadata
	})
	if err != nil {
		t.Fatalf("CreateWithResult returned error: %v (兜底生成的 ClientSubmitID 应让 submit provenance 通过)", err)
	}
	if created.TurnID == "" {
		t.Fatal("CreateWithResult returned an empty turnId")
	}
	if len(runtime.provenanceCalls) != 1 {
		t.Fatalf("provenance calls = %d, want 1", len(runtime.provenanceCalls))
	}
	submitID := runtime.provenanceCalls[0].ClientSubmitID
	if submitID == "" {
		t.Fatal("provenance 收到空 ClientSubmitID，service 层兜底未生效")
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
	}
	if runtime.execCalls[0].ClientSubmitID != submitID {
		t.Fatalf("exec ClientSubmitID = %q, provenance ClientSubmitID = %q, 应一致", runtime.execCalls[0].ClientSubmitID, submitID)
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
		return
	}
	if got := visibleStart.Provider; got != "claude-code" {
		t.Fatalf("runtime provider = %q, want claude-code", got)
	}
	if got := visibleStart.AgentTargetID; got != agenttargetbiz.IDLocalClaudeCode {
		t.Fatalf("runtime agent target id = %q, want %s", got, agenttargetbiz.IDLocalClaudeCode)
	}
	ref := visibleStart.ProviderTargetRef
	if ref["kind"] != agenttargetbiz.LaunchRefTypeBuiltinLocal ||
		ref["provider"] != "claude-code" ||
		ref["targetId"] != agenttargetbiz.IDLocalClaudeCode {
		t.Fatalf("runtime provider target ref = %#v, want daemon-derived builtin_local claude target", ref)
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
		"cwd_resolved",
		"model_validated",
		"runtime_prepared",
		"runtime_started",
		"session_persisted",
		"session_published",
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
