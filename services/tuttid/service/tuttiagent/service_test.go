package tuttiagent

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gofrs/flock"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
)

func TestIssueTuttiAgentLLMTokenUsesLegacyDefaultAppID(t *testing.T) {
	legacyAccountAppID := "nex" + "top"
	var requestedAppID string
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != tuttiAgentLLMTokenIssueRoute {
			t.Fatalf("path = %q, want %q", r.URL.Path, tuttiAgentLLMTokenIssueRoute)
		}
		var payload struct {
			RequestedAppID string   `json:"requested_app_id"`
			Scopes         []string `json:"scopes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		requestedAppID = payload.RequestedAppID
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"accessToken":"lat_test","accessTokenExpiresAt":"1780000000","refreshToken":"lrt_test","refreshTokenExpiresAt":"1790000000","tokenType":"Bearer","appId":"` + legacyAccountAppID + `","scopes":["llm:models","llm:chat"]}}`))
	}))
	defer account.Close()

	t.Setenv("TUTTI_ACCOUNT_BASE_URL", account.URL)
	t.Setenv("TUTTI_AGENT_LLM_APP_ID", "")

	bundle, err := issueTuttiAgentLLMToken(t.Context(), "session_id=test")
	if err != nil {
		t.Fatalf("issueTuttiAgentLLMToken() error = %v", err)
	}
	if requestedAppID != legacyAccountAppID {
		t.Fatalf("requested_app_id = %q, want legacy account app id", requestedAppID)
	}
	if bundle.AppID != legacyAccountAppID {
		t.Fatalf("bundle AppID = %q, want legacy account app id", bundle.AppID)
	}
}

func TestIssueTuttiAgentLLMTokenAppIDEnvOverride(t *testing.T) {
	var requestedAppID string
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			RequestedAppID string `json:"requested_app_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		requestedAppID = payload.RequestedAppID
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"accessToken":"lat_test","accessTokenExpiresAt":"1780000000","refreshToken":"lrt_test","refreshTokenExpiresAt":"1790000000","tokenType":"Bearer","appId":"custom-app","scopes":["llm:models"]}}`))
	}))
	defer account.Close()

	t.Setenv("TUTTI_ACCOUNT_BASE_URL", account.URL)
	t.Setenv("TUTTI_AGENT_LLM_APP_ID", "custom-app")

	if _, err := issueTuttiAgentLLMToken(t.Context(), "session_id=test"); err != nil {
		t.Fatalf("issueTuttiAgentLLMToken() error = %v", err)
	}
	if requestedAppID != "custom-app" {
		t.Fatalf("requested_app_id = %q, want custom-app", requestedAppID)
	}
}

func TestIssueTuttiAgentLLMTokenTreatsHTTPUnauthorizedAsRejected(t *testing.T) {
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer account.Close()
	t.Setenv("TUTTI_ACCOUNT_BASE_URL", account.URL)

	_, err := issueTuttiAgentLLMToken(t.Context(), "session_id=stale")
	if err == nil || !tuttiAgentLLMTokenIssueRejectedWithCode(err, http.StatusUnauthorized) {
		t.Fatalf("issueTuttiAgentLLMToken() error = %v, want HTTP 401 rejection", err)
	}
}

func TestTuttiAgentLoginEnvironmentUsesCanonicalAuthHome(t *testing.T) {
	authPath := filepath.Join(t.TempDir(), ".tutti-agent", "auth.json")
	env := tuttiAgentLoginEnvironment([]string{
		"PATH=C:\\Windows\\System32",
		"TUTTI_AGENT_HOME=C:\\stale\\session-home",
		"CODEX_HOME=C:\\stale\\codex-home",
		"TUTTI_AGENT_HOME=C:\\duplicate\\value",
	}, authPath)
	if got := environmentValue(env, "TUTTI_AGENT_HOME"); got != filepath.Dir(authPath) {
		t.Fatalf("TUTTI_AGENT_HOME = %q, want %q", got, filepath.Dir(authPath))
	}
	if got := environmentValue(env, "CODEX_HOME"); got != "" {
		t.Fatalf("CODEX_HOME = %q, want empty", got)
	}
	if count := environmentValueCount(env, "TUTTI_AGENT_HOME"); count != 1 {
		t.Fatalf("TUTTI_AGENT_HOME entries = %d, want one", count)
	}
}

func TestRunTuttiAgentTokenLoginPreparesCanonicalAuthHomeBeforeLaunch(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	authHome := filepath.Join(home, ".tutti-agent")

	err := runTuttiAgentTokenLogin(
		t.Context(),
		filepath.Join(t.TempDir(), "missing-tutti-agent"),
		tuttiAgentLLMTokenBundle{},
	)
	if err == nil {
		t.Fatal("runTuttiAgentTokenLogin() succeeded with a missing binary")
	}
	info, statErr := os.Stat(authHome)
	if statErr != nil {
		t.Fatalf("stat prepared auth home: %v", statErr)
	}
	if !info.IsDir() {
		t.Fatalf("prepared auth home mode = %v, want directory", info.Mode())
	}
}

func TestPrepareTuttiAgentAuthHomeRejectsFile(t *testing.T) {
	authHome := filepath.Join(t.TempDir(), ".tutti-agent")
	if err := os.WriteFile(authHome, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := prepareTuttiAgentAuthHome(filepath.Join(authHome, "auth.json"))
	if err == nil || !strings.Contains(err.Error(), "is not a directory") {
		t.Fatalf("prepareTuttiAgentAuthHome() error = %v, want not-a-directory detail", err)
	}
}

func TestSanitizeTuttiAgentLoginOutputRedactsTokensAndTruncates(t *testing.T) {
	bundle := tuttiAgentLLMTokenBundle{
		AccessToken:  "access-secret",
		RefreshToken: "refresh-secret",
	}
	detail := sanitizeTuttiAgentLoginOutput(
		"login failed access-secret refresh-secret "+strings.Repeat("x", 2100),
		bundle,
	)
	if strings.Contains(detail, "access-secret") || strings.Contains(detail, "refresh-secret") {
		t.Fatalf("sanitizeTuttiAgentLoginOutput() leaked a token: %q", detail)
	}
	if !strings.Contains(detail, "[REDACTED]") {
		t.Fatalf("sanitizeTuttiAgentLoginOutput() = %q, want redaction marker", detail)
	}
	if !strings.HasSuffix(detail, "…") {
		t.Fatalf("sanitizeTuttiAgentLoginOutput() was not truncated: %q", detail)
	}
}

func TestTuttiAgentUserAuthReadyRejectsExpiredAccessToken(t *testing.T) {
	expiresAt := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	writeTuttiAgentUserAuth(t, t.TempDir(), `{"tutti_llm":{"access_token":"lat_test","access_token_expires_at":`+strconv.Quote(expiresAt)+`,"refresh_token":"lrt_test"}}`)

	if tuttiAgentUserAuthMaterialReady() {
		t.Fatal("tuttiAgentUserAuthMaterialReady() = true, want false for expired access token")
	}
}

func TestTuttiAgentUserAuthReadyAcceptsFutureAccessTokenExpiry(t *testing.T) {
	expiresAt := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	writeTuttiAgentUserAuth(t, t.TempDir(), `{"tutti_llm":{"access_token":"lat_test","access_token_expires_at":`+strconv.Quote(expiresAt)+`,"refresh_token":"lrt_test"}}`)

	if !tuttiAgentUserAuthMaterialReady() {
		t.Fatal("tuttiAgentUserAuthMaterialReady() = false, want true for unexpired access token")
	}
}

func TestTuttiAgentUserAuthReadyAcceptsUnixAccessTokenExpiry(t *testing.T) {
	expiresAt := strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10)
	writeTuttiAgentUserAuth(t, t.TempDir(), `{"tutti_llm":{"access_token":"lat_test","access_token_expires_at":`+expiresAt+`,"refresh_token":"lrt_test"}}`)

	if !tuttiAgentUserAuthMaterialReady() {
		t.Fatal("tuttiAgentUserAuthMaterialReady() = false, want true for numeric access token expiry")
	}
}

func TestTuttiAgentUserAuthReadyRejectsMissingAccessTokenExpiry(t *testing.T) {
	writeTuttiAgentUserAuth(t, t.TempDir(), `{"tutti_llm":{"access_token":"lat_test","refresh_token":"lrt_test"}}`)

	if tuttiAgentUserAuthMaterialReady() {
		t.Fatal("tuttiAgentUserAuthMaterialReady() = true, want false without access token expiry")
	}
}

func TestBootstrapTuttiAgentUserAuthIssuesTokenWhenExistingAccessTokenExpired(t *testing.T) {
	home := t.TempDir()
	expiredAt := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	writeTuttiAgentUserAuth(t, home, `{"tutti_llm":{"access_token":"lat_old","access_token_expires_at":`+strconv.Quote(expiredAt)+`,"refresh_token":"lrt_old"}}`)

	stateDir := t.TempDir()
	accountAuthDir := filepath.Join(stateDir, "account")
	if err := os.MkdirAll(accountAuthDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(accountAuthDir, "auth.json"), []byte(`{"cookie":"session_id=session_test"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TUTTI_STATE_DIR", stateDir)

	issueRequests := make(chan struct{}, 1)
	accessExpiresAt := strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10)
	refreshExpiresAt := strconv.FormatInt(time.Now().Add(24*time.Hour).Unix(), 10)
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != tuttiAgentLLMTokenIssueRoute {
			http.NotFound(w, r)
			return
		}
		if got := r.Header.Get("Cookie"); got != "session_id=session_test" {
			t.Fatalf("Cookie = %q, want session_id=session_test", got)
		}
		issueRequests <- struct{}{}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"accessToken":"lat_new","accessTokenExpiresAt":"` + accessExpiresAt + `","refreshToken":"lrt_new","refreshTokenExpiresAt":"` + refreshExpiresAt + `","tokenType":"Bearer","appId":"tutti","scopes":["llm:models","llm:chat"]}}`))
	}))
	defer account.Close()
	t.Setenv("TUTTI_ACCOUNT_BASE_URL", account.URL)

	capturePath := filepath.Join(t.TempDir(), "login.json")
	t.Setenv("TUTTI_AGENT_LOGIN_CAPTURE", capturePath)
	installFakeTuttiAgentBinary(t)

	bootstrapTuttiAgentUserAuth(t.Context(), runtimeprep.PrepareInput{}, "")

	select {
	case <-issueRequests:
	default:
		t.Fatal("llm token issue request was not sent")
	}
	loginJSON, err := os.ReadFile(capturePath)
	if err != nil {
		t.Fatalf("read fake tutti-agent login capture: %v", err)
	}
	if !strings.Contains(string(loginJSON), `"access_token":"lat_new"`) {
		t.Fatalf("login payload = %s, want issued access token", string(loginJSON))
	}
	if !tuttiAgentUserAuthMaterialReady() {
		t.Fatal("tutti-agent credential material is not usable after successful reconcile")
	}
}

func TestBootstrapTuttiAgentUserAuthRetainsAuthWithoutHostSession(t *testing.T) {
	var revokeCalls atomic.Int32
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/v1/llm-token/revoke" {
			http.NotFound(w, r)
			return
		}
		revokeCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0}`))
	}))
	defer account.Close()

	home := t.TempDir()
	expiresAt := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	writeTuttiAgentUserAuth(
		t,
		home,
		`{"tutti_llm":{"account_base_url":`+strconv.Quote(account.URL)+`,"access_token":"lat_old","access_token_expires_at":`+strconv.Quote(expiresAt)+`,"refresh_token":"lrt_old"}}`,
	)
	t.Setenv("TUTTI_STATE_DIR", t.TempDir())

	bootstrapTuttiAgentUserAuth(t.Context(), runtimeprep.PrepareInput{}, "")

	authPath := filepath.Join(home, ".tutti-agent", "auth.json")
	assertTuttiAgentAuthUnchanged(t, authPath, []byte(`{"tutti_llm":{"account_base_url":`+strconv.Quote(account.URL)+`,"access_token":"lat_old","access_token_expires_at":`+strconv.Quote(expiresAt)+`,"refresh_token":"lrt_old"}}`))
	if got := revokeCalls.Load(); got != 0 {
		t.Fatalf("revoke calls = %d, want 0", got)
	}
}

func TestBootstrapTuttiAgentUserAuthRetainsAuthWhenHostAuthIsInvalidJSON(t *testing.T) {
	var revokeCalls atomic.Int32
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		revokeCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0}`))
	}))
	defer account.Close()

	home := t.TempDir()
	expiresAt := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	authJSON := `{"tutti_llm":{"account_base_url":` + strconv.Quote(account.URL) + `,"access_token":"lat_old","access_token_expires_at":` + strconv.Quote(expiresAt) + `,"refresh_token":"lrt_old"}}`
	writeTuttiAgentUserAuth(t, home, authJSON)

	stateDir := t.TempDir()
	accountAuthDir := filepath.Join(stateDir, "account")
	if err := os.MkdirAll(accountAuthDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(accountAuthDir, "auth.json"), []byte(`{"cookie":`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TUTTI_STATE_DIR", stateDir)

	bootstrapTuttiAgentUserAuth(t.Context(), runtimeprep.PrepareInput{}, "")

	authPath := filepath.Join(home, ".tutti-agent", "auth.json")
	assertTuttiAgentAuthUnchanged(t, authPath, []byte(authJSON))
	if _, err := os.Stat(filepath.Join(stateDir, "account", "auth.json")); err != nil {
		t.Fatalf("host auth stat error = %v, want rejected session to be retained", err)
	}
	if got := revokeCalls.Load(); got != 0 {
		t.Fatalf("revoke calls = %d, want 0", got)
	}
}

func TestBootstrapTuttiAgentUserAuthRetainsAuthWhenHostAuthIsUnreadable(t *testing.T) {
	var revokeCalls atomic.Int32
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		revokeCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0}`))
	}))
	defer account.Close()

	home := t.TempDir()
	expiresAt := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	authJSON := `{"tutti_llm":{"account_base_url":` + strconv.Quote(account.URL) + `,"access_token":"lat_old","access_token_expires_at":` + strconv.Quote(expiresAt) + `,"refresh_token":"lrt_old"}}`
	writeTuttiAgentUserAuth(t, home, authJSON)

	stateDir := t.TempDir()
	accountAuthPath := filepath.Join(stateDir, "account", "auth.json")
	if err := os.MkdirAll(accountAuthPath, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TUTTI_STATE_DIR", stateDir)

	bootstrapTuttiAgentUserAuth(t.Context(), runtimeprep.PrepareInput{}, "")

	authPath := filepath.Join(home, ".tutti-agent", "auth.json")
	assertTuttiAgentAuthUnchanged(t, authPath, []byte(authJSON))
	if got := revokeCalls.Load(); got != 0 {
		t.Fatalf("revoke calls = %d, want 0", got)
	}
}

func TestBootstrapTuttiAgentUserAuthRetainsAuthAfterUnauthorizedTokenIssue(t *testing.T) {
	var revokeCalls atomic.Int32
	home := t.TempDir()
	expiredAt := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)

	stateDir := t.TempDir()
	accountAuthDir := filepath.Join(stateDir, "account")
	if err := os.MkdirAll(accountAuthDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(accountAuthDir, "auth.json"), []byte(`{"cookie":"session_id=stale"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TUTTI_STATE_DIR", stateDir)

	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case tuttiAgentLLMTokenIssueRoute:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"code":401,"errmsg":"session not found"}`))
		case "/auth/v1/llm-token/revoke":
			revokeCalls.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"code":0}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer account.Close()
	t.Setenv("TUTTI_ACCOUNT_BASE_URL", account.URL)
	authJSON := `{"tutti_llm":{"account_base_url":` + strconv.Quote(account.URL) + `,"access_token":"lat_old","access_token_expires_at":` + strconv.Quote(expiredAt) + `,"refresh_token":"lrt_old"}}`
	writeTuttiAgentUserAuth(t, home, authJSON)

	bootstrapTuttiAgentUserAuth(t.Context(), runtimeprep.PrepareInput{}, "")

	authPath := filepath.Join(home, ".tutti-agent", "auth.json")
	assertTuttiAgentAuthUnchanged(t, authPath, []byte(authJSON))
	if _, err := os.Stat(filepath.Join(stateDir, "account", "auth.json")); err != nil {
		t.Fatalf("host auth stat error = %v, want rejected session to be retained", err)
	}
	if got := revokeCalls.Load(); got != 0 {
		t.Fatalf("revoke calls = %d, want 0", got)
	}
}

func TestBootstrapTuttiAgentUserAuthRestoresPreviousAuthAfterReconcileFailures(t *testing.T) {
	for _, test := range []struct {
		name         string
		tokenPayload string
		loginScript  string
	}{
		{
			name:         "invalid bundle",
			tokenPayload: validTuttiAgentTokenPayload(t, []string{"llm:models"}),
			loginScript:  "exit 9\n",
		},
		{
			name:         "login failure",
			tokenPayload: validTuttiAgentTokenPayload(t, []string{"llm:models", "llm:chat"}),
			loginScript:  "exit 9\n",
		},
		{
			name:         "verify failure",
			tokenPayload: validTuttiAgentTokenPayload(t, []string{"llm:models", "llm:chat"}),
			loginScript:  "mkdir -p \"$HOME/.tutti-agent\"\nprintf '%s' '{}' > \"$HOME/.tutti-agent/auth.json\"\n",
		},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case tuttiAgentLLMTokenIssueRoute:
					_, _ = w.Write([]byte(test.tokenPayload))
				case "/auth/v1/llm-token/revoke":
					_, _ = w.Write([]byte(`{"code":0}`))
				default:
					http.NotFound(w, r)
				}
			}))
			defer account.Close()
			t.Setenv("TUTTI_ACCOUNT_BASE_URL", account.URL)

			home := t.TempDir()
			oldAuth := []byte(`{"tutti_llm":{"account_base_url":` + strconv.Quote(account.URL) + `,"access_token":"lat_old","access_token_expires_at":"2000-01-01T00:00:00Z","refresh_token":"lrt_old"}}`)
			writeTuttiAgentUserAuth(t, home, string(oldAuth))
			writeHostAccountAuth(t, "session_id=session_test")
			binaryPath := writeTuttiAgentTestBinary(t, test.loginScript)

			bootstrapTuttiAgentUserAuth(t.Context(), runtimeprep.PrepareInput{}, binaryPath)

			assertTuttiAgentAuthUnchanged(t, filepath.Join(home, ".tutti-agent", "auth.json"), oldAuth)
		})
	}
}

func TestBootstrapTuttiAgentUserAuthWaitsForAgentRefreshLock(t *testing.T) {
	var issueCalls atomic.Int32
	tokenPayload := validTuttiAgentTokenPayload(t, []string{"llm:models", "llm:chat"})
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != tuttiAgentLLMTokenIssueRoute {
			http.NotFound(w, r)
			return
		}
		issueCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(tokenPayload))
	}))
	defer account.Close()
	t.Setenv("TUTTI_ACCOUNT_BASE_URL", account.URL)

	home := t.TempDir()
	writeTuttiAgentUserAuth(t, home, `{"tutti_llm":{"access_token":"lat_old","access_token_expires_at":"2000-01-01T00:00:00Z","refresh_token":"lrt_old"}}`)
	writeHostAccountAuth(t, "session_id=session_test")
	installFakeTuttiAgentBinary(t)

	authPath := filepath.Join(home, ".tutti-agent", "auth.json")
	externalLock := flock.New(authPath + ".refresh.lock")
	if err := externalLock.Lock(); err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	done := make(chan struct{})
	go func() {
		defer close(done)
		bootstrapTuttiAgentUserAuth(ctx, runtimeprep.PrepareInput{}, "")
	}()
	select {
	case <-done:
		t.Fatal("bootstrap completed while refresh lock was held")
	case <-time.After(100 * time.Millisecond):
	}
	if got := issueCalls.Load(); got != 0 {
		t.Fatalf("issue calls while refresh lock held = %d, want 0", got)
	}
	if err := externalLock.Unlock(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("bootstrap did not resume after refresh lock release")
	}
	if got := issueCalls.Load(); got != 1 {
		t.Fatalf("issue calls = %d, want 1", got)
	}
}

func TestLogoutTuttiAgentUserAuthRemovesAuthAndRevokesToken(t *testing.T) {
	revokeBody := make(chan map[string]string, 1)
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/v1/llm-token/revoke" {
			http.NotFound(w, r)
			return
		}
		var payload map[string]string
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode revoke body: %v", err)
		}
		revokeBody <- payload
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0}`))
	}))
	defer account.Close()

	home := t.TempDir()
	authDir := filepath.Join(home, ".tutti-agent")
	authPath := filepath.Join(authDir, "auth.json")
	if err := os.MkdirAll(authDir, 0o700); err != nil {
		t.Fatal(err)
	}
	authJSON := `{"tutti_llm":{"account_base_url":` + strconv.Quote(account.URL) + `,"access_token":"lat_test","refresh_token":"lrt_test"}}`
	if err := os.WriteFile(authPath, []byte(authJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	if err := logoutTuttiAgentUserAuth(t.Context()); err != nil {
		t.Fatalf("logoutTuttiAgentUserAuth() error = %v", err)
	}
	if _, err := os.Stat(authPath); !os.IsNotExist(err) {
		t.Fatalf("auth json stat error = %v, want not exist", err)
	}
	select {
	case body := <-revokeBody:
		if body["refresh_token"] != "lrt_test" {
			t.Fatalf("refresh_token = %q, want lrt_test", body["refresh_token"])
		}
		if body["reason"] != "logout" {
			t.Fatalf("reason = %q, want logout", body["reason"])
		}
	case <-time.After(time.Second):
		t.Fatal("revoke request was not sent")
	}
}

func TestLogoutTuttiAgentUserAuthWaitsForAgentRefreshLock(t *testing.T) {
	revokeRequest := make(chan struct{}, 1)
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		revokeRequest <- struct{}{}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0}`))
	}))
	defer account.Close()

	home := t.TempDir()
	authJSON := `{"tutti_llm":{"account_base_url":` + strconv.Quote(account.URL) + `,"access_token":"lat_test","refresh_token":"lrt_test"}}`
	writeTuttiAgentUserAuth(t, home, authJSON)
	authPath := filepath.Join(home, ".tutti-agent", "auth.json")
	externalLock := flock.New(authPath + ".refresh.lock")
	if err := externalLock.Lock(); err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	done := make(chan error, 1)
	go func() {
		done <- logoutTuttiAgentUserAuth(ctx)
	}()
	select {
	case err := <-done:
		t.Fatalf("logout completed while refresh lock was held: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	assertTuttiAgentAuthUnchanged(t, authPath, []byte(authJSON))
	if err := externalLock.Unlock(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("logout after lock release: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("logout did not resume after refresh lock release")
	}
	if _, err := os.Stat(authPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("auth json stat error = %v, want not exist", err)
	}
	select {
	case <-revokeRequest:
	case <-time.After(time.Second):
		t.Fatal("revoke request was not sent")
	}
}

func writeTuttiAgentUserAuth(t *testing.T, home string, authJSON string) {
	t.Helper()
	authDir := filepath.Join(home, ".tutti-agent")
	if err := os.MkdirAll(authDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(authDir, "auth.json"), []byte(authJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
}

func assertTuttiAgentAuthUnchanged(t *testing.T, authPath string, expected []byte) {
	t.Helper()
	actual, err := os.ReadFile(authPath)
	if err != nil {
		t.Fatalf("read auth json: %v", err)
	}
	if !bytes.Equal(actual, expected) {
		t.Fatalf("auth json changed:\n got: %s\nwant: %s", actual, expected)
	}
}

func writeHostAccountAuth(t *testing.T, cookie string) {
	t.Helper()
	stateDir := t.TempDir()
	accountAuthDir := filepath.Join(stateDir, "account")
	if err := os.MkdirAll(accountAuthDir, 0o700); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]string{"cookie": cookie})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(accountAuthDir, "auth.json"), payload, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TUTTI_STATE_DIR", stateDir)
}

func validTuttiAgentTokenPayload(t *testing.T, scopes []string) string {
	t.Helper()
	payload := map[string]any{
		"code": 0,
		"data": map[string]any{
			"accessToken":           "lat_new",
			"accessTokenExpiresAt":  strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10),
			"refreshToken":          "lrt_new",
			"refreshTokenExpiresAt": strconv.FormatInt(time.Now().Add(24*time.Hour).Unix(), 10),
			"tokenType":             "Bearer",
			"appId":                 tuttiAgentDefaultLLMAppID,
			"scopes":                scopes,
		},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func writeTuttiAgentTestBinary(t *testing.T, body string) string {
	t.Helper()
	binaryPath := filepath.Join(t.TempDir(), "tutti-agent")
	script := "#!/bin/sh\n" +
		"if [ \"$1\" != \"login\" ] || [ \"$2\" != \"--with-tutti-llm-tokens\" ]; then\n" +
		"  exit 2\n" +
		"fi\n" +
		"cat >/dev/null\n" +
		body
	if err := os.WriteFile(binaryPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return binaryPath
}

func environmentValue(env []string, key string) string {
	prefix := key + "="
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			return strings.TrimPrefix(entry, prefix)
		}
	}
	return ""
}

func environmentValueCount(env []string, key string) int {
	prefix := key + "="
	count := 0
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			count++
		}
	}
	return count
}

func installFakeTuttiAgentBinary(t *testing.T) {
	t.Helper()
	binDir := t.TempDir()
	binaryPath := filepath.Join(binDir, "tutti-agent")
	script := "#!/bin/sh\n" +
		"if [ \"$1\" != \"login\" ] || [ \"$2\" != \"--with-tutti-llm-tokens\" ]; then\n" +
		"  echo unexpected arguments: \"$@\" >&2\n" +
		"  exit 2\n" +
		"fi\n" +
		"cat > \"$TUTTI_AGENT_LOGIN_CAPTURE\"\n" +
		"mkdir -p \"$HOME/.tutti-agent\"\n" +
		"printf '%s' '{\"tutti_llm\":{\"access_token\":\"lat_new\",\"access_token_expires_at\":4102444800,\"refresh_token\":\"lrt_new\"}}' > \"$HOME/.tutti-agent/auth.json\"\n"
	if err := os.WriteFile(binaryPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
}
