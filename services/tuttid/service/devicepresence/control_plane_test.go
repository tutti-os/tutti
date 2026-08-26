package devicepresence

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPControlPlaneRunsPendingToActiveLifecycle(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		if request.Header.Get("Cookie") != "sid=test" {
			t.Errorf("cookie = %q", request.Header.Get("Cookie"))
		}
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/devices/current":
			_ = json.NewEncoder(writer).Encode(map[string]any{"device": map[string]any{"userDeviceId": "user-device-1", "deviceId": "device-1"}})
		case "/device-presence/sessions":
			_ = json.NewEncoder(writer).Encode(map[string]any{"presenceLeaseId": "lease-1", "userDeviceId": "user-device-1", "heartbeatIntervalSeconds": 30})
		case "/device-presence/sessions/lease-1/heartbeat":
			_ = json.NewEncoder(writer).Encode(map[string]any{"state": "DEVICE_PRESENCE_SESSION_STATE_ACTIVE"})
		case "/device-presence/sessions/lease-1":
			writer.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected path: %s", request.URL.Path)
		}
	}))
	defer server.Close()
	client := &HTTPControlPlane{BaseURL: server.URL}
	if err := client.RegisterCurrentDevice(context.Background(), "sid=test", DeviceMetadata{DeviceID: "device-1"}); err != nil {
		t.Fatal(err)
	}
	lease, err := client.OpenSession(context.Background(), "sid=test", "device-1", "session-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Heartbeat(context.Background(), "sid=test", lease.PresenceLeaseID); err != nil {
		t.Fatal(err)
	}
	if err := client.CloseSession(context.Background(), "sid=test", lease.PresenceLeaseID); err != nil {
		t.Fatal(err)
	}
	if requests != 4 {
		t.Fatalf("requests = %d", requests)
	}
}
