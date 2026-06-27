package ingress

import (
	"context"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
	guestdesktoprelayv1 "github.com/tutti-os/tutti/packages/agentactivity/daemon/internal/guestdesktoprelay/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestDispatchReportActivityIgnoresTimelineOnlyRequestForActivityObserver(t *testing.T) {
	t.Parallel()

	reporter := &fakeReporter{}
	dispatch := NewDispatchService()
	dispatch.RegisterWorkspace("ws-1", WorkspaceHandler{
		RoomID:   "room-1",
		Reporter: reporter,
	})

	var observed string
	dispatch.SetActivityObserver(func(workspaceID string) {
		observed = workspaceID
	})
	resp, err := dispatch.ReportActivity(context.Background(), testReportRequest("ws-1"))
	if err != nil {
		t.Fatalf("ReportActivity() error = %v", err)
	}
	if resp.GetAcceptedTimelineItemCount() != 0 {
		t.Fatalf("accepted = %d, want 0", resp.GetAcceptedTimelineItemCount())
	}
	if observed != "" {
		t.Fatalf("observed workspace = %q, want no timeline-only notification", observed)
	}
}

func TestDispatchReportActivityDoesNotNotifyObserverForIdlePatch(t *testing.T) {
	t.Parallel()

	reporter := &fakeReporter{}
	dispatch := NewDispatchService()
	dispatch.RegisterWorkspace("ws-1", WorkspaceHandler{
		RoomID:   "room-1",
		Reporter: reporter,
	})

	observed := false
	dispatch.SetActivityObserver(func(_ string) {
		observed = true
	})
	_, err := dispatch.ReportActivity(context.Background(), &guestdesktoprelayv1.ReportAgentActivityRequest{
		WorkspaceId: "ws-1",
		StatePatches: []*guestdesktoprelayv1.AgentActivityStatePatch{{
			AgentSessionId: "agent-session-1",
			CurrentPhase:   "idle",
		}},
	})
	if err != nil {
		t.Fatalf("ReportActivity() error = %v", err)
	}
	if observed {
		t.Fatal("observer was called for idle-only activity")
	}
}

func TestDispatchReportActivityNotifiesObserverForActivePatch(t *testing.T) {
	t.Parallel()

	reporter := &fakeReporter{}
	dispatch := NewDispatchService()
	dispatch.RegisterWorkspace("ws-1", WorkspaceHandler{
		RoomID:   "room-1",
		Reporter: reporter,
	})

	var observed string
	dispatch.SetActivityObserver(func(workspaceID string) {
		observed = workspaceID
	})
	_, err := dispatch.ReportActivity(context.Background(), &guestdesktoprelayv1.ReportAgentActivityRequest{
		WorkspaceId: "ws-1",
		StatePatches: []*guestdesktoprelayv1.AgentActivityStatePatch{{
			AgentSessionId: "agent-session-1",
			CurrentPhase:   "working",
		}},
	})
	if err != nil {
		t.Fatalf("ReportActivity() error = %v", err)
	}
	if observed != "ws-1" {
		t.Fatalf("observed workspace = %q, want ws-1", observed)
	}
}

func TestDispatchReportActivityIgnoresTimelineOnlyRequestWithResolvedRoom(t *testing.T) {
	t.Parallel()

	reporter := &fakeReporter{}
	dispatch := NewDispatchService()
	dispatch.RegisterWorkspace("ws-1", WorkspaceHandler{
		RoomID:   "resolved-room",
		Reporter: reporter,
	})
	_, err := dispatch.ReportActivity(context.Background(), testReportRequest("ws-1"))
	if err != nil {
		t.Fatalf("ReportActivity() error = %v", err)
	}
	if reporter.reportActivity {
		t.Fatal("ReportActivity was called")
	}
	if reporter.reportSessionState {
		t.Fatal("ReportSessionState was called for timeline-only request")
	}
	if reporter.reportSessionMessages {
		t.Fatal("ReportSessionMessages was called for timeline-only request")
	}
}

func TestDispatchReportActivitySplitsMessageUpdates(t *testing.T) {
	t.Parallel()

	reporter := &fakeReporter{}
	dispatch := NewDispatchService()
	dispatch.RegisterWorkspace("ws-1", WorkspaceHandler{
		RoomID:   "room-1",
		Reporter: reporter,
	})
	resp, err := dispatch.ReportActivity(context.Background(), &guestdesktoprelayv1.ReportAgentActivityRequest{
		WorkspaceId: "ws-1",
		MessageUpdates: []*guestdesktoprelayv1.AgentActivityMessageUpdate{{
			AgentSessionId: "agent-session-1",
			MessageId:      "message-1",
			Seq:            7,
			TurnId:         "turn-1",
			Role:           "assistant",
			Kind:           "text",
		}},
	})
	if err != nil {
		t.Fatalf("ReportActivity() error = %v", err)
	}
	if resp.GetAcceptedMessageUpdateCount() != 1 {
		t.Fatalf("accepted message updates = %d, want 1", resp.GetAcceptedMessageUpdateCount())
	}
	if reporter.reportActivity {
		t.Fatal("ReportActivity was called for message-only report")
	}
	if len(reporter.sessionMessagesInputs) != 1 || len(reporter.sessionMessagesInputs[0].Updates) != 1 {
		t.Fatalf("reported session message inputs = %#v, want one update", reporter.sessionMessagesInputs)
	}
	if reporter.sessionMessagesInputs[0].AgentSessionID != "agent-session-1" {
		t.Fatalf("reported session = %q, want agent-session-1", reporter.sessionMessagesInputs[0].AgentSessionID)
	}
	update := reporter.sessionMessagesInputs[0].Updates[0]
	if update.MessageID != "message-1" || update.Role != "assistant" || update.Kind != "text" {
		t.Fatalf("message update = %#v", update)
	}
}

func TestDispatchReportSessionStateNotifiesObserverAndForwardsState(t *testing.T) {
	t.Parallel()

	reporter := &fakeReporter{}
	dispatch := NewDispatchService()
	dispatch.RegisterWorkspace("ws-1", WorkspaceHandler{
		RoomID:   "room-1",
		Reporter: reporter,
	})

	var observed string
	dispatch.SetActivityObserver(func(workspaceID string) {
		observed = workspaceID
	})
	resp, err := dispatch.ReportSessionState(context.Background(), &guestdesktoprelayv1.ReportAgentSessionStateRequest{
		WorkspaceId:    " ws-1 ",
		AgentSessionId: " agent-session-1 ",
		SessionOrigin:  guestdesktoprelayv1.AgentSessionOrigin_AGENT_SESSION_ORIGIN_RUNTIME,
		State: &guestdesktoprelayv1.AgentSessionStateUpdate{
			Provider:         " codex ",
			Title:            " Working ",
			OccurredAtUnixMs: 1710000000001,
		},
	})
	if err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	if !resp.GetAccepted() || resp.GetLastEventAtUnixMs() != 1710000000001 {
		t.Fatalf("response = %#v", resp)
	}
	if observed != "ws-1" {
		t.Fatalf("observed workspace = %q, want ws-1", observed)
	}
	if reporter.reportActivity {
		t.Fatal("ReportActivity was called")
	}
	if !reporter.reportSessionState {
		t.Fatal("ReportSessionState was not called")
	}
	input := reporter.sessionStateInput
	if input.WorkspaceID != "room-1" || input.AgentSessionID != "agent-session-1" || input.SessionOrigin != agentsessionstore.WorkspaceAgentSessionOriginRuntime {
		t.Fatalf("input identity = %#v", input)
	}
	if input.State.Provider != "codex" || input.State.Title != "Working" {
		t.Fatalf("state = %#v", input.State)
	}
}

func TestDispatchReportSessionMessagesNotifiesObserverAndForwardsMessages(t *testing.T) {
	t.Parallel()

	reporter := &fakeReporter{}
	dispatch := NewDispatchService()
	dispatch.RegisterWorkspace("ws-1", WorkspaceHandler{
		RoomID:   "room-1",
		Reporter: reporter,
	})

	var observed string
	dispatch.SetActivityObserver(func(workspaceID string) {
		observed = workspaceID
	})
	resp, err := dispatch.ReportSessionMessages(context.Background(), &guestdesktoprelayv1.ReportAgentSessionMessagesRequest{
		WorkspaceId:    "ws-1",
		AgentSessionId: " agent-session-1 ",
		SessionOrigin:  guestdesktoprelayv1.AgentSessionOrigin_AGENT_SESSION_ORIGIN_RUNTIME,
		Updates: []*guestdesktoprelayv1.AgentSessionMessageUpdate{{
			MessageId: " message-1 ",
			Role:      " assistant ",
			Kind:      " text ",
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
	if resp.GetAcceptedCount() != 1 || resp.GetLatestVersion() != 7 {
		t.Fatalf("response = %#v", resp)
	}
	if observed != "ws-1" {
		t.Fatalf("observed workspace = %q, want ws-1", observed)
	}
	if reporter.reportActivity {
		t.Fatal("ReportActivity was called")
	}
	if !reporter.reportSessionMessages {
		t.Fatal("ReportSessionMessages was not called")
	}
	input := reporter.sessionMessagesInput
	if input.WorkspaceID != "room-1" || input.AgentSessionID != "agent-session-1" || input.SessionOrigin != agentsessionstore.WorkspaceAgentSessionOriginRuntime {
		t.Fatalf("input identity = %#v", input)
	}
	if len(input.Updates) != 1 || input.Updates[0].MessageID != "message-1" {
		t.Fatalf("updates = %#v", input.Updates)
	}
}

func TestDispatchReportActivityRejectsUnregisteredWorkspace(t *testing.T) {
	t.Parallel()

	reporter := &fakeReporter{}
	dispatch := NewDispatchService()
	dispatch.RegisterWorkspace("ws-1", WorkspaceHandler{
		RoomID:   "handler-room",
		Reporter: reporter,
	})
	_, err := dispatch.ReportActivity(context.Background(), testReportRequest("missing-ws"))
	if status.Code(err) != codes.NotFound {
		t.Fatalf("status = %v, want NotFound", status.Code(err))
	}
	if reporter.reportActivity {
		t.Fatal("ReportActivity was called")
	}
}

func TestDispatchReportActivityRequiresWorkspaceID(t *testing.T) {
	t.Parallel()

	reporter := &fakeReporter{}
	dispatch := NewDispatchService()
	dispatch.RegisterWorkspace("ws-1", WorkspaceHandler{
		RoomID:   "room-1",
		Reporter: reporter,
	})

	_, err := dispatch.ReportActivity(context.Background(), &guestdesktoprelayv1.ReportAgentActivityRequest{})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("status = %v, want InvalidArgument", status.Code(err))
	}
}

func TestDispatchReportActivityRequiresHandlerRoom(t *testing.T) {
	t.Parallel()

	reporter := &fakeReporter{}
	dispatch := NewDispatchService()
	dispatch.RegisterWorkspace("ws-1", WorkspaceHandler{
		Reporter: reporter,
	})

	_, err := dispatch.ReportActivity(context.Background(), &guestdesktoprelayv1.ReportAgentActivityRequest{WorkspaceId: "ws-1"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("status = %v, want FailedPrecondition", status.Code(err))
	}
	if reporter.reportActivity {
		t.Fatal("ReportActivity was called")
	}
}

func TestDispatchReportActivityPreservesReportPayload(t *testing.T) {
	t.Parallel()

	reporter := &fakeReporter{}
	dispatch := NewDispatchService()
	dispatch.RegisterWorkspace("ws-1", WorkspaceHandler{
		RoomID:   "room-1",
		Reporter: reporter,
	})
	_, err := dispatch.ReportActivity(context.Background(), &guestdesktoprelayv1.ReportAgentActivityRequest{
		WorkspaceId: "ws-1",
		Source:      &guestdesktoprelayv1.AgentActivitySource{Cwd: "/workspace/ws-1/project"},
		StatePatches: []*guestdesktoprelayv1.AgentActivityStatePatch{{
			AgentSessionId: "agent-session-1",
			Provider:       "codex",
			Cwd:            "/workspace/ws-2",
		}},
	})
	if err != nil {
		t.Fatalf("ReportActivity: %v", err)
	}
	if reporter.reportActivity {
		t.Fatal("ReportActivity was called for state-only report")
	}
	if len(reporter.sessionStateInputs) != 1 {
		t.Fatalf("reported session state inputs = %d, want 1", len(reporter.sessionStateInputs))
	}
	if reporter.sessionStateInputs[0].State.CWD != "/workspace/ws-2" {
		t.Fatalf("state cwd = %q, want /workspace/ws-2", reporter.sessionStateInputs[0].State.CWD)
	}
}

func testReportRequest(workspaceID string) *guestdesktoprelayv1.ReportAgentActivityRequest {
	return &guestdesktoprelayv1.ReportAgentActivityRequest{
		WorkspaceId: workspaceID,
		TimelineItems: []*guestdesktoprelayv1.AgentActivityTimelineItem{{
			AgentSessionId: "agent-session-1",
			EventId:        "event-1",
			ItemType:       "message.assistant",
		}},
	}
}
