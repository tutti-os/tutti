package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestCodexCLIModelListerCompletesInitializeHandshakeBeforeModelList(t *testing.T) {
	scriptPath := filepath.Join(t.TempDir(), "codex")
	script := `#!/bin/sh
initialized=false
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      echo '{"id":"1","result":{}}'
      ;;
    *'"method":"initialized"'*)
      initialized=true
      ;;
    *model/list*)
      if [ "$initialized" != true ]; then
        echo '{"id":"2","error":{"code":-32600,"message":"Not initialized"}}'
        exit 0
      fi
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

func TestRequestCodexModelListReadsInitializeResponseBeforeFollowingRequests(t *testing.T) {
	transport := &strictCodexHandshakeTransport{}

	models, err := requestCodexModelList(transport, transport, "tuttid-test")
	if err != nil {
		t.Fatalf("requestCodexModelList returned error: %v", err)
	}
	if len(models) != 1 || models[0].ID != "gpt-5" {
		t.Fatalf("models = %#v, want gpt-5", models)
	}
	wantMethods := []string{"initialize", "initialized", "model/list"}
	if !reflect.DeepEqual(transport.methods, wantMethods) {
		t.Fatalf("request methods = %#v, want %#v", transport.methods, wantMethods)
	}
}

type strictCodexHandshakeTransport struct {
	methods                []string
	initializeRequested    bool
	initializeResponseRead bool
	initializedReceived    bool
	modelListRequested     bool
	responseStage          int
}

func (t *strictCodexHandshakeTransport) Write(p []byte) (int, error) {
	var request struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
	}
	if err := json.Unmarshal(p, &request); err != nil {
		return 0, err
	}
	t.methods = append(t.methods, request.Method)
	switch request.Method {
	case "initialize":
		t.initializeRequested = true
	case "initialized":
		if !t.initializeResponseRead {
			return 0, errors.New("initialized sent before initialize response was read")
		}
		if len(request.ID) != 0 {
			return 0, errors.New("initialized must be a notification without an id")
		}
		t.initializedReceived = true
	case "model/list":
		if !t.initializeResponseRead {
			return 0, errors.New("model/list sent before initialize response was read")
		}
		if !t.initializedReceived {
			return 0, errors.New("model/list sent before initialized")
		}
		t.modelListRequested = true
	default:
		return 0, errors.New("unexpected Codex app-server method")
	}
	return len(p), nil
}

func (t *strictCodexHandshakeTransport) Read(p []byte) (int, error) {
	var response string
	switch t.responseStage {
	case 0:
		if !t.initializeRequested {
			return 0, errors.New("initialize response read before initialize request")
		}
		t.initializeResponseRead = true
		response = `{"id":"1","result":{}}` + "\n"
	case 1:
		if !t.modelListRequested {
			return 0, errors.New("model/list response read before model/list request")
		}
		response = `{"id":"2","result":{"data":[{"id":"gpt-5"}]}}` + "\n"
	default:
		return 0, io.EOF
	}
	t.responseStage += 1
	return copy(p, response), nil
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
    *'"method":"initialize"'*)
      echo '{"id":"1","result":{}}'
      ;;
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

	first, err := catalog.ListModels(context.Background(), AgentModelCatalogInput{Provider: "codex"})
	if err != nil {
		t.Fatalf("first ListModels returned error: %v", err)
	}
	second, err := catalog.ListModels(context.Background(), AgentModelCatalogInput{Provider: "codex"})
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
