package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/httpx"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	"golang.org/x/sync/singleflight"
)

const (
	defaultModelsDevAPIURL               = "https://models.dev/api.json"
	defaultModelCapabilitiesSuccessTTL   = 6 * time.Hour
	defaultModelCapabilitiesErrorTTL     = 5 * time.Minute
	defaultModelCapabilitiesFetchTimeout = 10 * time.Second
	modelCapabilitiesLogPrefix           = "agent.model_capabilities"
	modelCapabilitiesSourceModelsDev     = "models.dev"
	modelCapabilitiesSourceProviderRules = "provider-rules"
)

type modelCapabilityDecision int

const (
	modelCapabilityUnknown modelCapabilityDecision = iota
	modelCapabilityUnsupported
	modelCapabilitySupported
)

type ModelCapabilityLookupInput struct {
	Provider string
	ModelID  string
	Label    string
}

type ModelCapabilityResult struct {
	SupportsImageInput *bool
	Source             string
}

type ModelCapabilitiesResolver interface {
	ResolveModelCapabilities(context.Context, ModelCapabilityLookupInput) ModelCapabilityResult
}

type ModelCapabilitiesService struct {
	APIURL       string
	HTTPClient   *http.Client
	Now          func() time.Time
	SuccessTTL   time.Duration
	ErrorTTL     time.Duration
	FetchTimeout time.Duration

	mu          sync.Mutex
	cached      *modelsDevCatalog
	cachedErr   error
	expiresAtMS int64
	group       singleflight.Group
}

type modelsDevCatalog struct {
	providers map[string]modelsDevProvider
}

type modelsDevProvider struct {
	models map[string]modelsDevModel
}

type modelsDevModel struct {
	modalities modelsDevModalities
}

type modelsDevModalities struct {
	input []string
}

func NewModelCapabilitiesService() *ModelCapabilitiesService {
	return &ModelCapabilitiesService{}
}

func (s *ModelCapabilitiesService) ResolveModelCapabilities(ctx context.Context, input ModelCapabilityLookupInput) ModelCapabilityResult {
	provider := agentprovider.Normalize(input.Provider)
	modelID := strings.TrimSpace(input.ModelID)
	label := strings.TrimSpace(input.Label)
	if !providerUsesModelImageCapabilities(provider) {
		return ModelCapabilityResult{}
	}
	if modelID == "" && label == "" {
		return ModelCapabilityResult{}
	}
	if decision, ok := s.resolveFromModelsDev(ctx, modelID); ok {
		return modelCapabilityResult(decision, modelCapabilitiesSourceModelsDev)
	}
	if decision := providerRuleModelImageCapability(provider, modelID, label); decision != modelCapabilityUnknown {
		return modelCapabilityResult(decision, modelCapabilitiesSourceProviderRules)
	}
	logModelCapabilities("unknown", map[string]any{
		"provider": provider,
		"modelID":  modelID,
		"label":    label,
	})
	return ModelCapabilityResult{}
}

func (s *ModelCapabilitiesService) resolveFromModelsDev(ctx context.Context, modelID string) (modelCapabilityDecision, bool) {
	normalized := normalizeModelCapabilityID(modelID)
	candidates := modelCapabilityIDCandidates(normalized)
	if len(candidates) == 0 {
		return modelCapabilityUnknown, false
	}
	catalog, err := s.modelsDevCatalog(ctx)
	if err != nil {
		logModelCapabilities("models_dev.fetch_unavailable", map[string]any{
			"modelID": normalized,
			"error":   err.Error(),
		})
		return modelCapabilityUnknown, false
	}
	for _, candidate := range candidates {
		providerID, modelName, ok := strings.Cut(candidate, "/")
		if !ok || strings.TrimSpace(providerID) == "" || strings.TrimSpace(modelName) == "" {
			continue
		}
		provider, ok := catalog.providers[strings.TrimSpace(providerID)]
		if !ok {
			continue
		}
		model, ok := provider.models[strings.TrimSpace(modelName)]
		if !ok {
			continue
		}
		supportsImage := false
		for _, modality := range model.modalities.input {
			if strings.EqualFold(strings.TrimSpace(modality), "image") {
				supportsImage = true
				break
			}
		}
		logModelCapabilities("models_dev.match", map[string]any{
			"modelID":            normalized,
			"candidate":          candidate,
			"supportsImageInput": supportsImage,
		})
		if supportsImage {
			return modelCapabilitySupported, true
		}
		return modelCapabilityUnsupported, true
	}
	return modelCapabilityUnknown, false
}

func (s *ModelCapabilitiesService) modelsDevCatalog(ctx context.Context) (*modelsDevCatalog, error) {
	now := s.now()
	if cached, ok, err := s.readModelsDevCache(now); ok {
		if err == nil {
			logModelCapabilities("models_dev.cache_hit", map[string]any{"status": "ok"})
		}
		return cached, err
	}
	value, err, _ := s.group.Do("models-dev", func() (any, error) {
		now := s.now()
		if cached, ok, err := s.readModelsDevCache(now); ok {
			return cached, err
		}
		fetchCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.fetchTimeout())
		defer cancel()
		catalog, fetchErr := s.fetchModelsDevCatalog(fetchCtx)
		s.writeModelsDevCache(now, catalog, fetchErr)
		return catalog, fetchErr
	})
	if err != nil {
		return nil, err
	}
	catalog, _ := value.(*modelsDevCatalog)
	return catalog, nil
}

func (s *ModelCapabilitiesService) readModelsDevCache(now time.Time) (*modelsDevCatalog, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.expiresAtMS == 0 || now.UnixMilli() > s.expiresAtMS {
		return nil, false, nil
	}
	return s.cached, true, s.cachedErr
}

func (s *ModelCapabilitiesService) writeModelsDevCache(now time.Time, catalog *modelsDevCatalog, err error) {
	ttl := s.successTTL()
	if err != nil {
		ttl = s.errorTTL()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cached = catalog
	s.cachedErr = err
	s.expiresAtMS = now.Add(ttl).UnixMilli()
}

func (s *ModelCapabilitiesService) fetchModelsDevCatalog(ctx context.Context) (*modelsDevCatalog, error) {
	url := strings.TrimSpace(s.APIURL)
	if url == "" {
		url = defaultModelsDevAPIURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("create models.dev request: %w", err)
	}
	client := s.HTTPClient
	if client == nil {
		client = httpx.Default()
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch models.dev catalog: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil, fmt.Errorf("fetch models.dev catalog: status %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, fmt.Errorf("read models.dev catalog: %w", err)
	}
	catalog, err := parseModelsDevCatalog(data)
	if err != nil {
		return nil, err
	}
	logModelCapabilities("models_dev.fetch_success", map[string]any{
		"providers": len(catalog.providers),
	})
	return catalog, nil
}

func parseModelsDevCatalog(data []byte) (*modelsDevCatalog, error) {
	var raw map[string]struct {
		Models map[string]struct {
			Modalities struct {
				Input []string `json:"input"`
			} `json:"modalities"`
		} `json:"models"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parse models.dev catalog: %w", err)
	}
	catalog := &modelsDevCatalog{providers: make(map[string]modelsDevProvider, len(raw))}
	for providerID, provider := range raw {
		normalizedProviderID := strings.TrimSpace(providerID)
		if normalizedProviderID == "" {
			continue
		}
		models := make(map[string]modelsDevModel, len(provider.Models))
		for modelID, model := range provider.Models {
			normalizedModelID := strings.TrimSpace(modelID)
			if normalizedModelID == "" {
				continue
			}
			models[normalizedModelID] = modelsDevModel{
				modalities: modelsDevModalities{input: append([]string(nil), model.Modalities.Input...)},
			}
		}
		catalog.providers[normalizedProviderID] = modelsDevProvider{models: models}
	}
	return catalog, nil
}

func providerRuleModelImageCapability(provider string, modelID string, label string) modelCapabilityDecision {
	if composerProfileFor(provider).ModelCapabilityRuleKind != providerregistry.ModelCapabilityRuleKindCursorComposerImage {
		return modelCapabilityUnknown
	}
	baseModelID := normalizeModelCapabilityID(modelID)
	baseModelID = stripModelCapabilityParameters(baseModelID)
	baseLabel := strings.ToLower(strings.TrimSpace(label))
	switch {
	case baseModelID == "default" || baseModelID == "auto":
		return modelCapabilitySupported
	case baseLabel == "auto":
		return modelCapabilitySupported
	case strings.HasPrefix(strings.ToLower(baseModelID), "composer-"):
		return modelCapabilitySupported
	default:
		return modelCapabilityUnknown
	}
}

func providerUsesModelImageCapabilities(provider string) bool {
	return composerProfileHasCapability(
		agentprovider.Normalize(provider),
		providerregistry.CapabilityModelImageInputRequired,
	)
}

func enrichAgentModelOptions(ctx context.Context, provider string, models []AgentModelOption, resolver ModelCapabilitiesResolver) []AgentModelOption {
	if len(models) == 0 || resolver == nil || !providerUsesModelImageCapabilities(provider) {
		return cloneAgentModelOptions(models)
	}
	result := cloneAgentModelOptions(models)
	for index := range result {
		if result[index].SupportsImageInput != nil {
			continue
		}
		capabilities := resolver.ResolveModelCapabilities(ctx, ModelCapabilityLookupInput{
			Provider: provider,
			ModelID:  result[index].ID,
			Label:    result[index].DisplayName,
		})
		if capabilities.SupportsImageInput != nil {
			result[index].SupportsImageInput = capabilities.SupportsImageInput
		}
	}
	return result
}

func (s *Service) enrichModelCapabilityOptions(ctx context.Context, provider string, options []ComposerConfigOptionValue) []ComposerConfigOptionValue {
	if len(options) == 0 || s == nil || s.ModelCapabilities == nil || !providerUsesModelImageCapabilities(provider) {
		return cloneComposerConfigOptionValues(options)
	}
	result := cloneComposerConfigOptionValues(options)
	for index := range result {
		if result[index].SupportsImageInput != nil {
			continue
		}
		capabilities := s.ModelCapabilities.ResolveModelCapabilities(ctx, ModelCapabilityLookupInput{
			Provider: provider,
			ModelID:  result[index].Value,
			Label:    result[index].Label,
		})
		if capabilities.SupportsImageInput != nil {
			result[index].SupportsImageInput = capabilities.SupportsImageInput
		}
	}
	return result
}

func modelCapabilityResult(decision modelCapabilityDecision, source string) ModelCapabilityResult {
	switch decision {
	case modelCapabilitySupported:
		value := true
		return ModelCapabilityResult{SupportsImageInput: &value, Source: source}
	case modelCapabilityUnsupported:
		value := false
		return ModelCapabilityResult{SupportsImageInput: &value, Source: source}
	default:
		return ModelCapabilityResult{}
	}
}

func modelCapabilityIDCandidates(modelID string) []string {
	normalized := normalizeModelCapabilityID(modelID)
	if normalized == "" {
		return nil
	}
	base := stripModelCapabilityParameters(normalized)
	candidates := []string{}
	if strings.Contains(normalized, "/") {
		candidates = append(candidates, normalized)
	}
	if base != "" && base != normalized && strings.Contains(base, "/") {
		candidates = append(candidates, base)
	}
	for _, candidateBase := range modelCapabilityBaseIDCandidates(base) {
		if strings.Contains(candidateBase, "/") {
			candidates = append(candidates, candidateBase)
		}
		candidates = append(candidates, inferModelsDevProviderCandidates(candidateBase)...)
	}
	candidates = append(candidates, inferModelsDevProviderCandidates(base)...)
	return dedupeModelCapabilityCandidates(candidates)
}

func normalizeModelCapabilityID(modelID string) string {
	return strings.TrimSpace(modelID)
}

func stripModelCapabilityParameters(modelID string) string {
	if before, _, ok := strings.Cut(strings.TrimSpace(modelID), "["); ok {
		return strings.TrimSpace(before)
	}
	return strings.TrimSpace(modelID)
}

func modelCapabilityBaseIDCandidates(modelID string) []string {
	modelID = strings.TrimSpace(modelID)
	if modelID == "" {
		return nil
	}
	strippedSpeed := stripModelCapabilitySpeedSuffix(modelID)
	if strippedSpeed == "" || strippedSpeed == modelID {
		return nil
	}
	return []string{strippedSpeed}
}

func stripModelCapabilitySpeedSuffix(modelID string) string {
	modelID = strings.TrimSpace(modelID)
	if modelID == "" {
		return ""
	}
	providerID, modelName, hasProvider := strings.Cut(modelID, "/")
	target := modelID
	if hasProvider {
		target = modelName
	}
	if !strings.HasSuffix(strings.ToLower(target), "-fast") {
		return modelID
	}
	target = strings.TrimSpace(target[:len(target)-len("-fast")])
	if target == "" {
		return modelID
	}
	if hasProvider {
		return strings.TrimSpace(providerID) + "/" + target
	}
	return target
}

func inferModelsDevProviderCandidates(modelID string) []string {
	modelID = strings.TrimSpace(modelID)
	lower := strings.ToLower(modelID)
	switch {
	case strings.HasPrefix(lower, "gpt-"), strings.HasPrefix(lower, "o1"), strings.HasPrefix(lower, "o3"), strings.HasPrefix(lower, "o4"):
		return []string{"openai/" + modelID}
	case strings.HasPrefix(lower, "claude-"):
		return []string{"anthropic/" + modelID}
	case strings.HasPrefix(lower, "gemini-"):
		return []string{"google/" + modelID}
	case strings.HasPrefix(lower, "grok-"):
		return []string{"xai/" + modelID}
	case strings.HasPrefix(lower, "kimi-"):
		return []string{"moonshotai/" + modelID}
	case strings.HasPrefix(lower, "glm-"):
		return []string{"zai/" + modelID}
	case strings.HasPrefix(lower, "deepseek-"):
		return []string{"deepseek/" + modelID}
	default:
		return nil
	}
}

func dedupeModelCapabilityCandidates(candidates []string) []string {
	seen := map[string]struct{}{}
	result := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		if _, ok := seen[candidate]; ok {
			continue
		}
		seen[candidate] = struct{}{}
		result = append(result, candidate)
	}
	return result
}

func (s *ModelCapabilitiesService) now() time.Time {
	if s != nil && s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *ModelCapabilitiesService) successTTL() time.Duration {
	if s != nil && s.SuccessTTL > 0 {
		return s.SuccessTTL
	}
	return defaultModelCapabilitiesSuccessTTL
}

func (s *ModelCapabilitiesService) errorTTL() time.Duration {
	if s != nil && s.ErrorTTL > 0 {
		return s.ErrorTTL
	}
	return defaultModelCapabilitiesErrorTTL
}

func (s *ModelCapabilitiesService) fetchTimeout() time.Duration {
	if s != nil && s.FetchTimeout > 0 {
		return s.FetchTimeout
	}
	return defaultModelCapabilitiesFetchTimeout
}

func logModelCapabilities(stage string, payload map[string]any) {
	if payload == nil {
		payload = map[string]any{}
	}
	payload["stage"] = stage
	encoded, err := json.Marshal(payload)
	if err != nil {
		encoded, _ = json.Marshal(map[string]any{
			"stage": stage,
			"error": err.Error(),
		})
	}
	slog.Info(modelCapabilitiesLogPrefix, "payload", string(encoded))
}
