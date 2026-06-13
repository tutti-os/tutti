package agentcontext

import (
	"context"
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
	createInput     agentservice.CreateSessionInput
	composerInput   agentservice.ComposerOptionsInput
	sendInput       agentservice.SendInput
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
				Label:    "代我批准",
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

func TestSessionMessagesCommandUsesLimitAndAfterVersion(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newSessionMessagesCommand([]string{"agent", "session", "messages"}, "agent-context.agent.session.messages")

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"session-id": "SESSION-1", "limit": "20", "after-version": "3"},
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
}

func TestStartCommandPassesDisplayPrompt(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newStartCommand()

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"provider":       "codex",
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
	if modes[0].(map[string]any)["label"] != "代我批准" {
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
		Input: map[string]any{"provider": "codex"},
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
		Input: map[string]any{"provider": "codex", "show": "true"},
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
	if session["id"] != "SESSION-1" || sessions.workspaceID != "workspace-1" {
		t.Fatalf("output = %#v sessions = %#v", output.Value, sessions)
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

func TestSessionSummaryAliasMatchesMessages(t *testing.T) {
	sessions := &fakeAgentSessions{}
	provider := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions)
	commands := provider.Commands()
	var alias cliservice.Command
	for _, command := range commands {
		if command.Capability.ID == "agent-context.agent.session-summary" {
			alias = command
		}
	}
	if alias.Handler == nil {
		t.Fatal("session-summary alias not registered")
	}
	if _, err := alias.Handler(context.Background(), cliservice.InvokeRequest{Input: map[string]any{"session-id": "SESSION-1"}}); err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if len(sessions.messageCallIDs) != 1 || sessions.messageCallIDs[0] != "SESSION-1" {
		t.Fatalf("messageCallIDs = %#v", sessions.messageCallIDs)
	}
}

func TestActivePeersReturnsServiceProjection(t *testing.T) {
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, &fakeAgentSessions{}).newActivePeersCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	agents := output.Value["agents"].([]any)
	if len(agents) != 1 || agents[0].(map[string]any)["id"] != "SESSION-1" {
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
