package api

import (
	"context"
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

type accountServiceStub struct {
	status authbridge.LoginStatus
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
