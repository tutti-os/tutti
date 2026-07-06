package api

import (
	"context"
	"errors"

	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	accountservice "github.com/tutti-os/tutti/services/tuttid/service/account"
)

type AccountService interface {
	GetProductSummary(context.Context) (accountservice.ProductSummary, error)
	GetUserInfo(context.Context) (*authbridge.UserInfo, error)
	LoginStatus(string) (authbridge.LoginStatus, error)
	Logout(context.Context) error
	StartLogin(context.Context) (accountservice.LoginStart, error)
}

func (api DaemonAPI) StartAccountLogin(ctx context.Context, _ tuttigenerated.StartAccountLoginRequestObject) (tuttigenerated.StartAccountLoginResponseObject, error) {
	if api.AccountService == nil {
		return tuttigenerated.StartAccountLogin503JSONResponse{ServiceUnavailableErrorJSONResponse: accountServiceUnavailableError()}, nil
	}
	start, err := api.AccountService.StartLogin(ctx)
	if err != nil {
		return tuttigenerated.StartAccountLogin503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable("account_login_failed", apierrors.WithCause(err)),
			),
		}, nil
	}
	return tuttigenerated.StartAccountLogin200JSONResponse{
		AttemptId: start.AttemptID,
		ExpiresAt: start.ExpiresAt,
		LoginUrl:  start.LoginURL,
	}, nil
}

func (api DaemonAPI) GetAccountLoginStatus(_ context.Context, request tuttigenerated.GetAccountLoginStatusRequestObject) (tuttigenerated.GetAccountLoginStatusResponseObject, error) {
	if api.AccountService == nil {
		return tuttigenerated.GetAccountLoginStatus503JSONResponse{ServiceUnavailableErrorJSONResponse: accountServiceUnavailableError()}, nil
	}
	status, err := api.AccountService.LoginStatus(request.Params.AttemptId)
	if err != nil {
		if errors.Is(err, accountservice.ErrAttemptNotFound) {
			return tuttigenerated.GetAccountLoginStatus400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(
					apierrors.InvalidRequest("account_login_attempt_not_found", apierrors.WithParams(map[string]any{"field": "attempt_id"})),
				),
			}, nil
		}
		return tuttigenerated.GetAccountLoginStatus503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable("account_login_status_failed", apierrors.WithCause(err)),
			),
		}, nil
	}
	return tuttigenerated.GetAccountLoginStatus200JSONResponse{
		AttemptId: status.AttemptID,
		Error:     stringPointer(status.Error),
		ExpiresAt: status.ExpiresAt.UnixMilli(),
		Status:    tuttigenerated.AccountLoginStatusValue(status.Status),
		User:      generatedAccountUser(status.User),
	}, nil
}

func (api DaemonAPI) GetAccountUserInfo(ctx context.Context, _ tuttigenerated.GetAccountUserInfoRequestObject) (tuttigenerated.GetAccountUserInfoResponseObject, error) {
	if api.AccountService == nil {
		return tuttigenerated.GetAccountUserInfo503JSONResponse{ServiceUnavailableErrorJSONResponse: accountServiceUnavailableError()}, nil
	}
	user, err := api.AccountService.GetUserInfo(ctx)
	if err != nil {
		return tuttigenerated.GetAccountUserInfo503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable("account_user_info_failed", apierrors.WithCause(err)),
			),
		}, nil
	}
	return tuttigenerated.GetAccountUserInfo200JSONResponse{
		User: generatedAccountUser(user),
	}, nil
}

func (api DaemonAPI) GetAccountProductSummary(ctx context.Context, _ tuttigenerated.GetAccountProductSummaryRequestObject) (tuttigenerated.GetAccountProductSummaryResponseObject, error) {
	if api.AccountService == nil {
		return tuttigenerated.GetAccountProductSummary503JSONResponse{ServiceUnavailableErrorJSONResponse: accountServiceUnavailableError()}, nil
	}
	summary, err := api.AccountService.GetProductSummary(ctx)
	if err != nil {
		return tuttigenerated.GetAccountProductSummary503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable("account_product_summary_failed", apierrors.WithCause(err)),
			),
		}, nil
	}
	return tuttigenerated.GetAccountProductSummary200JSONResponse{
		User:         generatedAccountUser(summary.User),
		Membership:   generatedAccountMembership(summary.Membership),
		Credits:      generatedAccountCredits(summary.Credits),
		PartialError: generatedAccountProductPartialError(summary.PartialError),
		Links: tuttigenerated.AccountProductSummaryLinks{
			PlanUrl:     summary.Links.PlanURL,
			UsageUrl:    summary.Links.UsageURL,
			SettingsUrl: summary.Links.SettingsURL,
		},
	}, nil
}

func (api DaemonAPI) LogoutAccount(ctx context.Context, _ tuttigenerated.LogoutAccountRequestObject) (tuttigenerated.LogoutAccountResponseObject, error) {
	if api.AccountService == nil {
		return tuttigenerated.LogoutAccount503JSONResponse{ServiceUnavailableErrorJSONResponse: accountServiceUnavailableError()}, nil
	}
	if err := api.AccountService.Logout(ctx); err != nil {
		return tuttigenerated.LogoutAccount503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable("account_logout_failed", apierrors.WithCause(err)),
			),
		}, nil
	}
	return tuttigenerated.LogoutAccount204Response{}, nil
}

func accountServiceUnavailableError() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(
		apierrors.ServiceUnavailable("account_service_unavailable", apierrors.WithDeveloperMessage("account service is unavailable")),
	)
}

func generatedAccountUser(user *authbridge.UserInfo) *tuttigenerated.AccountUserInfo {
	if user == nil || user.UserID == "" {
		return nil
	}
	return &tuttigenerated.AccountUserInfo{
		Avatar: stringPointer(user.Avatar),
		Email:  stringPointer(user.Email),
		Name:   stringPointer(user.Name),
		UserId: user.UserID,
	}
}

func generatedAccountMembership(membership *accountservice.MembershipSummary) *tuttigenerated.AccountMembershipSummary {
	if membership == nil || membership.TierKey == "" {
		return nil
	}
	return &tuttigenerated.AccountMembershipSummary{
		TierKey:           membership.TierKey,
		DisplayName:       membership.DisplayName,
		BillingPeriod:     stringPointer(membership.BillingPeriod),
		Status:            stringPointer(membership.Status),
		AccessStatus:      stringPointer(membership.AccessStatus),
		CurrentPeriodEnd:  stringPointer(membership.CurrentPeriodEnd),
		CancelAtPeriodEnd: membership.CancelAtPeriodEnd,
	}
}

func generatedAccountCredits(credits *accountservice.CreditsSummary) *tuttigenerated.AccountCreditsSummary {
	if credits == nil {
		return nil
	}
	return &tuttigenerated.AccountCreditsSummary{
		AvailableCredits:         credits.AvailableCredits,
		ExpiringCreditsWithin24h: credits.ExpiringCreditsWithin24h,
		NextExpireAt:             stringPointer(credits.NextExpireAt),
		RefreshedAt:              stringPointer(credits.RefreshedAt),
	}
}

func generatedAccountProductPartialError(partialError *accountservice.ProductSummaryPartialError) *tuttigenerated.AccountProductSummaryPartialError {
	if partialError == nil || partialError.Code == "" {
		return nil
	}
	return &tuttigenerated.AccountProductSummaryPartialError{
		Scope:   generatedAccountProductPartialErrorScope(partialError.Scope),
		Code:    partialError.Code,
		Message: stringPointer(partialError.Message),
	}
}

func generatedAccountProductPartialErrorScope(scope string) tuttigenerated.AccountProductSummaryPartialErrorScope {
	switch scope {
	case "membership":
		return tuttigenerated.AccountProductSummaryPartialErrorScopeMembership
	case "credits":
		return tuttigenerated.AccountProductSummaryPartialErrorScopeCredits
	case "links":
		return tuttigenerated.AccountProductSummaryPartialErrorScopeLinks
	default:
		return tuttigenerated.AccountProductSummaryPartialErrorScopeUnknown
	}
}
