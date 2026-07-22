package tuttiagent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tutti-os/tutti/packages/agent/daemon/httpx"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const (
	tuttiAgentAccountBaseURL     = "https://tutti.sh/api/account"
	tuttiAgentLLMTokenIssueRoute = "/auth/v1/llm-token"
)

var tuttiAgentDefaultLLMAppID = "nex" + "top"

type AuthInvalidation interface {
	AuthInvalidated(provider string) bool
	ClearAuthInvalidated(provider string)
}

// NewPreparer returns the shared runtime preparer with Tutti account bootstrap
// injected at the product boundary.
func NewPreparer(invalidations ...AuthInvalidation) runtimeprep.TuttiAgentPreparer {
	invalidation := firstAuthInvalidation(invalidations)
	return runtimeprep.TuttiAgentPreparer{BeforePrepare: func(ctx context.Context, input runtimeprep.PrepareInput) {
		bootstrapTuttiAgentUserAuth(ctx, input, invalidation)
	}}
}

func PrepareHome(home string) error {
	return runtimeprep.PrepareTuttiAgentHome(home, runtimeprep.PrepareInput{})
}

func tuttiAgentLLMAppID() string {
	if value := strings.TrimSpace(os.Getenv("TUTTI_AGENT_LLM_APP_ID")); value != "" {
		return value
	}
	return tuttiAgentDefaultLLMAppID
}

func tuttiAgentAccountBase() string {
	if value := strings.TrimSpace(os.Getenv("TUTTI_ACCOUNT_BASE_URL")); value != "" {
		return value
	}
	return tuttiAgentAccountBaseURL
}

// BootstrapTuttiAgentUserAuth exchanges the host account session for a Tutti
// LLM token bundle and hands it to `tutti-agent login --with-tutti-llm-tokens`
// so the durable user home gains a usable `tutti_llm` auth entry. Best-effort:
// failures leave the session in the auth-required state that the provider
// status service already reports.
func BootstrapTuttiAgentUserAuth(ctx context.Context, invalidations ...AuthInvalidation) {
	bootstrapTuttiAgentUserAuth(ctx, runtimeprep.PrepareInput{}, firstAuthInvalidation(invalidations))
}

func firstAuthInvalidation(invalidations []AuthInvalidation) AuthInvalidation {
	if len(invalidations) == 0 {
		return nil
	}
	return invalidations[0]
}

// LogoutTuttiAgentUserAuth removes the local auth marker synchronously so
// provider readiness reflects the host account logout, then revokes the Tutti
// Agent LLM refresh token in the background when one was present.
func LogoutTuttiAgentUserAuth(ctx context.Context) {
	if err := logoutTuttiAgentUserAuth(ctx); err != nil {
		slog.Warn("tutti-agent auth cleanup failed", "error", err)
	}
}

func logoutTuttiAgentUserAuth(ctx context.Context) error {
	authPath, ok := userTuttiAgentAuthPath()
	if !ok {
		return nil
	}
	return withTuttiAgentCredentialLock(ctx, authPath, func() error {
		return logoutTuttiAgentUserAuthUnlocked(ctx, authPath)
	})
}

func logoutTuttiAgentUserAuthUnlocked(ctx context.Context, authPath string) error {
	if _, err := os.Stat(authPath); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return fmt.Errorf("stat tutti-agent auth.json: %w", err)
	}
	raw, readErr := os.ReadFile(authPath)
	if readErr != nil {
		slog.Warn("read tutti-agent auth before cleanup failed", "error", readErr)
	}
	removeErr := os.Remove(authPath)
	if removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
		return fmt.Errorf("remove tutti-agent auth.json: %w", removeErr)
	}
	if refreshToken, accountBaseURL, ok := parseTuttiAgentLLMRevokeTarget(raw); ok {
		revokeCtx := context.WithoutCancel(ctx)
		go func() {
			if err := revokeTuttiAgentLLMToken(revokeCtx, accountBaseURL, refreshToken, "logout"); err != nil {
				slog.Warn("tutti-agent llm token revoke failed", "error", err)
			}
		}()
	}
	return nil
}

// bootstrapTuttiAgentUserAuth is the provider-prepare variant that preserves
// runtime prepare trace context when a real Tutti Agent session is starting.
func bootstrapTuttiAgentUserAuth(ctx context.Context, input runtimeprep.PrepareInput, invalidation AuthInvalidation) {
	authPath, ok := userTuttiAgentAuthPath()
	if !ok {
		return
	}
	if err := withTuttiAgentCredentialLock(ctx, authPath, func() error {
		bootstrapTuttiAgentUserAuthLocked(ctx, input, invalidation, authPath)
		return nil
	}); err != nil {
		slog.Warn("tutti-agent auth bootstrap lock failed", "error", err, "agent_session_id", input.AgentSessionID)
	}
}

func bootstrapTuttiAgentUserAuthLocked(ctx context.Context, input runtimeprep.PrepareInput, invalidation AuthInvalidation, authPath string) {
	cookie, ok := tuttiAgentAccountSessionCookie()
	if !ok {
		if err := logoutTuttiAgentUserAuthUnlocked(ctx, authPath); err != nil {
			slog.Warn("tutti-agent auth cleanup without host session failed", "error", err)
		}
		slog.Debug("tutti-agent auth bootstrap skipped", "reason", "no_host_account_session", "agent_session_id", input.AgentSessionID)
		return
	}
	provider := (runtimeprep.TuttiAgentPreparer{}).Provider()
	forceBootstrap := invalidation != nil && invalidation.AuthInvalidated(provider)
	if !forceBootstrap && tuttiAgentUserAuthReady() {
		return
	}
	if forceBootstrap {
		if err := logoutTuttiAgentUserAuthUnlocked(ctx, authPath); err != nil {
			slog.Warn("tutti-agent invalid auth cleanup failed", "error", err)
			return
		}
	}
	bundle, err := issueTuttiAgentLLMToken(ctx, cookie)
	if err != nil {
		slog.Warn("tutti-agent llm token issue failed", "error", err)
		if tuttiAgentLLMTokenIssueRejectedWithCode(err, http.StatusUnauthorized) {
			if cleanupErr := logoutTuttiAgentUserAuthUnlocked(ctx, authPath); cleanupErr != nil {
				slog.Warn("tutti-agent auth cleanup after token rejection failed", "error", cleanupErr)
			}
		}
		return
	}
	if err := runTuttiAgentTokenLogin(ctx, bundle); err != nil {
		slog.Warn("tutti-agent token login failed", "error", err)
		if revokeErr := revokeTuttiAgentLLMToken(
			context.WithoutCancel(ctx),
			bundle.AccountBaseURL,
			bundle.RefreshToken,
			"login_failed",
		); revokeErr != nil {
			slog.Warn("tutti-agent token cleanup after login failure failed", "error", revokeErr)
		}
		return
	}
	if invalidation != nil {
		invalidation.ClearAuthInvalidated(provider)
	}
	slog.Debug(
		"tutti-agent auth bootstrap resolved",
		"agent_session_id", input.AgentSessionID,
		"app_id", bundle.AppID,
		"access_expires_at", bundle.AccessTokenExpiresAt,
		"refresh_expires_at", bundle.RefreshTokenExpiresAt,
		"scope_count", len(bundle.Scopes),
		"forced", forceBootstrap,
	)
}

func tuttiAgentUserAuthReady() bool {
	authPath, ok := userTuttiAgentAuthPath()
	if !ok {
		return false
	}
	raw, err := os.ReadFile(authPath)
	if err != nil {
		return false
	}
	var payload struct {
		TuttiLLM *struct {
			AccessToken          string          `json:"access_token"`
			AccessTokenExpiresAt json.RawMessage `json:"access_token_expires_at"`
			RefreshToken         string          `json:"refresh_token"`
		} `json:"tutti_llm"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return false
	}
	if payload.TuttiLLM == nil ||
		strings.TrimSpace(payload.TuttiLLM.AccessToken) == "" ||
		strings.TrimSpace(payload.TuttiLLM.RefreshToken) == "" {
		return false
	}
	expiresAt, ok := parseTuttiAgentTokenExpiresAt(payload.TuttiLLM.AccessTokenExpiresAt)
	if !ok {
		return false
	}
	return time.Now().UTC().Before(expiresAt)
}

func parseTuttiAgentTokenExpiresAt(raw json.RawMessage) (time.Time, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return time.Time{}, false
	}
	var numeric int64
	if err := json.Unmarshal(raw, &numeric); err == nil && numeric > 0 {
		return time.Unix(numeric, 0).UTC(), true
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return time.Time{}, false
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return time.Time{}, false
	}
	if parsed, err := time.Parse(time.RFC3339, text); err == nil {
		return parsed.UTC(), true
	}
	numeric, err := strconv.ParseInt(text, 10, 64)
	if err != nil || numeric <= 0 {
		return time.Time{}, false
	}
	return time.Unix(numeric, 0).UTC(), true
}

func userTuttiAgentAuthPath() (string, bool) {
	userHome, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(userHome) == "" {
		return "", false
	}
	return filepath.Join(userHome, ".tutti-agent", "auth.json"), true
}

func tuttiAgentAccountSessionCookie() (string, bool) {
	raw, err := os.ReadFile(filepath.Join(tuttitypes.DefaultStateDir(), "account", "auth.json"))
	if err != nil {
		return "", false
	}
	var payload struct {
		SessionID string `json:"session_id"`
		Cookie    string `json:"cookie"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", false
	}
	if cookie := strings.TrimSpace(payload.Cookie); cookie != "" {
		return cookie, true
	}
	if sessionID := strings.TrimSpace(payload.SessionID); sessionID != "" {
		return "session_id=" + sessionID, true
	}
	return "", false
}

type tuttiAgentLLMTokenBundle struct {
	AppID                 string   `json:"app_id"`
	AccountBaseURL        string   `json:"account_base_url"`
	AccessToken           string   `json:"access_token"`
	AccessTokenExpiresAt  int64    `json:"access_token_expires_at"`
	RefreshToken          string   `json:"refresh_token"`
	RefreshTokenExpiresAt int64    `json:"refresh_token_expires_at"`
	TokenType             string   `json:"token_type"`
	Scopes                []string `json:"scopes"`
	CredentialGeneration  string   `json:"credential_generation"`
}

type tuttiAgentLLMTokenIssueRejectedError struct {
	Code   int
	Errmsg string
}

func (e tuttiAgentLLMTokenIssueRejectedError) Error() string {
	return fmt.Sprintf("llm token issue rejected: code=%d errmsg=%s", e.Code, e.Errmsg)
}

func tuttiAgentLLMTokenIssueRejectedWithCode(err error, code int) bool {
	var rejected tuttiAgentLLMTokenIssueRejectedError
	return errors.As(err, &rejected) && rejected.Code == code
}

func issueTuttiAgentLLMToken(ctx context.Context, cookie string) (tuttiAgentLLMTokenBundle, error) {
	requestBody, err := json.Marshal(map[string]any{
		"requested_app_id": tuttiAgentLLMAppID(),
		"scopes":           []string{"llm:models", "llm:chat"},
	})
	if err != nil {
		return tuttiAgentLLMTokenBundle{}, err
	}
	issueCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(issueCtx, http.MethodPost, tuttiAgentAccountBase()+tuttiAgentLLMTokenIssueRoute, bytes.NewReader(requestBody))
	if err != nil {
		return tuttiAgentLLMTokenBundle{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Cookie", cookie)
	response, err := httpx.Default().Do(request)
	if err != nil {
		return tuttiAgentLLMTokenBundle{}, err
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return tuttiAgentLLMTokenBundle{}, err
	}
	var payload struct {
		Code   int    `json:"code"`
		Errmsg string `json:"errmsg"`
		Data   struct {
			AccessToken           string   `json:"accessToken"`
			AccessTokenExpiresAt  string   `json:"accessTokenExpiresAt"`
			RefreshToken          string   `json:"refreshToken"`
			RefreshTokenExpiresAt string   `json:"refreshTokenExpiresAt"`
			TokenType             string   `json:"tokenType"`
			AppID                 string   `json:"appId"`
			Scopes                []string `json:"scopes"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return tuttiAgentLLMTokenBundle{}, fmt.Errorf("decode llm token response (status %d): %w", response.StatusCode, err)
	}
	if payload.Code != 0 {
		return tuttiAgentLLMTokenBundle{}, tuttiAgentLLMTokenIssueRejectedError{
			Code:   payload.Code,
			Errmsg: payload.Errmsg,
		}
	}
	accessExpires, _ := strconv.ParseInt(strings.TrimSpace(payload.Data.AccessTokenExpiresAt), 10, 64)
	refreshExpires, _ := strconv.ParseInt(strings.TrimSpace(payload.Data.RefreshTokenExpiresAt), 10, 64)
	return tuttiAgentLLMTokenBundle{
		AppID:                 payload.Data.AppID,
		AccountBaseURL:        tuttiAgentAccountBase(),
		AccessToken:           payload.Data.AccessToken,
		AccessTokenExpiresAt:  accessExpires,
		RefreshToken:          payload.Data.RefreshToken,
		RefreshTokenExpiresAt: refreshExpires,
		TokenType:             payload.Data.TokenType,
		Scopes:                payload.Data.Scopes,
		CredentialGeneration:  uuid.NewString(),
	}, nil
}

func parseTuttiAgentLLMRevokeTarget(raw []byte) (string, string, bool) {
	var payload struct {
		TuttiLLM *struct {
			AccountBaseURL string `json:"account_base_url"`
			RefreshToken   string `json:"refresh_token"`
		} `json:"tutti_llm"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || payload.TuttiLLM == nil {
		return "", "", false
	}
	refreshToken := strings.TrimSpace(payload.TuttiLLM.RefreshToken)
	if refreshToken == "" {
		return "", "", false
	}
	accountBaseURL := strings.TrimSpace(payload.TuttiLLM.AccountBaseURL)
	if accountBaseURL == "" {
		accountBaseURL = tuttiAgentAccountBase()
	}
	return refreshToken, accountBaseURL, true
}

func revokeTuttiAgentLLMToken(ctx context.Context, accountBaseURL string, refreshToken string, reason string) error {
	requestBody, err := json.Marshal(map[string]string{
		"refresh_token": refreshToken,
		"reason":        reason,
	})
	if err != nil {
		return err
	}
	revokeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(
		revokeCtx,
		http.MethodPost,
		strings.TrimRight(accountBaseURL, "/")+"/auth/v1/llm-token/revoke",
		bytes.NewReader(requestBody),
	)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := httpx.Default().Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("llm token revoke failed: status=%d", response.StatusCode)
	}
	var payload struct {
		Code   int    `json:"code"`
		Errmsg string `json:"errmsg"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return fmt.Errorf("decode llm token revoke response (status %d): %w", response.StatusCode, err)
	}
	if payload.Code != 0 {
		return fmt.Errorf("llm token revoke rejected: code=%d errmsg=%s", payload.Code, payload.Errmsg)
	}
	return nil
}

func runTuttiAgentTokenLogin(ctx context.Context, bundle tuttiAgentLLMTokenBundle) error {
	binary, err := resolveTuttiAgentBinary()
	if err != nil {
		return err
	}
	stdin, err := json.Marshal(bundle)
	if err != nil {
		return err
	}
	loginCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(
		loginCtx,
		binary,
		"-c",
		`cli_auth_credentials_store="file"`,
		"login",
		"--with-tutti-llm-tokens",
	)
	cmd.Stdin = bytes.NewReader(stdin)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("tutti-agent login failed: %w", err)
	}
	return nil
}

func resolveTuttiAgentBinary() (string, error) {
	if path, err := exec.LookPath("tutti-agent"); err == nil {
		return path, nil
	}
	if userHome, err := os.UserHomeDir(); err == nil && strings.TrimSpace(userHome) != "" {
		for _, candidate := range []string{
			filepath.Join(tuttitypes.DefaultStateDir(), "bin", "tutti-agent"),
			filepath.Join(userHome, "Library", "pnpm", "tutti-agent"),
			filepath.Join(userHome, ".local", "bin", "tutti-agent"),
		} {
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				return candidate, nil
			}
		}
	}
	return "", fmt.Errorf("tutti-agent binary not found")
}
