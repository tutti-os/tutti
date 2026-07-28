package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	accountservice "github.com/tutti-os/tutti/services/tuttid/service/account"
)

func TestAccountLoginStatusMapsServiceStatus(t *testing.T) {
	api := DaemonAPI{
		AccountService: accountServiceStub{
			status: authbridge.LoginStatus{
				AttemptID: "attempt-1",
				ExpiresAt: time.UnixMilli(123),
				Status:    "completed",
				User:      &authbridge.UserInfo{UserID: "user-1", Email: "user@example.com"},
			},
		},
	}
	response, err := api.GetAccountLoginStatus(context.Background(), tuttigenerated.GetAccountLoginStatusRequestObject{
		Params: tuttigenerated.GetAccountLoginStatusParams{AttemptId: "attempt-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	got, ok := response.(tuttigenerated.GetAccountLoginStatus200JSONResponse)
	if !ok {
		t.Fatalf("response = %T, want 200", response)
	}
	if got.AttemptId != "attempt-1" || got.Status != tuttigenerated.AccountLoginStatusValueCompleted || got.User == nil || got.User.UserId != "user-1" {
		t.Fatalf("response = %#v", got)
	}
}

func TestAccountProductSummaryMapsServiceSummary(t *testing.T) {
	availableCredits := "2450.52"
	expiringCredits := "100.25"
	cancelAtPeriodEnd := false
	api := DaemonAPI{
		AccountService: accountServiceStub{
			summary: accountservice.ProductSummary{
				User: &authbridge.UserInfo{UserID: "user-1", Name: "Jane", Email: "jane@example.com"},
				Membership: &accountservice.MembershipSummary{
					TierKey:           "basic",
					DisplayName:       "Basic",
					BillingPeriod:     "month",
					Status:            "active",
					AccessStatus:      "active",
					CurrentPeriodEnd:  "2026-08-01T00:00:00Z",
					CancelAtPeriodEnd: &cancelAtPeriodEnd,
				},
				Credits: &accountservice.CreditsSummary{
					AvailableCredits:         &availableCredits,
					ExpiringCreditsWithin24h: &expiringCredits,
					NextExpireAt:             "2026-07-07T00:00:00Z",
					RefreshedAt:              "2026-07-06T00:00:00Z",
				},
				RegistrationCreditsReward: &accountservice.RegistrationCreditsReward{
					ID:        "registrationCreditsToastShown:user-1:grant-1",
					UserID:    "user-1",
					GrantNo:   "grant-1",
					Credits:   500,
					CreatedAt: time.UnixMilli(123),
				},
				Links: accountservice.ProductSummaryLinks{
					PlanURL:     "https://tutti.sh/profile/plan",
					UsageURL:    "https://tutti.sh/profile/usage",
					SettingsURL: "https://tutti.sh/profile/settings",
				},
			},
		},
	}
	response, err := api.GetAccountProductSummary(context.Background(), tuttigenerated.GetAccountProductSummaryRequestObject{})
	if err != nil {
		t.Fatal(err)
	}
	got, ok := response.(tuttigenerated.GetAccountProductSummary200JSONResponse)
	if !ok {
		t.Fatalf("response = %T, want 200", response)
	}
	if got.User == nil || got.User.UserId != "user-1" || got.Membership == nil || got.Membership.DisplayName != "Basic" {
		t.Fatalf("response = %#v", got)
	}
	if got.Credits == nil || got.Credits.AvailableCredits == nil || *got.Credits.AvailableCredits != "2450.52" {
		t.Fatalf("credits = %#v", got.Credits)
	}
	if got.RegistrationCreditsReward == nil || got.RegistrationCreditsReward.Id != "registrationCreditsToastShown:user-1:grant-1" || got.RegistrationCreditsReward.Credits != 500 {
		t.Fatalf("registration credits reward = %#v", got.RegistrationCreditsReward)
	}
	if got.Links.PlanUrl != "https://tutti.sh/profile/plan" || got.Links.UsageUrl != "https://tutti.sh/profile/usage" {
		t.Fatalf("links = %#v", got.Links)
	}
}

func TestAccountProductSummaryRouteIsRegistered(t *testing.T) {
	availableCredits := "2450.52"
	mux := http.NewServeMux()
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			AccountService: accountServiceStub{
				summary: accountservice.ProductSummary{
					User:    &authbridge.UserInfo{UserID: "user-1", Name: "Jane", Email: "jane@example.com"},
					Credits: &accountservice.CreditsSummary{AvailableCredits: &availableCredits},
					Links: accountservice.ProductSummaryLinks{
						PlanURL:     "https://tutti.sh/profile/plan",
						UsageURL:    "https://tutti.sh/profile/usage",
						SettingsURL: "https://tutti.sh/profile/settings",
					},
				},
			},
		}),
	)

	request := httptest.NewRequest(http.MethodGet, "/v1/account/product_summary", nil)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
	}
	var body tuttigenerated.AccountProductSummaryResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.User == nil || body.User.UserId != "user-1" {
		t.Fatalf("user = %#v", body.User)
	}
	if body.Credits == nil || body.Credits.AvailableCredits == nil || *body.Credits.AvailableCredits != "2450.52" {
		t.Fatalf("credits = %#v", body.Credits)
	}
	if body.MembershipAccess != tuttigenerated.AccountMembershipAccessStateUnknown {
		t.Fatalf("membership access = %q, want unknown", body.MembershipAccess)
	}
}

func TestDismissAccountRegistrationCreditsRewardMapsRequest(t *testing.T) {
	var dismissedRewardID string
	api := DaemonAPI{
		AccountService: accountServiceStub{
			dismissedRewardID: &dismissedRewardID,
		},
	}
	response, err := api.DismissAccountRegistrationCreditsReward(context.Background(), tuttigenerated.DismissAccountRegistrationCreditsRewardRequestObject{
		Body: &tuttigenerated.DismissAccountRegistrationCreditsRewardJSONRequestBody{
			RewardId: "registrationCreditsToastShown:user-1:grant-1",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := response.(tuttigenerated.DismissAccountRegistrationCreditsReward204Response); !ok {
		t.Fatalf("response = %T, want 204", response)
	}
	if dismissedRewardID != "registrationCreditsToastShown:user-1:grant-1" {
		t.Fatalf("dismissed reward id = %q", dismissedRewardID)
	}
}

type accountServiceStub struct {
	status            authbridge.LoginStatus
	summary           accountservice.ProductSummary
	dismissedRewardID *string
}

func (s accountServiceStub) GetProductSummary(context.Context) (accountservice.ProductSummary, error) {
	return s.summary, nil
}

func (s accountServiceStub) DismissRegistrationCreditsReward(_ context.Context, rewardID string) error {
	if s.dismissedRewardID != nil {
		*s.dismissedRewardID = rewardID
	}
	return nil
}

func (accountServiceStub) GetUserInfo(context.Context) (*authbridge.UserInfo, error) {
	return nil, nil
}

func (s accountServiceStub) LoginStatus(string) (authbridge.LoginStatus, error) {
	return s.status, nil
}

func (accountServiceStub) Logout(context.Context) error {
	return nil
}

func (accountServiceStub) StartLogin(context.Context) (accountservice.LoginStart, error) {
	return accountservice.LoginStart{}, nil
}
