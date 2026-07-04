package eventstream

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	preferencesservice "github.com/tutti-os/tutti/services/tuttid/service/preferences"
)

type preferencesMutatorStub struct {
	inputs []preferencesservice.PutInput
	result preferencesbiz.DesktopPreferences
}

func (s *preferencesMutatorStub) Put(_ context.Context, input preferencesservice.PutInput) (preferencesbiz.DesktopPreferences, error) {
	s.inputs = append(s.inputs, input)
	return s.result, nil
}

func TestServiceSubscribeRejectsIntentOnlyTopic(t *testing.T) {
	t.Parallel()

	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	t.Cleanup(func() {
		service.CloseSession(session)
	})

	err := service.Subscribe(session, []string{TopicPreferencesDesktopUpdateRequested}, EventScope{})
	if err == nil {
		t.Fatal("Subscribe() error = nil, want invalid direction")
	}

	validationErr, ok := err.(*ValidationError)
	if !ok {
		t.Fatalf("Subscribe() error type = %T, want *ValidationError", err)
	}
	if validationErr.Code != ValidationCodeInvalidDirection {
		t.Fatalf("Subscribe() code = %q, want %q", validationErr.Code, ValidationCodeInvalidDirection)
	}
}

func TestServicePublishRejectsInvalidPayload(t *testing.T) {
	t.Parallel()

	service := NewService(DefaultCatalog(), nil)

	err := service.PublishFromClient(context.Background(), ClientEvent{
		Topic:   TopicPreferencesDesktopUpdateRequested,
		Payload: []byte(`{"preferences":{"agentComposerDefaultsByProvider":{},"agentGuiConversationRailCollapsedByProvider":{},"agentConversationDetailMode":"coding","agentDockLayout":"legacySplit","appCatalogChannel":"production","defaultAgentProvider":"codex","dockIconStyle":"default","dockPlacement":"bottom","locale":"fr","sleepPreventionMode":"never","themeSource":"dark","updateChannel":"stable","updatePolicy":"prompt"}}`),
	})
	if err == nil {
		t.Fatal("PublishFromClient() error = nil, want invalid payload")
	}

	validationErr, ok := err.(*ValidationError)
	if !ok {
		t.Fatalf("PublishFromClient() error type = %T, want *ValidationError", err)
	}
	if validationErr.Code != ValidationCodeInvalidPayload {
		t.Fatalf("PublishFromClient() code = %q, want %q", validationErr.Code, ValidationCodeInvalidPayload)
	}
}

func TestServicePublishRejectsInvalidAgentDockLayout(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		payload string
		want    string
	}{
		{
			name:    "missing",
			payload: `{"preferences":{"agentComposerDefaultsByProvider":{},"agentGuiConversationRailCollapsedByProvider":{},"agentConversationDetailMode":"coding","appCatalogChannel":"production","defaultAgentProvider":"codex","dockIconStyle":"default","dockPlacement":"bottom","locale":"zh-CN","minimizeAnimation":"scale","sleepPreventionMode":"never","themeSource":"dark","updateChannel":"stable","updatePolicy":"prompt"}}`,
			want:    "preferences.agentDockLayout is required",
		},
		{
			name:    "unsupported",
			payload: `{"preferences":{"agentComposerDefaultsByProvider":{},"agentGuiConversationRailCollapsedByProvider":{},"agentConversationDetailMode":"coding","agentDockLayout":"stacked","appCatalogChannel":"production","defaultAgentProvider":"codex","dockIconStyle":"default","dockPlacement":"bottom","locale":"zh-CN","minimizeAnimation":"scale","sleepPreventionMode":"never","themeSource":"dark","updateChannel":"stable","updatePolicy":"prompt"}}`,
			want:    "preferences.agentDockLayout is unsupported",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			service := NewService(DefaultCatalog(), nil)
			err := service.PublishFromClient(context.Background(), ClientEvent{
				Topic:   TopicPreferencesDesktopUpdateRequested,
				Payload: []byte(tt.payload),
			})
			if err == nil {
				t.Fatal("PublishFromClient() error = nil, want invalid payload")
			}
			validationErr, ok := err.(*ValidationError)
			if !ok {
				t.Fatalf("PublishFromClient() error type = %T, want *ValidationError", err)
			}
			if validationErr.Code != ValidationCodeInvalidPayload {
				t.Fatalf("PublishFromClient() code = %q, want %q", validationErr.Code, ValidationCodeInvalidPayload)
			}
			if !strings.Contains(validationErr.Message, tt.want) {
				t.Fatalf("PublishFromClient() message = %q, want containing %q", validationErr.Message, tt.want)
			}
		})
	}
}

func TestAgentActivityUpdatedValidationRejectsSchemaDrift(t *testing.T) {
	t.Parallel()

	catalog := DefaultCatalog()
	tests := []struct {
		name    string
		payload string
	}{
		{
			name: "missing message latestVersion",
			payload: `{
				"workspaceId":"workspace-1",
				"agentSessionId":"agent-session-1",
				"eventType":"message_update",
				"data":{
					"workspaceId":"workspace-1",
					"agentSessionId":"agent-session-1",
					"eventType":"message_update",
					"acceptedCount":1,
					"messages":[{
						"agentSessionId":"agent-session-1",
						"id":1,
						"kind":"text",
						"messageId":"message-1",
						"payload":{},
						"role":"assistant",
						"version":1
					}]
				}
			}`,
		},
		{
			name: "missing message id",
			payload: `{
				"workspaceId":"workspace-1",
				"agentSessionId":"agent-session-1",
				"eventType":"message_update",
				"data":{
					"workspaceId":"workspace-1",
					"agentSessionId":"agent-session-1",
					"eventType":"message_update",
					"latestVersion":1,
					"acceptedCount":1,
					"messages":[{
						"agentSessionId":"agent-session-1",
						"kind":"text",
						"messageId":"message-1",
						"payload":{},
						"role":"assistant",
						"version":1
					}]
				}
			}`,
		},
		{
			name: "unknown state patch field",
			payload: `{
				"workspaceId":"workspace-1",
				"agentSessionId":"agent-session-1",
				"eventType":"state_patch",
				"data":{
					"workspaceId":"workspace-1",
					"agentSessionId":"agent-session-1",
					"eventType":"state_patch",
					"lastEventUnixMs":1,
					"unexpected":true
				}
			}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			err := catalog.ValidatePublish(
				TopicAgentActivityUpdated,
				DirectionServerToClient,
				[]byte(tt.payload),
			)
			if err == nil {
				t.Fatal("ValidatePublish() error = nil, want invalid payload")
			}
			validationErr, ok := err.(*ValidationError)
			if !ok {
				t.Fatalf("ValidatePublish() error type = %T, want *ValidationError", err)
			}
			if validationErr.Code != ValidationCodeInvalidPayload {
				t.Fatalf("ValidatePublish() code = %q, want %q", validationErr.Code, ValidationCodeInvalidPayload)
			}
		})
	}
}

func TestAgentActivityUpdatedValidationAcceptsAgentTargetID(t *testing.T) {
	t.Parallel()

	catalog := DefaultCatalog()
	tests := []struct {
		name    string
		payload string
	}{
		{
			name: "session update",
			payload: `{
				"workspaceId":"workspace-1",
				"agentSessionId":"agent-session-1",
				"agentTargetId":"local:codex",
				"eventType":"session_update",
				"data":{
					"workspaceId":"workspace-1",
					"agentSessionId":"agent-session-1",
					"agentTargetId":"local:codex",
					"eventType":"session_update",
					"lastEventUnixMs":1
				}
			}`,
		},
		{
			name: "state patch",
			payload: `{
				"workspaceId":"workspace-1",
				"agentSessionId":"agent-session-1",
				"agentTargetId":"local:codex",
				"eventType":"state_patch",
				"data":{
					"workspaceId":"workspace-1",
					"agentSessionId":"agent-session-1",
					"eventType":"state_patch",
					"lastEventUnixMs":1,
					"provider":"codex",
					"agentTargetId":"local:codex"
				}
			}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			if err := catalog.ValidatePublish(
				TopicAgentActivityUpdated,
				DirectionServerToClient,
				[]byte(tt.payload),
			); err != nil {
				t.Fatalf("ValidatePublish() error = %v", err)
			}
		})
	}
}

func TestPreferencesIntentHandlerUsesAuthoritativeMutationPath(t *testing.T) {
	t.Parallel()

	service := NewService(DefaultCatalog(), nil)
	mutator := &preferencesMutatorStub{
		result: preferencesbiz.DesktopPreferences{
			AgentGUIConversationRailCollapsedByProvider: map[string]bool{"codex": true},
			AgentConversationDetailMode:                 "coding",
			AppCatalogChannel:                           "staging",
			DefaultAgentProvider:                        "codex",

			DockIconStyle:       "flat",
			DockPlacement:       "bottom",
			Initialized:         true,
			Locale:              "zh-CN",
			MinimizeAnimation:   "scale",
			SleepPreventionMode: "whileAgentRunning",
			ThemeSource:         "dark",
			UpdateChannel:       "rc",
			UpdatePolicy:        "auto",
		},
	}

	session := service.OpenSession()
	t.Cleanup(func() {
		service.CloseSession(session)
	})
	if err := service.Subscribe(session, []string{TopicPreferencesDesktopUpdated}, EventScope{}); err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}

	service.RegisterIntentHandler(
		TopicPreferencesDesktopUpdateRequested,
		NewPreferencesDesktopUpdateRequestedHandler(mutator),
	)

	if err := service.PublishFromClient(context.Background(), ClientEvent{
		Topic:   TopicPreferencesDesktopUpdateRequested,
		Payload: []byte(`{"preferences":{"agentComposerDefaultsByProvider":{},"agentGuiConversationRailCollapsedByProvider":{"codex":true},"agentConversationDetailMode":"coding","agentDockLayout":"unified","appCatalogChannel":"staging","defaultAgentProvider":"codex","dockIconStyle":"flat","dockPlacement":"left","locale":"zh-CN","minimizeAnimation":"scale","sleepPreventionMode":"never","themeSource":"dark","updateChannel":"rc","updatePolicy":"auto"}}`),
	}); err != nil {
		t.Fatalf("PublishFromClient() error = %v", err)
	}

	if len(mutator.inputs) != 1 {
		t.Fatalf("mutator inputs = %d, want 1", len(mutator.inputs))
	}
	if mutator.inputs[0].DockPlacement != "left" ||
		mutator.inputs[0].AgentDockLayout != "unified" ||
		mutator.inputs[0].AppCatalogChannel != "staging" ||
		mutator.inputs[0].DockIconStyle != "flat" ||
		mutator.inputs[0].Locale != "zh-CN" ||
		mutator.inputs[0].MinimizeAnimation != "scale" ||
		mutator.inputs[0].ThemeSource != "dark" ||
		mutator.inputs[0].UpdateChannel != "rc" ||
		mutator.inputs[0].UpdatePolicy != "auto" {
		t.Fatalf("mutator input = %#v, want staging/flat/left/zh-CN/dark/rc/auto", mutator.inputs[0])
	}
	if !mutator.inputs[0].AgentGUIConversationRailCollapsedByProvider["codex"] {
		t.Fatalf("mutator rail preference = %#v, want codex true", mutator.inputs[0].AgentGUIConversationRailCollapsedByProvider)
	}
	if mutator.inputs[0].WindowSnapping != nil {
		t.Fatalf("mutator window snapping = %#v, want nil", mutator.inputs[0].WindowSnapping)
	}
}

func TestPreferencesIntentHandlerPassesWindowSnappingWhenProvided(t *testing.T) {
	t.Parallel()

	service := NewService(DefaultCatalog(), nil)
	mutator := &preferencesMutatorStub{}

	service.RegisterIntentHandler(
		TopicPreferencesDesktopUpdateRequested,
		NewPreferencesDesktopUpdateRequestedHandler(mutator),
	)

	if err := service.PublishFromClient(context.Background(), ClientEvent{
		Topic:   TopicPreferencesDesktopUpdateRequested,
		Payload: []byte(`{"preferences":{"agentComposerDefaultsByProvider":{},"agentGuiConversationRailCollapsedByProvider":{"codex":true},"agentConversationDetailMode":"coding","agentDockLayout":"unified","appCatalogChannel":"staging","defaultAgentProvider":"codex","dockIconStyle":"flat","dockPlacement":"left","locale":"zh-CN","minimizeAnimation":"scale","sleepPreventionMode":"never","themeSource":"dark","updateChannel":"rc","updatePolicy":"auto","workbenchWindowSnapping":{"enabled":false,"shortcutPreset":"commandArrows"}}}`),
	}); err != nil {
		t.Fatalf("PublishFromClient() error = %v", err)
	}

	if len(mutator.inputs) != 1 {
		t.Fatalf("mutator inputs = %d, want 1", len(mutator.inputs))
	}
	if mutator.inputs[0].WindowSnapping == nil {
		t.Fatal("mutator window snapping = nil, want value")
	}
	if mutator.inputs[0].WindowSnapping.Enabled {
		t.Fatal("mutator window snapping enabled = true, want false")
	}
	if mutator.inputs[0].WindowSnapping.ShortcutPreset != "commandArrows" {
		t.Fatalf("mutator window snapping shortcut = %q, want commandArrows", mutator.inputs[0].WindowSnapping.ShortcutPreset)
	}
}

func TestDesktopPreferencesPublisherIncludesDockIconStyle(t *testing.T) {
	t.Parallel()

	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	t.Cleanup(func() {
		service.CloseSession(session)
	})
	if err := service.Subscribe(session, []string{TopicPreferencesDesktopUpdated}, EventScope{}); err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}

	publisher := DesktopPreferencesPublisher{Service: service}
	if err := publisher.PublishDesktopPreferencesUpdated(context.Background(), preferencesbiz.DesktopPreferences{
		AgentGUIConversationRailCollapsedByProvider: map[string]bool{"codex": true},
		AgentConversationDetailMode:                 "coding",
		AppCatalogChannel:                           "staging",
		DefaultAgentProvider:                        "codex",
		DockIconStyle:                               "flat",
		DockPlacement:                               "bottom",
		Initialized:                                 true,
		Locale:                                      "zh-CN",
		MinimizeAnimation:                           "scale",
		SleepPreventionMode:                         "never",
		ThemeSource:                                 "dark",
		UpdateChannel:                               "stable",
		UpdatePolicy:                                "prompt",
	}); err != nil {
		t.Fatalf("PublishDesktopPreferencesUpdated() error = %v", err)
	}

	event := receiveEvent(t, session)
	var payload desktopPreferencesUpdatedPayload
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatalf("decode published event payload: %v", err)
	}
	if payload.Preferences.DockIconStyle != "flat" {
		t.Fatalf("published dock icon style = %q, want flat", payload.Preferences.DockIconStyle)
	}
	if payload.Preferences.AppCatalogChannel != "staging" {
		t.Fatalf("published app catalog channel = %q, want staging", payload.Preferences.AppCatalogChannel)
	}
	if !payload.Preferences.AgentGUIConversationRailCollapsedByProvider["codex"] {
		t.Fatalf("published rail preference = %#v, want codex true", payload.Preferences.AgentGUIConversationRailCollapsedByProvider)
	}
}

// TestClosedSessionRejectsFurtherEnqueueWithoutPanic moved to stream-go
// (it exercises the registry's unexported enqueue path).

func TestServiceFiltersScopedSubscriptions(t *testing.T) {
	t.Parallel()

	service := NewService(DefaultCatalog(), nil)
	scopedSession := service.OpenSession()
	otherScopedSession := service.OpenSession()
	unscopedSession := service.OpenSession()
	t.Cleanup(func() {
		service.CloseSession(scopedSession)
		service.CloseSession(otherScopedSession)
		service.CloseSession(unscopedSession)
	})

	if err := service.Subscribe(scopedSession, []string{TopicPreferencesDesktopUpdated}, EventScope{WorkspaceID: "workspace-1"}); err != nil {
		t.Fatalf("Subscribe(scoped) error = %v", err)
	}
	if err := service.Subscribe(otherScopedSession, []string{TopicPreferencesDesktopUpdated}, EventScope{WorkspaceID: "workspace-2"}); err != nil {
		t.Fatalf("Subscribe(other scoped) error = %v", err)
	}
	if err := service.Subscribe(unscopedSession, []string{TopicPreferencesDesktopUpdated}, EventScope{}); err != nil {
		t.Fatalf("Subscribe(unscoped) error = %v", err)
	}

	if err := service.PublishFromServerScoped(
		context.Background(),
		TopicPreferencesDesktopUpdated,
		[]byte(`{"initialized":true,"preferences":{"agentComposerDefaultsByProvider":{},"agentGuiConversationRailCollapsedByProvider":{},"agentConversationDetailMode":"coding","agentDockLayout":"legacySplit","appCatalogChannel":"production","defaultAgentProvider":"codex","dockIconStyle":"default","dockPlacement":"bottom","locale":"zh-CN","minimizeAnimation":"scale","sleepPreventionMode":"never","themeSource":"dark","updateChannel":"stable","updatePolicy":"prompt"}}`),
		EventScope{WorkspaceID: "workspace-1"},
	); err != nil {
		t.Fatalf("PublishFromServerScoped() error = %v", err)
	}

	assertReceivedEvent(t, scopedSession, "workspace-1")
	assertReceivedEvent(t, unscopedSession, "workspace-1")
	assertNoEvent(t, otherScopedSession)
}

func TestAgentActivityPublisherPublishesScopedUpdate(t *testing.T) {
	t.Parallel()

	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	t.Cleanup(func() {
		service.CloseSession(session)
	})
	if err := service.Subscribe(session, []string{TopicAgentActivityUpdated}, EventScope{WorkspaceID: "workspace-1"}); err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}

	publisher := AgentActivityPublisher{Service: service}
	if err := publisher.PublishAgentActivityUpdated(
		context.Background(),
		"workspace-1",
		"agent-session-1",
		"message_update",
		map[string]any{
			"acceptedCount": 1,
			"latestVersion": float64(3),
			"messages": []map[string]any{
				{
					"agentSessionId":   "agent-session-1",
					"id":               float64(3),
					"kind":             "text",
					"messageId":        "message-3",
					"occurredAtUnixMs": float64(3000),
					"payload":          map[string]any{},
					"role":             "assistant",
					"turnId":           "turn-3",
					"version":          float64(3),
				},
			},
		},
	); err != nil {
		t.Fatalf("PublishAgentActivityUpdated() error = %v", err)
	}

	event := receiveEvent(t, session)
	if event.Topic != TopicAgentActivityUpdated {
		t.Fatalf("event topic = %q, want %q", event.Topic, TopicAgentActivityUpdated)
	}
	if event.Scope.WorkspaceID != "workspace-1" {
		t.Fatalf("event scope workspace id = %q, want workspace-1", event.Scope.WorkspaceID)
	}
}

func TestWorkspaceAppPublisherIncludesReferencesState(t *testing.T) {
	t.Parallel()

	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	t.Cleanup(func() {
		service.CloseSession(session)
	})
	if err := service.Subscribe(session, []string{TopicWorkspaceAppUpdated}, EventScope{WorkspaceID: "workspace-1"}); err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}

	publisher := WorkspaceAppPublisher{Service: service}
	if err := publisher.PublishWorkspaceAppUpdated(context.Background(), "workspace-1", workspacebiz.WorkspaceApp{
		Package: workspacebiz.AppPackage{
			AppID:   "docs",
			Version: "1.0.0",
			Manifest: workspacebiz.AppManifest{
				Name:        "Docs",
				Description: "Browse docs",
				References: &workspacebiz.AppManifestReferences{
					ListEndpoint: "/references/list",
				},
			},
		},
		Runtime: workspacebiz.AppRuntimeState{
			Status: workspacebiz.AppRuntimeStatusIdle,
		},
	}); err != nil {
		t.Fatalf("PublishWorkspaceAppUpdated() error = %v", err)
	}

	event := receiveEvent(t, session)
	var payload struct {
		App struct {
			References struct {
				ListSupported bool `json:"listSupported"`
			} `json:"references"`
		} `json:"app"`
	}
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatalf("decode published event payload: %v", err)
	}
	if !payload.App.References.ListSupported {
		t.Fatal("published references.listSupported = false, want true")
	}
}

func TestWorkspaceAppUpdatedValidationRequiresReferencesState(t *testing.T) {
	t.Parallel()

	catalog := DefaultCatalog()
	tests := []struct {
		name    string
		payload string
	}{
		{
			name: "missing references",
			payload: `{"app":{
				"appId":"docs",
				"displayName":"Docs",
				"version":"1.0.0",
				"status":"idle",
				"stateRevision":1,
				"minimizeBehavior":"keep-mounted"
			}}`,
		},
		{
			name: "missing listSupported",
			payload: `{"app":{
				"appId":"docs",
				"displayName":"Docs",
				"version":"1.0.0",
				"status":"idle",
				"stateRevision":1,
				"minimizeBehavior":"keep-mounted",
				"references":{}
			}}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			err := catalog.ValidatePublish(
				TopicWorkspaceAppUpdated,
				DirectionServerToClient,
				[]byte(tt.payload),
			)
			if err == nil {
				t.Fatal("ValidatePublish() error = nil, want invalid payload")
			}
			validationErr, ok := err.(*ValidationError)
			if !ok {
				t.Fatalf("ValidatePublish() error type = %T, want *ValidationError", err)
			}
			if validationErr.Code != ValidationCodeInvalidPayload {
				t.Fatalf("ValidatePublish() code = %q, want %q", validationErr.Code, ValidationCodeInvalidPayload)
			}
		})
	}
}

func TestWorkspaceAppUpdatedValidationAcceptsInstalledPendingRestart(t *testing.T) {
	t.Parallel()

	err := DefaultCatalog().ValidatePublish(
		TopicWorkspaceAppUpdated,
		DirectionServerToClient,
		[]byte(`{"app":{
			"appId":"docs",
			"displayName":"Docs",
			"version":"1.0.0",
			"status":"installed_pending_restart",
			"stateRevision":1,
			"minimizeBehavior":"keep-mounted",
			"references":{"listSupported":false}
		}}`),
	)
	if err != nil {
		t.Fatalf("ValidatePublish() error = %v, want nil", err)
	}
}

func TestWorkspaceIssuePublisherPublishesScopedUpdate(t *testing.T) {
	t.Parallel()

	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	t.Cleanup(func() {
		service.CloseSession(session)
	})
	if err := service.Subscribe(session, []string{TopicWorkspaceIssueUpdated}, EventScope{WorkspaceID: "workspace-1"}); err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}

	publisher := WorkspaceIssuePublisher{Service: service}
	if err := publisher.PublishWorkspaceIssueUpdated(
		context.Background(),
		WorkspaceIssueUpdate{
			WorkspaceID: "workspace-1",
			IssueID:     "issue-1",
			TaskID:      "task-1",
			ChangeKind:  WorkspaceIssueChangeTaskUpdated,
		},
	); err != nil {
		t.Fatalf("PublishWorkspaceIssueUpdated() error = %v", err)
	}

	event := receiveEvent(t, session)
	if event.Topic != TopicWorkspaceIssueUpdated {
		t.Fatalf("event topic = %q, want %q", event.Topic, TopicWorkspaceIssueUpdated)
	}
	if event.Scope.WorkspaceID != "workspace-1" {
		t.Fatalf("event scope workspace id = %q, want workspace-1", event.Scope.WorkspaceID)
	}
}

func assertReceivedEvent(t *testing.T, session *Session, workspaceID string) {
	t.Helper()
	event := receiveEvent(t, session)
	if event.Scope.WorkspaceID != workspaceID {
		t.Fatalf("event scope workspace id = %q, want %q", event.Scope.WorkspaceID, workspaceID)
	}
}

func receiveEvent(t *testing.T, session *Session) PublishedEvent {
	t.Helper()
	select {
	case event := <-session.Events():
		return event
	default:
		t.Fatal("event not received")
	}
	return PublishedEvent{}
}

func assertNoEvent(t *testing.T, session *Session) {
	t.Helper()
	select {
	case event := <-session.Events():
		t.Fatalf("unexpected event received: %#v", event)
	default:
	}
}
