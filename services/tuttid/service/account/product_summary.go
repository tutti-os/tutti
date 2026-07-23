package account

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/httpx"
	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
	"github.com/tutti-os/tutti/packages/commerce"
)

const (
	defaultCommerceBaseURL = "https://tutti.sh/api/commerce"
	defaultWebBaseURL      = "https://tutti.sh"
)

type ProductSummary struct {
	User                      *authbridge.UserInfo
	Membership                *MembershipSummary
	MembershipAccess          commerce.MembershipAccessState
	Credits                   *CreditsSummary
	RegistrationCreditsReward *RegistrationCreditsReward
	PartialError              *ProductSummaryPartialError
	Links                     ProductSummaryLinks
}

type MembershipSummary = commerce.MembershipSummary
type CreditsSummary = commerce.CreditsSummary
type ProductSummaryPartialError = commerce.ProductSummaryPartialError
type RegistrationCreditsReward = commerce.RegistrationCreditsReward

type ProductSummaryLinks struct {
	PlanURL     string
	UsageURL    string
	SettingsURL string
}

func (s *Service) productSummary(ctx context.Context) (ProductSummary, error) {
	links := s.productSummaryLinks()
	emptySummary := ProductSummary{
		MembershipAccess: commerce.MembershipAccessUnknown,
		Links:            links,
	}
	client, err := s.authClient()
	if err != nil {
		return emptySummary, err
	}
	session, err := client.ReadSession()
	if err != nil || session == nil {
		return emptySummary, err
	}
	user, err := client.GetUserInfo(ctx)
	if err != nil {
		return emptySummary, err
	}
	if user == nil {
		return emptySummary, nil
	}

	commerceService, err := s.commerceService()
	if err != nil {
		emptySummary.User = user
		return emptySummary, err
	}
	remote := commerceService.ProductSummary(ctx, user.UserID)
	summary := ProductSummary{
		User:                      user,
		Membership:                remote.Membership,
		MembershipAccess:          remote.MembershipAccess,
		Credits:                   remote.Credits,
		RegistrationCreditsReward: remote.RegistrationCreditsReward,
		PartialError:              remote.PartialError,
		Links:                     links,
	}
	slog.Info("account product summary completed",
		"event", "account.product_summary.completed",
		"user_hash", accountLogHash(user.UserID),
		"has_membership", summary.Membership != nil,
		"has_credits", summary.Credits != nil,
		"has_registration_credits_reward", summary.RegistrationCreditsReward != nil,
		"partial_error_scope", productSummaryPartialErrorScope(summary.PartialError),
		"partial_error_code", productSummaryPartialErrorCode(summary.PartialError),
	)
	return summary, nil
}

func (s *Service) commerceService() (*commerce.Service, error) {
	s.commerceMu.Lock()
	defer s.commerceMu.Unlock()
	if s.commerce != nil {
		return s.commerce, nil
	}
	service, err := commerce.NewService(commerce.Config{
		BaseURL:            s.commerceBaseURL(),
		HTTPClient:         s.httpClient(),
		Authorizer:         commerce.RequestAuthorizerFunc(s.authorizeCommerceRequest),
		RewardReceiptStore: &registrationCreditsRewardStore{path: s.registrationCreditsRewardStatePath()},
	})
	if err != nil {
		return nil, err
	}
	s.commerce = service
	return service, nil
}

func (s *Service) authorizeCommerceRequest(request *http.Request) error {
	client, err := s.authClient()
	if err != nil {
		return err
	}
	session, err := client.ReadSession()
	if err != nil {
		return err
	}
	cookie := sessionCookie(session)
	if cookie == "" {
		return errors.New("account session cookie is unavailable")
	}
	request.Header.Set("Cookie", cookie)
	return nil
}

func (s *Service) DismissRegistrationCreditsReward(ctx context.Context, rewardID string) error {
	service, err := s.commerceService()
	if err != nil {
		return err
	}
	return service.DismissRegistrationCreditsReward(ctx, rewardID)
}

func membershipSummary(data map[string]any) *MembershipSummary {
	return commerce.MembershipSummaryFromUserInfo(data)
}

func productSummaryPartialErrorScope(err *ProductSummaryPartialError) string {
	if err == nil {
		return ""
	}
	return err.Scope
}

func productSummaryPartialErrorCode(err *ProductSummaryPartialError) string {
	if err == nil {
		return ""
	}
	return err.Code
}

func (s *Service) productSummaryLinks() ProductSummaryLinks {
	base := firstNonEmpty(s.WebBaseURL, defaultWebBaseURL)
	return ProductSummaryLinks{
		PlanURL:     buildProfileURL(base, "/profile/plan"),
		UsageURL:    buildProfileURL(base, "/profile/usage"),
		SettingsURL: buildProfileURL(base, "/profile/settings"),
	}
}

func (s *Service) commerceBaseURL() string {
	return firstNonEmpty(s.CommerceBaseURL, defaultCommerceBaseURL)
}

func (s *Service) httpClient() *http.Client {
	if s.HTTPClient != nil {
		return s.HTTPClient
	}
	return httpx.Default()
}

func buildRemoteURL(baseURL string, path string) string {
	return strings.TrimRight(baseURL, "/") + "/" + strings.TrimLeft(path, "/")
}

func buildProfileURL(baseURL string, path string) string {
	parsed, err := url.Parse(firstNonEmpty(baseURL, defaultWebBaseURL))
	if err != nil {
		return buildRemoteURL(defaultWebBaseURL, path)
	}
	relative := &url.URL{Path: "/" + strings.TrimLeft(path, "/")}
	return parsed.ResolveReference(relative).String()
}

func sessionCookie(session *authbridge.Session) string {
	if session == nil {
		return ""
	}
	if strings.TrimSpace(session.Cookie) != "" {
		return strings.TrimSpace(session.Cookie)
	}
	if strings.TrimSpace(session.SessionID) == "" {
		return ""
	}
	return "session_id=" + strings.TrimSpace(session.SessionID)
}
