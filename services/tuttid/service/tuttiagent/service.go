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

	"github.com/tutti-os/tutti/packages/agent/daemon/httpx"
	"github.com/tutti-os/tutti/packages/agent/daemon/tuttiagentauth"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const (
	tuttiAgentAccountBaseURL     = "https://tutti.sh/api/account"
	tuttiAgentLLMTokenIssueRoute = "/auth/v1/llm-token"
)

var (
	tuttiAgentDefaultLLMAppID = "nex" + "top"
	tuttiAgentAuthReconciler  tuttiagentauth.Reconciler
)

// NewPreparer returns the shared runtime preparer with Tutti account bootstrap
// injected at the product boundary.
func NewPreparer() runtimeprep.TuttiAgentPreparer {
	return runtimeprep.TuttiAgentPreparer{BeforePrepare: bootstrapTuttiAgentUserAuth}
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
func BootstrapTuttiAgentUserAuth(ctx context.Context) {
	bootstrapTuttiAgentUserAuth(ctx, runtimeprep.PrepareInput{})
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
	target, err := tuttiAgentAuthReconciler.RemoveLocal(ctx, tuttiAgentUserCredentialStore{})
	if err != nil {
		return err
	}
	if target.Valid() {
		revokeCtx := context.WithoutCancel(ctx)
		go func() {
			if err := (tuttiAgentSessionAuthorizer{}).Revoke(revokeCtx, target, "logout"); err != nil {
				slog.Warn("tutti-agent llm token revoke failed", "error", err)
			}
		}()
	}
	return nil
}

// bootstrapTuttiAgentUserAuth is the provider-prepare variant that preserves
// runtime prepare trace context when a real Tutti Agent session is starting.
func bootstrapTuttiAgentUserAuth(ctx context.Context, input runtimeprep.PrepareInput) {
	cookie, ok := tuttiAgentAccountSessionCookie()
	if !ok {
		if err := logoutTuttiAgentUserAuth(ctx); err != nil {
			slog.Warn("tutti-agent auth cleanup without host session failed", "error", err)
		}
		slog.Debug("tutti-agent auth bootstrap skipped", "reason", "no_host_account_session", "agent_session_id", input.AgentSessionID)
		return
	}
	if tuttiAgentUserAuthMaterialReady() {
		return
	}
	_, err := tuttiAgentAuthReconciler.Reconcile(
		ctx,
		tuttiAgentSessionAuthorizer{cookie: cookie},
		tuttiAgentUserCredentialStore{},
		tuttiAgentLoginRunner{},
		time.Now().UTC(),
	)
	if err != nil {
		slog.Warn("tutti-agent auth reconcile failed", "error", err)
		if tuttiAgentLLMTokenIssueRejectedWithCode(err, http.StatusUnauthorized) {
			if cleanupErr := logoutTuttiAgentUserAuth(ctx); cleanupErr != nil {
				slog.Warn("tutti-agent auth cleanup after token rejection failed", "error", cleanupErr)
			}
		}
		return
	}
	slog.Debug("tutti-agent auth bootstrap resolved", "agent_session_id", input.AgentSessionID)
}

func tuttiAgentUserAuthMaterialReady() bool {
	state, err := (tuttiAgentUserCredentialStore{}).Inspect(context.Background())
	return err == nil && state.MaterialReady
}

func inspectTuttiAgentCredential(raw []byte) tuttiagentauth.CredentialState {
	var payload struct {
		TuttiLLM *struct {
			AccountBaseURL       string          `json:"account_base_url"`
			AccessToken          string          `json:"access_token"`
			AccessTokenExpiresAt json.RawMessage `json:"access_token_expires_at"`
			RefreshToken         string          `json:"refresh_token"`
		} `json:"tutti_llm"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return tuttiagentauth.CredentialState{}
	}
	if payload.TuttiLLM == nil ||
		strings.TrimSpace(payload.TuttiLLM.AccessToken) == "" ||
		strings.TrimSpace(payload.TuttiLLM.RefreshToken) == "" {
		return tuttiagentauth.CredentialState{}
	}
	state := tuttiagentauth.CredentialState{RevokeTarget: tuttiagentauth.RevokeTarget{
		AccountBaseURL: payload.TuttiLLM.AccountBaseURL,
		RefreshToken:   payload.TuttiLLM.RefreshToken,
	}}
	if strings.TrimSpace(state.RevokeTarget.AccountBaseURL) == "" {
		state.RevokeTarget.AccountBaseURL = tuttiAgentAccountBase()
	}
	expiresAt, ok := parseTuttiAgentTokenExpiresAt(payload.TuttiLLM.AccessTokenExpiresAt)
	if !ok {
		return state
	}
	state.MaterialReady = time.Now().UTC().Before(expiresAt)
	return state
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

type tuttiAgentLLMTokenBundle = tuttiagentauth.TokenBundle

type tuttiAgentSessionAuthorizer struct {
	cookie string
}

func (a tuttiAgentSessionAuthorizer) Issue(ctx context.Context) (tuttiagentauth.TokenBundle, error) {
	return issueTuttiAgentLLMToken(ctx, a.cookie)
}

func (tuttiAgentSessionAuthorizer) Revoke(ctx context.Context, target tuttiagentauth.RevokeTarget, reason string) error {
	return revokeTuttiAgentLLMToken(ctx, target.AccountBaseURL, target.RefreshToken, reason)
}

type tuttiAgentUserCredentialStore struct{}

func (tuttiAgentUserCredentialStore) Inspect(context.Context) (tuttiagentauth.CredentialState, error) {
	authPath, ok := userTuttiAgentAuthPath()
	if !ok {
		return tuttiagentauth.CredentialState{}, nil
	}
	raw, err := os.ReadFile(authPath)
	if errors.Is(err, os.ErrNotExist) {
		return tuttiagentauth.CredentialState{}, nil
	}
	if err != nil {
		return tuttiagentauth.CredentialState{}, fmt.Errorf("read tutti-agent auth state: %w", err)
	}
	return inspectTuttiAgentCredential(raw), nil
}

func (tuttiAgentUserCredentialStore) Remove(context.Context) error {
	authPath, ok := userTuttiAgentAuthPath()
	if !ok {
		return nil
	}
	if err := os.Remove(authPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove tutti-agent auth state: %w", err)
	}
	return nil
}

type tuttiAgentLoginRunner struct{}

func (tuttiAgentLoginRunner) Login(ctx context.Context, bundle tuttiagentauth.TokenBundle) error {
	return runTuttiAgentTokenLogin(ctx, bundle)
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
	}, nil
}

func revokeTuttiAgentLLMToken(ctx context.Context, accountBaseURL string, refreshToken string, reason string) error {
	requestBody, err := json.Marshal(map[string]string{
		"refresh_token": refreshToken,
		"reason":        strings.TrimSpace(reason),
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
		return fmt.Errorf("llm token revoke failed: status=%d body=%s", response.StatusCode, truncateForLog(string(body)))
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
	cmd := exec.CommandContext(loginCtx, binary, "login", "--with-tutti-llm-tokens")
	cmd.Stdin = bytes.NewReader(stdin)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("tutti-agent login failed: %w: %s", err, strings.TrimSpace(string(output)))
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

func truncateForLog(value string) string {
	trimmed := strings.TrimSpace(value)
	const limit = 4000
	if len(trimmed) <= limit {
		return trimmed
	}
	return trimmed[:limit]
}
