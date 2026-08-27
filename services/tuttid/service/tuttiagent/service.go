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

type tuttiAgentAccountSessionState string

const (
	tuttiAgentAccountSessionPresent    tuttiAgentAccountSessionState = "present"
	tuttiAgentAccountSessionAbsent     tuttiAgentAccountSessionState = "absent"
	tuttiAgentAccountSessionUnreadable tuttiAgentAccountSessionState = "unreadable"
)

// NewPreparer returns the shared runtime preparer with Tutti account bootstrap
// and the daemon-owned stable Skill bundle store injected at the product boundary.
func NewPreparer(stateDir string) runtimeprep.TuttiAgentPreparer {
	stableRoot := filepath.Join(
		filepath.Clean(strings.TrimSpace(stateDir)),
		"agent",
	)
	return runtimeprep.TuttiAgentPreparer{
		BeforePrepare: bootstrapTuttiAgentUserAuthForPrepare,
		AuthProjector: runtimeprep.MutagenAuthFileProjector{StateDir: stateDir},
		StableSkillBundleRoot: filepath.Join(
			stableRoot,
			"skill-bundles",
		),
		StableSystemSkillBundleRoot: filepath.Join(stableRoot, "system-skill-bundles"),
	}
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
	bootstrapTuttiAgentUserAuth(ctx, runtimeprep.PrepareInput{}, "")
}

// BootstrapTuttiAgentUserAuthWithBinary reconciles auth with the exact managed
// runtime that passed provider readiness probing.
func BootstrapTuttiAgentUserAuthWithBinary(ctx context.Context, binaryPath string) {
	bootstrapTuttiAgentUserAuth(ctx, runtimeprep.PrepareInput{}, binaryPath)
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
	authLock, err := acquireTuttiAgentAuthMutationLock(ctx)
	if err != nil {
		return err
	}
	target, err := tuttiAgentAuthReconciler.RemoveLocal(ctx, tuttiAgentUserCredentialStore{})
	unlockErr := authLock.Unlock()
	if err != nil {
		return errors.Join(err, unlockErr)
	}
	slog.Info("tutti-agent auth removed",
		"event", "tutti_agent.auth_bootstrap",
		"action", "delete",
		"reason", "explicit_logout",
	)
	if target.Valid() {
		revokeCtx := context.WithoutCancel(ctx)
		go func() {
			if err := (tuttiAgentSessionAuthorizer{}).Revoke(revokeCtx, target, "logout"); err != nil {
				slog.Warn("tutti-agent llm token revoke failed", "error", err)
				return
			}
			slog.Info("tutti-agent llm token revoked",
				"event", "tutti_agent.auth_bootstrap",
				"action", "revoke",
				"reason", "explicit_logout",
			)
		}()
	}
	return unlockErr
}

// bootstrapTuttiAgentUserAuth is the provider-prepare variant that preserves
// runtime prepare trace context when a real Tutti Agent session is starting.
func bootstrapTuttiAgentUserAuthForPrepare(ctx context.Context, input runtimeprep.PrepareInput) {
	bootstrapTuttiAgentUserAuth(ctx, input, "")
}

func bootstrapTuttiAgentUserAuth(ctx context.Context, input runtimeprep.PrepareInput, binaryPath string) {
	cookie, state := tuttiAgentAccountSessionCookie()
	if state != tuttiAgentAccountSessionPresent {
		reason := "host_auth_absent"
		if state == tuttiAgentAccountSessionUnreadable {
			reason = "host_auth_unreadable"
		}
		logTuttiAgentAuthRetention(input.AgentSessionID, reason)
		return
	}
	authLock, err := acquireTuttiAgentAuthMutationLock(ctx)
	if err != nil {
		slog.Warn("tutti-agent auth mutation lock failed", "error", err)
		return
	}
	defer func() {
		if err := authLock.Unlock(); err != nil {
			slog.Warn("tutti-agent auth mutation unlock failed", "error", err)
		}
	}()
	if tuttiAgentUserAuthMaterialReady() {
		return
	}
	snapshot, err := captureTuttiAgentAuthSnapshot()
	if err != nil {
		slog.Warn("tutti-agent auth snapshot failed", "error", err)
		return
	}
	result, err := tuttiAgentAuthReconciler.Reconcile(
		ctx,
		tuttiAgentSessionAuthorizer{cookie: cookie},
		tuttiAgentUserCredentialStore{},
		tuttiAgentLoginRunner{BinaryPath: binaryPath},
		time.Now().UTC(),
	)
	if err != nil {
		if restoreErr := snapshot.Restore(); restoreErr != nil {
			err = errors.Join(err, fmt.Errorf("restore previous tutti-agent auth: %w", restoreErr))
		}
		logArgs := []any{"error", err}
		if stage := tuttiAgentAuthFailureStage(err); stage != "" {
			logArgs = append(logArgs, "stage", stage)
		}
		if detail := tuttiAgentAuthFailureDetail(err); detail != "" {
			logArgs = append(logArgs, "detail", detail)
		}
		slog.Warn("tutti-agent auth reconcile failed", logArgs...)
		if tuttiAgentLLMTokenIssueRejectedWithCode(err, http.StatusUnauthorized) {
			slog.Info("tutti-agent auth retained after token issue rejection",
				"event", "tutti_agent.auth_bootstrap",
				"action", "retain",
				"reason", "token_issue_rejected",
				"agent_session_id", input.AgentSessionID,
			)
		}
		return
	}
	if !result.Changed {
		slog.Debug("tutti-agent auth bootstrap already resolved",
			"event", "tutti_agent.auth_bootstrap",
			"action", "noop",
			"reason", "credential_already_ready",
			"agent_session_id", input.AgentSessionID,
		)
		return
	}
	slog.Info("tutti-agent auth bootstrap resolved",
		"event", "tutti_agent.auth_bootstrap",
		"action", "replace",
		"reason", "token_issue_succeeded",
		"agent_session_id", input.AgentSessionID,
	)
}

func logTuttiAgentAuthRetention(agentSessionID, reason string) {
	state, err := (tuttiAgentUserCredentialStore{}).Inspect(context.Background())
	if err != nil || !state.RevokeTarget.Valid() {
		slog.Debug("tutti-agent auth bootstrap skipped without existing credentials",
			"event", "tutti_agent.auth_bootstrap",
			"action", "noop",
			"reason", reason,
			"agent_session_id", agentSessionID,
		)
		return
	}
	slog.Info("tutti-agent auth bootstrap retained existing credentials",
		"event", "tutti_agent.auth_bootstrap",
		"action", "retain",
		"reason", reason,
		"agent_session_id", agentSessionID,
	)
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

func tuttiAgentAccountSessionCookie() (string, tuttiAgentAccountSessionState) {
	raw, err := os.ReadFile(filepath.Join(tuttitypes.DefaultStateDir(), "account", "auth.json"))
	if errors.Is(err, os.ErrNotExist) {
		return "", tuttiAgentAccountSessionAbsent
	}
	if err != nil {
		return "", tuttiAgentAccountSessionUnreadable
	}
	var payload struct {
		SessionID string `json:"session_id"`
		Cookie    string `json:"cookie"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", tuttiAgentAccountSessionUnreadable
	}
	if cookie := strings.TrimSpace(payload.Cookie); cookie != "" {
		return cookie, tuttiAgentAccountSessionPresent
	}
	if sessionID := strings.TrimSpace(payload.SessionID); sessionID != "" {
		return "session_id=" + sessionID, tuttiAgentAccountSessionPresent
	}
	return "", tuttiAgentAccountSessionAbsent
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

type tuttiAgentLoginRunner struct {
	BinaryPath string
}

func (r tuttiAgentLoginRunner) Login(ctx context.Context, bundle tuttiagentauth.TokenBundle) error {
	return runTuttiAgentTokenLogin(ctx, r.BinaryPath, bundle)
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

func tuttiAgentAuthFailureStage(err error) string {
	var stageErr tuttiagentauth.StageError
	if !errors.As(err, &stageErr) {
		return ""
	}
	return strings.TrimSpace(stageErr.Stage)
}

func tuttiAgentAuthFailureDetail(err error) string {
	var stageErr tuttiagentauth.StageError
	if !errors.As(err, &stageErr) || strings.TrimSpace(stageErr.Stage) != "login" || stageErr.Err == nil {
		return ""
	}
	return truncateTuttiAgentDiagnostic(strings.TrimSpace(stageErr.Err.Error()), 2048)
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
	if response.StatusCode == http.StatusUnauthorized {
		return tuttiAgentLLMTokenBundle{}, tuttiAgentLLMTokenIssueRejectedError{Code: http.StatusUnauthorized}
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

func runTuttiAgentTokenLogin(ctx context.Context, binaryPath string, bundle tuttiAgentLLMTokenBundle) error {
	binary := strings.TrimSpace(binaryPath)
	if binary == "" {
		var err error
		binary, err = resolveTuttiAgentBinary()
		if err != nil {
			return err
		}
	}
	stdin, err := json.Marshal(bundle)
	if err != nil {
		return err
	}
	loginCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(loginCtx, binary, "login", "--with-tutti-llm-tokens")
	if authPath, ok := userTuttiAgentAuthPath(); ok {
		// The daemon may inherit TUTTI_AGENT_HOME/CODEX_HOME from a parent
		// process or an earlier provider session.  The login command must write
		// the same canonical user auth file inspected by the reconciler; leaving
		// either override in place can make a successful login invisible to the
		// verifier (or write the bundle into another session home).
		created, prepareErr := prepareTuttiAgentAuthHome(authPath)
		if prepareErr != nil {
			return prepareErr
		}
		if created {
			slog.Info("tutti-agent auth home prepared",
				"event", "tutti_agent.auth_home.prepared",
				"action", "create",
				"reason", "missing_directory",
			)
		}
		cmd.Env = tuttiAgentLoginEnvironment(os.Environ(), authPath)
	}
	cmd.Stdin = bytes.NewReader(stdin)
	output, err := cmd.CombinedOutput()
	if err != nil {
		detail := sanitizeTuttiAgentLoginOutput(string(output), bundle)
		if detail == "" {
			return fmt.Errorf("tutti-agent login failed: %w", err)
		}
		return fmt.Errorf("tutti-agent login failed: %w: %s", err, detail)
	}
	return nil
}

func prepareTuttiAgentAuthHome(authPath string) (bool, error) {
	authHome := filepath.Dir(filepath.Clean(authPath))
	info, err := os.Stat(authHome)
	if err == nil {
		if !info.IsDir() {
			return false, fmt.Errorf("prepare tutti-agent auth home: %s is not a directory", authHome)
		}
		return false, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("inspect tutti-agent auth home: %w", err)
	}
	if err := os.MkdirAll(authHome, 0o700); err != nil {
		return false, fmt.Errorf("prepare tutti-agent auth home: %w", err)
	}
	return true, nil
}

func sanitizeTuttiAgentLoginOutput(output string, bundle tuttiAgentLLMTokenBundle) string {
	detail := strings.TrimSpace(output)
	for _, secret := range []string{bundle.AccessToken, bundle.RefreshToken} {
		if secret = strings.TrimSpace(secret); secret != "" {
			detail = strings.ReplaceAll(detail, secret, "[REDACTED]")
		}
	}
	return truncateTuttiAgentDiagnostic(detail, 2048)
}

func truncateTuttiAgentDiagnostic(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}

func tuttiAgentLoginEnvironment(base []string, authPath string) []string {
	env := append([]string(nil), base...)
	env = replaceEnvironmentValue(env, "TUTTI_AGENT_HOME", filepath.Dir(filepath.Clean(authPath)))
	env = replaceEnvironmentValue(env, "CODEX_HOME", "")
	return env
}

func replaceEnvironmentValue(env []string, key, value string) []string {
	prefix := key + "="
	result := make([]string, 0, len(env)+1)
	replaced := false
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			if !replaced {
				result = append(result, prefix+value)
				replaced = true
			}
			continue
		}
		result = append(result, entry)
	}
	if !replaced {
		result = append(result, prefix+value)
	}
	return result
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
