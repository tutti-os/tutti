package agent

import (
	"context"
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
