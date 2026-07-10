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
	ID                         string
	DisplayName                string
	Description                string
	DefaultReasoningEffort     string
	IsDefault                  bool
	ReasoningEffortsAdvertised bool
	SupportedReasoningEfforts  []AgentModelReasoningEffortOption
}

type AgentModelReasoningEffortOption struct {
	Description string
	Value       string
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

type CachedAgentModelCatalog struct {
	Codex  AgentModelLister
	Gemini AgentModelLister
	Now    func() time.Time

	mu          sync.Mutex
	codexCache  *agentModelCatalogCacheEntry
	geminiCache *agentModelCatalogCacheEntry
}

type agentModelCatalogCacheEntry struct {
	result      AgentModelCatalogResult
	err         error
	expiresAtMS int64
}

func NewAgentModelCatalog() *CachedAgentModelCatalog {
	return &CachedAgentModelCatalog{
		Codex:  CodexCLIModelLister{},
		Gemini: GeminiCLIModelLister{},
	}
}

func (c *CachedAgentModelCatalog) ListModels(ctx context.Context, provider string) (AgentModelCatalogResult, error) {
	provider = agentprovider.Normalize(provider)
	switch provider {
	case agentprovider.Codex:
		return c.listCodexModels(ctx)
	case agentprovider.Gemini:
		return c.listGeminiModels(ctx)
	default:
		return AgentModelCatalogResult{}, ErrInvalidArgument
	}
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
		switch agentprovider.Normalize(provider) {
		case agentprovider.Codex:
			c.codexCache = nil
		case agentprovider.Gemini:
			c.geminiCache = nil
		}
	}
}

func (c *CachedAgentModelCatalog) listCodexModels(ctx context.Context) (AgentModelCatalogResult, error) {
	now := c.now()
	if cached := c.readCodexCache(now); cached != nil {
		return cached.result, cached.err
	}
	lister := c.Codex
	if lister == nil {
		lister = CodexCLIModelLister{}
	}
	listResult, err := lister.ListModels(ctx)
	configuredModel := readCodexConfiguredDefaultModel()
	models := applyConfiguredDefaultModel(
		listResult.Models,
		configuredModel,
		"Codex configured custom model",
	)
	source := "codex-cli"
	// Custom model_provider endpoints (OpenRouter, etc.) do not serve the
	// official model/list ids. Expose only the configured model so the
	// composer menu matches what the session can actually run.
	if err == nil && codexUsesCustomModelProvider() && configuredModel != "" {
		models = []AgentModelOption{{
			ID:          configuredModel,
			DisplayName: configuredModel,
			Description: "Codex configured custom model",
			IsDefault:   true,
		}}
		source = "codex-configured-model"
	}
	result := AgentModelCatalogResult{
		Provider:  agentprovider.Codex,
		Source:    source,
		FetchedAt: now,
		Models:    models,
	}
	c.writeCodexCache(now, result, err)
	return cloneAgentModelCatalogResult(result), err
}

func (c *CachedAgentModelCatalog) listGeminiModels(ctx context.Context) (AgentModelCatalogResult, error) {
	now := c.now()
	if cached := c.readGeminiCache(now); cached != nil {
		return cached.result, cached.err
	}
	lister := c.Gemini
	if lister == nil {
		lister = GeminiCLIModelLister{}
	}
	listResult, err := lister.ListModels(ctx)
	result := AgentModelCatalogResult{
		Provider:  agentprovider.Gemini,
		Source:    "gemini-cli",
		FetchedAt: now,
		Models: applyConfiguredDefaultModel(
			listResult.Models,
			readGeminiConfiguredDefaultModel(),
			"Gemini configured custom model",
		),
	}
	c.writeGeminiCache(now, result, listResult.IsFallback, err)
	return cloneAgentModelCatalogResult(result), err
}

func (c *CachedAgentModelCatalog) readCodexCache(now time.Time) *agentModelCatalogCacheEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.codexCache == nil || now.UnixMilli() > c.codexCache.expiresAtMS {
		c.codexCache = nil
		return nil
	}
	return &agentModelCatalogCacheEntry{
		result: cloneAgentModelCatalogResult(c.codexCache.result),
		err:    c.codexCache.err,
	}
}

func (c *CachedAgentModelCatalog) writeCodexCache(now time.Time, result AgentModelCatalogResult, err error) {
	ttl := codexModelCacheTTL
	if err != nil {
		ttl = codexModelErrorCacheTTL
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.codexCache = &agentModelCatalogCacheEntry{
		result:      cloneAgentModelCatalogResult(result),
		err:         err,
		expiresAtMS: now.Add(ttl).UnixMilli(),
	}
}

func (c *CachedAgentModelCatalog) readGeminiCache(now time.Time) *agentModelCatalogCacheEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.geminiCache == nil || now.UnixMilli() > c.geminiCache.expiresAtMS {
		c.geminiCache = nil
		return nil
	}
	return &agentModelCatalogCacheEntry{
		result: cloneAgentModelCatalogResult(c.geminiCache.result),
		err:    c.geminiCache.err,
	}
}

func (c *CachedAgentModelCatalog) writeGeminiCache(now time.Time, result AgentModelCatalogResult, isFallback bool, err error) {
	ttl := geminiModelCacheTTL
	if isFallback || err != nil {
		ttl = geminiModelFallbackTTL
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.geminiCache = &agentModelCatalogCacheEntry{
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
