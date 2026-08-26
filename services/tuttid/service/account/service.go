package account

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
	"github.com/tutti-os/tutti/packages/commerce"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

var ErrAttemptNotFound = errors.New("account login attempt not found")

type Service struct {
	AuthJSONPath                       string
	AccountBaseURL                     string
	AccountHeaders                     http.Header
	AppCallbackURL                     string
	AuthLoginURL                       string
	CommerceBaseURL                    string
	WebBaseURL                         string
	RegistrationCreditsRewardStatePath string
	HTTPClient                         *http.Client
	// OnLoginCompleted runs after the desktop account login bridge has completed
	// and the account auth.json is available. It must be best-effort: login status
	// polling should not block on downstream provider credential bootstrap.
	OnLoginCompleted func(context.Context)
	// OnLogoutStarting runs synchronously while the authenticated cookie is
	// still readable. Hooks must be bounded and best-effort.
	OnLogoutStarting func(context.Context)
	// OnLogoutCompleted runs after the desktop account auth state has been
	// cleared. It should avoid long-running work; downstream providers should
	// clear local readiness markers before starting background network cleanup.
	OnLogoutCompleted func(context.Context)

	mu       sync.Mutex
	client   *authbridge.Client
	attempts map[string]*authbridge.LoginAttempt

	commerceMu sync.Mutex
	commerce   *commerce.Service

	analyticsMu         sync.RWMutex
	analyticsReporter   reporterservice.Reporter
	analyticsUserID     string
	analyticsMembership string
	analyticsTier       string
}

type LoginStart struct {
	AttemptID string
	ExpiresAt int64
	LoginURL  string
}

func NewService(authJSONPath string) *Service {
	accountHeaders := make(http.Header)
	if lane := strings.TrimSpace(os.Getenv("TUTTI_PPE_LANE")); lane != "" {
		accountHeaders.Set("x-zk-ppe-lane", lane)
	}
	return &Service{
		AuthJSONPath:    firstNonEmpty(authJSONPath, filepath.Join(tuttitypes.DefaultStateDir(), "account", "auth.json")),
		AccountBaseURL:  os.Getenv("TUTTI_ACCOUNT_BASE_URL"),
		AccountHeaders:  accountHeaders,
		AppCallbackURL:  tuttitypes.DesktopLoginCallbackURL(),
		AuthLoginURL:    os.Getenv("TUTTI_AUTH_LOGIN_URL"),
		CommerceBaseURL: os.Getenv("TUTTI_COMMERCE_BASE_URL"),
		WebBaseURL:      os.Getenv("TUTTI_WEB_BASE_URL"),
		attempts:        map[string]*authbridge.LoginAttempt{},
	}
}

func (s *Service) StartLogin(ctx context.Context) (LoginStart, error) {
	client, err := s.authClient()
	if err != nil {
		s.reportLogin(ctx, "", "login", "start", "failed", "auth_client_unavailable", nil)
		return LoginStart{}, err
	}
	attempt, err := client.StartLogin(context.WithoutCancel(ctx))
	if err != nil {
		s.reportLogin(ctx, "", "login", "start", "failed", "start_failed", nil)
		return LoginStart{}, err
	}
	s.mu.Lock()
	s.attempts[attempt.ID] = attempt
	s.mu.Unlock()
	s.reportLogin(ctx, attempt.ID, "login", "start", "started", "", nil)
	return LoginStart{
		AttemptID: attempt.ID,
		ExpiresAt: attempt.ExpiresAt.UnixMilli(),
		LoginURL:  attempt.LoginURL,
	}, nil
}

func (s *Service) LoginStatus(attemptID string) (authbridge.LoginStatus, error) {
	s.mu.Lock()
	attempt := s.attempts[strings.TrimSpace(attemptID)]
	if attempt == nil {
		s.mu.Unlock()
		return authbridge.LoginStatus{}, ErrAttemptNotFound
	}
	status := attempt.Status()
	if status.Status != "pending" {
		delete(s.attempts, attempt.ID)
	}
	s.mu.Unlock()
	if status.Status == "completed" {
		s.updateAnalyticsUser(status.User)
		s.reportLogin(context.Background(), attempt.ID, "login", "complete", "success", "", status.User)
		s.notifyLoginCompleted()
	} else if status.Status != "pending" {
		result, errorCode := loginAnalyticsResult(status.Status)
		s.reportLogin(context.Background(), attempt.ID, "login", "complete", result, errorCode, nil)
	}
	return status, nil
}

func (s *Service) notifyLoginCompleted() {
	if s.OnLoginCompleted == nil {
		return
	}
	go s.OnLoginCompleted(context.Background())
}

func (s *Service) GetUserInfo(ctx context.Context) (*authbridge.UserInfo, error) {
	client, err := s.authClient()
	if err != nil {
		return nil, err
	}
	user, err := client.GetUserInfo(ctx)
	if err == nil {
		s.updateAnalyticsUser(user)
	}
	return user, err
}

// ReadSession exposes the daemon-owned account session to trusted service
// adapters without returning credentials through the local HTTP API.
func (s *Service) ReadSession() (*authbridge.Session, error) {
	client, err := s.authClient()
	if err != nil {
		return nil, err
	}
	return client.ReadSession()
}

func (s *Service) GetProductSummary(ctx context.Context) (ProductSummary, error) {
	return s.productSummary(ctx)
}

func (s *Service) Logout(ctx context.Context) error {
	client, err := s.authClient()
	if err != nil {
		return err
	}
	if s.OnLogoutStarting != nil {
		s.OnLogoutStarting(ctx)
	}
	if err := client.Logout(ctx); err != nil {
		return err
	}
	s.clearAnalyticsIdentity()
	s.notifyLogoutCompleted()
	return nil
}

func (s *Service) SetAnalyticsReporter(reporter reporterservice.Reporter) {
	s.analyticsMu.Lock()
	s.analyticsReporter = reporter
	s.analyticsMu.Unlock()
	s.restoreAnalyticsIdentity()
}

func (s *Service) restoreAnalyticsIdentity() {
	session, err := s.ReadSession()
	if err != nil || session == nil || strings.TrimSpace(session.UserID) == "" {
		return
	}
	s.updateAnalyticsUser(&authbridge.UserInfo{UserID: session.UserID})
}

func (s *Service) AnalyticsContext() reporterservice.DynamicContext {
	s.analyticsMu.RLock()
	defer s.analyticsMu.RUnlock()
	params := map[string]any{
		"identity_status": "anonymous",
		"login_state":     "anonymous",
	}
	if s.analyticsUserID != "" {
		params["identity_status"] = "ready"
		params["login_state"] = "authenticated"
		params["membership_status"] = "unknown"
		params["membership_tier"] = "unknown"
		params["uid"] = s.analyticsUserID
	}
	if s.analyticsMembership != "" {
		params["membership_status"] = s.analyticsMembership
	}
	if s.analyticsTier != "" {
		params["membership_tier"] = s.analyticsTier
	}
	return reporterservice.DynamicContext{
		CommonParams: params,
		UserUniqueID: s.analyticsUserID,
	}
}

func (s *Service) reportLogin(
	ctx context.Context,
	flowID string,
	stage string,
	action string,
	result string,
	errorCode string,
	user *authbridge.UserInfo,
) {
	s.analyticsMu.RLock()
	reporter := s.analyticsReporter
	s.analyticsMu.RUnlock()
	if reporter == nil {
		return
	}
	params := map[string]any{
		"schema_version": 1,
		"client":         "desktop",
		"source":         "desktop_daemon",
		"auth_method":    "desktop_bridge",
		"auth_flow":      "desktop_bridge",
		"stage":          stage,
		"action":         action,
		"result":         result,
	}
	if flowID != "" {
		params["flow_id"] = flowID
	}
	if errorCode != "" {
		params["error_code"] = errorCode
	}
	if user != nil && strings.TrimSpace(user.UserID) != "" {
		params["uid"] = strings.TrimSpace(user.UserID)
	}
	reporter.Track(ctx, reporterservice.Event{
		Name:   "account.login",
		Params: params,
	})
}

func (s *Service) updateAnalyticsUser(user *authbridge.UserInfo) {
	if user == nil || strings.TrimSpace(user.UserID) == "" {
		return
	}
	s.analyticsMu.Lock()
	s.analyticsUserID = strings.TrimSpace(user.UserID)
	s.analyticsMu.Unlock()
}

func (s *Service) updateAnalyticsProductSummary(summary ProductSummary) {
	s.updateAnalyticsUser(summary.User)
	s.analyticsMu.Lock()
	s.analyticsMembership = string(summary.MembershipAccess)
	s.analyticsTier = ""
	if summary.Membership != nil {
		if strings.TrimSpace(summary.Membership.Status) != "" {
			s.analyticsMembership = strings.TrimSpace(summary.Membership.Status)
		}
		s.analyticsTier = strings.TrimSpace(summary.Membership.TierKey)
	} else if summary.MembershipAccess == commerce.MembershipAccessFree {
		s.analyticsTier = "free"
	}
	s.analyticsMu.Unlock()
}

func (s *Service) clearAnalyticsIdentity() {
	s.analyticsMu.Lock()
	s.analyticsUserID = ""
	s.analyticsMembership = ""
	s.analyticsTier = ""
	s.analyticsMu.Unlock()
}

func loginAnalyticsResult(status string) (result string, errorCode string) {
	switch strings.TrimSpace(status) {
	case "expired":
		return "expired", "attempt_expired"
	case "cancelled":
		return "cancelled", "user_cancelled"
	case "failed":
		return "failed", "authentication_failed"
	default:
		return "failed", "unknown_terminal_status"
	}
}

func (s *Service) notifyLogoutCompleted() {
	if s.OnLogoutCompleted == nil {
		return
	}
	s.OnLogoutCompleted(context.Background())
}

func (s *Service) authClient() (*authbridge.Client, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.client != nil {
		return s.client, nil
	}
	client, err := authbridge.NewClient(authbridge.Config{
		AccountBaseURL: s.AccountBaseURL,
		AccountHeaders: s.AccountHeaders,
		AuthJSONPath:   firstNonEmpty(s.AuthJSONPath, filepath.Join(tuttitypes.DefaultStateDir(), "account", "auth.json")),
		AppCallbackURL: firstNonEmpty(s.AppCallbackURL, tuttitypes.DesktopLoginCallbackURL()),
		AuthLoginURL:   s.AuthLoginURL,
		HTTPClient:     s.HTTPClient,
	})
	if err != nil {
		return nil, err
	}
	s.client = client
	if s.attempts == nil {
		s.attempts = map[string]*authbridge.LoginAttempt{}
	}
	return client, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
