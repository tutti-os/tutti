package authbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStartLoginCompletesAndWritesAuthJSON(t *testing.T) {
	account := newAccountServer(t)
	defer account.Close()

	client := newTestClient(t, account.URL)
	attempt, err := client.StartLogin(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	state := loginState(t, attempt.LoginURL)
	if state.AttemptID != attempt.ID || state.AppID != DefaultAppID {
		t.Fatalf("state = %#v", state)
	}

	healthURL := state.LocalServerOrigin + "/oauth/health?attempt_id=" + state.AttemptID + "&token=" + state.BridgeToken
	healthResp, err := http.Get(healthURL)
	if err != nil {
		t.Fatal(err)
	}
	if healthResp.StatusCode != http.StatusOK {
		t.Fatalf("health status = %d", healthResp.StatusCode)
	}
	if got := healthResp.Header.Get("Access-Control-Allow-Private-Network"); got != "true" {
		t.Fatalf("private network cors header = %q", got)
	}
	_ = healthResp.Body.Close()

	body, _ := json.Marshal(map[string]string{
		"state":         attempt.state,
		"transfer_code": "transfer-1",
	})
	completeResp, err := http.Post(state.LocalServerOrigin+"/oauth/complete", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if completeResp.StatusCode != http.StatusOK {
		t.Fatalf("complete status = %d", completeResp.StatusCode)
	}
	_ = completeResp.Body.Close()

	waitForStatus(t, attempt, statusCompleted)

	session, err := client.ReadSession()
	if err != nil {
		t.Fatal(err)
	}
	if session == nil || session.SessionID != "session-1" || session.UserID != "user-1" {
		t.Fatalf("session = %#v", session)
	}
}

func TestCompleteRejectsInvalidState(t *testing.T) {
	account := newAccountServer(t)
	defer account.Close()

	client := newTestClient(t, account.URL)
	attempt, err := client.StartLogin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	state := loginState(t, attempt.LoginURL)
	body, _ := json.Marshal(map[string]string{
		"state":         "bad",
		"transfer_code": "transfer-1",
	})
	resp, err := http.Post(state.LocalServerOrigin+"/oauth/complete", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("complete status = %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
	waitForStatus(t, attempt, statusFailed)
}

func TestCompleteRejectsMismatchedStateOrigin(t *testing.T) {
	account := newAccountServer(t)
	defer account.Close()

	client := newTestClient(t, account.URL)
	attempt, err := client.StartLogin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	state := loginState(t, attempt.LoginURL)
	tampered := state
	tampered.LocalServerOrigin = "http://127.0.0.1:1"
	tamperedState, err := encodeBridgeState(tampered)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{
		"state":         tamperedState,
		"transfer_code": "transfer-1",
	})
	resp, err := http.Post(state.LocalServerOrigin+"/oauth/complete", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("complete status = %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
	waitForStatus(t, attempt, statusFailed)
}

func TestGetUserInfoAndLogout(t *testing.T) {
	account := newAccountServer(t)
	defer account.Close()

	client := newTestClient(t, account.URL)
	err := client.writeAuthJSON(sessionFromUser("session-1", UserInfo{UserID: "old"}))
	if err != nil {
		t.Fatal(err)
	}
	user, err := client.GetUserInfo(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if user == nil || user.UserID != "user-1" || user.Email != "user@example.com" {
		t.Fatalf("user = %#v", user)
	}
	if err := client.Logout(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(client.config.AuthJSONPath); !os.IsNotExist(err) {
		t.Fatalf("auth json stat error = %v, want not exist", err)
	}
}

func newTestClient(t *testing.T, accountBaseURL string) *Client {
	t.Helper()
	client, err := NewClient(Config{
		AccountBaseURL: accountBaseURL,
		AppCallbackURL: "tutti://login/callback",
		AuthJSONPath:   filepath.Join(t.TempDir(), "account", "auth.json"),
		AuthLoginURL:   "https://tutti.sh/auth/login",
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func newAccountServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/auth/v1/redeem_desktop_transfer_code":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 0,
				"data": map[string]string{"session_id": "session-1"},
			})
		case "/user/v1/user_info":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 0,
				"data": map[string]string{
					"user_id": "user-1",
					"name":    "Tutti User",
					"email":   "user@example.com",
					"avatar":  "https://example.com/avatar.png",
				},
			})
		case "/auth/v1/logout-web-session":
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{}})
		default:
			t.Fatalf("unexpected account path %s", r.URL.Path)
		}
	}))
}

func loginState(t *testing.T, loginURL string) bridgeState {
	t.Helper()
	u, err := url.Parse(loginURL)
	if err != nil {
		t.Fatal(err)
	}
	state, err := decodeBridgeState(u.Query().Get("state"))
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func waitForStatus(t *testing.T, attempt *LoginAttempt, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if got := attempt.Status().Status; got == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("status = %s, want %s", attempt.Status().Status, want)
}
