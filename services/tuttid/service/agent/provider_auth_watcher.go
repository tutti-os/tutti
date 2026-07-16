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

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

const defaultProviderAuthWatchInterval = 2 * time.Second
const defaultProviderAuthChangeCoalesceDelay = 1 * time.Second

// providerAuthFileMaxContentBytes caps how much of a watched file the watcher
// is willing to read per change when computing a content fingerprint. Files
// larger than this fall back to mtime+size semantics.
const providerAuthFileMaxContentBytes = 32 << 20

// ProviderAuthWatchEntry describes the on-disk auth/config files whose changes
// refresh one provider's model catalog consumers and invalidate any cached
// catalog for that provider.
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
// going through tuttid, so the daemon watches them to refresh open composers;
// providers that cache model lists also drop those cached results.
func DefaultProviderAuthWatchEntries() []ProviderAuthWatchEntry {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	entries := make([]ProviderAuthWatchEntry, 0, len(providerregistry.Migrated()))
	for _, descriptor := range providerregistry.Migrated() {
		if entry, ok := providerAuthWatchEntryFromDescriptor(descriptor, home); ok {
			entries = append(entries, entry)
		}
	}
	return entries
}

func providerAuthWatchEntryFromDescriptor(
	descriptor providerregistry.ProviderDescriptor,
	home string,
) (ProviderAuthWatchEntry, bool) {
	watch := descriptor.Status.AuthWatch
	if len(watch.Sources) == 0 {
		return ProviderAuthWatchEntry{}, false
	}
	paths := []string{}
	for _, source := range watch.Sources {
		for _, envVar := range source.PathEnvVars {
			if path := strings.TrimSpace(os.Getenv(strings.TrimSpace(envVar))); path != "" {
				paths = append(paths, expandProviderAuthWatchHome(path, home))
			}
		}
		root := ""
		for _, candidate := range source.RootCandidates {
			root = strings.TrimSpace(os.Getenv(strings.TrimSpace(candidate.EnvVar)))
			if root == "" {
				continue
			}
			if suffix := strings.TrimSpace(candidate.Suffix); suffix != "" {
				root = filepath.Join(root, suffix)
			}
			break
		}
		if root == "" {
			root = strings.TrimSpace(source.DefaultRoot)
		}
		root = expandProviderAuthWatchHome(root, home)
		if root == "" {
			continue
		}
		for _, path := range source.Paths {
			path = strings.TrimSpace(path)
			if path == "" {
				continue
			}
			if !filepath.IsAbs(path) {
				path = filepath.Join(root, path)
			}
			paths = append(paths, path)
		}
	}
	paths = uniqueNonEmptyPaths(paths)
	if len(paths) == 0 {
		return ProviderAuthWatchEntry{}, false
	}
	entry := ProviderAuthWatchEntry{
		Provider: descriptor.Identity.ID,
		Paths:    paths,
	}
	if watch.ContentFingerprint == providerregistry.AuthWatchContentFingerprintFullFile {
		entry.ContentFingerprint = hashProviderAuthFileContent
	}
	if watch.ContentFingerprint == providerregistry.AuthWatchContentFingerprintClaudeState {
		claudeStatePath := ""
		if strings.TrimSpace(home) != "" {
			claudeStatePath = filepath.Join(home, ".claude.json")
		}
		entry.ContentFingerprint = claudeProviderAuthContentFingerprint(claudeStatePath)
	}
	return entry, true
}

func expandProviderAuthWatchHome(path string, home string) string {
	path = strings.TrimSpace(path)
	if path == "~" {
		return strings.TrimSpace(home)
	}
	if strings.HasPrefix(path, "~/") {
		if strings.TrimSpace(home) == "" {
			return ""
		}
		return filepath.Join(home, strings.TrimPrefix(path, "~/"))
	}
	return path
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
	Entries       []ProviderAuthWatchEntry
	Interval      time.Duration
	CoalesceDelay time.Duration
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

func (w *ProviderAuthWatcher) coalesceDelay() time.Duration {
	if w.CoalesceDelay < 0 {
		return 0
	}
	if w.CoalesceDelay > 0 {
		return w.CoalesceDelay
	}
	return defaultProviderAuthChangeCoalesceDelay
}

func (w *ProviderAuthWatcher) run() {
	defer close(w.done)
	fingerprints := w.collectFingerprints(nil)
	ticker := time.NewTicker(w.interval())
	defer ticker.Stop()
	pendingProviders := make(map[string]struct{})
	var coalesceTimer *time.Timer
	var coalesceTimerC <-chan time.Time
	stopCoalesceTimer := func() {
		if coalesceTimer == nil {
			return
		}
		if !coalesceTimer.Stop() {
			select {
			case <-coalesceTimer.C:
			default:
			}
		}
		coalesceTimer = nil
		coalesceTimerC = nil
	}
	flushPendingProviders := func() {
		if len(pendingProviders) == 0 {
			return
		}
		providers := providerAuthPendingProviders(w.Entries, pendingProviders)
		pendingProviders = make(map[string]struct{})
		if len(providers) > 0 {
			w.OnChange(providers)
		}
	}
	scheduleProviderChanges := func(changed []string) {
		for _, provider := range changed {
			if normalized := agentprovider.Normalize(provider); normalized != "" {
				pendingProviders[normalized] = struct{}{}
			}
		}
		if len(pendingProviders) == 0 {
			return
		}
		delay := w.coalesceDelay()
		if delay <= 0 {
			flushPendingProviders()
			return
		}
		if coalesceTimer == nil {
			coalesceTimer = time.NewTimer(delay)
			coalesceTimerC = coalesceTimer.C
		}
	}
	for {
		select {
		case <-w.stop:
			stopCoalesceTimer()
			return
		case <-ticker.C:
			next := w.collectFingerprints(fingerprints)
			changed := changedProviders(w.Entries, fingerprints, next)
			fingerprints = next
			if len(changed) > 0 {
				scheduleProviderChanges(changed)
			}
		case <-coalesceTimerC:
			coalesceTimer = nil
			coalesceTimerC = nil
			flushPendingProviders()
		}
	}
}

func providerAuthPendingProviders(
	entries []ProviderAuthWatchEntry,
	pending map[string]struct{},
) []string {
	if len(pending) == 0 {
		return nil
	}
	providers := make([]string, 0, len(pending))
	seen := make(map[string]struct{}, len(pending))
	for _, entry := range entries {
		provider := agentprovider.Normalize(entry.Provider)
		if provider == "" {
			continue
		}
		if _, ok := pending[provider]; !ok {
			continue
		}
		if _, ok := seen[provider]; ok {
			continue
		}
		seen[provider] = struct{}{}
		providers = append(providers, provider)
	}
	for provider := range pending {
		if _, ok := seen[provider]; ok {
			continue
		}
		providers = append(providers, provider)
	}
	sort.Strings(providers[len(seen):])
	return providers
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
