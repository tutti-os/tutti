package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	eventprotocol "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

func validPublishFrameJSON(t *testing.T, eventOverrides string) []byte {
	t.Helper()

	event := `{
		"id":"evt-1",
		"topic":"preferences.desktop.update.requested",
		"version":1,
		"emittedAt":"` + time.Now().UTC().Format(time.RFC3339Nano) + `",
		"payload":{"preferences":{"agentCliUpdateCheckEnabled":true,"agentComposerDefaultsByProvider":{},"agentGuiConversationRailCollapsedByProvider":{},"agentConversationDetailMode":"coding","appCatalogChannel":"production","defaultAgentProvider":"codex","dockIconStyle":"default","dockPlacement":"bottom","locale":"en","sleepPreventionMode":"never","themeSource":"system","updateChannel":"stable","updatePolicy":"prompt","workbenchWindowSnapping":{"enabled":false,"shortcutPreset":"commandArrows"}}}
	}`
	if eventOverrides != "" {
		event = eventOverrides
	}

	return []byte(`{
		"kind":"publish",
		"requestId":"req-1",
		"event":` + event + `
	}`)
}

func TestParseEventStreamClientPublishFrameRejectsUnknownEnvelopeFields(t *testing.T) {
	t.Parallel()

	payload := validPublishFrameJSON(t, `{
		"id":"evt-1",
		"topic":"preferences.desktop.update.requested",
		"version":1,
		"emittedAt":"`+time.Now().UTC().Format(time.RFC3339Nano)+`",
		"payload":{"preferences":{"agentCliUpdateCheckEnabled":true,"agentComposerDefaultsByProvider":{},"agentGuiConversationRailCollapsedByProvider":{},"agentConversationDetailMode":"coding","appCatalogChannel":"production","defaultAgentProvider":"codex","dockIconStyle":"default","dockPlacement":"bottom","locale":"en","sleepPreventionMode":"never","themeSource":"system","updateChannel":"stable","updatePolicy":"prompt","workbenchWindowSnapping":{"enabled":false,"shortcutPreset":"commandArrows"}}},
		"unexpected":"value"
	}`)

	_, _, err := parseEventStreamClientPublishFrame(payload)
	if err == nil {
		t.Fatal("parseEventStreamClientPublishFrame() error = nil, want invalid payload")
	}
}

func TestParseEventStreamClientPublishFrameRejectsUnknownPayloadFields(t *testing.T) {
	t.Parallel()

	payload := validPublishFrameJSON(t, `{
		"id":"evt-1",
		"topic":"preferences.desktop.update.requested",
		"version":1,
		"emittedAt":"`+time.Now().UTC().Format(time.RFC3339Nano)+`",
		"payload":{
			"preferences":{"agentCliUpdateCheckEnabled":true,"agentComposerDefaultsByProvider":{},"agentGuiConversationRailCollapsedByProvider":{},"agentConversationDetailMode":"coding","defaultAgentProvider":"codex","dockIconStyle":"default","locale":"en",
				"themeSource":"system",
				"updateChannel":"stable",
				"updatePolicy":"prompt",
				"unexpected":"value"
			}
		}
	}`)

	_, _, err := parseEventStreamClientPublishFrame(payload)
	if err == nil {
		t.Fatal("parseEventStreamClientPublishFrame() error = nil, want invalid payload")
	}
}

func TestParseEventStreamClientPublishFrameRejectsMissingEventID(t *testing.T) {
	t.Parallel()

	payload := validPublishFrameJSON(t, `{
		"topic":"preferences.desktop.update.requested",
		"version":1,
		"emittedAt":"`+time.Now().UTC().Format(time.RFC3339Nano)+`",
		"payload":{"preferences":{"agentCliUpdateCheckEnabled":true,"agentComposerDefaultsByProvider":{},"agentGuiConversationRailCollapsedByProvider":{},"agentConversationDetailMode":"coding","appCatalogChannel":"production","defaultAgentProvider":"codex","dockIconStyle":"default","dockPlacement":"bottom","locale":"en","sleepPreventionMode":"never","themeSource":"system","updateChannel":"stable","updatePolicy":"prompt","workbenchWindowSnapping":{"enabled":false,"shortcutPreset":"commandArrows"}}}
	}`)

	_, _, err := parseEventStreamClientPublishFrame(payload)
	if err == nil {
		t.Fatal("parseEventStreamClientPublishFrame() error = nil, want invalid payload")
	}
}

func TestParseEventStreamClientPublishFrameRejectsEmptyEventID(t *testing.T) {
	t.Parallel()

	payload := validPublishFrameJSON(t, `{
		"id":"   ",
		"topic":"preferences.desktop.update.requested",
		"version":1,
		"emittedAt":"`+time.Now().UTC().Format(time.RFC3339Nano)+`",
		"payload":{"preferences":{"agentCliUpdateCheckEnabled":true,"agentComposerDefaultsByProvider":{},"agentGuiConversationRailCollapsedByProvider":{},"agentConversationDetailMode":"coding","appCatalogChannel":"production","defaultAgentProvider":"codex","dockIconStyle":"default","dockPlacement":"bottom","locale":"en","sleepPreventionMode":"never","themeSource":"system","updateChannel":"stable","updatePolicy":"prompt","workbenchWindowSnapping":{"enabled":false,"shortcutPreset":"commandArrows"}}}
	}`)

	_, _, err := parseEventStreamClientPublishFrame(payload)
	if err == nil {
		t.Fatal("parseEventStreamClientPublishFrame() error = nil, want invalid payload")
	}
}

func TestParseEventStreamClientPublishFrameRejectsMissingEmittedAt(t *testing.T) {
	t.Parallel()

	payload := validPublishFrameJSON(t, `{
		"id":"evt-1",
		"topic":"preferences.desktop.update.requested",
		"version":1,
		"payload":{"preferences":{"agentCliUpdateCheckEnabled":true,"agentComposerDefaultsByProvider":{},"agentGuiConversationRailCollapsedByProvider":{},"agentConversationDetailMode":"coding","appCatalogChannel":"production","defaultAgentProvider":"codex","dockIconStyle":"default","dockPlacement":"bottom","locale":"en","sleepPreventionMode":"never","themeSource":"system","updateChannel":"stable","updatePolicy":"prompt","workbenchWindowSnapping":{"enabled":false,"shortcutPreset":"commandArrows"}}}
	}`)

	_, _, err := parseEventStreamClientPublishFrame(payload)
	if err == nil {
		t.Fatal("parseEventStreamClientPublishFrame() error = nil, want invalid payload")
	}
}

func TestParseEventStreamClientPublishFrameRejectsInvalidEmittedAt(t *testing.T) {
	t.Parallel()

	payload := validPublishFrameJSON(t, `{
		"id":"evt-1",
		"topic":"preferences.desktop.update.requested",
		"version":1,
		"emittedAt":"not-a-timestamp",
		"payload":{"preferences":{"agentCliUpdateCheckEnabled":true,"agentComposerDefaultsByProvider":{},"agentGuiConversationRailCollapsedByProvider":{},"agentConversationDetailMode":"coding","appCatalogChannel":"production","defaultAgentProvider":"codex","dockIconStyle":"default","dockPlacement":"bottom","locale":"en","sleepPreventionMode":"never","themeSource":"system","updateChannel":"stable","updatePolicy":"prompt","workbenchWindowSnapping":{"enabled":false,"shortcutPreset":"commandArrows"}}}
	}`)

	_, _, err := parseEventStreamClientPublishFrame(payload)
	if err == nil {
		t.Fatal("parseEventStreamClientPublishFrame() error = nil, want invalid payload")
	}
}

func TestParseEventStreamClientPublishFrameRejectsInvalidWorkspaceScope(t *testing.T) {
	t.Parallel()

	payload := validPublishFrameJSON(t, `{
		"id":"evt-1",
		"topic":"preferences.desktop.update.requested",
		"version":1,
		"emittedAt":"`+time.Now().UTC().Format(time.RFC3339Nano)+`",
		"scope":{"workspaceId":"   "},
		"payload":{"preferences":{"agentCliUpdateCheckEnabled":true,"agentComposerDefaultsByProvider":{},"agentGuiConversationRailCollapsedByProvider":{},"agentConversationDetailMode":"coding","appCatalogChannel":"production","defaultAgentProvider":"codex","dockIconStyle":"default","dockPlacement":"bottom","locale":"en","sleepPreventionMode":"never","themeSource":"system","updateChannel":"stable","updatePolicy":"prompt","workbenchWindowSnapping":{"enabled":false,"shortcutPreset":"commandArrows"}}}
	}`)

	_, _, err := parseEventStreamClientPublishFrame(payload)
	if err == nil {
		t.Fatal("parseEventStreamClientPublishFrame() error = nil, want invalid payload")
	}
}

func TestParseEventStreamClientPublishFrameRejectsMissingPayload(t *testing.T) {
	t.Parallel()

	payload := validPublishFrameJSON(t, `{
		"id":"evt-1",
		"topic":"preferences.desktop.update.requested",
		"version":1,
		"emittedAt":"`+time.Now().UTC().Format(time.RFC3339Nano)+`"
	}`)

	_, _, err := parseEventStreamClientPublishFrame(payload)
	if err == nil {
		t.Fatal("parseEventStreamClientPublishFrame() error = nil, want invalid payload")
	}
}

func TestParseEventStreamClientPublishFrameReturnsValidatedClientEvent(t *testing.T) {
	t.Parallel()

	windowSnapping := struct {
		Enabled        bool   `json:"enabled"`
		ShortcutPreset string `json:"shortcutPreset"`
	}{
		Enabled:        false,
		ShortcutPreset: "commandArrows",
	}
	rawPayload, err := json.Marshal(eventprotocol.PreferencesDesktopUpdateRequestedPayload{
		Preferences: eventprotocol.PreferencesDesktopPreferences{
			AgentConversationDetailMode: "coding",
			DockPlacement:               "bottom",
			Locale:                      "en",
			SleepPreventionMode:         "never",
			ThemeSource:                 "system",
			UpdateChannel:               "stable",
			UpdatePolicy:                "prompt",
			WorkbenchWindowSnapping:     &windowSnapping,
		},
	})
	if err != nil {
		t.Fatalf("Marshal payload error = %v", err)
	}

	framePayload, err := json.Marshal(eventprotocol.ClientPublishFrame{
		Kind:      "publish",
		RequestID: "req-1",
		Event: eventprotocol.EventEnvelope{
			ID:        "evt-1",
			Topic:     eventprotocol.TopicPreferencesDesktopUpdateRequested,
			Version:   1,
			EmittedAt: time.Now().UTC().Format(time.RFC3339Nano),
			Payload:   rawPayload,
		},
	})
	if err != nil {
		t.Fatalf("Marshal frame error = %v", err)
	}

	frame, event, err := parseEventStreamClientPublishFrame(framePayload)
	if err != nil {
		t.Fatalf("parseEventStreamClientPublishFrame() error = %v", err)
	}
	if frame.RequestID != "req-1" {
		t.Fatalf("requestId = %q, want req-1", frame.RequestID)
	}
	if event.Topic != eventstreamservice.TopicPreferencesDesktopUpdateRequested {
		t.Fatalf("event topic = %q, want %q", event.Topic, eventstreamservice.TopicPreferencesDesktopUpdateRequested)
	}
	if string(event.Payload) != string(rawPayload) {
		t.Fatalf("event payload = %s, want %s", string(event.Payload), string(rawPayload))
	}
}

func TestEventScopeFromGeneratedPreservesInvalidWhitespace(t *testing.T) {
	t.Parallel()

	workspaceID := "   "
	scope := eventScopeFromGenerated(&eventprotocol.EventScope{
		WorkspaceID: &workspaceID,
	})

	service := eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil)
	session := service.OpenSession()
	t.Cleanup(func() {
		service.CloseSession(session)
	})

	err := service.Subscribe(session, []string{eventstreamservice.TopicPreferencesDesktopUpdated}, scope)
	if err == nil {
		t.Fatal("Subscribe() error = nil, want invalid scope")
	}
}

func TestForwardEventStreamEventsReportsUnexpectedSubscriptionClosure(t *testing.T) {
	t.Parallel()

	service := eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil)
	session := service.OpenSession()
	outbound := make(chan any, 1)
	subscriptionClosed := make(chan struct{}, 1)

	go forwardEventStreamEvents(
		context.Background(),
		service,
		session,
		outbound,
		func() { subscriptionClosed <- struct{}{} },
	)
	service.CloseSession(session)

	select {
	case <-subscriptionClosed:
	case <-time.After(time.Second):
		t.Fatal("subscription closure was not reported")
	}
}

func TestForwardEventStreamEventsIgnoresClosureAfterContextCancellation(t *testing.T) {
	t.Parallel()

	for range 100 {
		service := eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil)
		session := service.OpenSession()
		outbound := make(chan any, 1)
		subscriptionClosed := make(chan struct{}, 1)
		ctx, cancel := context.WithCancel(context.Background())
		forwardingStopped := make(chan struct{})

		go func() {
			defer close(forwardingStopped)
			forwardEventStreamEvents(
				ctx,
				service,
				session,
				outbound,
				func() { subscriptionClosed <- struct{}{} },
			)
		}()
		cancel()
		service.CloseSession(session)
		select {
		case <-forwardingStopped:
		case <-time.After(time.Second):
			t.Fatal("forwarder did not stop after context cancellation")
		}

		select {
		case <-subscriptionClosed:
			t.Fatal("normal context cancellation reported an overflow")
		default:
		}
	}
}

func TestEventStreamWebSocketClosesWhenFanoutSessionEnds(t *testing.T) {
	t.Parallel()

	eventService := &controlledEventStreamService{
		Service: eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil),
		events:  make(chan eventstreamservice.PublishedEvent),
	}
	api := DaemonAPI{EventStreamService: eventService}
	server := httptest.NewServer(http.HandlerFunc(api.attachEventStreamWebSocket))
	t.Cleanup(server.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	socketURL := "ws" + strings.TrimPrefix(server.URL, "http")
	connection, _, err := websocket.Dial(ctx, socketURL, nil)
	if err != nil {
		t.Fatalf("dial event stream: %v", err)
	}
	t.Cleanup(func() {
		_ = connection.Close(websocket.StatusNormalClosure, "test complete")
	})

	_, readyPayload, err := connection.Read(ctx)
	if err != nil {
		t.Fatalf("read ready frame: %v", err)
	}
	var ready eventprotocol.ServerReadyFrame
	if err := json.Unmarshal(readyPayload, &ready); err != nil {
		t.Fatalf("decode ready frame: %v", err)
	}
	if ready.Kind != "ready" {
		t.Fatalf("ready kind = %q", ready.Kind)
	}

	close(eventService.events)
	_, _, err = connection.Read(ctx)
	if status := websocket.CloseStatus(err); status != websocket.StatusTryAgainLater {
		t.Fatalf("close status = %d, want %d; error = %v", status, websocket.StatusTryAgainLater, err)
	}
}

type controlledEventStreamService struct {
	*eventstreamservice.Service
	events chan eventstreamservice.PublishedEvent
}

func (s *controlledEventStreamService) Events(
	*eventstreamservice.Session,
) <-chan eventstreamservice.PublishedEvent {
	return s.events
}
