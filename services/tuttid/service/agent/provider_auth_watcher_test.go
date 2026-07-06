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

func TestDefaultProviderAuthWatchEntriesCoverCodexAndClaude(t *testing.T) {
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
}

func cloneFingerprints(fingerprints map[string]providerAuthFileFingerprint) map[string]providerAuthFileFingerprint {
	cloned := make(map[string]providerAuthFileFingerprint, len(fingerprints))
	for key, value := range fingerprints {
		cloned[key] = value
	}
	return cloned
}
