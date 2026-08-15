package agent

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type blockingComposerModelCatalog struct {
	started chan struct{}
	release chan struct{}
}

func (c *blockingComposerModelCatalog) ListModels(
	ctx context.Context,
	_ AgentModelCatalogInput,
) (AgentModelCatalogResult, error) {
	close(c.started)
	select {
	case <-c.release:
		return AgentModelCatalogResult{
			Models: []AgentModelOption{{
				ID:          "gpt-5.6-sol",
				DisplayName: "GPT-5.6",
				IsDefault:   true,
			}},
			Source: "test",
		}, nil
	case <-ctx.Done():
		return AgentModelCatalogResult{}, ctx.Err()
	}
}

type blockingComposerCapabilityLister struct {
	started chan struct{}
	release chan struct{}
}

func (l *blockingComposerCapabilityLister) ListComposerCapabilityOptions(
	ctx context.Context,
	_ string,
	_ string,
	_ []ComposerSkillOption,
) ([]ComposerCapabilityOption, []string) {
	close(l.started)
	select {
	case <-l.release:
		return nil, nil
	case <-ctx.Done():
		return nil, []string{ctx.Err().Error()}
	}
}

func TestServiceGetComposerOptionsLoadsModelAndCapabilityCatalogsConcurrently(t *testing.T) {
	modelCatalog := &blockingComposerModelCatalog{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	capabilityLister := &blockingComposerCapabilityLister{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	defer closeTestRelease(modelCatalog.release)
	defer closeTestRelease(capabilityLister.release)

	service := newIsolatedAgentService(newFakeRuntime())
	service.ModelCatalog = modelCatalog
	service.CapabilityLister = capabilityLister

	result := make(chan error, 1)
	go func() {
		_, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
			Provider:               "codex",
			IgnoreModelPlanBinding: true,
		})
		result <- err
	}()

	waitForCatalogLoadStart(t, modelCatalog.started, "model")
	waitForCatalogLoadStart(t, capabilityLister.started, "capability")
	close(modelCatalog.release)
	close(capabilityLister.release)

	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("GetComposerOptions returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("GetComposerOptions did not finish after catalog releases")
	}
}

func TestServiceGetComposerOptionsCoreDoesNotStartCapabilityCatalog(t *testing.T) {
	capabilityLister := &blockingComposerCapabilityLister{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.CapabilityLister = capabilityLister

	result, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
		Section:  ComposerOptionsSectionCore,
	})
	if err != nil {
		t.Fatalf("core composer options returned error: %v", err)
	}
	if result.Provider != "codex" {
		t.Fatalf("provider = %q, want codex", result.Provider)
	}
	select {
	case <-capabilityLister.started:
		t.Fatal("core composer options started capability discovery")
	default:
	}
}

func TestServiceGetComposerOptionsCapabilitiesDoesNotStartModelCatalog(t *testing.T) {
	modelCatalog := &blockingComposerModelCatalog{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.ModelCatalog = modelCatalog
	includeCapabilities := true

	_, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		IncludeCapabilityCatalog: &includeCapabilities,
		Provider:                 "codex",
		Section:                  ComposerOptionsSectionCapabilities,
	})
	if err != nil {
		t.Fatalf("capabilities composer options returned error: %v", err)
	}
	select {
	case <-modelCatalog.started:
		t.Fatal("capabilities composer options started model discovery")
	default:
	}
}

type countingComposerCapabilityLister struct {
	allow   chan struct{}
	called  atomic.Int32
	started chan struct{}
	once    sync.Once
}

func (l *countingComposerCapabilityLister) ListComposerCapabilityOptions(
	context.Context,
	string,
	string,
	[]ComposerSkillOption,
) ([]ComposerCapabilityOption, []string) {
	l.called.Add(1)
	l.once.Do(func() { close(l.started) })
	<-l.allow
	return []ComposerCapabilityOption{{ID: "test", Kind: "skill", Name: "test", Label: "test"}}, nil
}

func TestServiceGetComposerOptionsDeduplicatesCapabilityDiscovery(t *testing.T) {
	lister := &countingComposerCapabilityLister{
		allow:   make(chan struct{}),
		started: make(chan struct{}),
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.CapabilityLister = lister
	includeCapabilities := true
	inputs := ComposerOptionsInput{
		IncludeCapabilityCatalog: &includeCapabilities,
		Provider:                 "codex",
		Section:                  ComposerOptionsSectionCapabilities,
	}
	results := make(chan error, 2)
	for range 2 {
		go func() {
			_, err := service.GetComposerOptions(context.Background(), inputs)
			results <- err
		}()
	}
	select {
	case <-lister.started:
	case <-time.After(2 * time.Second):
		t.Fatal("capability discovery did not start")
	}
	close(lister.allow)
	for range 2 {
		if err := <-results; err != nil {
			t.Fatalf("composer options returned error: %v", err)
		}
	}
	if got := lister.called.Load(); got != 1 {
		t.Fatalf("capability discovery calls = %d, want 1", got)
	}
}

func waitForCatalogLoadStart(t *testing.T, started <-chan struct{}, catalog string) {
	t.Helper()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatalf("%s catalog did not start while the other catalog was blocked", catalog)
	}
}

func closeTestRelease(release chan struct{}) {
	select {
	case <-release:
	default:
		close(release)
	}
}
