package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/modelcatalog"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	tuttiagentservice "github.com/tutti-os/tutti/services/tuttid/service/tuttiagent"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
	"golang.org/x/sync/singleflight"
)

const (
	codexModelCacheTTL       = 5 * time.Minute
	codexModelErrorCacheTTL  = 5 * time.Second
	modelCatalogFetchTimeout = 12 * time.Second
)

type AgentModelOption = modelcatalog.ModelOption

type AgentModelReasoningEffortOption = modelcatalog.ReasoningEffortOption

type AgentModelSpeedOption = modelcatalog.SpeedOption

type AgentModelCatalogResult struct {
	Provider  string
	Source    string
	FetchedAt time.Time
	Models    []AgentModelOption
	// Stale means the result is usable for presentation but is being refreshed
	// after an auth/config change or TTL expiry. Callers that need an
	// authoritative validation result must not accept stale models.
	Stale bool
}

type AgentModelCatalogInput struct {
	Provider string
	Cwd      string
	// WaitForFresh makes a stale cached result synchronous. Normal composer
	// loads leave this false so the stale result can render immediately while a
	// refresh runs in the background; the explicit model picker request sets it.
	WaitForFresh bool
}

type AgentModelCatalog interface {
	ListModels(context.Context, AgentModelCatalogInput) (AgentModelCatalogResult, error)
}

type AgentModelListResult struct {
	Models     []AgentModelOption
	IsFallback bool
}

type AgentModelLister interface {
	ListModels(context.Context) (AgentModelListResult, error)
}

// agentModelCatalogSpec declares how one provider's model list is fetched and
// cached. Adding a provider to the catalog means adding one entry to
// agentModelCatalogSpecs (and a lister field on CachedAgentModelCatalog for
// test injection).
type agentModelCatalogSpec struct {
	// source labels the catalog origin surfaced to the GUI (e.g. "codex-cli").
	source string
	// ttl caches a successful, non-fallback list. Zero disables successful
	// result caching for providers whose catalogs depend on request context.
	ttl time.Duration
	// errTTL caches a failed fetch (avoids hammering a broken CLI).
	errTTL time.Duration
	// fallbackTTL caches a fallback list when the lister flags one; zero
	// means fallback results use the normal ttl.
	fallbackTTL time.Duration
	// lister picks the injected lister off the catalog, falling back to the
	// default CLI-backed implementation.
	lister func(*CachedAgentModelCatalog, AgentModelCatalogInput) AgentModelLister
	// configuredDefaultModel reads the user's CLI-configured default model;
	// it is marked (or appended) as the default option.
	configuredDefaultModel func() string
	// missingDefaultDescription describes a configured default model that the
	// lister did not return.
	missingDefaultDescription string
}

func defaultAgentModelCatalogSpecs() map[string]agentModelCatalogSpec {
	specs := make(map[string]agentModelCatalogSpec, len(providerregistry.Migrated()))
	for _, descriptor := range providerregistry.Migrated() {
		spec, ok, err := agentModelCatalogSpecFromDescriptor(descriptor)
		if err != nil {
			panic(fmt.Sprintf("invalid provider model catalog descriptor: %v", err))
		}
		if ok {
			specs[descriptor.Identity.ID] = spec
		}
	}
	return specs
}

var agentModelCatalogSpecs = defaultAgentModelCatalogSpecs()

func agentModelCatalogSpecFromDescriptor(descriptor providerregistry.ProviderDescriptor) (agentModelCatalogSpec, bool, error) {
	switch descriptor.ComposerProfile.ModelCatalog {
	case "":
		return agentModelCatalogSpec{}, false, nil
	case providerregistry.ModelCatalogKindCodexCLI:
		command := append([]string(nil), descriptor.Runtime.Command...)
		if len(command) == 0 || strings.TrimSpace(command[0]) == "" {
			return agentModelCatalogSpec{}, false, fmt.Errorf(
				"provider %q model catalog runtime command is required",
				descriptor.Identity.ID,
			)
		}
		return agentModelCatalogSpec{
			source: string(descriptor.ComposerProfile.ModelCatalog),
			ttl:    codexModelCacheTTL,
			errTTL: codexModelErrorCacheTTL,
			lister: func(c *CachedAgentModelCatalog, _ AgentModelCatalogInput) AgentModelLister {
				if c.Codex != nil {
					return c.Codex
				}
				lister := CodexCLIModelLister{
					Command:          command[0],
					Args:             append([]string(nil), command[1:]...),
					Provider:         descriptor.Identity.ID,
					ProviderCommands: c.ProviderCommands,
				}
				lister.Session = c.codexSession(descriptor.Identity.ID, lister)
				return lister
			},
			configuredDefaultModel:    readCodexConfiguredDefaultModel,
			missingDefaultDescription: descriptor.Identity.DisplayName + " configured custom model",
		}, true, nil
	case providerregistry.ModelCatalogKindOpenCodeCLI:
		command := append([]string(nil), descriptor.Runtime.Command...)
		if len(command) == 0 || strings.TrimSpace(command[0]) == "" {
			return agentModelCatalogSpec{}, false, fmt.Errorf(
				"provider %q model catalog runtime command is required",
				descriptor.Identity.ID,
			)
		}
		return agentModelCatalogSpec{
			source: string(descriptor.ComposerProfile.ModelCatalog),
			lister: func(c *CachedAgentModelCatalog, input AgentModelCatalogInput) AgentModelLister {
				if c.OpenCode != nil {
					return c.OpenCode
				}
				return OpenCodeCLIModelLister{
					Command: command[0],
					Args:    []string{"models", "--verbose"},
					Cwd:     strings.TrimSpace(input.Cwd),
				}
			},
			configuredDefaultModel:    readOpenCodeConfiguredDefaultModel,
			missingDefaultDescription: descriptor.Identity.DisplayName + " configured custom model",
		}, true, nil
	case providerregistry.ModelCatalogKindTuttiCLI:
		return agentModelCatalogSpec{
			source: string(descriptor.ComposerProfile.ModelCatalog), ttl: codexModelCacheTTL, errTTL: codexModelErrorCacheTTL,
			lister: func(c *CachedAgentModelCatalog, _ AgentModelCatalogInput) AgentModelLister {
				if c.TuttiAgent != nil {
					return c.TuttiAgent
				}
				lister := defaultTuttiAgentModelLister(descriptor.Identity.ID, c.ProviderCommands)
				lister.Session = c.codexSession(descriptor.Identity.ID, lister)
				return lister
			},
			configuredDefaultModel: func() string { return "" },
		}, true, nil
	default:
		return agentModelCatalogSpec{}, false, fmt.Errorf(
			"provider %q model catalog kind %q is unsupported",
			descriptor.Identity.ID,
			descriptor.ComposerProfile.ModelCatalog,
		)
	}
}

type CachedAgentModelCatalog struct {
	Codex             AgentModelLister
	TuttiAgent        AgentModelLister
	OpenCode          AgentModelLister
	ModelCapabilities ModelCapabilitiesResolver
	ProviderCommands  ProviderCommandResolver
	Now               func() time.Time
	// PersistentPath is configured by the daemon composition root. Keeping the
	// path injectable leaves unit tests in-memory and avoids coupling them to a
	// developer's real provider cache.
	PersistentPath string
	// AuthFingerprint is injectable for tests; production uses the watched
	// provider auth/config files.
	AuthFingerprint func(provider string) string
	// OnRefresh is called after a stale catalog has been refreshed successfully.
	// It is an invalidation hint; the next consumer read remains authoritative.
	OnRefresh func(provider string)

	mu             sync.Mutex
	cache          map[string]*agentModelCatalogCacheEntry
	generation     map[string]uint64
	codexSessions  map[string]*codexAppServerSession
	loads          singleflight.Group
	persistentOnce sync.Once
}

type agentModelCatalogCacheEntry struct {
	result           AgentModelCatalogResult
	err              error
	expiresAtMS      int64
	refreshRetryAtMS int64
	stale            bool
	generation       uint64
	authFingerprint  string
}

type persistedAgentModelCatalog struct {
	Version int                                        `json:"version"`
	Entries map[string]persistedAgentModelCatalogEntry `json:"entries"`
}

type persistedAgentModelCatalogEntry struct {
	Provider        string             `json:"provider"`
	Source          string             `json:"source"`
	FetchedAt       time.Time          `json:"fetchedAt"`
	Models          []AgentModelOption `json:"models"`
	AuthFingerprint string             `json:"authFingerprint,omitempty"`
}

type agentModelCatalogFetchOutcome struct {
	result       AgentModelCatalogResult
	err          error
	staleRefresh bool
	accepted     bool
}

func NewAgentModelCatalog() *CachedAgentModelCatalog {
	return &CachedAgentModelCatalog{}
}

func (c *CachedAgentModelCatalog) ensurePersistentCacheLoaded() {
	if c == nil || strings.TrimSpace(c.PersistentPath) == "" {
		return
	}
	c.persistentOnce.Do(func() {
		path := strings.TrimSpace(c.PersistentPath)
		data, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			return
		}
		if err != nil {
			slog.Warn("agent model catalog persistent cache read failed",
				"event", "agent.model_catalog.persistent_load_failed",
				"path", path,
				"error", err,
			)
			return
		}
		var persisted persistedAgentModelCatalog
		if err := json.Unmarshal(data, &persisted); err != nil || persisted.Version != 1 {
			if err == nil {
				err = fmt.Errorf("unsupported cache version %d", persisted.Version)
			}
			slog.Warn("agent model catalog persistent cache ignored",
				"event", "agent.model_catalog.persistent_load_ignored",
				"path", path,
				"error", err,
			)
			return
		}
		now := c.now()
		loaded := 0
		c.mu.Lock()
		if c.cache == nil {
			c.cache = make(map[string]*agentModelCatalogCacheEntry)
		}
		if c.generation == nil {
			c.generation = make(map[string]uint64)
		}
		for provider, entry := range persisted.Entries {
			provider = agentprovider.Normalize(provider)
			if provider == "" || len(entry.Models) == 0 {
				continue
			}
			if strings.TrimSpace(entry.Provider) == "" {
				entry.Provider = provider
			}
			c.cache[provider] = &agentModelCatalogCacheEntry{
				result: AgentModelCatalogResult{
					Provider:  entry.Provider,
					Source:    entry.Source,
					FetchedAt: entry.FetchedAt,
					Models:    cloneAgentModelOptions(entry.Models),
					Stale:     true,
				},
				expiresAtMS:     now.UnixMilli(),
				stale:           true,
				authFingerprint: entry.AuthFingerprint,
			}
			loaded++
		}
		c.mu.Unlock()
		if loaded > 0 {
			slog.Info("agent model catalog persistent cache loaded",
				"event", "agent.model_catalog.persistent_loaded",
				"path", path,
				"providerCount", loaded,
			)
		}
	})
}

func (c *CachedAgentModelCatalog) authFingerprint(provider string) string {
	if c.AuthFingerprint != nil {
		return strings.TrimSpace(c.AuthFingerprint(provider))
	}
	return providerAuthFingerprint(provider)
}

func (c *CachedAgentModelCatalog) cacheAuthMatches(provider, cachedFingerprint string) bool {
	if strings.TrimSpace(cachedFingerprint) == "" {
		return true
	}
	return cachedFingerprint == c.authFingerprint(provider)
}

func (c *CachedAgentModelCatalog) ListModels(ctx context.Context, input AgentModelCatalogInput) (AgentModelCatalogResult, error) {
	provider := agentprovider.Normalize(input.Provider)
	input.Provider = provider
	input.Cwd = strings.TrimSpace(input.Cwd)
	c.ensurePersistentCacheLoaded()
	spec, ok := agentModelCatalogSpecs[provider]
	if !ok {
		return AgentModelCatalogResult{}, ErrInvalidArgument
	}
	now := c.now()
	if specCachesModelCatalog(spec) {
		if cached := c.readCache(provider, now); cached != nil {
			if !c.cacheAuthMatches(provider, cached.authFingerprint) {
				slog.Info("agent model catalog cache rejected for auth generation",
					"event", "agent.model_catalog.cache_rejected",
					"provider", provider,
					"reason", "auth_fingerprint_mismatch",
				)
				c.Invalidate(provider)
				return c.loadModels(ctx, input, spec, false, c.currentGeneration(provider))
			}
			if cached.err == nil && cached.stale {
				if input.WaitForFresh {
					return c.loadModels(ctx, input, spec, false, cached.generation)
				}
				if now.UnixMilli() >= cached.refreshRetryAtMS {
					c.startBackgroundRefresh(input, spec, cached.generation)
				}
				stale := cloneAgentModelCatalogResult(cached.result)
				stale.Stale = true
				return stale, nil
			}
			return cached.result, cached.err
		}
	}
	return c.loadModels(ctx, input, spec, false, c.currentGeneration(provider))
}

func (c *CachedAgentModelCatalog) loadModels(
	ctx context.Context,
	input AgentModelCatalogInput,
	spec agentModelCatalogSpec,
	staleRefresh bool,
	expectedGeneration uint64,
) (AgentModelCatalogResult, error) {
	provider := agentprovider.Normalize(input.Provider)
	key := provider
	if !specCachesModelCatalog(spec) {
		key += "\x00" + strings.TrimSpace(input.Cwd)
	}
	startedAt := time.Now()
	resultCh := c.loads.DoChan(key, func() (any, error) {
		fetchContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), modelCatalogFetchTimeout)
		defer cancel()
		return c.fetchModels(fetchContext, input, spec, staleRefresh, expectedGeneration), nil
	})
	select {
	case <-ctx.Done():
		return AgentModelCatalogResult{}, ctx.Err()
	case shared := <-resultCh:
		outcome, ok := shared.Val.(agentModelCatalogFetchOutcome)
		if !ok {
			return AgentModelCatalogResult{}, fmt.Errorf("model catalog fetch returned invalid result")
		}
		if !outcome.accepted && !staleRefresh && specCachesModelCatalog(spec) {
			// An auth/config invalidation raced the cold fetch. Do not return a
			// catalog produced from the old credential generation.
			return c.loadModels(ctx, input, spec, false, c.currentGeneration(provider))
		}
		slog.Info("agent model catalog request settled",
			"event", "agent.model_catalog.request_settled",
			"provider", provider,
			"shared", shared.Shared,
			"stale_refresh", staleRefresh,
			"durationMs", time.Since(startedAt).Milliseconds(),
			"error", outcome.err,
		)
		return cloneAgentModelCatalogResult(outcome.result), outcome.err
	}
}

func (c *CachedAgentModelCatalog) startBackgroundRefresh(
	input AgentModelCatalogInput,
	spec agentModelCatalogSpec,
	expectedGeneration uint64,
) {
	provider := agentprovider.Normalize(input.Provider)
	key := provider
	if !specCachesModelCatalog(spec) {
		key += "\x00" + strings.TrimSpace(input.Cwd)
	}
	resultCh := c.loads.DoChan(key, func() (any, error) {
		fetchContext, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), modelCatalogFetchTimeout)
		defer cancel()
		return c.fetchModels(fetchContext, input, spec, true, expectedGeneration), nil
	})
	go func() {
		<-resultCh
	}()
}

func (c *CachedAgentModelCatalog) fetchModels(
	ctx context.Context,
	input AgentModelCatalogInput,
	spec agentModelCatalogSpec,
	staleRefresh bool,
	expectedGeneration uint64,
) agentModelCatalogFetchOutcome {
	provider := agentprovider.Normalize(input.Provider)
	startedAt := time.Now()
	slog.Info("agent model catalog fetch started",
		"event", "agent.model_catalog.fetch_start",
		"provider", provider,
		"stale_refresh", staleRefresh,
	)
	listResult, err := spec.lister(c, input).ListModels(ctx)
	configuredDefaultModel := spec.configuredDefaultModel()
	models := applyConfiguredDefaultModel(listResult.Models, configuredDefaultModel, spec.missingDefaultDescription)
	models = enrichAgentModelOptions(ctx, provider, models, c.ModelCapabilities)
	result := AgentModelCatalogResult{
		Provider:  provider,
		Source:    spec.source,
		FetchedAt: startedAt,
		Models:    models,
	}
	accepted := c.writeCache(provider, spec, startedAt, result, listResult.IsFallback, err, expectedGeneration, staleRefresh)
	if accepted && staleRefresh && err == nil && c.OnRefresh != nil {
		c.OnRefresh(provider)
	}
	slog.Info("agent model catalog fetch settled",
		"event", "agent.model_catalog.fetch_settled",
		"provider", provider,
		"durationMs", time.Since(startedAt).Milliseconds(),
		"modelCount", len(models),
		"modelNames", diagnosticModelNames(models),
		"stale_refresh", staleRefresh,
		"accepted", accepted,
		"error", err,
	)
	return agentModelCatalogFetchOutcome{result: result, err: err, staleRefresh: staleRefresh, accepted: accepted}
}

func diagnosticModelNames(models []AgentModelOption) []string {
	const (
		maxNames       = 32
		maxNameLength  = 120
		maxTotalLength = 1024
	)
	names := make([]string, 0, min(len(models), maxNames))
	seen := make(map[string]struct{}, maxNames)
	totalLength := 0
	for _, model := range models {
		name := strings.TrimSpace(model.ID)
		if name == "" {
			continue
		}
		name = strings.Map(func(r rune) rune {
			if r < 0x20 || (r >= 0x7f && r <= 0x9f) {
				return -1
			}
			return r
		}, name)
		if len(name) > maxNameLength {
			name = name[:maxNameLength]
		}
		if _, ok := seen[name]; ok || name == "" || len(names) >= maxNames || totalLength+len(name) > maxTotalLength {
			continue
		}
		seen[name] = struct{}{}
		names = append(names, name)
		totalLength += len(name)
	}
	return names
}

func specCachesModelCatalog(spec agentModelCatalogSpec) bool {
	return spec.ttl > 0 || spec.errTTL > 0 || spec.fallbackTTL > 0
}

func defaultTuttiAgentModelLister(provider string, providerCommands ProviderCommandResolver) CodexCLIModelLister {
	return CodexCLIModelLister{
		Command:          "tutti-agent",
		ClientName:       "tutti_agent",
		Provider:         provider,
		ProviderCommands: providerCommands,
		PrepareEnv:       prepareTuttiAgentModelListEnv,
	}
}

func prepareTuttiAgentModelListEnv(ctx context.Context, env []string) ([]string, error) {
	env = append([]string(nil), env...)
	env = withoutEnvKeys(env, "TUTTI_AGENT_HOME", "CODEX_HOME")
	tuttiAgentHome := filepath.Join(tuttitypes.DefaultStateDir(), "agent-model-catalog", "tutti-agent-home")
	tuttiagentservice.BootstrapTuttiAgentUserAuth(ctx)
	if err := refreshTuttiAgentModelCatalogAuth(tuttiAgentHome); err != nil {
		return nil, err
	}
	if err := tuttiagentservice.PrepareHome(tuttiAgentHome); err != nil {
		return nil, err
	}
	env = append(env, "TUTTI_AGENT_HOME="+tuttiAgentHome)
	// Prevent Tutti Agent's legacy CODEX_HOME fallback from reading Codex's
	// model cache when tuttid itself runs inside a Codex-hosted environment.
	env = append(env, "CODEX_HOME=")
	return env, nil
}

// refreshTuttiAgentModelCatalogAuth drops only a stale materialized auth view
// in the dedicated model-catalog home. PrepareHome will then recreate the
// view from the freshly bootstrapped user auth (symlink/hard-link when
// possible). This matters on Windows, where a first-run copy can otherwise
// remain frozen after the host auth is refreshed.
func refreshTuttiAgentModelCatalogAuth(home string) error {
	userHome, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(userHome) == "" {
		return nil
	}
	source := filepath.Join(userHome, ".tutti-agent", "auth.json")
	sourceBytes, err := os.ReadFile(source)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read tutti-agent user auth: %w", err)
	}
	target := filepath.Join(home, "auth.json")
	targetBytes, err := os.ReadFile(target)
	if err == nil && bytes.Equal(sourceBytes, targetBytes) {
		return nil
	}
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read tutti-agent model catalog auth: %w", err)
	}
	if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove stale tutti-agent model catalog auth: %w", err)
	}
	return nil
}

func withoutEnvKeys(env []string, keys ...string) []string {
	if len(env) == 0 || len(keys) == 0 {
		return env
	}
	drop := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		drop[key] = struct{}{}
	}
	filtered := env[:0]
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		if _, ok := drop[key]; ok {
			continue
		}
		filtered = append(filtered, entry)
	}
	return filtered
}

// Invalidate marks cached model lists stale for the given providers and closes
// their persistent app-server sessions. The last known list remains available
// for presentation while the next read refreshes it in the background.
func (c *CachedAgentModelCatalog) Invalidate(providers ...string) {
	if c == nil {
		return
	}
	var sessions []*codexAppServerSession
	c.mu.Lock()
	for _, provider := range providers {
		normalized := agentprovider.Normalize(provider)
		if normalized == "" {
			continue
		}
		if c.generation == nil {
			c.generation = make(map[string]uint64)
		}
		c.generation[normalized]++
		if entry := c.cache[normalized]; entry != nil {
			entry.stale = true
			entry.refreshRetryAtMS = 0
			entry.generation = c.generation[normalized]
		}
		if session := c.codexSessions[normalized]; session != nil {
			sessions = append(sessions, session)
			delete(c.codexSessions, normalized)
		}
	}
	c.mu.Unlock()
	for _, session := range sessions {
		_ = session.Close()
	}
}

func (c *CachedAgentModelCatalog) readCache(provider string, now time.Time) *agentModelCatalogCacheEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry := c.cache[provider]
	if entry == nil {
		return nil
	}
	if entry.err != nil && now.UnixMilli() > entry.expiresAtMS {
		delete(c.cache, provider)
		return nil
	}
	if !entry.stale && entry.err == nil && now.UnixMilli() > entry.expiresAtMS {
		entry.stale = true
		entry.refreshRetryAtMS = 0
	}
	return &agentModelCatalogCacheEntry{
		result:           cloneAgentModelCatalogResult(entry.result),
		err:              entry.err,
		expiresAtMS:      entry.expiresAtMS,
		refreshRetryAtMS: entry.refreshRetryAtMS,
		stale:            entry.stale,
		generation:       entry.generation,
		authFingerprint:  entry.authFingerprint,
	}
}

func (c *CachedAgentModelCatalog) writeCache(
	provider string,
	spec agentModelCatalogSpec,
	now time.Time,
	result AgentModelCatalogResult,
	isFallback bool,
	err error,
	expectedGeneration uint64,
	staleRefresh bool,
) bool {
	ttl := spec.ttl
	switch {
	case err != nil:
		ttl = spec.errTTL
	case isFallback && spec.fallbackTTL > 0:
		ttl = spec.fallbackTTL
	}
	if ttl <= 0 {
		return true
	}
	authFingerprint := c.authFingerprint(provider)
	c.mu.Lock()
	currentGeneration := c.generation[provider]
	if currentGeneration != expectedGeneration {
		c.mu.Unlock()
		return false
	}
	if c.cache == nil {
		c.cache = make(map[string]*agentModelCatalogCacheEntry)
	}
	if c.generation == nil {
		c.generation = make(map[string]uint64)
	}
	if err != nil && staleRefresh {
		if entry := c.cache[provider]; entry != nil && entry.generation == expectedGeneration {
			entry.refreshRetryAtMS = now.Add(ttl).UnixMilli()
		}
		c.mu.Unlock()
		return false
	}
	c.cache[provider] = &agentModelCatalogCacheEntry{
		result:          cloneAgentModelCatalogResult(result),
		err:             err,
		expiresAtMS:     now.Add(ttl).UnixMilli(),
		generation:      expectedGeneration,
		authFingerprint: authFingerprint,
	}
	c.mu.Unlock()
	if err == nil && !isFallback && len(result.Models) > 0 {
		c.persistCache()
	}
	return true
}

func (c *CachedAgentModelCatalog) persistCache() {
	path := strings.TrimSpace(c.PersistentPath)
	if path == "" {
		return
	}
	persisted := persistedAgentModelCatalog{Version: 1, Entries: make(map[string]persistedAgentModelCatalogEntry)}
	c.mu.Lock()
	for provider, entry := range c.cache {
		if entry == nil || entry.err != nil || len(entry.result.Models) == 0 {
			continue
		}
		persisted.Entries[provider] = persistedAgentModelCatalogEntry{
			Provider:        entry.result.Provider,
			Source:          entry.result.Source,
			FetchedAt:       entry.result.FetchedAt,
			Models:          cloneAgentModelOptions(entry.result.Models),
			AuthFingerprint: entry.authFingerprint,
		}
	}
	c.mu.Unlock()
	if len(persisted.Entries) == 0 {
		return
	}
	data, err := json.MarshalIndent(persisted, "", "  ")
	if err != nil {
		slog.Warn("agent model catalog persistent cache encode failed",
			"event", "agent.model_catalog.persistent_write_failed",
			"path", path,
			"error", err,
		)
		return
	}
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		slog.Warn("agent model catalog persistent cache directory failed",
			"event", "agent.model_catalog.persistent_write_failed",
			"path", path,
			"error", err,
		)
		return
	}
	temporary, err := os.CreateTemp(directory, ".model-catalog-*.tmp")
	if err != nil {
		slog.Warn("agent model catalog persistent cache temp file failed",
			"event", "agent.model_catalog.persistent_write_failed",
			"path", path,
			"error", err,
		)
		return
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	writeOK := false
	if chmodErr := temporary.Chmod(0o600); chmodErr != nil {
		err = chmodErr
	} else if _, writeErr := temporary.Write(data); writeErr != nil {
		err = writeErr
	} else if syncErr := temporary.Sync(); syncErr != nil {
		err = syncErr
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(temporaryPath, path)
		if err != nil {
			// Windows does not replace an existing destination with Rename. The
			// file is only a recoverable cache, so remove that old copy and retry.
			if removeErr := os.Remove(path); removeErr == nil || os.IsNotExist(removeErr) {
				err = os.Rename(temporaryPath, path)
			}
		}
		writeOK = err == nil
	}
	if !writeOK {
		slog.Warn("agent model catalog persistent cache write failed",
			"event", "agent.model_catalog.persistent_write_failed",
			"path", path,
			"error", err,
		)
		return
	}
	slog.Info("agent model catalog persistent cache written",
		"event", "agent.model_catalog.persistent_written",
		"path", path,
		"providerCount", len(persisted.Entries),
	)
}

func (c *CachedAgentModelCatalog) currentGeneration(provider string) uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.generation[provider]
}

func (c *CachedAgentModelCatalog) codexSession(provider string, lister CodexCLIModelLister) *codexAppServerSession {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.codexSessions == nil {
		c.codexSessions = make(map[string]*codexAppServerSession)
	}
	if session := c.codexSessions[provider]; session != nil {
		return session
	}
	lister.Session = nil
	session := newCodexAppServerSession(lister)
	c.codexSessions[provider] = session
	return session
}

// Close releases persistent provider app-server processes owned by the catalog.
func (c *CachedAgentModelCatalog) Close() error {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	sessions := make([]*codexAppServerSession, 0, len(c.codexSessions))
	for provider, session := range c.codexSessions {
		sessions = append(sessions, session)
		delete(c.codexSessions, provider)
	}
	c.mu.Unlock()
	var closeErr error
	for _, session := range sessions {
		if err := session.Close(); err != nil && closeErr == nil {
			closeErr = err
		}
	}
	return closeErr
}

func (c *CachedAgentModelCatalog) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func cloneAgentModelCatalogResult(result AgentModelCatalogResult) AgentModelCatalogResult {
	return AgentModelCatalogResult{
		Provider:  result.Provider,
		Source:    result.Source,
		FetchedAt: result.FetchedAt,
		Models:    cloneAgentModelOptions(result.Models),
		Stale:     result.Stale,
	}
}

func cloneAgentModelOptions(models []AgentModelOption) []AgentModelOption {
	if len(models) == 0 {
		return nil
	}
	result := make([]AgentModelOption, len(models))
	copy(result, models)
	for index := range result {
		result[index].SupportedReasoningEfforts = append(
			[]AgentModelReasoningEffortOption(nil),
			models[index].SupportedReasoningEfforts...,
		)
	}
	return result
}

func applyConfiguredDefaultModel(models []AgentModelOption, configuredDefaultModel string, missingDescription string) []AgentModelOption {
	if configuredDefaultModel == "" {
		return cloneAgentModelOptions(models)
	}
	result := cloneAgentModelOptions(models)
	matched := false
	for index := range result {
		isDefault := result[index].ID == configuredDefaultModel
		result[index].IsDefault = isDefault
		if isDefault {
			matched = true
		}
	}
	if !matched {
		result = append(result, AgentModelOption{
			ID:          configuredDefaultModel,
			DisplayName: configuredDefaultModel,
			Description: missingDescription,
			IsDefault:   true,
		})
	}
	return result
}
