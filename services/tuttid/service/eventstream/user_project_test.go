package eventstream

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	eventprotocol "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
)

func TestUserProjectPublisherPublishesCompleteOrderedGlobalSnapshot(t *testing.T) {
	t.Parallel()

	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	t.Cleanup(func() { service.CloseSession(session) })
	if err := service.Subscribe(session, []string{TopicUserProjectUpdated}, EventScope{}); err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}

	publisher := UserProjectPublisher{Service: service}
	if err := publisher.PublishUserProjectUpdated(context.Background(), []userprojectbiz.Project{
		{
			ID:               "project-second",
			Path:             "/workspace/second",
			Label:            "second",
			CreatedAtUnixMS:  10,
			UpdatedAtUnixMS:  20,
			LastUsedAtUnixMS: 30,
			PinnedAtUnixMS:   40,
			SortOrder:        0,
		},
		{
			ID:               "project-first",
			Path:             "/workspace/first",
			Label:            "first",
			CreatedAtUnixMS:  11,
			UpdatedAtUnixMS:  21,
			LastUsedAtUnixMS: 31,
			SortOrder:        1,
		},
	}); err != nil {
		t.Fatalf("PublishUserProjectUpdated() error = %v", err)
	}

	event := receiveEvent(t, session)
	if event.Topic != TopicUserProjectUpdated {
		t.Fatalf("event topic = %q, want %q", event.Topic, TopicUserProjectUpdated)
	}
	if event.Scope.WorkspaceID != "" {
		t.Fatalf("event workspace scope = %q, want global", event.Scope.WorkspaceID)
	}
	if strings.Contains(string(event.Payload), "sortOrder") {
		t.Fatalf("payload exposes daemon-only sortOrder: %s", event.Payload)
	}

	var payload eventprotocol.UserProjectUpdatedPayload
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if len(payload.Projects) != 2 {
		t.Fatalf("projects length = %d, want 2", len(payload.Projects))
	}
	if payload.Projects[0].Id != "project-second" || payload.Projects[1].Id != "project-first" {
		t.Fatalf("project order = [%q, %q], want second then first", payload.Projects[0].Id, payload.Projects[1].Id)
	}
	first := payload.Projects[0]
	if first.SectionKey != "project:/workspace/second" || first.CreatedAtUnixMs != 10 || first.UpdatedAtUnixMs != 20 || first.LastUsedAtUnixMs != 30 || first.PinnedAtUnixMs != 40 {
		t.Fatalf("first project = %#v, want complete generated snapshot", first)
	}
}

func TestUserProjectUpdatedCatalogStrictlyValidatesSnapshot(t *testing.T) {
	t.Parallel()

	validProject := `{
		"id":"project-1",
		"path":"/workspace/one",
		"label":"one",
		"sectionKey":"project:/workspace/one",
			"createdAtUnixMs":0,
			"updatedAtUnixMs":1,
			"lastUsedAtUnixMs":2,
			"pinnedAtUnixMs":3
	}`
	tests := []struct {
		name    string
		payload string
		valid   bool
	}{
		{name: "complete project", payload: `{"projects":[` + validProject + `]}`, valid: true},
		{name: "empty snapshot", payload: `{"projects":[]}`, valid: true},
		{name: "missing projects", payload: `{}`},
		{name: "null projects", payload: `{"projects":null}`},
		{name: "unknown top-level field", payload: `{"projects":[],"workspaceId":"workspace-1"}`},
		{name: "daemon sort order exposed", payload: `{"projects":[` + strings.TrimSuffix(validProject, "}") + `,"sortOrder":0}]}`},
		{name: "blank id", payload: `{"projects":[` + strings.Replace(validProject, `"project-1"`, `" "`, 1) + `]}`},
		{name: "missing timestamp", payload: `{"projects":[` + strings.Replace(validProject, `"createdAtUnixMs":0,`, "", 1) + `]}`},
		{name: "missing pinned timestamp", payload: `{"projects":[` + strings.Replace(validProject, ",\n\t\t\t\"pinnedAtUnixMs\":3", "", 1) + `]}`},
		{name: "negative timestamp", payload: `{"projects":[` + strings.Replace(validProject, `"createdAtUnixMs":0`, `"createdAtUnixMs":-1`, 1) + `]}`},
		{name: "negative pinned timestamp", payload: `{"projects":[` + strings.Replace(validProject, `"pinnedAtUnixMs":3`, `"pinnedAtUnixMs":-1`, 1) + `]}`},
	}

	catalog := DefaultCatalog()
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := catalog.ValidatePublish(TopicUserProjectUpdated, DirectionServerToClient, []byte(test.payload))
			if test.valid && err != nil {
				t.Fatalf("ValidatePublish() error = %v, want nil", err)
			}
			if !test.valid && err == nil {
				t.Fatal("ValidatePublish() error = nil, want invalid payload")
			}
		})
	}
}

func TestUserProjectPublisherWithoutServiceIsNoOp(t *testing.T) {
	t.Parallel()

	if err := (UserProjectPublisher{}).PublishUserProjectUpdated(context.Background(), nil); err != nil {
		t.Fatalf("PublishUserProjectUpdated() error = %v, want nil", err)
	}
}
