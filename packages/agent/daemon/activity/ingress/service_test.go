package ingress

import (
	"context"
	"errors"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
	guestdesktoprelayv1 "github.com/tutti-os/tutti/packages/agentactivity/daemon/internal/guestdesktoprelay/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/structpb"
)

type fakeReporter struct {
	workspaceID           string
	activityInput         agentsessionstore.ReportActivityInput
	sessionStateInput     agentsessionstore.ReportSessionStateInput
	sessionMessagesInput  agentsessionstore.ReportSessionMessagesInput
	activityInputs        []agentsessionstore.ReportActivityInput
	sessionStateInputs    []agentsessionstore.ReportSessionStateInput
	sessionMessagesInputs []agentsessionstore.ReportSessionMessagesInput
	reportActivity        bool
	reportSessionState    bool
	reportSessionMessages bool
	err                   error
}

func (f *fakeReporter) ReportActivity(_ context.Context, input agentsessionstore.ReportActivityInput) (agentsessionstore.ReportActivityReply, error) {
	f.reportActivity = true
	f.activityInput = input
	f.activityInputs = append(f.activityInputs, input)
	f.workspaceID = input.WorkspaceID
	if f.err != nil {
		return agentsessionstore.ReportActivityReply{}, f.err
	}
	return agentsessionstore.ReportActivityReply{
		AcceptedTimelineItemCount:  len(input.TimelineItems),
		AcceptedStatePatchCount:    len(input.StatePatches),
		AcceptedMessageUpdateCount: len(input.MessageUpdates),
	}, nil
}

func (f *fakeReporter) ReportSessionState(_ context.Context, input agentsessionstore.ReportSessionStateInput) (agentsessionstore.ReportSessionStateReply, error) {
	f.reportSessionState = true
	f.sessionStateInput = input
	f.sessionStateInputs = append(f.sessionStateInputs, input)
	f.workspaceID = input.WorkspaceID
	if f.err != nil {
		return agentsessionstore.ReportSessionStateReply{}, f.err
	}
	return agentsessionstore.ReportSessionStateReply{
		Accepted:          true,
		LastEventAtUnixMS: input.State.OccurredAtUnixMS,
	}, nil
}

func (f *fakeReporter) ReportSessionMessages(_ context.Context, input agentsessionstore.ReportSessionMessagesInput) (agentsessionstore.ReportSessionMessagesReply, error) {
	f.reportSessionMessages = true
	f.sessionMessagesInput = input
	f.sessionMessagesInputs = append(f.sessionMessagesInputs, input)
	f.workspaceID = input.WorkspaceID
	if f.err != nil {
		return agentsessionstore.ReportSessionMessagesReply{}, f.err
	}
	return agentsessionstore.ReportSessionMessagesReply{
		AcceptedCount: len(input.Updates),
		LatestVersion: 7,
	}, nil
}

func TestReportActivityIgnoresTimelineItemsAndSplitsStatePatches(t *testing.T) {
	t.Parallel()

	reporter := &fakeReporter{}
	service, err := NewService(Config{RoomID: "room-1", Reporter: reporter})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	resp, err := service.ReportActivity(context.Background(), &guestdesktoprelayv1.ReportAgentActivityRequest{
		TimelineItems: []*guestdesktoprelayv1.AgentActivityTimelineItem{{
			AgentSessionId: "session-1",
			EventId:        "message-1",
			ItemType:       "message.assistant",
			Role:           "assistant",
		}},
		StatePatches: []*guestdesktoprelayv1.AgentActivityStatePatch{{
			AgentSessionId: "session-1",
			Provider:       "codex",
			CurrentPhase:   "idle",
		}},
	})
	if err != nil {
		t.Fatalf("ReportActivity: %v", err)
	}
	if resp.GetAcceptedTimelineItemCount() != 0 || resp.GetAcceptedStatePatchCount() != 1 {
		t.Fatalf("accepted = %d/%d, want 0/1", resp.GetAcceptedTimelineItemCount(), resp.GetAcceptedStatePatchCount())
	}
	if reporter.workspaceID != "room-1" {
		t.Fatalf("reported workspace = %q, want room-1", reporter.workspaceID)
	}
	if reporter.reportActivity {
		t.Fatal("ReportActivity was called")
	}
	if len(reporter.sessionStateInputs) != 1 {
		t.Fatalf("session state calls = %d, want 1", len(reporter.sessionStateInputs))
	}
	if reporter.sessionStateInputs[0].AgentSessionID != "session-1" ||
		reporter.sessionStateInputs[0].State.Provider != "codex" ||
		reporter.sessionStateInputs[0].State.CurrentPhase != "idle" {
		t.Fatalf("session state input = %#v", reporter.sessionStateInputs[0])
	}
	if len(reporter.sessionMessagesInputs) != 0 {
		t.Fatalf("session message inputs = %#v, want no timeline-derived messages", reporter.sessionMessagesInputs)
	}
}

func TestReportActivitySplitsMessageUpdates(t *testing.T) {
	t.Parallel()

	reporter := &fakeReporter{}
	service, err := NewService(Config{RoomID: "room-1", Reporter: reporter})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	payload, err := structpb.NewStruct(map[string]any{"path": "README.md"})
	if err != nil {
		t.Fatalf("payload: %v", err)
	}

	resp, err := service.ReportActivity(context.Background(), &guestdesktoprelayv1.ReportAgentActivityRequest{
		MessageUpdates: []*guestdesktoprelayv1.AgentActivityMessageUpdate{{
			AgentSessionId:    " session-1 ",
			MessageId:         " message-1 ",
			Seq:               42,
			TurnId:            " turn-1 ",
			Role:              " assistant ",
			Kind:              " tool_call ",
			Status:            " completed ",
			CallId:            " call-1 ",
			ParentCallId:      " parent-call-1 ",
			RootCallId:        " root-call-1 ",
			Title:             " Read file ",
			Payload:           payload,
			OccurredAtUnixMs:  1710000000001,
			StartedAtUnixMs:   1710000000002,
			CompletedAtUnixMs: 1710000000003,
		}},
	})
	if err != nil {
		t.Fatalf("ReportActivity: %v", err)
	}
	if resp.GetAcceptedMessageUpdateCount() != 1 {
		t.Fatalf("accepted message updates = %d, want 1", resp.GetAcceptedMessageUpdateCount())
	}
	if reporter.reportActivity {
		t.Fatal("ReportActivity was called for message-only report")
	}
	if len(reporter.sessionMessagesInputs) != 1 || len(reporter.sessionMessagesInputs[0].Updates) != 1 {
		t.Fatalf("session message inputs = %#v, want one update", reporter.sessionMessagesInputs)
	}
	if reporter.sessionMessagesInputs[0].AgentSessionID != "session-1" {
		t.Fatalf("agent session id = %q, want session-1", reporter.sessionMessagesInputs[0].AgentSessionID)
	}
	update := reporter.sessionMessagesInputs[0].Updates[0]
	if update.MessageID != "message-1" ||
		update.TurnID != "turn-1" || update.Role != "assistant" || update.Kind != "tool_call" ||
		update.Status != "completed" {
		t.Fatalf("message update = %#v", update)
	}
	if update.Payload["path"] != "README.md" {
		t.Fatalf("payload = %#v", update.Payload)
	}
	if update.Payload["seq"] != uint64(42) ||
		update.Payload["callId"] != "call-1" ||
		update.Payload["parentCallId"] != "parent-call-1" ||
		update.Payload["rootCallId"] != "root-call-1" ||
		update.Payload["title"] != "Read file" {
		t.Fatalf("payload folded fields = %#v", update.Payload)
	}
	if update.OccurredAtUnixMS != 1710000000001 ||
		update.StartedAtUnixMS != 1710000000002 ||
		update.CompletedAtUnixMS != 1710000000003 {
		t.Fatalf("timestamps = %#v", update)
	}
}

func TestReportActivitySplitsStateAndMessagesFromOldActivity(t *testing.T) {
	t.Parallel()

	reporter := &fakeReporter{}
	service, err := NewService(Config{RoomID: "room-1", Reporter: reporter})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	payload, err := structpb.NewStruct(map[string]any{
		"text":   "hello",
		"callId": "payload-call-id",
	})
	if err != nil {
		t.Fatalf("payload: %v", err)
	}

	resp, err := service.ReportActivity(context.Background(), &guestdesktoprelayv1.ReportAgentActivityRequest{
		WorkspaceId: "room-1",
		Source: &guestdesktoprelayv1.AgentActivitySource{
			Provider:          " codex ",
			ProviderSessionId: " provider-session-1 ",
			AgentId:           " source-session ",
			SessionOrigin:     guestdesktoprelayv1.AgentSessionOrigin_AGENT_SESSION_ORIGIN_RUNTIME,
		},
		TimelineItems: []*guestdesktoprelayv1.AgentActivityTimelineItem{{
			AgentSessionId: "timeline-session",
			EventId:        "event-1",
			ItemType:       "message.assistant",
		}},
		StatePatches: []*guestdesktoprelayv1.AgentActivityStatePatch{{
			AgentSessionId:    " state-session ",
			Provider:          " codex ",
			ProviderSessionId: " provider-session-1 ",
			Title:             " Working ",
			CurrentPhase:      " coding ",
			OccurredAtUnixMs:  1710000000001,
		}},
		MessageUpdates: []*guestdesktoprelayv1.AgentActivityMessageUpdate{{
			AgentSessionId: " message-session-a ",
			MessageId:      " message-1 ",
			Seq:            42,
			TurnId:         " turn-1 ",
			Role:           " assistant ",
			Kind:           " text ",
			Status:         " completed ",
			CallId:         " top-level-call-id ",
			Title:          " Top-level title ",
			Payload:        payload,
		}, {
			AgentSessionId: " message-session-b ",
			MessageId:      " message-2 ",
			TurnId:         " turn-2 ",
			Role:           " user ",
			Kind:           " text ",
		}},
	})
	if err != nil {
		t.Fatalf("ReportActivity: %v", err)
	}
	if resp.GetAcceptedTimelineItemCount() != 0 ||
		resp.GetAcceptedStatePatchCount() != 1 ||
		resp.GetAcceptedMessageUpdateCount() != 2 {
		t.Fatalf("response counts = %d/%d/%d, want 0/1/2",
			resp.GetAcceptedTimelineItemCount(),
			resp.GetAcceptedStatePatchCount(),
			resp.GetAcceptedMessageUpdateCount(),
		)
	}
	if reporter.reportActivity {
		t.Fatal("ReportActivity was called")
	}
	if len(reporter.sessionStateInputs) != 1 {
		t.Fatalf("ReportSessionState calls = %d, want 1", len(reporter.sessionStateInputs))
	}
	stateInput := reporter.sessionStateInputs[0]
	if stateInput.AgentSessionID != "state-session" || stateInput.SessionOrigin != agentsessionstore.WorkspaceAgentSessionOriginRuntime {
		t.Fatalf("state input identity = %#v", stateInput)
	}
	if stateInput.State.Title != "Working" || stateInput.State.CurrentPhase != "coding" ||
		stateInput.State.OccurredAtUnixMS != 1710000000001 {
		t.Fatalf("state input = %#v", stateInput.State)
	}
	if len(reporter.sessionMessagesInputs) != 2 {
		t.Fatalf("ReportSessionMessages calls = %d, want 2", len(reporter.sessionMessagesInputs))
	}
	seen := map[string]agentsessionstore.WorkspaceAgentSessionMessageUpdate{}
	for _, input := range reporter.sessionMessagesInputs {
		if len(input.Updates) != 1 {
			t.Fatalf("message input = %#v, want one update per session", input)
		}
		seen[input.AgentSessionID] = input.Updates[0]
		if input.SessionOrigin != agentsessionstore.WorkspaceAgentSessionOriginRuntime {
			t.Fatalf("message input origin = %#v", input)
		}
	}
	update, ok := seen["message-session-a"]
	if !ok {
		t.Fatalf("message sessions = %#v, missing message-session-a", seen)
	}
	if update.MessageID != "message-1" || update.TurnID != "turn-1" || update.Role != "assistant" ||
		update.Kind != "text" || update.Status != "completed" {
		t.Fatalf("converted update = %#v", update)
	}
	if update.Payload["callId"] != "top-level-call-id" ||
		update.Payload["seq"] != uint64(42) ||
		update.Payload["title"] != "Top-level title" {
		t.Fatalf("payload = %#v", update.Payload)
	}
	if _, ok := seen["message-session-b"]; !ok {
		t.Fatalf("message sessions = %#v, missing message-session-b", seen)
	}
}

func TestReportSessionStateForwardsStateWithoutReportActivity(t *testing.T) {
	t.Parallel()

	reporter := &fakeReporter{}
	service, err := NewService(Config{RoomID: "room-1", Reporter: reporter})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	fileChanges, err := structpb.NewStruct(map[string]any{"modified": []any{"README.md"}})
	if err != nil {
		t.Fatalf("file changes: %v", err)
	}

	resp, err := service.ReportSessionState(context.Background(), &guestdesktoprelayv1.ReportAgentSessionStateRequest{
		WorkspaceId:    " room-1 ",
		AgentSessionId: " agent-session-1 ",
		SessionOrigin:  guestdesktoprelayv1.AgentSessionOrigin_AGENT_SESSION_ORIGIN_RUNTIME,
		Connector:      &guestdesktoprelayv1.AgentActivityConnector{Id: " desktopd ", Version: " 1.2.3 "},
		Source: &guestdesktoprelayv1.AgentActivitySource{
			Provider:          " codex ",
			ProviderSessionId: " provider-session-1 ",
			AgentId:           " agent-session-1 ",
			Cwd:               " /workspace ",
			SessionOrigin:     guestdesktoprelayv1.AgentSessionOrigin_AGENT_SESSION_ORIGIN_RUNTIME,
		},
		State: &guestdesktoprelayv1.AgentSessionStateUpdate{
			Provider:          " codex ",
			ProviderSessionId: " provider-session-1 ",
			Model:             " gpt-5 ",
			Cwd:               " /workspace ",
			Title:             " Working ",
			LifecycleStatus:   " active ",
			CurrentPhase:      " coding ",
			OccurredAtUnixMs:  1710000000001,
			StartedAtUnixMs:   1710000000002,
			Turn: &guestdesktoprelayv1.AgentSessionTurnStateUpdate{
				TurnId:            " turn-1 ",
				Phase:             " coding ",
				Outcome:           " running ",
				FileChanges:       fileChanges,
				StartedAtUnixMs:   1710000000002,
				CompletedAtUnixMs: 1710000000003,
			},
		},
	})
	if err != nil {
		t.Fatalf("ReportSessionState: %v", err)
	}
	if !resp.GetAccepted() || resp.GetLastEventAtUnixMs() != 1710000000001 {
		t.Fatalf("response = %#v", resp)
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
	if input.Connector == nil || input.Connector.ID != "desktopd" || input.Connector.Version != "1.2.3" {
		t.Fatalf("connector = %#v", input.Connector)
	}
	if input.Source.Provider != "codex" || input.Source.AgentID != "agent-session-1" {
		t.Fatalf("source = %#v", input.Source)
	}
	if input.State.Provider != "codex" || input.State.Title != "Working" || input.State.CurrentPhase != "coding" {
		t.Fatalf("state = %#v", input.State)
	}
	if input.State.Turn == nil || input.State.Turn.TurnID != "turn-1" || input.State.Turn.FileChanges["modified"] == nil {
		t.Fatalf("turn = %#v", input.State.Turn)
	}
}

func TestReportSessionMessagesForwardsMessagesWithoutReportActivity(t *testing.T) {
	t.Parallel()

	reporter := &fakeReporter{}
	service, err := NewService(Config{RoomID: "room-1", Reporter: reporter})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	payload, err := structpb.NewStruct(map[string]any{"path": "README.md"})
	if err != nil {
		t.Fatalf("payload: %v", err)
	}

	resp, err := service.ReportSessionMessages(context.Background(), &guestdesktoprelayv1.ReportAgentSessionMessagesRequest{
		WorkspaceId:    "room-1",
		AgentSessionId: " agent-session-1 ",
		SessionOrigin:  guestdesktoprelayv1.AgentSessionOrigin_AGENT_SESSION_ORIGIN_RUNTIME,
		Updates: []*guestdesktoprelayv1.AgentSessionMessageUpdate{{
			MessageId:         " message-1 ",
			TurnId:            " turn-1 ",
			Role:              " assistant ",
			Kind:              " tool_call ",
			Status:            " completed ",
			Payload:           payload,
			OccurredAtUnixMs:  1710000000001,
			StartedAtUnixMs:   1710000000002,
			CompletedAtUnixMs: 1710000000003,
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages: %v", err)
	}
	if resp.GetAcceptedCount() != 1 || resp.GetLatestVersion() != 7 {
		t.Fatalf("response = %#v", resp)
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
	if len(input.Updates) != 1 {
		t.Fatalf("updates = %#v, want one", input.Updates)
	}
	update := input.Updates[0]
	if update.MessageID != "message-1" || update.TurnID != "turn-1" || update.Role != "assistant" ||
		update.Kind != "tool_call" || update.Status != "completed" {
		t.Fatalf("update = %#v", update)
	}
	if update.Payload["path"] != "README.md" {
		t.Fatalf("payload = %#v", update.Payload)
	}
}

func TestReportActivityRejectsMismatchedWorkspaceID(t *testing.T) {
	t.Parallel()

	service, err := NewService(Config{RoomID: "room-1", Reporter: &fakeReporter{}})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	_, err = service.ReportActivity(context.Background(), &guestdesktoprelayv1.ReportAgentActivityRequest{WorkspaceId: "other-room"})
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("status = %v, want PermissionDenied", status.Code(err))
	}
}

func TestReportActivityPropagatesReporterError(t *testing.T) {
	t.Parallel()

	service, err := NewService(Config{RoomID: "room-1", Reporter: &fakeReporter{err: errors.New("upstream unavailable")}})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	_, err = service.ReportActivity(context.Background(), &guestdesktoprelayv1.ReportAgentActivityRequest{
		StatePatches: []*guestdesktoprelayv1.AgentActivityStatePatch{{AgentSessionId: "session-1", CurrentPhase: "working"}},
	})
	if status.Code(err) != codes.Unavailable {
		t.Fatalf("status = %v, want Unavailable", status.Code(err))
	}
}
