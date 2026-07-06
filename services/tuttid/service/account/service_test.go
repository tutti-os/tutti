package account

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
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

func TestLoginStatusCompletedTriggersCallbackOnce(t *testing.T) {
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/auth/v1/redeem_desktop_transfer_code":
			_, _ = w.Write([]byte(`{"code":0,"data":{"sessionId":"session-1"}}`))
		case "/user/v1/user_info":
			_, _ = w.Write([]byte(`{"code":0,"data":{"userId":"user-1","email":"user@example.com"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer account.Close()

	service := NewService(filepath.Join(t.TempDir(), "auth.json"))
	service.AccountBaseURL = account.URL
	service.AuthLoginURL = account.URL + "/auth/login"
	var callbackCount atomic.Int32
	done := make(chan struct{}, 1)
	service.OnLoginCompleted = func(context.Context) {
		callbackCount.Add(1)
		done <- struct{}{}
	}

	started, err := service.StartLogin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	rawState := loginStateParam(t, started.LoginURL)
	state := decodeLoginState(t, started.LoginURL)
	body, _ := json.Marshal(map[string]string{
		"state":         rawState,
		"transfer_code": "transfer-1",
	})
	completeResp, err := http.Post(state.LocalServerOrigin+"/oauth/complete", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	_ = completeResp.Body.Close()

	status, err := waitForCompletedLoginStatus(service, started.AttemptID)
	if err != nil {
		t.Fatal(err)
	}
	if status.User == nil || status.User.UserID != "user-1" {
		t.Fatalf("status user = %#v, want user-1", status.User)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("OnLoginCompleted was not called")
	}
	if _, err := service.LoginStatus(started.AttemptID); err != ErrAttemptNotFound {
		t.Fatalf("second LoginStatus error = %v, want ErrAttemptNotFound", err)
	}
	if got := callbackCount.Load(); got != 1 {
		t.Fatalf("callback count = %d, want 1", got)
	}
}

func TestGetProductSummaryFetchesCommerceWithSessionCookie(t *testing.T) {
	var commerceUserInfoCookie string
	var creditsOverviewCookie string
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/user/v1/user_info":
			if got := r.Header.Get("Cookie"); got != "session_id=session-1" {
				t.Fatalf("account user info Cookie = %q, want session cookie", got)
			}
			_, _ = w.Write([]byte(`{"code":0,"data":{"userId":"user-1","name":"Jane","email":"jane@example.com","avatar":"https://example.com/avatar.png"}}`))
		case "/v1/user-info":
			commerceUserInfoCookie = r.Header.Get("Cookie")
			_, _ = w.Write([]byte(`{
				"membership": {
					"tier_key": "basic",
					"billing_period": "month",
					"status": "active",
					"access_status": "active",
					"current_period_end": "2026-08-01T00:00:00Z",
					"cancel_at_period_end": false
				},
				"available_credits": 1200
			}`))
		case "/v1/credits/overview":
			creditsOverviewCookie = r.Header.Get("Cookie")
			_, _ = w.Write([]byte(`{
				"available_credits": 2450,
				"expiring_credits_within_24h": 100,
				"next_expire_at": "2026-07-07T00:00:00Z"
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer account.Close()

	authPath := filepath.Join(t.TempDir(), "auth.json")
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(authPath, []byte(`{"session_id":"session-1","cookie":"session_id=session-1","user_id":"user-1"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	service := NewService(authPath)
	service.AccountBaseURL = account.URL
	service.CommerceBaseURL = account.URL
	service.WebBaseURL = "https://staging.tutti.sh"

	summary, err := service.GetProductSummary(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.User == nil || summary.User.UserID != "user-1" || summary.User.Name != "Jane" {
		t.Fatalf("summary user = %#v", summary.User)
	}
	if summary.Membership == nil || summary.Membership.TierKey != "basic" || summary.Membership.DisplayName != "Lite" {
		t.Fatalf("summary membership = %#v", summary.Membership)
	}
	if summary.Credits == nil || summary.Credits.AvailableCredits == nil || *summary.Credits.AvailableCredits != 2450 {
		t.Fatalf("summary credits = %#v", summary.Credits)
	}
	if commerceUserInfoCookie != "session_id=session-1" || creditsOverviewCookie != "session_id=session-1" {
		t.Fatalf("commerce cookies = (%q, %q), want session cookie", commerceUserInfoCookie, creditsOverviewCookie)
	}
	if summary.Links.PlanURL != "https://staging.tutti.sh/profile/plan" ||
		summary.Links.UsageURL != "https://staging.tutti.sh/profile/usage" ||
		summary.Links.SettingsURL != "https://staging.tutti.sh/profile/settings" {
		t.Fatalf("summary links = %#v", summary.Links)
	}
	if summary.PartialError != nil {
		t.Fatalf("partial error = %#v, want nil", summary.PartialError)
	}
}

func TestGetProductSummaryReturnsLinksWhenSignedOut(t *testing.T) {
	service := NewService(filepath.Join(t.TempDir(), "auth.json"))
	service.WebBaseURL = "https://tutti.sh"

	summary, err := service.GetProductSummary(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.User != nil || summary.Membership != nil || summary.Credits != nil {
		t.Fatalf("summary = %#v, want signed-out summary", summary)
	}
	if summary.Links.PlanURL != "https://tutti.sh/profile/plan" {
		t.Fatalf("plan url = %q", summary.Links.PlanURL)
	}
}

func TestLogoutTriggersCallbackAfterAuthCleared(t *testing.T) {
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/auth/v1/logout-web-session":
			_, _ = w.Write([]byte(`{"code":0}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer account.Close()

	authPath := filepath.Join(t.TempDir(), "auth.json")
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(authPath, []byte(`{"session_id":"session-1","cookie":"session_id=session-1","user":{"user_id":"user-1"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	service := NewService(authPath)
	service.AccountBaseURL = account.URL
	var callbackCount atomic.Int32
	done := make(chan struct{}, 1)
	service.OnLogoutCompleted = func(context.Context) {
		callbackCount.Add(1)
		done <- struct{}{}
	}

	if err := service.Logout(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(authPath); !os.IsNotExist(err) {
		t.Fatalf("auth json stat error = %v, want not exist", err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("OnLogoutCompleted was not called")
	}
	if got := callbackCount.Load(); got != 1 {
		t.Fatalf("callback count = %d, want 1", got)
	}
}

type testLoginState struct {
	LocalServerOrigin string `json:"localServerOrigin"`
}

func loginStateParam(t *testing.T, loginURL string) string {
	t.Helper()
	u, err := url.Parse(loginURL)
	if err != nil {
		t.Fatal(err)
	}
	return u.Query().Get("state")
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

func waitForCompletedLoginStatus(service *Service, attemptID string) (authbridge.LoginStatus, error) {
	for index := 0; index < 50; index += 1 {
		status, err := service.LoginStatus(attemptID)
		if err != nil {
			return authbridge.LoginStatus{}, err
		}
		if status.Status == "completed" {
			return status, nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return authbridge.LoginStatus{}, context.DeadlineExceeded
}
