package api

import (
	"context"
	"testing"

	"github.com/google/uuid"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentsessionreplay "github.com/tutti-os/tutti/services/tuttid/service/agentsessionreplay"
)

type agentSessionRecordingServiceStub struct {
	AgentSessionRecordingService
	startInput agentsessionreplay.StartInput
	recording  agentsessionreplay.Recording
	renameName string
	events     []agentsessionreplay.ActivityEvent
}

func (s *agentSessionRecordingServiceStub) RecordActivityEvents(
	_ context.Context,
	events []agentsessionreplay.ActivityEvent,
) (uint64, error) {
	s.events = append(s.events, events...)
	return uint64(len(s.events)), nil
}

func (s *agentSessionRecordingServiceStub) Start(
	_ context.Context,
	input agentsessionreplay.StartInput,
) (agentsessionreplay.Recording, error) {
	s.startInput = input
	return agentsessionreplay.Recording{
		ID:                 "54f46b5c-34e5-40e2-8147-361bb0d046dc",
		Name:               "2026-07-28T10:00:00.000Z",
		ScopeID:            input.WorkspaceID,
		AgentTargetID:      input.AgentTargetID,
		Mode:               agentsessionreplay.ScenarioModeContinueSession,
		RootAgentSessionID: input.AgentSessionID,
		Status:             agentsessionreplay.StatusRecording,
		ArtifactKey:        "/tmp/recording",
		CreatedAtUnixMS:    1,
		UpdatedAtUnixMS:    1,
	}, nil
}

func (s *agentSessionRecordingServiceStub) Get(
	_ context.Context,
	_ string,
) (agentsessionreplay.Recording, error) {
	return s.recording, nil
}

func (s *agentSessionRecordingServiceStub) Rename(
	_ context.Context,
	_ string,
	name string,
) (agentsessionreplay.Recording, error) {
	s.renameName = name
	s.recording.Name = name
	return s.recording, nil
}

func TestStartAgentSessionRecordingAcceptsOpaqueExistingSessionID(t *testing.T) {
	service := &agentSessionRecordingServiceStub{}
	agentSessionID := "imported-codex-48e73404e80c12d2d18e5808"
	workspaceID := "934219f8-5fa2-4d28-aaf0-420a73d45847"

	response, err := (DaemonAPI{
		AgentSessionRecordingService: service,
	}).StartAgentSessionRecording(context.Background(), tuttigenerated.StartAgentSessionRecordingRequestObject{
		WorkspaceID: workspaceID,
		Body: &tuttigenerated.StartAgentSessionRecordingRequest{
			AgentTargetId:  "local:codex",
			AgentSessionId: &agentSessionID,
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	created, ok := response.(tuttigenerated.StartAgentSessionRecording201JSONResponse)
	if !ok {
		t.Fatalf("response = %T, want 201", response)
	}
	if service.startInput.AgentSessionID != agentSessionID {
		t.Fatalf("start input session = %q, want %q", service.startInput.AgentSessionID, agentSessionID)
	}
	if created.RootAgentSessionId == nil || *created.RootAgentSessionId != agentSessionID {
		t.Fatalf("response root session = %#v, want %q", created.RootAgentSessionId, agentSessionID)
	}
}

func TestRenameAgentSessionRecordingUpdatesTheCassetteName(t *testing.T) {
	workspaceID := "934219f8-5fa2-4d28-aaf0-420a73d45847"
	recordingID := "54f46b5c-34e5-40e2-8147-361bb0d046dc"
	service := &agentSessionRecordingServiceStub{
		recording: agentsessionreplay.Recording{
			ID: recordingID, Name: "old", ScopeID: workspaceID,
			AgentTargetID: "local:codex", Mode: agentsessionreplay.ScenarioModeCreateSession,
			Status: agentsessionreplay.StatusComplete, ArtifactKey: "/tmp/cassette",
		},
	}
	response, err := (DaemonAPI{
		AgentSessionRecordingService: service,
	}).RenameAgentSessionRecording(
		context.Background(),
		tuttigenerated.RenameAgentSessionRecordingRequestObject{
			WorkspaceID: workspaceID,
			RecordingID: uuid.MustParse(recordingID),
			Body: &tuttigenerated.RenameAgentSessionRecordingRequest{
				Name: "checkout regression",
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	renamed, ok := response.(tuttigenerated.RenameAgentSessionRecording200JSONResponse)
	if !ok || renamed.Name != "checkout regression" ||
		service.renameName != "checkout regression" {
		t.Fatalf("response=%#v rename=%q", response, service.renameName)
	}
}

func TestAppendAgentSessionRecordingActivityEventsMapsRendererBatch(t *testing.T) {
	workspaceID := "934219f8-5fa2-4d28-aaf0-420a73d45847"
	recordingID := "54f46b5c-34e5-40e2-8147-361bb0d046dc"
	sessionID := "session-1"
	correlationID := "submit-1"
	payload := map[string]any{"routing": "send_now"}
	service := &agentSessionRecordingServiceStub{
		recording: agentsessionreplay.Recording{
			ID: recordingID, ScopeID: workspaceID,
			Status: agentsessionreplay.StatusRecording,
		},
	}
	response, err := (DaemonAPI{
		AgentSessionRecordingService: service,
	}).AppendAgentSessionRecordingActivityEvents(
		context.Background(),
		tuttigenerated.AppendAgentSessionRecordingActivityEventsRequestObject{
			WorkspaceID: workspaceID,
			RecordingID: uuid.MustParse(recordingID),
			Body: &tuttigenerated.AppendAgentSessionRecordingActivityEventsRequest{
				Events: []tuttigenerated.AgentSessionRecordingActivityEventInput{{
					EventId: "event-1",
					Kind: tuttigenerated.AgentSessionRecordingActivityEventInputKind(
						agentsessionreplay.ActivityEventKindIntent,
					),
					Type:             "submit/requested",
					AgentSessionId:   &sessionID,
					CorrelationId:    &correlationID,
					Payload:          &payload,
					OccurredAtUnixMs: 10,
				}},
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	accepted, ok := response.(tuttigenerated.AppendAgentSessionRecordingActivityEvents200JSONResponse)
	if !ok || accepted.AcceptedThroughSequence != 1 {
		t.Fatalf("response = %#v", response)
	}
	if len(service.events) != 1 ||
		service.events[0].Kind != agentsessionreplay.ActivityEventKindIntent ||
		service.events[0].WorkspaceID != workspaceID ||
		service.events[0].CorrelationID != correlationID {
		t.Fatalf("events = %#v", service.events)
	}
}
