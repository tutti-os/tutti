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
				"is_vip": true,
				"vip_level": "basic",
				"vip_billing_period": "month",
				"vip_renew_at": "2026-08-01T00:00:00Z",
				"vip_cancel_at_period_end": false,
				"available_credits": "1200"
			}`))
		case "/v1/credits/overview":
			creditsOverviewCookie = r.Header.Get("Cookie")
			_, _ = w.Write([]byte(`{
				"available_credits": "2450.52",
				"expiring_credits_within_24h": "100.25",
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
	if summary.Membership == nil || summary.Membership.TierKey != "basic" || summary.Membership.DisplayName != "Basic" {
		t.Fatalf("summary membership = %#v", summary.Membership)
	}
	if summary.Credits == nil || summary.Credits.AvailableCredits == nil || *summary.Credits.AvailableCredits != "2450.52" {
		t.Fatalf("summary credits = %#v", summary.Credits)
	}
	if summary.Credits.ExpiringCreditsWithin24h == nil || *summary.Credits.ExpiringCreditsWithin24h != "100.25" {
		t.Fatalf("summary expiring credits = %#v", summary.Credits)
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

func TestCommerceAuthorizerFailsClosedWithoutSessionCookie(t *testing.T) {
	service := NewService(filepath.Join(t.TempDir(), "auth.json"))
	request := httptest.NewRequest(http.MethodGet, "https://tutti.sh/api/commerce/v1/user-info", nil)

	if err := service.authorizeCommerceRequest(request); err == nil {
		t.Fatal("authorizeCommerceRequest error = nil, want missing session cookie")
	}
	if cookie := request.Header.Get("Cookie"); cookie != "" {
		t.Fatalf("Cookie = %q, want empty", cookie)
	}
}

func TestMembershipSummaryMapsVIPUserInfoContract(t *testing.T) {
	falseValue := false
	trueValue := true
	tests := []struct {
		name string
		data map[string]any
		want *MembershipSummary
	}{
		{
			name: "free ignores stale legacy membership",
			data: map[string]any{
				"is_vip":    false,
				"vip_level": "free",
				"membership": map[string]any{
					"tier_key": "pro",
				},
			},
			want: nil,
		},
		{
			name: "active paid uses renewal time",
			data: map[string]any{
				"is_vip":                   true,
				"vip_level":                "basic",
				"vip_billing_period":       "month",
				"vip_renew_at":             "2026-08-01T00:00:00Z",
				"vip_cancel_at_period_end": false,
			},
			want: &MembershipSummary{
				TierKey:           "basic",
				DisplayName:       "Basic",
				BillingPeriod:     "month",
				Status:            "active",
				AccessStatus:      "active",
				CurrentPeriodEnd:  "2026-08-01T00:00:00Z",
				CancelAtPeriodEnd: &falseValue,
			},
		},
		{
			name: "cancel at period end uses valid until time",
			data: map[string]any{
				"is_vip":                   true,
				"vip_level":                "pro",
				"vip_billing_period":       "year",
				"vip_valid_until":          "2026-09-01T00:00:00Z",
				"vip_cancel_at_period_end": true,
			},
			want: &MembershipSummary{
				TierKey:           "pro",
				DisplayName:       "Pro",
				BillingPeriod:     "year",
				Status:            "active",
				AccessStatus:      "active",
				CurrentPeriodEnd:  "2026-09-01T00:00:00Z",
				CancelAtPeriodEnd: &trueValue,
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := membershipSummary(test.data)
			assertMembershipSummary(t, got, test.want)
		})
	}
}

func TestGetProductSummaryClaimsRegistrationCreditsOnceAndDismissesReward(t *testing.T) {
	var loginClaimCount atomic.Int32
	var loginClaimCookie string
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/user/v1/user_info":
			_, _ = w.Write([]byte(`{"code":0,"data":{"userId":"user-1","name":"Jane"}}`))
		case "/v1/user-info":
			_, _ = w.Write([]byte(`{"is_vip":true,"vip_level":"basic","available_credits":500}`))
		case "/v1/credits/overview":
			_, _ = w.Write([]byte(`{"available_credits":500}`))
		case "/v1/credits/login-claim":
			if r.Method != http.MethodPost {
				t.Fatalf("login-claim method = %s, want POST", r.Method)
			}
			loginClaimCount.Add(1)
			loginClaimCookie = r.Header.Get("Cookie")
			_, _ = w.Write([]byte(`{
				"claimed": true,
				"grant_no": "fallback-grant",
				"first_login_claimed": true,
				"first_login_grant_no": "first-grant-1",
				"first_login_grant_credits": "500",
				"daily_claimed": true,
				"daily_grant_credits": "200"
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer account.Close()

	authPath := filepath.Join(t.TempDir(), "auth.json")
	writeAccountAuthSession(t, authPath)
	service := NewService(authPath)
	service.AccountBaseURL = account.URL
	service.CommerceBaseURL = account.URL

	summary, err := service.GetProductSummary(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if loginClaimCookie != "session_id=session-1" {
		t.Fatalf("login-claim cookie = %q, want session cookie", loginClaimCookie)
	}
	if loginClaimCount.Load() != 1 {
		t.Fatalf("login-claim count = %d, want 1", loginClaimCount.Load())
	}
	reward := summary.RegistrationCreditsReward
	if reward == nil || reward.UserID != "user-1" || reward.GrantNo != "first-grant-1" || reward.Credits != 500 {
		t.Fatalf("registration credits reward = %#v", reward)
	}

	summary, err = service.GetProductSummary(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.RegistrationCreditsReward == nil || summary.RegistrationCreditsReward.ID != reward.ID {
		t.Fatalf("pending reward = %#v, want same reward", summary.RegistrationCreditsReward)
	}
	if loginClaimCount.Load() != 1 {
		t.Fatalf("login-claim count after pending summary = %d, want 1", loginClaimCount.Load())
	}

	if err := service.DismissRegistrationCreditsReward(context.Background(), reward.ID); err != nil {
		t.Fatal(err)
	}
	summary, err = service.GetProductSummary(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.RegistrationCreditsReward != nil {
		t.Fatalf("registration credits reward after dismiss = %#v, want nil", summary.RegistrationCreditsReward)
	}
	if loginClaimCount.Load() != 1 {
		t.Fatalf("login-claim count after dismiss = %d, want 1", loginClaimCount.Load())
	}
}

func TestGetProductSummaryIgnoresDailyClaimWithoutFirstLoginReward(t *testing.T) {
	var loginClaimCount atomic.Int32
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/user/v1/user_info":
			_, _ = w.Write([]byte(`{"code":0,"data":{"userId":"user-1","name":"Jane"}}`))
		case "/v1/user-info":
			_, _ = w.Write([]byte(`{"is_vip":true,"vip_level":"basic","available_credits":700}`))
		case "/v1/credits/overview":
			_, _ = w.Write([]byte(`{"available_credits":700}`))
		case "/v1/credits/login-claim":
			loginClaimCount.Add(1)
			_, _ = w.Write([]byte(`{
				"first_login_claimed": false,
				"first_login_grant_credits": 0,
				"daily_claimed": true,
				"daily_grant_no": "daily-grant-1",
				"daily_grant_credits": 200
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer account.Close()

	authPath := filepath.Join(t.TempDir(), "auth.json")
	writeAccountAuthSession(t, authPath)
	service := NewService(authPath)
	service.AccountBaseURL = account.URL
	service.CommerceBaseURL = account.URL

	summary, err := service.GetProductSummary(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.RegistrationCreditsReward != nil {
		t.Fatalf("registration credits reward = %#v, want nil", summary.RegistrationCreditsReward)
	}
	if loginClaimCount.Load() != 1 {
		t.Fatalf("login-claim count = %d, want 1", loginClaimCount.Load())
	}
	summary, err = service.GetProductSummary(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.RegistrationCreditsReward != nil {
		t.Fatalf("second registration credits reward = %#v, want nil", summary.RegistrationCreditsReward)
	}
	if loginClaimCount.Load() != 1 {
		t.Fatalf("login-claim count after second summary = %d, want 1", loginClaimCount.Load())
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

func writeAccountAuthSession(t *testing.T, authPath string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(authPath, []byte(`{"session_id":"session-1","cookie":"session_id=session-1","user_id":"user-1"}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

type testLoginState struct {
	LocalServerOrigin string `json:"localServerOrigin"`
}

func assertMembershipSummary(t *testing.T, got *MembershipSummary, want *MembershipSummary) {
	t.Helper()
	if want == nil {
		if got != nil {
			t.Fatalf("membership summary = %#v, want nil", got)
		}
		return
	}
	if got == nil {
		t.Fatalf("membership summary = nil, want %#v", want)
	}
	if got.TierKey != want.TierKey ||
		got.DisplayName != want.DisplayName ||
		got.BillingPeriod != want.BillingPeriod ||
		got.Status != want.Status ||
		got.AccessStatus != want.AccessStatus ||
		got.CurrentPeriodEnd != want.CurrentPeriodEnd {
		t.Fatalf("membership summary = %#v, want %#v", got, want)
	}
	if (got.CancelAtPeriodEnd == nil) != (want.CancelAtPeriodEnd == nil) {
		t.Fatalf("cancel_at_period_end = %#v, want %#v", got.CancelAtPeriodEnd, want.CancelAtPeriodEnd)
	}
	if got.CancelAtPeriodEnd != nil && *got.CancelAtPeriodEnd != *want.CancelAtPeriodEnd {
		t.Fatalf("cancel_at_period_end = %v, want %v", *got.CancelAtPeriodEnd, *want.CancelAtPeriodEnd)
	}
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
