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
	availableCredits := int64(2450)
	expiringCredits := int64(100)
	cancelAtPeriodEnd := false
	api := DaemonAPI{
		AccountService: accountServiceStub{
			summary: accountservice.ProductSummary{
				User: &authbridge.UserInfo{UserID: "user-1", Name: "Jane", Email: "jane@example.com"},
				Membership: &accountservice.MembershipSummary{
					TierKey:           "basic",
					DisplayName:       "Lite",
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
	if got.User == nil || got.User.UserId != "user-1" || got.Membership == nil || got.Membership.DisplayName != "Lite" {
		t.Fatalf("response = %#v", got)
	}
	if got.Credits == nil || got.Credits.AvailableCredits == nil || *got.Credits.AvailableCredits != 2450 {
		t.Fatalf("credits = %#v", got.Credits)
	}
	if got.Links.PlanUrl != "https://tutti.sh/profile/plan" || got.Links.UsageUrl != "https://tutti.sh/profile/usage" {
		t.Fatalf("links = %#v", got.Links)
	}
}

func TestAccountProductSummaryRouteIsRegistered(t *testing.T) {
	availableCredits := int64(2450)
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
	if body.Credits == nil || body.Credits.AvailableCredits == nil || *body.Credits.AvailableCredits != 2450 {
		t.Fatalf("credits = %#v", body.Credits)
	}
}

type accountServiceStub struct {
	status  authbridge.LoginStatus
	summary accountservice.ProductSummary
}

func (s accountServiceStub) GetProductSummary(context.Context) (accountservice.ProductSummary, error) {
	return s.summary, nil
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
