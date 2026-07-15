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
	err         error
}

type fakeAgentTargetLister struct{}

func (fakeAgentTargetLister) List(context.Context) ([]agenttargetbiz.Target, error) {
	return agenttargetbiz.DefaultSystemTargets(1), nil
}

type fakeAgentTargetList struct {
	targets []agenttargetbiz.Target
}

func (f fakeAgentTargetList) List(context.Context) ([]agenttargetbiz.Target, error) {
	return f.targets, nil
}

func (f fakeDesktopPreferencesReader) Get(context.Context) (preferencesbiz.DesktopPreferences, error) {
	return f.preferences, f.err
}

type fakeAgentSessions struct {
	workspaceID     string
	sessionID       string
	cancelCallCount int
	limit           int
	waitInput       agentservice.WaitInput
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
	waitResult      agentservice.WaitResult
}

func newTestProvider(workspaces cliservice.WorkspaceCatalog, sessions AgentSessions) Provider {
	return NewProviderWithAgentTargets(workspaces, sessions, nil, fakeAgentTargetLister{})
}

func newTestCodexStartCommand(provider Provider) cliservice.Command {
	if provider.agentTargets == nil {
		provider.agentTargets = fakeAgentTargetLister{}
	}
	return provider.newStartCommand()
}

func newTestClaudeStartCommand(provider Provider) cliservice.Command {
	if provider.agentTargets == nil {
		provider.agentTargets = fakeAgentTargetLister{}
	}
	return provider.newStartCommand()
}

func (f *fakeAgentSessions) CancelTurn(_ context.Context, workspaceID string, sessionID string, _ string) (agentservice.CancelTurnResult, error) {
	f.workspaceID = workspaceID
	f.sessionID = sessionID
	f.cancelCallCount++
	return agentservice.CancelTurnResult{Canceled: true, Reason: agentservice.CancelTurnReasonTurnCanceled}, nil
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
		ID:            "SESSION-NEW",
		AgentTargetID: input.AgentTargetID,
		Provider:      input.Provider,
		Cwd:           cwd,
		Visible:       visible,
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
	return agentservice.Session{ID: sessionID, Provider: "codex", Visible: true}, nil
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
		SchemaVersion:  2,
		AgentTargetID:  input.AgentTargetID,
		Provider:       "codex",
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
		{ID: "SESSION-1", Provider: "codex", ActiveTurnID: "turn-1", Title: &title, CreatedAt: time.Unix(1, 0)},
		{ID: "SESSION-2", Provider: "claude", CreatedAt: time.Unix(2, 0)},
	}, nil
}

func (f *fakeAgentSessions) ListActivePeers(_ context.Context, workspaceID string) (agentservice.ActivePeers, error) {
	f.workspaceID = workspaceID
	title := "Work"
	return agentservice.ActivePeers{
		Agents: []agentservice.ActivePeer{{
			Session:      agentservice.Session{ID: "SESSION-1", Provider: "codex", Cwd: "/workspace/repo", ActiveTurnID: "turn-1", Title: &title, CreatedAt: time.Unix(1, 0)},
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
		Session: agentservice.Session{ID: sessionID, Provider: "codex", ActiveTurnID: "turn-1", Visible: true},
	}, nil
}

func (f *fakeAgentSessions) Wait(_ context.Context, input agentservice.WaitInput) (agentservice.WaitResult, error) {
	f.workspaceID = input.WorkspaceID
	f.sessionID = input.AgentSessionID
	f.waitInput = input
	if f.waitResult.Session.ID != "" || f.waitResult.Reason != "" {
		return f.waitResult, nil
	}
	effectiveAfter := uint64(0)
	if input.AfterVersion != nil {
		effectiveAfter = *input.AfterVersion
	}
	return agentservice.WaitResult{
		Session: agentservice.Session{
			ID:           input.AgentSessionID,
			Provider:     "codex",
			ActiveTurnID: "turn-1",
			Visible:      true,
		},
		Messages: []agentservice.SessionMessage{{
			AgentSessionID: input.AgentSessionID,
			MessageID:      "message-2",
			Role:           "assistant",
			Kind:           "text",
			Status:         "completed",
			Payload:        map[string]any{"content": "Recent output"},
			Version:        6,
		}},
		LatestVersion:  6,
		Reason:         agentservice.WaitReasonWaitingInput,
		EffectiveAfter: effectiveAfter,
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

func waitAfterVersionValue(value *uint64) (uint64, bool) {
	if value == nil {
		return 0, false
	}
	return *value, true
}

func TestSessionSummaryCommandUsesLimitAndAfterVersion(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newSessionSummaryCommand()

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
	command := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newSessionSummaryCommand()

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
	command := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newTurnResourcesCommand()

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
	command := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newTurnResourcesCommand()

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
	command := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newSessionSummaryCommand()

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
	command := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newSessionSummaryCommand()

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"session-id": "SESSION-1", "order": "sideways"},
	})
	if !errors.Is(err, cliservice.ErrInvalidInput) {
		t.Fatalf("err = %v, want ErrInvalidInput", err)
	}
}

func TestWaitCommandReturnsStopPointWithoutMessages(t *testing.T) {
	sessions := &fakeAgentSessions{
		waitResult: agentservice.WaitResult{
			Session: agentservice.Session{
				ID:           "SESSION-1",
				Provider:     "codex",
				ActiveTurnID: "turn-1",
				Visible:      true,
				ActiveTurn:   &agentactivitybiz.Turn{TurnID: "turn-1", Phase: agentactivitybiz.TurnPhaseWaiting},
			},
			Messages: []agentservice.SessionMessage{
				{
					AgentSessionID: "SESSION-1",
					MessageID:      "assistant-1",
					Role:           "assistant",
					Kind:           "text",
					Status:         "completed",
					Payload:        map[string]any{"content": "First reply"},
					Version:        8,
				},
				{
					AgentSessionID: "SESSION-1",
					MessageID:      "tool-1",
					Role:           "tool",
					Kind:           "call",
					Status:         "completed",
					Payload:        map[string]any{"name": "Read files", "status": "completed"},
					Version:        9,
				},
			},
			LatestVersion:  9,
			HasMore:        true,
			Reason:         agentservice.WaitReasonWaitingInput,
			EffectiveAfter: 7,
		},
	}
	command := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newWaitCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"session-id": "SESSION-1", "after-version": "7", "timeout-ms": "2500"},
		OutputMode: cliservice.OutputModeJSON,
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	waitAfterVersion, ok := waitAfterVersionValue(sessions.waitInput.AfterVersion)
	if sessions.waitInput.WorkspaceID != "workspace-1" ||
		sessions.waitInput.AgentSessionID != "SESSION-1" ||
		!ok ||
		waitAfterVersion != 7 ||
		sessions.waitInput.MessageLimit != 0 ||
		!sessions.waitInput.SkipMessages ||
		sessions.waitInput.Timeout != 2500*time.Millisecond {
		t.Fatalf("wait input = %#v", sessions.waitInput)
	}
	if output.Value["agentSessionId"] != "SESSION-1" ||
		output.Value["reason"] != "waiting_input" ||
		output.Value["timedOut"] != false ||
		output.Value["latestVersion"] != uint64(9) ||
		output.Value["effectiveAfter"] != uint64(7) {
		t.Fatalf("output = %#v", output.Value)
	}
	session := output.Value["session"].(map[string]any)
	if _, ok := session["settings"]; ok {
		t.Fatalf("wait session should stay compact: %#v", session)
	}
	for _, key := range []string{"messages", "hasMore"} {
		if _, ok := output.Value[key]; ok {
			t.Fatalf("wait output should omit %q: %#v", key, output.Value)
		}
	}
}

func TestWaitCommandPreservesExplicitZeroAfterVersion(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newWaitCommand()

	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"session-id": "SESSION-1", "after-version": "0"},
		OutputMode: cliservice.OutputModeJSON,
	}); err != nil {
		t.Fatalf("Handler: %v", err)
	}
	waitAfterVersion, ok := waitAfterVersionValue(sessions.waitInput.AfterVersion)
	if !ok || waitAfterVersion != 0 {
		t.Fatalf("wait after version = %#v, want explicit zero", sessions.waitInput.AfterVersion)
	}
}

func TestWaitCommandExposesOnlyWaitParameters(t *testing.T) {
	command := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, &fakeAgentSessions{}).newWaitCommand()

	properties := command.Capability.InputSchema["properties"].(map[string]any)
	for _, key := range []string{"session-id", "after-version", "timeout-ms"} {
		if _, ok := properties[key]; !ok {
			t.Fatalf("wait schema should include %q: %#v", key, properties)
		}
	}
	if _, ok := properties["limit"]; ok {
		t.Fatalf("wait schema should omit limit: %#v", properties)
	}
}

func TestWaitCommandUsesDefaultTimeout(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newWaitCommand()

	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"session-id": "SESSION-1"},
		OutputMode: cliservice.OutputModeJSON,
	}); err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.waitInput.AfterVersion != nil {
		t.Fatalf("after version = %#v, want nil when omitted", sessions.waitInput.AfterVersion)
	}
	if !sessions.waitInput.SkipMessages {
		t.Fatalf("skip messages = false, want true")
	}
	if sessions.waitInput.Timeout != 5*time.Minute {
		t.Fatalf("timeout = %v, want 5m", sessions.waitInput.Timeout)
	}
}

func TestStartCommandPassesDisplayPrompt(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestCodexStartCommand(newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"agent-id":       agenttargetbiz.IDLocalCodex,
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

func TestStartCommandRequiresOneSelectorAndPrompt(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newStartCommand()
	required, ok := command.Capability.InputSchema["required"].([]string)
	if !ok {
		t.Fatalf("required schema = %#v", command.Capability.InputSchema["required"])
	}
	if len(required) != 2 || required[0] != "agent-id" || required[1] != "prompt" {
		t.Fatalf("required = %#v", required)
	}

	for name, input := range map[string]map[string]any{
		"missing agent id": {"model": "gpt-5", "prompt": "do work"},
		"missing prompt":   {"agent-id": agenttargetbiz.IDLocalCodex, "model": "gpt-5"},
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
		Input: map[string]any{"agent-id": agenttargetbiz.IDLocalCodex, "prompt": "do work"},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.createCallCount != 1 || sessions.createInput.AgentTargetID != agenttargetbiz.IDLocalCodex {
		t.Fatalf("create input = %#v, count = %d", sessions.createInput, sessions.createCallCount)
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
		Input: map[string]any{"agent-id": agenttargetbiz.IDLocalCodex, "prompt": "do work"},
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

func TestAgentsCommandReturnsAvailability(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newAgentsCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"agent-id": agenttargetbiz.IDLocalCodex},
		OutputMode: cliservice.OutputModeJSON,
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	agents := output.Value["agents"].([]any)
	if len(agents) != 1 || agents[0].(map[string]any)["id"] != agenttargetbiz.IDLocalCodex {
		t.Fatalf("agents = %#v", agents)
	}
	if output.Value["defaultAgentTargetId"] != agenttargetbiz.IDLocalCodex {
		t.Fatalf("defaultAgentTargetId = %#v, want global default %q", output.Value["defaultAgentTargetId"], agenttargetbiz.IDLocalCodex)
	}
	if len(sessions.availabilityIn) != 1 || sessions.availabilityIn[0].Provider != "codex" {
		t.Fatalf("availability inputs = %#v, want only requested provider", sessions.availabilityIn)
	}
}

func TestComposerOptionsCommandReturnsProviderOptions(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newComposerOptionsCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"locale":           "zh-CN",
			"model":            "gpt-5",
			"permission-mode":  "auto",
			"agent-id":         agenttargetbiz.IDLocalCodex,
			"reasoning-effort": "high",
		},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.composerInput.AgentTargetID != agenttargetbiz.IDLocalCodex || sessions.composerInput.Locale != "zh-CN" || sessions.composerInput.Provider != "codex" || sessions.composerInput.Settings.Model != "gpt-5" || sessions.composerInput.Settings.PermissionModeID != "auto" || sessions.composerInput.Settings.ReasoningEffort != "high" {
		t.Fatalf("composer input = %#v", sessions.composerInput)
	}
	if sessions.composerInput.IncludeCapabilityCatalog == nil || *sessions.composerInput.IncludeCapabilityCatalog {
		t.Fatalf("include capability catalog = %#v, want explicit false", sessions.composerInput.IncludeCapabilityCatalog)
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
	command := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newComposerOptionsCommand()

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"agent-id": agenttargetbiz.IDLocalCodex,
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
	command := NewProviderWithAgentTargets(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		sessions,
		nil,
		fakeAgentTargetLister{},
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
			"agent-id": agenttargetbiz.IDLocalCodex,
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
	command := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newSkillBundleCommand()
	if command.Capability.ID != appID+".agent.tutti-cli-skill-bundle" ||
		strings.Join(command.Capability.Path, " ") != "agent tutti-cli-skill-bundle" {
		t.Fatalf("command capability = %#v", command.Capability)
	}
	if command.Capability.Visibility != cliservice.CapabilityVisibilityIntegration {
		t.Fatalf("visibility = %q, want integration", command.Capability.Visibility)
	}

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"agent-id":         agenttargetbiz.IDLocalCodex,
			"agent-session-id": "run-1",
			"browser-use":      "true",
		},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.workspaceID != "workspace-1" {
		t.Fatalf("workspaceID = %q, want workspace-1", sessions.workspaceID)
	}
	if sessions.skillBundleIn.AgentTargetID != agenttargetbiz.IDLocalCodex ||
		sessions.skillBundleIn.AgentSessionID != "run-1" ||
		!sessions.skillBundleIn.BrowserUse ||
		sessions.skillBundleIn.ComputerUse {
		t.Fatalf("skill bundle input = %#v", sessions.skillBundleIn)
	}
	if output.Kind != cliservice.OutputModeJSON {
		t.Fatalf("output kind = %q, want json", output.Kind)
	}
	if output.Value["agentTargetId"] != agenttargetbiz.IDLocalCodex {
		t.Fatalf("agentTargetId = %#v", output.Value["agentTargetId"])
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
	if output.Value["schemaVersion"] != 2 ||
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

func TestStartCommandLeavesVisibilityUnsetAndShowPublishesLaunch(t *testing.T) {
	sessions := &fakeAgentSessions{}
	publisher := &fakeAgentGUILaunchPublisher{}
	provider := NewProviderWithLaunchPublisher(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		sessions,
		publisher,
	)
	command := newTestCodexStartCommand(provider)

	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"agent-id": agenttargetbiz.IDLocalCodex, "model": "gpt-5", "prompt": "do work"},
		Context: cliservice.InvokeContext{
			Source: "cli",
		},
	}); err != nil {
		t.Fatalf("Handler default visibility: %v", err)
	}
	if sessions.createInput.Visible != nil {
		t.Fatalf("Visible = %#v, want nil", sessions.createInput.Visible)
	}
	if len(publisher.requests) != 0 {
		t.Fatalf("launch requests = %#v, want none", publisher.requests)
	}

	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"agent-id": agenttargetbiz.IDLocalCodex, "model": "gpt-5", "prompt": "do work", "show": "true"},
		Context: cliservice.InvokeContext{
			Source: "cli",
		},
	}); err != nil {
		t.Fatalf("Handler show: %v", err)
	}
	if sessions.createInput.Visible != nil {
		t.Fatalf("Visible = %#v, want nil", sessions.createInput.Visible)
	}
	if len(publisher.requests) != 1 || publisher.requests[0].AgentSessionID != "SESSION-NEW" || publisher.requests[0].AgentTargetID != agenttargetbiz.IDLocalCodex || publisher.requests[0].Source != "cli" {
		t.Fatalf("launch requests = %#v", publisher.requests)
	}
}

func TestStartCommandShowDoesNotHideSession(t *testing.T) {
	sessions := &fakeAgentSessions{}
	publisher := &fakeAgentGUILaunchPublisher{}
	provider := NewProviderWithLaunchPublisher(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		sessions,
		publisher,
	)
	command := newTestCodexStartCommand(provider)

	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"agent-id": agenttargetbiz.IDLocalCodex,
			"model":    "gpt-5",
			"prompt":   "do work",
			"show":     "true",
		},
		Context: cliservice.InvokeContext{
			Source: "cli",
		},
	}); err != nil {
		t.Fatalf("Handler show: %v", err)
	}
	if sessions.createInput.Visible != nil {
		t.Fatalf("Visible = %#v, want nil", sessions.createInput.Visible)
	}
	if len(publisher.requests) != 1 || publisher.requests[0].Reason != "start_show" {
		t.Fatalf("launch requests = %#v", publisher.requests)
	}
}

func TestStartCommandHiddenCreatesHiddenSession(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestCodexStartCommand(newTestProvider(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		sessions,
	))

	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"agent-id": agenttargetbiz.IDLocalCodex,
			"model":    "gpt-5",
			"prompt":   "do work",
			"hidden":   "true",
		},
		Context: cliservice.InvokeContext{
			Source: "cli",
		},
	}); err != nil {
		t.Fatalf("Handler hidden: %v", err)
	}
	if sessions.createInput.Visible == nil || *sessions.createInput.Visible {
		t.Fatalf("Visible = %#v, want false", sessions.createInput.Visible)
	}
}

func TestStartCommandPassesComposerSettings(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestCodexStartCommand(newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))

	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"agent-id":         agenttargetbiz.IDLocalCodex,
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
	command := newTestCodexStartCommand(newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))
	imagePath := filepath.Join(t.TempDir(), "shot.png")
	if err := os.WriteFile(imagePath, []byte("png-bytes"), 0o600); err != nil {
		t.Fatalf("write image: %v", err)
	}

	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"agent-id": agenttargetbiz.IDLocalCodex,
			"image":    imagePath,
			"model":    "gpt-5",
			"prompt":   "describe this",
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
	command := newTestCodexStartCommand(newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"agent-id": agenttargetbiz.IDLocalCodex,
			"image":    filepath.Join(t.TempDir(), "notes.txt"),
			"model":    "gpt-5",
			"prompt":   "describe this",
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
	command := newTestCodexStartCommand(newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))
	imagePath := filepath.Join(t.TempDir(), "shot,one.png")
	if err := os.WriteFile(imagePath, []byte("comma-path-bytes"), 0o600); err != nil {
		t.Fatalf("write image: %v", err)
	}

	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"agent-id": agenttargetbiz.IDLocalCodex,
			"image":    imagePath,
			"model":    "gpt-5",
			"prompt":   "describe this",
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
	command := newTestClaudeStartCommand(newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"agent-id": agenttargetbiz.IDLocalClaudeCode, "model": "sonnet", "prompt": "do work"},
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
	command := newTestCodexStartCommand(newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"agent-id": agenttargetbiz.IDLocalCodex,
			"cwd":      "/workspace/other",
			"model":    "gpt-5",
			"prompt":   "do work",
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
	command := newTestCodexStartCommand(newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"agent-id": agenttargetbiz.IDLocalCodex, "model": "gpt-5", "prompt": "do work"},
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
	command := newTestCodexStartCommand(newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"agent-id": agenttargetbiz.IDLocalCodex, "model": "gpt-5", "prompt": "do work"},
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

func TestProviderCommandsKeepExactDeprecatedLaunchAdapters(t *testing.T) {
	provider := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, &fakeAgentSessions{})
	commands := provider.Commands()
	start := commandByID(t, commands, "agent-context.agent.start")
	if strings.Join(start.Capability.Path, " ") != "agent start" {
		t.Fatalf("agent start capability = %#v", start.Capability)
	}
	for id, path := range map[string]string{
		"agent-context.codex.start":  "codex start",
		"agent-context.claude.start": "claude start",
	} {
		command := commandByID(t, commands, id)
		if strings.Join(command.Capability.Path, " ") != path ||
			!strings.Contains(command.Capability.Description, "Deprecated") ||
			command.Capability.Visibility != cliservice.CapabilityVisibilityIntegration {
			t.Fatalf("legacy adapter = %#v", command.Capability)
		}
	}
	providers := commandByID(t, commands, "agent-context.agent.providers")
	if providers.Capability.Visibility != cliservice.CapabilityVisibilityIntegration {
		t.Fatalf("legacy provider catalog visibility = %q", providers.Capability.Visibility)
	}
	for _, command := range commands {
		if strings.Join(command.Capability.Path, " ") == "tutti-agent start" {
			t.Fatalf("never-supported launcher registered: %#v", command.Capability)
		}
	}
}

func TestAgentListKeepsMultipleAgentsForOneProvider(t *testing.T) {
	targets := append([]agenttargetbiz.Target{{
		ID:            "user:reviewer",
		Provider:      "codex",
		LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
		Name:          "Reviewer",
		Enabled:       true,
		Source:        agenttargetbiz.SourceUser,
		SortOrder:     0,
	}}, agenttargetbiz.DefaultSystemTargets(1)...)
	provider := NewProviderWithAgentTargets(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		&fakeAgentSessions{}, nil, fakeAgentTargetList{targets: targets},
	)
	output, err := provider.newAgentsCommand().Handler(context.Background(), cliservice.InvokeRequest{OutputMode: cliservice.OutputModeJSON})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	agents := output.Value["agents"].([]any)
	codexAgentIDs := []string{}
	for _, value := range agents {
		agent := value.(map[string]any)
		if agent["provider"] == "codex" {
			codexAgentIDs = append(codexAgentIDs, agent["id"].(string))
		}
	}
	if !equalStrings(codexAgentIDs, []string{"user:reviewer", agenttargetbiz.IDLocalCodex}) {
		t.Fatalf("codex agent ids = %#v", codexAgentIDs)
	}
	if output.Value["defaultAgentTargetId"] != agenttargetbiz.IDLocalCodex {
		t.Fatalf("defaultAgentTargetId = %#v, want exact built-in target %q", output.Value["defaultAgentTargetId"], agenttargetbiz.IDLocalCodex)
	}
}

func TestAgentListPreservesPreferredProviderAsExactDefaultAgent(t *testing.T) {
	provider := NewProviderWithAgentTargets(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		&fakeAgentSessions{}, nil, fakeAgentTargetLister{},
		fakeDesktopPreferencesReader{preferences: preferencesbiz.DesktopPreferences{
			DefaultAgentProvider: "claude-code",
		}},
	)
	output, err := provider.newAgentsCommand().Handler(context.Background(), cliservice.InvokeRequest{OutputMode: cliservice.OutputModeJSON})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if output.Value["defaultAgentTargetId"] != agenttargetbiz.IDLocalClaudeCode {
		t.Fatalf("defaultAgentTargetId = %#v, want %q", output.Value["defaultAgentTargetId"], agenttargetbiz.IDLocalClaudeCode)
	}
}

func TestAgentListKeepsGlobalDefaultWhenFilteringAnotherAgent(t *testing.T) {
	provider := NewProviderWithAgentTargets(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		&fakeAgentSessions{}, nil, fakeAgentTargetLister{},
		fakeDesktopPreferencesReader{preferences: preferencesbiz.DesktopPreferences{DefaultAgentProvider: "codex"}},
	)
	output, err := provider.newAgentsCommand().Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"agent-id": agenttargetbiz.IDLocalClaudeCode},
		OutputMode: cliservice.OutputModeJSON,
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if output.Value["defaultAgentTargetId"] != agenttargetbiz.IDLocalCodex {
		t.Fatalf("defaultAgentTargetId = %#v, want global default %q", output.Value["defaultAgentTargetId"], agenttargetbiz.IDLocalCodex)
	}
}

func TestAgentListKeepsUnavailablePreferredTargetAsDefault(t *testing.T) {
	provider := NewProviderWithAgentTargets(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		&fakeAgentSessions{availability: []agentservice.ProviderAvailability{
			providerAvailability("codex", agentservice.ProviderAvailabilityUnavailable),
			availableProvider("claude-code"),
		}}, nil, fakeAgentTargetLister{},
		fakeDesktopPreferencesReader{preferences: preferencesbiz.DesktopPreferences{DefaultAgentProvider: "codex"}},
	)
	output, err := provider.newAgentsCommand().Handler(context.Background(), cliservice.InvokeRequest{OutputMode: cliservice.OutputModeJSON})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if output.Value["defaultAgentTargetId"] != agenttargetbiz.IDLocalCodex {
		t.Fatalf("defaultAgentTargetId = %#v, want unavailable preferred target %q", output.Value["defaultAgentTargetId"], agenttargetbiz.IDLocalCodex)
	}
}

func TestAgentListFallsBackWhenDesktopPreferencesCannotBeRead(t *testing.T) {
	provider := NewProviderWithAgentTargets(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		&fakeAgentSessions{}, nil, fakeAgentTargetLister{},
		fakeDesktopPreferencesReader{err: errors.New("preferences unavailable")},
	)
	output, err := provider.newAgentsCommand().Handler(context.Background(), cliservice.InvokeRequest{OutputMode: cliservice.OutputModeJSON})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if output.Value["defaultAgentTargetId"] != agenttargetbiz.IDLocalCodex {
		t.Fatalf("defaultAgentTargetId = %#v, want built-in fallback %q", output.Value["defaultAgentTargetId"], agenttargetbiz.IDLocalCodex)
	}
}

func TestAgentStartCommandAllowsOmittedModel(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestCodexStartCommand(newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions))
	required, ok := command.Capability.InputSchema["required"].([]string)
	if !ok {
		t.Fatalf("required schema = %#v", command.Capability.InputSchema["required"])
	}
	if len(required) != 2 || required[0] != "agent-id" || required[1] != "prompt" {
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
		Input: map[string]any{"agent-id": agenttargetbiz.IDLocalCodex, "prompt": "do work"},
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

func TestAgentStartCommandUsesComposerDefaults(t *testing.T) {
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
		Input: map[string]any{"agent-id": agenttargetbiz.IDLocalCodex, "prompt": "do work"},
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
	sessions := &fakeAgentSessions{getSession: agentservice.Session{
		ID:            "SESSION-1",
		AgentTargetID: "extension:gemini",
		Provider:      "gemini",
		Visible:       true,
	}}
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
	if len(publisher.requests) != 1 || publisher.requests[0].AgentSessionID != "SESSION-1" || publisher.requests[0].AgentTargetID != "extension:gemini" || publisher.requests[0].Provider != "gemini" || publisher.requests[0].Reason != "open" {
		t.Fatalf("launch requests = %#v", publisher.requests)
	}
}

func TestGetCommandReturnsSession(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestProvider(
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
	command := newTestProvider(
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

func TestSendCommandReturnsWaitAfterVersionInJSON(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestProvider(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		sessions,
	).newSendCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"prompt":     "continue",
			"session-id": "SESSION-1",
		},
		OutputMode: cliservice.OutputModeJSON,
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.limit != 1 || sessions.order != agentactivitybiz.MessageOrderDesc {
		t.Fatalf("list messages input = limit %d order %q", sessions.limit, sessions.order)
	}
	if output.Value["waitAfterVersion"] != uint64(2) {
		t.Fatalf("output = %#v", output.Value)
	}
}

func TestSendCommandExposesGuidanceFlagInSchema(t *testing.T) {
	command := newTestProvider(
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
	sessions := &fakeAgentSessions{getSession: agentservice.Session{
		ID: "SESSION-1", Provider: "codex", ActiveTurnID: "turn-1", Visible: true,
	}}
	command := newTestProvider(
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
	if output.Rows[0]["id"] != "SESSION-1" {
		t.Fatalf("output = %#v", output)
	}
}

func TestSessionSummaryIncludesCompactSession(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newSessionSummaryCommand()

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
	commands := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, &fakeAgentSessions{}).Commands()
	for _, command := range commands {
		if command.Capability.ID == "agent-context.agent.session.messages" {
			t.Fatalf("removed command still registered: %q", command.Capability.ID)
		}
	}
}

func TestActivePeersReturnsServiceProjection(t *testing.T) {
	command := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, &fakeAgentSessions{}).newActivePeersCommand()

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
