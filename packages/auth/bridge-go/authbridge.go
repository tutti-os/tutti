package authbridge

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	DefaultAppID              = "nextop"
	DefaultAccountBaseURL     = "https://tutti.sh/api/account"
	DefaultAuthLoginURL       = "https://tutti.sh/auth/login"
	DefaultBridgeHost         = "127.0.0.1"
	DefaultBridgeBasePort     = 38473
	DefaultBridgeMaxPort      = 38492
	DefaultLoginIdleTimeout   = 90 * time.Second
	DefaultLoginMaxTimeout    = 5 * time.Minute
	statusPending             = "pending"
	statusCompleted           = "completed"
	statusFailed              = "failed"
	statusExpired             = "expired"
	bridgeFlowDesktop         = "desktop_bridge"
	bridgeStateVersion        = 1
	authJSONFileMode          = 0o600
	authJSONDirectoryFileMode = 0o755
)

// ErrUserCancelled identifies a desktop login that the user explicitly cancelled.
var ErrUserCancelled = errors.New("user cancelled")

// IsUserCancelled reports whether err represents an explicit user cancellation.
func IsUserCancelled(err error) bool {
	return errors.Is(err, ErrUserCancelled)
}

type Config struct {
	AccountBaseURL   string
	AppCallbackURL   string
	AppID            string
	AuthJSONPath     string
	AuthLoginURL     string
	BridgeHost       string
	BridgeBasePort   int
	BridgeMaxPort    int
	ClientVersion    string
	DeviceID         string
	DeviceName       string
	Hostname         string
	HTTPClient       *http.Client
	LoginIdleTimeout time.Duration
	LoginMaxTimeout  time.Duration
	OpenURL          func(context.Context, string) error
}

type Client struct {
	config Config
	http   *http.Client
}

type UserInfo struct {
	UserID string `json:"user_id"`
	Name   string `json:"name,omitempty"`
	Email  string `json:"email,omitempty"`
	Avatar string `json:"avatar,omitempty"`
}

type Session struct {
	SessionID string `json:"session_id"`
	Cookie    string `json:"cookie"`
	UserID    string `json:"user_id"`
	Name      string `json:"name"`
	Avatar    string `json:"avatar"`
	Email     string `json:"email"`
	UpdatedAt int64  `json:"updatedAt"`
}

type LoginResult struct {
	Session Session  `json:"session"`
	User    UserInfo `json:"user"`
}

type LoginStatus struct {
	AttemptID string    `json:"attempt_id"`
	Error     string    `json:"error,omitempty"`
	ExpiresAt time.Time `json:"expires_at"`
	Status    string    `json:"status"`
	User      *UserInfo `json:"user,omitempty"`
}

type LoginAttempt struct {
	ID        string
	LoginURL  string
	ExpiresAt time.Time

	client      *Client
	state       string
	bridgeToken string
	deviceID    string
	origin      string
	server      *http.Server
	listener    net.Listener
	maxExpires  time.Time
	idleTimeout time.Duration

	mu       sync.Mutex
	status   string
	err      error
	user     *UserInfo
	done     chan struct{}
	doneOnce sync.Once
}

type bridgeState struct {
	Version           int    `json:"v"`
	Flow              string `json:"flow"`
	AttemptID         string `json:"attemptId"`
	LocalServerOrigin string `json:"localServerOrigin"`
	BridgeToken       string `json:"bridgeToken"`
	AppID             string `json:"appId"`
	AppCallbackURL    string `json:"appCallbackUrl"`
	DeviceID          string `json:"deviceId,omitempty"`
	DeviceName        string `json:"deviceName,omitempty"`
	ClientVersion     string `json:"clientVersion,omitempty"`
	Hostname          string `json:"hostname,omitempty"`
}

type accountEnvelope struct {
	Code    int             `json:"code"`
	ErrMsg  string          `json:"errmsg"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

func NewClient(config Config) (*Client, error) {
	normalized := normalizeConfig(config)
	if strings.TrimSpace(normalized.AuthJSONPath) == "" {
		return nil, errors.New("auth json path is required")
	}
	if strings.TrimSpace(normalized.AppCallbackURL) == "" {
		return nil, errors.New("app callback url is required")
	}
	if _, err := url.ParseRequestURI(normalized.AppCallbackURL); err != nil {
		return nil, fmt.Errorf("invalid app callback url: %w", err)
	}
	if _, err := url.ParseRequestURI(normalized.AuthLoginURL); err != nil {
		return nil, fmt.Errorf("invalid auth login url: %w", err)
	}
	httpClient := normalized.HTTPClient
	if httpClient == nil {
		// This package is a standalone module and intentionally preserves the
		// caller's process-wide default client customizations.
		httpClient = http.DefaultClient //nolint:forbidigo
	}
	return &Client{config: normalized, http: httpClient}, nil
}

func (c *Client) StartLogin(ctx context.Context) (*LoginAttempt, error) {
	if c == nil {
		return nil, errors.New("auth client is nil")
	}
	listener, origin, err := listenBridge(c.config.BridgeHost, c.config.BridgeBasePort, c.config.BridgeMaxPort)
	if err != nil {
		return nil, err
	}

	attemptID := randomID()
	bridgeToken := randomID()
	now := time.Now()
	maxExpires := now.Add(c.config.LoginMaxTimeout)
	state := bridgeState{
		Version:           bridgeStateVersion,
		Flow:              bridgeFlowDesktop,
		AttemptID:         attemptID,
		LocalServerOrigin: origin,
		BridgeToken:       bridgeToken,
		AppID:             c.config.AppID,
		AppCallbackURL:    c.config.AppCallbackURL,
		DeviceID:          firstNonEmpty(c.config.DeviceID, randomID()),
		DeviceName:        firstNonEmpty(c.config.DeviceName, c.config.Hostname, "Desktop"),
		ClientVersion:     c.config.ClientVersion,
		Hostname:          c.config.Hostname,
	}
	encodedState, err := encodeBridgeState(state)
	if err != nil {
		_ = listener.Close()
		return nil, err
	}

	attempt := &LoginAttempt{
		ID:          attemptID,
		LoginURL:    buildLoginURL(c.config.AuthLoginURL, encodedState),
		ExpiresAt:   maxExpires,
		bridgeToken: bridgeToken,
		client:      c,
		deviceID:    state.DeviceID,
		done:        make(chan struct{}),
		idleTimeout: c.config.LoginIdleTimeout,
		listener:    listener,
		maxExpires:  maxExpires,
		origin:      origin,
		state:       encodedState,
		status:      statusPending,
	}
	attempt.server = &http.Server{Handler: attempt}

	go attempt.serve()
	go attempt.wait(ctx)

	return attempt, nil
}

func (c *Client) Login(ctx context.Context) (LoginResult, error) {
	attempt, err := c.StartLogin(ctx)
	if err != nil {
		return LoginResult{}, err
	}
	if c.config.OpenURL != nil {
		if err := c.config.OpenURL(ctx, attempt.LoginURL); err != nil {
			attempt.fail(err)
			return LoginResult{}, err
		}
	}
	<-attempt.done
	status := attempt.Status()
	if status.Status != statusCompleted {
		if attemptErr := attempt.resultError(); attemptErr != nil {
			return LoginResult{}, attemptErr
		}
		if status.Error != "" {
			return LoginResult{}, errors.New(status.Error)
		}
		return LoginResult{}, errors.New("login did not complete")
	}
	session, err := c.ReadSession()
	if err != nil {
		return LoginResult{}, err
	}
	if session == nil || status.User == nil {
		return LoginResult{}, errors.New("login session is missing")
	}
	return LoginResult{Session: *session, User: *status.User}, nil
}

func (c *Client) GetUserInfo(ctx context.Context) (*UserInfo, error) {
	session, err := c.ReadSession()
	if err != nil || session == nil {
		return nil, err
	}
	user, err := c.fetchUserInfo(ctx, session.Cookie)
	if err != nil || user == nil {
		return user, err
	}
	if err := c.writeAuthJSON(sessionFromUser(session.SessionID, *user)); err != nil {
		return nil, err
	}
	return user, nil
}

func (c *Client) Logout(ctx context.Context) error {
	session, err := c.ReadSession()
	if err != nil {
		return err
	}
	if session != nil {
		_ = c.logoutSession(ctx, session.Cookie)
	}
	if err := os.Remove(c.config.AuthJSONPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (c *Client) ReadSession() (*Session, error) {
	raw, err := os.ReadFile(c.config.AuthJSONPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var payload struct {
		SessionID string `json:"session_id"`
		Cookie    string `json:"cookie"`
		UserID    string `json:"user_id"`
		Name      string `json:"name"`
		Avatar    string `json:"avatar"`
		Email     string `json:"email"`
		UpdatedAt int64  `json:"updatedAt"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	if strings.TrimSpace(payload.SessionID) == "" {
		return nil, nil
	}
	session := sessionFromUser(payload.SessionID, UserInfo{
		UserID: payload.UserID,
		Name:   payload.Name,
		Email:  payload.Email,
		Avatar: payload.Avatar,
	})
	if payload.Cookie != "" {
		session.Cookie = payload.Cookie
	}
	if payload.UpdatedAt > 0 {
		session.UpdatedAt = payload.UpdatedAt
	}
	return &session, nil
}

func (a *LoginAttempt) Status() LoginStatus {
	a.mu.Lock()
	defer a.mu.Unlock()
	status := a.status
	if status == statusPending && time.Now().After(a.ExpiresAt) {
		status = statusExpired
	}
	out := LoginStatus{
		AttemptID: a.ID,
		ExpiresAt: a.ExpiresAt,
		Status:    status,
		User:      a.user,
	}
	if a.err != nil {
		out.Error = a.err.Error()
	}
	return out
}

func (a *LoginAttempt) resultError() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.err
}

func (a *LoginAttempt) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		if !a.allowedOrigin(r) || !a.allowedHost(r) {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		sendBridgeCORS(w, http.StatusNoContent)
		return
	}

	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/oauth/health":
		a.handleHealth(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/oauth/callback":
		a.handleCallback(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/oauth/complete":
		a.handleComplete(w, r)
	default:
		sendBridgeJSON(w, http.StatusNotFound, map[string]any{"ok": false})
	}
}

func (a *LoginAttempt) handleHealth(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	matched := a.status == statusPending &&
		time.Now().Before(a.ExpiresAt) &&
		time.Now().Before(a.maxExpires) &&
		r.URL.Query().Get("attempt_id") == a.ID &&
		r.URL.Query().Get("token") == a.bridgeToken
	if matched {
		a.ExpiresAt = minTime(a.maxExpires, time.Now().Add(a.idleTimeout))
	}
	expiresAt := a.ExpiresAt
	a.mu.Unlock()

	if !matched {
		sendBridgeJSON(w, http.StatusUnauthorized, map[string]any{
			"ok": false,
			"error": map[string]string{
				"code":    "INVALID_BRIDGE_ATTEMPT",
				"message": "Desktop login attempt is unavailable.",
			},
		})
		return
	}
	sendBridgeJSON(w, http.StatusOK, map[string]any{
		"ok": true,
		"data": map[string]any{
			"attemptId": a.ID,
			"status":    "ready",
			"expiresAt": expiresAt.UnixMilli(),
		},
	})
}

func (a *LoginAttempt) handleComplete(w http.ResponseWriter, r *http.Request) {
	if !a.allowedOrigin(r) || !a.allowedHost(r) {
		sendBridgeJSON(w, http.StatusForbidden, map[string]any{"ok": false})
		return
	}
	var payload map[string]any
	if err := readJSON(r.Body, &payload); err != nil {
		sendBridgeJSON(w, http.StatusBadRequest, map[string]any{"ok": false})
		go a.fail(err)
		return
	}
	callbackError := stringField(payload, "error")
	callbackState := stringField(payload, "state")
	transferCode := stringField(payload, "transfer_code", "transferCode")
	if !a.stateMatches(callbackState) {
		err := errors.New("invalid state")
		sendBridgeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": map[string]string{"code": "INVALID_STATE", "message": err.Error()}})
		go a.fail(err)
		return
	}
	if strings.TrimSpace(callbackError) != "" {
		err := callbackErrorValue(callbackError)
		errorCode := "PROVIDER_CALLBACK_ERROR"
		if IsUserCancelled(err) {
			errorCode = "USER_CANCELLED"
		}
		sendBridgeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": map[string]string{"code": errorCode, "message": err.Error()}})
		go a.fail(err)
		return
	}
	if strings.TrimSpace(transferCode) == "" {
		err := errors.New("missing transfer_code")
		sendBridgeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": map[string]string{"code": "MISSING_TRANSFER_CODE", "message": err.Error()}})
		go a.fail(err)
		return
	}
	sendBridgeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": map[string]string{"status": statusCompleted}})
	go a.complete(transferCode)
}

func (a *LoginAttempt) handleCallback(w http.ResponseWriter, r *http.Request) {
	if !a.allowedHost(r) {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	query := r.URL.Query()
	callbackError := strings.TrimSpace(query.Get("error"))
	callbackState := strings.TrimSpace(query.Get("state"))
	transferCode := strings.TrimSpace(query.Get("transfer_code"))
	if !a.stateMatches(callbackState) {
		err := errors.New("invalid state")
		redirectBridgeResult(w, r, a, "error", "invalidState")
		a.markFailed(err)
		a.closeGracefully()
		return
	}
	if callbackError != "" {
		err := callbackErrorValue(callbackError)
		redirectBridgeResult(w, r, a, "error", callbackErrorSafeResultCode(callbackError))
		a.markFailed(err)
		a.closeGracefully()
		return
	}
	if transferCode == "" {
		err := errors.New("missing transfer_code")
		redirectBridgeResult(w, r, a, "error", "missingTransferCode")
		a.markFailed(err)
		a.closeGracefully()
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := a.completeWithContext(ctx, transferCode); err != nil {
		redirectBridgeResult(w, r, a, "error", "redeemFailed")
		a.closeGracefully()
		return
	}
	redirectBridgeResult(w, r, a, "success", "")
	a.closeGracefully()
}

func (a *LoginAttempt) complete(transferCode string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	_ = a.completeWithContext(ctx, transferCode)
	a.close()
}

func (a *LoginAttempt) completeWithContext(ctx context.Context, transferCode string) error {
	sessionID, err := a.client.redeemTransferCode(ctx, a, transferCode)
	if err != nil {
		a.markFailed(err)
		return err
	}
	user, err := a.client.fetchUserInfo(ctx, buildSessionCookie(sessionID))
	if err != nil {
		a.markFailed(err)
		return err
	}
	if user == nil {
		err := errors.New("failed to load user info after login")
		a.markFailed(err)
		return err
	}
	if err := a.client.writeAuthJSON(sessionFromUser(sessionID, *user)); err != nil {
		a.markFailed(err)
		return err
	}
	a.mu.Lock()
	a.status = statusCompleted
	a.user = user
	a.mu.Unlock()
	return nil
}

func (a *LoginAttempt) wait(ctx context.Context) {
	t := time.NewTimer(time.Until(a.maxExpires))
	defer t.Stop()
	select {
	case <-a.done:
	case <-ctx.Done():
		a.fail(ctx.Err())
	case <-t.C:
		a.fail(errors.New("login timed out"))
	}
}

func (a *LoginAttempt) serve() {
	err := a.server.Serve(a.listener)
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		a.fail(err)
	}
}

func (a *LoginAttempt) fail(err error) {
	a.markFailed(err)
	a.close()
}

func (a *LoginAttempt) markFailed(err error) {
	a.mu.Lock()
	if a.status == statusCompleted {
		a.mu.Unlock()
		return
	}
	if time.Now().After(a.ExpiresAt) {
		a.status = statusExpired
	} else {
		a.status = statusFailed
	}
	a.err = err
	a.mu.Unlock()
}

func (a *LoginAttempt) close() {
	_ = a.server.Close()
	a.doneOnce.Do(func() {
		close(a.done)
	})
}

func (a *LoginAttempt) closeGracefully() {
	a.doneOnce.Do(func() {
		close(a.done)
	})
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = a.server.Shutdown(ctx)
	}()
}

func (a *LoginAttempt) allowedOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	authURL, err := url.Parse(a.client.config.AuthLoginURL)
	return err == nil && origin == authURL.Scheme+"://"+authURL.Host
}

func (a *LoginAttempt) allowedHost(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		host = r.Host
	}
	return host == a.client.config.BridgeHost || host == "localhost"
}

func (a *LoginAttempt) stateMatches(raw string) bool {
	state, err := decodeBridgeState(raw)
	if err != nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.status == statusPending &&
		time.Now().Before(a.maxExpires) &&
		state.Flow == bridgeFlowDesktop &&
		state.AttemptID == a.ID &&
		state.BridgeToken == a.bridgeToken &&
		state.AppID == a.client.config.AppID &&
		state.AppCallbackURL == a.client.config.AppCallbackURL &&
		state.LocalServerOrigin == a.origin
}

func (c *Client) redeemTransferCode(ctx context.Context, attempt *LoginAttempt, transferCode string) (string, error) {
	body := map[string]string{
		"transfer_code": transferCode,
		"attempt_id":    attempt.ID,
		"bridge_token":  attempt.bridgeToken,
		"app_id":        c.config.AppID,
		"device_id":     attempt.deviceID,
	}
	var data struct {
		SessionIDLegacy string `json:"session_id"`
		SessionID       string `json:"sessionId"`
	}
	if err := c.postAccount(ctx, "/auth/v1/redeem_desktop_transfer_code", "", body, &data); err != nil {
		return "", err
	}
	sessionID := firstNonEmpty(data.SessionIDLegacy, data.SessionID)
	if strings.TrimSpace(sessionID) == "" {
		return "", errors.New("redeem response missing session_id")
	}
	return sessionID, nil
}

func (c *Client) fetchUserInfo(ctx context.Context, cookie string) (*UserInfo, error) {
	var raw map[string]any
	if err := c.postAccount(ctx, "/user/v1/user_info", cookie, map[string]any{}, &raw); err != nil {
		if errors.Is(err, errUnauthorized) {
			return nil, nil
		}
		return nil, err
	}
	user := mapUserInfo(raw)
	if user.UserID == "" {
		return nil, nil
	}
	return &user, nil
}

func (c *Client) logoutSession(ctx context.Context, cookie string) error {
	return c.postAccount(ctx, "/auth/v1/logout-web-session", cookie, map[string]string{"app_id": c.config.AppID}, nil)
}

func (c *Client) postAccount(ctx context.Context, path string, cookie string, body any, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, buildAccountURL(c.config.AccountBaseURL, path), bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var envelope accountEnvelope
	if err := readJSON(resp.Body, &envelope); err != nil {
		return err
	}
	if resp.StatusCode == http.StatusUnauthorized || envelope.Code == http.StatusUnauthorized {
		return errUnauthorized
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || envelope.Code != 0 {
		message := firstNonEmpty(envelope.ErrMsg, envelope.Message, fmt.Sprintf("request failed with status %d", resp.StatusCode))
		return errors.New(message)
	}
	if out != nil && len(envelope.Data) > 0 {
		return json.Unmarshal(envelope.Data, out)
	}
	return nil
}

func (c *Client) writeAuthJSON(session Session) error {
	if err := os.MkdirAll(filepath.Dir(c.config.AuthJSONPath), authJSONDirectoryFileMode); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(session, "", "  ")
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp-%d-%s", c.config.AuthJSONPath, os.Getpid(), randomID())
	if err := os.WriteFile(tmp, raw, authJSONFileMode); err != nil {
		return err
	}
	if err := os.Rename(tmp, c.config.AuthJSONPath); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

var errUnauthorized = errors.New("unauthorized")

func normalizeConfig(config Config) Config {
	config.AppID = firstNonEmpty(config.AppID, DefaultAppID)
	config.AccountBaseURL = firstNonEmpty(config.AccountBaseURL, DefaultAccountBaseURL)
	config.AuthLoginURL = firstNonEmpty(config.AuthLoginURL, DefaultAuthLoginURL)
	config.BridgeHost = firstNonEmpty(config.BridgeHost, DefaultBridgeHost)
	if config.BridgeBasePort == 0 {
		config.BridgeBasePort = DefaultBridgeBasePort
	}
	if config.BridgeMaxPort == 0 {
		config.BridgeMaxPort = DefaultBridgeMaxPort
	}
	if config.LoginIdleTimeout <= 0 {
		config.LoginIdleTimeout = DefaultLoginIdleTimeout
	}
	if config.LoginMaxTimeout <= 0 {
		config.LoginMaxTimeout = DefaultLoginMaxTimeout
	}
	if config.LoginMaxTimeout < config.LoginIdleTimeout {
		config.LoginMaxTimeout = config.LoginIdleTimeout
	}
	if config.Hostname == "" {
		if hostname, err := os.Hostname(); err == nil {
			config.Hostname = hostname
		}
	}
	return config
}

func listenBridge(host string, basePort int, maxPort int) (net.Listener, string, error) {
	if maxPort < basePort {
		maxPort = basePort
	}
	for port := basePort; port <= maxPort; port++ {
		addr := fmt.Sprintf("%s:%d", host, port)
		listener, err := net.Listen("tcp", addr)
		if err != nil {
			continue
		}
		return listener, "http://" + addr, nil
	}
	return nil, "", fmt.Errorf("no available bridge port in %d-%d", basePort, maxPort)
}

func encodeBridgeState(state bridgeState) (string, error) {
	raw, err := json.Marshal(state)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func decodeBridgeState(raw string) (bridgeState, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return bridgeState{}, err
	}
	var state bridgeState
	if err := json.Unmarshal(decoded, &state); err != nil {
		return bridgeState{}, err
	}
	if state.Version != bridgeStateVersion || state.Flow != bridgeFlowDesktop || state.AttemptID == "" || state.BridgeToken == "" {
		return bridgeState{}, errors.New("invalid bridge state")
	}
	return state, nil
}

func isAllowedAppCallbackScheme(scheme string) bool {
	switch strings.ToLower(strings.TrimSpace(scheme)) {
	case "tutti", "tutti-dev", "nextop", "nextop-dev":
		return true
	default:
		return false
	}
}

func buildAccountURL(baseURL string, path string) string {
	return strings.TrimRight(baseURL, "/") + "/" + strings.TrimLeft(path, "/")
}

func buildSessionCookie(sessionID string) string {
	return "session_id=" + strings.TrimSpace(sessionID)
}

func sessionFromUser(sessionID string, user UserInfo) Session {
	return Session{
		SessionID: strings.TrimSpace(sessionID),
		Cookie:    buildSessionCookie(sessionID),
		UserID:    user.UserID,
		Name:      user.Name,
		Avatar:    user.Avatar,
		Email:     user.Email,
		UpdatedAt: time.Now().UnixMilli(),
	}
}

func mapUserInfo(data map[string]any) UserInfo {
	return UserInfo{
		UserID: stringField(data, "userId", "user_id"),
		Name:   stringField(data, "name"),
		Email:  stringField(data, "email", "userEmail", "emailAddress"),
		Avatar: stringField(data, "avatar", "picture", "avatarUrl", "headImg"),
	}
}

func stringField(data map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := data[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func readJSON(reader io.Reader, out any) error {
	decoder := json.NewDecoder(reader)
	return decoder.Decode(out)
}

func sendBridgeJSON(w http.ResponseWriter, status int, body any) {
	sendBridgeCORS(w, status)
	_ = json.NewEncoder(w).Encode(body)
}

func sendBridgeCORS(w http.ResponseWriter, status int) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "content-type")
	w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
	w.Header().Set("Access-Control-Allow-Private-Network", "true")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
}

func randomID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return base64.RawURLEncoding.EncodeToString(bytes[:])
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func minTime(a time.Time, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
