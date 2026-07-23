package mobileremote

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHTTPControlPlaneRegistersDeviceWithAccountCookie(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/desktop/v1/devices/current" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Cookie") != "session=cookie" {
			t.Fatalf("unexpected cookie: %q", r.Header.Get("Cookie"))
		}
		var body userDeviceRegistrationWire
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.DeviceID != "desktop-device" ||
			base64.StdEncoding.EncodeToString(body.PublicIdentity.PublicKey) != "a2V5" ||
			base64.StdEncoding.EncodeToString(body.PublicIdentity.Proof) != "cHJvb2Y=" {
			t.Fatalf("unexpected registration body: %+v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"device":{"userDeviceId":"user-device-1","deviceId":"desktop-device"}}`))
	}))
	defer server.Close()

	client := HTTPControlPlane{BaseURL: server.URL + "/api/desktop/v1", HTTPClient: server.Client()}
	registered, err := client.RegisterDevice(context.Background(), "session=cookie", RegisterDeviceInput{
		DeviceID: "desktop-device", Algorithm: "ed25519", PublicKey: []byte("key"), Proof: []byte("proof"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if registered.UserDeviceID != "user-device-1" || registered.DeviceID != "desktop-device" {
		t.Fatalf("unexpected registered device: %+v", registered)
	}
}

func TestHTTPControlPlaneListsAndUpdatesDeviceLinkAttempts(t *testing.T) {
	t.Parallel()
	listSignature := []byte("list-proof")
	updateSignature := []byte("update-proof")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/desktop/v1/device-pairings/pairing-1/device-link-attempts":
			if got := r.URL.Query().Get("deviceId"); got != "desktop-device" {
				t.Fatalf("unexpected device id: %q", got)
			}
			if got := r.URL.Query().Get("identitySignature"); got != base64.RawURLEncoding.EncodeToString(listSignature) {
				t.Fatalf("unexpected list signature: %q", got)
			}
			_, _ = w.Write([]byte(`{"attempts":[{
				"attemptId":"attempt-1","scopeId":"pairing-1",
				"callerDeviceId":"phone-device","callerFingerprint":"caller-fingerprint",
				"callerIce":{"ufrag":"caller-u","pwd":"caller-p","candidates":["candidate-1"]},
				"callerProtocolVersion":2,"ownerDeviceId":"desktop-device",
				"ownerFingerprint":"","ownerIce":null,"ownerProtocolVersion":0,
				"state":"awaiting_owner","stunEndpoints":["stun:example.com:3478"],
				"expiresAt":"2026-07-23T10:05:00Z"
			}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/desktop/v1/device-pairings/pairing-1/device-link-attempts/attempt-1/participant":
			if got := r.URL.Query().Get("deviceId"); got != "desktop-device" {
				t.Fatalf("unexpected device id: %q", got)
			}
			var body struct {
				EphemeralFingerprint string              `json:"ephemeralFingerprint"`
				Candidates           []string            `json:"candidates"`
				ProtocolVersion      int                 `json:"protocolVersion"`
				ICE                  DeviceLinkICEParams `json:"ice"`
				IdentitySignature    []byte              `json:"identitySignature"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.EphemeralFingerprint != "owner-fingerprint" || body.ProtocolVersion != 2 ||
				body.ICE.Ufrag != "owner-u" || body.ICE.Pwd != "owner-p" ||
				len(body.Candidates) != 0 || string(body.IdentitySignature) != string(updateSignature) {
				t.Fatalf("unexpected participant body: %+v", body)
			}
			_, _ = w.Write([]byte(`{"attempt":{
				"attemptId":"attempt-1","scopeId":"pairing-1",
				"callerDeviceId":"phone-device","callerFingerprint":"caller-fingerprint",
				"callerIce":{"ufrag":"caller-u","pwd":"caller-p","candidates":["candidate-1"]},
				"callerProtocolVersion":2,"ownerDeviceId":"desktop-device",
				"ownerFingerprint":"owner-fingerprint",
				"ownerIce":{"ufrag":"owner-u","pwd":"owner-p","candidates":["candidate-2"]},
				"ownerProtocolVersion":2,"state":"ready",
				"stunEndpoints":["stun:example.com:3478"],"expiresAt":"2026-07-23T10:05:00Z"
			}}`))
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.String())
		}
	}))
	defer server.Close()

	client := HTTPControlPlane{BaseURL: server.URL + "/api/desktop/v1", HTTPClient: server.Client()}
	attempts, err := client.ListDeviceLinkAttempts(
		context.Background(), "session=cookie", "pairing-1", "desktop-device", listSignature,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 1 || attempts[0].AttemptID != "attempt-1" ||
		attempts[0].CallerICE == nil || attempts[0].CallerICE.Candidates[0] != "candidate-1" {
		t.Fatalf("unexpected attempts: %+v", attempts)
	}
	updated, err := client.UpdateDeviceLinkParticipant(
		context.Background(), "session=cookie", "pairing-1", "attempt-1", "desktop-device",
		DeviceLinkParticipantInput{
			Fingerprint: "owner-fingerprint", ProtocolVersion: 2,
			ICE:               DeviceLinkICEParams{Ufrag: "owner-u", Pwd: "owner-p", Candidates: []string{"candidate-2"}},
			IdentitySignature: updateSignature,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if updated.State != "ready" || updated.OwnerICE == nil || updated.OwnerFingerprint != "owner-fingerprint" {
		t.Fatalf("unexpected updated attempt: %+v", updated)
	}
}

func TestHTTPControlPlaneDoesNotExposeRemoteErrorBody(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"internal":"secret-leak"}`))
	}))
	defer server.Close()

	client := HTTPControlPlane{BaseURL: server.URL, HTTPClient: server.Client()}
	_, err := client.ListPairings(context.Background(), "session=cookie")
	if err == nil {
		t.Fatal("expected request failure")
	}
	if strings.Contains(err.Error(), "secret-leak") {
		t.Fatalf("remote response leaked into error: %v", err)
	}
}
