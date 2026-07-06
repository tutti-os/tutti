package agent

import (
	"context"
	"sync"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

const (
	codexModelCacheTTL      = 30 * time.Second
	codexModelErrorCacheTTL = 5 * time.Second
	geminiModelCacheTTL     = 6 * time.Hour
	geminiModelFallbackTTL  = 5 * time.Minute
)

type AgentModelOption struct {
	ID          string
	DisplayName string
	Description string
	IsDefault   bool
}

type AgentModelCatalogResult struct {
	Provider  string
	Source    string
	FetchedAt time.Time
	Models    []AgentModelOption
}

type AgentModelCatalog interface {
	ListModels(context.Context, string) (AgentModelCatalogResult, error)
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
	// ttl caches a successful, non-fallback list.
	ttl time.Duration
	// errTTL caches a failed fetch (avoids hammering a broken CLI).
	errTTL time.Duration
	// fallbackTTL caches a fallback list when the lister flags one; zero
	// means fallback results use the normal ttl.
	fallbackTTL time.Duration
	// lister picks the injected lister off the catalog, falling back to the
	// default CLI-backed implementation.
	lister func(*CachedAgentModelCatalog) AgentModelLister
	// configuredDefaultModel reads the user's CLI-configured default model;
	// it is marked (or appended) as the default option.
	configuredDefaultModel func() string
	// missingDefaultDescription describes a configured default model that the
	// lister did not return.
	missingDefaultDescription string
}

var agentModelCatalogSpecs = map[string]agentModelCatalogSpec{
	agentprovider.Codex: {
		source: "codex-cli",
		ttl:    codexModelCacheTTL,
		errTTL: codexModelErrorCacheTTL,
		lister: func(c *CachedAgentModelCatalog) AgentModelLister {
			if c.Codex != nil {
				return c.Codex
			}
			return CodexCLIModelLister{}
		},
		configuredDefaultModel:    readCodexConfiguredDefaultModel,
		missingDefaultDescription: "Codex configured custom model",
	},
	agentprovider.Gemini: {
		source:      "gemini-cli",
		ttl:         geminiModelCacheTTL,
		errTTL:      geminiModelFallbackTTL,
		fallbackTTL: geminiModelFallbackTTL,
		lister: func(c *CachedAgentModelCatalog) AgentModelLister {
			if c.Gemini != nil {
				return c.Gemini
			}
			return GeminiCLIModelLister{}
		},
		configuredDefaultModel:    readGeminiConfiguredDefaultModel,
		missingDefaultDescription: "Gemini configured custom model",
	},
}

type CachedAgentModelCatalog struct {
	Codex  AgentModelLister
	Gemini AgentModelLister
	Now    func() time.Time

	mu    sync.Mutex
	cache map[string]*agentModelCatalogCacheEntry
}

type agentModelCatalogCacheEntry struct {
	result      AgentModelCatalogResult
	err         error
	expiresAtMS int64
}

func NewAgentModelCatalog() *CachedAgentModelCatalog {
	return &CachedAgentModelCatalog{}
}

func (c *CachedAgentModelCatalog) ListModels(ctx context.Context, provider string) (AgentModelCatalogResult, error) {
	provider = agentprovider.Normalize(provider)
	spec, ok := agentModelCatalogSpecs[provider]
	if !ok {
		return AgentModelCatalogResult{}, ErrInvalidArgument
	}
	now := c.now()
	if cached := c.readCache(provider, now); cached != nil {
		return cached.result, cached.err
	}
	listResult, err := spec.lister(c).ListModels(ctx)
	result := AgentModelCatalogResult{
		Provider:  provider,
		Source:    spec.source,
		FetchedAt: now,
		Models: applyConfiguredDefaultModel(
			listResult.Models,
			spec.configuredDefaultModel(),
			spec.missingDefaultDescription,
		),
	}
	c.writeCache(provider, spec, now, result, listResult.IsFallback, err)
	return cloneAgentModelCatalogResult(result), err
}

// Invalidate drops the cached model list for the given providers so the next
// ListModels call re-queries the provider CLI. Used when provider auth or
// config files change on disk (for example via an external credential
// switcher) and the cached list may reflect the previous account.
func (c *CachedAgentModelCatalog) Invalidate(providers ...string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, provider := range providers {
		normalized := agentprovider.Normalize(provider)
		if normalized == "" {
			continue
		}
		delete(c.cache, normalized)
	}
}

func (c *CachedAgentModelCatalog) readCache(provider string, now time.Time) *agentModelCatalogCacheEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry := c.cache[provider]
	if entry == nil || now.UnixMilli() > entry.expiresAtMS {
		delete(c.cache, provider)
		return nil
	}
	return &agentModelCatalogCacheEntry{
		result: cloneAgentModelCatalogResult(entry.result),
		err:    entry.err,
	}
}

func (c *CachedAgentModelCatalog) writeCache(
	provider string,
	spec agentModelCatalogSpec,
	now time.Time,
	result AgentModelCatalogResult,
	isFallback bool,
	err error,
) {
	ttl := spec.ttl
	switch {
	case err != nil:
		ttl = spec.errTTL
	case isFallback && spec.fallbackTTL > 0:
		ttl = spec.fallbackTTL
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cache == nil {
		c.cache = make(map[string]*agentModelCatalogCacheEntry)
	}
	c.cache[provider] = &agentModelCatalogCacheEntry{
		result:      cloneAgentModelCatalogResult(result),
		err:         err,
		expiresAtMS: now.Add(ttl).UnixMilli(),
	}
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
	}
}

func cloneAgentModelOptions(models []AgentModelOption) []AgentModelOption {
	if len(models) == 0 {
		return nil
	}
	result := make([]AgentModelOption, len(models))
	copy(result, models)
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
