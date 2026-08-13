package agentruntime

import (
	"context"
	"errors"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type reprepareTestAdapter struct {
	provider     string
	live         bool
	resumeInputs []Session
	launchInputs []ProviderLaunchPrepareInput
	releaseCalls int
}

func (a *reprepareTestAdapter) Provider() string { return a.provider }

func (*reprepareTestAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, errors.New("unexpected Start")
}

func (a *reprepareTestAdapter) Resume(ctx context.Context, session Session) error {
	a.resumeInputs = append(a.resumeInputs, session)
	_, _, err := prepareProviderLaunch(ctx, func(_ context.Context, input ProviderLaunchPrepareInput) (ProviderLaunchPrepareResult, error) {
		a.launchInputs = append(a.launchInputs, input)
		return ProviderLaunchPrepareResult{}, nil
	}, session, ProcessSpec{})
	if err != nil {
		return err
	}
	a.live = true
	return nil
}

func (*reprepareTestAdapter) Close(context.Context, Session) error { return nil }

func (*reprepareTestAdapter) Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error) {
	return nil, nil
}

func (*reprepareTestAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *reprepareTestAdapter) HasLiveSession(Session) bool { return a.live }

func (a *reprepareTestAdapter) ReleaseLiveSession(context.Context, Session) error {
	a.releaseCalls++
	a.live = false
	return nil
}

func TestControllerRepreparePreservesSessionIdentityAcrossProviders(t *testing.T) {
	for _, provider := range []string{ProviderCodex, ProviderClaudeCode, ProviderOpenCode} {
		t.Run(provider, func(t *testing.T) {
			adapter := &reprepareTestAdapter{provider: provider}
			controller := NewController([]Adapter{adapter}, nil)
			base := ResumeInput{
				RoomID: "workspace-1", AgentSessionID: "session-1", AgentTargetID: "target-1",
				Provider: provider, ProviderSessionID: "provider-session-1", CWD: "/workspace",
				MCPServers:     []MCPServerBinding{{Name: "connectors", Type: "http", URL: "http://127.0.0.1/old"}},
				RuntimeContext: map[string]any{"canonical": true},
			}
			if _, err := controller.Resume(t.Context(), base); err != nil {
				t.Fatalf("Resume() error = %v", err)
			}
			replacement := base
			replacement.MCPServers = []MCPServerBinding{{Name: "connectors", Type: "http", URL: "http://127.0.0.1/new", Headers: map[string]string{"Authorization": "Bearer invocation"}}}
			replacement.ProviderLaunchRuntimeContext = map[string]any{"canonical": true, "invocationId": "invocation-2"}
			result, err := controller.Reprepare(t.Context(), replacement)
			if err != nil {
				t.Fatalf("Reprepare() error = %v", err)
			}
			if result.AgentSessionID != "session-1" || result.ProviderSessionID != "provider-session-1" || result.Provider != provider {
				t.Fatalf("reprepared identity = %#v", result)
			}
			if adapter.releaseCalls != 1 || len(adapter.resumeInputs) != 2 {
				t.Fatalf("release calls=%d resume inputs=%d, want 1/2", adapter.releaseCalls, len(adapter.resumeInputs))
			}
			if got := adapter.resumeInputs[1].MCPServers; len(got) != 1 || got[0].URL != "http://127.0.0.1/new" || got[0].Headers["Authorization"] != "Bearer invocation" {
				t.Fatalf("replacement MCP binding = %#v", got)
			}
			if len(adapter.launchInputs) != 2 || adapter.launchInputs[1].Session.RuntimeContext["invocationId"] != "invocation-2" {
				t.Fatalf("provider launch input = %#v", adapter.launchInputs)
			}
			if adapter.resumeInputs[1].RuntimeContext["invocationId"] != nil {
				t.Fatalf("adapter retained ephemeral launch context: %#v", adapter.resumeInputs[1].RuntimeContext)
			}
			stored, ok := controller.Session("workspace-1", "session-1")
			if !ok || stored.ProviderSessionID != "provider-session-1" || stored.MCPServers[0].URL != "http://127.0.0.1/new" || stored.RuntimeContext["invocationId"] != nil {
				t.Fatalf("stored replacement = %#v found=%t", stored, ok)
			}
		})
	}
}

func TestControllerReprepareRejectsActiveTurnBeforeRelease(t *testing.T) {
	adapter := &reprepareTestAdapter{provider: ProviderCodex}
	controller := NewController([]Adapter{adapter}, nil)
	input := ResumeInput{
		RoomID: "workspace-1", AgentSessionID: "session-1", Provider: ProviderCodex,
		ProviderSessionID: "provider-session-1", CWD: "/workspace",
	}
	if _, err := controller.Resume(t.Context(), input); err != nil {
		t.Fatal(err)
	}
	controller.mu.Lock()
	controller.turns[sessionKey("workspace-1", "session-1")] = activeTurn{turnID: "turn-1"}
	controller.mu.Unlock()

	_, err := controller.Reprepare(t.Context(), input)
	if !errors.Is(err, ErrSessionActiveTurn) {
		t.Fatalf("Reprepare() error = %v, want ErrSessionActiveTurn", err)
	}
	if adapter.releaseCalls != 0 || len(adapter.resumeInputs) != 1 {
		t.Fatalf("active reprepare release=%d resume=%d", adapter.releaseCalls, len(adapter.resumeInputs))
	}
}
