package account

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"path/filepath"
	"testing"
	"time"
)

func TestNewServiceReadsLocalAuthOverrides(t *testing.T) {
	t.Setenv("TUTTI_ACCOUNT_BASE_URL", "http://127.0.0.1:1/api/account")
	t.Setenv("TUTTI_AUTH_LOGIN_URL", "http://127.0.0.1:1/auth/login")
	t.Setenv("TUTTI_ENV", "development")

	service := NewService("")
	if service.AccountBaseURL != "http://127.0.0.1:1/api/account" {
		t.Fatalf("AccountBaseURL = %q", service.AccountBaseURL)
	}
	if service.AuthLoginURL != "http://127.0.0.1:1/auth/login" {
		t.Fatalf("AuthLoginURL = %q", service.AuthLoginURL)
	}
	if service.AppCallbackURL != "tutti-dev://login/callback" {
		t.Fatalf("AppCallbackURL = %q", service.AppCallbackURL)
	}
}

func TestStartLoginOutlivesRequestContext(t *testing.T) {
	service := NewService(filepath.Join(t.TempDir(), "auth.json"))
	ctx, cancel := context.WithCancel(context.Background())
	started, err := service.StartLogin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	time.Sleep(20 * time.Millisecond)

	status, err := service.LoginStatus(started.AttemptID)
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "pending" {
		t.Fatalf("status = %s, want pending", status.Status)
	}

	state := decodeLoginState(t, started.LoginURL)
	body, _ := json.Marshal(map[string]string{
		"state":         "bad",
		"transfer_code": "bad",
	})
	_, _ = http.Post(state.LocalServerOrigin+"/oauth/complete", "application/json", bytes.NewReader(body))
}

type testLoginState struct {
	LocalServerOrigin string `json:"localServerOrigin"`
}

func decodeLoginState(t *testing.T, loginURL string) testLoginState {
	t.Helper()
	u, err := url.Parse(loginURL)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(u.Query().Get("state"))
	if err != nil {
		t.Fatal(err)
	}
	var state testLoginState
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	return state
}
