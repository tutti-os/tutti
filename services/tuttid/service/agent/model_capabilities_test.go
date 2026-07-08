package agent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func TestModelCapabilitiesModelsDevTakesPrecedenceOverProviderRules(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"openai":{"models":{"gpt-5.2":{"modalities":{"input":["text"]}}}}}`))
	}))
	defer server.Close()
	service := &ModelCapabilitiesService{APIURL: server.URL}

	result := service.ResolveModelCapabilities(context.Background(), ModelCapabilityLookupInput{
		Provider: "cursor",
		ModelID:  "openai/gpt-5.2[reasoning=medium,fast=false]",
		Label:    "composer-2.5",
	})
	if result.SupportsImageInput == nil || *result.SupportsImageInput {
		t.Fatalf("supportsImageInput = %#v, want explicit false from models.dev", result.SupportsImageInput)
	}
	if result.Source != modelCapabilitiesSourceModelsDev {
		t.Fatalf("source = %q, want models.dev", result.Source)
	}
}

func TestModelCapabilitiesUsesCursorRuleWhenModelsDevDoesNotMatch(t *testing.T) {
	t.Parallel()
	service := &ModelCapabilitiesService{}

	result := service.ResolveModelCapabilities(context.Background(), ModelCapabilityLookupInput{
		Provider: "cursor",
		ModelID:  "composer-2.5[fast=true]",
		Label:    "composer-2.5",
	})
	if result.SupportsImageInput == nil || !*result.SupportsImageInput {
		t.Fatalf("supportsImageInput = %#v, want cursor composer model supported", result.SupportsImageInput)
	}
	if result.Source != modelCapabilitiesSourceProviderRules {
		t.Fatalf("source = %q, want provider rules", result.Source)
	}
}

func TestModelCapabilitiesModelsDevSupportsImage(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"openai":{"models":{"gpt-5.2-pro":{"modalities":{"input":["text","image"]}}}}}`))
	}))
	defer server.Close()
	service := &ModelCapabilitiesService{APIURL: server.URL}

	result := service.ResolveModelCapabilities(context.Background(), ModelCapabilityLookupInput{
		Provider: "opencode",
		ModelID:  "openai/gpt-5.2-pro",
		Label:    "GPT-5.2 Pro",
	})
	if result.SupportsImageInput == nil || !*result.SupportsImageInput {
		t.Fatalf("supportsImageInput = %#v, want true", result.SupportsImageInput)
	}
}

func TestModelCapabilitiesInfersModelsDevProviderForBarePublicModel(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"openai":{"models":{"gpt-5.2":{"modalities":{"input":["text","image"]}}}}}`))
	}))
	defer server.Close()
	service := &ModelCapabilitiesService{APIURL: server.URL}

	result := service.ResolveModelCapabilities(context.Background(), ModelCapabilityLookupInput{
		Provider: "cursor",
		ModelID:  "gpt-5.2[reasoning=medium,fast=false]",
		Label:    "gpt-5.2",
	})
	if result.SupportsImageInput == nil || !*result.SupportsImageInput {
		t.Fatalf("supportsImageInput = %#v, want inferred openai model support", result.SupportsImageInput)
	}
	if result.Source != modelCapabilitiesSourceModelsDev {
		t.Fatalf("source = %q, want models.dev", result.Source)
	}
}

func TestModelCapabilitiesMatchesSpeedSuffixedModelToBaseModel(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"openai":{"models":{"gpt-5.5":{"modalities":{"input":["text","image"]}}}}}`))
	}))
	defer server.Close()
	service := &ModelCapabilitiesService{APIURL: server.URL}

	result := service.ResolveModelCapabilities(context.Background(), ModelCapabilityLookupInput{
		Provider: "opencode",
		ModelID:  "openai/gpt-5.5-fast",
		Label:    "openai/gpt-5.5-fast",
	})
	if result.SupportsImageInput == nil || !*result.SupportsImageInput {
		t.Fatalf("supportsImageInput = %#v, want true from base model", result.SupportsImageInput)
	}
	if result.Source != modelCapabilitiesSourceModelsDev {
		t.Fatalf("source = %q, want models.dev", result.Source)
	}
}

func TestModelCapabilitiesPrefersExactSpeedSuffixedModelsDevMatch(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"openai":{"models":{"gpt-5.5":{"modalities":{"input":["text","image"]}},"gpt-5.5-fast":{"modalities":{"input":["text"]}}}}}`))
	}))
	defer server.Close()
	service := &ModelCapabilitiesService{APIURL: server.URL}

	result := service.ResolveModelCapabilities(context.Background(), ModelCapabilityLookupInput{
		Provider: "opencode",
		ModelID:  "openai/gpt-5.5-fast",
		Label:    "openai/gpt-5.5-fast",
	})
	if result.SupportsImageInput == nil || *result.SupportsImageInput {
		t.Fatalf("supportsImageInput = %#v, want exact speed-suffixed model to stay authoritative", result.SupportsImageInput)
	}
	if result.Source != modelCapabilitiesSourceModelsDev {
		t.Fatalf("source = %q, want models.dev", result.Source)
	}
}

func TestModelCapabilitiesCachesModelsDevFetches(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"openai":{"models":{"gpt-5.2-pro":{"modalities":{"input":["text","image"]}}}}}`))
	}))
	defer server.Close()
	now := time.Unix(100, 0)
	service := &ModelCapabilitiesService{
		APIURL:     server.URL,
		Now:        func() time.Time { return now },
		SuccessTTL: time.Hour,
	}

	for range 2 {
		result := service.ResolveModelCapabilities(context.Background(), ModelCapabilityLookupInput{
			Provider: "opencode",
			ModelID:  "openai/gpt-5.2-pro",
		})
		if result.SupportsImageInput == nil || !*result.SupportsImageInput {
			t.Fatalf("supportsImageInput = %#v, want true", result.SupportsImageInput)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("models.dev calls = %d, want 1", calls.Load())
	}
	now = now.Add(2 * time.Hour)
	_ = service.ResolveModelCapabilities(context.Background(), ModelCapabilityLookupInput{
		Provider: "opencode",
		ModelID:  "openai/gpt-5.2-pro",
	})
	if calls.Load() != 2 {
		t.Fatalf("models.dev calls after ttl = %d, want 2", calls.Load())
	}
}

func TestModelCapabilitiesErrorStillAllowsCursorRule(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusInternalServerError)
	}))
	defer server.Close()
	service := &ModelCapabilitiesService{APIURL: server.URL}

	result := service.ResolveModelCapabilities(context.Background(), ModelCapabilityLookupInput{
		Provider: "cursor",
		ModelID:  "default[]",
		Label:    "Auto",
	})
	if result.SupportsImageInput == nil || !*result.SupportsImageInput {
		t.Fatalf("supportsImageInput = %#v, want cursor rule after models.dev failure", result.SupportsImageInput)
	}
}

func TestModelCapabilitiesSharedFetchIgnoresCallerCancellation(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if err := r.Context().Err(); err != nil {
			t.Errorf("models.dev request context error = %v, want nil", err)
		}
		_, _ = w.Write([]byte(`{"openai":{"models":{"gpt-5.2-pro":{"modalities":{"input":["text","image"]}}}}}`))
	}))
	defer server.Close()
	service := &ModelCapabilitiesService{
		APIURL:       server.URL,
		FetchTimeout: time.Second,
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	result := service.ResolveModelCapabilities(ctx, ModelCapabilityLookupInput{
		Provider: "opencode",
		ModelID:  "openai/gpt-5.2-pro",
	})
	if result.SupportsImageInput == nil || !*result.SupportsImageInput {
		t.Fatalf("supportsImageInput = %#v, want true despite caller cancellation", result.SupportsImageInput)
	}
	if calls.Load() != 1 {
		t.Fatalf("models.dev calls = %d, want 1", calls.Load())
	}
}

func TestServiceEnrichesComposerModelOptions(t *testing.T) {
	t.Parallel()
	service := &Service{ModelCapabilities: fakeModelCapabilitiesResolver{
		"opencode:openai/gpt-5.2-pro":    true,
		"cursor:composer-2.5[fast=true]": true,
	}}

	options := service.enrichModelCapabilityOptions(context.Background(), "opencode", []ComposerConfigOptionValue{{
		ID:    "openai/gpt-5.2-pro",
		Label: "GPT-5.2 Pro",
		Value: "openai/gpt-5.2-pro",
	}})
	if len(options) != 1 || options[0].SupportsImageInput == nil || !*options[0].SupportsImageInput {
		t.Fatalf("opencode options = %#v, want supportsImageInput true", options)
	}

	liveOptions := service.enrichModelCapabilityOptions(context.Background(), "cursor", []ComposerConfigOptionValue{{
		ID:    "composer-2.5[fast=true]",
		Label: "composer-2.5",
		Value: "composer-2.5[fast=true]",
	}})
	if len(liveOptions) != 1 || liveOptions[0].SupportsImageInput == nil || !*liveOptions[0].SupportsImageInput {
		t.Fatalf("cursor options = %#v, want supportsImageInput true", liveOptions)
	}
}

type fakeModelCapabilitiesResolver map[string]bool

func (r fakeModelCapabilitiesResolver) ResolveModelCapabilities(_ context.Context, input ModelCapabilityLookupInput) ModelCapabilityResult {
	value, ok := r[agentprovider.Normalize(input.Provider)+":"+input.ModelID]
	if !ok {
		return ModelCapabilityResult{}
	}
	return ModelCapabilityResult{SupportsImageInput: &value, Source: "fake"}
}
