package agent

import (
	"context"
	"path/filepath"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/agentcatalog"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

const (
	modelDiscoveryDescriptorSchemaVersion = 1
	legacyModelCatalogResolverKind        = "model_catalog"
)

type modelCatalogResolverInput struct {
	ComposerInput ComposerOptionsInput
	Settings      ComposerSettings
}

// catalogCoordinator adapts tuttid's provider process implementations to the
// host-neutral model facet coordinator. It is intentionally lazy because many
// service tests inject ModelCatalog after constructing Service.
func (s *Service) catalogCoordinator() *agentcatalog.Coordinator {
	s.modelCatalogCoordinatorMu.Lock()
	defer s.modelCatalogCoordinatorMu.Unlock()
	if s.modelCatalogCoordinator != nil {
		return s.modelCatalogCoordinator
	}
	s.modelCatalogCoordinator = agentcatalog.NewCoordinator(agentcatalog.CoordinatorOptions{
		Resolvers: map[string]agentcatalog.ColdResolver{
			legacyModelCatalogResolverKind:                                 agentcatalog.ColdResolverFunc(s.resolveCatalogModels),
			string(providerregistry.ModelResolverKindCodexAppServer):       agentcatalog.ColdResolverFunc(s.resolveCatalogModels),
			string(providerregistry.ModelResolverKindOpenCodeCLI):          agentcatalog.ColdResolverFunc(s.resolveCatalogModels),
			string(providerregistry.ModelResolverKindTuttiAppServer):       agentcatalog.ColdResolverFunc(s.resolveCatalogModels),
			string(providerregistry.ModelResolverKindHiddenRuntimeSession): agentcatalog.ColdResolverFunc(s.resolveHiddenRuntimeModels),
		},
	})
	return s.modelCatalogCoordinator
}

func (s *Service) resolveCatalogModels(ctx context.Context, input agentcatalog.ResolveModelsInput) (agentcatalog.ModelSnapshot, error) {
	if s.ModelCatalog == nil {
		return agentcatalog.ModelSnapshot{}, agentcatalog.ErrResolverUnavailable
	}
	resolverInput, _ := input.ResolverInput.(modelCatalogResolverInput)
	result, err := s.ModelCatalog.ListModels(ctx, AgentModelCatalogInput{Provider: input.Key.ProviderID, Cwd: resolverInput.ComposerInput.Cwd})
	if err != nil {
		return agentcatalog.ModelSnapshot{}, err
	}
	return agentModelCatalogSnapshot(result), nil
}

func (s *Service) resolveHiddenRuntimeModels(ctx context.Context, input agentcatalog.ResolveModelsInput) (agentcatalog.ModelSnapshot, error) {
	resolverInput, ok := input.ResolverInput.(modelCatalogResolverInput)
	if !ok {
		return agentcatalog.ModelSnapshot{}, ErrInvalidArgument
	}
	scope := newComposerLiveModelScope(input.Key.ProviderID, resolverInput.ComposerInput.WorkspaceID, resolverInput.ComposerInput.Cwd, resolverInput.ComposerInput.AgentTargetID)
	models, err := s.discoverLiveComposerModelsUncachedForScope(ctx, scope, resolverInput.ComposerInput.providerTargetRef, resolverInput.Settings)
	if err != nil {
		return agentcatalog.ModelSnapshot{}, err
	}
	snapshot := composerModelSnapshot(models, true)
	snapshot.ResolverSource = runtimeLiveModelCatalogSource
	return snapshot, nil
}

func (s *Service) resolveModelsFromCatalog(ctx context.Context, input ComposerOptionsInput, settings ComposerSettings, readPolicy agentcatalog.ReadPolicy) (agentcatalog.ResolveModelsResult, error) {
	profile := composerProfileFor(input.Provider)
	return s.resolveModelsFromCatalogProfile(ctx, input, settings, readPolicy, profile)
}

func (s *Service) resolveModelsFromCatalogProfile(ctx context.Context, input ComposerOptionsInput, settings ComposerSettings, readPolicy agentcatalog.ReadPolicy, profile composerProfile) (agentcatalog.ResolveModelsResult, error) {
	policy := profile.ModelDiscovery
	if !policy.Enabled && profile.UsesModelCatalog {
		// Preserve compatibility for host/test profiles that predate the unified
		// descriptor. Built-in providers always declare an explicit policy.
		policy = providerregistry.ModelDiscoveryDescriptor{
			Enabled: true, ColdResolverKind: legacyModelCatalogResolverKind,
			ScopeKind:       providerregistry.ModelDiscoveryScopeProvider,
			FreshTTLSeconds: 300, MaxStaleSeconds: 86400,
		}
	}
	if !policy.Enabled {
		return agentcatalog.ResolveModelsResult{}, nil
	}
	if profile.LiveModelDiscovery {
		s.ingestReusableLiveComposerModels(input)
		if strings.TrimSpace(input.WorkspaceID) == "" && readPolicy == "" {
			readPolicy = agentcatalog.ReadPolicyCacheOnly
		}
	}
	result, err := s.catalogCoordinator().ResolveModels(ctx, agentcatalog.ResolveModelsInput{
		Key:           modelCatalogSnapshotKey(input.Provider, input.AgentTargetID, input.Cwd, policy),
		Policy:        modelCatalogPolicy(policy, settings.Model),
		ReadPolicy:    readPolicy,
		SelectedModel: settings.Model,
		ResolverInput: modelCatalogResolverInput{ComposerInput: input, Settings: settings},
	})
	if err == nil && result.Source == agentcatalog.SnapshotSourceFallback && policy.FallbackKind == providerregistry.ModelFallbackKindClaudeAliases {
		result.Value.ResolverSource = "claude-static"
	}
	return result, err
}

func (s *Service) ingestReusableLiveComposerModels(input ComposerOptionsInput) {
	provider := agentprovider.NormalizeOpen(input.Provider)
	if strings.TrimSpace(input.WorkspaceID) == "" || provider == "" {
		return
	}
	now := time.Now().UTC()
	scope := newComposerLiveModelScope(provider, input.WorkspaceID, input.Cwd, input.AgentTargetID)
	if models, _ := s.liveModelOptionsFromRunningSession(input.WorkspaceID, provider, input.AgentTargetID); len(models) > 0 {
		s.setLiveComposerModelOptionsForScope(scope, now, models)
		return
	}
	if models, ok := s.getLiveComposerModelOptionsForScope(scope, now); ok {
		s.ingestComposerModels(input, models, true)
		return
	}
	if models, ok := s.persistedLiveModelFallback(input.WorkspaceID, input.Cwd, provider, now, input.AgentTargetID); ok {
		s.ingestComposerModels(input, models, true)
	}
}

func (s *Service) ingestComposerModels(input ComposerOptionsInput, models []ComposerConfigOptionValue, complete bool) {
	profile := composerProfileFor(input.Provider)
	if len(models) == 0 || !profile.ModelDiscovery.ReuseRuntimeSnapshot {
		return
	}
	snapshot := composerModelSnapshot(models, complete)
	snapshot.ResolverSource = runtimeLiveModelCatalogSource
	_ = s.catalogCoordinator().IngestRuntimeSnapshot(context.Background(), agentcatalog.RuntimeCatalogSnapshot{
		Key:       modelCatalogSnapshotKey(input.Provider, input.AgentTargetID, input.Cwd, profile.ModelDiscovery),
		Models:    snapshot,
		FetchedAt: time.Now().UTC(),
	})
}

func modelCatalogSnapshotKey(provider, agentTargetID, cwd string, policy providerregistry.ModelDiscoveryDescriptor) agentcatalog.SnapshotKey {
	scopeValue := strings.TrimSpace(provider)
	switch policy.ScopeKind {
	case providerregistry.ModelDiscoveryScopeAccount:
		scopeValue = "account:" + strings.TrimSpace(provider)
	case providerregistry.ModelDiscoveryScopeCWD:
		scopeValue = filepath.Clean(strings.TrimSpace(cwd))
		if scopeValue == "." {
			scopeValue = "cwd:default"
		}
	case providerregistry.ModelDiscoveryScopeTarget:
		scopeValue = strings.TrimSpace(agentTargetID)
	}
	if strings.TrimSpace(agentTargetID) == "" {
		agentTargetID = "default"
	}
	return agentcatalog.SnapshotKey{
		Facet: agentcatalog.FacetModels, ProviderID: strings.TrimSpace(provider), AgentTargetID: strings.TrimSpace(agentTargetID),
		ScopeKind: agentcatalog.ScopeKind(policy.ScopeKind), ScopeValue: scopeValue, DescriptorSchemaVersion: modelDiscoveryDescriptorSchemaVersion,
	}
}

func modelCatalogPolicy(policy providerregistry.ModelDiscoveryDescriptor, selectedModel string) agentcatalog.ModelDiscoveryPolicy {
	fallback := []agentcatalog.ModelOption(nil)
	if policy.FallbackKind == providerregistry.ModelFallbackKindClaudeAliases {
		for _, option := range staticClaudeComposerModelOptions(selectedModel) {
			fallback = append(fallback, agentcatalog.ModelOption{Value: option.Value, Label: option.Label, Description: option.Description, SupportsImageInput: option.SupportsImageInput})
		}
	}
	return agentcatalog.ModelDiscoveryPolicy{
		Enabled: policy.Enabled, ReuseRuntimeSnapshot: policy.ReuseRuntimeSnapshot, RuntimeAuthoritative: policy.RuntimeAuthoritative,
		PersistLastGood: policy.PersistLastGood, FreshTTL: time.Duration(policy.FreshTTLSeconds) * time.Second,
		MaxStale: time.Duration(policy.MaxStaleSeconds) * time.Second, ColdResolverKind: string(policy.ColdResolverKind), FallbackModels: fallback,
	}
}

func agentModelCatalogSnapshot(result AgentModelCatalogResult) agentcatalog.ModelSnapshot {
	models := make([]agentcatalog.ModelOption, 0, len(result.Models))
	for _, model := range result.Models {
		reasoning := make([]agentcatalog.ModelReasoningOption, 0, len(model.SupportedReasoningEfforts))
		for _, option := range model.SupportedReasoningEfforts {
			reasoning = append(reasoning, agentcatalog.ModelReasoningOption{Value: option.Value, Description: option.Description})
		}
		models = append(models, agentcatalog.ModelOption{
			Value: model.ID, Label: model.DisplayName, Description: model.Description, IsDefault: model.IsDefault,
			DefaultReasoningEffort: model.DefaultReasoningEffort, ReasoningEffortsAdvertised: model.ReasoningEffortsAdvertised,
			SupportedReasoningEfforts: reasoning, SupportsImageInput: model.SupportsImageInput,
		})
	}
	return agentcatalog.ModelSnapshot{Models: models, ResolverSource: result.Source, Complete: true}
}

func composerModelSnapshot(models []ComposerConfigOptionValue, complete bool) agentcatalog.ModelSnapshot {
	result := make([]agentcatalog.ModelOption, 0, len(models))
	for _, model := range models {
		value := strings.TrimSpace(model.Value)
		if value == "" {
			value = strings.TrimSpace(model.ID)
		}
		result = append(result, agentcatalog.ModelOption{Value: value, Label: model.Label, Description: model.Description, IsDefault: value == "default", SupportsImageInput: model.SupportsImageInput})
	}
	return agentcatalog.ModelSnapshot{Models: result, Complete: complete}
}

func catalogSnapshotProjection(snapshot agentcatalog.ResolveModelsResult, selectedModel string) (composerModelCatalogProjection, bool) {
	if len(snapshot.Value.Models) == 0 {
		return composerModelCatalogProjection{}, false
	}
	source := strings.TrimSpace(snapshot.Value.ResolverSource)
	if source == "" {
		source = string(snapshot.Source)
	}
	result := AgentModelCatalogResult{Source: source, FetchedAt: snapshot.FetchedAt}
	for _, model := range snapshot.Value.Models {
		reasoning := make([]AgentModelReasoningEffortOption, 0, len(model.SupportedReasoningEfforts))
		for _, option := range model.SupportedReasoningEfforts {
			reasoning = append(reasoning, AgentModelReasoningEffortOption{Value: option.Value, Description: option.Description})
		}
		result.Models = append(result.Models, AgentModelOption{ID: model.Value, DisplayName: model.Label, Description: model.Description, IsDefault: model.IsDefault, DefaultReasoningEffort: model.DefaultReasoningEffort, ReasoningEffortsAdvertised: model.ReasoningEffortsAdvertised, SupportedReasoningEfforts: reasoning, SupportsImageInput: model.SupportsImageInput})
	}
	return composerModelOptionsFromCatalogResult(result, selectedModel)
}
