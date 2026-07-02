package integration_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	eventprotocol "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

type eventStreamEnvelopeFrame struct {
	Event eventprotocol.EventEnvelope `json:"event"`
	Kind  string                      `json:"kind"`
}

type eventStreamRawFrame struct {
	Kind    string
	Payload []byte
}

type eventStreamErrorFrame struct {
	Kind      string  `json:"kind"`
	RequestID *string `json:"requestId,omitempty"`
	Code      string  `json:"code"`
	Message   string  `json:"message"`
}

func TestTuttidBlackBoxEventStreamWebSocketRejectsMissingAccessToken(t *testing.T) {
	daemon := startTestDaemon(t)

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	streamURL := "ws" + strings.TrimPrefix(daemon.baseURL, "http") + "/v1/events/ws"

	conn, response, err := websocket.Dial(ctx, streamURL, nil)
	if err == nil {
		_ = conn.Close(websocket.StatusNormalClosure, "test done")
		t.Fatal("websocket Dial() error = nil, want unauthorized failure")
	}
	if response == nil {
		t.Fatalf("websocket response = nil, want HTTP 401; err = %v", err)
	}
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d; err = %v", response.StatusCode, http.StatusUnauthorized, err)
	}
}

func TestTuttidBlackBoxEventStreamWebSocketReadyAndValidation(t *testing.T) {
	daemon := startTestDaemon(t)

	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()

	conn := mustDialEventStream(t, ctx, daemon)
	defer conn.Close(websocket.StatusNormalClosure, "test done")

	ready := readEventStreamReadyFrame(t, ctx, conn)
	if ready.Kind != "ready" {
		t.Fatalf("ready kind = %q, want ready", ready.Kind)
	}
	if ready.ProtocolVersion != eventprotocol.BusinessEventProtocolVersion {
		t.Fatalf("protocolVersion = %d, want %d", ready.ProtocolVersion, eventprotocol.BusinessEventProtocolVersion)
	}
	if ready.CatalogRevision != eventprotocol.BusinessEventCatalogRevision {
		t.Fatalf("catalogRevision = %q, want %q", ready.CatalogRevision, eventprotocol.BusinessEventCatalogRevision)
	}

	writeEventStreamFrame(t, ctx, conn, eventprotocol.ClientPingFrame{
		Kind:      "ping",
		RequestID: "ping-1",
		SentAt:    time.Now().UTC().Format(time.RFC3339Nano),
	})
	pong := readEventStreamPongFrame(t, ctx, conn)
	if pong.Kind != "pong" || pong.RequestID != "ping-1" {
		t.Fatalf("pong = %#v, want pong/ping-1", pong)
	}

	writeEventStreamFrame(t, ctx, conn, eventprotocol.ClientSubscribeFrame{
		Kind:      "subscribe",
		RequestID: "sub-1",
		Topics:    []eventprotocol.Topic{"preferences.desktop.unknown"},
	})
	invalidTopic := readEventStreamErrorFrame(t, ctx, conn)
	assertEventStreamErrorFrame(t, invalidTopic, "sub-1", "invalid_topic")

	writeEventStreamFrame(t, ctx, conn, eventprotocol.ClientSubscribeFrame{
		Kind:      "subscribe",
		RequestID: "sub-2",
		Topics:    []eventprotocol.Topic{eventprotocol.TopicPreferencesDesktopUpdateRequested},
	})
	invalidDirection := readEventStreamErrorFrame(t, ctx, conn)
	assertEventStreamErrorFrame(t, invalidDirection, "sub-2", "invalid_direction")

	writeEventStreamFrame(t, ctx, conn, eventprotocol.ClientPublishFrame{
		Kind:      "publish",
		RequestID: "pub-1",
		Event: eventprotocol.EventEnvelope{
			Topic:   eventprotocol.TopicPreferencesDesktopUpdateRequested,
			Version: 1,
			Payload: mustMarshalRawJSON(t, eventprotocol.PreferencesDesktopUpdateRequestedPayload{
				Preferences: eventprotocol.PreferencesDesktopPreferences{
					AgentConversationDetailMode: "coding",
					DockPlacement:               "bottom",
					Locale:                      "fr",
					MinimizeAnimation:           "scale",
					SleepPreventionMode:         "never",
					ThemeSource:                 "dark",
				},
			}),
		},
	})
	invalidPayload := readEventStreamErrorFrame(t, ctx, conn)
	assertEventStreamErrorFrame(t, invalidPayload, "pub-1", "invalid_payload")

	writeEventStreamPayload(t, ctx, conn, []byte(`{
		"kind":"publish",
		"requestId":"pub-2",
		"event":{
			"topic":"preferences.desktop.update.requested",
			"version":1,
			"payload":{
				"preferences":{"agentComposerDefaultsByProvider":{},"agentGuiConversationRailCollapsedByProvider":{},"defaultAgentProvider":"codex","dockIconStyle":"default","locale":"en-US",
					"themeSource":"system",
					"unexpected":"value"
				}
			}
		}
	}`))
	invalidPayloadShape := readEventStreamErrorFrame(t, ctx, conn)
	assertEventStreamErrorFrame(t, invalidPayloadShape, "pub-2", "invalid_payload")

	writeEventStreamPayload(t, ctx, conn, []byte(`{
		"kind":"publish",
		"requestId":"pub-3",
		"event":{
			"topic":"preferences.desktop.update.requested",
			"version":1,
			"payload":{
				"preferences":{"agentComposerDefaultsByProvider":{},"agentGuiConversationRailCollapsedByProvider":{},"defaultAgentProvider":"codex","dockIconStyle":"default","locale":"en-US",
					"themeSource":"system"
				}
			},
			"unexpected":"value"
		}
	}`))
	invalidEnvelopeShape := readEventStreamErrorFrame(t, ctx, conn)
	assertEventStreamErrorFrame(t, invalidEnvelopeShape, "pub-3", "invalid_payload")
}

func TestTuttidBlackBoxEventStreamPreferenceIntentPublishesUpdatedEvent(t *testing.T) {
	daemon := startTestDaemon(t)

	initialPreferences := mustRequestJSON[tuttigenerated.DesktopPreferencesStateResponse](
		t,
		daemon,
		http.MethodGet,
		"/v1/preferences/desktop",
		nil,
		http.StatusOK,
	)
	if initialPreferences.Initialized {
		t.Fatalf("initial initialized = true, want false")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	conn := mustDialEventStream(t, ctx, daemon)
	defer conn.Close(websocket.StatusNormalClosure, "test done")

	_ = readEventStreamReadyFrame(t, ctx, conn)

	writeEventStreamFrame(t, ctx, conn, eventprotocol.ClientSubscribeFrame{
		Kind:      "subscribe",
		RequestID: "sub-1",
		Topics:    []eventprotocol.Topic{eventprotocol.TopicPreferencesDesktopUpdated},
	})
	subscribeAck := readEventStreamAckFrame(t, ctx, conn)
	if subscribeAck.Kind != "ack" || subscribeAck.RequestID != "sub-1" {
		t.Fatalf("subscribe ack = %#v, want requestId sub-1", subscribeAck)
	}

	writeEventStreamFrame(t, ctx, conn, eventprotocol.ClientPublishFrame{
		Kind:      "publish",
		RequestID: "pub-1",
		Event: eventprotocol.EventEnvelope{
			ID:        "evt-1",
			Topic:     eventprotocol.TopicPreferencesDesktopUpdateRequested,
			Version:   1,
			EmittedAt: time.Now().UTC().Format(time.RFC3339Nano),
			Payload: mustMarshalRawJSON(t, eventprotocol.PreferencesDesktopUpdateRequestedPayload{
				Preferences: eventprotocol.PreferencesDesktopPreferences{
					AgentConversationDetailMode: "general",
					AgentDockLayout:             "unified",
					AppCatalogChannel:           "staging",
					DefaultAgentProvider:        "codex",

					DockIconStyle:       "default",
					DockPlacement:       "bottom",
					Locale:              "zh-CN",
					MinimizeAnimation:   "scale",
					SleepPreventionMode: "whileAgentRunning",
					ThemeSource:         "dark",
					UpdateChannel:       "stable",
					UpdatePolicy:        "prompt",
				},
			}),
		},
	})

	var (
		sawPublishAck bool
		sawUpdated    bool
		updated       eventprotocol.PreferencesDesktopUpdatedPayload
	)

	for !sawPublishAck || !sawUpdated {
		frame := readEventStreamRawFrame(t, ctx, conn)
		switch frame.Kind {
		case "ack":
			ack := decodeEventStreamAckFrame(t, frame)
			if ack.RequestID == "pub-1" {
				sawPublishAck = true
			}
		case "event":
			eventFrame := decodeEventStreamEventFrame(t, frame)
			if eventFrame.Event.Topic != eventprotocol.TopicPreferencesDesktopUpdated {
				continue
			}
			if err := json.Unmarshal(eventFrame.Event.Payload, &updated); err != nil {
				t.Fatalf("Unmarshal updated payload error = %v; payload: %s", err, string(eventFrame.Event.Payload))
			}
			sawUpdated = true
		case "error":
			t.Fatalf("unexpected error frame = %#v", decodeEventStreamErrorFrame(t, frame))
		default:
			t.Fatalf("unexpected frame kind = %q", frame.Kind)
		}
	}

	if !updated.Initialized {
		t.Fatal("updated initialized = false, want true")
	}
	if updated.Preferences.DefaultAgentProvider != "codex" ||
		updated.Preferences.AgentConversationDetailMode != "general" ||
		updated.Preferences.AgentDockLayout != "unified" ||
		updated.Preferences.AppCatalogChannel != "staging" ||
		updated.Preferences.DockPlacement != "bottom" ||
		updated.Preferences.Locale != "zh-CN" ||
		updated.Preferences.ThemeSource != "dark" ||
		updated.Preferences.UpdateChannel != "stable" ||
		updated.Preferences.UpdatePolicy != "prompt" {
		t.Fatalf("updated payload = %#v, want staging/codex/general/unified/bottom/zh-CN/dark/stable/prompt", updated)
	}

	after := mustRequestJSON[tuttigenerated.DesktopPreferencesStateResponse](
		t,
		daemon,
		http.MethodGet,
		"/v1/preferences/desktop",
		nil,
		http.StatusOK,
	)
	if !after.Initialized {
		t.Fatal("stored initialized = false, want true")
	}
	if after.Preferences.Locale != tuttigenerated.ZhCN {
		t.Fatalf("stored locale = %q, want %q", after.Preferences.Locale, tuttigenerated.ZhCN)
	}
	if after.Preferences.DefaultAgentProvider != tuttigenerated.WorkspaceAgentProviderCodex {
		t.Fatalf("stored defaultAgentProvider = %q, want %q", after.Preferences.DefaultAgentProvider, tuttigenerated.WorkspaceAgentProviderCodex)
	}
	if after.Preferences.AgentConversationDetailMode != tuttigenerated.General {
		t.Fatalf("stored agentConversationDetailMode = %q, want %q", after.Preferences.AgentConversationDetailMode, tuttigenerated.General)
	}
	if after.Preferences.AgentDockLayout != tuttigenerated.Unified {
		t.Fatalf("stored agentDockLayout = %q, want %q", after.Preferences.AgentDockLayout, tuttigenerated.Unified)
	}
	if after.Preferences.AppCatalogChannel != tuttigenerated.Staging {
		t.Fatalf("stored appCatalogChannel = %q, want %q", after.Preferences.AppCatalogChannel, tuttigenerated.Staging)
	}
	if after.Preferences.DockPlacement != tuttigenerated.Bottom {
		t.Fatalf("stored dockPlacement = %q, want %q", after.Preferences.DockPlacement, tuttigenerated.Bottom)
	}
	if after.Preferences.ThemeSource != tuttigenerated.DesktopThemeSourceDark {
		t.Fatalf("stored themeSource = %q, want %q", after.Preferences.ThemeSource, tuttigenerated.DesktopThemeSourceDark)
	}
}

func mustDialEventStream(t *testing.T, ctx context.Context, daemon *testDaemon) *websocket.Conn {
	t.Helper()

	streamURL := "ws" +
		strings.TrimPrefix(daemon.baseURL, "http") +
		"/v1/events/ws?access_token=" + daemon.accessToken

	conn, _, err := websocket.Dial(ctx, streamURL, nil)
	if err != nil {
		t.Fatalf("websocket Dial() error = %v", err)
	}
	return conn
}

func mustMarshalRawJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()

	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("Marshal payload error = %v", err)
	}
	return payload
}

func writeEventStreamFrame(t *testing.T, ctx context.Context, conn *websocket.Conn, frame any) {
	t.Helper()

	payload, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("Marshal event stream frame error = %v", err)
	}
	writeEventStreamPayload(t, ctx, conn, payload)
}

func writeEventStreamPayload(t *testing.T, ctx context.Context, conn *websocket.Conn, payload []byte) {
	t.Helper()

	if err := conn.Write(ctx, websocket.MessageText, payload); err != nil {
		t.Fatalf("websocket Write() error = %v", err)
	}
}

func readEventStreamPayload(t *testing.T, ctx context.Context, conn *websocket.Conn) []byte {
	t.Helper()

	_, payload, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("websocket Read() error = %v", err)
	}
	return payload
}

func readEventStreamRawFrame(t *testing.T, ctx context.Context, conn *websocket.Conn) eventStreamRawFrame {
	t.Helper()

	payload := readEventStreamPayload(t, ctx, conn)
	var frame struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(payload, &frame); err != nil {
		t.Fatalf("Unmarshal kind frame error = %v; payload: %s", err, string(payload))
	}
	return eventStreamRawFrame{
		Kind:    frame.Kind,
		Payload: payload,
	}
}

func readEventStreamReadyFrame(t *testing.T, ctx context.Context, conn *websocket.Conn) eventprotocol.ServerReadyFrame {
	t.Helper()

	payload := readEventStreamPayload(t, ctx, conn)
	var frame eventprotocol.ServerReadyFrame
	if err := json.Unmarshal(payload, &frame); err != nil {
		t.Fatalf("Unmarshal ready frame error = %v; payload: %s", err, string(payload))
	}
	return frame
}

func readEventStreamPongFrame(t *testing.T, ctx context.Context, conn *websocket.Conn) eventprotocol.ServerPongFrame {
	t.Helper()

	payload := readEventStreamPayload(t, ctx, conn)
	var frame eventprotocol.ServerPongFrame
	if err := json.Unmarshal(payload, &frame); err != nil {
		t.Fatalf("Unmarshal pong frame error = %v; payload: %s", err, string(payload))
	}
	return frame
}

func readEventStreamAckFrame(t *testing.T, ctx context.Context, conn *websocket.Conn) eventprotocol.ServerAckFrame {
	t.Helper()

	payload := readEventStreamPayload(t, ctx, conn)
	var frame eventprotocol.ServerAckFrame
	if err := json.Unmarshal(payload, &frame); err != nil {
		t.Fatalf("Unmarshal ack frame error = %v; payload: %s", err, string(payload))
	}
	return frame
}

func decodeEventStreamAckFrame(t *testing.T, raw eventStreamRawFrame) eventprotocol.ServerAckFrame {
	t.Helper()
	if raw.Kind != "ack" {
		t.Fatalf("frame kind = %q, want ack", raw.Kind)
	}
	var frame eventprotocol.ServerAckFrame
	if err := json.Unmarshal(raw.Payload, &frame); err != nil {
		t.Fatalf("Unmarshal ack frame error = %v; payload: %s", err, string(raw.Payload))
	}
	return frame
}

func decodeEventStreamEventFrame(t *testing.T, raw eventStreamRawFrame) eventStreamEnvelopeFrame {
	t.Helper()
	if raw.Kind != "event" {
		t.Fatalf("frame kind = %q, want event", raw.Kind)
	}
	var frame eventStreamEnvelopeFrame
	if err := json.Unmarshal(raw.Payload, &frame); err != nil {
		t.Fatalf("Unmarshal event frame error = %v; payload: %s", err, string(raw.Payload))
	}
	return frame
}

func readEventStreamErrorFrame(t *testing.T, ctx context.Context, conn *websocket.Conn) eventStreamErrorFrame {
	t.Helper()

	payload := readEventStreamPayload(t, ctx, conn)
	var frame eventStreamErrorFrame
	if err := json.Unmarshal(payload, &frame); err != nil {
		t.Fatalf("Unmarshal error frame error = %v; payload: %s", err, string(payload))
	}
	return frame
}

func decodeEventStreamErrorFrame(t *testing.T, raw eventStreamRawFrame) eventStreamErrorFrame {
	t.Helper()
	if raw.Kind != "error" {
		t.Fatalf("frame kind = %q, want error", raw.Kind)
	}
	var frame eventStreamErrorFrame
	if err := json.Unmarshal(raw.Payload, &frame); err != nil {
		t.Fatalf("Unmarshal error frame error = %v; payload: %s", err, string(raw.Payload))
	}
	return frame
}

func assertEventStreamErrorFrame(t *testing.T, frame eventStreamErrorFrame, requestID string, code string) {
	t.Helper()

	if frame.Kind != "error" {
		t.Fatalf("frame kind = %q, want error", frame.Kind)
	}
	if frame.RequestID == nil || *frame.RequestID != requestID {
		t.Fatalf("frame requestId = %v, want %q", frame.RequestID, requestID)
	}
	if frame.Code != code {
		t.Fatalf("error code = %q, want %q", frame.Code, code)
	}
}
