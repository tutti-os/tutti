package agentruntime

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestGoalRecoveryCapabilitiesComeFromAdapterPolicy(t *testing.T) {
	codex := (&CodexAppServerAdapter{}).GoalCapabilities()
	if !codex.QuerySupported || !codex.ReplaySetAfterRestart {
		t.Fatalf("codex capabilities=%#v", codex)
	}
	claude := (&ClaudeCodeSDKAdapter{}).GoalCapabilities()
	if claude.QuerySupported || claude.ReplaySetAfterRestart {
		t.Fatalf("claude capabilities=%#v", claude)
	}

	// A provider name is not a capability. Even an adapter registered under
	// the codex string is rejected if it does not implement GoalAdapter.
	adapter := &recordingStartAdapter{provider: ProviderCodex}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{RoomID: "room-policy", Provider: ProviderCodex})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := controller.GoalCapabilities(context.Background(), GoalReconcileInput{RoomID: "room-policy", AgentSessionID: started.Session.AgentSessionID}); err == nil {
		t.Fatal("provider-name-only adapter unexpectedly acquired goal recovery capabilities")
	}
}

func TestBackgroundGoalControlsRequireExistingLiveProvider(t *testing.T) {
	adapter := &requireLiveGoalAdapter{recordingStartAdapter: recordingStartAdapter{provider: "require-live-goal"}}
	controller := NewController([]Adapter{adapter}, nil)
	session, err := controller.Resume(context.Background(), ResumeInput{
		RoomID: "room-require-live", AgentSessionID: "session-require-live", Provider: adapter.Provider(),
		ProviderSessionID: "provider-session-require-live",
	})
	if err != nil {
		t.Fatal(err)
	}
	adapter.live = false
	adapter.resumeCalls = 0
	adapter.calls = nil

	if _, err := controller.GoalControl(context.Background(), GoalControlInput{
		RoomID: session.RoomID, AgentSessionID: session.AgentSessionID,
		Action: GoalControlClear, RequireLive: true,
	}); !errors.Is(err, ErrSessionDisconnected) {
		t.Fatalf("RequireLive GoalControl error=%v", err)
	}
	if err := controller.FenceGoalGeneration(context.Background(), GoalGenerationFenceRequest{
		RoomID: session.RoomID, AgentSessionID: session.AgentSessionID,
		OperationID: "goal-op", Revision: 1, RequireLive: true,
	}); !errors.Is(err, ErrSessionDisconnected) {
		t.Fatalf("RequireLive FenceGoalGeneration error=%v", err)
	}
	if adapter.resumeCalls != 0 || adapter.goalCalls != 0 || adapter.fenceCalls != 0 {
		t.Fatalf("background controls resumed or reached provider: resume=%d goal=%d fence=%d",
			adapter.resumeCalls, adapter.goalCalls, adapter.fenceCalls)
	}

	if _, err := controller.GoalControl(context.Background(), GoalControlInput{
		RoomID: session.RoomID, AgentSessionID: session.AgentSessionID,
		Action: GoalControlClear,
	}); err != nil {
		t.Fatal(err)
	}
	if adapter.resumeCalls != 1 || adapter.goalCalls != 1 || adapter.fenceCalls != 1 {
		t.Fatalf("user control resume=%d goal=%d fence=%d", adapter.resumeCalls, adapter.goalCalls, adapter.fenceCalls)
	}
	if got, want := strings.Join(adapter.calls, ","), "resume,fence,goal"; got != want {
		t.Fatalf("reconnect call order=%q want=%q", got, want)
	}

	// Releasing or losing the provider connection discards adapter-local
	// fences. The Controller registry must reinstall them on the replacement
	// connection before any user operation reaches the provider.
	adapter.live = false
	adapter.calls = nil
	if _, err := controller.GoalControl(context.Background(), GoalControlInput{
		RoomID: session.RoomID, AgentSessionID: session.AgentSessionID,
		Action: GoalControlClear,
	}); err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(adapter.calls, ","), "resume,fence,goal"; got != want {
		t.Fatalf("replacement connection call order=%q want=%q", got, want)
	}

	adapter.live = false
	adapter.calls = nil
	adapter.fenceErr = errors.New("fence install failed")
	if _, err := controller.GoalControl(context.Background(), GoalControlInput{
		RoomID: session.RoomID, AgentSessionID: session.AgentSessionID,
		Action: GoalControlClear,
	}); err == nil {
		t.Fatal("replacement connection unexpectedly survived fence installation failure")
	}
	if got, want := strings.Join(adapter.calls, ","), "resume,fence,close"; got != want {
		t.Fatalf("failed replacement call order=%q want=%q", got, want)
	}
	if adapter.live {
		t.Fatal("failed replacement remained live without its admission fences")
	}
}

func TestResumeInstallsPreloadedGoalFencesBeforePublishingSession(t *testing.T) {
	adapter := &requireLiveGoalAdapter{recordingStartAdapter: recordingStartAdapter{provider: "resume-goal-fences"}}
	controller := NewController([]Adapter{adapter}, nil)
	adapter.onFence = func(session Session) {
		if published, found := controller.Session(session.RoomID, session.AgentSessionID); found {
			t.Fatalf("session published before durable fences were installed: %#v", published)
		}
	}
	inputFence := GoalGenerationFenceInput{
		OperationID: "old-goal", Revision: 4, RepairEpoch: 2, Reason: "binding_revoked",
	}
	session, err := controller.Resume(context.Background(), ResumeInput{
		RoomID: "room-resume-fences", AgentSessionID: "session-resume-fences", Provider: adapter.Provider(),
		ProviderSessionID:    "provider-session-resume-fences",
		GoalGenerationFences: []GoalGenerationFenceInput{inputFence},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(adapter.calls, ","), "resume,fence"; got != want {
		t.Fatalf("resume fence order=%q want=%q", got, want)
	}
	if adapter.lastFence != inputFence {
		t.Fatalf("installed fence=%#v want=%#v", adapter.lastFence, inputFence)
	}
	if published, found := controller.Session(session.RoomID, session.AgentSessionID); !found || published.AgentSessionID != session.AgentSessionID {
		t.Fatalf("resumed session was not published after fence installation: %#v found=%v", published, found)
	}
}

type requireLiveGoalAdapter struct {
	recordingStartAdapter
	live        bool
	resumeCalls int
	goalCalls   int
	fenceCalls  int
	closeCalls  int
	calls       []string
	fenceErr    error
	lastFence   GoalGenerationFenceInput
	onFence     func(Session)
}

func (a *requireLiveGoalAdapter) Start(ctx context.Context, session Session) ([]activityshared.Event, error) {
	events, err := a.recordingStartAdapter.Start(ctx, session)
	if err == nil {
		a.live = true
	}
	return events, err
}

func (a *requireLiveGoalAdapter) Resume(context.Context, Session) error {
	a.resumeCalls++
	a.live = true
	a.calls = append(a.calls, "resume")
	return nil
}

func (a *requireLiveGoalAdapter) HasLiveSession(Session) bool {
	return a.live
}

func (*requireLiveGoalAdapter) GoalCapabilities() GoalAdapterCapabilities {
	return GoalAdapterCapabilities{}
}

func (a *requireLiveGoalAdapter) ApplyGoal(_ context.Context, _ Session, input GoalApplyInput) (GoalAdapterResult, error) {
	a.goalCalls++
	a.calls = append(a.calls, "goal")
	return GoalAdapterResult{Observation: map[string]any{"action": string(input.Action)}}, nil
}

func (*requireLiveGoalAdapter) ReconcileGoal(context.Context, Session) (GoalAdapterResult, error) {
	return GoalAdapterResult{}, nil
}

func (*requireLiveGoalAdapter) NormalizeGoalObservation(raw map[string]any) map[string]any {
	return clonePayload(raw)
}

func (*requireLiveGoalAdapter) ExecGoalControl(context.Context, Session, []PromptContentBlock, string) ([]activityshared.Event, bool, error) {
	return nil, false, nil
}

func (a *requireLiveGoalAdapter) FenceGoalGeneration(_ context.Context, session Session, input GoalGenerationFenceInput) error {
	a.fenceCalls++
	a.calls = append(a.calls, "fence")
	a.lastFence = input
	if a.onFence != nil {
		a.onFence(session)
	}
	return a.fenceErr
}

func (a *requireLiveGoalAdapter) Close(context.Context, Session) error {
	a.closeCalls++
	a.live = false
	a.calls = append(a.calls, "close")
	return nil
}

func TestGoalCapabilitiesWaitObservesContextCancellation(t *testing.T) {
	controller := NewController(nil, nil)
	release := controller.acquireLifecycleLock("room-1", "session-1")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := controller.GoalCapabilities(ctx, GoalReconcileInput{RoomID: "room-1", AgentSessionID: "session-1"})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("GoalCapabilities error = %v", err)
	}
	release()
	controller.mu.Lock()
	remaining := len(controller.lifecycleLocks)
	controller.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("lifecycle lock references leaked: %d", remaining)
	}
}

func TestGoalControlWaitObservesContextCancellation(t *testing.T) {
	controller := NewController(nil, nil)
	release := controller.acquireLifecycleLock("room-1", "session-1")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := controller.GoalControl(ctx, GoalControlInput{RoomID: "room-1", AgentSessionID: "session-1"})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("GoalControl error = %v", err)
	}
	release()
	controller.mu.Lock()
	remaining := len(controller.lifecycleLocks)
	controller.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("lifecycle lock references leaked: %d", remaining)
	}
}
