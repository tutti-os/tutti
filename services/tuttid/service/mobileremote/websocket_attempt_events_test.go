package mobileremote

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestRealtimeEndpointRequiresDeviceIdentity(t *testing.T) {
	if _, err := realtimeEndpoint("ws://localhost:8080/realtime", ""); err == nil {
		t.Fatal("expected missing device identity to fail")
	}
	if _, err := realtimeEndpoint("https://ws.example.test/realtime", "device-1"); err == nil {
		t.Fatal("expected non-websocket scheme to fail")
	}
	endpoint, err := realtimeEndpoint("ws://localhost:8080/realtime?lane=mobile", "device/1")
	if err != nil {
		t.Fatalf("realtime endpoint: %v", err)
	}
	if !strings.Contains(endpoint, "lane=mobile") || !strings.Contains(endpoint, "deviceId=device%2F1") {
		t.Fatalf("endpoint does not preserve query and encode device id: %s", endpoint)
	}
}

func TestParseDeviceLinkAttemptEvent(t *testing.T) {
	payload, err := json.Marshal(deviceLinkAttemptChangedPayload{AttemptID: "attempt-1"})
	if err != nil {
		t.Fatalf("encode payload: %v", err)
	}
	raw, err := json.Marshal(map[string]any{
		"event_type":       deviceLinkAttemptChangedType,
		"payload":          base64.StdEncoding.EncodeToString(payload),
		"protocol_version": websocketProtocolVersion,
	})
	if err != nil {
		t.Fatalf("encode envelope: %v", err)
	}
	attemptID, ok := parseDeviceLinkAttemptEvent(raw)
	if !ok || attemptID != "attempt-1" {
		t.Fatalf("parse event = %q, %v", attemptID, ok)
	}
	if _, ok := parseDeviceLinkAttemptEvent([]byte(`{"event_type":"room.message","protocol_version":2}`)); ok {
		t.Fatal("non-attempt event should be ignored")
	}
}

func TestWebSocketAttemptEventsReadsV2BusinessFrame(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("deviceId"); got != "device-1" {
			t.Errorf("device id = %q", got)
		}
		if got := r.Header.Get("Cookie"); got != "session-cookie" {
			t.Errorf("cookie = %q", got)
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept websocket: %v", err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "test finished")
		readCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_, raw, err := conn.Read(readCtx)
		if err != nil {
			t.Errorf("read initialize: %v", err)
			return
		}
		var initialize struct {
			Action string `json:"action"`
		}
		if err := json.Unmarshal(raw, &initialize); err != nil {
			t.Errorf("decode initialize: %v", err)
			return
		}
		if initialize.Action != "connection.initialize" {
			t.Errorf("initialize action = %q", initialize.Action)
			return
		}
		_, raw, err = conn.Read(readCtx)
		if err != nil {
			t.Errorf("read device init: %v", err)
			return
		}
		var deviceInit struct {
			Action string         `json:"action"`
			Data   map[string]any `json:"data"`
		}
		if err := json.Unmarshal(raw, &deviceInit); err != nil {
			t.Errorf("decode device init: %v", err)
			return
		}
		if deviceInit.Action != "init" || deviceInit.Data["deviceId"] != "device-1" {
			t.Errorf("device init = %#v", deviceInit)
			return
		}
		payload, _ := json.Marshal(deviceLinkAttemptChangedPayload{AttemptID: "attempt-1"})
		envelope, _ := json.Marshal(map[string]any{
			"content_type":     "PAYLOAD_CONTENT_TYPE_JSON",
			"delivery":         map[string]any{"device_id": "device-1", "scope": "user_device"},
			"dispatch_id":      "dispatch-1",
			"event_id":         "event-1",
			"event_type":       deviceLinkAttemptChangedType,
			"payload":          base64.StdEncoding.EncodeToString(payload),
			"protocol_version": websocketProtocolVersion,
			"schema_version":   1,
			"occurred_at":      time.Now().UTC().Format(time.RFC3339Nano),
		})
		if err := conn.Write(context.Background(), websocket.MessageText, envelope); err != nil {
			t.Errorf("write attempt event: %v", err)
			return
		}
		_, _, _ = conn.Read(context.Background())
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := WebSocketAttemptEvents{URL: strings.Replace(server.URL, "http://", "ws://", 1)}
	received := make(chan string, 1)
	result := make(chan error, 1)
	go func() {
		result <- events.Run(ctx, "session-cookie", "device-1", func(attemptID string) {
			received <- attemptID
		})
	}()

	select {
	case attemptID := <-received:
		if attemptID != "attempt-1" {
			t.Fatalf("attempt id = %q", attemptID)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for attempt event")
	}
	cancel()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("event source returned error after cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("event source did not stop after cancellation")
	}
}
