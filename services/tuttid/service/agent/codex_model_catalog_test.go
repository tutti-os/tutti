package agent

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCodexCLIModelListerReadsModelListFromAppServer(t *testing.T) {
	scriptPath := filepath.Join(t.TempDir(), "codex")
	script := `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *model/list*)
      echo '{"id":"2","result":{"data":[{"id":"gpt-5","displayName":"GPT-5","description":"default","isDefault":true,"defaultReasoningEffort":"medium","supportedReasoningEfforts":[{"reasoningEffort":"medium","description":"Balanced"},{"reasoningEffort":"ultra","description":"Maximum reasoning with automatic task delegation"}]},{"model":"gpt-5.1"}]}}'
      sleep 10
      exit 0
      ;;
  esac
done
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake codex script: %v", err)
	}

	result, err := (CodexCLIModelLister{
		Command: scriptPath,
		Timeout: 15 * time.Second,
	}).ListModels(context.Background())
	if err != nil {
		t.Fatalf("ListModels returned error: %v", err)
	}
	models := result.Models
	if len(models) != 2 {
		t.Fatalf("len(models) = %d, want 2", len(models))
	}
	if models[0].ID != "gpt-5" || models[0].DisplayName != "GPT-5" || !models[0].IsDefault {
		t.Fatalf("first model = %#v", models[0])
	}
	if models[0].DefaultReasoningEffort != "medium" {
		t.Fatalf("first model default reasoning effort = %q, want medium", models[0].DefaultReasoningEffort)
	}
	if !models[0].ReasoningEffortsAdvertised {
		t.Fatal("first model reasoning efforts advertised = false, want true")
	}
	if len(models[0].SupportedReasoningEfforts) != 2 ||
		models[0].SupportedReasoningEfforts[1].Value != "ultra" ||
		models[0].SupportedReasoningEfforts[1].Description != "Maximum reasoning with automatic task delegation" {
		t.Fatalf("first model reasoning efforts = %#v", models[0].SupportedReasoningEfforts)
	}
	if models[1].ID != "gpt-5.1" || models[1].DisplayName != "gpt-5.1" {
		t.Fatalf("second model = %#v", models[1])
	}
	if models[1].ReasoningEffortsAdvertised {
		t.Fatal("second model reasoning efforts advertised = true, want false")
	}
}

func TestNormalizeCodexModelPreservesAdvertisedEmptyReasoningEfforts(t *testing.T) {
	model, ok := normalizeCodexModel([]byte(`{"id":"no-reasoning","supportedReasoningEfforts":[]}`))
	if !ok {
		t.Fatal("normalizeCodexModel ok = false")
	}
	if !model.ReasoningEffortsAdvertised {
		t.Fatal("ReasoningEffortsAdvertised = false, want true")
	}
	if model.SupportedReasoningEfforts == nil || len(model.SupportedReasoningEfforts) != 0 {
		t.Fatalf("SupportedReasoningEfforts = %#v, want advertised empty list", model.SupportedReasoningEfforts)
	}
}

func TestCodexCLIModelListerResolvesCodexFromKnownUserBin(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir local bin: %v", err)
	}
	scriptPath := filepath.Join(binDir, "codex")
	script := `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *model/list*)
      echo '{"id":"2","result":{"data":[{"id":"gpt-5","displayName":"GPT-5"}]}}'
      exit 0
      ;;
  esac
done
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake codex script: %v", err)
	}

	result, err := (CodexCLIModelLister{
		Environ: func() []string {
			return []string{"PATH=/usr/bin:/bin"}
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
		LookPath: func(string) (string, error) {
			return "", os.ErrNotExist
		},
		Timeout: 15 * time.Second,
	}).ListModels(context.Background())
	if err != nil {
		t.Fatalf("ListModels returned error: %v", err)
	}
	if len(result.Models) != 1 || result.Models[0].ID != "gpt-5" {
		t.Fatalf("models = %#v, want resolved user-bin codex result", result.Models)
	}
}

func TestCachedAgentModelCatalogCachesCodexModels(t *testing.T) {
	now := time.UnixMilli(1000)
	lister := &fakeAgentModelLister{
		models: []AgentModelOption{{ID: "gpt-5", DisplayName: "GPT-5"}},
	}
	catalog := &CachedAgentModelCatalog{
		Codex: lister,
		Now: func() time.Time {
			return now
		},
	}

	first, err := catalog.ListModels(context.Background(), "codex")
	if err != nil {
		t.Fatalf("first ListModels returned error: %v", err)
	}
	second, err := catalog.ListModels(context.Background(), "codex")
	if err != nil {
		t.Fatalf("second ListModels returned error: %v", err)
	}
	if lister.calls != 1 {
		t.Fatalf("lister calls = %d, want one cached fetch", lister.calls)
	}
	if first.Models[0].ID != second.Models[0].ID {
		t.Fatalf("cached result mismatch: first=%#v second=%#v", first, second)
	}
}

type fakeAgentModelLister struct {
	calls    int
	models   []AgentModelOption
	fallback bool
	err      error
}

func (f *fakeAgentModelLister) ListModels(context.Context) (AgentModelListResult, error) {
	f.calls += 1
	return AgentModelListResult{Models: f.models, IsFallback: f.fallback}, f.err
}
