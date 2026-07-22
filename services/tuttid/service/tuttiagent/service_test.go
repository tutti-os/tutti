package tuttiagent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

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

func TestTuttiAgentUserAuthReadyRejectsExpiredAccessToken(t *testing.T) {
	expiresAt := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	writeTuttiAgentUserAuth(t, t.TempDir(), `{"tutti_llm":{"access_token":"lat_test","access_token_expires_at":`+strconv.Quote(expiresAt)+`,"refresh_token":"lrt_test"}}`)

	if tuttiAgentUserAuthReady() {
		t.Fatal("tuttiAgentUserAuthReady() = true, want false for expired access token")
	}
}

func TestTuttiAgentUserAuthReadyAcceptsFutureAccessTokenExpiry(t *testing.T) {
	expiresAt := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	writeTuttiAgentUserAuth(t, t.TempDir(), `{"tutti_llm":{"access_token":"lat_test","access_token_expires_at":`+strconv.Quote(expiresAt)+`,"refresh_token":"lrt_test"}}`)

	if !tuttiAgentUserAuthReady() {
		t.Fatal("tuttiAgentUserAuthReady() = false, want true for unexpired access token")
	}
}

func TestTuttiAgentUserAuthReadyAcceptsUnixAccessTokenExpiry(t *testing.T) {
	expiresAt := strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10)
	writeTuttiAgentUserAuth(t, t.TempDir(), `{"tutti_llm":{"access_token":"lat_test","access_token_expires_at":`+expiresAt+`,"refresh_token":"lrt_test"}}`)

	if !tuttiAgentUserAuthReady() {
		t.Fatal("tuttiAgentUserAuthReady() = false, want true for numeric access token expiry")
	}
}

func TestTuttiAgentUserAuthReadyRejectsMissingAccessTokenExpiry(t *testing.T) {
	writeTuttiAgentUserAuth(t, t.TempDir(), `{"tutti_llm":{"access_token":"lat_test","refresh_token":"lrt_test"}}`)

	if tuttiAgentUserAuthReady() {
		t.Fatal("tuttiAgentUserAuthReady() = true, want false without access token expiry")
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

	bootstrapTuttiAgentUserAuth(t.Context(), runtimeprep.PrepareInput{}, nil)

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
	var loginBundle tuttiAgentLLMTokenBundle
	if err := json.Unmarshal(loginJSON, &loginBundle); err != nil {
		t.Fatalf("decode login payload: %v", err)
	}
	if strings.TrimSpace(loginBundle.CredentialGeneration) == "" {
		t.Fatal("login payload credential_generation is empty")
	}
}

func TestBootstrapTuttiAgentUserAuthForcesFreshGenerationAfterAuthInvalidation(t *testing.T) {
	home := t.TempDir()
	expiresAt := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	writeTuttiAgentUserAuth(t, home, `{"tutti_llm":{"access_token":"lat_old","access_token_expires_at":`+strconv.Quote(expiresAt)+`,"refresh_token":"lrt_old"}}`)
	stateDir := t.TempDir()
	accountAuthDir := filepath.Join(stateDir, "account")
	if err := os.MkdirAll(accountAuthDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(accountAuthDir, "auth.json"), []byte(`{"cookie":"session_id=session_test"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TUTTI_STATE_DIR", stateDir)
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case tuttiAgentLLMTokenIssueRoute:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"code":0,"data":{"accessToken":"lat_new","accessTokenExpiresAt":"1780000000","refreshToken":"lrt_new","refreshTokenExpiresAt":"1790000000","tokenType":"Bearer","appId":"tutti","scopes":["llm:models","llm:chat"]}}`))
		case "/auth/v1/llm-token/revoke":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"code":0}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer account.Close()
	t.Setenv("TUTTI_ACCOUNT_BASE_URL", account.URL)
	capturePath := filepath.Join(t.TempDir(), "login.json")
	t.Setenv("TUTTI_AGENT_LOGIN_CAPTURE", capturePath)
	installFakeTuttiAgentBinary(t)
	invalidation := &fakeAuthInvalidation{invalid: true}

	bootstrapTuttiAgentUserAuth(t.Context(), runtimeprep.PrepareInput{}, invalidation)

	if invalidation.invalid {
		t.Fatal("auth invalidation was not cleared after successful bootstrap")
	}
	loginJSON, err := os.ReadFile(capturePath)
	if err != nil {
		t.Fatalf("read fake tutti-agent login capture: %v", err)
	}
	if !strings.Contains(string(loginJSON), `"access_token":"lat_new"`) {
		t.Fatalf("login payload = %s, want forced fresh access token", string(loginJSON))
	}
}

func TestBootstrapTuttiAgentUserAuthRevokesIssuedTokenWhenLoginFails(t *testing.T) {
	home := t.TempDir()
	writeTuttiAgentUserAuth(t, home, `{}`)
	stateDir := t.TempDir()
	accountAuthDir := filepath.Join(stateDir, "account")
	if err := os.MkdirAll(accountAuthDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(accountAuthDir, "auth.json"), []byte(`{"cookie":"session_id=session_test"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TUTTI_STATE_DIR", stateDir)
	revokeBody := make(chan map[string]string, 1)
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case tuttiAgentLLMTokenIssueRoute:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"code":0,"data":{"accessToken":"lat_new","accessTokenExpiresAt":"1780000000","refreshToken":"lrt_new","refreshTokenExpiresAt":"1790000000","tokenType":"Bearer","appId":"tutti","scopes":["llm:models","llm:chat"]}}`))
		case "/auth/v1/llm-token/revoke":
			var payload map[string]string
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("decode revoke body: %v", err)
			}
			revokeBody <- payload
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"code":0}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer account.Close()
	t.Setenv("TUTTI_ACCOUNT_BASE_URL", account.URL)
	installFailingTuttiAgentBinary(t)

	bootstrapTuttiAgentUserAuth(t.Context(), runtimeprep.PrepareInput{}, nil)

	select {
	case body := <-revokeBody:
		if body["refresh_token"] != "lrt_new" || body["reason"] != "login_failed" {
			t.Fatalf("revoke body = %#v, want issued token cleanup", body)
		}
	case <-time.After(time.Second):
		t.Fatal("issued token was not revoked after login failure")
	}
}

func TestBootstrapTuttiAgentUserAuthClearsAuthWithoutHostSession(t *testing.T) {
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/v1/llm-token/revoke" {
			http.NotFound(w, r)
			return
		}
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

	bootstrapTuttiAgentUserAuth(t.Context(), runtimeprep.PrepareInput{}, nil)

	authPath := filepath.Join(home, ".tutti-agent", "auth.json")
	if _, err := os.Stat(authPath); !os.IsNotExist(err) {
		t.Fatalf("auth json stat error = %v, want not exist", err)
	}
}

func TestBootstrapTuttiAgentUserAuthClearsAuthAfterUnauthorizedTokenIssue(t *testing.T) {
	home := t.TempDir()
	expiredAt := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	writeTuttiAgentUserAuth(t, home, `{"tutti_llm":{"access_token":"lat_old","access_token_expires_at":`+strconv.Quote(expiredAt)+`,"refresh_token":"lrt_old"}}`)

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
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"code":0}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer account.Close()
	t.Setenv("TUTTI_ACCOUNT_BASE_URL", account.URL)

	bootstrapTuttiAgentUserAuth(t.Context(), runtimeprep.PrepareInput{}, nil)

	authPath := filepath.Join(home, ".tutti-agent", "auth.json")
	if _, err := os.Stat(authPath); !os.IsNotExist(err) {
		t.Fatalf("auth json stat error = %v, want not exist", err)
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
}

func installFakeTuttiAgentBinary(t *testing.T) {
	t.Helper()
	binDir := t.TempDir()
	binaryPath := filepath.Join(binDir, "tutti-agent")
	script := "#!/bin/sh\n" +
		"if [ \"$1\" != \"-c\" ] || [ \"$2\" != 'cli_auth_credentials_store=\"file\"' ] || [ \"$3\" != \"login\" ] || [ \"$4\" != \"--with-tutti-llm-tokens\" ]; then\n" +
		"  echo unexpected arguments: \"$@\" >&2\n" +
		"  exit 2\n" +
		"fi\n" +
		"cat > \"$TUTTI_AGENT_LOGIN_CAPTURE\"\n"
	if err := os.WriteFile(binaryPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func installFailingTuttiAgentBinary(t *testing.T) {
	t.Helper()
	binDir := t.TempDir()
	binaryPath := filepath.Join(binDir, "tutti-agent")
	script := "#!/bin/sh\n" +
		"cat >/dev/null\n" +
		"echo login failed >&2\n" +
		"exit 1\n"
	if err := os.WriteFile(binaryPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

type fakeAuthInvalidation struct {
	invalid bool
}

func (f *fakeAuthInvalidation) AuthInvalidated(_ string) bool {
	return f.invalid
}

func (f *fakeAuthInvalidation) ClearAuthInvalidated(_ string) {
	f.invalid = false
}
