package agentcontext

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentgui"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

type fakeWorkspaceCatalog struct {
	startup workspacebiz.Summary
}

func (f fakeWorkspaceCatalog) Startup(context.Context) (*workspacebiz.Summary, error) {
	return &f.startup, nil
}

func (fakeWorkspaceCatalog) Get(_ context.Context, workspaceID string) (workspacebiz.Summary, error) {
	return workspacebiz.Summary{ID: workspaceID}, nil
}

type fakeDesktopPreferencesReader struct {
	preferences preferencesbiz.DesktopPreferences
}

func (f fakeDesktopPreferencesReader) Get(context.Context) (preferencesbiz.DesktopPreferences, error) {
	return f.preferences, nil
}

type fakeAgentSessions struct {
	workspaceID     string
	sessionID       string
	cancelCallCount int
	limit           int
	afterVersion    uint64
	listCallCount   int
	messageCallIDs  []string
	createCallCount int
	createInput     agentservice.CreateSessionInput
	composerInput   agentservice.ComposerOptionsInput
	sendInput       agentservice.SendInput
	getSession      agentservice.Session
	getErr          error
}

func (f *fakeAgentSessions) Cancel(_ context.Context, workspaceID string, sessionID string) (agentservice.CancelSessionResult, error) {
	f.workspaceID = workspaceID
	f.sessionID = sessionID
	f.cancelCallCount++
	return agentservice.CancelSessionResult{
		Session:  agentservice.Session{ID: sessionID, Provider: "codex", Status: "canceled", Visible: true},
		Canceled: true,
		Reason:   agentservice.CancelReasonActiveTurnCanceled,
	}, nil
}

func (f *fakeAgentSessions) Create(_ context.Context, workspaceID string, input agentservice.CreateSessionInput) (agentservice.Session, error) {
	f.workspaceID = workspaceID
	f.createCallCount++
	f.createInput = input
	cwd := ""
	if input.Cwd != nil {
		cwd = *input.Cwd
	}
	visible := true
	if input.Visible != nil {
		visible = *input.Visible
	}
	return agentservice.Session{
		ID:       "SESSION-NEW",
		Provider: input.Provider,
		Cwd:      cwd,
		Status:   "created",
		Visible:  visible,
	}, nil
}

func (f *fakeAgentSessions) Get(_ context.Context, workspaceID string, sessionID string) (agentservice.Session, error) {
	f.workspaceID = workspaceID
	f.sessionID = sessionID
	if f.getErr != nil {
		return agentservice.Session{}, f.getErr
	}
	if f.getSession.ID != "" {
		return f.getSession, nil
	}
	return agentservice.Session{ID: sessionID, Provider: "codex", Status: "created", Visible: true}, nil
}

func (f *fakeAgentSessions) GetComposerOptions(_ context.Context, input agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error) {
	f.composerInput = input
	return agentservice.ComposerOptions{
		Provider:          input.Provider,
		EffectiveSettings: input.Settings,
		ModelConfig: agentservice.ComposerConfigOption{
			Configurable: true,
			CurrentValue: input.Settings.Model,
			DefaultValue: input.Settings.Model,
			Options: []agentservice.ComposerConfigOptionValue{{
				ID:    input.Settings.Model,
				Label: "GPT-5",
				Value: input.Settings.Model,
			}},
		},
		PermissionConfig: agentservice.PermissionConfig{
			Configurable: true,
			DefaultValue: input.Settings.PermissionModeID,
			Modes: []agentservice.PermissionModeOption{{
				ID:       input.Settings.PermissionModeID,
				Label:    "替我审批",
				Semantic: agentservice.PermissionModeSemanticAuto,
			}},
		},
		ReasoningConfig: agentservice.ComposerConfigOption{
			Configurable: true,
			CurrentValue: input.Settings.ReasoningEffort,
			DefaultValue: input.Settings.ReasoningEffort,
			Options: []agentservice.ComposerConfigOptionValue{{
				ID:    input.Settings.ReasoningEffort,
				Label: "高",
				Value: input.Settings.ReasoningEffort,
			}},
		},
		RuntimeContext: map[string]any{
			"configOptions": []map[string]any{{
				"currentValue": input.Settings.Model,
				"id":           "model",
				"options": []map[string]string{{
					"name":  "GPT-5",
					"value": "gpt-5",
				}},
			}},
		},
	}, nil
}

func (f *fakeAgentSessions) List(_ context.Context, workspaceID string) ([]agentservice.Session, error) {
	f.workspaceID = workspaceID
	f.listCallCount++
	title := "Work"
	return []agentservice.Session{
		{ID: "SESSION-1", Provider: "codex", Status: "working", Title: &title, CreatedAt: time.Unix(1, 0)},
		{ID: "SESSION-2", Provider: "claude", Status: "completed", CreatedAt: time.Unix(2, 0)},
	}, nil
}

func (f *fakeAgentSessions) ListActivePeers(_ context.Context, workspaceID string) (agentservice.ActivePeers, error) {
	f.workspaceID = workspaceID
	title := "Work"
	return agentservice.ActivePeers{
		Agents: []agentservice.ActivePeer{{
			Session:      agentservice.Session{ID: "SESSION-1", Provider: "codex", Status: "working", Title: &title, CreatedAt: time.Unix(1, 0)},
			SelfRelation: "unknown",
		}},
		SelfKnown:      false,
		MayIncludeSelf: true,
		Warning:        "SELF_IDENTITY_UNAVAILABLE",
	}, nil
}

func (*fakeAgentSessions) ListProviderAvailability(_ context.Context, input agentservice.ProviderAvailabilityInput) ([]agentservice.ProviderAvailability, error) {
	return []agentservice.ProviderAvailability{{
		Provider: input.Provider,
		Status:   agentservice.ProviderAvailabilityAvailable,
		Checks: []agentservice.ProviderAvailabilityCheck{{
			Name:   "runtime_command",
			Passed: true,
			Detail: "codex found",
		}},
		CapturedAt: time.Unix(3, 0).UTC(),
	}}, nil
}

func (f *fakeAgentSessions) ListMessages(_ context.Context, workspaceID string, sessionID string, input agentservice.ListMessagesInput) (agentservice.SessionMessagesPage, error) {
	f.workspaceID = workspaceID
	f.sessionID = sessionID
	f.limit = input.Limit
	f.afterVersion = input.AfterVersion
	f.messageCallIDs = append(f.messageCallIDs, sessionID)
	return agentservice.SessionMessagesPage{
		AgentSessionID: sessionID,
		Messages: []agentservice.SessionMessage{{
			ID:             1,
			AgentSessionID: sessionID,
			MessageID:      "message-1",
			Role:           "assistant",
			Kind:           "text",
			Payload:        map[string]any{"content": "Done."},
			Version:        2,
		}},
		LatestVersion: 2,
		HasMore:       false,
	}, nil
}

func (f *fakeAgentSessions) SendInput(_ context.Context, workspaceID string, sessionID string, input agentservice.SendInput) (agentservice.Session, error) {
	f.workspaceID = workspaceID
	f.sessionID = sessionID
	f.sendInput = input
	return agentservice.Session{ID: sessionID, Provider: "codex", Status: "working", Visible: true}, nil
}

type fakeAgentGUILaunchPublisher struct {
	requests []agentgui.LaunchRequest
}

func (f *fakeAgentGUILaunchPublisher) PublishAgentGUILaunchRequested(_ context.Context, request agentgui.LaunchRequest) error {
	f.requests = append(f.requests, request)
	return nil
}

func commandByID(t *testing.T, commands []cliservice.Command, commandID string) cliservice.Command {
	t.Helper()
	for _, command := range commands {
		if command.Capability.ID == commandID {
			return command
		}
	}
	t.Fatalf("command %q not found", commandID)
	return cliservice.Command{}
}

func TestSessionSummaryCommandUsesLimitAndAfterVersion(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newSessionSummaryCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"session-id": "SESSION-1", "limit": "20", "after-version": "3"},
		OutputMode: cliservice.OutputModeJSON,
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.workspaceID != "workspace-1" || sessions.sessionID != "SESSION-1" || sessions.limit != 20 || sessions.afterVersion != 3 {
		t.Fatalf("sessions = %#v", sessions)
	}
	if output.Value["agentSessionId"] != "SESSION-1" || output.Value["latestVersion"] != uint64(2) {
		t.Fatalf("output = %#v", output.Value)
	}
	session, ok := output.Value["session"].(map[string]any)
	if !ok || session["agentSessionId"] != "SESSION-1" {
		t.Fatalf("output = %#v", output.Value)
	}
	messages := output.Value["messages"].([]any)
	if len(messages) != 1 {
		t.Fatalf("messages = %#v", messages)
	}
	message := messages[0].(map[string]any)
	if message["text"] != "Done." {
		t.Fatalf("message = %#v", message)
	}
	if _, ok := message["payload"]; ok {
		t.Fatalf("compact message should not include payload: %#v", message)
	}
}

func TestStartCommandPassesDisplayPrompt(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newStartCommand()

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"provider":       "codex",
			"model":          "gpt-5",
			"prompt":         "real automation prompt",
			"display-prompt": "Run Automation",
		},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if len(sessions.createInput.InitialContent) != 1 || sessions.createInput.InitialContent[0].Text != "real automation prompt" {
		t.Fatalf("initial content = %#v", sessions.createInput.InitialContent)
	}
	if sessions.createInput.InitialDisplayPrompt != "Run Automation" {
		t.Fatalf("initial display prompt = %q", sessions.createInput.InitialDisplayPrompt)
	}
}

func TestStartCommandRequiresProviderModelAndPrompt(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newStartCommand()
	required, ok := command.Capability.InputSchema["required"].([]string)
	if !ok {
		t.Fatalf("required schema = %#v", command.Capability.InputSchema["required"])
	}
	if len(required) != 3 || required[0] != "provider" || required[1] != "model" || required[2] != "prompt" {
		t.Fatalf("required = %#v", required)
	}

	for name, input := range map[string]map[string]any{
		"missing provider": {"model": "gpt-5", "prompt": "do work"},
		"missing model":    {"provider": "codex", "prompt": "do work"},
		"missing prompt":   {"provider": "codex", "model": "gpt-5"},
	} {
		_, err := command.Handler(context.Background(), cliservice.InvokeRequest{Input: input})
		if !errors.Is(err, cliservice.ErrInvalidInput) {
			t.Fatalf("%s err = %v, want ErrInvalidInput", name, err)
		}
	}
	if sessions.createCallCount != 0 {
		t.Fatalf("createCallCount = %d, want 0", sessions.createCallCount)
	}
}

func TestProvidersCommandReturnsAvailability(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newProvidersCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"provider": "codex"},
		OutputMode: cliservice.OutputModeJSON,
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	providers := output.Value["providers"].([]any)
	if len(providers) != 1 || providers[0].(map[string]any)["provider"] != "codex" {
		t.Fatalf("providers = %#v", providers)
	}
	if output.Value["defaultProvider"] != "codex" {
		t.Fatalf("defaultProvider = %#v, want codex", output.Value["defaultProvider"])
	}
}

func TestProvidersCommandReturnsDefaultProviderFromPreferences(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProviderWithLaunchPublisher(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		sessions,
		nil,
		fakeDesktopPreferencesReader{
			preferences: preferencesbiz.DesktopPreferences{
				DefaultAgentProvider: "claude-code",

				DockIconStyle: "default",
			},
		},
	).newProvidersCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		OutputMode: cliservice.OutputModeJSON,
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if output.Value["defaultProvider"] != "claude-code" {
		t.Fatalf("defaultProvider = %#v, want claude-code", output.Value["defaultProvider"])
	}
}

func TestComposerOptionsCommandReturnsProviderOptions(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newComposerOptionsCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"locale":           "zh-CN",
			"model":            "gpt-5",
			"permission-mode":  "auto",
			"provider":         "codex",
			"reasoning-effort": "high",
		},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.composerInput.Locale != "zh-CN" || sessions.composerInput.Provider != "codex" || sessions.composerInput.Settings.Model != "gpt-5" || sessions.composerInput.Settings.PermissionModeID != "auto" || sessions.composerInput.Settings.ReasoningEffort != "high" {
		t.Fatalf("composer input = %#v", sessions.composerInput)
	}
	if output.Value["provider"] != "codex" {
		t.Fatalf("output = %#v", output.Value)
	}
	effectiveSettings := output.Value["effectiveSettings"].(map[string]any)
	if effectiveSettings["model"] != "gpt-5" || effectiveSettings["reasoningEffort"] != "high" {
		t.Fatalf("effectiveSettings = %#v", effectiveSettings)
	}
	permissionConfig := output.Value["permissionConfig"].(map[string]any)
	if permissionConfig["defaultValue"] != "auto" {
		t.Fatalf("permissionConfig = %#v", permissionConfig)
	}
	modes := permissionConfig["modes"].([]any)
	if modes[0].(map[string]any)["label"] != "替我审批" {
		t.Fatalf("permission modes = %#v", modes)
	}
}

func TestComposerOptionsCommandUsesComposerDefaultsFromPreferences(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProviderWithLaunchPublisher(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		sessions,
		nil,
		fakeDesktopPreferencesReader{
			preferences: preferencesbiz.DesktopPreferences{
				AgentComposerDefaultsByProvider: map[string]preferencesbiz.AgentComposerDefaults{
					"codex": {
						Model:            "gpt-5",
						PermissionModeID: "full-access",
						ReasoningEffort:  "high",
					},
				},
			},
		},
	).newComposerOptionsCommand()

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"provider": "codex",
		},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.composerInput.Settings.Model != "gpt-5" ||
		sessions.composerInput.Settings.PermissionModeID != "full-access" ||
		sessions.composerInput.Settings.ReasoningEffort != "high" {
		t.Fatalf("composer input = %#v", sessions.composerInput)
	}
}

func TestStartCommandDefaultsHeadlessAndShowPublishesLaunch(t *testing.T) {
	sessions := &fakeAgentSessions{}
	publisher := &fakeAgentGUILaunchPublisher{}
	provider := NewProviderWithLaunchPublisher(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		sessions,
		publisher,
	)
	command := provider.newStartCommand()

	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"provider": "codex", "model": "gpt-5", "prompt": "do work"},
		Context: cliservice.InvokeContext{
			Source: "cli",
		},
	}); err != nil {
		t.Fatalf("Handler headless: %v", err)
	}
	if sessions.createInput.Visible == nil || *sessions.createInput.Visible {
		t.Fatalf("Visible = %#v, want false", sessions.createInput.Visible)
	}
	if len(publisher.requests) != 0 {
		t.Fatalf("launch requests = %#v, want none", publisher.requests)
	}

	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"provider": "codex", "model": "gpt-5", "prompt": "do work", "show": "true"},
		Context: cliservice.InvokeContext{
			Source: "cli",
		},
	}); err != nil {
		t.Fatalf("Handler show: %v", err)
	}
	if sessions.createInput.Visible == nil || !*sessions.createInput.Visible {
		t.Fatalf("Visible = %#v, want true", sessions.createInput.Visible)
	}
	if len(publisher.requests) != 1 || publisher.requests[0].AgentSessionID != "SESSION-NEW" || publisher.requests[0].Source != "cli" {
		t.Fatalf("launch requests = %#v", publisher.requests)
	}
}

func TestStartCommandPassesComposerSettings(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newStartCommand()

	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"model":            "gpt-5",
			"permission-mode":  "ask",
			"prompt":           "do work",
			"provider":         "codex",
			"reasoning-effort": "high",
		},
	}); err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.createInput.Model == nil || *sessions.createInput.Model != "gpt-5" {
		t.Fatalf("Model = %#v", sessions.createInput.Model)
	}
	if sessions.createInput.PermissionModeID == nil || *sessions.createInput.PermissionModeID != "ask" {
		t.Fatalf("PermissionModeID = %#v", sessions.createInput.PermissionModeID)
	}
	if sessions.createInput.ReasoningEffort == nil || *sessions.createInput.ReasoningEffort != "high" {
		t.Fatalf("ReasoningEffort = %#v", sessions.createInput.ReasoningEffort)
	}
}

func TestStartCommandInheritsCallerSessionCwd(t *testing.T) {
	sessions := &fakeAgentSessions{
		getSession: agentservice.Session{ID: "CALLER-1", Cwd: "/workspace/a"},
	}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newProviderStartCommand(providerStartCommandSpec{
		AppID:       claudeCodeAgentAppID,
		AppName:     "Claude Code",
		CommandID:   appID + ".claude.start",
		Description: "Start a Claude Code agent session in the current workspace.",
		Path:        []string{"claude", "start"},
		Provider:    "claude-code",
		Summary:     "Start a Claude Code agent session",
	})

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"model": "sonnet", "prompt": "do work"},
		Context: cliservice.InvokeContext{
			AgentSessionID: "CALLER-1",
		},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.sessionID != "CALLER-1" {
		t.Fatalf("sessionID = %q, want CALLER-1", sessions.sessionID)
	}
	if sessions.createInput.Cwd == nil || *sessions.createInput.Cwd != "/workspace/a" {
		t.Fatalf("Cwd = %#v, want /workspace/a", sessions.createInput.Cwd)
	}
}

func TestStartCommandExplicitCwdOverridesCallerSessionCwd(t *testing.T) {
	sessions := &fakeAgentSessions{
		getSession: agentservice.Session{ID: "CALLER-1", Cwd: "/workspace/a"},
	}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newStartCommand()

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"cwd":      "/workspace/other",
			"model":    "gpt-5",
			"prompt":   "do work",
			"provider": "codex",
		},
		Context: cliservice.InvokeContext{
			AgentSessionID: "CALLER-1",
		},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.sessionID != "" {
		t.Fatalf("sessionID = %q, want no caller lookup", sessions.sessionID)
	}
	if sessions.createInput.Cwd == nil || *sessions.createInput.Cwd != "/workspace/other" {
		t.Fatalf("Cwd = %#v, want /workspace/other", sessions.createInput.Cwd)
	}
}

func TestStartCommandWithoutCallerSessionLeavesCwdForAllocator(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newStartCommand()

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"model": "gpt-5", "prompt": "do work", "provider": "codex"},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.createInput.Cwd != nil {
		t.Fatalf("Cwd = %#v, want nil", sessions.createInput.Cwd)
	}
}

func TestStartCommandMissingCallerSessionLeavesCwdForAllocator(t *testing.T) {
	sessions := &fakeAgentSessions{getErr: agentservice.ErrSessionNotFound}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newStartCommand()

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"model": "gpt-5", "prompt": "do work", "provider": "codex"},
		Context: cliservice.InvokeContext{
			AgentSessionID: "CALLER-1",
		},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.createInput.Cwd != nil {
		t.Fatalf("Cwd = %#v, want nil", sessions.createInput.Cwd)
	}
}

func TestProviderStartCommandsExposeAgentAppsAndFixProvider(t *testing.T) {
	provider := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, &fakeAgentSessions{})
	commands := provider.Commands()
	codex := commandByID(t, commands, "agent-context.codex.start")
	claude := commandByID(t, commands, "agent-context.claude.start")

	if codex.Capability.Source.Kind != cliservice.CapabilitySourceApp ||
		codex.Capability.Source.AppID != codexAgentAppID ||
		codex.Capability.Source.AppName != "Codex" ||
		len(codex.Capability.Path) != 2 ||
		codex.Capability.Path[0] != "codex" ||
		codex.Capability.Path[1] != "start" {
		t.Fatalf("codex capability = %#v", codex.Capability)
	}
	if claude.Capability.Source.Kind != cliservice.CapabilitySourceApp ||
		claude.Capability.Source.AppID != claudeCodeAgentAppID ||
		claude.Capability.Source.AppName != "Claude Code" ||
		len(claude.Capability.Path) != 2 ||
		claude.Capability.Path[0] != "claude" ||
		claude.Capability.Path[1] != "start" {
		t.Fatalf("claude capability = %#v", claude.Capability)
	}

	for name, tc := range map[string]struct {
		commandID string
		want      string
	}{
		"codex":  {commandID: "agent-context.codex.start", want: "codex"},
		"claude": {commandID: "agent-context.claude.start", want: "claude-code"},
	} {
		sessions := &fakeAgentSessions{}
		command := commandByID(t, NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).Commands(), tc.commandID)
		_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
			Input: map[string]any{"model": "model-1", "prompt": "do work"},
		})
		if err != nil {
			t.Fatalf("%s Handler: %v", name, err)
		}
		if sessions.createInput.Provider != tc.want {
			t.Fatalf("%s provider = %q, want %q", name, sessions.createInput.Provider, tc.want)
		}
	}
}

func TestProviderStartCommandRequiresModelAndPrompt(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newProviderStartCommand(providerStartCommandSpec{
		AppID:       codexAgentAppID,
		AppName:     "Codex",
		CommandID:   appID + ".codex.start",
		Description: "Start a Codex agent session in the current workspace.",
		Path:        []string{"codex", "start"},
		Provider:    "codex",
		Summary:     "Start a Codex agent session",
	})
	required, ok := command.Capability.InputSchema["required"].([]string)
	if !ok {
		t.Fatalf("required schema = %#v", command.Capability.InputSchema["required"])
	}
	if len(required) != 2 || required[0] != "model" || required[1] != "prompt" {
		t.Fatalf("required = %#v", required)
	}
	for name, input := range map[string]map[string]any{
		"missing model":  {"prompt": "do work"},
		"missing prompt": {"model": "gpt-5"},
	} {
		_, err := command.Handler(context.Background(), cliservice.InvokeRequest{Input: input})
		if !errors.Is(err, cliservice.ErrInvalidInput) {
			t.Fatalf("%s err = %v, want ErrInvalidInput", name, err)
		}
	}
	if sessions.createCallCount != 0 {
		t.Fatalf("createCallCount = %d, want 0", sessions.createCallCount)
	}
}

func TestOpenCommandPublishesLaunchIntent(t *testing.T) {
	sessions := &fakeAgentSessions{}
	publisher := &fakeAgentGUILaunchPublisher{}
	command := NewProviderWithLaunchPublisher(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		sessions,
		publisher,
	).newOpenCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"session-id": "SESSION-1"},
		Context: cliservice.InvokeContext{
			Source: "cli",
		},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if output.Rows[0]["launchRequested"] != true {
		t.Fatalf("output = %#v", output)
	}
	if len(publisher.requests) != 1 || publisher.requests[0].AgentSessionID != "SESSION-1" || publisher.requests[0].Reason != "open" {
		t.Fatalf("launch requests = %#v", publisher.requests)
	}
}

func TestGetCommandReturnsSession(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		sessions,
	).newGetCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"session-id": "SESSION-1"},
		OutputMode: cliservice.OutputModeJSON,
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	session := output.Value["session"].(map[string]any)
	if session["agentSessionId"] != "SESSION-1" || sessions.workspaceID != "workspace-1" {
		t.Fatalf("output = %#v sessions = %#v", output.Value, sessions)
	}
	if _, ok := session["runtimeContext"]; ok {
		t.Fatalf("compact session should not include runtimeContext: %#v", session)
	}
	if _, ok := session["permissionConfig"]; ok {
		t.Fatalf("compact session should not include permissionConfig: %#v", session)
	}
}

func TestCancelCommandCancelsSession(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		sessions,
	).newCancelCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"session-id": "SESSION-1"},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.cancelCallCount != 1 || sessions.sessionID != "SESSION-1" {
		t.Fatalf("sessions = %#v", sessions)
	}
	if output.Rows[0]["status"] != "canceled" {
		t.Fatalf("output = %#v", output)
	}
}

func TestSessionSummaryIncludesCompactSession(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newSessionSummaryCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"session-id": "SESSION-1"},
		OutputMode: cliservice.OutputModeJSON,
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if len(sessions.messageCallIDs) != 1 || sessions.messageCallIDs[0] != "SESSION-1" {
		t.Fatalf("messageCallIDs = %#v", sessions.messageCallIDs)
	}
	session, ok := output.Value["session"].(map[string]any)
	if !ok || session["agentSessionId"] != "SESSION-1" {
		t.Fatalf("output = %#v", output.Value)
	}
}

func TestProviderCommandsExcludeRemovedSessionAliases(t *testing.T) {
	commands := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, &fakeAgentSessions{}).Commands()
	for _, command := range commands {
		switch command.Capability.ID {
		case "agent-context.agent.list", "agent-context.agent.session.messages":
			t.Fatalf("removed command still registered: %q", command.Capability.ID)
		}
	}
}

func TestActivePeersReturnsServiceProjection(t *testing.T) {
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, &fakeAgentSessions{}).newActivePeersCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	agents := output.Value["agents"].([]any)
	if len(agents) != 1 || agents[0].(map[string]any)["agentSessionId"] != "SESSION-1" {
		t.Fatalf("agents = %#v", agents)
	}
	if agents[0].(map[string]any)["selfRelation"] != "unknown" {
		t.Fatalf("agents = %#v", agents)
	}
	if _, ok := agents[0].(map[string]any)["isSelf"]; ok {
		t.Fatalf("agents should not assert isSelf when self is unknown: %#v", agents)
	}
	if output.Value["selfKnown"] != false || output.Value["mayIncludeSelf"] != true || output.Value["warning"] != "SELF_IDENTITY_UNAVAILABLE" {
		t.Fatalf("output = %#v", output.Value)
	}
}
