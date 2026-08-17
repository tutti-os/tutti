package agentruntime

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
	"time"
)

// TestRealGrokACPInitializeSmoke is deliberately opt-in. It never creates an
// ACP session and never sends a prompt, so running it cannot consume a paid
// model turn. The exact spawn-time permission argv is covered by the fake ACP
// transport tests; this smoke limits itself to executable/version discovery,
// initialize/model capability projection, and a clean process close.
func TestRealGrokACPInitializeSmoke(t *testing.T) {
	if os.Getenv("TUTTI_REAL_GROK_ACP_SMOKE") != "1" {
		t.Skip("set TUTTI_REAL_GROK_ACP_SMOKE=1 to run the local Grok initialize smoke")
	}

	binary := strings.TrimSpace(os.Getenv("TUTTI_GROK_BIN"))
	if binary == "" {
		var err error
		binary, err = exec.LookPath("grok")
		if err != nil {
			t.Fatalf("find grok executable: %v", err)
		}
	}
	versionCtx, cancelVersion := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelVersion()
	versionOutput, err := exec.CommandContext(versionCtx, binary, "--version").CombinedOutput()
	if err != nil {
		t.Fatalf("grok --version: %v: %s", err, strings.TrimSpace(string(versionOutput)))
	}
	if !regexp.MustCompile(`(?m)^grok [0-9]+\.[0-9]+\.[0-9]+(?:\s|$)`).Match(versionOutput) {
		t.Fatalf("unexpected grok version output: %q", strings.TrimSpace(string(versionOutput)))
	}

	for _, permissionMode := range []string{"default", "auto", "bypassPermissions"} {
		t.Run(permissionMode, func(t *testing.T) {
			adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
				Provider:    "acp:real-smoke",
				Name:        "real-acp-smoke",
				DisplayName: "Real Grok Smoke",
				Command:     []string{binary, "--no-auto-update", "--permission-mode", permissionMode, "agent", "stdio"},
			}, NewLocalProcessTransport(), LegacyHostMetadata())
			if err != nil {
				t.Fatalf("build smoke adapter: %v", err)
			}
			adapter := adapterRaw.(*standardACPAdapter)
			smokeCtx, cancelSmoke := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancelSmoke()
			session := standardTestSession("acp:real-smoke")
			session.CWD = t.TempDir()
			client, initializeResult, err := adapter.startInitializedClient(smokeCtx, session)
			if err != nil {
				t.Fatalf("grok ACP initialize: %v", err)
			}
			if err := client.Close(); err != nil {
				t.Fatalf("close grok ACP process: %v", err)
			}

			var initialized struct {
				Meta struct {
					ModelState struct {
						AvailableModels []struct {
							ModelID string `json:"modelId"`
						} `json:"availableModels"`
						CurrentModelID string `json:"currentModelId"`
					} `json:"modelState"`
				} `json:"_meta"`
			}
			if err := json.Unmarshal(initializeResult, &initialized); err != nil {
				t.Fatalf("decode initialize result: %v", err)
			}
			if len(initialized.Meta.ModelState.AvailableModels) == 0 || strings.TrimSpace(initialized.Meta.ModelState.CurrentModelID) == "" {
				t.Fatalf("initialize model state = %#v, want available and current model", initialized.Meta.ModelState)
			}
			foundCurrent := false
			for _, model := range initialized.Meta.ModelState.AvailableModels {
				if strings.TrimSpace(model.ModelID) == strings.TrimSpace(initialized.Meta.ModelState.CurrentModelID) {
					foundCurrent = true
					break
				}
			}
			if !foundCurrent {
				t.Fatalf("current model %q is not in initialize availableModels", initialized.Meta.ModelState.CurrentModelID)
			}
		})
	}
}
