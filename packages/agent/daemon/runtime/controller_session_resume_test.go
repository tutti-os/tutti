package agentruntime

import (
	"context"
	"errors"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type unavailableResumeAdapterResolver struct{}

func (unavailableResumeAdapterResolver) ResolveAdapter(context.Context, AdapterResolveInput) (Adapter, error) {
	return nil, errors.New("adapter resolution must not run during resume eligibility checks")
}

func TestControllerCanResumeAuthorizedAgentExtensionBinding(t *testing.T) {
	controller := NewControllerWithAdapterResolver(nil, nil, unavailableResumeAdapterResolver{})
	valid := ResumeInput{
		RoomID:            "workspace-1",
		AgentSessionID:    "session-1",
		AgentTargetID:     "workspace-agent:writer",
		Provider:          "acp:codebuddy",
		ProviderSessionID: "provider-session-1",
		ProviderTargetRef: map[string]any{
			"kind":                    "agent_extension",
			"provider":                "acp:codebuddy",
			"targetId":                "extension:codebuddy",
			"extensionInstallationId": "codebuddy@1.0.0",
		},
	}

	tests := []struct {
		name   string
		mutate func(*ResumeInput)
		want   bool
	}{
		{name: "authorized after controller restart", want: true},
		{name: "missing target ref", mutate: func(input *ResumeInput) { input.ProviderTargetRef = nil }},
		{name: "missing provider session", mutate: func(input *ResumeInput) { input.ProviderSessionID = "" }},
		{name: "provider mismatch", mutate: func(input *ResumeInput) { input.ProviderTargetRef["provider"] = "acp:other" }},
		{name: "missing Harness target", mutate: func(input *ResumeInput) { input.ProviderTargetRef["targetId"] = "" }},
		{name: "missing installation", mutate: func(input *ResumeInput) { delete(input.ProviderTargetRef, "extensionInstallationId") }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			input := valid
			input.ProviderTargetRef = clonePayload(valid.ProviderTargetRef)
			if tt.mutate != nil {
				tt.mutate(&input)
			}
			if got := controller.CanResume(input); got != tt.want {
				t.Fatalf("CanResume() = %t, want %t", got, tt.want)
			}
		})
	}
}

func TestControllerCanResumeChecksCachedAgentExtensionBinding(t *testing.T) {
	adapter, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:          "acp:codebuddy",
		Name:              "codebuddy-acp",
		Command:           []string{"codebuddy", "--acp"},
		ProviderTargetID:  "extension:codebuddy",
		InstallationID:    "codebuddy@1.0.0",
		AdapterResolveCWD: "/workspace",
	}, nil, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	controller := NewControllerWithAdapterResolver(
		[]Adapter{adapter},
		nil,
		unavailableResumeAdapterResolver{},
	)
	input := ResumeInput{
		RoomID:            "workspace-1",
		AgentSessionID:    "session-1",
		AgentTargetID:     "workspace-agent:writer",
		Provider:          "acp:codebuddy",
		ProviderSessionID: "provider-session-1",
		CWD:               "/workspace",
		ProviderTargetRef: map[string]any{
			"kind":                    "agent_extension",
			"provider":                "acp:codebuddy",
			"targetId":                "extension:codebuddy",
			"extensionInstallationId": "codebuddy@1.0.0",
		},
	}

	if !controller.CanResume(input) {
		t.Fatal("CanResume() = false, want true for exact cached binding")
	}
	input.ProviderTargetRef["targetId"] = "extension:other"
	if controller.CanResume(input) {
		t.Fatal("CanResume() = true, want false for cached binding mismatch")
	}
}

func TestControllerExecResumesExistingSessionWhenAdapterLiveSessionMissing(t *testing.T) {
	t.Parallel()

	adapter := newReconnectableAdapter()
	controller := NewController([]Adapter{adapter}, nil)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderClaudeCode,
		CWD:            "/workspace",
		Title:          "Claude Code",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if started.Session.ProviderSessionID != "provider-session-1" {
		t.Fatalf("provider session id = %q, want provider-session-1", started.Session.ProviderSessionID)
	}

	adapter.dropLiveSession("agent-session-1")
	result, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Content:        textPrompt("hello"),
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if !result.Accepted {
		t.Fatalf("Exec result = %#v, want accepted", result)
	}
	if adapter.resumeCalls != 1 {
		t.Fatalf("resume calls = %d, want 1", adapter.resumeCalls)
	}
}

func TestControllerResumeReattachesExistingProviderSession(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	reporter := &recordingReporter{}
	controller := NewDefaultControllerWithProcessTransport(reporter, transport)

	session, err := controller.Resume(context.Background(), ResumeInput{
		RoomID:            "room-1",
		AgentSessionID:    "agent-session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "codex-acp-session-restored",
		CWD:               "/workspace",
		Env:               []string{"CODEX_HOME=/prepared/codex-home"},
		Title:             "Restored",
		Status:            SessionStatusReady,
		CreatedAtUnixMS:   100,
		UpdatedAtUnixMS:   200,
	})
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if session.AgentSessionID != "agent-session-1" || session.ProviderSessionID != "codex-acp-session-restored" {
		t.Fatalf("session = %#v, want restored ids", session)
	}
	if session.UpdatedAtUnixMS != 200 {
		t.Fatalf("UpdatedAtUnixMS = %d, want preserved value 200", session.UpdatedAtUnixMS)
	}
	if len(session.Env) != 1 || session.Env[0] != "CODEX_HOME=/prepared/codex-home" {
		t.Fatalf("session env = %#v, want resume env", session.Env)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	if !containsString(transport.specs[0].Env, "CODEX_HOME=/prepared/codex-home") {
		t.Fatalf("process env = %#v, want resume env", transport.specs[0].Env)
	}
	if calls := reporter.snapshot(); len(calls) != 0 {
		t.Fatalf("resume report calls = %#v, want none for attach-only resume", calls)
	}
	_, unsubscribe, ok := controller.Subscribe("room-1", "agent-session-1")
	if !ok {
		t.Fatal("Subscribe after Resume returned ok=false")
	}
	defer unsubscribe()

	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Content:        textPrompt("continue"),
	})
	if err != nil {
		t.Fatalf("Exec after Resume: %v", err)
	}
	if !execResult.Accepted {
		t.Fatalf("Exec result = %#v, want accepted", execResult)
	}
}

func TestControllerResumeRecreatesMissingProviderSessionWhenOptedIn(t *testing.T) {
	t.Parallel()

	restoreErr := &AppError{Code: AppErrorProviderSessionNotFound, Message: "gone"}

	t.Run("without opt-in the restore error surfaces unchanged", func(t *testing.T) {
		t.Parallel()
		adapter := newRecreatableResumeAdapter(restoreErr)
		controller := NewController([]Adapter{adapter}, nil)
		_, err := controller.Resume(context.Background(), ResumeInput{
			RoomID:            "room-1",
			AgentSessionID:    "imported-1",
			Provider:          ProviderClaudeCode,
			ProviderSessionID: "stale-provider-session",
			CWD:               "/workspace",
			Title:             "Imported",
		})
		if AppErrorCode(err) != AppErrorProviderSessionNotFound {
			t.Fatalf("err = %v, want provider session not found", err)
		}
		if adapter.startCalls != 0 {
			t.Fatalf("start calls = %d, want 0 (no recreate)", adapter.startCalls)
		}
	})

	t.Run("with opt-in a fresh provider session is created in place", func(t *testing.T) {
		t.Parallel()
		adapter := newRecreatableResumeAdapter(restoreErr)
		reporter := &recordingReporter{}
		controller := NewController([]Adapter{adapter}, reporter)
		session, err := controller.Resume(context.Background(), ResumeInput{
			RoomID:            "room-1",
			AgentSessionID:    "imported-1",
			Provider:          ProviderClaudeCode,
			ProviderSessionID: "stale-provider-session",
			CWD:               "/workspace",
			Title:             "Imported",
			RecreateIfMissing: true,
		})
		if err != nil {
			t.Fatalf("Resume: %v", err)
		}
		if adapter.startCalls != 1 {
			t.Fatalf("start calls = %d, want 1 (recreate)", adapter.startCalls)
		}
		if session.AgentSessionID != "imported-1" {
			t.Fatalf("agent session id = %q, want imported-1", session.AgentSessionID)
		}
		if session.ProviderSessionID != "fresh-provider-session" {
			t.Fatalf("provider session id = %q, want fresh-provider-session", session.ProviderSessionID)
		}
		// A silently recreated provider session has no memory of anything the
		// user said before this point, even though the transcript still shows
		// the old (imported) messages seamlessly joined with new ones. Without
		// a visible notice this looks exactly like the agent forgot the
		// conversation, so recreation must surface a system notice message.
		reports := reporter.waitForCalls(t, 1)
		var notice *agentsessionstore.WorkspaceAgentMessageUpdate
		for _, call := range reports {
			for i, update := range call.report.MessageUpdates {
				if update.AgentSessionID != "imported-1" {
					continue
				}
				if asString(update.Payload["kind"]) == "agent_system_notice" {
					notice = &call.report.MessageUpdates[i]
				}
			}
		}
		if notice == nil {
			t.Fatalf("no agent_system_notice message reported for recreated session; reports = %#v", reports)
		}
		if title := asString(notice.Payload["title"]); title == "" {
			t.Fatalf("recreated-session notice has empty title: %#v", notice.Payload)
		}
		// The recreated session must be live so a turn can run on it.
		result, err := controller.Exec(context.Background(), ExecInput{
			RoomID:         "room-1",
			AgentSessionID: "imported-1",
			Content:        textPrompt("continue"),
		})
		if err != nil {
			t.Fatalf("Exec after recreate: %v", err)
		}
		if !result.Accepted {
			t.Fatalf("Exec result = %#v, want accepted", result)
		}
	})
}

type reconnectableAdapter struct {
	live        map[string]bool
	resumeCalls int
}

func newReconnectableAdapter() *reconnectableAdapter {
	return &reconnectableAdapter{live: make(map[string]bool)}
}

func (*reconnectableAdapter) Provider() string { return ProviderClaudeCode }

func (a *reconnectableAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	session.ProviderSessionID = "provider-session-1"
	a.live[session.AgentSessionID] = true
	return []activityshared.Event{
		newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil),
	}, nil
}

func (a *reconnectableAdapter) Resume(_ context.Context, session Session) error {
	a.resumeCalls++
	a.live[session.AgentSessionID] = true
	return nil
}

func (*reconnectableAdapter) Close(context.Context, Session) error {
	return nil
}

func (a *reconnectableAdapter) Exec(_ context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, _ EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	if !a.live[session.AgentSessionID] {
		return nil, ErrSessionDisconnected
	}
	return []activityshared.Event{
		newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", nil),
	}, nil
}

func (*reconnectableAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *reconnectableAdapter) HasLiveSession(session Session) bool {
	return a.live[session.AgentSessionID]
}

func (a *reconnectableAdapter) dropLiveSession(agentSessionID string) {
	a.live[agentSessionID] = false
}

// recreatableResumeAdapter fails Resume with a configurable restore error and
// mints a fresh provider session on Start, modelling an imported conversation
// whose provider session cannot be restored locally.
type recreatableResumeAdapter struct {
	resumeErr   error
	resumeCalls int
	startCalls  int
	live        map[string]bool
}

func newRecreatableResumeAdapter(resumeErr error) *recreatableResumeAdapter {
	return &recreatableResumeAdapter{resumeErr: resumeErr, live: make(map[string]bool)}
}

func (*recreatableResumeAdapter) Provider() string { return ProviderClaudeCode }

func (a *recreatableResumeAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	a.startCalls++
	session.ProviderSessionID = "fresh-provider-session"
	a.live[session.AgentSessionID] = true
	return []activityshared.Event{
		newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil),
	}, nil
}

func (a *recreatableResumeAdapter) Resume(_ context.Context, session Session) error {
	a.resumeCalls++
	if a.resumeErr != nil {
		return a.resumeErr
	}
	a.live[session.AgentSessionID] = true
	return nil
}

func (*recreatableResumeAdapter) Close(context.Context, Session) error { return nil }

func (a *recreatableResumeAdapter) Exec(_ context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, _ EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	if !a.live[session.AgentSessionID] {
		return nil, ErrSessionDisconnected
	}
	return []activityshared.Event{
		newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", nil),
	}, nil
}

func (*recreatableResumeAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *recreatableResumeAdapter) HasLiveSession(session Session) bool {
	return a.live[session.AgentSessionID]
}
