package modelgateway

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	defaultListenAddress   = "127.0.0.1:0"
	defaultRequestTimeout  = 10 * time.Minute
	defaultFirstTokenLimit = 90 * time.Second
	defaultMaxRequestBytes = 32 << 20
	defaultMaxErrorBytes   = 1 << 20
)

// Route is one session-scoped upstream Chat Completions destination. The
// upstream credential never leaves the gateway process.
type Route struct {
	WorkspaceID    string
	AgentSessionID string
	UpstreamURL    string
	UpstreamAPIKey string
	Models         []string
}

// ClientEndpoint is the temporary Responses endpoint injected into one Codex
// runtime. Token is random bearer authentication for this route, not the
// upstream model-plan credential.
type ClientEndpoint struct {
	BaseURL string
	Token   string
	WireAPI string
}

// Config controls the loopback gateway. Zero values select production
// defaults; tests can replace the client and timeout limits.
type Config struct {
	ListenAddress   string
	HTTPClient      *http.Client
	RequestTimeout  time.Duration
	FirstTokenLimit time.Duration
	MaxRequestBytes int64
	Logger          *slog.Logger
}

// Gateway owns the loopback listener and the in-memory session route table.
type Gateway struct {
	listener        net.Listener
	server          *http.Server
	client          *http.Client
	baseURL         string
	requestTimeout  time.Duration
	firstTokenLimit time.Duration
	maxRequestBytes int64
	logger          *slog.Logger

	mu        sync.RWMutex
	byToken   map[string]Route
	bySession map[string]string

	serveDone chan struct{}
	serveErr  error
	closeOnce sync.Once
}

// New starts a loopback-only Model Gateway.
func New(config Config) (*Gateway, error) {
	address := strings.TrimSpace(config.ListenAddress)
	if address == "" {
		address = defaultListenAddress
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return nil, fmt.Errorf("listen for model gateway: %w", err)
	}
	tcpAddress, ok := listener.Addr().(*net.TCPAddr)
	if !ok || tcpAddress.IP == nil || !tcpAddress.IP.IsLoopback() {
		_ = listener.Close()
		return nil, errors.New("model gateway listener must be loopback-only")
	}
	requestTimeout := config.RequestTimeout
	if requestTimeout <= 0 {
		requestTimeout = defaultRequestTimeout
	}
	firstTokenLimit := config.FirstTokenLimit
	if firstTokenLimit <= 0 {
		firstTokenLimit = defaultFirstTokenLimit
	}
	maxRequestBytes := config.MaxRequestBytes
	if maxRequestBytes <= 0 {
		maxRequestBytes = defaultMaxRequestBytes
	}
	logger := config.Logger
	if logger == nil {
		logger = slog.Default()
	}
	gateway := &Gateway{
		listener:        listener,
		client:          securedHTTPClient(config.HTTPClient),
		baseURL:         "http://" + listener.Addr().String(),
		requestTimeout:  requestTimeout,
		firstTokenLimit: firstTokenLimit,
		maxRequestBytes: maxRequestBytes,
		logger:          logger,
		byToken:         make(map[string]Route),
		bySession:       make(map[string]string),
		serveDone:       make(chan struct{}),
	}
	gateway.server = &http.Server{
		Handler:           gateway,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	go func() {
		defer close(gateway.serveDone)
		err := gateway.server.Serve(listener)
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			gateway.serveErr = err
		}
	}()
	return gateway, nil
}

func securedHTTPClient(input *http.Client) *http.Client {
	var client http.Client
	if input != nil {
		client = *input
	} else {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.ResponseHeaderTimeout = defaultFirstTokenLimit
		client.Transport = transport
	}
	previousCheck := client.CheckRedirect
	client.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if len(via) == 0 {
			return http.ErrUseLastResponse
		}
		origin := via[0].URL
		if !sameOrigin(origin, request.URL) {
			return http.ErrUseLastResponse
		}
		if previousCheck != nil {
			return previousCheck(request, via)
		}
		if len(via) >= 10 {
			return errors.New("stopped after 10 redirects")
		}
		return nil
	}
	return &client
}

func sameOrigin(left *url.URL, right *url.URL) bool {
	return left != nil && right != nil &&
		strings.EqualFold(left.Scheme, right.Scheme) &&
		strings.EqualFold(left.Host, right.Host)
}

// Register atomically replaces any existing route for the same
// workspace/session. The old token is invalid before the new endpoint is
// returned.
func (g *Gateway) Register(_ context.Context, route Route) (ClientEndpoint, error) {
	if g == nil {
		return ClientEndpoint{}, errors.New("model gateway is unavailable")
	}
	normalized, err := normalizeRoute(route)
	if err != nil {
		return ClientEndpoint{}, err
	}
	token, err := randomToken()
	if err != nil {
		return ClientEndpoint{}, fmt.Errorf("generate model gateway token: %w", err)
	}
	sessionKey := routeSessionKey(normalized.WorkspaceID, normalized.AgentSessionID)
	g.mu.Lock()
	if oldToken := g.bySession[sessionKey]; oldToken != "" {
		delete(g.byToken, oldToken)
	}
	g.byToken[token] = normalized
	g.bySession[sessionKey] = token
	g.mu.Unlock()
	return ClientEndpoint{
		BaseURL: g.baseURL + "/v1",
		Token:   token,
		WireAPI: "responses",
	}, nil
}

// Unregister revokes the current token for one workspace/session.
func (g *Gateway) Unregister(_ context.Context, workspaceID string, agentSessionID string) {
	if g == nil {
		return
	}
	sessionKey := routeSessionKey(workspaceID, agentSessionID)
	g.mu.Lock()
	token := g.bySession[sessionKey]
	delete(g.bySession, sessionKey)
	if token != "" {
		delete(g.byToken, token)
	}
	g.mu.Unlock()
}

func normalizeRoute(route Route) (Route, error) {
	route.WorkspaceID = strings.TrimSpace(route.WorkspaceID)
	route.AgentSessionID = strings.TrimSpace(route.AgentSessionID)
	route.UpstreamURL = strings.TrimSpace(route.UpstreamURL)
	route.UpstreamAPIKey = strings.TrimSpace(route.UpstreamAPIKey)
	if route.WorkspaceID == "" || route.AgentSessionID == "" ||
		route.UpstreamURL == "" || route.UpstreamAPIKey == "" {
		return Route{}, errors.New("model gateway route is incomplete")
	}
	parsed, err := url.Parse(route.UpstreamURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return Route{}, errors.New("model gateway upstream URL must be absolute")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return Route{}, errors.New("model gateway upstream URL must use http or https")
	}
	if parsed.User != nil {
		return Route{}, errors.New("model gateway upstream URL must not contain user information")
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	if !endsWithVersionSegment(parsed.Path) {
		parsed.Path += "/v1"
	}
	route.UpstreamURL = parsed.String() + "/chat/completions"
	seen := make(map[string]struct{}, len(route.Models))
	models := make([]string, 0, len(route.Models))
	for _, model := range route.Models {
		model = strings.TrimSpace(model)
		if model == "" {
			continue
		}
		if _, exists := seen[model]; exists {
			continue
		}
		seen[model] = struct{}{}
		models = append(models, model)
	}
	route.Models = models
	return route, nil
}

func endsWithVersionSegment(path string) bool {
	segments := strings.Split(strings.Trim(path, "/"), "/")
	if len(segments) == 0 {
		return false
	}
	last := segments[len(segments)-1]
	if len(last) < 2 || last[0] != 'v' {
		return false
	}
	for _, character := range last[1:] {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func routeSessionKey(workspaceID string, agentSessionID string) string {
	return strings.TrimSpace(workspaceID) + "\x00" + strings.TrimSpace(agentSessionID)
}

func randomToken() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func (g *Gateway) routeForRequest(request *http.Request) (Route, bool) {
	authorization := strings.TrimSpace(request.Header.Get("Authorization"))
	const prefix = "Bearer "
	if !strings.HasPrefix(authorization, prefix) {
		return Route{}, false
	}
	token := strings.TrimSpace(strings.TrimPrefix(authorization, prefix))
	g.mu.RLock()
	defer g.mu.RUnlock()
	for candidate, route := range g.byToken {
		if len(candidate) == len(token) &&
			subtle.ConstantTimeCompare([]byte(candidate), []byte(token)) == 1 {
			return route, true
		}
	}
	return Route{}, false
}

func (g *Gateway) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.URL.Path != "/v1/responses" || request.URL.RawQuery != "" {
		writeResponsesError(writer, http.StatusNotFound, "invalid_request_error", "not_found", "", "Only POST /v1/responses is supported")
		return
	}
	if request.Method != http.MethodPost {
		writer.Header().Set("Allow", http.MethodPost)
		writeResponsesError(writer, http.StatusMethodNotAllowed, "invalid_request_error", "method_not_allowed", "", "Only POST /v1/responses is supported")
		return
	}
	route, ok := g.routeForRequest(request)
	if !ok {
		writeResponsesError(writer, http.StatusUnauthorized, "invalid_request_error", "invalid_api_key", "", "Invalid model gateway token")
		return
	}
	g.handleResponses(writer, request, route)
}

// Close stops the listener and revokes every route.
func (g *Gateway) Close() error {
	if g == nil {
		return nil
	}
	var closeErr error
	g.closeOnce.Do(func() {
		g.mu.Lock()
		clear(g.byToken)
		clear(g.bySession)
		g.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		closeErr = g.server.Shutdown(ctx)
		if closeErr != nil {
			_ = g.server.Close()
		}
		<-g.serveDone
		if closeErr == nil {
			closeErr = g.serveErr
		}
	})
	return closeErr
}
