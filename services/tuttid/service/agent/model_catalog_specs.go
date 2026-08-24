package agent

import (
	"fmt"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

const (
	codexModelCacheTTL       = 5 * time.Minute
	codexModelErrorCacheTTL  = 5 * time.Second
	codexModelFetchTimeout   = 35 * time.Second
	modelCatalogFetchTimeout = 12 * time.Second
)

// agentModelCatalogSpec declares how one provider's model list is fetched and
// cached. Adding a provider to the catalog means adding one entry to
// agentModelCatalogSpecs (and a lister field on CachedAgentModelCatalog for
// test injection).
type agentModelCatalogSpec struct {
	// source labels the catalog origin surfaced to the GUI (e.g. "codex-cli").
	source string
	// ttl caches a successful, non-fallback list. Zero disables successful
	// result caching; cacheKey may scope a non-zero ttl to request context.
	ttl time.Duration
	// errTTL caches a failed fetch (avoids hammering a broken CLI).
	errTTL time.Duration
	// fetchTimeout bounds the provider-specific CLI fetch. Most providers use
	// the shared default; slow npm-shimmed CLIs may need a larger bounded
	// window without relaxing every provider's status path.
	fetchTimeout time.Duration
	// cacheKey scopes in-memory results and singleflight calls when the model
	// catalog depends on request context such as the working directory. Such
	// context-scoped entries are intentionally memory-only.
	cacheKey func(AgentModelCatalogInput) string
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
			source:       string(descriptor.ComposerProfile.ModelCatalog),
			ttl:          codexModelCacheTTL,
			errTTL:       codexModelErrorCacheTTL,
			fetchTimeout: codexModelFetchTimeout,
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
			source:       string(descriptor.ComposerProfile.ModelCatalog),
			ttl:          opencodeModelCacheTTL,
			errTTL:       opencodeModelErrorCacheTTL,
			fetchTimeout: opencodeModelFetchTimeout,
			cacheKey: func(input AgentModelCatalogInput) string {
				return modelCatalogCacheKeyByCwd(descriptor.Identity.ID, input.Cwd)
			},
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
			source:       string(descriptor.ComposerProfile.ModelCatalog),
			ttl:          codexModelCacheTTL,
			errTTL:       codexModelErrorCacheTTL,
			fetchTimeout: codexModelFetchTimeout,
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
