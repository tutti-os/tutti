package agentsidecar

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
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const (
	tuttiAgentLLMProviderID      = "tutti-llm"
	tuttiAgentDefaultLLMBaseURL  = "https://llm-api.tutti.sh/v1"
	tuttiAgentDefaultModel       = "gpt-5.4"
	tuttiAgentAccountBaseURL     = "https://tutti.sh/api/account"
	tuttiAgentLLMTokenIssueRoute = "/auth/v1/llm-token"
)

var tuttiAgentDefaultLLMAppID = "nex" + "top"

// TuttiAgentPreparer materializes the session-scoped TUTTI_AGENT_HOME for the
// tutti-agent provider, a Codex CLI fork that authenticates against the Tutti
// model gateway with host-issued `tutti_llm` tokens.
type TuttiAgentPreparer struct{}

func (TuttiAgentPreparer) Provider() string {
	return "tutti-agent"
}

func (TuttiAgentPreparer) Prepare(ctx context.Context, input ProviderPrepareInput) (ProviderPrepareResult, error) {
	home := filepath.Join(input.RuntimeRoot, "tutti-agent-home")
	logRuntimePrepareTrace("runtime_prepare.tutti_agent.entered", input.PrepareInput, nil)
	// Token bootstrap targets the durable user home so every session shares one
	// refresh-token family; the rotated refresh flow revokes the whole family on
	// replay, so per-session token copies are unsafe.
	bootstrapTuttiAgentUserAuth(ctx, input.PrepareInput)
	if err := PrepareTuttiAgentHome(home, input.PrepareInput); err != nil {
		return ProviderPrepareResult{}, err
	}
	logRuntimePrepareTrace("runtime_prepare.tutti_agent.home_prepared", input.PrepareInput, nil)
	instructionsPath := filepath.Join(home, "AGENTS.md")
	writeResult, err := input.Store.WriteManagedBlock(instructionsPath, tuttiCLIPolicy(input.PrepareInput))
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	if input.Manifest != nil {
		input.Manifest.RecordManagedFile(instructionsPath, "provider-instructions", writeResult.Created)
		input.Manifest.RecordManagedFile(home, "tutti-agent-home", true)
	}
	logRuntimePrepareTrace("runtime_prepare.tutti_agent.resolved", input.PrepareInput, nil)
	return ProviderPrepareResult{
		Cwd: input.Cwd,
		Env: []string{
			"TUTTI_AGENT_HOME=" + home,
		},
	}, nil
}

// PrepareTuttiAgentHome materializes a TUTTI_AGENT_HOME with the user's auth
// exposed and a session-safe config pinned to the Tutti LLM gateway.
func PrepareTuttiAgentHome(home string, input PrepareInput) error {
	if err := os.MkdirAll(home, 0o700); err != nil {
		return fmt.Errorf("create tutti-agent home: %w", err)
	}
	if err := exposeUserTuttiAgentFiles(home); err != nil {
		return err
	}
	return ensureTuttiAgentSessionConfig(filepath.Join(home, "config.toml"), input)
}

// exposeUserTuttiAgentFiles links the durable user auth into the session home
// and copies the user config as the session config baseline. auth.json must be
// a symlink (not a copy) so the SDK's refresh-token rotation stays on a single
// shared token family.
func exposeUserTuttiAgentFiles(home string) error {
	userHome, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(userHome) == "" {
		return nil
	}
	userAgentHome := filepath.Join(userHome, ".tutti-agent")
	source := filepath.Join(userAgentHome, "auth.json")
	if _, err := os.Stat(source); err == nil {
		target := filepath.Join(home, "auth.json")
		if _, err := os.Lstat(target); os.IsNotExist(err) {
			if err := os.Symlink(source, target); err != nil {
				return fmt.Errorf("expose tutti-agent auth.json: %w", err)
			}
		}
	}
	target := filepath.Join(home, "config.toml")
	if _, err := os.Lstat(target); os.IsNotExist(err) {
		userConfig := filepath.Join(userAgentHome, "config.toml")
		if _, err := os.Stat(userConfig); err == nil {
			if err := copyFile(userConfig, target, 0o600); err != nil {
				return fmt.Errorf("copy tutti-agent config: %w", err)
			}
		}
	}
	return nil
}

func ensureTuttiAgentSessionConfig(configPath string, input PrepareInput) error {
	contentBytes, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read tutti-agent config: %w", err)
	}
	next, changed := codexConfigWithProjectRootMarkersDisabled(string(contentBytes))
	if tuttiNext, tuttiChanged := codexConfigWithTuttiConversationDetailMode(next, input.ConversationDetailMode); tuttiChanged {
		next = tuttiNext
		changed = true
	}
	if detailModeNext, detailModeChanged := codexConfigWithConversationDetailModeInstructions(next, input.ConversationDetailMode); detailModeChanged {
		next = detailModeNext
		changed = true
	}
	if providerNext, providerChanged := tuttiAgentConfigWithLLMProvider(next); providerChanged {
		next = providerNext
		changed = true
	}
	if !changed {
		return nil
	}
	if err := os.WriteFile(configPath, []byte(next), 0o600); err != nil {
		return fmt.Errorf("write tutti-agent config: %w", err)
	}
	return nil
}

// tuttiAgentConfigWithLLMProvider pins the session config to a gateway-backed
// model provider that carries no env_key requirement. The fork's built-in
// `tutti-agent` provider demands TUTTI_AGENT_API_KEY and short-circuits the
// stored `tutti_llm` bearer auth, so sessions must select a custom provider
// entry for host-token auth to be used at all.
func tuttiAgentConfigWithLLMProvider(content string) (string, bool) {
	changed := false
	content, changed = tuttiAgentConfigWithRootValue(content, "model_provider", tuttiAgentLLMProviderID, changed)
	content, changed = tuttiAgentConfigWithRootValue(content, "model", tuttiAgentDefaultModel, changed)
	sectionHeader := "[model_providers." + tuttiAgentLLMProviderID + "]"
	if !strings.Contains(content, sectionHeader) {
		block := sectionHeader + "\n" +
			`name = "Tutti LLM"` + "\n" +
			`base_url = ` + strconv.Quote(tuttiAgentLLMBaseURL()) + "\n" +
			`wire_api = "responses"` + "\n"
		if strings.TrimSpace(content) == "" {
			content = block
		} else {
			content = strings.TrimRight(content, "\r\n") + "\n\n" + block
		}
		changed = true
	}
	return content, changed
}

func tuttiAgentConfigWithRootValue(content string, key string, value string, changed bool) (string, bool) {
	line := key + " = " + strconv.Quote(value)
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	lines := strings.Split(normalized, "\n")
	for index, current := range lines {
		trimmed := strings.TrimSpace(current)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			lines = append(lines[:index], append([]string{line}, lines[index:]...)...)
			return strings.Join(lines, "\n"), true
		}
		if codexConfigLineHasKey(trimmed, key) {
			if strings.TrimSpace(current) == line {
				return content, changed
			}
			lines[index] = line
			return strings.Join(lines, "\n"), true
		}
	}
	if strings.TrimSpace(content) == "" {
		return line + "\n", true
	}
	return line + "\n" + strings.TrimLeft(normalized, "\n"), true
}

func tuttiAgentLLMBaseURL() string {
	if value := strings.TrimSpace(os.Getenv("TUTTI_AGENT_LLM_BASE_URL")); value != "" {
		return value
	}
	return tuttiAgentDefaultLLMBaseURL
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
	bootstrapTuttiAgentUserAuth(ctx, PrepareInput{})
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
			if err := revokeTuttiAgentLLMToken(revokeCtx, accountBaseURL, refreshToken); err != nil {
				slog.Warn("tutti-agent llm token revoke failed", "error", err)
			}
		}()
	}
	return nil
}

// bootstrapTuttiAgentUserAuth is the provider-prepare variant that preserves
// runtime prepare trace context when a real Tutti Agent session is starting.
func bootstrapTuttiAgentUserAuth(ctx context.Context, input PrepareInput) {
	cookie, ok := tuttiAgentAccountSessionCookie()
	if !ok {
		if err := logoutTuttiAgentUserAuth(ctx); err != nil {
			slog.Warn("tutti-agent auth cleanup without host session failed", "error", err)
		}
		logRuntimePrepareTrace("runtime_prepare.tutti_agent.auth_bootstrap_skipped", input, map[string]any{
			"reason": "no_host_account_session",
		})
		return
	}
	if tuttiAgentUserAuthReady() {
		return
	}
	bundle, err := issueTuttiAgentLLMToken(ctx, cookie)
	if err != nil {
		slog.Warn("tutti-agent llm token issue failed", "error", err)
		if tuttiAgentLLMTokenIssueRejectedWithCode(err, http.StatusUnauthorized) {
			if cleanupErr := logoutTuttiAgentUserAuth(ctx); cleanupErr != nil {
				slog.Warn("tutti-agent auth cleanup after token rejection failed", "error", cleanupErr)
			}
		}
		return
	}
	if err := runTuttiAgentTokenLogin(ctx, bundle); err != nil {
		slog.Warn("tutti-agent token login failed", "error", err)
		return
	}
	logRuntimePrepareTrace("runtime_prepare.tutti_agent.auth_bootstrap_resolved", input, nil)
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

func revokeTuttiAgentLLMToken(ctx context.Context, accountBaseURL string, refreshToken string) error {
	requestBody, err := json.Marshal(map[string]string{
		"refresh_token": refreshToken,
		"reason":        "logout",
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
