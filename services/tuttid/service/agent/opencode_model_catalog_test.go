package agent

import "testing"

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
