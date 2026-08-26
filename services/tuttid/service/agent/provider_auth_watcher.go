package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
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

// ProviderAuthChange identifies the exact watched file that caused a provider
// catalog invalidation. Paths are diagnostics only; file contents are never
// included.
type ProviderAuthChange struct {
	Provider string
	Path     string
	Kind     string
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

// providerAuthFingerprint returns a stable, opaque fingerprint for the files
// that define the active provider credentials/configuration. It is shared by
// the persisted model catalog so a catalog from a different account is never
// presented after restart.
func providerAuthFingerprint(provider string) string {
	provider = agentprovider.Normalize(provider)
	if provider == "" {
		return ""
	}
	entries := DefaultProviderAuthWatchEntries()
	hasher := sha256.New()
	found := false
	seen := make(map[string]struct{})
	for _, entry := range entries {
		if agentprovider.Normalize(entry.Provider) != provider {
			continue
		}
		for _, path := range entry.Paths {
			path = filepath.Clean(path)
			if _, ok := seen[path]; ok {
				continue
			}
			seen[path] = struct{}{}
			found = true
			fingerprint := statProviderAuthFile(path)
			if entry.ContentFingerprint != nil && fingerprint.exists {
				fingerprint.contentKey = readProviderAuthContentKey(
					path,
					fingerprint.size,
					entry.ContentFingerprint,
				)
			}
			hasher.Write([]byte(path))
			hasher.Write([]byte{0})
			hasher.Write([]byte(strconv.FormatBool(fingerprint.exists)))
			hasher.Write([]byte{0})
			if fingerprint.contentKey != "" {
				// The watcher treats an identical-content rewrite as unchanged;
				// keep persisted cache identity consistent with that rule.
				hasher.Write([]byte(fingerprint.contentKey))
			} else {
				hasher.Write([]byte(strconv.FormatInt(fingerprint.modTime.UnixNano(), 10)))
				hasher.Write([]byte{0})
				hasher.Write([]byte(strconv.FormatInt(fingerprint.size, 10)))
			}
			hasher.Write([]byte{0})
		}
	}
	if !found {
		return ""
	}
	return hex.EncodeToString(hasher.Sum(nil))
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
	// OnChangeDetailed receives the same coalesced change with the triggering
	// paths attached. It is optional so existing consumers can keep using
	// OnChange while diagnostics opt into the richer signal.
	OnChangeDetailed func(changes []ProviderAuthChange)
	// OnClose releases resources attached to the watcher, such as persistent
	// provider processes owned by the same composition root.
	OnClose func()

	stopOnce      sync.Once
	closeHookOnce sync.Once
	stop          chan struct{}
	done          chan struct{}
	// scanRequests is an internal synchronization seam for deterministic tests.
	// Production leaves it nil, so polling remains ticker-driven.
	scanRequests chan chan struct{}
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
	if w == nil || (w.OnChange == nil && w.OnChangeDetailed == nil) || len(w.Entries) == 0 {
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
	w.closeHookOnce.Do(func() {
		if w.OnClose != nil {
			w.OnClose()
		}
	})
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
	reportedFingerprints := fingerprints
	ticker := time.NewTicker(w.interval())
	defer ticker.Stop()
	pendingProviders := make(map[string]struct{})
	pendingChanges := make(map[string]ProviderAuthChange)
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
		if len(pendingProviders) == 0 && len(pendingChanges) == 0 {
			return
		}
		// Atomic credential rewrites can be observed as exists -> missing ->
		// exists on Windows, where replacing an existing file may require a
		// remove-then-rename fallback. Decide from the net state at the fixed
		// coalesce deadline instead of publishing an intermediate missing scan.
		// The timer is intentionally not reset by later scans, so a real delete
		// or content change is still reported after one bounded delay.
		changes := changedProviderAuthFiles(w.Entries, reportedFingerprints, fingerprints)
		providers := make(map[string]struct{}, len(changes))
		for _, change := range changes {
			if provider := agentprovider.Normalize(change.Provider); provider != "" {
				providers[provider] = struct{}{}
			}
		}
		reportedFingerprints = fingerprints
		sort.Slice(changes, func(i, j int) bool {
			if changes[i].Provider != changes[j].Provider {
				return changes[i].Provider < changes[j].Provider
			}
			return changes[i].Path < changes[j].Path
		})
		pendingProviders = make(map[string]struct{})
		pendingChanges = make(map[string]ProviderAuthChange)
		orderedProviders := providerAuthPendingProviders(w.Entries, providers)
		if len(orderedProviders) > 0 && w.OnChange != nil {
			w.OnChange(orderedProviders)
		}
		if len(changes) > 0 && w.OnChangeDetailed != nil {
			w.OnChangeDetailed(changes)
		}
	}
	scheduleProviderChanges := func(changed []ProviderAuthChange) {
		for _, change := range changed {
			provider := agentprovider.Normalize(change.Provider)
			if provider != "" {
				pendingProviders[provider] = struct{}{}
				change.Provider = provider
				pendingChanges[provider+"\x00"+change.Path] = change
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
	scan := func() {
		next := w.collectFingerprints(fingerprints)
		changed := changedProviderAuthFiles(w.Entries, fingerprints, next)
		fingerprints = next
		if len(changed) > 0 {
			scheduleProviderChanges(changed)
		}
	}
	for {
		select {
		case <-w.stop:
			stopCoalesceTimer()
			return
		case <-ticker.C:
			scan()
		case done := <-w.scanRequests:
			scan()
			close(done)
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
	changes := changedProviderAuthFiles(entries, previous, next)
	providers := make([]string, 0, len(changes))
	seen := make(map[string]struct{}, len(changes))
	for _, change := range changes {
		if _, ok := seen[change.Provider]; ok {
			continue
		}
		seen[change.Provider] = struct{}{}
		providers = append(providers, change.Provider)
	}
	return providers
}

func changedProviderAuthFiles(
	entries []ProviderAuthWatchEntry,
	previous map[string]providerAuthFileFingerprint,
	next map[string]providerAuthFileFingerprint,
) []ProviderAuthChange {
	changed := make([]ProviderAuthChange, 0, len(entries))
	seenPaths := make(map[string]struct{})
	for _, entry := range entries {
		provider := agentprovider.Normalize(entry.Provider)
		if provider == "" {
			continue
		}
		for _, path := range entry.Paths {
			path = filepath.Clean(path)
			if _, ok := seenPaths[path]; ok {
				continue
			}
			seenPaths[path] = struct{}{}
			if !providerAuthFileChanged(previous[path], next[path]) {
				continue
			}
			changed = append(changed, ProviderAuthChange{
				Provider: provider,
				Path:     path,
				Kind:     providerAuthFileChangeKind(previous[path], next[path]),
			})
		}
	}
	return changed
}

func providerAuthFileChangeKind(previous, next providerAuthFileFingerprint) string {
	switch {
	case !previous.exists && next.exists:
		return "created"
	case previous.exists && !next.exists:
		return "deleted"
	case previous.contentKey != "" && next.contentKey != "":
		return "content_changed"
	default:
		return "metadata_changed"
	}
}

func providerAuthFileChanged(previous, next providerAuthFileFingerprint) bool {
	// When both polls produced a content fingerprint, it alone decides: the
	// file body churning without an auth-relevant change must stay quiet.
	if previous.contentKey != "" && next.contentKey != "" {
		return previous.contentKey != next.contentKey
	}
	return previous != next
}
