package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sync"
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

func TestRequestCodexModelListWithStagesReportsProviderStages(t *testing.T) {
	transport := &strictCodexHandshakeTransport{}
	var stages []string
	models, err := requestCodexModelListWithStages(
		transport,
		transport,
		"tuttid-test",
		func(stage string, _ time.Time, stageErr error) {
			if stageErr != nil {
				t.Fatalf("stage %q returned error: %v", stage, stageErr)
			}
			stages = append(stages, stage)
		},
	)
	if err != nil {
		t.Fatalf("requestCodexModelListWithStages returned error: %v", err)
	}
	if len(models) != 1 || models[0].ID != "gpt-5" {
		t.Fatalf("models = %#v, want gpt-5", models)
	}
	if !reflect.DeepEqual(stages, []string{"initialize", "model_list"}) {
		t.Fatalf("stages = %#v, want initialize then model_list", stages)
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

func TestCodexCLIModelListerReusesPersistentAppServerSession(t *testing.T) {
	tempDir := t.TempDir()
	scriptPath := filepath.Join(tempDir, "codex")
	countPath := filepath.Join(tempDir, "starts")
	script := "#!/bin/sh\n" +
		"count=0\n" +
		"if [ -f \"$CODEX_TEST_STARTS\" ]; then count=$(cat \"$CODEX_TEST_STARTS\"); fi\n" +
		"count=$((count + 1))\n" +
		"printf '%s' \"$count\" > \"$CODEX_TEST_STARTS\"\n" +
		"while IFS= read -r line; do\n" +
		"  case \"$line\" in\n" +
		"    *'\"method\":\"initialize\"'*)\n" +
		"      id=$(printf '%s' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p')\n" +
		"      printf '{\"id\":\"%s\",\"result\":{}}\\n' \"$id\"\n" +
		"      ;;\n" +
		"    *'\"method\":\"model/list\"'*)\n" +
		"      id=$(printf '%s' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p')\n" +
		"      printf '{\"id\":\"%s\",\"result\":{\"data\":[{\"id\":\"gpt-5\",\"displayName\":\"GPT-5\"}]}}\\n' \"$id\"\n" +
		"      ;;\n" +
		"  esac\n" +
		"done\n"
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write persistent fake codex: %v", err)
	}
	base := CodexCLIModelLister{
		Command: scriptPath,
		Environ: func() []string {
			return []string{"PATH=/usr/bin:/bin", "CODEX_TEST_STARTS=" + countPath}
		},
		Timeout: 2 * time.Second,
	}
	lister := base
	lister.Session = newCodexAppServerSession(base)
	first, err := lister.ListModels(context.Background())
	if err != nil {
		t.Fatalf("first ListModels returned error: %v", err)
	}
	second, err := lister.ListModels(context.Background())
	if err != nil {
		t.Fatalf("second ListModels returned error: %v", err)
	}
	if len(first.Models) != 1 || len(second.Models) != 1 || first.Models[0].ID != "gpt-5" || second.Models[0].ID != "gpt-5" {
		t.Fatalf("models = %#v / %#v, want gpt-5", first.Models, second.Models)
	}
	starts, err := os.ReadFile(countPath)
	if err != nil {
		t.Fatalf("read process start count: %v", err)
	}
	if string(starts) != "1" {
		t.Fatalf("app-server starts = %q, want one persistent process", starts)
	}
	if err := lister.Session.Close(); err != nil {
		t.Fatalf("close persistent app-server: %v", err)
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

func TestCachedAgentModelCatalogSharesConcurrentColdFetch(t *testing.T) {
	lister := &blockingAgentModelLister{
		started: make(chan struct{}),
		release: make(chan struct{}),
		models:  []AgentModelOption{{ID: "gpt-5", DisplayName: "GPT-5"}},
	}
	catalog := &CachedAgentModelCatalog{Codex: lister}
	results := make(chan error, 2)
	for range 2 {
		go func() {
			_, err := catalog.ListModels(context.Background(), AgentModelCatalogInput{Provider: "codex"})
			results <- err
		}()
	}
	select {
	case <-lister.started:
	case <-time.After(time.Second):
		t.Fatal("model lister did not start")
	}
	close(lister.release)
	for range 2 {
		select {
		case err := <-results:
			if err != nil {
				t.Fatalf("ListModels returned error: %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("shared model catalog fetch did not settle")
		}
	}
	if lister.calls() != 1 {
		t.Fatalf("lister calls = %d, want one shared fetch", lister.calls())
	}
}

func TestCachedAgentModelCatalogRefreshesStaleModelsInBackground(t *testing.T) {
	lister := &sequencedAgentModelLister{
		models: []AgentModelListResult{
			{Models: []AgentModelOption{{ID: "old-model", DisplayName: "Old"}}},
			{Models: []AgentModelOption{{ID: "new-model", DisplayName: "New"}}},
		},
		secondStarted: make(chan struct{}),
		secondRelease: make(chan struct{}),
	}
	refreshed := make(chan string, 1)
	catalog := &CachedAgentModelCatalog{
		Codex: lister,
		OnRefresh: func(provider string) {
			refreshed <- provider
		},
	}
	first, err := catalog.ListModels(context.Background(), AgentModelCatalogInput{Provider: "codex"})
	if err != nil {
		t.Fatalf("initial ListModels returned error: %v", err)
	}
	catalog.Invalidate("codex")
	stale, err := catalog.ListModels(context.Background(), AgentModelCatalogInput{Provider: "codex"})
	if err != nil {
		t.Fatalf("stale ListModels returned error: %v", err)
	}
	if !stale.Stale || stale.Models[0].ID != first.Models[0].ID {
		t.Fatalf("stale result = %#v, want old model marked stale", stale)
	}
	select {
	case <-lister.secondStarted:
	case <-time.After(time.Second):
		t.Fatal("background refresh did not start")
	}
	close(lister.secondRelease)
	select {
	case provider := <-refreshed:
		if provider != "codex" {
			t.Fatalf("refresh provider = %q, want codex", provider)
		}
	case <-time.After(time.Second):
		t.Fatal("background refresh did not publish completion")
	}
	fresh, err := catalog.ListModels(context.Background(), AgentModelCatalogInput{Provider: "codex"})
	if err != nil {
		t.Fatalf("fresh ListModels returned error: %v", err)
	}
	if fresh.Stale || len(fresh.Models) == 0 || fresh.Models[0].ID != "new-model" {
		t.Fatalf("fresh result = %#v, want new model", fresh)
	}
}

func TestCachedAgentModelCatalogLoadsPersistentCatalogBeforeBackgroundRefresh(t *testing.T) {
	persistentPath := filepath.Join(t.TempDir(), "model-catalog.json")
	first := &CachedAgentModelCatalog{
		Codex: &fakeAgentModelLister{
			models: []AgentModelOption{{ID: "old-model", DisplayName: "Old"}},
		},
		PersistentPath: persistentPath,
		AuthFingerprint: func(string) string {
			return "account-a"
		},
	}
	if _, err := first.ListModels(context.Background(), AgentModelCatalogInput{Provider: "codex"}); err != nil {
		t.Fatalf("initial ListModels returned error: %v", err)
	}

	refreshLister := &blockingAgentModelLister{
		started: make(chan struct{}),
		release: make(chan struct{}),
		models:  []AgentModelOption{{ID: "new-model", DisplayName: "New"}},
	}
	refreshed := make(chan string, 1)
	second := &CachedAgentModelCatalog{
		Codex:          refreshLister,
		PersistentPath: persistentPath,
		AuthFingerprint: func(string) string {
			return "account-a"
		},
		OnRefresh: func(provider string) {
			refreshed <- provider
		},
	}
	result, err := second.ListModels(context.Background(), AgentModelCatalogInput{Provider: "codex"})
	if err != nil {
		t.Fatalf("persistent ListModels returned error: %v", err)
	}
	if !result.Stale || len(result.Models) == 0 || result.Models[0].ID != "old-model" {
		t.Fatalf("persistent result = %#v, want stale old model", result)
	}
	select {
	case <-refreshLister.started:
	case <-time.After(time.Second):
		t.Fatal("persistent catalog did not start background refresh")
	}
	close(refreshLister.release)
	select {
	case provider := <-refreshed:
		if provider != "codex" {
			t.Fatalf("refresh provider = %q, want codex", provider)
		}
	case <-time.After(time.Second):
		t.Fatal("persistent catalog refresh did not settle")
	}
}

func TestCachedAgentModelCatalogWaitForFreshBlocksUntilRefreshSettles(t *testing.T) {
	lister := &sequencedAgentModelLister{
		models: []AgentModelListResult{
			{Models: []AgentModelOption{{ID: "old-model"}}},
			{Models: []AgentModelOption{{ID: "new-model"}}},
		},
		secondStarted: make(chan struct{}),
		secondRelease: make(chan struct{}),
	}
	catalog := &CachedAgentModelCatalog{Codex: lister}
	if _, err := catalog.ListModels(context.Background(), AgentModelCatalogInput{Provider: "codex"}); err != nil {
		t.Fatalf("initial ListModels returned error: %v", err)
	}
	catalog.Invalidate("codex")
	resultCh := make(chan struct {
		result AgentModelCatalogResult
		err    error
	}, 1)
	go func() {
		result, err := catalog.ListModels(context.Background(), AgentModelCatalogInput{
			Provider:     "codex",
			WaitForFresh: true,
		})
		resultCh <- struct {
			result AgentModelCatalogResult
			err    error
		}{result: result, err: err}
	}()
	select {
	case <-lister.secondStarted:
	case <-time.After(time.Second):
		t.Fatal("fresh catalog refresh did not start")
	}
	select {
	case result := <-resultCh:
		t.Fatalf("fresh request returned before refresh settled: %#v", result)
	default:
	}
	close(lister.secondRelease)
	select {
	case result := <-resultCh:
		if result.err != nil {
			t.Fatalf("fresh ListModels returned error: %v", result.err)
		}
		if result.result.Stale || result.result.Models[0].ID != "new-model" {
			t.Fatalf("fresh result = %#v, want new model", result.result)
		}
	case <-time.After(time.Second):
		t.Fatal("fresh request did not settle")
	}
}

func TestCachedAgentModelCatalogRejectsPersistentCatalogFromAnotherAuthGeneration(t *testing.T) {
	persistentPath := filepath.Join(t.TempDir(), "model-catalog.json")
	first := &CachedAgentModelCatalog{
		Codex:          &fakeAgentModelLister{models: []AgentModelOption{{ID: "old-model"}}},
		PersistentPath: persistentPath,
		AuthFingerprint: func(string) string {
			return "account-a"
		},
	}
	if _, err := first.ListModels(context.Background(), AgentModelCatalogInput{Provider: "codex"}); err != nil {
		t.Fatalf("initial ListModels returned error: %v", err)
	}
	secondLister := &fakeAgentModelLister{models: []AgentModelOption{{ID: "new-model"}}}
	second := &CachedAgentModelCatalog{
		Codex:          secondLister,
		PersistentPath: persistentPath,
		AuthFingerprint: func(string) string {
			return "account-b"
		},
	}
	result, err := second.ListModels(context.Background(), AgentModelCatalogInput{Provider: "codex"})
	if err != nil {
		t.Fatalf("auth-generation ListModels returned error: %v", err)
	}
	if result.Stale || len(result.Models) == 0 || result.Models[0].ID != "new-model" {
		t.Fatalf("auth-generation result = %#v, want fresh new model", result)
	}
	if secondLister.calls != 1 {
		t.Fatalf("new-account lister calls = %d, want one", secondLister.calls)
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

type blockingAgentModelLister struct {
	started chan struct{}
	release chan struct{}
	models  []AgentModelOption
	mu      sync.Mutex
	count   int
	once    sync.Once
}

func (l *blockingAgentModelLister) ListModels(ctx context.Context) (AgentModelListResult, error) {
	l.mu.Lock()
	l.count++
	l.mu.Unlock()
	l.once.Do(func() { close(l.started) })
	select {
	case <-l.release:
		return AgentModelListResult{Models: l.models}, nil
	case <-ctx.Done():
		return AgentModelListResult{}, ctx.Err()
	}
}

func (l *blockingAgentModelLister) calls() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.count
}

type sequencedAgentModelLister struct {
	models        []AgentModelListResult
	secondStarted chan struct{}
	secondRelease chan struct{}
	mu            sync.Mutex
	count         int
}

func (l *sequencedAgentModelLister) ListModels(ctx context.Context) (AgentModelListResult, error) {
	l.mu.Lock()
	index := l.count
	l.count++
	l.mu.Unlock()
	if index == 1 {
		close(l.secondStarted)
		select {
		case <-l.secondRelease:
		case <-ctx.Done():
			return AgentModelListResult{}, ctx.Err()
		}
	}
	if index >= len(l.models) {
		index = len(l.models) - 1
	}
	return l.models[index], nil
}
