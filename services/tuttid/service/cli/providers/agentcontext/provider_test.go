package agentcontext

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentgui"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
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
	turnID          string
	afterVersion    uint64
	beforeVersion   uint64
	order           agentactivitybiz.MessageOrder
	messages        []agentservice.SessionMessage
	listCallCount   int
	messageCallIDs  []string
	createCallCount int
	createInput     agentservice.CreateSessionInput
	composerInput   agentservice.ComposerOptionsInput
	skillBundleIn   agentservice.SkillBundleInput
	sendInput       agentservice.SendInput
	localPaths      map[string]string
	getSession      agentservice.Session
	getErr          error
	availability    []agentservice.ProviderAvailability
	availabilityErr error
	availabilityIn  []agentservice.ProviderAvailabilityInput
}

func newTestCodexStartCommand(provider Provider) cliservice.Command {
	return provider.newProviderStartCommand(providerStartCommandSpec{
		AppID:         codexAgentAppID,
		AppName:       "Codex",
		CommandID:     appID + ".codex.start",
		Description:   "Start a Codex agent session in the current workspace.",
		Path:          []string{"codex", "start"},
		Provider:      "codex",
		AgentTargetID: agenttargetbiz.IDLocalCodex,
		Summary:       "Start a Codex agent session",
	})
}

func newTestClaudeStartCommand(provider Provider) cliservice.Command {
	return provider.newProviderStartCommand(providerStartCommandSpec{
		AppID:         claudeCodeAgentAppID,
		AppName:       "Claude Code",
		CommandID:     appID + ".claude.start",
		Description:   "Start a Claude Code agent session in the current workspace.",
		Path:          []string{"claude", "start"},
		Provider:      "claude-code",
		AgentTargetID: agenttargetbiz.IDLocalClaudeCode,
		Summary:       "Start a Claude Code agent session",
	})
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
		SpeedConfig: agentservice.ComposerConfigOption{
			Configurable: true,
			CurrentValue: "standard",
			DefaultValue: "standard",
			Options: []agentservice.ComposerConfigOptionValue{{
				ID:    "standard",
				Label: "标准",
				Value: "standard",
			}, {
				ID:    "fast",
				Label: "快速",
				Value: "fast",
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

func (f *fakeAgentSessions) GetSkillBundle(_ context.Context, workspaceID string, input agentservice.SkillBundleInput) (agentservice.SkillBundle, error) {
	f.workspaceID = workspaceID
	f.skillBundleIn = input
	return agentservice.SkillBundle{
		SchemaVersion:  1,
		Provider:       input.Provider,
		AgentSessionID: input.AgentSessionID,
		CLICommand:     "tutti-dev",
		RecommendedSystemPrompt: &agentservice.RecommendedSystemPrompt{
			Format:  "text/markdown",
			Content: "Use Tutti skills for mention routing.",
		},
		Skills: []agentservice.SkillMaterializationRecord{
			{
				Content:      "---\nname: tutti-cli\n---\nUse tutti.\n",
				SkillID:      "tutti/tutti-cli",
				Slug:         "tutti-cli",
				DeliveryMode: "materialized-files",
			},
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
			Session:      agentservice.Session{ID: "SESSION-1", Provider: "codex", Cwd: "/workspace/repo", Status: "working", Title: &title, CreatedAt: time.Unix(1, 0)},
			SelfRelation: "unknown",
		}},
		SelfKnown:      false,
		MayIncludeSelf: true,
		Warning:        "SELF_IDENTITY_UNAVAILABLE",
	}, nil
}

func (f *fakeAgentSessions) ListProviderAvailability(_ context.Context, input agentservice.ProviderAvailabilityInput) ([]agentservice.ProviderAvailability, error) {
	f.availabilityIn = append(f.availabilityIn, input)
	if f.availabilityErr != nil {
		return nil, f.availabilityErr
	}
	items := f.availability
	if items == nil {
		items = []agentservice.ProviderAvailability{
			availableProvider("codex"),
			availableProvider("claude-code"),
		}
	}
	if strings.TrimSpace(input.Provider) == "" {
		return append([]agentservice.ProviderAvailability(nil), items...), nil
	}
	filtered := make([]agentservice.ProviderAvailability, 0, len(items))
	for _, item := range items {
		if strings.TrimSpace(item.Provider) == strings.TrimSpace(input.Provider) {
			filtered = append(filtered, item)
		}
	}
	return filtered, nil
}

func availableProvider(provider string) agentservice.ProviderAvailability {
	return providerAvailability(provider, agentservice.ProviderAvailabilityAvailable)
}

func providerAvailability(provider string, status string) agentservice.ProviderAvailability {
	return agentservice.ProviderAvailability{
		Provider: provider,
		Status:   status,
		Checks: []agentservice.ProviderAvailabilityCheck{{
			Name:   "runtime_command",
			Passed: status == agentservice.ProviderAvailabilityAvailable,
			Detail: provider + " status",
		}},
		CapturedAt: time.Unix(3, 0).UTC(),
	}
}

func (f *fakeAgentSessions) ListMessages(_ context.Context, workspaceID string, sessionID string, input agentservice.ListMessagesInput) (agentservice.SessionMessagesPage, error) {
	f.workspaceID = workspaceID
	f.sessionID = sessionID
	f.limit = input.Limit
	f.turnID = input.TurnID
	f.afterVersion = input.AfterVersion
	f.beforeVersion = input.BeforeVersion
	f.order = input.Order
	f.messageCallIDs = append(f.messageCallIDs, sessionID)
	messages := f.messages
	if messages == nil {
		messages = []agentservice.SessionMessage{{
			ID:             1,
			AgentSessionID: sessionID,
			MessageID:      "message-1",
			Role:           "assistant",
			Kind:           "text",
			Payload:        map[string]any{"content": "Done."},
			Version:        2,
		}}
	}
	return agentservice.SessionMessagesPage{
		AgentSessionID: sessionID,
		Messages:       messages,
		LatestVersion:  2,
		HasMore:        false,
	}, nil
}

func (f *fakeAgentSessions) LocalAttachmentPath(_ context.Context, workspaceID string, sessionID string, attachmentID string, _ string) (string, error) {
	f.workspaceID = workspaceID
	f.sessionID = sessionID
	if f.localPaths != nil {
		if path := f.localPaths[attachmentID]; path != "" {
			return path, nil
		}
	}
	return filepath.Join("/tmp", "agent", "attachments", sessionID, attachmentID+".png"), nil
}

func (f *fakeAgentSessions) SendInput(_ context.Context, workspaceID string, sessionID string, input agentservice.SendInput) (agentservice.SendInputResult, error) {
	f.workspaceID = workspaceID
	f.sessionID = sessionID
	f.sendInput = input
	return agentservice.SendInputResult{
		Session: agentservice.Session{ID: sessionID, Provider: "codex", Status: "working", Visible: true},
	}, nil
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

func capabilityIDs(capabilities []cliservice.Capability) []string {
	ids := make([]string, 0, len(capabilities))
	for _, capability := range capabilities {
		ids = append(ids, capability.ID)
	}
	return ids
}

func providerAgentAppIDs(capabilities []cliservice.Capability) []string {
	ids := []string{}
	for _, capability := range capabilities {
		if capability.Source.Kind == cliservice.CapabilitySourceApp &&
			(capability.Source.AppID == codexAgentAppID || capability.Source.AppID == claudeCodeAgentAppID) {
			ids = append(ids, capability.Source.AppID)
		}
	}
	return ids
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func equalStrings(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
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
	if sessions.workspaceID != "workspace-1" ||
		sessions.sessionID != "SESSION-1" ||
		sessions.limit != 20 ||
		sessions.afterVersion != 3 ||
		sessions.beforeVersion != 0 ||
		sessions.order != agentactivitybiz.MessageOrderAsc {
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

func TestSessionSummaryCommandIncludesImageCompactMetadata(t *testing.T) {
	sessions := &fakeAgentSessions{
		localPaths: map[string]string{"attachment-1": "/tmp/agent/attachments/SESSION-1/attachment-1.png"},
		messages: []agentservice.SessionMessage{{
			ID:             1,
			AgentSessionID: "SESSION-1",
			MessageID:      "message-1",
			Role:           "user",
			Kind:           "text",
			Status:         "completed",
			Payload: map[string]any{
				"content": []any{
					map[string]any{"type": "text", "text": "look"},
					map[string]any{
						"type":         "image",
						"attachmentId": "attachment-1",
						"mimeType":     "image/png",
						"name":         "shot.png",
					},
				},
			},
			Version: 2,
		}},
	}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newSessionSummaryCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"session-id": "SESSION-1"},
		OutputMode: cliservice.OutputModeJSON,
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	messages := output.Value["messages"].([]any)
	message := messages[0].(map[string]any)
	images, ok := message["images"].([]any)
	if !ok || len(images) != 1 {
		t.Fatalf("images = %#v", message["images"])
	}
	image := images[0].(map[string]any)
	if image["attachmentId"] != "attachment-1" ||
		image["mimeType"] != "image/png" ||
		image["name"] != "shot.png" ||
		image["localPath"] != "/tmp/agent/attachments/SESSION-1/attachment-1.png" {
		t.Fatalf("image = %#v", image)
	}
	if message["messageId"] != "message-1" {
		t.Fatalf("message = %#v", message)
	}
}

func TestTurnResourcesCommandReturnsImagesGroupedByUserMessage(t *testing.T) {
	sessions := &fakeAgentSessions{
		localPaths: map[string]string{
			"attachment-1": "/tmp/agent/attachments/SESSION-1/attachment-1.png",
			"attachment-2": "/tmp/agent/attachments/SESSION-1/attachment-2.png",
		},
		messages: []agentservice.SessionMessage{
			{
				AgentSessionID: "SESSION-1",
				MessageID:      "message-user-image",
				TurnID:         "turn-2",
				Role:           "user",
				Kind:           "text",
				Status:         "completed",
				Payload: map[string]any{
					"content": []any{
						map[string]any{"type": "text", "text": "look at this"},
						map[string]any{"type": "image", "attachmentId": "attachment-1", "mimeType": "image/png"},
					},
				},
				Version: 3,
			},
			{
				AgentSessionID: "SESSION-1",
				MessageID:      "message-user-text",
				TurnID:         "turn-2",
				Role:           "user",
				Kind:           "text",
				Status:         "completed",
				Payload:        map[string]any{"content": "no image"},
				Version:        4,
			},
			{
				AgentSessionID: "SESSION-1",
				MessageID:      "message-assistant-image",
				TurnID:         "turn-2",
				Role:           "assistant",
				Kind:           "text",
				Status:         "completed",
				Payload: map[string]any{
					"content": []any{
						map[string]any{"type": "image", "attachmentId": "attachment-2", "mimeType": "image/png"},
					},
				},
				Version: 5,
			},
		},
	}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newTurnResourcesCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"session-id": "SESSION-1", "turn-id": "turn-2"},
		OutputMode: cliservice.OutputModeJSON,
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.workspaceID != "workspace-1" || sessions.sessionID != "SESSION-1" || sessions.turnID != "turn-2" {
		t.Fatalf("sessions = %#v", sessions)
	}
	if output.Value["agentSessionId"] != "SESSION-1" || output.Value["turnId"] != "turn-2" {
		t.Fatalf("output = %#v", output.Value)
	}
	messages := output.Value["messages"].([]any)
	if len(messages) != 1 {
		t.Fatalf("messages = %#v", messages)
	}
	message := messages[0].(map[string]any)
	if message["messageId"] != "message-user-image" || message["turnId"] != "turn-2" || message["text"] != "look at this" {
		t.Fatalf("message = %#v", message)
	}
	images := message["images"].([]any)
	image := images[0].(map[string]any)
	if image["attachmentId"] != "attachment-1" || image["localPath"] != "/tmp/agent/attachments/SESSION-1/attachment-1.png" {
		t.Fatalf("image = %#v", image)
	}
}

func TestTurnResourcesCommandRejectsBlankTurnID(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newTurnResourcesCommand()

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"session-id": "SESSION-1", "turn-id": "   "},
		OutputMode: cliservice.OutputModeJSON,
	})
	if !errors.Is(err, cliservice.ErrInvalidInput) {
		t.Fatalf("Handler error = %v, want ErrInvalidInput", err)
	}
	if len(sessions.messageCallIDs) != 0 {
		t.Fatalf("ListMessages calls = %#v, want none", sessions.messageCallIDs)
	}
}

func TestSessionSummaryCommandUsesDescendingBeforeVersion(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newSessionSummaryCommand()

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"session-id": "SESSION-1", "limit": "50", "order": "desc", "before-version": "99"},
		OutputMode: cliservice.OutputModeJSON,
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.workspaceID != "workspace-1" ||
		sessions.sessionID != "SESSION-1" ||
		sessions.limit != 50 ||
		sessions.afterVersion != 0 ||
		sessions.beforeVersion != 99 ||
		sessions.order != agentactivitybiz.MessageOrderDesc {
		t.Fatalf("sessions = %#v", sessions)
	}
}

func TestSessionSummaryCommandRejectsInvalidOrder(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newSessionSummaryCommand()

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"session-id": "SESSION-1", "order": "sideways"},
	})
	if !errors.Is(err, cliservice.ErrInvalidInput) {
		t.Fatalf("err = %v, want ErrInvalidInput", err)
	}
}

func TestStartCommandPassesDisplayPrompt(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestCodexStartCommand(NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
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
	if sessions.createInput.AgentTargetID != agenttargetbiz.IDLocalCodex {
		t.Fatalf("agent target id = %q, want %s", sessions.createInput.AgentTargetID, agenttargetbiz.IDLocalCodex)
	}
}

func TestStartCommandRequiresProviderAndPrompt(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newStartCommand()
	required, ok := command.Capability.InputSchema["required"].([]string)
	if !ok {
		t.Fatalf("required schema = %#v", command.Capability.InputSchema["required"])
	}
	if len(required) != 2 || required[0] != "provider" || required[1] != "prompt" {
		t.Fatalf("required = %#v", required)
	}

	for name, input := range map[string]map[string]any{
		"missing provider": {"model": "gpt-5", "prompt": "do work"},
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

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"provider": "codex", "prompt": "do work"},
	})
	if !errors.Is(err, cliservice.ErrInvalidInput) {
		t.Fatalf("err = %v, want ErrInvalidInput", err)
	}
	if !strings.Contains(err.Error(), "tutti codex start") || !strings.Contains(err.Error(), "tutti claude start") {
		t.Fatalf("err = %v, want provider command guidance", err)
	}
	if sessions.createCallCount != 0 {
		t.Fatalf("createCallCount = %d, want 0", sessions.createCallCount)
	}
}

func TestStartCommandUsesComposerDefaults(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestCodexStartCommand(NewProviderWithLaunchPublisher(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		sessions,
		nil,
		fakeDesktopPreferencesReader{preferences: preferencesbiz.DesktopPreferences{
			AgentConversationDetailMode: preferencesbiz.DesktopAgentConversationDetailModeGeneral,
			AgentComposerDefaultsByAgentTarget: map[string]preferencesbiz.AgentComposerDefaults{
				"local:codex": {
					Model:            "gpt-5.5",
					PermissionModeID: "full-access",
					ReasoningEffort:  "high",
				},
			},
		}},
	))

	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"prompt": "do work"},
	}); err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.createInput.Model == nil || *sessions.createInput.Model != "gpt-5.5" {
		t.Fatalf("Model = %#v, want composer default", sessions.createInput.Model)
	}
	if sessions.createInput.PermissionModeID == nil || *sessions.createInput.PermissionModeID != "full-access" {
		t.Fatalf("PermissionModeID = %#v, want composer default", sessions.createInput.PermissionModeID)
	}
	if sessions.createInput.ReasoningEffort == nil || *sessions.createInput.ReasoningEffort != "high" {
		t.Fatalf("ReasoningEffort = %#v, want composer default", sessions.createInput.ReasoningEffort)
	}
	if sessions.createInput.ConversationDetailMode != preferencesbiz.DesktopAgentConversationDetailModeGeneral {
		t.Fatalf("ConversationDetailMode = %q, want general", sessions.createInput.ConversationDetailMode)
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
	if sessions.composerInput.IncludeCapabilityCatalog != nil {
		t.Fatalf("include capability catalog = %#v, want nil default", *sessions.composerInput.IncludeCapabilityCatalog)
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
	speedConfig := output.Value["speedConfig"].(map[string]any)
	if speedConfig["currentValue"] != "standard" || speedConfig["defaultValue"] != "standard" {
		t.Fatalf("speedConfig = %#v", speedConfig)
	}
	speedOptions := speedConfig["options"].([]any)
	if len(speedOptions) != 2 || speedOptions[0].(map[string]any)["value"] != "standard" || speedOptions[1].(map[string]any)["value"] != "fast" {
		t.Fatalf("speed options = %#v", speedOptions)
	}
}

func TestComposerOptionsCommandCanDisableCapabilityCatalog(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newComposerOptionsCommand()

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"provider":                   "codex",
			"include-capability-catalog": "false",
		},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.composerInput.IncludeCapabilityCatalog == nil {
		t.Fatal("include capability catalog = nil, want explicit false")
	}
	if *sessions.composerInput.IncludeCapabilityCatalog {
		t.Fatalf("include capability catalog = true, want false")
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
				AgentComposerDefaultsByAgentTarget: map[string]preferencesbiz.AgentComposerDefaults{
					"local:codex": {
						Model:            "gpt-5",
						PermissionModeID: "full-access",
						ReasoningEffort:  "high",
					},
				},
				AgentConversationDetailMode: preferencesbiz.DesktopAgentConversationDetailModeGeneral,
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
		sessions.composerInput.Settings.ReasoningEffort != "high" ||
		sessions.composerInput.Settings.ConversationDetailMode != "" {
		t.Fatalf("composer input = %#v", sessions.composerInput)
	}
}

func TestSkillBundleCommandReturnsAgentACPKitShape(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newSkillBundleCommand()
	if command.Capability.ID != appID+".agent.tutti-cli-skill-bundle" ||
		strings.Join(command.Capability.Path, " ") != "agent tutti-cli-skill-bundle" {
		t.Fatalf("command capability = %#v", command.Capability)
	}
	if command.Capability.Visibility != cliservice.CapabilityVisibilityIntegration {
		t.Fatalf("visibility = %q, want integration", command.Capability.Visibility)
	}

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"agent-session-id": "run-1",
			"browser-use":      "true",
			"provider":         "codex",
		},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.workspaceID != "workspace-1" {
		t.Fatalf("workspaceID = %q, want workspace-1", sessions.workspaceID)
	}
	if sessions.skillBundleIn.Provider != "codex" ||
		sessions.skillBundleIn.AgentSessionID != "run-1" ||
		!sessions.skillBundleIn.BrowserUse ||
		sessions.skillBundleIn.ComputerUse {
		t.Fatalf("skill bundle input = %#v", sessions.skillBundleIn)
	}
	if output.Kind != cliservice.OutputModeJSON {
		t.Fatalf("output kind = %q, want json", output.Kind)
	}
	skills, ok := output.Value["skills"].([]any)
	if !ok || len(skills) != 1 {
		t.Fatalf("skills output = %#v", output.Value["skills"])
	}
	first, ok := skills[0].(map[string]any)
	if !ok {
		t.Fatalf("first skill = %#v", skills[0])
	}
	recommended, ok := output.Value["recommendedSystemPrompt"].(map[string]any)
	if !ok {
		t.Fatalf("recommendedSystemPrompt = %#v", output.Value["recommendedSystemPrompt"])
	}
	if output.Value["schemaVersion"] != 1 ||
		output.Value["provider"] != "codex" ||
		output.Value["agentSessionId"] != "run-1" ||
		output.Value["cliCommand"] != "tutti-dev" ||
		recommended["format"] != "text/markdown" ||
		recommended["content"] != "Use Tutti skills for mention routing." ||
		first["skillId"] != "tutti/tutti-cli" ||
		first["slug"] != "tutti-cli" ||
		first["deliveryMode"] != "materialized-files" ||
		first["materializedPath"] != nil {
		t.Fatalf("skill bundle output = %#v", output.Value)
	}
}

func TestSkillBundleSkillsValuePreservesMaterializedPathWhenPresent(t *testing.T) {
	values := skillBundleSkillsValue([]agentservice.SkillMaterializationRecord{
		{
			SkillID:          "app/custom",
			Slug:             "custom",
			DeliveryMode:     "materialized-files",
			MaterializedPath: "/workspace/.local-agent/runs/run-1/skills/custom",
		},
	})

	first, ok := values[0].(map[string]any)
	if !ok {
		t.Fatalf("first skill = %#v", values[0])
	}
	if first["materializedPath"] != "/workspace/.local-agent/runs/run-1/skills/custom" {
		t.Fatalf("skill value = %#v", first)
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
	command := newTestCodexStartCommand(provider)

	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"model": "gpt-5", "prompt": "do work"},
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
		Input: map[string]any{"model": "gpt-5", "prompt": "do work", "show": "true"},
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
	command := newTestCodexStartCommand(NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))

	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"model":            "gpt-5",
			"permission-mode":  "ask",
			"prompt":           "do work",
			"reasoning-effort": "high",
			"speed":            "fast",
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
	if sessions.createInput.Speed == nil || *sessions.createInput.Speed != "fast" {
		t.Fatalf("Speed = %#v", sessions.createInput.Speed)
	}
}

func TestStartCommandConvertsImageFilesToPromptContentBlocks(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestCodexStartCommand(NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))
	imagePath := filepath.Join(t.TempDir(), "shot.png")
	if err := os.WriteFile(imagePath, []byte("png-bytes"), 0o600); err != nil {
		t.Fatalf("write image: %v", err)
	}

	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"image":  imagePath,
			"model":  "gpt-5",
			"prompt": "describe this",
		},
	}); err != nil {
		t.Fatalf("Handler: %v", err)
	}

	content := sessions.createInput.InitialContent
	if len(content) != 2 {
		t.Fatalf("initial content = %#v, want text + image", content)
	}
	if content[0].Type != "text" || content[0].Text != "describe this" {
		t.Fatalf("text block = %#v", content[0])
	}
	if content[1].Type != "image" || content[1].MimeType != "image/png" || content[1].Name != "shot.png" {
		t.Fatalf("image block metadata = %#v", content[1])
	}
	decoded, err := base64.StdEncoding.DecodeString(content[1].Data)
	if err != nil || string(decoded) != "png-bytes" {
		t.Fatalf("image block data decoded = %q err=%v", string(decoded), err)
	}
}

func TestStartCommandRejectsUnsupportedImageExtension(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestCodexStartCommand(NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"image":  filepath.Join(t.TempDir(), "notes.txt"),
			"model":  "gpt-5",
			"prompt": "describe this",
		},
	})
	if !errors.Is(err, cliservice.ErrInvalidInput) {
		t.Fatalf("err = %v, want ErrInvalidInput", err)
	}
	if sessions.createCallCount != 0 {
		t.Fatalf("createCallCount = %d, want 0", sessions.createCallCount)
	}
}

func TestStartCommandPreservesCommaInImagePath(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestCodexStartCommand(NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))
	imagePath := filepath.Join(t.TempDir(), "shot,one.png")
	if err := os.WriteFile(imagePath, []byte("comma-path-bytes"), 0o600); err != nil {
		t.Fatalf("write image: %v", err)
	}

	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"image":  imagePath,
			"model":  "gpt-5",
			"prompt": "describe this",
		},
	}); err != nil {
		t.Fatalf("Handler: %v", err)
	}

	content := sessions.createInput.InitialContent
	if len(content) != 2 || content[1].Name != "shot,one.png" {
		t.Fatalf("initial content = %#v, want image with comma path", content)
	}
	decoded, err := base64.StdEncoding.DecodeString(content[1].Data)
	if err != nil || string(decoded) != "comma-path-bytes" {
		t.Fatalf("image block data decoded = %q err=%v", string(decoded), err)
	}
}

func TestStartCommandInheritsCallerSessionCwd(t *testing.T) {
	sessions := &fakeAgentSessions{
		getSession: agentservice.Session{ID: "CALLER-1", Cwd: "/workspace/a"},
	}
	command := newTestClaudeStartCommand(NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))

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
	command := newTestCodexStartCommand(NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"cwd":    "/workspace/other",
			"model":  "gpt-5",
			"prompt": "do work",
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
	command := newTestCodexStartCommand(NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"model": "gpt-5", "prompt": "do work"},
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
	command := newTestCodexStartCommand(NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"model": "gpt-5", "prompt": "do work"},
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
		commandID  string
		want       string
		wantTarget string
	}{
		"codex":  {commandID: "agent-context.codex.start", want: "codex", wantTarget: agenttargetbiz.IDLocalCodex},
		"claude": {commandID: "agent-context.claude.start", want: "claude-code", wantTarget: agenttargetbiz.IDLocalClaudeCode},
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
		if sessions.createInput.AgentTargetID != tc.wantTarget {
			t.Fatalf("%s agent target id = %q, want %s", name, sessions.createInput.AgentTargetID, tc.wantTarget)
		}
	}
}

func TestProviderCapabilitiesFilterAgentAppsByAvailability(t *testing.T) {
	for name, tc := range map[string]struct {
		availability    []agentservice.ProviderAvailability
		availabilityErr error
		wantAppIDs      []string
	}{
		"both available": {
			availability: []agentservice.ProviderAvailability{
				availableProvider("codex"),
				availableProvider("claude-code"),
			},
			wantAppIDs: []string{codexAgentAppID, claudeCodeAgentAppID},
		},
		"codex unavailable": {
			availability: []agentservice.ProviderAvailability{
				providerAvailability("codex", agentservice.ProviderAvailabilityUnavailable),
				availableProvider("claude-code"),
			},
			wantAppIDs: []string{claudeCodeAgentAppID},
		},
		"claude unavailable": {
			availability: []agentservice.ProviderAvailability{
				availableProvider("codex"),
				providerAvailability("claude-code", agentservice.ProviderAvailabilityUnavailable),
			},
			wantAppIDs: []string{codexAgentAppID},
		},
		"unknown hidden": {
			availability: []agentservice.ProviderAvailability{
				providerAvailability("codex", agentservice.ProviderAvailabilityUnknown),
				availableProvider("claude-code"),
			},
			wantAppIDs: []string{claudeCodeAgentAppID},
		},
		"missing hidden": {
			availability: []agentservice.ProviderAvailability{
				availableProvider("codex"),
			},
			wantAppIDs: []string{codexAgentAppID},
		},
		"availability error hides both": {
			availabilityErr: errors.New("availability failed"),
			wantAppIDs:      []string{},
		},
	} {
		t.Run(name, func(t *testing.T) {
			sessions := &fakeAgentSessions{
				availability:    tc.availability,
				availabilityErr: tc.availabilityErr,
			}
			registry, err := cliservice.NewRegistryFromProviders(
				NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions),
			)
			if err != nil {
				t.Fatalf("NewRegistryFromProviders: %v", err)
			}

			capabilities := registry.Capabilities(context.Background(), cliservice.InvokeContext{WorkspaceID: "workspace-1"})
			if got := providerAgentAppIDs(capabilities); !equalStrings(got, tc.wantAppIDs) {
				t.Fatalf("provider agent app ids = %#v, want %#v; capabilities=%#v", got, tc.wantAppIDs, capabilityIDs(capabilities))
			}
			if !containsString(capabilityIDs(capabilities), appID+".agent.start") {
				t.Fatalf("generic agent start capability missing: %#v", capabilityIDs(capabilities))
			}
			if len(sessions.availabilityIn) != 1 || sessions.availabilityIn[0].Provider != "" {
				t.Fatalf("availability inputs = %#v, want one unfiltered request", sessions.availabilityIn)
			}
		})
	}
}

func TestProviderCapabilitiesHideAgentAppsWithoutSessions(t *testing.T) {
	registry, err := cliservice.NewRegistryFromProviders(
		NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, nil),
	)
	if err != nil {
		t.Fatalf("NewRegistryFromProviders: %v", err)
	}

	capabilities := registry.Capabilities(context.Background(), cliservice.InvokeContext{WorkspaceID: "workspace-1"})
	if got := providerAgentAppIDs(capabilities); len(got) != 0 {
		t.Fatalf("provider agent app ids = %#v, want none", got)
	}
	if !containsString(capabilityIDs(capabilities), appID+".agent.start") {
		t.Fatalf("generic agent start capability missing: %#v", capabilityIDs(capabilities))
	}
}

func TestProviderCapabilityFilterKeepsGenericAndNonAgentAppCapabilities(t *testing.T) {
	provider := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, &fakeAgentSessions{
		availability: []agentservice.ProviderAvailability{
			providerAvailability("codex", agentservice.ProviderAvailabilityUnavailable),
			providerAvailability("claude-code", agentservice.ProviderAvailabilityUnavailable),
		},
	})

	capabilities := []cliservice.Capability{
		{
			ID:     appID + ".codex.start",
			Source: cliservice.CapabilitySource{Kind: cliservice.CapabilitySourceApp, AppID: codexAgentAppID},
		},
		{
			ID:     appID + ".agent.start",
			Source: cliservice.CapabilitySource{Kind: cliservice.CapabilitySourceBuiltin},
		},
		{
			ID:     "workspace.other.start",
			Source: cliservice.CapabilitySource{Kind: cliservice.CapabilitySourceApp, AppID: "other-app"},
		},
	}

	filtered := provider.FilterCapabilities(context.Background(), cliservice.InvokeContext{WorkspaceID: "workspace-1"}, capabilities)
	if got, want := capabilityIDs(filtered), []string{appID + ".agent.start", "workspace.other.start"}; !equalStrings(got, want) {
		t.Fatalf("capability ids = %#v, want %#v", got, want)
	}
}

func TestProviderHiddenAgentAppCapabilityRemainsInvokable(t *testing.T) {
	sessions := &fakeAgentSessions{
		availability: []agentservice.ProviderAvailability{
			providerAvailability("codex", agentservice.ProviderAvailabilityUnavailable),
			availableProvider("claude-code"),
		},
	}
	registry, err := cliservice.NewRegistryFromProviders(
		NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions),
	)
	if err != nil {
		t.Fatalf("NewRegistryFromProviders: %v", err)
	}
	capabilities := registry.Capabilities(context.Background(), cliservice.InvokeContext{WorkspaceID: "workspace-1"})
	if got := providerAgentAppIDs(capabilities); !equalStrings(got, []string{claudeCodeAgentAppID}) {
		t.Fatalf("provider agent app ids = %#v, want claude only", got)
	}

	if _, err := registry.Invoke(context.Background(), cliservice.InvokeRequest{
		CommandID: appID + ".codex.start",
		Input: map[string]any{
			"model":  "gpt-5",
			"prompt": "do work",
			"speed":  "fast",
		},
	}); err != nil {
		t.Fatalf("Invoke hidden codex command: %v", err)
	}
	if sessions.createInput.Provider != "codex" {
		t.Fatalf("created provider = %q, want codex", sessions.createInput.Provider)
	}
	if sessions.createInput.AgentTargetID != agenttargetbiz.IDLocalCodex {
		t.Fatalf("created agent target id = %q, want %s", sessions.createInput.AgentTargetID, agenttargetbiz.IDLocalCodex)
	}
	if sessions.createInput.Speed == nil || *sessions.createInput.Speed != "fast" {
		t.Fatalf("created speed = %#v, want fast", sessions.createInput.Speed)
	}
}

func TestProviderStartCommandRequiresPrompt(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestCodexStartCommand(NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))
	required, ok := command.Capability.InputSchema["required"].([]string)
	if !ok {
		t.Fatalf("required schema = %#v", command.Capability.InputSchema["required"])
	}
	if len(required) != 1 || required[0] != "prompt" {
		t.Fatalf("required = %#v", required)
	}
	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{Input: map[string]any{"model": "gpt-5"}})
	if !errors.Is(err, cliservice.ErrInvalidInput) {
		t.Fatalf("err = %v, want ErrInvalidInput", err)
	}
	if sessions.createCallCount != 0 {
		t.Fatalf("createCallCount = %d, want 0", sessions.createCallCount)
	}

	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"prompt": "do work"},
	}); err != nil {
		t.Fatalf("Handler without model: %v", err)
	}
	if sessions.createCallCount != 1 {
		t.Fatalf("createCallCount = %d, want 1", sessions.createCallCount)
	}
	if sessions.createInput.Model != nil {
		t.Fatalf("Model = %#v, want nil when omitted", sessions.createInput.Model)
	}
	if sessions.createInput.AgentTargetID != agenttargetbiz.IDLocalCodex {
		t.Fatalf("agent target id = %q, want %s", sessions.createInput.AgentTargetID, agenttargetbiz.IDLocalCodex)
	}
}

func TestProviderStartCommandUsesComposerDefaults(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestCodexStartCommand(NewProviderWithLaunchPublisher(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		sessions,
		nil,
		fakeDesktopPreferencesReader{preferences: preferencesbiz.DesktopPreferences{
			AgentConversationDetailMode: preferencesbiz.DesktopAgentConversationDetailModeGeneral,
			AgentComposerDefaultsByAgentTarget: map[string]preferencesbiz.AgentComposerDefaults{
				"local:codex": {
					Model:            "gpt-5.5",
					PermissionModeID: "full-access",
					ReasoningEffort:  "high",
				},
			},
		}},
	))

	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"prompt": "do work"},
	}); err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.createInput.Model == nil || *sessions.createInput.Model != "gpt-5.5" {
		t.Fatalf("Model = %#v, want composer default", sessions.createInput.Model)
	}
	if sessions.createInput.PermissionModeID == nil || *sessions.createInput.PermissionModeID != "full-access" {
		t.Fatalf("PermissionModeID = %#v, want composer default", sessions.createInput.PermissionModeID)
	}
	if sessions.createInput.ReasoningEffort == nil || *sessions.createInput.ReasoningEffort != "high" {
		t.Fatalf("ReasoningEffort = %#v, want composer default", sessions.createInput.ReasoningEffort)
	}
	if sessions.createInput.ConversationDetailMode != preferencesbiz.DesktopAgentConversationDetailModeGeneral {
		t.Fatalf("ConversationDetailMode = %q, want general", sessions.createInput.ConversationDetailMode)
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

func TestSendCommandConvertsImageFilesToPromptContentBlocks(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := NewProvider(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		sessions,
	).newSendCommand()
	imagePath := filepath.Join(t.TempDir(), "frame.webp")
	if err := os.WriteFile(imagePath, []byte("webp-bytes"), 0o600); err != nil {
		t.Fatalf("write image: %v", err)
	}

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"guidance":   true,
			"image":      []any{imagePath},
			"prompt":     "continue with this",
			"session-id": "SESSION-1",
		},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}

	if output.Rows[0]["id"] != "SESSION-1" || sessions.workspaceID != "workspace-1" || sessions.sessionID != "SESSION-1" {
		t.Fatalf("output = %#v sessions = %#v", output.Rows, sessions)
	}
	if !sessions.sendInput.Guidance {
		t.Fatalf("send guidance = false, want true")
	}
	content := sessions.sendInput.Content
	if len(content) != 2 {
		t.Fatalf("send content = %#v, want text + image", content)
	}
	if content[1].Type != "image" || content[1].MimeType != "image/webp" || content[1].Name != "frame.webp" {
		t.Fatalf("image block metadata = %#v", content[1])
	}
	decoded, err := base64.StdEncoding.DecodeString(content[1].Data)
	if err != nil || string(decoded) != "webp-bytes" {
		t.Fatalf("image block data decoded = %q err=%v", string(decoded), err)
	}
}

func TestSendCommandExposesGuidanceFlagInSchema(t *testing.T) {
	command := NewProvider(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		&fakeAgentSessions{},
	).newSendCommand()

	properties, ok := command.Capability.InputSchema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("input schema properties = %#v", command.Capability.InputSchema["properties"])
	}
	guidance, ok := properties["guidance"].(map[string]any)
	if !ok {
		t.Fatalf("guidance schema = %#v", properties["guidance"])
	}
	if guidance["type"] != "boolean" {
		t.Fatalf("guidance type = %#v, want boolean", guidance["type"])
	}
	description, _ := guidance["description"].(string)
	if !strings.Contains(description, "currently active turn") {
		t.Fatalf("guidance description = %#v", guidance["description"])
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
	if agents[0].(map[string]any)["cwd"] != "/workspace/repo" {
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
