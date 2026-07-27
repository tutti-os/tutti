package commerce

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestProductSummaryNormalizesMembershipCreditsAndAuthorization(t *testing.T) {
	var requestCookies sync.Map
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requestCookies.Store(request.URL.Path, request.Header.Get("Cookie"))
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v1/user-info":
			_, _ = writer.Write([]byte(`{
				"is_vip": true,
				"vip_level": "basic",
				"vip_billing_period": "month",
				"vip_renew_at": "2026-08-01T00:00:00Z",
				"vip_cancel_at_period_end": false,
				"available_credits": "1200"
			}`))
		case "/v1/credits/overview":
			_, _ = writer.Write([]byte(`{
				"available_credits": "2450.52",
				"expiring_credits_within_24h": "100.25",
				"next_expire_at": "2026-07-07T00:00:00Z"
			}`))
		case "/v1/credits/login-claim":
			_, _ = writer.Write([]byte(`{"first_login_claimed":false}`))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	store := &memoryRewardReceiptStore{}
	service, err := NewService(Config{
		BaseURL: server.URL,
		Authorizer: RequestAuthorizerFunc(func(request *http.Request) error {
			request.Header.Set("Cookie", "session_id=session-1")
			return nil
		}),
		RewardReceiptStore: store,
	})
	if err != nil {
		t.Fatal(err)
	}

	summary := service.ProductSummary(context.Background(), "user-1")
	if summary.Membership == nil || summary.Membership.TierKey != "basic" ||
		summary.Membership.DisplayName != "Basic" {
		t.Fatalf("membership = %#v", summary.Membership)
	}
	if summary.MembershipAccess != MembershipAccessActive {
		t.Fatalf("membership access = %q, want active", summary.MembershipAccess)
	}
	if summary.Credits == nil || summary.Credits.AvailableCredits == nil ||
		*summary.Credits.AvailableCredits != "2450.52" {
		t.Fatalf("credits = %#v", summary.Credits)
	}
	if summary.Credits.ExpiringCreditsWithin24h == nil ||
		*summary.Credits.ExpiringCreditsWithin24h != "100.25" {
		t.Fatalf("expiring credits = %#v", summary.Credits)
	}
	for _, path := range []string{"/v1/user-info", "/v1/credits/overview", "/v1/credits/login-claim"} {
		cookie, ok := requestCookies.Load(path)
		if !ok || cookie != "session_id=session-1" {
			t.Fatalf("%s Cookie = %q, want session cookie", path, cookie)
		}
	}
	if summary.PartialError != nil {
		t.Fatalf("partial error = %#v, want nil", summary.PartialError)
	}
}

func TestProductSummaryReturnsPartialErrorsWithoutDiscardingUsableData(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v1/user-info":
			http.Error(writer, "private upstream detail", http.StatusUnauthorized)
		case "/v1/credits/overview":
			_, _ = writer.Write([]byte(`{"available_credits":"12.5"}`))
		case "/v1/credits/login-claim":
			_, _ = writer.Write([]byte(`{"first_login_claimed":false}`))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	service := newTestService(t, Config{
		BaseURL:            server.URL,
		RewardReceiptStore: &memoryRewardReceiptStore{},
	})
	summary := service.ProductSummary(context.Background(), "user-1")
	if summary.Credits == nil || summary.Credits.AvailableCredits == nil ||
		*summary.Credits.AvailableCredits != "12.5" {
		t.Fatalf("credits = %#v", summary.Credits)
	}
	if summary.PartialError == nil || summary.PartialError.Scope != "membership" ||
		summary.PartialError.Code != ErrorCodeUnauthorized {
		t.Fatalf("partial error = %#v", summary.PartialError)
	}
	if summary.PartialError.Message != "Commerce session is unavailable" {
		t.Fatalf("partial error message = %q", summary.PartialError.Message)
	}
	if summary.MembershipAccess != MembershipAccessUnknown {
		t.Fatalf("membership access = %q, want unknown", summary.MembershipAccess)
	}
}

func TestMembershipFromUserInfoNormalizesAccessState(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		data     map[string]any
		want     MembershipAccessState
		wantTier string
	}{
		{
			name: "top-level free is authoritative",
			data: map[string]any{
				"is_vip":    false,
				"vip_level": "free",
				"membership": map[string]any{
					"tier_key":      "pro",
					"access_status": "active",
				},
			},
			want: MembershipAccessFree,
		},
		{
			name: "top-level paid is active",
			data: map[string]any{
				"is_vip":    true,
				"vip_level": "pro",
			},
			want: MembershipAccessActive,
		},
		{
			name: "top-level vip flag without level is unknown",
			data: map[string]any{
				"is_vip": true,
			},
			want: MembershipAccessUnknown,
		},
		{
			name: "top-level paid level without vip flag is unknown",
			data: map[string]any{
				"vip_level": "pro",
			},
			want: MembershipAccessUnknown,
		},
		{
			name: "contradictory top-level facts fail closed",
			data: map[string]any{
				"is_vip":    false,
				"vip_level": "pro",
				"membership": map[string]any{
					"tier_key":      "pro",
					"access_status": "active",
				},
			},
			want:     MembershipAccessUnknown,
			wantTier: "pro",
		},
		{
			name: "legacy free tier is free",
			data: map[string]any{
				"membership": map[string]any{
					"tier_key": "free",
				},
			},
			want: MembershipAccessFree,
		},
		{
			name: "legacy explicit active access is active",
			data: map[string]any{
				"membership": map[string]any{
					"tier_key":             "pro",
					"access_status":        "active",
					"cancel_at_period_end": true,
				},
			},
			want: MembershipAccessActive,
		},
		{
			name: "legacy explicit inactive access is inactive",
			data: map[string]any{
				"membership": map[string]any{
					"tier_key":      "pro",
					"access_status": "inactive",
				},
			},
			want: MembershipAccessInactive,
		},
		{
			name: "unrecognized state fails closed",
			data: map[string]any{
				"membership": map[string]any{
					"tier_key":      "pro",
					"access_status": "past_due",
				},
			},
			want: MembershipAccessUnknown,
		},
		{
			name: "missing membership is unknown",
			data: map[string]any{},
			want: MembershipAccessUnknown,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			summary, got := MembershipFromUserInfo(test.data)
			if got != test.want {
				t.Fatalf("membership access = %q, want %q", got, test.want)
			}
			if test.wantTier != "" && (summary == nil || summary.TierKey != test.wantTier) {
				t.Fatalf("membership summary = %#v, want tier %q", summary, test.wantTier)
			}
		})
	}
}

func TestRegistrationRewardClaimIsSerializedPersistedAndDismissed(t *testing.T) {
	var claimCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v1/user-info":
			_, _ = writer.Write([]byte(`{"is_vip":false,"vip_level":"free"}`))
		case "/v1/credits/overview":
			_, _ = writer.Write([]byte(`{"available_credits":"500"}`))
		case "/v1/credits/login-claim":
			claimCount.Add(1)
			time.Sleep(20 * time.Millisecond)
			_, _ = writer.Write([]byte(`{
				"grant_no":"fallback",
				"first_login_claimed":true,
				"first_login_grant_no":"first-grant-1",
				"first_login_grant_credits":"500",
				"daily_claimed":true,
				"daily_grant_credits":"200"
			}`))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	store := &memoryRewardReceiptStore{}
	service := newTestService(t, Config{BaseURL: server.URL, RewardReceiptStore: store})

	const callers = 8
	rewards := make(chan *RegistrationCreditsReward, callers)
	var waitGroup sync.WaitGroup
	for range callers {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			rewards <- service.ProductSummary(context.Background(), "user-1").RegistrationCreditsReward
		}()
	}
	waitGroup.Wait()
	close(rewards)

	var reward *RegistrationCreditsReward
	for candidate := range rewards {
		if candidate == nil {
			t.Fatal("concurrent caller did not observe pending reward")
		}
		if reward == nil {
			reward = candidate
			continue
		}
		if candidate.ID != reward.ID {
			t.Fatalf("reward id = %q, want %q", candidate.ID, reward.ID)
		}
	}
	if claimCount.Load() != 1 {
		t.Fatalf("claim count = %d, want 1", claimCount.Load())
	}
	if reward == nil || reward.Credits != 500 || reward.GrantNo != "first-grant-1" {
		t.Fatalf("reward = %#v", reward)
	}

	if err := service.DismissRegistrationCreditsReward(context.Background(), reward.ID); err != nil {
		t.Fatal(err)
	}
	summary := service.ProductSummary(context.Background(), "user-1")
	if summary.RegistrationCreditsReward != nil {
		t.Fatalf("reward after dismiss = %#v", summary.RegistrationCreditsReward)
	}
	if claimCount.Load() != 1 {
		t.Fatalf("claim count after dismiss = %d, want 1", claimCount.Load())
	}
}

func TestProductSummaryHonorsCancellation(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		select {
		case started <- struct{}{}:
		default:
		}
		select {
		case <-request.Context().Done():
		case <-release:
		}
	}))
	defer func() {
		close(release)
		server.Close()
	}()

	service := newTestService(t, Config{
		BaseURL:            server.URL,
		RewardReceiptStore: &memoryRewardReceiptStore{},
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan ProductSummary, 1)
	go func() {
		done <- service.ProductSummary(ctx, "user-1")
	}()
	<-started
	cancel()

	select {
	case summary := <-done:
		if summary.PartialError == nil || summary.PartialError.Code != ErrorCodeUnavailable {
			t.Fatalf("partial error = %#v", summary.PartialError)
		}
	case <-time.After(time.Second):
		t.Fatal("ProductSummary did not return after cancellation")
	}
}

func TestNewServiceFailsClosedWithoutAuthorizerOrReceiptStore(t *testing.T) {
	_, err := NewService(Config{BaseURL: "https://example.com"})
	if !errors.Is(err, ErrRequestAuthorizerRequired) {
		t.Fatalf("error = %v, want ErrRequestAuthorizerRequired", err)
	}
	_, err = NewService(Config{
		BaseURL: "https://example.com",
		Authorizer: RequestAuthorizerFunc(func(*http.Request) error {
			return nil
		}),
	})
	if !errors.Is(err, ErrRewardReceiptStoreRequired) {
		t.Fatalf("error = %v, want ErrRewardReceiptStoreRequired", err)
	}
}

func TestRegistrationRewardFailsClosedWhenReceiptStateIsUnavailable(t *testing.T) {
	var claimCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/credits/login-claim" {
			_, _ = writer.Write([]byte(`{}`))
			return
		}
		claimCount.Add(1)
		_, _ = writer.Write([]byte(`{
			"first_login_claimed":true,
			"first_login_grant_no":"grant-1",
			"first_login_grant_credits":"500"
		}`))
	}))
	defer server.Close()

	loadFailed := newTestService(t, Config{
		BaseURL: server.URL,
		RewardReceiptStore: &failingRewardReceiptStore{
			loadErr: errors.New("receipt load failed"),
		},
	})
	if reward := loadFailed.ProductSummary(context.Background(), "user-1").RegistrationCreditsReward; reward != nil {
		t.Fatalf("reward with failed load = %#v, want nil", reward)
	}
	if claimCount.Load() != 0 {
		t.Fatalf("claim count after failed load = %d, want 0", claimCount.Load())
	}

	saveFailed := newTestService(t, Config{
		BaseURL: server.URL,
		RewardReceiptStore: &failingRewardReceiptStore{
			saveErr: errors.New("receipt save failed"),
		},
	})
	if reward := saveFailed.ProductSummary(context.Background(), "user-1").RegistrationCreditsReward; reward != nil {
		t.Fatalf("reward with failed save = %#v, want nil", reward)
	}
	if reward := saveFailed.ProductSummary(context.Background(), "user-1").RegistrationCreditsReward; reward != nil {
		t.Fatalf("second reward with failed save = %#v, want nil", reward)
	}
	if claimCount.Load() != 1 {
		t.Fatalf("claim count after failed save = %d, want 1", claimCount.Load())
	}
}

func newTestService(t *testing.T, config Config) *Service {
	t.Helper()
	if config.Authorizer == nil {
		config.Authorizer = RequestAuthorizerFunc(func(*http.Request) error { return nil })
	}
	service, err := NewService(config)
	if err != nil {
		t.Fatal(err)
	}
	return service
}

type memoryRewardReceiptStore struct {
	mu    sync.Mutex
	state RewardReceiptState
}

type failingRewardReceiptStore struct {
	loadErr error
	saveErr error
}

func (s *failingRewardReceiptStore) Load(context.Context) (RewardReceiptState, error) {
	return RewardReceiptState{}, s.loadErr
}

func (s *failingRewardReceiptStore) Save(context.Context, RewardReceiptState) error {
	return s.saveErr
}

func (s *memoryRewardReceiptStore) Load(context.Context) (RewardReceiptState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneRewardReceiptState(s.state), nil
}

func (s *memoryRewardReceiptStore) Save(_ context.Context, state RewardReceiptState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state = cloneRewardReceiptState(state)
	return nil
}
