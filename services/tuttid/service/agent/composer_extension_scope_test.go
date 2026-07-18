package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

func TestComposerLiveModelScopeUsesExactTargetProjectInstallationAndSettings(t *testing.T) {
	project := t.TempDir()
	alias := filepath.Join(t.TempDir(), "project-link")
	if err := os.Symlink(project, alias); err != nil {
		t.Fatalf("create project symlink: %v", err)
	}
	input := ComposerOptionsInput{
		Provider:      "acp:example",
		WorkspaceID:   "workspace-1",
		Cwd:           project + string(filepath.Separator),
		AgentTargetID: "extension:example-a",
		providerTargetRef: map[string]any{
			"kind":                    "agent_extension",
			"extensionInstallationId": "example@1.0.0",
		},
	}
	settings := ComposerSettings{PermissionModeID: "ask-before-write"}
	scope := newComposerLiveModelScopeForInput(input, settings)

	aliasInput := input
	aliasInput.Cwd = alias
	if got := newComposerLiveModelScopeForInput(aliasInput, settings).key(); got != scope.key() {
		t.Fatalf("normalized project alias key = %q, want %q", got, scope.key())
	}

	mutations := []struct {
		name   string
		mutate func(*ComposerOptionsInput, *ComposerSettings)
	}{
		{"workspace", func(input *ComposerOptionsInput, _ *ComposerSettings) { input.WorkspaceID = "workspace-2" }},
		{"target", func(input *ComposerOptionsInput, _ *ComposerSettings) { input.AgentTargetID = "extension:example-b" }},
		{"project", func(input *ComposerOptionsInput, _ *ComposerSettings) { input.Cwd = t.TempDir() }},
		{"installation", func(input *ComposerOptionsInput, _ *ComposerSettings) {
			input.providerTargetRef["extensionInstallationId"] = "example@2.0.0"
		}},
		{"settings", func(_ *ComposerOptionsInput, settings *ComposerSettings) { settings.PermissionModeID = "full-access" }},
	}
	for _, tt := range mutations {
		t.Run(tt.name, func(t *testing.T) {
			candidate := input
			candidate.providerTargetRef = clonePayload(input.providerTargetRef)
			candidateSettings := settings
			tt.mutate(&candidate, &candidateSettings)
			if got := newComposerLiveModelScopeForInput(candidate, candidateSettings).key(); got == scope.key() {
				t.Fatalf("scope key did not change for %s", tt.name)
			}
		})
	}
}

func TestComposerRuntimeContextSelectsNewestExactLiveSession(t *testing.T) {
	project := t.TempDir()
	settings := ComposerSettings{PermissionModeID: "ask-before-write"}
	ref := map[string]any{"kind": "agent_extension", "extensionInstallationId": "example@1.0.0"}
	scope := newComposerLiveModelScopeForInput(ComposerOptionsInput{
		Provider:          "acp:example",
		WorkspaceID:       "workspace-1",
		Cwd:               project,
		AgentTargetID:     "extension:example-a",
		providerTargetRef: ref,
	}, settings)
	runtime := newFakeRuntime()
	add := func(id, target, cwd, installation, marker string, updated int64) {
		context := stampAgentExtensionComposerScope(map[string]any{
			"availableCommands": []any{map[string]any{"name": marker}},
		}, map[string]any{"kind": "agent_extension", "extensionInstallationId": installation}, cwd, settings)
		runtime.sessions["workspace-1:"+id] = ProviderRuntimeSession{
			ID: id, WorkspaceID: "workspace-1", Provider: "acp:example", AgentTargetID: target,
			RuntimeContext: context, UpdatedAtUnixMS: updated,
		}
	}
	add("exact-old", "extension:example-a", project, "example@1.0.0", "old", 100)
	add("exact-new", "extension:example-a", project, "example@1.0.0", "new", 200)
	add("wrong-target", "extension:example-b", project, "example@1.0.0", "wrong-target", 500)
	add("wrong-project", "extension:example-a", t.TempDir(), "example@1.0.0", "wrong-project", 500)
	add("wrong-installation", "extension:example-a", project, "example@2.0.0", "wrong-installation", 500)

	context := newIsolatedAgentService(runtime).composerRuntimeContextFromSession(scope)
	commands := composerCommandsFromRuntimeContext(context)
	if len(commands) != 1 || commands[0]["name"] != "new" {
		t.Fatalf("selected commands = %#v, want newest exact live session", commands)
	}
}

func TestComposerRuntimeContextPersistedFallbackRequiresPinnedIdentity(t *testing.T) {
	project := t.TempDir()
	settings := ComposerSettings{ReasoningEffort: "high"}
	ref := map[string]any{"kind": "agent_extension", "extensionInstallationId": "example@1.0.0"}
	scope := newComposerLiveModelScopeForInput(ComposerOptionsInput{
		Provider:          "acp:example",
		WorkspaceID:       "workspace-1",
		Cwd:               project,
		AgentTargetID:     "extension:example",
		providerTargetRef: ref,
	}, settings)
	exact := stampAgentExtensionComposerScope(map[string]any{
		"capabilities": []any{"compact"},
	}, ref, project, settings)
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{sessions: map[string]PersistedSession{
		"workspace-1:legacy": {
			ID: "legacy", WorkspaceID: "workspace-1", Provider: "acp:example", AgentTargetID: "extension:example",
			InternalRuntimeContext: map[string]any{"capabilities": []any{"planMode"}}, UpdatedAtUnixMS: 500,
		},
		"workspace-1:wrong-target": {
			ID: "wrong-target", WorkspaceID: "workspace-1", Provider: "acp:example", AgentTargetID: "extension:other",
			InternalRuntimeContext: exact, UpdatedAtUnixMS: 600,
		},
		"workspace-1:exact": {
			ID: "exact", WorkspaceID: "workspace-1", Provider: "acp:example", AgentTargetID: "extension:example",
			InternalRuntimeContext: exact, UpdatedAtUnixMS: 100,
		},
	}}

	context := service.composerRuntimeContextFromSession(scope)
	if got := stringSliceFromAny(context["capabilities"]); !slices.Equal(got, []string{"compact"}) {
		t.Fatalf("persisted capabilities = %#v, want exact pinned context", got)
	}
}

func TestExtensionCapabilitiesRemainUnknownWithoutLiveRuntimeFacts(t *testing.T) {
	options := applyExtensionComposerCapabilities(ComposerOptions{
		RuntimeContext: map[string]any{},
	}, ExtensionComposerProfile{Capabilities: []string{"compact", "planMode"}})
	if len(options.Capabilities) != 0 {
		t.Fatalf("capabilities = %#v, want no fabricated signed-only runtime facts", options.Capabilities)
	}
}

func TestExtensionCreatePreservesSignedSemanticAndLiveReasoningSelections(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.startHook = func(input RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		if input.Visible == nil || *input.Visible {
			return session
		}
		runtimeContext := clonePayload(session.RuntimeContext)
		runtimeContext["configOptions"] = []any{
			map[string]any{
				"id": "model-choice",
				"options": []any{
					map[string]any{"value": "example-pro", "name": "Example Pro"},
				},
			},
			map[string]any{
				"id": "thought-level",
				"options": []any{
					map[string]any{"value": "deep", "name": "Deep"},
				},
			},
		}
		session.RuntimeContext = runtimeContext
		return session
	}
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: map[string]agenttargetbiz.Target{
		"extension:example": {
			ID: "extension:example", Name: "Example Agent", Provider: "acp:example", Enabled: true,
			Source:        agenttargetbiz.SourceSystem,
			LaunchRefJSON: `{"type":"agent_extension","extensionInstallationId":"example@1.0.0"}`,
		},
	}}
	service.ExtensionComposerProfiles = extensionComposerProfileResolverStub{
		profile: ExtensionComposerProfile{
			ModelConfigOptionID:     "model-choice",
			ReasoningConfigOptionID: "thought-level",
			PermissionModes: []ExtensionComposerPermissionMode{
				{RuntimeID: "full-access", Semantic: PermissionModeSemanticFullAccess},
			},
		},
	}
	permission := "full-access"
	reasoning := "deep"
	model := "example-pro"
	_, err := service.Create(context.Background(), "workspace-1", CreateSessionInput{
		AgentTargetID:    "extension:example",
		Provider:         "acp:example",
		Cwd:              stringPointer(t.TempDir()),
		PermissionModeID: &permission,
		ReasoningEffort:  &reasoning,
		Model:            &model,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	visibleStarts := visibleRuntimeStarts(runtime.startCalls)
	if len(visibleStarts) != 1 {
		t.Fatalf("visible start calls = %#v, want one", visibleStarts)
	}
	started := visibleStarts[0]
	if started.PermissionModeID != permission || started.ReasoningEffort != reasoning || started.Model != model {
		t.Fatalf("start settings = permission %q reasoning %q model %q", started.PermissionModeID, started.ReasoningEffort, started.Model)
	}
}

func TestExtensionResumePreservesRuntimeAdvertisedReasoningSelection(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: map[string]agenttargetbiz.Target{
		"extension:example": {
			ID: "extension:example", Name: "Example Agent", Provider: "acp:example", Enabled: true,
			Source:        agenttargetbiz.SourceSystem,
			LaunchRefJSON: `{"type":"agent_extension","extensionInstallationId":"example@1.0.0"}`,
		},
	}}
	service.SessionReader = fakeSessionReader{sessions: map[string]PersistedSession{
		"workspace-1:session-1": {
			ID: "session-1", WorkspaceID: "workspace-1", AgentTargetID: "extension:example", Provider: "acp:example",
			Cwd: t.TempDir(), Settings: ComposerSettings{Model: "example-pro", PermissionModeID: "full-access", ReasoningEffort: "deep"},
		},
	}}

	if _, err := service.SendInput(context.Background(), "workspace-1", "session-1", SendInput{Content: TextPromptContent("continue")}); err != nil {
		t.Fatalf("SendInput() error = %v", err)
	}
	if len(runtime.resumeCalls) != 1 {
		t.Fatalf("resume calls = %#v, want one", runtime.resumeCalls)
	}
	settings := runtime.resumeCalls[0].Settings
	if runtime.resumeCalls[0].AgentTargetID != "extension:example" {
		t.Fatalf("resume agentTargetId = %q, want exact persisted Target", runtime.resumeCalls[0].AgentTargetID)
	}
	if settings.Model != "example-pro" || settings.PermissionModeID != "full-access" || settings.ReasoningEffort != "deep" {
		t.Fatalf("resume settings = %#v, want preserved extension selections", settings)
	}
}

func TestExtensionHiddenComposerDiscoveryIsSingleFlightAndClosesSession(t *testing.T) {
	runtime := newFakeRuntime()
	started := make(chan struct{})
	release := make(chan struct{})
	runtime.startHook = func(_ RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		close(started)
		<-release
		session.RuntimeContext["configOptions"] = []any{map[string]any{
			"id": "model", "currentValue": "example-pro",
			"options": []any{map[string]any{"value": "example-pro", "name": "Example Pro"}},
		}}
		return session
	}
	service := newIsolatedAgentService(runtime)
	input := extensionComposerDiscoveryInput(t.TempDir())

	type result struct {
		models []ComposerConfigOptionValue
		err    error
	}
	results := make(chan result, 2)
	go func() {
		models, err := service.discoverLiveComposerModels(context.Background(), input, ComposerSettings{})
		results <- result{models: models, err: err}
	}()
	<-started
	secondStarted := make(chan struct{})
	go func() {
		close(secondStarted)
		models, err := service.discoverLiveComposerModels(context.Background(), input, ComposerSettings{})
		results <- result{models: models, err: err}
	}()
	<-secondStarted
	close(release)

	for range 2 {
		got := <-results
		if got.err != nil || len(got.models) != 1 || got.models[0].Value != "example-pro" {
			t.Fatalf("discovery result = %#v, error = %v", got.models, got.err)
		}
	}
	if len(runtime.startCalls) != 1 || len(runtime.closeCalls) != 1 || len(runtime.sessions) != 0 {
		t.Fatalf("start=%d close=%d sessions=%d, want one closed single-flight discovery", len(runtime.startCalls), len(runtime.closeCalls), len(runtime.sessions))
	}
}

func TestExtensionHiddenComposerDiscoveryCleansUpOnTerminalFailureCancellationAndTimeout(t *testing.T) {
	tests := []struct {
		name      string
		context   func() (context.Context, context.CancelFunc)
		startHook func(RuntimeStartInput, ProviderRuntimeSession) ProviderRuntimeSession
		wantErr   error
	}{
		{
			name: "terminal failure",
			context: func() (context.Context, context.CancelFunc) {
				return context.WithCancel(context.Background())
			},
			startHook: func(_ RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
				session.Status = "failed"
				session.LastError = "runtime stopped"
				return session
			},
			wantErr: errLiveModelDiscoverySessionFailed,
		},
		{
			name: "cancellation",
			context: func() (context.Context, context.CancelFunc) {
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				return ctx, func() {}
			},
			wantErr: context.Canceled,
		},
		{
			name: "timeout",
			context: func() (context.Context, context.CancelFunc) {
				return context.WithTimeout(context.Background(), 150*time.Millisecond)
			},
			wantErr: context.DeadlineExceeded,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			runtime := newFakeRuntime()
			runtime.startHook = tt.startHook
			service := newIsolatedAgentService(runtime)
			input := extensionComposerDiscoveryInput(t.TempDir())
			scope := newComposerLiveModelScopeForInput(input, ComposerSettings{})
			ctx, cancel := tt.context()
			defer cancel()

			_, err := service.discoverLiveComposerModelsUncachedForScope(ctx, scope, input.providerTargetRef, ComposerSettings{})
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("discovery error = %v, want %v", err, tt.wantErr)
			}
			if len(runtime.startCalls) != 1 || len(runtime.closeCalls) != 1 || len(runtime.sessions) != 0 {
				t.Fatalf("start=%d close=%d sessions=%d, want failed discovery closed", len(runtime.startCalls), len(runtime.closeCalls), len(runtime.sessions))
			}
		})
	}
}

func TestExtensionHiddenComposerDiscoveryCleansPreparedRuntimeAfterStartFailure(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.startErr = errors.New("start failed")
	cleanupCalls := make([]runtimeprep.CleanupInput, 0, 1)
	service := newIsolatedAgentService(runtime)
	service.RuntimePreparer = fakeRuntimePreparer{cleanupCalls: &cleanupCalls}
	input := extensionComposerDiscoveryInput(t.TempDir())
	scope := newComposerLiveModelScopeForInput(input, ComposerSettings{})

	_, err := service.discoverLiveComposerModelsUncachedForScope(
		context.Background(), scope, input.providerTargetRef, ComposerSettings{},
	)
	if err == nil || !strings.Contains(err.Error(), "start failed") {
		t.Fatalf("discovery error = %v, want start failure", err)
	}
	if len(runtime.startCalls) != 1 || len(runtime.sessions) != 0 || len(cleanupCalls) != 1 {
		t.Fatalf("start=%d sessions=%d cleanup=%#v, want prepared runtime cleanup", len(runtime.startCalls), len(runtime.sessions), cleanupCalls)
	}
}

func TestExtensionHiddenComposerDiscoveryCallerCancellationClosesSession(t *testing.T) {
	runtime := newFakeRuntime()
	started := make(chan struct{})
	closed := make(chan struct{})
	runtime.startHook = func(_ RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		close(started)
		return session
	}
	runtime.closeHook = func(RuntimeCloseInput) { close(closed) }
	service := newIsolatedAgentService(runtime)
	input := extensionComposerDiscoveryInput(t.TempDir())
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := service.discoverLiveComposerModels(ctx, input, ComposerSettings{})
		result <- err
	}()
	<-started
	cancel()

	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("discovery error = %v, want caller cancellation", err)
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for caller-canceled discovery cleanup")
	}
	if len(runtime.closeCalls) != 1 || len(runtime.sessions) != 0 {
		t.Fatalf("close=%d sessions=%d, want caller-canceled discovery closed", len(runtime.closeCalls), len(runtime.sessions))
	}
}

func extensionComposerDiscoveryInput(cwd string) ComposerOptionsInput {
	return ComposerOptionsInput{
		Provider:      "acp:example",
		WorkspaceID:   "workspace-1",
		Cwd:           cwd,
		AgentTargetID: "extension:example",
		providerTargetRef: map[string]any{
			"kind":                    "agent_extension",
			"extensionInstallationId": "example@1.0.0",
		},
	}
}
