package agent

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestParseOpenCodeModelsOutput(t *testing.T) {
	t.Parallel()

	models := parseOpenCodeModelsOutput([]byte(`
Provider  Model
anthropic claude-sonnet-4-5 anthropic/claude-sonnet-4-5
openai    gpt-5                  openai/gpt-5
duplicate openai/gpt-5
`))

	if len(models) != 2 {
		t.Fatalf("len(models) = %d, want 2: %#v", len(models), models)
	}
	if models[0].ID != "anthropic/claude-sonnet-4-5" || models[0].IsDefault {
		t.Fatalf("first model = %#v", models[0])
	}
	if models[1].ID != "openai/gpt-5" || models[1].IsDefault {
		t.Fatalf("second model = %#v", models[1])
	}
}

func TestParseVerboseOpenCodeModelsOutputUsesModelVariants(t *testing.T) {
	t.Parallel()

	models := parseOpenCodeModelsOutput([]byte(`opencode/big-pickle
{
  "name": "Big Pickle",
  "capabilities": {"input": {"image": false}},
  "variants": {}
}
opencode/deepseek-v4-flash-free
{
  "name": "DeepSeek V4 Flash Free",
  "capabilities": {"input": {"image": true}},
  "variants": {
    "max": {"reasoningEffort": "max"},
    "low": {"reasoningEffort": "low"},
    "high": {"reasoningEffort": "high"},
    "medium": {"reasoningEffort": "medium"}
  }
}
`))

	if len(models) != 2 {
		t.Fatalf("len(models) = %d, want 2: %#v", len(models), models)
	}
	if !models[0].ReasoningEffortsAdvertised || len(models[0].SupportedReasoningEfforts) != 0 {
		t.Fatalf("Big Pickle reasoning profile = %#v", models[0])
	}
	if models[0].SupportsImageInput == nil || *models[0].SupportsImageInput {
		t.Fatalf("Big Pickle image support = %#v", models[0].SupportsImageInput)
	}
	if models[0].DisplayName != "Big Pickle" ||
		models[1].DisplayName != "DeepSeek V4 Flash Free" {
		t.Fatalf("model display names = %#v, want built-in provider omitted", models)
	}
	wantEfforts := []string{"low", "medium", "high", "max"}
	for index, want := range wantEfforts {
		if models[1].SupportedReasoningEfforts[index].Value != want {
			t.Fatalf("DeepSeek reasoning efforts = %#v", models[1].SupportedReasoningEfforts)
		}
	}
	if models[1].SupportsImageInput == nil || !*models[1].SupportsImageInput {
		t.Fatalf("DeepSeek image support = %#v", models[1].SupportsImageInput)
	}
}

func TestParseVerboseOpenCodeModelsOutputFiltersSparkUnsupportedNoneEffort(t *testing.T) {
	t.Parallel()

	models := parseOpenCodeModelsOutput([]byte(`openai/gpt-5.3-codex-spark
{
  "name": "GPT-5.3 Codex Spark",
  "variants": {
    "none": {"reasoningEffort": "none"},
    "low": {"reasoningEffort": "low"},
    "medium": {"reasoningEffort": "medium"},
    "high": {"reasoningEffort": "high"},
    "xhigh": {"reasoningEffort": "xhigh"}
  }
}
`))
	if len(models) != 1 {
		t.Fatalf("models = %#v, want one Spark model", models)
	}
	if !models[0].ReasoningEffortsAdvertised {
		t.Fatalf("Spark reasoning profile = %#v, want advertised", models[0])
	}
	want := []string{"low", "medium", "high", "xhigh"}
	if len(models[0].SupportedReasoningEfforts) != len(want) {
		t.Fatalf("Spark reasoning efforts = %#v, want %#v", models[0].SupportedReasoningEfforts, want)
	}
	for index, value := range want {
		if got := models[0].SupportedReasoningEfforts[index].Value; got != value {
			t.Fatalf("Spark reasoning effort[%d] = %q, want %q", index, got, value)
		}
	}
}

func TestParseVerboseOpenCodeModelsOutputKeepsEveryProvider(t *testing.T) {
	t.Parallel()

	models := parseOpenCodeModelsOutput([]byte(`opencode/big-pickle
{"name":"Big Pickle","variants":{}}
opencode-minimax/MiniMax-M2.7
{"name":"MiniMax M2.7","variants":{}}
openai/gpt-5.6-pro
{"name":"GPT-5.6 Pro","variants":{}}
tutti/glm-5
{"name":"GLM-5","variants":{}}
`))

	want := []string{
		"openai/gpt-5.6-pro",
		"opencode-minimax/MiniMax-M2.7",
		"opencode/big-pickle",
		"tutti/glm-5",
	}
	if len(models) != len(want) {
		t.Fatalf("len(models) = %d, want %d: %#v", len(models), len(want), models)
	}
	for index, modelID := range want {
		if models[index].ID != modelID {
			t.Fatalf("models[%d].ID = %q, want %q", index, models[index].ID, modelID)
		}
	}
}

func TestParseVerboseOpenCodeModelsOutputDistinguishesSameModelAcrossProviders(t *testing.T) {
	t.Parallel()

	models := parseOpenCodeModelsOutput([]byte(`newapi/deepseek-v4-pro
{"name":"DeepSeek V4 Pro","providerID":"newapi","variants":{}}
opencode/deepseek-v4-pro
{"name":"DeepSeek V4 Pro","providerID":"opencode","variants":{}}
`))

	if len(models) != 2 {
		t.Fatalf("len(models) = %d, want 2: %#v", len(models), models)
	}
	if models[0].DisplayName != "DeepSeek V4 Pro / newapi" ||
		models[1].DisplayName != "DeepSeek V4 Pro" {
		t.Fatalf("model display names = %#v, want custom provider suffix only", models)
	}
}

func TestOpenCodeCLIModelListerUsesRequestedCwd(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is unix-only")
	}
	requestedCwd := t.TempDir()
	expectedCwd, err := filepath.EvalSymlinks(requestedCwd)
	if err != nil {
		t.Fatalf("resolve requested cwd: %v", err)
	}
	scriptPath := filepath.Join(t.TempDir(), "opencode")
	script := "#!/bin/sh\n" +
		"if [ \"$PWD\" != \"$EXPECTED_CWD\" ]; then\n" +
		"  echo unexpected cwd: \"$PWD\" >&2\n" +
		"  exit 2\n" +
		"fi\n" +
		"printf \"opencode/big-pickle\\n{\\\"name\\\":\\\"Big Pickle\\\",\\\"variants\\\":{}}\\n\"\n"
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake opencode: %v", err)
	}

	result, err := (OpenCodeCLIModelLister{
		Command: scriptPath,
		Cwd:     requestedCwd,
		Environ: func() []string {
			return []string{"EXPECTED_CWD=" + expectedCwd, "PATH=/usr/bin:/bin"}
		},
	}).ListModels(context.Background())
	if err != nil {
		t.Fatalf("ListModels() error = %v", err)
	}
	if len(result.Models) != 1 || result.Models[0].ID != "opencode/big-pickle" {
		t.Fatalf("models = %#v, want opencode/big-pickle", result.Models)
	}
}
