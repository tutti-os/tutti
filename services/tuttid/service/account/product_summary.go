package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	User         *authbridge.UserInfo
	Membership   *MembershipSummary
	Credits      *CreditsSummary
	PartialError *ProductSummaryPartialError
	Links        ProductSummaryLinks
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
	AvailableCredits         *int64
	ExpiringCreditsWithin24h *int64
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
	client, err := s.authClient()
	if err != nil {
		return ProductSummary{Links: links}, err
	}
	session, err := client.ReadSession()
	if err != nil || session == nil {
		return ProductSummary{Links: links}, err
	}
	user, err := client.GetUserInfo(ctx)
	if err != nil {
		return ProductSummary{Links: links}, err
	}
	if user == nil {
		return ProductSummary{Links: links}, nil
	}

	remote := s.fetchRemoteProductSummary(ctx, sessionCookie(session))
	summary := ProductSummary{
		User:         user,
		Membership:   membershipSummary(remote.UserInfo),
		Credits:      creditsSummary(remote.CreditsOverview, remote.UserInfo),
		PartialError: remote.PartialError,
		Links:        links,
	}
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

func (s *Service) fetchSessionJSON(ctx context.Context, baseURL string, path string, cookie string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, buildRemoteURL(baseURL, path), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := s.httpClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, productSummaryBodyLimit))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return productSummaryHTTPError{status: resp.StatusCode}
	}
	if len(body) == 0 || out == nil {
		return nil
	}
	return json.Unmarshal(body, out)
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

func creditsSummary(overview map[string]any, fallback map[string]any) *CreditsSummary {
	if len(overview) == 0 && len(fallback) == 0 {
		return nil
	}
	available := int64FieldPointer(overview, "available_credits", "availableCredits", "totalAvailable", "balance")
	if available == nil {
		available = int64FieldPointer(fallback, "available_credits", "availableCredits", "credits")
	}
	if available == nil {
		return nil
	}
	return &CreditsSummary{
		AvailableCredits:         available,
		ExpiringCreditsWithin24h: int64FieldPointer(overview, "expiring_credits_within_24h", "expiringCreditsWithin24h"),
		NextExpireAt:             stringField(overview, "next_expire_at", "nextExpireAt"),
		RefreshedAt:              time.Now().UTC().Format(time.RFC3339),
	}
}

func displayPlanName(tierKey string) string {
	switch strings.ToLower(strings.TrimSpace(tierKey)) {
	case "free":
		return "Free"
	case "basic":
		return "Lite"
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

func int64FieldPointer(data map[string]any, keys ...string) *int64 {
	for _, key := range keys {
		switch value := data[key].(type) {
		case float64:
			result := int64(value)
			return &result
		case int64:
			return &value
		case json.Number:
			if result, err := value.Int64(); err == nil {
				return &result
			}
		case string:
			if result, err := parseInt64(value); err == nil {
				return &result
			}
		}
	}
	return nil
}

func parseInt64(raw string) (int64, error) {
	return strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
}
