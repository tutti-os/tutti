package api

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

// Exercise the real CLI parser, catalog, service, HTTP route and response codec.
// The executable is the only external double; no provider or credentials exist.
func TestComposerOpenCodeMiniMaxChoicesThroughHTTP(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is unix-only")
	}
	dir := t.TempDir()
	command := filepath.Join(dir, "opencode")
	fixture := `#!/bin/sh
[ "$1" = models ] && [ "$2" = --verbose ] || exit 2
printf '%s\n' 'opencode/minimax-m2.7' '{"name":"MiniMax M2.7","variants":{}}' 'opencode/minimax-m3' '{"name":"MiniMax M3","variants":{}}' 'opencode/minimax-m3.1-flash-free' '{"name":"MiniMax M3.1 Flash Free","capabilities":{"input":{"image":true}},"variants":{"high":{}}}' 'opencode-minimax/MiniMax-M2.7' '{"name":"Custom MiniMax","variants":{}}' 'openai/gpt-5' '{"name":"GPT-5","variants":{}}' 'opencode/speech-2.8-hd' '{"name":"Speech","variants":{}}'
`
	if err := os.WriteFile(command, []byte(fixture), 0o700); err != nil {
		t.Fatal(err)
	}
	catalog := &agentservice.CachedAgentModelCatalog{
		OpenCode: agentservice.OpenCodeCLIModelLister{
			Command: command,
			Args:    []string{"models", "--verbose"},
			Environ: func() []string { return []string{"PATH=/usr/bin:/bin", "HOME=" + dir} },
			HomeDir: func() (string, error) { return dir, nil },
		},
		AuthFingerprint: func(string) string { return "isolated-fixture" },
	}
	service := &agentservice.Service{ModelCatalog: catalog}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{AgentSessionService: service}))
	for _, selected := range []string{"", "opencode/minimax-m3", "opencode/minimax-m2.7", "custom/my-model", "openai/gpt-5"} {
		t.Run("selected="+selected, func(t *testing.T) {
			recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/agent-providers/opencode/composer-options", map[string]any{
				"section": "core", "settings": map[string]any{"model": selected},
			})
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d; body: %s", recorder.Code, recorder.Body.String())
			}
			var response tuttigenerated.AgentProviderComposerOptionsResponse
			decodeGeneratedRouteResponse(t, recorder, &response)
			wantModel := selected
			if wantModel == "" {
				wantModel = "openai/gpt-5"
			}
			if response.EffectiveSettings.Model == nil || *response.EffectiveSettings.Model != wantModel {
				t.Fatalf("effective model = %#v, want %q", response.EffectiveSettings.Model, wantModel)
			}
			var ids []string
			for _, option := range response.ModelConfig.Options {
				ids = append(ids, option.Value)
			}
			flash := slices.Index(ids, "opencode/minimax-m3.1-flash-free")
			m3 := slices.Index(ids, "opencode/minimax-m3")
			if flash < 0 || m3 != flash+1 {
				t.Fatalf("MiniMax order = %v", ids)
			}
			if slices.Contains(ids, "opencode/minimax-m2.7") != (selected == "opencode/minimax-m2.7") {
				t.Fatalf("legacy choice must be retained only when explicitly selected: %v", ids)
			}
			for _, preserved := range []string{"openai/gpt-5", "opencode-minimax/MiniMax-M2.7", "opencode/speech-2.8-hd"} {
				if !slices.Contains(ids, preserved) {
					t.Fatalf("missing preserved model %q: %v", preserved, ids)
				}
			}
			if selected == "custom/my-model" {
				index := slices.Index(ids, selected)
				if index < 0 || response.ModelConfig.Options[index].Requested == nil || !*response.ModelConfig.Options[index].Requested {
					t.Fatal("custom selection lost its requested provenance")
				}
			}
			if response.ModelConfig.Options[flash].SupportsImageInput == nil || !*response.ModelConfig.Options[flash].SupportsImageInput {
				t.Fatal("advertised Flash image capability lost in HTTP projection")
			}
		})
	}
}
