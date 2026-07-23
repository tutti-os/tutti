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
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := HTTPControlPlane{BaseURL: server.URL + "/api/desktop/v1", HTTPClient: server.Client()}
	err := client.RegisterDevice(context.Background(), "session=cookie", RegisterDeviceInput{
		DeviceID: "desktop-device", Algorithm: "ed25519", PublicKey: []byte("key"), Proof: []byte("proof"),
	})
	if err != nil {
		t.Fatal(err)
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
