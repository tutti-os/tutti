package agent

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func TestChangedProvidersReportsProvidersWithChangedFiles(t *testing.T) {
	entries := []ProviderAuthWatchEntry{
		{Provider: agentprovider.Codex, Paths: []string{"/tmp/codex/auth.json", "/tmp/codex/config.toml"}},
		{Provider: agentprovider.ClaudeCode, Paths: []string{"/tmp/claude/settings.json"}},
	}
	baseline := map[string]providerAuthFileFingerprint{
		"/tmp/codex/auth.json":      {exists: true, modTime: time.UnixMilli(1000), size: 10},
		"/tmp/codex/config.toml":    {exists: true, modTime: time.UnixMilli(1000), size: 20},
		"/tmp/claude/settings.json": {exists: true, modTime: time.UnixMilli(1000), size: 30},
	}

	unchanged := changedProviders(entries, baseline, cloneFingerprints(baseline))
	if len(unchanged) != 0 {
		t.Fatalf("changedProviders with identical fingerprints = %v, want empty", unchanged)
	}

	next := cloneFingerprints(baseline)
	next["/tmp/codex/auth.json"] = providerAuthFileFingerprint{exists: true, modTime: time.UnixMilli(2000), size: 12}
	changed := changedProviders(entries, baseline, next)
	if len(changed) != 1 || changed[0] != agentprovider.Codex {
		t.Fatalf("changedProviders = %v, want [codex]", changed)
	}
}

func TestChangedProvidersTreatsCreateAndDeleteAsChanges(t *testing.T) {
	entries := []ProviderAuthWatchEntry{
		{Provider: agentprovider.Codex, Paths: []string{"/tmp/codex/auth.json"}},
		{Provider: agentprovider.ClaudeCode, Paths: []string{"/tmp/claude/settings.json"}},
	}
	baseline := map[string]providerAuthFileFingerprint{
		"/tmp/codex/auth.json":      {},
		"/tmp/claude/settings.json": {exists: true, modTime: time.UnixMilli(1000), size: 30},
	}
	next := map[string]providerAuthFileFingerprint{
		"/tmp/codex/auth.json":      {exists: true, modTime: time.UnixMilli(2000), size: 5},
		"/tmp/claude/settings.json": {},
	}

	changed := changedProviders(entries, baseline, next)
	if len(changed) != 2 {
		t.Fatalf("changedProviders = %v, want both providers", changed)
	}
}

func TestProviderAuthWatcherReportsFileRewrites(t *testing.T) {
	dir := t.TempDir()
	authPath := filepath.Join(dir, "auth.json")
	if err := os.WriteFile(authPath, []byte(`{"mode":"chatgpt"}`), 0o600); err != nil {
		t.Fatalf("write baseline auth file: %v", err)
	}

	changes := make(chan []string, 8)
	watcher := &ProviderAuthWatcher{
		Entries: []ProviderAuthWatchEntry{
			{Provider: agentprovider.Codex, Paths: []string{authPath}},
		},
		Interval: 5 * time.Millisecond,
		OnChange: func(providers []string) {
			changes <- providers
		},
	}
	watcher.Start()
	defer watcher.Close()

	// Give the watcher time to record the baseline, then rewrite the file the
	// way credential switchers do (replace content; size change guarantees a
	// fingerprint diff even on coarse mtime filesystems).
	time.Sleep(20 * time.Millisecond)
	if err := os.WriteFile(authPath, []byte(`{"mode":"api-key","key":"sk-test"}`), 0o600); err != nil {
		t.Fatalf("rewrite auth file: %v", err)
	}

	select {
	case providers := <-changes:
		if len(providers) != 1 || providers[0] != agentprovider.Codex {
			t.Fatalf("OnChange providers = %v, want [codex]", providers)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("watcher did not report the auth file rewrite")
	}
}

func TestProviderAuthWatcherStartWithoutCallbackIsInert(_ *testing.T) {
	watcher := &ProviderAuthWatcher{
		Entries: []ProviderAuthWatchEntry{
			{Provider: agentprovider.Codex, Paths: []string{"/tmp/does-not-matter"}},
		},
	}
	watcher.Start()
	watcher.Close()
}

func TestDefaultProviderAuthWatchEntriesCoverCodexClaudeAndOpenCode(t *testing.T) {
	home := t.TempDir()
	configDir := filepath.Join(home, "opencode-config")
	dataDir := filepath.Join(home, "opencode-data")
	configPath := filepath.Join(home, "custom-opencode.json")
	t.Setenv("HOME", home)
	t.Setenv("OPENCODE_CONFIG", configPath)
	t.Setenv("OPENCODE_CONFIG_DIR", configDir)
	t.Setenv("XDG_DATA_HOME", dataDir)

	entries := DefaultProviderAuthWatchEntries()
	byProvider := make(map[string][]string, len(entries))
	for _, entry := range entries {
		byProvider[entry.Provider] = entry.Paths
	}
	if len(byProvider[agentprovider.Codex]) == 0 {
		t.Fatal("expected codex watch paths")
	}
	if len(byProvider[agentprovider.ClaudeCode]) == 0 {
		t.Fatal("expected claude-code watch paths")
	}
	opencodePaths := byProvider[agentprovider.OpenCode]
	if len(opencodePaths) == 0 {
		t.Fatal("expected opencode watch paths")
	}
	for _, want := range []string{
		configPath,
		filepath.Join(configDir, "opencode.json"),
		filepath.Join(configDir, "config.json"),
		filepath.Join(dataDir, "opencode", "auth.json"),
	} {
		if !containsString(opencodePaths, want) {
			t.Fatalf("opencode paths = %v, want %q", opencodePaths, want)
		}
	}
}

func TestProviderAuthWatcherIgnoresNonAuthClaudeStateChurn(t *testing.T) {
	dir := t.TempDir()
	statePath := filepath.Join(dir, ".claude.json")
	writeState := func(content string) {
		t.Helper()
		tempPath := filepath.Join(dir, ".claude.json.next")
		if err := os.WriteFile(tempPath, []byte(content), 0o600); err != nil {
			t.Fatalf("write staged claude state file: %v", err)
		}
		if err := os.Rename(tempPath, statePath); err != nil {
			t.Fatalf("write claude state file: %v", err)
		}
	}
	writeState(`{"oauthAccount":{"emailAddress":"a@b.c"},"history":["one"]}`)

	changes := make(chan []string, 8)
	watcher := &ProviderAuthWatcher{
		Entries: []ProviderAuthWatchEntry{
			{
				Provider:           agentprovider.ClaudeCode,
				Paths:              []string{statePath},
				ContentFingerprint: claudeProviderAuthContentFingerprint(statePath),
			},
		},
		Interval: 5 * time.Millisecond,
		OnChange: func(providers []string) {
			changes <- providers
		},
	}
	watcher.Start()
	defer watcher.Close()

	// Non-auth churn (history grows, mtime/size change) must stay quiet.
	time.Sleep(20 * time.Millisecond)
	writeState(`{"oauthAccount":{"emailAddress":"a@b.c"},"history":["one","two","three"]}`)
	select {
	case providers := <-changes:
		t.Fatalf("watcher reported %v for non-auth state churn", providers)
	case <-time.After(100 * time.Millisecond):
	}

	// A credential switch (oauthAccount changes) must fire.
	writeState(`{"oauthAccount":{"emailAddress":"other@b.c"},"history":["one","two","three"]}`)
	select {
	case providers := <-changes:
		if len(providers) != 1 || providers[0] != agentprovider.ClaudeCode {
			t.Fatalf("OnChange providers = %v, want [claude-code]", providers)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("watcher did not report the credential switch")
	}
}

func TestProviderAuthWatcherReportsOpenCodeConfigRewrites(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "opencode.json")
	if err := os.WriteFile(configPath, []byte(`{"model":"openai/gpt-5"}`), 0o600); err != nil {
		t.Fatalf("write baseline config file: %v", err)
	}

	changes := make(chan []string, 8)
	watcher := &ProviderAuthWatcher{
		Entries: []ProviderAuthWatchEntry{
			{
				Provider:           agentprovider.OpenCode,
				Paths:              []string{configPath},
				ContentFingerprint: hashProviderAuthFileContent,
			},
		},
		Interval: 5 * time.Millisecond,
		OnChange: func(providers []string) {
			changes <- providers
		},
	}
	watcher.Start()
	defer watcher.Close()

	time.Sleep(20 * time.Millisecond)
	if err := os.WriteFile(configPath, []byte(`{"model":"openai/gpt-5.3-codex-spark"}`), 0o600); err != nil {
		t.Fatalf("rewrite config file: %v", err)
	}

	select {
	case providers := <-changes:
		if len(providers) != 1 || providers[0] != agentprovider.OpenCode {
			t.Fatalf("OnChange providers = %v, want [opencode]", providers)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("watcher did not report the opencode config rewrite")
	}
}

func TestProviderAuthFileChangedPrefersContentKey(t *testing.T) {
	previous := providerAuthFileFingerprint{
		exists: true, modTime: time.UnixMilli(1000), size: 10, contentKey: "same",
	}
	next := providerAuthFileFingerprint{
		exists: true, modTime: time.UnixMilli(2000), size: 99, contentKey: "same",
	}
	if providerAuthFileChanged(previous, next) {
		t.Fatal("identical content keys must suppress mtime/size churn")
	}
	next.contentKey = "different"
	if !providerAuthFileChanged(previous, next) {
		t.Fatal("content key change must report")
	}
	// Missing content keys (no fingerprinter or read failure) keep the
	// conservative mtime/size semantics.
	previous.contentKey = ""
	next.contentKey = ""
	if !providerAuthFileChanged(previous, next) {
		t.Fatal("stat change without content keys must report")
	}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func TestJSONSubsetFingerprintTracksOnlySelectedKeys(t *testing.T) {
	base, ok := jsonSubsetFingerprint(
		[]byte(`{"oauthAccount":{"a":1},"history":[1,2,3]}`),
		claudeAuthRelevantStateKeys,
	)
	if !ok {
		t.Fatal("expected fingerprint for JSON object")
	}
	churned, ok := jsonSubsetFingerprint(
		[]byte(`{"oauthAccount":{"a":1},"history":[1,2,3,4,5]}`),
		claudeAuthRelevantStateKeys,
	)
	if !ok || churned != base {
		t.Fatalf("non-auth churn changed fingerprint: %q vs %q", churned, base)
	}
	switched, ok := jsonSubsetFingerprint(
		[]byte(`{"oauthAccount":{"a":2},"history":[1,2,3]}`),
		claudeAuthRelevantStateKeys,
	)
	if !ok || switched == base {
		t.Fatal("auth change did not change fingerprint")
	}
	if _, ok := jsonSubsetFingerprint([]byte(`not-json`), claudeAuthRelevantStateKeys); ok {
		t.Fatal("expected failure for non-JSON payload")
	}
}

func cloneFingerprints(fingerprints map[string]providerAuthFileFingerprint) map[string]providerAuthFileFingerprint {
	cloned := make(map[string]providerAuthFileFingerprint, len(fingerprints))
	for key, value := range fingerprints {
		cloned[key] = value
	}
	return cloned
}
