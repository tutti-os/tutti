package agentruntime

import (
	"context"
	"strings"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
)

func TestControllerRoutesChildInteractionThroughRootLiveSession(t *testing.T) {
	t.Parallel()
	adapter := &statefulInteractiveAdapter{}
	adapter.submitHook = func(session Session) {
		if session.AgentSessionID != "root-session" {
			t.Fatalf("adapter session = %q, want root live session", session.AgentSessionID)
		}
	}
	controller := NewController([]Adapter{adapter}, nil)
	if _, err := controller.Start(context.Background(), StartInput{
		RoomID: "room-1", AgentSessionID: "root-session", Provider: ProviderCodex, Title: "Codex",
	}); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
		RoomID:             "room-1",
		RootAgentSessionID: "root-session",
		AgentSessionID:     "child-session",
		TurnID:             "child-turn",
		RequestID:          "child-request",
		OptionID:           "allow",
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if adapter.interactiveInput.AgentSessionID != "child-session" ||
		adapter.interactiveInput.TurnID != "child-turn" ||
		adapter.interactiveInput.RequestID != "child-request" {
		t.Fatalf("adapter target = %#v", adapter.interactiveInput)
	}
}

func TestControllerSubmitInteractiveDelegatesToAdapter(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           "room-1",
		AgentSessionID:   "agent-session-1",
		Provider:         ProviderCodex,
		CWD:              "/workspace",
		Title:            "Codex",
		PermissionModeID: "auto",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	result, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
		RoomID:             "room-1",
		RootAgentSessionID: started.Session.AgentSessionID,
		AgentSessionID:     started.Session.AgentSessionID,
		RequestID:          "request-1",
		Action:             "submit",
		OptionID:           "option-1",
		Payload: map[string]any{
			"answer": "Use the task renderer",
		},
	})
	if err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if !result.Accepted {
		t.Fatalf("submit result = %#v, want accepted", result)
	}
	if adapter.interactiveInput.RequestID != "request-1" || adapter.interactiveInput.OptionID != "option-1" {
		t.Fatalf("interactive input = %#v", adapter.interactiveInput)
	}
}

func TestControllerSubmitInteractiveSyncsClaudeCodePermissionModeSelection(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		initial  string
		optionID string
		payload  map[string]any
		resolved string
		wantMode string
	}{
		{name: "accept edits", initial: "default", optionID: "acceptEdits", wantMode: "acceptEdits"},
		{name: "bypass permissions", initial: "default", optionID: "bypassPermissions", wantMode: "bypassPermissions"},
		{name: "default", initial: "acceptEdits", optionID: "default", wantMode: "default"},
		{name: "legacy auto", initial: "default", optionID: "auto", wantMode: "acceptEdits"},
		{name: "dont ask from payload", initial: "default", payload: map[string]any{"optionId": "dontAsk"}, resolved: "dontAsk", wantMode: "dontAsk"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			adapter := &statefulInteractiveAdapter{provider: ProviderClaudeCode, interactiveOptionID: tt.resolved}
			controller := NewController([]Adapter{adapter}, nil)
			started, err := controller.Start(context.Background(), StartInput{
				RoomID:           "room-1",
				AgentSessionID:   "agent-session-" + strings.ReplaceAll(tt.name, " ", "-"),
				Provider:         ProviderClaudeCode,
				CWD:              "/workspace",
				Title:            "Claude Code",
				PermissionModeID: tt.initial,
			})
			if err != nil {
				t.Fatalf("Start: %v", err)
			}

			events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
			if !ok {
				t.Fatal("Subscribe returned ok=false")
			}
			defer unsubscribe()
			_ = waitForStreamEventType(t, events, StreamEventStatePatch)

			if _, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
				RoomID:             "room-1",
				RootAgentSessionID: started.Session.AgentSessionID,
				AgentSessionID:     started.Session.AgentSessionID,
				RequestID:          "permission-1",
				OptionID:           tt.optionID,
				Payload:            tt.payload,
			}); err != nil {
				t.Fatalf("SubmitInteractive: %v", err)
			}

			session, ok := controller.Session("room-1", started.Session.AgentSessionID)
			if !ok {
				t.Fatal("Session returned ok=false")
			}
			if session.PermissionModeID != tt.wantMode {
				t.Fatalf("session permission mode = %q, want %q", session.PermissionModeID, tt.wantMode)
			}
			if session.Settings == nil || session.Settings.PermissionModeID != tt.wantMode {
				t.Fatalf("session settings = %#v, want permission mode %q", session.Settings, tt.wantMode)
			}

			event := waitForStatePatchPermissionMode(t, events, tt.wantMode)
			patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
			if !ok {
				t.Fatalf("event data = %#v, want state patch", event.Data)
			}
			if patch.Settings["permissionModeId"] != tt.wantMode {
				t.Fatalf("patch settings = %#v, want permission mode %q", patch.Settings, tt.wantMode)
			}
			if patch.Settings["planMode"] != false {
				t.Fatalf("patch settings planMode = %#v, want false", patch.Settings["planMode"])
			}
			if patch.RuntimeContext != nil {
				t.Fatalf("patch runtime context snapshot = %#v, want nil", patch.RuntimeContext)
			}
			if patch.RuntimeContextPatch == nil || patch.RuntimeContextPatch.Set["permissionModeId"] != tt.wantMode {
				t.Fatalf("patch runtime context update = %#v, want permission mode %q", patch.RuntimeContextPatch, tt.wantMode)
			}
			if patch.RuntimeContextPatch.Set["planMode"] != false {
				t.Fatalf("patch runtime context planMode = %#v, want false", patch.RuntimeContextPatch.Set["planMode"])
			}
			if patch.LifecycleStatus != "" || patch.CurrentPhase != "" {
				t.Fatalf("patch status fields = %q/%q, want empty permission-only patch", patch.LifecycleStatus, patch.CurrentPhase)
			}
		})
	}
}

func TestClaudeCodeModeFromID(t *testing.T) {
	t.Parallel()

	tests := []struct {
		modeID         string
		wantPlan       bool
		wantPermission string
		wantOK         bool
	}{
		{modeID: "plan", wantPlan: true, wantPermission: "", wantOK: true},
		{modeID: "default", wantPlan: false, wantPermission: "default", wantOK: true},
		{modeID: "acceptEdits", wantPlan: false, wantPermission: "acceptEdits", wantOK: true},
		{modeID: "bypassPermissions", wantPlan: false, wantPermission: "bypassPermissions", wantOK: true},
		{modeID: "auto", wantPlan: false, wantPermission: "acceptEdits", wantOK: true},
		{modeID: "dontAsk", wantPlan: false, wantPermission: "dontAsk", wantOK: true},
		{modeID: "allow_once", wantOK: false},
		{modeID: "reject", wantOK: false},
		{modeID: "", wantOK: false},
	}
	for _, tt := range tests {
		plan, permission, ok := claudeCodeModeFromID(tt.modeID)
		if ok != tt.wantOK || plan != tt.wantPlan || permission != tt.wantPermission {
			t.Fatalf("claudeCodeModeFromID(%q) = (%v, %q, %v), want (%v, %q, %v)",
				tt.modeID, plan, permission, ok, tt.wantPlan, tt.wantPermission, tt.wantOK)
		}
	}
}

func TestControllerSubmitInteractiveExitsPlanModeOnPermissionSelection(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{provider: ProviderClaudeCode}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           "room-1",
		AgentSessionID:   "agent-session-exit-plan",
		Provider:         ProviderClaudeCode,
		CWD:              "/workspace",
		Title:            "Claude Code",
		PermissionModeID: "default",
		Settings:         &SessionSettings{PlanMode: true, PermissionModeID: "default"},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()
	_ = waitForStreamEventType(t, events, StreamEventStatePatch)

	if _, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
		RoomID:             "room-1",
		RootAgentSessionID: started.Session.AgentSessionID,
		AgentSessionID:     started.Session.AgentSessionID,
		RequestID:          "permission-1",
		OptionID:           "auto",
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}

	session, ok := controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false")
	}
	if session.PermissionModeID != "acceptEdits" {
		t.Fatalf("session permission mode = %q, want acceptEdits", session.PermissionModeID)
	}
	if session.Settings == nil || session.Settings.PlanMode {
		t.Fatalf("session settings = %#v, want plan mode cleared", session.Settings)
	}

	event := waitForStatePatchPermissionMode(t, events, "acceptEdits")
	patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
	if !ok {
		t.Fatalf("event data = %#v, want state patch", event.Data)
	}
	if patch.Settings["planMode"] != false {
		t.Fatalf("patch settings planMode = %#v, want false", patch.Settings["planMode"])
	}
}

func TestControllerSubmitInteractiveModeSurvivesActiveTurnStaleSession(t *testing.T) {
	t.Parallel()

	adapter := newBlockingExecAdapter()
	adapter.provider = ProviderClaudeCode
	adapter.interactiveOptionID = "bypassPermissions"
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           "room-1",
		AgentSessionID:   "agent-session-exit-plan-stale-turn",
		Provider:         ProviderClaudeCode,
		CWD:              "/workspace",
		Title:            "Claude Code",
		PermissionModeID: "default",
		Settings:         &SessionSettings{PlanMode: true, PermissionModeID: "default"},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        []PromptContentBlock{{Type: "text", Text: "implement"}},
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	adapter.waitForPrompt(t, "implement")

	if _, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
		RoomID:             "room-1",
		RootAgentSessionID: started.Session.AgentSessionID,
		AgentSessionID:     started.Session.AgentSessionID,
		RequestID:          "permission-1",
		OptionID:           "bypassPermissions",
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	session, ok := controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false")
	}
	if session.Settings == nil || session.Settings.PlanMode || session.PermissionModeID != "bypassPermissions" {
		t.Fatalf("session after exit = %#v, want planMode=false and bypassPermissions", session)
	}

	adapter.releaseNext()
	session = waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusReady)
	if session.Settings == nil || session.Settings.PlanMode || session.PermissionModeID != "bypassPermissions" {
		t.Fatalf("session after stale turn completion = %#v, want planMode=false and bypassPermissions", session)
	}
	if got, _ := session.RuntimeContext["planMode"].(bool); got {
		t.Fatalf("runtime context planMode = %#v, want false", session.RuntimeContext["planMode"])
	}
	if got, _ := session.RuntimeContext["permissionModeId"].(string); got != "bypassPermissions" {
		t.Fatalf("runtime context permissionModeId = %#v, want bypassPermissions", session.RuntimeContext["permissionModeId"])
	}
}

func TestControllerSubmitInteractiveKeepPlanningStaysInPlanMode(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{provider: ProviderClaudeCode}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           "room-1",
		AgentSessionID:   "agent-session-keep-planning",
		Provider:         ProviderClaudeCode,
		CWD:              "/workspace",
		Title:            "Claude Code",
		PermissionModeID: "default",
		Settings:         &SessionSettings{PlanMode: true, PermissionModeID: "default"},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()
	_ = waitForStreamEventType(t, events, StreamEventStatePatch)

	if _, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
		RoomID:             "room-1",
		RootAgentSessionID: started.Session.AgentSessionID,
		AgentSessionID:     started.Session.AgentSessionID,
		RequestID:          "permission-1",
		OptionID:           "plan",
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}

	session, ok := controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false")
	}
	if session.Settings == nil || !session.Settings.PlanMode {
		t.Fatalf("session settings = %#v, want plan mode preserved", session.Settings)
	}
	if session.PermissionModeID != "default" {
		t.Fatalf("session permission mode = %q, want unchanged default", session.PermissionModeID)
	}
	// Keeping planning is a no-op for the mode, so no state patch is published.
	expectNoStreamEventType(t, events, StreamEventStatePatch)
}

func TestControllerSubmitInteractiveDoesNotSyncUnsupportedPermissionSelections(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		provider string
		optionID string
		resolved string
	}{
		{name: "ordinary allow", provider: ProviderClaudeCode, optionID: "allow_once"},
		{name: "reject", provider: ProviderClaudeCode, optionID: "reject"},
		{name: "raw permission alias resolves to ordinary allow", provider: ProviderClaudeCode, optionID: "acceptEdits", resolved: "allow_once"},
		{name: "non claude", provider: ProviderCodex, optionID: "acceptEdits"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			adapter := &statefulInteractiveAdapter{provider: tt.provider, interactiveOptionID: tt.resolved}
			controller := NewController([]Adapter{adapter}, nil)
			initialMode := defaultPermissionModeIDForProvider(tt.provider)
			started, err := controller.Start(context.Background(), StartInput{
				RoomID:           "room-1",
				AgentSessionID:   "agent-session-" + strings.ReplaceAll(tt.name, " ", "-"),
				Provider:         tt.provider,
				CWD:              "/workspace",
				Title:            "Agent",
				PermissionModeID: initialMode,
			})
			if err != nil {
				t.Fatalf("Start: %v", err)
			}

			events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
			if !ok {
				t.Fatal("Subscribe returned ok=false")
			}
			defer unsubscribe()
			_ = waitForStreamEventType(t, events, StreamEventStatePatch)

			if _, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
				RoomID:             "room-1",
				RootAgentSessionID: started.Session.AgentSessionID,
				AgentSessionID:     started.Session.AgentSessionID,
				RequestID:          "permission-1",
				OptionID:           tt.optionID,
			}); err != nil {
				t.Fatalf("SubmitInteractive: %v", err)
			}

			session, ok := controller.Session("room-1", started.Session.AgentSessionID)
			if !ok {
				t.Fatal("Session returned ok=false")
			}
			if session.PermissionModeID != initialMode {
				t.Fatalf("session permission mode = %q, want unchanged %q", session.PermissionModeID, initialMode)
			}
			expectNoStreamEventType(t, events, StreamEventStatePatch)
		})
	}
}

func TestControllerKeepsTerminalInteractiveDispositionAfterSessionRemoval(t *testing.T) {
	controller := NewController(nil, nil)
	controller.recordTerminalInteractiveDisposition("session-1", "turn-1", "request-1", InteractiveDispositionAnswered)

	if got := controller.InteractiveDisposition("room-1", "session-1", "session-1", "turn-1", "request-1"); got != InteractiveDispositionAnswered {
		t.Fatalf("disposition without live session = %q, want answered", got)
	}
	if got := controller.InteractiveDisposition("room-1", "session-1", "session-1", "turn-2", "request-1"); got != InteractiveDispositionUnknown {
		t.Fatalf("different-turn disposition = %q, want unknown", got)
	}
}

func TestControllerSubmitInteractivePermissionSyncPreservesCurrentSessionState(t *testing.T) {
	t.Parallel()

	controller := NewController(nil, nil)
	adapter := &statefulInteractiveAdapter{
		provider:            ProviderClaudeCode,
		interactiveOptionID: "acceptEdits",
	}
	adapter.submitHook = func(session Session) {
		current, ok := controller.Session(session.RoomID, session.AgentSessionID)
		if !ok {
			return
		}
		current.Status = SessionStatusCompleted
		current.Title = "Finished title"
		current.ProviderSessionID = "latest-provider-session"
		controller.store(current)
	}
	controller = NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           "room-1",
		AgentSessionID:   "agent-session-1",
		Provider:         ProviderClaudeCode,
		CWD:              "/workspace",
		Title:            "Claude Code",
		PermissionModeID: "default",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	if _, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
		RoomID:             "room-1",
		RootAgentSessionID: started.Session.AgentSessionID,
		AgentSessionID:     started.Session.AgentSessionID,
		RequestID:          "permission-1",
		OptionID:           "acceptEdits",
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}

	session, ok := controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false")
	}
	if session.PermissionModeID != "acceptEdits" {
		t.Fatalf("session permission mode = %q, want acceptEdits", session.PermissionModeID)
	}
	if session.Status != SessionStatusCompleted || session.Title != "Finished title" || session.ProviderSessionID != "latest-provider-session" {
		t.Fatalf("session after sync = %#v, want latest non-permission fields preserved", session)
	}
}

func TestControllerSubmitInteractiveStartsDenyFollowUpAfterActiveTurn(t *testing.T) {
	t.Parallel()

	adapter := newBlockingExecAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           "room-1",
		AgentSessionID:   "agent-session-1",
		Provider:         ProviderCodex,
		CWD:              "/workspace",
		Title:            "Codex",
		PermissionModeID: "auto",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("run tests"),
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	adapter.waitForPrompt(t, "run tests")

	result, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
		RoomID:             "room-1",
		RootAgentSessionID: started.Session.AgentSessionID,
		AgentSessionID:     started.Session.AgentSessionID,
		RequestID:          "permission-1",
		Action:             "deny",
		OptionID:           "abort",
		Payload: map[string]any{
			"denyMessage": "Please split the work into smaller steps.",
		},
	})
	if err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if !result.Accepted {
		t.Fatalf("submit result = %#v, want accepted", result)
	}

	if result.FollowUpPrompt != "Please split the work into smaller steps." {
		t.Fatalf("follow-up prompt = %q, want Host-owned follow-up intent", result.FollowUpPrompt)
	}
	adapter.releaseNext()
	waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusReady)
	if got := adapter.prompts(); len(got) != 1 || got[0] != "run tests" {
		t.Fatalf("adapter prompts = %#v, want only the original prompt", got)
	}
}

func TestInteractiveDenyFollowUpSkipsClaudeSDKAdapter(t *testing.T) {
	t.Parallel()

	if adapterShouldReceiveInteractiveDenyFollowUp(NewClaudeCodeSDKAdapter(nil)) {
		t.Fatal("Claude SDK adapter should consume deny feedback without daemon follow-up")
	}
	if adapterShouldReceiveInteractiveDenyFollowUp(NewCodexAppServerAdapter(nil)) {
		t.Fatal("Codex app-server adapter should steer deny feedback without daemon follow-up")
	}
	if !adapterShouldReceiveInteractiveDenyFollowUp(newBlockingExecAdapter()) {
		t.Fatal("ACP-style adapter should keep daemon deny follow-up")
	}
}
