package agent

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	tuttiagentservice "github.com/tutti-os/tutti/services/tuttid/service/tuttiagent"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const (
	codexModelCacheTTL      = 30 * time.Second
	codexModelErrorCacheTTL = 5 * time.Second
	opencodeModelCacheTTL   = 6 * time.Hour
	opencodeModelErrorTTL   = 5 * time.Minute
)

type AgentModelOption struct {
	ID                         string
	DisplayName                string
	Description                string
	DefaultReasoningEffort     string
	IsDefault                  bool
	ReasoningEffortsAdvertised bool
	SupportedReasoningEfforts  []AgentModelReasoningEffortOption
	SupportsImageInput         *bool
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
	configuredModelOnly       func() bool
	configuredModelSource     string
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
		configuredModelOnly, configuredModelSource, err := configuredModelOverrideFromDescriptor(descriptor.ComposerProfile.ConfiguredModelOverride)
		if err != nil {
			return agentModelCatalogSpec{}, false, err
		}
		return agentModelCatalogSpec{
			source: string(descriptor.ComposerProfile.ModelCatalog),
			ttl:    codexModelCacheTTL,
			errTTL: codexModelErrorCacheTTL,
			lister: func(c *CachedAgentModelCatalog) AgentModelLister {
				if c.Codex != nil {
					return c.Codex
				}
				return CodexCLIModelLister{
					Command: command[0],
					Args:    append([]string(nil), command[1:]...),
				}
			},
			configuredDefaultModel:    readCodexConfiguredDefaultModel,
			missingDefaultDescription: descriptor.Identity.DisplayName + " configured custom model",
			configuredModelOnly:       configuredModelOnly,
			configuredModelSource:     configuredModelSource,
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
			ttl:    opencodeModelCacheTTL,
			errTTL: opencodeModelErrorTTL,
			lister: func(c *CachedAgentModelCatalog) AgentModelLister {
				if c.OpenCode != nil {
					return c.OpenCode
				}
				return OpenCodeCLIModelLister{
					Command: command[0],
					Args:    []string{"models"},
				}
			},
			configuredDefaultModel:    readOpenCodeConfiguredDefaultModel,
			missingDefaultDescription: descriptor.Identity.DisplayName + " configured custom model",
		}, true, nil
	case providerregistry.ModelCatalogKindTuttiCLI:
		return agentModelCatalogSpec{
			source: string(descriptor.ComposerProfile.ModelCatalog), ttl: codexModelCacheTTL, errTTL: codexModelErrorCacheTTL,
			lister: func(c *CachedAgentModelCatalog) AgentModelLister {
				if c.TuttiAgent != nil {
					return c.TuttiAgent
				}
				return defaultTuttiAgentModelLister()
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

func configuredModelOverrideFromDescriptor(kind providerregistry.ConfiguredModelOverrideKind) (func() bool, string, error) {
	switch kind {
	case "":
		return nil, "", nil
	case providerregistry.ConfiguredModelOverrideCodexCustomProvider:
		return codexUsesCustomModelProvider, "codex-configured-model", nil
	default:
		return nil, "", fmt.Errorf("configured model override kind %q is unsupported", kind)
	}
}

type CachedAgentModelCatalog struct {
	Codex             AgentModelLister
	TuttiAgent        AgentModelLister
	OpenCode          AgentModelLister
	ModelCapabilities ModelCapabilitiesResolver
	Now               func() time.Time

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
	configuredDefaultModel := spec.configuredDefaultModel()
	models := applyConfiguredDefaultModel(listResult.Models, configuredDefaultModel, spec.missingDefaultDescription)
	source := spec.source
	if configuredDefaultModel != "" && spec.configuredModelOnly != nil && spec.configuredModelOnly() {
		models = []AgentModelOption{{
			ID:          configuredDefaultModel,
			DisplayName: configuredDefaultModel,
			Description: spec.missingDefaultDescription,
			IsDefault:   true,
		}}
		source = spec.configuredModelSource
	}
	models = enrichAgentModelOptions(ctx, provider, models, c.ModelCapabilities)
	result := AgentModelCatalogResult{
		Provider:  provider,
		Source:    source,
		FetchedAt: now,
		Models:    models,
	}
	c.writeCache(provider, spec, now, result, listResult.IsFallback, err)
	return cloneAgentModelCatalogResult(result), err
}

func defaultTuttiAgentModelLister() CodexCLIModelLister {
	return CodexCLIModelLister{
		Command:    "tutti-agent",
		ClientName: "tutti_agent",
		PrepareEnv: prepareTuttiAgentModelListEnv,
	}
}

func prepareTuttiAgentModelListEnv(env []string) ([]string, error) {
	env = append([]string(nil), env...)
	env = withoutEnvKeys(env, "TUTTI_AGENT_HOME", "CODEX_HOME")
	tuttiAgentHome := filepath.Join(tuttitypes.DefaultStateDir(), "agent-model-catalog", "tutti-agent-home")
	tuttiagentservice.BootstrapTuttiAgentUserAuth(context.Background())
	if err := tuttiagentservice.PrepareHome(tuttiAgentHome); err != nil {
		return nil, err
	}
	env = append(env, "TUTTI_AGENT_HOME="+tuttiAgentHome)
	// Prevent Tutti Agent's legacy CODEX_HOME fallback from reading Codex's
	// model cache when tuttid itself runs inside a Codex-hosted environment.
	env = append(env, "CODEX_HOME=")
	return env, nil
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
