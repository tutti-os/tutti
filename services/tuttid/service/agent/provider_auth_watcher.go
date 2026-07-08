package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

const defaultProviderAuthWatchInterval = 2 * time.Second

// providerAuthFileMaxContentBytes caps how much of a watched file the watcher
// is willing to read per change when computing a content fingerprint. Files
// larger than this fall back to mtime+size semantics.
const providerAuthFileMaxContentBytes = 32 << 20

// ProviderAuthWatchEntry describes the on-disk auth/config files whose changes
// invalidate the cached model catalog of one provider.
type ProviderAuthWatchEntry struct {
	Provider string
	Paths    []string
	// ContentFingerprint optionally reduces a watched file's bytes to the
	// auth-relevant fingerprint for the given path. When set, a file whose
	// mtime/size changed only reports a provider change if this fingerprint
	// changed too. Claude Code needs this: ~/.claude.json is the CLI's general
	// state file and is rewritten continuously while any session runs, but its
	// auth-relevant fields only change on a real credential switch.
	ContentFingerprint func(path string, data []byte) string
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
	opencodePaths := defaultOpenCodeAuthWatchPaths(home)
	entries := make([]ProviderAuthWatchEntry, 0, 3)
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
		claudeStatePath := ""
		if home != "" {
			claudeStatePath = filepath.Join(home, ".claude.json")
			claudePaths = append(claudePaths, claudeStatePath)
		}
		entries = append(entries, ProviderAuthWatchEntry{
			Provider:           agentprovider.ClaudeCode,
			Paths:              claudePaths,
			ContentFingerprint: claudeProviderAuthContentFingerprint(claudeStatePath),
		})
	}
	if len(opencodePaths) > 0 {
		entries = append(entries, ProviderAuthWatchEntry{
			Provider:           agentprovider.OpenCode,
			Paths:              opencodePaths,
			ContentFingerprint: hashProviderAuthFileContent,
		})
	}
	return entries
}

func defaultOpenCodeAuthWatchPaths(home string) []string {
	paths := []string{}
	if configPath := strings.TrimSpace(os.Getenv("OPENCODE_CONFIG")); configPath != "" {
		paths = append(paths, configPath)
	}
	configDir := strings.TrimSpace(os.Getenv("OPENCODE_CONFIG_DIR"))
	if configDir == "" {
		configDir = strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME"))
		if configDir != "" {
			configDir = filepath.Join(configDir, "opencode")
		}
	}
	if configDir == "" && home != "" {
		configDir = filepath.Join(home, ".config", "opencode")
	}
	if configDir != "" {
		paths = append(paths,
			filepath.Join(configDir, "opencode.json"),
			filepath.Join(configDir, "config.json"),
		)
	}
	dataDir := strings.TrimSpace(os.Getenv("XDG_DATA_HOME"))
	if dataDir != "" {
		dataDir = filepath.Join(dataDir, "opencode")
	} else if home != "" {
		dataDir = filepath.Join(home, ".local", "share", "opencode")
	}
	if dataDir != "" {
		paths = append(paths, filepath.Join(dataDir, "auth.json"))
	}
	return uniqueNonEmptyPaths(paths)
}

func uniqueNonEmptyPaths(paths []string) []string {
	result := make([]string, 0, len(paths))
	seen := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		cleaned := filepath.Clean(path)
		if _, ok := seen[cleaned]; ok {
			continue
		}
		seen[cleaned] = struct{}{}
		result = append(result, cleaned)
	}
	return result
}

// claudeAuthRelevantStateKeys lists the top-level ~/.claude.json fields that
// identify the active credentials. Everything else in that file (history,
// per-project state, telemetry counters, ...) churns while a session runs and
// must not invalidate the model catalog.
var claudeAuthRelevantStateKeys = []string{
	"customApiKeyResponses",
	"oauthAccount",
	"primaryApiKey",
	"userID",
}

// claudeProviderAuthContentFingerprint fingerprints ~/.claude.json by its
// auth-relevant fields only, and every other watched Claude file by its full
// contents (so a touch that rewrites identical bytes stays quiet).
func claudeProviderAuthContentFingerprint(
	claudeStatePath string,
) func(path string, data []byte) string {
	return func(path string, data []byte) string {
		if claudeStatePath != "" && path == claudeStatePath {
			if fingerprint, ok := jsonSubsetFingerprint(data, claudeAuthRelevantStateKeys); ok {
				return fingerprint
			}
		}
		return hashProviderAuthFileContent(path, data)
	}
}

func hashProviderAuthFileContent(_ string, data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// jsonSubsetFingerprint hashes the raw values of the given top-level keys of a
// JSON object. Returns false when the payload is not a JSON object.
func jsonSubsetFingerprint(data []byte, keys []string) (string, bool) {
	var topLevel map[string]json.RawMessage
	if err := json.Unmarshal(data, &topLevel); err != nil {
		return "", false
	}
	sorted := append([]string(nil), keys...)
	sort.Strings(sorted)
	hasher := sha256.New()
	for _, key := range sorted {
		hasher.Write([]byte(key))
		hasher.Write([]byte{0})
		hasher.Write(topLevel[key])
		hasher.Write([]byte{0})
	}
	return hex.EncodeToString(hasher.Sum(nil)), true
}

// ProviderAuthWatcher polls provider auth/config marker files and reports the
// providers whose files changed since the previous poll. Polling (rather than
// fsnotify) keeps the watcher robust against atomic rename rewrites, files
// that do not exist yet, and directories created after startup; the per-tick
// cost is a handful of stat calls (file contents are only re-read when
// mtime/size moved).
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
	// contentKey is the auth-relevant content fingerprint for paths with a
	// ContentFingerprint, "" otherwise (or when reading failed).
	contentKey string
}

func (f providerAuthFileFingerprint) statEqual(other providerAuthFileFingerprint) bool {
	return f.exists == other.exists &&
		f.modTime.Equal(other.modTime) &&
		f.size == other.size
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
	fingerprints := w.collectFingerprints(nil)
	ticker := time.NewTicker(w.interval())
	defer ticker.Stop()
	for {
		select {
		case <-w.stop:
			return
		case <-ticker.C:
			next := w.collectFingerprints(fingerprints)
			changed := changedProviders(w.Entries, fingerprints, next)
			fingerprints = next
			if len(changed) > 0 {
				w.OnChange(changed)
			}
		}
	}
}

func (w *ProviderAuthWatcher) collectFingerprints(
	previous map[string]providerAuthFileFingerprint,
) map[string]providerAuthFileFingerprint {
	fingerprints := make(map[string]providerAuthFileFingerprint)
	for _, entry := range w.Entries {
		for _, path := range entry.Paths {
			if _, ok := fingerprints[path]; ok {
				continue
			}
			fingerprint := statProviderAuthFile(path)
			if entry.ContentFingerprint != nil && fingerprint.exists {
				prev, hasPrev := previous[path]
				if hasPrev && fingerprint.statEqual(prev) {
					// File untouched since last poll: keep the known content key
					// without re-reading.
					fingerprint.contentKey = prev.contentKey
				} else {
					fingerprint.contentKey = readProviderAuthContentKey(
						path,
						fingerprint.size,
						entry.ContentFingerprint,
					)
				}
			}
			fingerprints[path] = fingerprint
		}
	}
	return fingerprints
}

func readProviderAuthContentKey(
	path string,
	size int64,
	contentFingerprint func(path string, data []byte) string,
) string {
	if size > providerAuthFileMaxContentBytes {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return contentFingerprint(path, data)
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
			if !providerAuthFileChanged(previous[path], next[path]) {
				continue
			}
			seen[provider] = struct{}{}
			changed = append(changed, provider)
			break
		}
	}
	return changed
}

func providerAuthFileChanged(previous, next providerAuthFileFingerprint) bool {
	// When both polls produced a content fingerprint, it alone decides: the
	// file body churning without an auth-relevant change must stay quiet.
	if previous.contentKey != "" && next.contentKey != "" {
		return previous.contentKey != next.contentKey
	}
	return previous != next
}
