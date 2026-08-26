package globalagentactivity

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
)

const defaultControlPlaneBaseURL = "https://api.tutti.sh"

var ErrUnauthenticated = errors.New("global agent activity requires an authenticated account")

type AccountSessionReader interface {
	ReadSession() (*authbridge.Session, error)
}

type Service struct {
	Account    AccountSessionReader
	BaseURL    string
	HTTPClient *http.Client
	PPELane    string
}

func NewService(account AccountSessionReader) *Service {
	return &Service{
		Account: account,
		BaseURL: firstNonEmpty(
			os.Getenv("TUTTI_AGENT_ACTIVITY_CONTROL_PLANE_BASE_URL"),
			defaultControlPlaneBaseURL,
		),
		PPELane: strings.TrimSpace(os.Getenv("TUTTI_PPE_LANE")),
	}
}

func (s *Service) FilterOptions(ctx context.Context) (*agentsessionstore.GlobalAgentActivityFilterOptions, error) {
	client, err := s.client()
	if err != nil {
		return nil, err
	}
	return client.GetGlobalAgentActivityFilterOptions(ctx)
}

func (s *Service) ListSessions(ctx context.Context, input agentsessionstore.ListGlobalAgentActivitySessionsInput) (*agentsessionstore.ListGlobalAgentActivitySessionsReply, error) {
	client, err := s.client()
	if err != nil {
		return nil, err
	}
	return client.ListGlobalAgentActivitySessions(ctx, input)
}

func (s *Service) client() (*agentsessionstore.Client, error) {
	if s == nil || s.Account == nil {
		return nil, ErrUnauthenticated
	}
	session, err := s.Account.ReadSession()
	if err != nil || session == nil || strings.TrimSpace(session.Cookie) == "" {
		return nil, ErrUnauthenticated
	}
	return agentsessionstore.NewClient(agentsessionstore.Config{
		BaseURL:       firstNonEmpty(s.BaseURL, defaultControlPlaneBaseURL),
		UserID:        strings.TrimSpace(session.UserID),
		SessionCookie: strings.TrimSpace(session.Cookie),
		PPELane:       strings.TrimSpace(s.PPELane),
		HTTPClient:    s.HTTPClient,
	}), nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
