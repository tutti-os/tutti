package account

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

var ErrAttemptNotFound = errors.New("account login attempt not found")

type Service struct {
	AuthJSONPath   string
	AccountBaseURL string
	AppCallbackURL string
	AuthLoginURL   string

	mu       sync.Mutex
	client   *authbridge.Client
	attempts map[string]*authbridge.LoginAttempt
}

type LoginStart struct {
	AttemptID string
	ExpiresAt int64
	LoginURL  string
}

func NewService(authJSONPath string) *Service {
	return &Service{
		AuthJSONPath:   firstNonEmpty(authJSONPath, filepath.Join(tuttitypes.DefaultStateDir(), "account", "auth.json")),
		AccountBaseURL: os.Getenv("TUTTI_ACCOUNT_BASE_URL"),
		AppCallbackURL: tuttitypes.DesktopLoginCallbackURL(),
		AuthLoginURL:   os.Getenv("TUTTI_AUTH_LOGIN_URL"),
		attempts:       map[string]*authbridge.LoginAttempt{},
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
	return status, nil
}

func (s *Service) GetUserInfo(ctx context.Context) (*authbridge.UserInfo, error) {
	client, err := s.authClient()
	if err != nil {
		return nil, err
	}
	return client.GetUserInfo(ctx)
}

func (s *Service) Logout(ctx context.Context) error {
	client, err := s.authClient()
	if err != nil {
		return err
	}
	return client.Logout(ctx)
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
