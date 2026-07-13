package agent

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func writeCodexModelCatalogConfig(t *testing.T, contents string) {
	t.Helper()
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	if err := os.WriteFile(filepath.Join(codexHome, codexConfigFileName), []byte(contents), 0o600); err != nil {
		t.Fatalf("write codex config.toml: %v", err)
	}
}

// A custom model_provider cannot serve the official Codex model/list ids. The
// composer must expose only the model configured for that provider.
func TestAgentModelCatalogCustomModelProviderExposesOnlyConfiguredModel(t *testing.T) {
	writeCodexModelCatalogConfig(t,
		"model_provider = \"openrouter\"\n"+
			"model = \"minimax/minimax-m2.5\"\n\n"+
			"[model_providers.openrouter]\n"+
			"base_url = \"https://openrouter.ai/api/v1\"\n")
	lister := &fakeAgentModelLister{
		models: []AgentModelOption{
			{ID: "gpt-5.5", DisplayName: "GPT-5.5", IsDefault: true},
			{ID: "gpt-5.4", DisplayName: "GPT-5.4"},
			{ID: "gpt-5.2", DisplayName: "GPT-5.2"},
		},
	}
	catalog := &CachedAgentModelCatalog{
		Codex: lister,
		Now: func() time.Time {
			return time.UnixMilli(1000)
		},
	}

	result, err := catalog.ListModels(context.Background(), "codex")
	if err != nil {
		t.Fatalf("ListModels returned error: %v", err)
	}
	if len(result.Models) != 1 {
		t.Fatalf("models = %#v, want only the configured custom-provider model", result.Models)
	}
	if result.Models[0].ID != "minimax/minimax-m2.5" || !result.Models[0].IsDefault {
		t.Fatalf("model = %#v, want configured minimax/minimax-m2.5 as default", result.Models[0])
	}
	if result.Source != "codex-configured-model" {
		t.Fatalf("source = %q, want codex-configured-model", result.Source)
	}
}

func TestAgentModelCatalogDefaultProviderKeepsOfficialListWithConfiguredDefault(t *testing.T) {
	writeCodexModelCatalogConfig(t, "model = \"gpt-5.5\"\n")
	lister := &fakeAgentModelLister{
		models: []AgentModelOption{
			{ID: "gpt-5.5", DisplayName: "GPT-5.5"},
			{ID: "gpt-5.4", DisplayName: "GPT-5.4"},
		},
	}
	catalog := &CachedAgentModelCatalog{
		Codex: lister,
		Now: func() time.Time {
			return time.UnixMilli(1000)
		},
	}

	result, err := catalog.ListModels(context.Background(), "codex")
	if err != nil {
		t.Fatalf("ListModels returned error: %v", err)
	}
	if len(result.Models) != 2 {
		t.Fatalf("models = %#v, want official catalog untouched", result.Models)
	}
	if !result.Models[0].IsDefault || result.Models[0].ID != "gpt-5.5" {
		t.Fatalf("models = %#v, want configured gpt-5.5 marked default", result.Models)
	}
}

func TestAgentModelCatalogDoesNotReturnClaudeStaticModels(t *testing.T) {
	catalog := &CachedAgentModelCatalog{
		Now: func() time.Time {
			return time.UnixMilli(1000)
		},
	}

	if _, err := catalog.ListModels(context.Background(), "claude-code"); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("ListModels error = %v, want ErrInvalidArgument", err)
	}
}

func TestAgentModelCatalogInvalidateDropsCodexCacheBeforeTTL(t *testing.T) {
	now := time.UnixMilli(1000)
	lister := &fakeAgentModelLister{
		models: []AgentModelOption{{ID: "gpt-5.2-codex", DisplayName: "gpt-5.2-codex", IsDefault: true}},
	}
	catalog := &CachedAgentModelCatalog{
		Codex: lister,
		Now: func() time.Time {
			return now
		},
	}

	if _, err := catalog.ListModels(context.Background(), "codex"); err != nil {
		t.Fatalf("first ListModels returned error: %v", err)
	}
	if _, err := catalog.ListModels(context.Background(), "codex"); err != nil {
		t.Fatalf("second ListModels returned error: %v", err)
	}
	if lister.calls != 1 {
		t.Fatalf("lister calls before invalidate = %d, want 1", lister.calls)
	}

	catalog.Invalidate("codex")
	if _, err := catalog.ListModels(context.Background(), "codex"); err != nil {
		t.Fatalf("ListModels after invalidate returned error: %v", err)
	}
	if lister.calls != 2 {
		t.Fatalf("lister calls after invalidate = %d, want 2", lister.calls)
	}
}

func TestAgentModelCatalogInvalidateIgnoresOtherProviders(t *testing.T) {
	now := time.UnixMilli(1000)
	lister := &fakeAgentModelLister{
		models: []AgentModelOption{{ID: "gpt-5.2-codex", DisplayName: "gpt-5.2-codex", IsDefault: true}},
	}
	catalog := &CachedAgentModelCatalog{
		Codex: lister,
		Now: func() time.Time {
			return now
		},
	}

	if _, err := catalog.ListModels(context.Background(), "codex"); err != nil {
		t.Fatalf("first ListModels returned error: %v", err)
	}
	catalog.Invalidate("claude-code", "unknown-provider")
	if _, err := catalog.ListModels(context.Background(), "codex"); err != nil {
		t.Fatalf("second ListModels returned error: %v", err)
	}
	if lister.calls != 1 {
		t.Fatalf("lister calls = %d, want 1 (codex cache must survive unrelated invalidations)", lister.calls)
	}
}

func TestAgentModelCatalogEnrichesOpenCodeModelsWithImageCapability(t *testing.T) {
	now := time.UnixMilli(1000)
	lister := &fakeAgentModelLister{
		models: []AgentModelOption{{
			ID:          "openai/gpt-5.2-pro",
			DisplayName: "GPT-5.2 Pro",
			IsDefault:   true,
		}},
	}
	catalog := &CachedAgentModelCatalog{
		OpenCode: lister,
		ModelCapabilities: fakeModelCapabilitiesResolver{
			"opencode:openai/gpt-5.2-pro": true,
		},
		Now: func() time.Time {
			return now
		},
	}

	result, err := catalog.ListModels(context.Background(), "opencode")
	if err != nil {
		t.Fatalf("ListModels returned error: %v", err)
	}
	if len(result.Models) != 1 {
		t.Fatalf("models = %#v, want one OpenCode model", result.Models)
	}
	if result.Models[0].SupportsImageInput == nil || !*result.Models[0].SupportsImageInput {
		t.Fatalf("supportsImageInput = %#v, want true", result.Models[0].SupportsImageInput)
	}
}

func TestAgentModelCatalogListsTuttiAgentModelsFromLiveLister(t *testing.T) {
	now := time.UnixMilli(1000)
	lister := &fakeAgentModelLister{
		models: []AgentModelOption{{ID: "gpt-5.4", DisplayName: "GPT-5.4", IsDefault: true}},
	}
	catalog := &CachedAgentModelCatalog{
		TuttiAgent: lister,
		Now: func() time.Time {
			return now
		},
	}

	first, err := catalog.ListModels(context.Background(), "tutti-agent")
	if err != nil {
		t.Fatalf("first ListModels returned error: %v", err)
	}
	second, err := catalog.ListModels(context.Background(), "tutti-agent")
	if err != nil {
		t.Fatalf("second ListModels returned error: %v", err)
	}

	if lister.calls != 1 {
		t.Fatalf("lister calls = %d, want 1", lister.calls)
	}
	if first.Provider != "tutti-agent" {
		t.Fatalf("provider = %q, want tutti-agent", first.Provider)
	}
	if first.Source != "tutti-agent-cli" {
		t.Fatalf("source = %q, want tutti-agent-cli", first.Source)
	}
	if len(first.Models) != 1 || first.Models[0].ID != "gpt-5.4" {
		t.Fatalf("models = %#v, want gpt-5.4", first.Models)
	}
	if second.Models[0].ID != first.Models[0].ID {
		t.Fatalf("cached model mismatch: first=%#v second=%#v", first, second)
	}
}

func TestDefaultTuttiAgentModelListerUsesTuttiHomeAndClearsCodexHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	stateDir := filepath.Join(home, "state")
	t.Setenv("TUTTI_STATE_DIR", stateDir)
	userAgentHome := filepath.Join(home, ".tutti-agent")
	if err := os.MkdirAll(userAgentHome, 0o700); err != nil {
		t.Fatal(err)
	}
	accessExpiresAt := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	authJSON := `{"tutti_llm":{"access_token":"access","access_token_expires_at":` + strconv.Quote(accessExpiresAt) + `,"refresh_token":"refresh"}}`
	if err := os.WriteFile(filepath.Join(userAgentHome, "auth.json"), []byte(authJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	accountAuthDir := filepath.Join(stateDir, "account")
	if err := os.MkdirAll(accountAuthDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(accountAuthDir, "auth.json"), []byte(`{"cookie":"session_id=session_test"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	userConfig := strings.Join([]string{
		`model_provider = "custom"`,
		`model = "custom-model"`,
		"",
		"[model_providers.custom]",
		`name = "Custom"`,
		`base_url = "https://custom.example.test/v1"`,
	}, "\n")
	if err := os.WriteFile(filepath.Join(userAgentHome, "config.toml"), []byte(userConfig), 0o600); err != nil {
		t.Fatal(err)
	}

	lister := defaultTuttiAgentModelLister()
	env, err := lister.PrepareEnv([]string{
		"TUTTI_AGENT_HOME=" + filepath.Join(home, "ignored-agent-home"),
		"CODEX_HOME=" + filepath.Join(home, "codex-home"),
	})
	if err != nil {
		t.Fatalf("PrepareEnv() error = %v", err)
	}
	tuttiAgentHome := filepath.Join(stateDir, "agent-model-catalog", "tutti-agent-home")
	if got, want := envValue(env, "TUTTI_AGENT_HOME"), tuttiAgentHome; got != want {
		t.Fatalf("TUTTI_AGENT_HOME = %q, want %q", got, want)
	}
	if got := envValue(env, "CODEX_HOME"); got != "" {
		t.Fatalf("CODEX_HOME = %q, want cleared", got)
	}
	if got := lister.ClientName; got != "tutti_agent" {
		t.Fatalf("ClientName = %q, want tutti_agent", got)
	}
	authInfo, err := os.Lstat(filepath.Join(tuttiAgentHome, "auth.json"))
	if err != nil {
		t.Fatalf("catalog auth not exposed: %v", err)
	}
	if authInfo.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("catalog auth should be symlink, got mode %v", authInfo.Mode())
	}
	config, err := os.ReadFile(filepath.Join(tuttiAgentHome, "config.toml"))
	if err != nil {
		t.Fatalf("catalog config missing: %v", err)
	}
	configText := string(config)
	if !strings.Contains(configText, `model_provider = "tutti-llm"`) ||
		!strings.Contains(configText, `model = "gpt-5.4"`) ||
		!strings.Contains(configText, "[model_providers.tutti-llm]") ||
		!strings.Contains(configText, "[model_providers.custom]") ||
		strings.Contains(configText, `model_provider = "custom"`) {
		t.Fatalf("catalog config = %q, want pinned tutti-llm root provider while preserving custom provider block", configText)
	}
	userConfigAfterPrepare, err := os.ReadFile(filepath.Join(userAgentHome, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if string(userConfigAfterPrepare) != userConfig {
		t.Fatalf("user tutti-agent config was modified: %q", string(userConfigAfterPrepare))
	}
}

func TestDefaultTuttiAgentModelListerBootstrapsExpiredTuttiAgentAuth(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	stateDir := filepath.Join(home, "state")
	t.Setenv("TUTTI_STATE_DIR", stateDir)

	userAgentHome := filepath.Join(home, ".tutti-agent")
	if err := os.MkdirAll(userAgentHome, 0o700); err != nil {
		t.Fatal(err)
	}
	expiredAt := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	authJSON := `{"tutti_llm":{"access_token":"lat_old","access_token_expires_at":` + strconv.Quote(expiredAt) + `,"refresh_token":"lrt_old"}}`
	if err := os.WriteFile(filepath.Join(userAgentHome, "auth.json"), []byte(authJSON), 0o600); err != nil {
		t.Fatal(err)
	}

	accountAuthDir := filepath.Join(stateDir, "account")
	if err := os.MkdirAll(accountAuthDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(accountAuthDir, "auth.json"), []byte(`{"cookie":"session_id=session_test"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	issueRequests := make(chan struct{}, 1)
	accessExpiresAt := strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10)
	refreshExpiresAt := strconv.FormatInt(time.Now().Add(24*time.Hour).Unix(), 10)
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/v1/llm-token" {
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
	installFakeTuttiAgentModelListBinary(t)

	lister := defaultTuttiAgentModelLister()
	if _, err := lister.PrepareEnv(nil); err != nil {
		t.Fatalf("PrepareEnv() error = %v", err)
	}

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
}

func installFakeTuttiAgentModelListBinary(t *testing.T) {
	t.Helper()
	binDir := t.TempDir()
	binaryPath := filepath.Join(binDir, "tutti-agent")
	script := "#!/bin/sh\n" +
		"if [ \"$1\" != \"login\" ] || [ \"$2\" != \"--with-tutti-llm-tokens\" ]; then\n" +
		"  echo unexpected arguments: \"$@\" >&2\n" +
		"  exit 2\n" +
		"fi\n" +
		"cat > \"$TUTTI_AGENT_LOGIN_CAPTURE\"\n"
	if err := os.WriteFile(binaryPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
}
