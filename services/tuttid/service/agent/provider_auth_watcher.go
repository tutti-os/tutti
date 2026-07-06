package agent

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

const defaultProviderAuthWatchInterval = 2 * time.Second

// ProviderAuthWatchEntry describes the on-disk auth/config files whose changes
// invalidate the cached model catalog of one provider.
type ProviderAuthWatchEntry struct {
	Provider string
	Paths    []string
}

// DefaultProviderAuthWatchEntries returns the auth/config marker files for the
// providers whose model catalog depends on the active credentials. External
// credential switchers (for example cc-switch) rewrite these files without
// going through tuttid, so the daemon watches them to know when cached model
// lists went stale.
func DefaultProviderAuthWatchEntries() []ProviderAuthWatchEntry {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if codexHome == "" && home != "" {
		codexHome = filepath.Join(home, ".codex")
	}
	claudeConfigDir := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR"))
	if claudeConfigDir == "" && home != "" {
		claudeConfigDir = filepath.Join(home, ".claude")
	}
	entries := make([]ProviderAuthWatchEntry, 0, 2)
	if codexHome != "" {
		entries = append(entries, ProviderAuthWatchEntry{
			Provider: agentprovider.Codex,
			Paths: []string{
				filepath.Join(codexHome, "auth.json"),
				filepath.Join(codexHome, codexConfigFileName),
			},
		})
	}
	if claudeConfigDir != "" {
		claudePaths := []string{
			filepath.Join(claudeConfigDir, "settings.json"),
			filepath.Join(claudeConfigDir, "auth.json"),
		}
		if home != "" {
			claudePaths = append(claudePaths, filepath.Join(home, ".claude.json"))
		}
		entries = append(entries, ProviderAuthWatchEntry{
			Provider: agentprovider.ClaudeCode,
			Paths:    claudePaths,
		})
	}
	return entries
}

// ProviderAuthWatcher polls provider auth/config marker files and reports the
// providers whose files changed since the previous poll. Polling (rather than
// fsnotify) keeps the watcher robust against atomic rename rewrites, files
// that do not exist yet, and directories created after startup; the per-tick
// cost is a handful of stat calls.
type ProviderAuthWatcher struct {
	Entries  []ProviderAuthWatchEntry
	Interval time.Duration
	// OnChange receives the normalized provider ids whose marker files changed.
	// Called from the watcher goroutine; implementations must not block for
	// long.
	OnChange func(providers []string)

	stopOnce sync.Once
	stop     chan struct{}
	done     chan struct{}
}

type providerAuthFileFingerprint struct {
	exists  bool
	modTime time.Time
	size    int64
}

// Start begins polling in a background goroutine. The first poll only records
// the baseline fingerprints; changes are reported from the second poll on.
func (w *ProviderAuthWatcher) Start() {
	if w == nil || w.OnChange == nil || len(w.Entries) == 0 {
		return
	}
	w.stop = make(chan struct{})
	w.done = make(chan struct{})
	go w.run()
}

// Close stops the polling goroutine and waits for it to exit.
func (w *ProviderAuthWatcher) Close() {
	if w == nil || w.stop == nil {
		return
	}
	w.stopOnce.Do(func() {
		close(w.stop)
	})
	<-w.done
}

func (w *ProviderAuthWatcher) interval() time.Duration {
	if w.Interval > 0 {
		return w.Interval
	}
	return defaultProviderAuthWatchInterval
}

func (w *ProviderAuthWatcher) run() {
	defer close(w.done)
	fingerprints := w.collectFingerprints()
	ticker := time.NewTicker(w.interval())
	defer ticker.Stop()
	for {
		select {
		case <-w.stop:
			return
		case <-ticker.C:
			next := w.collectFingerprints()
			changed := changedProviders(w.Entries, fingerprints, next)
			fingerprints = next
			if len(changed) > 0 {
				w.OnChange(changed)
			}
		}
	}
}

func (w *ProviderAuthWatcher) collectFingerprints() map[string]providerAuthFileFingerprint {
	fingerprints := make(map[string]providerAuthFileFingerprint)
	for _, entry := range w.Entries {
		for _, path := range entry.Paths {
			if _, ok := fingerprints[path]; ok {
				continue
			}
			fingerprints[path] = statProviderAuthFile(path)
		}
	}
	return fingerprints
}

func statProviderAuthFile(path string) providerAuthFileFingerprint {
	info, err := os.Stat(path)
	if err != nil {
		return providerAuthFileFingerprint{}
	}
	return providerAuthFileFingerprint{
		exists:  true,
		modTime: info.ModTime(),
		size:    info.Size(),
	}
}

func changedProviders(
	entries []ProviderAuthWatchEntry,
	previous map[string]providerAuthFileFingerprint,
	next map[string]providerAuthFileFingerprint,
) []string {
	changed := make([]string, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		provider := agentprovider.Normalize(entry.Provider)
		if provider == "" {
			continue
		}
		if _, ok := seen[provider]; ok {
			continue
		}
		for _, path := range entry.Paths {
			if previous[path] == next[path] {
				continue
			}
			seen[provider] = struct{}{}
			changed = append(changed, provider)
			break
		}
	}
	return changed
}
