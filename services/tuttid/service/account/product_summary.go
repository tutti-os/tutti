package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/httpx"
	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
)

const (
	defaultCommerceBaseURL  = "https://tutti.sh/api/commerce"
	defaultWebBaseURL       = "https://tutti.sh"
	productSummaryTimeout   = 5 * time.Second
	productSummaryBodyLimit = 1 << 20
)

type ProductSummary struct {
	User                      *authbridge.UserInfo
	Membership                *MembershipSummary
	Credits                   *CreditsSummary
	RegistrationCreditsReward *RegistrationCreditsReward
	PartialError              *ProductSummaryPartialError
	Links                     ProductSummaryLinks
}

type MembershipSummary struct {
	TierKey           string
	DisplayName       string
	BillingPeriod     string
	Status            string
	AccessStatus      string
	CurrentPeriodEnd  string
	CancelAtPeriodEnd *bool
}

type CreditsSummary struct {
	AvailableCredits         *string
	ExpiringCreditsWithin24h *string
	NextExpireAt             string
	RefreshedAt              string
}

type ProductSummaryPartialError struct {
	Scope   string
	Code    string
	Message string
}

type ProductSummaryLinks struct {
	PlanURL     string
	UsageURL    string
	SettingsURL string
}

func (s *Service) productSummary(ctx context.Context) (ProductSummary, error) {
	links := s.productSummaryLinks()
	slog.Info("account product summary requested", "event", "account.product_summary.requested")
	client, err := s.authClient()
	if err != nil {
		slog.Warn("account product summary auth client unavailable",
			"event", "account.product_summary.auth_client_failed",
			"error", err,
		)
		return ProductSummary{Links: links}, err
	}
	session, err := client.ReadSession()
	if err != nil || session == nil {
		slog.Info("account product summary skipped without session",
			"event", "account.product_summary.no_session",
			"has_session", session != nil,
			"error", err,
		)
		return ProductSummary{Links: links}, err
	}
	user, err := client.GetUserInfo(ctx)
	if err != nil {
		slog.Warn("account product summary user info unavailable",
			"event", "account.product_summary.user_info_failed",
			"error", err,
		)
		return ProductSummary{Links: links}, err
	}
	if user == nil {
		slog.Info("account product summary skipped without user",
			"event", "account.product_summary.no_user",
		)
		return ProductSummary{Links: links}, nil
	}

	registrationCreditsReward := s.registrationCreditsReward(ctx, session, user)
	remote := s.fetchRemoteProductSummary(ctx, sessionCookie(session))
	summary := ProductSummary{
		User:                      user,
		Membership:                membershipSummary(remote.UserInfo),
		Credits:                   creditsSummary(remote.CreditsOverview, remote.UserInfo),
		RegistrationCreditsReward: registrationCreditsReward,
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

type remoteSummaryResult struct {
	UserInfo        map[string]any
	CreditsOverview map[string]any
	PartialError    *ProductSummaryPartialError
}

func (s *Service) fetchRemoteProductSummary(ctx context.Context, cookie string) remoteSummaryResult {
	ctx, cancel := context.WithTimeout(ctx, productSummaryTimeout)
	defer cancel()

	var userInfo map[string]any
	membershipErr := s.fetchSessionJSON(ctx, s.commerceBaseURL(), "/v1/user-info", cookie, &userInfo)

	var creditsOverview map[string]any
	creditsErr := s.fetchSessionJSON(ctx, s.commerceBaseURL(), "/v1/credits/overview", cookie, &creditsOverview)
	slog.Info("account product summary remote fetch completed",
		"event", "account.product_summary.remote_fetch_completed",
		"membership_error_code", productSummaryErrorCodeOrEmpty(membershipErr),
		"credits_error_code", productSummaryErrorCodeOrEmpty(creditsErr),
		"has_membership_payload", userInfo != nil,
		"has_credits_payload", creditsOverview != nil,
	)

	return remoteSummaryResult{
		UserInfo:        userInfo,
		CreditsOverview: creditsOverview,
		PartialError:    productSummaryPartialError(membershipErr, creditsErr),
	}
}

func productSummaryPartialError(membershipErr error, creditsErr error) *ProductSummaryPartialError {
	if membershipErr == nil && creditsErr == nil {
		return nil
	}
	if membershipErr != nil && creditsErr != nil {
		return &ProductSummaryPartialError{
			Scope:   "unknown",
			Code:    productSummaryErrorCode(membershipErr),
			Message: productSummaryErrorMessage(membershipErr),
		}
	}
	if membershipErr != nil {
		return &ProductSummaryPartialError{
			Scope:   "membership",
			Code:    productSummaryErrorCode(membershipErr),
			Message: productSummaryErrorMessage(membershipErr),
		}
	}
	return &ProductSummaryPartialError{
		Scope:   "credits",
		Code:    productSummaryErrorCode(creditsErr),
		Message: productSummaryErrorMessage(creditsErr),
	}
}

type productSummaryHTTPError struct {
	status int
}

func (e productSummaryHTTPError) Error() string {
	return fmt.Sprintf("request failed with status %d", e.status)
}

func productSummaryErrorCode(err error) string {
	var httpErr productSummaryHTTPError
	if errors.As(err, &httpErr) {
		if httpErr.status == http.StatusUnauthorized || httpErr.status == http.StatusForbidden {
			return "unauthorized"
		}
		return fmt.Sprintf("http_%d", httpErr.status)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	return "unavailable"
}

func productSummaryErrorMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func productSummaryErrorCodeOrEmpty(err error) string {
	if err == nil {
		return ""
	}
	return productSummaryErrorCode(err)
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

func (s *Service) fetchSessionJSON(ctx context.Context, baseURL string, path string, cookie string, out any) error {
	return s.sessionJSON(ctx, http.MethodGet, baseURL, path, cookie, nil, out)
}

func (s *Service) postSessionJSON(ctx context.Context, baseURL string, path string, cookie string, body io.Reader, out any) error {
	return s.sessionJSON(ctx, http.MethodPost, baseURL, path, cookie, body, out)
}

func (s *Service) sessionJSON(
	ctx context.Context,
	method string,
	baseURL string,
	path string,
	cookie string,
	body io.Reader,
	out any,
) error {
	req, err := http.NewRequestWithContext(ctx, method, buildRemoteURL(baseURL, path), body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := s.httpClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	rawBody, err := io.ReadAll(io.LimitReader(resp.Body, productSummaryBodyLimit))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return productSummaryHTTPError{status: resp.StatusCode}
	}
	if len(rawBody) == 0 || out == nil {
		return nil
	}
	return json.Unmarshal(rawBody, out)
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

func membershipSummary(data map[string]any) *MembershipSummary {
	if summary, ok := currentVIPMembershipSummary(data); ok {
		return summary
	}
	membership, ok := objectField(data, "membership")
	if !ok {
		return nil
	}
	tierKey := stringField(membership, "tier_key", "tierKey", "tier")
	if tierKey == "" {
		return nil
	}
	return &MembershipSummary{
		TierKey:           tierKey,
		DisplayName:       displayPlanName(tierKey),
		BillingPeriod:     stringField(membership, "billing_period", "billingPeriod"),
		Status:            stringField(membership, "status"),
		AccessStatus:      stringField(membership, "access_status", "accessStatus", "stripe_status", "stripeStatus"),
		CurrentPeriodEnd:  stringField(membership, "current_period_end", "currentPeriodEnd", "expired_at", "expiredAt"),
		CancelAtPeriodEnd: boolFieldPointer(membership, "cancel_at_period_end", "cancelAtPeriodEnd"),
	}
}

func currentVIPMembershipSummary(data map[string]any) (*MembershipSummary, bool) {
	vipLevel := strings.ToLower(stringField(data, "vip_level", "vipLevel"))
	isVIP := boolFieldPointer(data, "is_vip", "isVip")
	if isVIP == nil && vipLevel == "" {
		return nil, false
	}
	if isVIP == nil || !*isVIP || vipLevel == "" || vipLevel == "free" {
		return nil, true
	}
	periodEnd := stringField(data, "vip_renew_at", "vipRenewAt")
	if periodEnd == "" {
		periodEnd = stringField(data, "vip_valid_until", "vipValidUntil")
	}
	return &MembershipSummary{
		TierKey:           vipLevel,
		DisplayName:       displayPlanName(vipLevel),
		BillingPeriod:     stringField(data, "vip_billing_period", "vipBillingPeriod"),
		Status:            "active",
		AccessStatus:      "active",
		CurrentPeriodEnd:  periodEnd,
		CancelAtPeriodEnd: boolFieldPointer(data, "vip_cancel_at_period_end", "vipCancelAtPeriodEnd"),
	}, true
}

func creditsSummary(overview map[string]any, fallback map[string]any) *CreditsSummary {
	if len(overview) == 0 && len(fallback) == 0 {
		return nil
	}
	available := creditsStringFieldPointer(overview, "available_credits", "availableCredits", "totalAvailable", "balance")
	if available == nil {
		available = creditsStringFieldPointer(fallback, "available_credits", "availableCredits", "credits")
	}
	if available == nil {
		return nil
	}
	return &CreditsSummary{
		AvailableCredits:         available,
		ExpiringCreditsWithin24h: creditsStringFieldPointer(overview, "expiring_credits_within_24h", "expiringCreditsWithin24h"),
		NextExpireAt:             stringField(overview, "next_expire_at", "nextExpireAt"),
		RefreshedAt:              time.Now().UTC().Format(time.RFC3339),
	}
}

func displayPlanName(tierKey string) string {
	switch strings.ToLower(strings.TrimSpace(tierKey)) {
	case "free":
		return "Free"
	case "basic":
		return "Basic"
	case "pro":
		return "Pro"
	case "ultra":
		return "Ultra"
	default:
		return strings.TrimSpace(tierKey)
	}
}

func objectField(data map[string]any, keys ...string) (map[string]any, bool) {
	for _, key := range keys {
		if value, ok := data[key].(map[string]any); ok {
			return value, true
		}
	}
	return nil, false
}

func boolFieldPointer(data map[string]any, keys ...string) *bool {
	for _, key := range keys {
		if value, ok := data[key].(bool); ok {
			return &value
		}
	}
	return nil
}

func stringField(data map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := data[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func creditsStringFieldPointer(data map[string]any, keys ...string) *string {
	for _, key := range keys {
		switch value := data[key].(type) {
		case float64:
			result := strconv.FormatFloat(value, 'f', -1, 64)
			return &result
		case int64:
			result := strconv.FormatInt(value, 10)
			return &result
		case int:
			result := strconv.Itoa(value)
			return &result
		case json.Number:
			result := strings.TrimSpace(value.String())
			if result != "" {
				return &result
			}
		case string:
			result := strings.TrimSpace(value)
			if result != "" {
				return &result
			}
		}
	}
	return nil
}
