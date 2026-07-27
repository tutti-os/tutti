package authbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCallbackCompletesWritesAuthJSONAndRedirectsToWebResult(t *testing.T) {
	account := newAccountServer(t)
	defer account.Close()

	client := newTestClient(t, account.URL)
	attempt, err := client.StartLogin(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	state := loginState(t, attempt.LoginURL)
	callbackURL, err := url.Parse(state.LocalServerOrigin + "/oauth/callback")
	if err != nil {
		t.Fatal(err)
	}
	query := callbackURL.Query()
	query.Set("state", attempt.state)
	query.Set("transfer_code", "transfer-1")
	callbackURL.RawQuery = query.Encode()

	resp, err := noRedirectClient().Get(callbackURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("callback status = %d", resp.StatusCode)
	}
	location := resp.Header.Get("Location")
	resultURL, err := url.Parse(location)
	if err != nil {
		t.Fatal(err)
	}
	if resultURL.String() == "" || resultURL.Scheme != "https" || resultURL.Host != "tutti.sh" || resultURL.Path != "/auth/login/callback" {
		t.Fatalf("redirect location = %q", location)
	}
	if got := resultURL.Query().Get("desktopBridgeStatus"); got != "success" {
		t.Fatalf("desktopBridgeStatus = %q", got)
	}
	if strings.Contains(location, "transfer-1") || strings.Contains(location, "desktop-session-1") {
		t.Fatalf("redirect leaked sensitive value: %s", location)
	}
	openAppURL := resultURL.Query().Get("openAppUrl")
	if openAppURL == "" {
		t.Fatal("openAppUrl is missing")
	}
	parsedOpenAppURL, err := url.Parse(openAppURL)
	if err != nil {
		t.Fatal(err)
	}
	if parsedOpenAppURL.Scheme != "tutti" || parsedOpenAppURL.Query().Get("desktopBridgeStatus") != "success" {
		t.Fatalf("openAppUrl = %q", openAppURL)
	}

	waitForStatus(t, attempt, statusCompleted)
	session, err := client.ReadSession()
	if err != nil {
		t.Fatal(err)
	}
	if session == nil || session.SessionID != "desktop-session-1" || session.UserID != "user-1" {
		t.Fatalf("session = %#v", session)
	}
}

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
	if session == nil || session.SessionID != "desktop-session-1" || session.UserID != "user-1" {
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

func TestCompletePreservesUserCancellation(t *testing.T) {
	account := newAccountServer(t)
	defer account.Close()

	client := newTestClient(t, account.URL)
	attempt, err := client.StartLogin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	state := loginState(t, attempt.LoginURL)
	body, _ := json.Marshal(map[string]string{
		"state": attempt.state,
		"error": "user_cancelled",
	})
	resp, err := http.Post(state.LocalServerOrigin+"/oauth/complete", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("complete status = %d", resp.StatusCode)
	}
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Error.Code != "USER_CANCELLED" {
		t.Fatalf("error code = %q, want USER_CANCELLED", payload.Error.Code)
	}
	waitForStatus(t, attempt, statusFailed)
	if !IsUserCancelled(attempt.resultError()) {
		t.Fatalf("attempt error = %v, want user cancellation", attempt.resultError())
	}
	session, err := client.ReadSession()
	if err != nil {
		t.Fatal(err)
	}
	if session != nil {
		t.Fatalf("session = %#v, want nil", session)
	}
}

func TestCallbackRedirectsProviderErrorWithoutLeakingSecrets(t *testing.T) {
	account := newAccountServer(t)
	defer account.Close()

	client := newTestClient(t, account.URL)
	attempt, err := client.StartLogin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	state := loginState(t, attempt.LoginURL)
	callbackURL, err := url.Parse(state.LocalServerOrigin + "/oauth/callback")
	if err != nil {
		t.Fatal(err)
	}
	query := callbackURL.Query()
	query.Set("state", attempt.state)
	query.Set("error", "access_denied")
	query.Set("transfer_code", "transfer-1")
	callbackURL.RawQuery = query.Encode()

	resp, err := noRedirectClient().Get(callbackURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("callback status = %d", resp.StatusCode)
	}
	location := resp.Header.Get("Location")
	resultURL, err := url.Parse(location)
	if err != nil {
		t.Fatal(err)
	}
	if got := resultURL.Query().Get("desktopBridgeStatus"); got != "error" {
		t.Fatalf("desktopBridgeStatus = %q", got)
	}
	if got := resultURL.Query().Get("desktopBridgeError"); got != "providerError" {
		t.Fatalf("desktopBridgeError = %q", got)
	}
	if strings.Contains(location, "access_denied") || strings.Contains(location, "transfer-1") {
		t.Fatalf("redirect leaked sensitive value: %s", location)
	}
	waitForStatus(t, attempt, statusFailed)
}

func TestCallbackPreservesUserCancellationWithoutOpenAppURL(t *testing.T) {
	account := newAccountServer(t)
	defer account.Close()

	client := newTestClient(t, account.URL)
	if err := client.writeAuthJSON(sessionFromUser("existing-session", UserInfo{UserID: "existing-user"})); err != nil {
		t.Fatal(err)
	}
	attempt, err := client.StartLogin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	state := loginState(t, attempt.LoginURL)
	callbackURL, err := url.Parse(state.LocalServerOrigin + "/oauth/callback")
	if err != nil {
		t.Fatal(err)
	}
	query := callbackURL.Query()
	query.Set("state", attempt.state)
	query.Set("error", "user_cancelled")
	callbackURL.RawQuery = query.Encode()

	resp, err := noRedirectClient().Get(callbackURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("callback status = %d", resp.StatusCode)
	}
	location := resp.Header.Get("Location")
	resultURL, err := url.Parse(location)
	if err != nil {
		t.Fatal(err)
	}
	if got := resultURL.Query().Get("desktopBridgeStatus"); got != "error" {
		t.Fatalf("desktopBridgeStatus = %q", got)
	}
	if got := resultURL.Query().Get("desktopBridgeError"); got != "userCancelled" {
		t.Fatalf("desktopBridgeError = %q", got)
	}
	if got := resultURL.Query().Get("openAppUrl"); got != "" {
		t.Fatalf("openAppUrl = %q, want empty", got)
	}
	if strings.Contains(location, "user_cancelled") {
		t.Fatalf("redirect leaked callback error: %s", location)
	}
	waitForStatus(t, attempt, statusFailed)
	if !IsUserCancelled(attempt.resultError()) {
		t.Fatalf("attempt error = %v, want user cancellation", attempt.resultError())
	}
	session, err := client.ReadSession()
	if err != nil {
		t.Fatal(err)
	}
	if session == nil || session.SessionID != "existing-session" {
		t.Fatalf("session = %#v, want existing session", session)
	}
}

func TestLoginReturnsUserCancelledSentinel(t *testing.T) {
	account := newAccountServer(t)
	defer account.Close()

	client, err := NewClient(Config{
		AccountBaseURL: account.URL,
		AppCallbackURL: "tutti://login/callback",
		AuthJSONPath:   filepath.Join(t.TempDir(), "account", "auth.json"),
		AuthLoginURL:   "https://tutti.sh/auth/login",
		OpenURL: func(_ context.Context, loginURL string) error {
			state := loginState(t, loginURL)
			parsedLoginURL, parseErr := url.Parse(loginURL)
			if parseErr != nil {
				return parseErr
			}
			callbackURL, parseErr := url.Parse(state.LocalServerOrigin + "/oauth/callback")
			if parseErr != nil {
				return parseErr
			}
			query := callbackURL.Query()
			query.Set("state", parsedLoginURL.Query().Get("state"))
			query.Set("error", "user_cancelled")
			callbackURL.RawQuery = query.Encode()
			response, requestErr := noRedirectClient().Get(callbackURL.String())
			if requestErr != nil {
				return requestErr
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusFound {
				return fmt.Errorf("callback status = %d", response.StatusCode)
			}
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	_, err = client.Login(context.Background())
	if !IsUserCancelled(err) {
		t.Fatalf("Login error = %v, want user cancellation", err)
	}
}

func TestBridgeResultOpenAppURLSchemeWhitelist(t *testing.T) {
	allowed := buildBridgeResultURL(Config{
		AuthLoginURL:   "https://tutti.sh/auth/login",
		AppCallbackURL: "tutti-dev://login/callback?transfer_code=bad",
	}, "success", "")
	allowedURL, err := url.Parse(allowed)
	if err != nil {
		t.Fatal(err)
	}
	openAppURL := allowedURL.Query().Get("openAppUrl")
	if openAppURL == "" {
		t.Fatal("allowed openAppUrl is missing")
	}
	if strings.Contains(openAppURL, "transfer_code") {
		t.Fatalf("openAppUrl leaked old query: %s", openAppURL)
	}
	parsedOpenAppURL, err := url.Parse(openAppURL)
	if err != nil {
		t.Fatal(err)
	}
	if parsedOpenAppURL.Scheme != "tutti-dev" {
		t.Fatalf("openAppUrl = %q", openAppURL)
	}

	blocked := buildBridgeResultURL(Config{
		AuthLoginURL:   "https://tutti.sh/auth/login",
		AppCallbackURL: "https://evil.example/callback",
	}, "success", "")
	blockedURL, err := url.Parse(blocked)
	if err != nil {
		t.Fatal(err)
	}
	if got := blockedURL.Query().Get("openAppUrl"); got != "" {
		t.Fatalf("blocked openAppUrl = %q", got)
	}
}

func TestGetUserInfoAndLogout(t *testing.T) {
	account := newAccountServer(t)
	defer account.Close()

	client := newTestClient(t, account.URL)
	err := client.writeAuthJSON(sessionFromUser("desktop-session-1", UserInfo{UserID: "old"}))
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
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode redeem body: %v", err)
			}
			if strings.TrimSpace(body["device_id"]) == "" {
				t.Errorf("redeem device_id is empty in body %#v", body)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 0,
				"data": map[string]string{"sessionId": "desktop-session-1"},
			})
		case "/user/v1/user_info":
			if got := r.Header.Get("Cookie"); got != "session_id=desktop-session-1" {
				t.Errorf("user_info cookie = %q, want redeemed desktop session", got)
			}
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
			if got := r.Header.Get("Cookie"); got != "session_id=desktop-session-1" {
				t.Errorf("logout cookie = %q, want redeemed desktop session", got)
			}
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode logout body: %v", err)
			}
			if strings.TrimSpace(body["app_id"]) == "" {
				t.Errorf("logout app_id is empty in body %#v", body)
			}
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

func noRedirectClient() *http.Client {
	return &http.Client{
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}
