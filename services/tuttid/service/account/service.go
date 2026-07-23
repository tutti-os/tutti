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
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

var ErrAttemptNotFound = errors.New("account login attempt not found")

type Service struct {
	AuthJSONPath                       string
	AccountBaseURL                     string
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
	// OnLogoutCompleted runs after the desktop account auth state has been
	// cleared. It should avoid long-running work; downstream providers should
	// clear local readiness markers before starting background network cleanup.
	OnLogoutCompleted func(context.Context)

	mu       sync.Mutex
	client   *authbridge.Client
	attempts map[string]*authbridge.LoginAttempt

	commerceMu sync.Mutex
	commerce   *commerce.Service
}

type LoginStart struct {
	AttemptID string
	ExpiresAt int64
	LoginURL  string
}

func NewService(authJSONPath string) *Service {
	return &Service{
		AuthJSONPath:    firstNonEmpty(authJSONPath, filepath.Join(tuttitypes.DefaultStateDir(), "account", "auth.json")),
		AccountBaseURL:  os.Getenv("TUTTI_ACCOUNT_BASE_URL"),
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
		return LoginStart{}, err
	}
	attempt, err := client.StartLogin(context.WithoutCancel(ctx))
	if err != nil {
		return LoginStart{}, err
	}
	s.mu.Lock()
	s.attempts[attempt.ID] = attempt
	s.mu.Unlock()
	return LoginStart{
		AttemptID: attempt.ID,
		ExpiresAt: attempt.ExpiresAt.UnixMilli(),
		LoginURL:  attempt.LoginURL,
	}, nil
}

func (s *Service) LoginStatus(attemptID string) (authbridge.LoginStatus, error) {
	s.mu.Lock()
	attempt := s.attempts[strings.TrimSpace(attemptID)]
	s.mu.Unlock()
	if attempt == nil {
		return authbridge.LoginStatus{}, ErrAttemptNotFound
	}
	status := attempt.Status()
	if status.Status != "pending" {
		s.mu.Lock()
		delete(s.attempts, attempt.ID)
		s.mu.Unlock()
	}
	if status.Status == "completed" {
		s.notifyLoginCompleted()
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
	return client.GetUserInfo(ctx)
}

func (s *Service) GetProductSummary(ctx context.Context) (ProductSummary, error) {
	return s.productSummary(ctx)
}

func (s *Service) Logout(ctx context.Context) error {
	client, err := s.authClient()
	if err != nil {
		return err
	}
	if err := client.Logout(ctx); err != nil {
		return err
	}
	s.notifyLogoutCompleted()
	return nil
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
