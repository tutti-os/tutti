package api

import (
	"encoding/json"
	"testing"
	"time"

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
		"payload":{"preferences":{"defaultAgentProvider":"codex","dockIconStyle":"default","dockPlacement":"bottom","locale":"en","sleepPreventionMode":"never","themeSource":"system","updateChannel":"stable","updatePolicy":"prompt"}}
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
		"payload":{"preferences":{"defaultAgentProvider":"codex","dockIconStyle":"default","dockPlacement":"bottom","locale":"en","sleepPreventionMode":"never","themeSource":"system","updateChannel":"stable","updatePolicy":"prompt"}},
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
			"preferences":{"defaultAgentProvider":"codex","dockIconStyle":"default","locale":"en",
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
		"payload":{"preferences":{"defaultAgentProvider":"codex","dockIconStyle":"default","dockPlacement":"bottom","locale":"en","sleepPreventionMode":"never","themeSource":"system","updateChannel":"stable","updatePolicy":"prompt"}}
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
		"payload":{"preferences":{"defaultAgentProvider":"codex","dockIconStyle":"default","dockPlacement":"bottom","locale":"en","sleepPreventionMode":"never","themeSource":"system","updateChannel":"stable","updatePolicy":"prompt"}}
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
		"payload":{"preferences":{"defaultAgentProvider":"codex","dockIconStyle":"default","dockPlacement":"bottom","locale":"en","sleepPreventionMode":"never","themeSource":"system","updateChannel":"stable","updatePolicy":"prompt"}}
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
		"payload":{"preferences":{"defaultAgentProvider":"codex","dockIconStyle":"default","dockPlacement":"bottom","locale":"en","sleepPreventionMode":"never","themeSource":"system","updateChannel":"stable","updatePolicy":"prompt"}}
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
		"payload":{"preferences":{"defaultAgentProvider":"codex","dockIconStyle":"default","dockPlacement":"bottom","locale":"en","sleepPreventionMode":"never","themeSource":"system","updateChannel":"stable","updatePolicy":"prompt"}}
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

	rawPayload, err := json.Marshal(eventprotocol.PreferencesDesktopUpdateRequestedPayload{
		Preferences: eventprotocol.PreferencesDesktopPreferences{
			DockPlacement:       "bottom",
			Locale:              "en",
			SleepPreventionMode: "never",
			ThemeSource:         "system",
			UpdateChannel:       "stable",
			UpdatePolicy:        "prompt",
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
