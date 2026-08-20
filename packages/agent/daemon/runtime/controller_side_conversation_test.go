package agentruntime

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type sideConformanceAdapter struct {
	mu            sync.Mutex
	live          map[string]bool
	parentEntered chan struct{}
	parentRelease chan struct{}
	resumeCalls   int
	sessionSink   SessionEventSink
	openErr       error
	capabilities  *SideConversationCapabilities
	openCaps      *SideConversationCapabilities
	openSession   *Session
	openEntered   chan struct{}
	openRelease   chan struct{}
	closedIDs     []string
}

func newSideConformanceAdapter() *sideConformanceAdapter {
	return &sideConformanceAdapter{
		live:          make(map[string]bool),
		parentEntered: make(chan struct{}),
		parentRelease: make(chan struct{}),
	}
}

func (*sideConformanceAdapter) Provider() string { return "side-conformance" }

func (a *sideConformanceAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	a.mu.Lock()
	a.live[session.AgentSessionID] = true
	a.mu.Unlock()
	return []activityshared.Event{
		newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil),
	}, nil
}

func (a *sideConformanceAdapter) Resume(_ context.Context, session Session) error {
	a.mu.Lock()
	a.resumeCalls++
	a.live[session.AgentSessionID] = true
	a.mu.Unlock()
	return nil
}

func (a *sideConformanceAdapter) Close(_ context.Context, session Session) error {
	a.mu.Lock()
	a.live[session.AgentSessionID] = false
	a.closedIDs = append(a.closedIDs, session.AgentSessionID)
	a.mu.Unlock()
	return nil
}

func (a *sideConformanceAdapter) Exec(
	ctx context.Context,
	session Session,
	_ []PromptContentBlock,
	_ string,
	turnID string,
	emit EventSink,
	_ CommandSnapshotSink,
) ([]activityshared.Event, error) {
	if !session.IsSideConversation() {
		close(a.parentEntered)
		select {
		case <-a.parentRelease:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	events := []activityshared.Event{
		newTurnActivityEvent(
			session, EventTurnCompleted, turnID, SessionStatusReady, "", "", nil,
		),
	}
	if emit != nil {
		emit(events)
	}
	return events, nil
}

func (*sideConformanceAdapter) Cancel(
	_ context.Context,
	session Session,
	turnID string,
) ([]activityshared.Event, error) {
	return []activityshared.Event{
		newTurnActivityEvent(
			session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", nil,
		),
	}, nil
}

func (a *sideConformanceAdapter) HasLiveSession(session Session) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.live[session.AgentSessionID]
}

func (a *sideConformanceAdapter) SideCapabilities(
	context.Context,
	Session,
) (SideConversationCapabilities, error) {
	if a.capabilities != nil {
		return *a.capabilities, nil
	}
	return SideConversationCapabilities{
		Supported:             true,
		ActiveSourceTurn:      true,
		Ephemeral:             true,
		HideInheritedTurns:    true,
		ModelBoundaryInjected: true,
	}, nil
}

func (a *sideConformanceAdapter) OpenSide(
	ctx context.Context,
	input SideConversationAdapterOpenInput,
) (SideConversationOpenResult, error) {
	if a.openEntered != nil {
		close(a.openEntered)
		select {
		case <-a.openRelease:
		case <-ctx.Done():
			return SideConversationOpenResult{}, ctx.Err()
		}
	}
	side := input.Side
	if a.sessionSink != nil {
		a.sessionSink(side.AgentSessionID, []activityshared.Event{
			newSessionActivityEvent(
				side, EventSessionUpdated, SessionStatusReady,
				map[string]any{"opening": true},
			),
		})
	}
	if a.openErr != nil {
		return SideConversationOpenResult{}, a.openErr
	}
	side.ProviderSessionID = "provider-side"
	a.mu.Lock()
	a.live[side.AgentSessionID] = true
	a.mu.Unlock()
	if a.openSession != nil {
		side = *a.openSession
	}
	openCapabilities, _ := a.SideCapabilities(context.Background(), input.Source)
	if a.openCaps != nil {
		openCapabilities = *a.openCaps
	}
	return SideConversationOpenResult{
		Session:      side,
		Capabilities: openCapabilities,
	}, nil
}

func TestSideConversationOpenSerializesSourceClose(t *testing.T) {
	adapter := newSideConformanceAdapter()
	adapter.openEntered = make(chan struct{})
	adapter.openRelease = make(chan struct{})
	controller := NewController([]Adapter{adapter}, nil)
	if _, err := controller.Start(t.Context(), StartInput{
		RoomID: "workspace-side-lock", AgentSessionID: "parent",
		Provider: adapter.Provider(),
	}); err != nil {
		t.Fatal(err)
	}

	openDone := make(chan error, 1)
	go func() {
		_, err := controller.OpenSide(t.Context(), SideConversationOpenInput{
			RoomID: "workspace-side-lock", SourceAgentSessionID: "parent",
			SideAgentSessionID: "side-lock", RequestID: "open-lock",
		})
		openDone <- err
	}()
	select {
	case <-adapter.openEntered:
	case <-time.After(time.Second):
		t.Fatal("Side open did not reach provider")
	}

	closeDone := make(chan error, 1)
	go func() {
		_, err := controller.Close(t.Context(), CloseInput{
			RoomID: "workspace-side-lock", AgentSessionID: "parent",
		})
		closeDone <- err
	}()
	lockDeadline := time.Now().Add(time.Second)
	for {
		controller.mu.Lock()
		sourceLock := controller.lifecycleLocks[sessionKey(
			"workspace-side-lock",
			"parent",
		)]
		sourceLockRefs := 0
		if sourceLock != nil {
			sourceLockRefs = sourceLock.refs
		}
		controller.mu.Unlock()
		if sourceLockRefs >= 2 {
			break
		}
		if time.Now().After(lockDeadline) {
			t.Fatal("source close did not contend on the Side snapshot lock")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case err := <-closeDone:
		t.Fatalf("source close overtook Side snapshot: %v", err)
	default:
	}

	close(adapter.openRelease)
	if err := <-openDone; err != nil {
		t.Fatal(err)
	}
	if err := <-closeDone; err != nil {
		t.Fatal(err)
	}
}

func (a *sideConformanceAdapter) SetSessionEventSink(sink SessionEventSink) {
	a.sessionSink = sink
}

type sessionRecordingObserver struct {
	mu       sync.Mutex
	sessions []string
}

func (o *sessionRecordingObserver) ObserveRuntimeStreamEvents(
	_ context.Context,
	_ string,
	sessionID string,
	_ []StreamEvent,
) error {
	o.mu.Lock()
	o.sessions = append(o.sessions, sessionID)
	o.mu.Unlock()
	return nil
}

func (*sessionRecordingObserver) ForgetSideConversation(string, string) {}

func (o *sessionRecordingObserver) contains(sessionID string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	for _, candidate := range o.sessions {
		if candidate == sessionID {
			return true
		}
	}
	return false
}

func TestSideConversationOpensDuringActiveParentWithoutDurableWrites(t *testing.T) {
	adapter := newSideConformanceAdapter()
	reporter := &recordingReporter{}
	controller := NewController([]Adapter{adapter}, reporter)
	canonicalObserver := &sessionRecordingObserver{}
	sideObserver := &sessionRecordingObserver{}
	controller.SetStreamEventObserver(canonicalObserver)
	controller.SetSideStreamEventObserver(sideObserver)

	started, err := controller.Start(t.Context(), StartInput{
		RoomID: "workspace-side", AgentSessionID: "parent", Provider: adapter.Provider(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := controller.Exec(t.Context(), ExecInput{
		RoomID: "workspace-side", AgentSessionID: "parent", TurnID: "parent-turn",
		Content: []PromptContentBlock{{Type: "text", Text: "keep working"}},
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-adapter.parentEntered:
	case <-time.After(time.Second):
		t.Fatal("parent turn did not become active")
	}
	before := reporter.waitForCalls(t, 2)

	opened, err := controller.OpenSide(t.Context(), SideConversationOpenInput{
		RoomID: "workspace-side", SourceAgentSessionID: "parent",
		SideAgentSessionID: "side-1", RequestID: "open-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !opened.Session.IsSideConversation() ||
		opened.Session.SourceAgentSessionID != started.Session.AgentSessionID ||
		opened.Session.ProviderSessionID != "provider-side" ||
		opened.Session.Resumable {
		t.Fatalf("opened side = %#v", opened.Session)
	}
	if !controller.HasActiveTurn("workspace-side", "parent") {
		t.Fatal("opening Side disturbed the active parent turn")
	}
	if err := controller.DurablyReportSubmitProvenance(
		t.Context(),
		SubmitProvenanceInput{
			RoomID: "workspace-side", AgentSessionID: "side-1",
			TurnID: "side-turn", ClientSubmitID: "side-submit",
			Content: []PromptContentBlock{{Type: "text", Text: "side question"}},
		},
	); !errors.Is(err, ErrSideConversationUnsupported) {
		t.Fatalf("Side submit provenance error = %v, want unsupported", err)
	}
	if err := controller.reportGoalReconcileDurable(
		t.Context(),
		opened.Session,
		GoalReconcileDurableRequest{RequestID: "side-goal"},
	); err != nil {
		t.Fatalf("Side goal reconcile durable sink error = %v", err)
	}
	if _, err := controller.BindGoalProvenance(
		t.Context(),
		opened.Session,
		"side-fingerprint",
		GoalProvenanceBinding{},
	); !errors.Is(err, ErrSideConversationUnsupported) {
		t.Fatalf("Side goal provenance error = %v, want unsupported", err)
	}
	if _, err := controller.Exec(t.Context(), ExecInput{
		RoomID: "workspace-side", AgentSessionID: "side-1",
		TurnID:                          "side-turn-with-canonical-submit",
		ClientSubmitID:                  "side-submit",
		CanonicalSubmitOccurredAtUnixMS: 1,
		Content: []PromptContentBlock{{
			Type: "text", Text: "must remain transient",
		}},
	}); err == nil || !strings.Contains(err.Error(), "canonical submit occurrence") {
		t.Fatalf(
			"Side canonical submit occurrence error = %v, want transient-lane rejection",
			err,
		)
	}
	if _, err := controller.Exec(t.Context(), ExecInput{
		RoomID: "workspace-side", AgentSessionID: "side-1", TurnID: "side-turn",
		ClientSubmitID: "side-submit",
		Content:        []PromptContentBlock{{Type: "text", Text: "side question"}},
	}); err != nil {
		t.Fatal(err)
	}
	waitForSessionStatus(
		t, controller, "workspace-side", "side-1", SessionStatusReady,
	)
	if _, err := controller.Close(t.Context(), CloseInput{
		RoomID: "workspace-side", AgentSessionID: "side-1",
	}); err != nil {
		t.Fatal(err)
	}
	if got := len(reporter.snapshot()); got != len(before) {
		t.Fatalf("durable report calls = %d, want unchanged %d", got, len(before))
	}
	if canonicalObserver.contains("side-1") {
		t.Fatal("side events leaked into the canonical stream observer")
	}
	if !sideObserver.contains("side-1") {
		t.Fatal("side events did not reach the transient observer")
	}
	if sessions := controller.Sessions("workspace-side"); len(sessions) != 1 ||
		sessions[0].AgentSessionID != "parent" {
		t.Fatalf("canonical sessions = %#v, want only parent", sessions)
	}

	close(adapter.parentRelease)
	waitForSessionStatus(
		t, controller, "workspace-side", "parent", SessionStatusReady,
	)
}

func TestExpiredSideConversationNeverResumes(t *testing.T) {
	adapter := newSideConformanceAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	if _, err := controller.Start(t.Context(), StartInput{
		RoomID: "workspace-side", AgentSessionID: "parent", Provider: adapter.Provider(),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := controller.OpenSide(t.Context(), SideConversationOpenInput{
		RoomID: "workspace-side", SourceAgentSessionID: "parent",
		SideAgentSessionID: "side-1", RequestID: "open-1",
	}); err != nil {
		t.Fatal(err)
	}
	adapter.mu.Lock()
	adapter.live["side-1"] = false
	adapter.mu.Unlock()

	_, err := controller.Exec(t.Context(), ExecInput{
		RoomID: "workspace-side", AgentSessionID: "side-1", TurnID: "side-turn",
		Content: []PromptContentBlock{{Type: "text", Text: "late question"}},
	})
	if !errors.Is(err, ErrSideConversationExpired) {
		t.Fatalf("Exec error = %v, want ErrSideConversationExpired", err)
	}
	adapter.mu.Lock()
	defer adapter.mu.Unlock()
	if adapter.resumeCalls != 0 {
		t.Fatalf("side resume calls = %d, want 0", adapter.resumeCalls)
	}
}

func TestSideCapabilitiesDelegatesAfterCanonicalSourceIdleRelease(t *testing.T) {
	adapter := newSideConformanceAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	if _, err := controller.Resume(t.Context(), ResumeInput{
		RoomID:            "workspace-side",
		AgentSessionID:    "parent",
		Provider:          adapter.Provider(),
		ProviderSessionID: "provider-parent",
	}); err != nil {
		t.Fatal(err)
	}
	adapter.mu.Lock()
	resumeCalls := adapter.resumeCalls
	adapter.live["parent"] = false
	adapter.mu.Unlock()

	capabilities, err := controller.SideCapabilities(
		t.Context(), "workspace-side", "parent",
	)
	if err != nil {
		t.Fatal(err)
	}
	if !validRequiredSideCapabilities(capabilities) {
		t.Fatalf("SideCapabilities = %#v, want supported", capabilities)
	}
	adapter.mu.Lock()
	defer adapter.mu.Unlock()
	if adapter.resumeCalls != resumeCalls {
		t.Fatalf("source resume calls = %d, want %d", adapter.resumeCalls, resumeCalls)
	}
}

func TestOpenSideDelegatesAfterCanonicalSourceIdleRelease(t *testing.T) {
	adapter := newSideConformanceAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	if _, err := controller.Resume(t.Context(), ResumeInput{
		RoomID:            "workspace-side",
		AgentSessionID:    "parent",
		Provider:          adapter.Provider(),
		ProviderSessionID: "provider-parent",
	}); err != nil {
		t.Fatal(err)
	}
	adapter.mu.Lock()
	resumeCalls := adapter.resumeCalls
	adapter.live["parent"] = false
	adapter.mu.Unlock()

	opened, err := controller.OpenSide(t.Context(), SideConversationOpenInput{
		RoomID:               "workspace-side",
		SourceAgentSessionID: "parent",
		SideAgentSessionID:   "side-after-release",
		RequestID:            "open-after-release",
	})
	if err != nil {
		t.Fatal(err)
	}
	if opened.Session.ProviderSessionID != "provider-side" {
		t.Fatalf("opened Side = %#v", opened.Session)
	}
	adapter.mu.Lock()
	defer adapter.mu.Unlock()
	if adapter.resumeCalls != resumeCalls {
		t.Fatalf("source resume calls = %d, want %d", adapter.resumeCalls, resumeCalls)
	}
}

func TestSideConversationRequiredCapabilitiesFailClosed(t *testing.T) {
	full := SideConversationCapabilities{
		Supported: true, ActiveSourceTurn: true, Ephemeral: true,
		HideInheritedTurns: true, ModelBoundaryInjected: true,
	}
	tests := []struct {
		name      string
		preflight SideConversationCapabilities
		open      *SideConversationCapabilities
	}{
		{
			name: "preflight lacks ephemeral",
			preflight: SideConversationCapabilities{
				Supported: true, ActiveSourceTurn: true,
				HideInheritedTurns: true, ModelBoundaryInjected: true,
			},
		},
		{
			name:      "open result weakens boundary",
			preflight: full,
			open: &SideConversationCapabilities{
				Supported: true, ActiveSourceTurn: true, Ephemeral: true,
				HideInheritedTurns: true,
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			adapter := newSideConformanceAdapter()
			adapter.capabilities = &test.preflight
			adapter.openCaps = test.open
			controller := NewController([]Adapter{adapter}, nil)
			if _, err := controller.Start(t.Context(), StartInput{
				RoomID: "workspace-caps", AgentSessionID: "parent",
				Provider: adapter.Provider(),
			}); err != nil {
				t.Fatal(err)
			}
			_, err := controller.OpenSide(t.Context(), SideConversationOpenInput{
				RoomID: "workspace-caps", SourceAgentSessionID: "parent",
				SideAgentSessionID: "side-caps", RequestID: "open-caps",
			})
			if !errors.Is(err, ErrSideConversationUnsupported) {
				t.Fatalf("OpenSide error = %v, want unsupported", err)
			}
			if _, found := controller.Session("workspace-caps", "side-caps"); found {
				t.Fatal("failed capability validation left Side registered")
			}
		})
	}
}

func TestInvalidSideOpenIdentityNeverClosesParent(t *testing.T) {
	adapter := newSideConformanceAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(t.Context(), StartInput{
		RoomID: "workspace-invalid-side", AgentSessionID: "parent",
		Provider: adapter.Provider(),
	})
	if err != nil {
		t.Fatal(err)
	}
	parent := started.Session
	adapter.openSession = &parent
	_, err = controller.OpenSide(t.Context(), SideConversationOpenInput{
		RoomID: "workspace-invalid-side", SourceAgentSessionID: "parent",
		SideAgentSessionID: "side-invalid", RequestID: "open-invalid",
	})
	if !errors.Is(err, ErrSideConversationConflict) {
		t.Fatalf("OpenSide error = %v, want conflict", err)
	}
	adapter.mu.Lock()
	parentLive := adapter.live["parent"]
	closedIDs := append([]string(nil), adapter.closedIDs...)
	adapter.mu.Unlock()
	if !parentLive {
		t.Fatal("invalid Side result closed the parent")
	}
	for _, closedID := range closedIDs {
		if closedID == "parent" {
			t.Fatal("invalid Side result invoked Close with parent identity")
		}
	}
}

func TestFailedSideOpenDiscardsBufferedTransientEvents(t *testing.T) {
	adapter := newSideConformanceAdapter()
	adapter.openErr = errors.New("fork rejected")
	controller := NewController([]Adapter{adapter}, nil)
	observer := &sessionRecordingObserver{}
	controller.SetSideStreamEventObserver(observer)
	if _, err := controller.Start(t.Context(), StartInput{
		RoomID: "workspace-side", AgentSessionID: "parent", Provider: adapter.Provider(),
	}); err != nil {
		t.Fatal(err)
	}
	_, err := controller.OpenSide(t.Context(), SideConversationOpenInput{
		RoomID: "workspace-side", SourceAgentSessionID: "parent",
		SideAgentSessionID: "side-failed", RequestID: "open-failed",
	})
	if !errors.Is(err, adapter.openErr) {
		t.Fatalf("OpenSide error = %v", err)
	}
	if observer.contains("side-failed") {
		t.Fatal("failed Side leaked its buffered transient events")
	}
	if _, found := controller.Session("workspace-side", "side-failed"); found {
		t.Fatal("failed Side remained registered")
	}
}
