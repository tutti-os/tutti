package eventstream

import (
	"encoding/json"
	"testing"
	"time"

	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
)

func TestAgentCollaborationPublisherPublishesRunPayload(t *testing.T) {
	t.Parallel()

	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	t.Cleanup(func() {
		service.CloseSession(session)
	})
	if err := service.Subscribe(session, []string{TopicAgentCollaborationUpdated}, EventScope{WorkspaceID: "ws-1"}); err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}

	publisher := AgentCollaborationPublisher{
		Service: service,
		Now: func() time.Time {
			return time.UnixMilli(1_720_000_000_000)
		},
	}
	publisher.PublishCollaborationRunUpdated("ws-1", collabrunbiz.Run{
		ID:              "cr-1",
		WorkspaceID:     "ws-1",
		Mode:            collabrunbiz.ModeConsult,
		TriggerSource:   collabrunbiz.TriggerUser,
		SourceSessionID: "session-1",
		ModelPlanID:     "mp-1",
		Model:           "fake-mini",
		Status:          collabrunbiz.StatusCompleted,
		Adoption:        collabrunbiz.AdoptionPending,
	})

	event := receiveEvent(t, session)
	if event.Topic != TopicAgentCollaborationUpdated {
		t.Fatalf("event topic = %q, want %q", event.Topic, TopicAgentCollaborationUpdated)
	}
	var payload agentCollaborationUpdatedPayload
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if payload.WorkspaceID != "ws-1" || payload.RunID != "cr-1" {
		t.Fatalf("payload identity = %q/%q, want ws-1/cr-1", payload.WorkspaceID, payload.RunID)
	}
	if payload.Mode != "consult" || payload.Status != "completed" || payload.TriggerSource != "user" {
		t.Fatalf("payload = %#v, want consult/completed/user", payload)
	}
	if payload.SourceSessionID != "session-1" || payload.ModelPlanID != "mp-1" || payload.Model != "fake-mini" {
		t.Fatalf("payload references = %#v", payload)
	}
	if payload.Adoption != "pending" {
		t.Fatalf("payload adoption = %q, want pending", payload.Adoption)
	}
	if payload.OccurredAtUnixMS != 1_720_000_000_000 {
		t.Fatalf("payload occurredAtUnixMs = %d, want 1720000000000", payload.OccurredAtUnixMS)
	}
}

func TestAgentCollaborationPublisherSkipsIncompleteRuns(t *testing.T) {
	t.Parallel()

	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	t.Cleanup(func() {
		service.CloseSession(session)
	})
	if err := service.Subscribe(session, []string{TopicAgentCollaborationUpdated}, EventScope{}); err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}

	publisher := AgentCollaborationPublisher{Service: service}
	publisher.PublishCollaborationRunUpdated("", collabrunbiz.Run{ID: "cr-1"})
	publisher.PublishCollaborationRunUpdated("ws-1", collabrunbiz.Run{})
	assertNoEvent(t, session)
}

func TestAgentCollaborationUpdatedValidationRejectsBadPayloads(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"missing workspaceId":   `{"runId":"cr-1","mode":"consult","status":"running","triggerSource":"user","occurredAtUnixMs":1000}`,
		"missing runId":         `{"workspaceId":"ws","mode":"consult","status":"running","triggerSource":"user","occurredAtUnixMs":1000}`,
		"unknown mode":          `{"workspaceId":"ws","runId":"cr-1","mode":"summon","status":"running","triggerSource":"user","occurredAtUnixMs":1000}`,
		"unknown status":        `{"workspaceId":"ws","runId":"cr-1","mode":"consult","status":"done","triggerSource":"user","occurredAtUnixMs":1000}`,
		"unknown triggerSource": `{"workspaceId":"ws","runId":"cr-1","mode":"consult","status":"running","triggerSource":"cron","occurredAtUnixMs":1000}`,
		"unknown adoption":      `{"workspaceId":"ws","runId":"cr-1","mode":"consult","status":"running","triggerSource":"user","adoption":"maybe","occurredAtUnixMs":1000}`,
		"missing occurredAt":    `{"workspaceId":"ws","runId":"cr-1","mode":"consult","status":"running","triggerSource":"user"}`,
		"unknown field present": `{"workspaceId":"ws","runId":"cr-1","mode":"consult","status":"running","triggerSource":"user","occurredAtUnixMs":1000,"extra":true}`,
	}
	for name, payload := range cases {
		if err := validateAgentCollaborationUpdatedPayload([]byte(payload)); err == nil {
			t.Fatalf("%s: expected validation error", name)
		}
	}

	if err := validateAgentCollaborationUpdatedPayload(
		[]byte(`{"workspaceId":"ws","runId":"cr-1","mode":"fork","status":"completed","sourceSessionId":"s1","targetSessionId":"s2","modelPlanId":"mp-1","model":"m1","triggerSource":"agent","adoption":"not_applicable","occurredAtUnixMs":1000}`),
	); err != nil {
		t.Fatalf("valid payload rejected: %v", err)
	}
}

// Contract test between the publisher's payload construction and the catalog
// schema: the catalog decodes strictly, so a payload field missing from the
// definition drops the WHOLE publish.
func TestAgentCollaborationPublisherPayloadPassesCatalogValidation(t *testing.T) {
	t.Parallel()

	payload, err := json.Marshal(agentCollaborationUpdatedPayload{
		WorkspaceID:      "ws-1",
		RunID:            "cr-1",
		Mode:             string(collabrunbiz.ModeConsult),
		Status:           string(collabrunbiz.StatusFailed),
		SourceSessionID:  "session-1",
		TargetSessionID:  "session-2",
		ModelPlanID:      "mp-1",
		Model:            "fake-mini",
		TriggerSource:    string(collabrunbiz.TriggerPolicy),
		Adoption:         string(collabrunbiz.AdoptionRejected),
		OccurredAtUnixMS: 1_720_000_000_000,
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	catalog := DefaultCatalog()
	if err := catalog.ValidatePublish(
		TopicAgentCollaborationUpdated,
		DirectionServerToClient,
		payload,
	); err != nil {
		t.Fatalf("ValidatePublish() error = %v, want nil", err)
	}
}
