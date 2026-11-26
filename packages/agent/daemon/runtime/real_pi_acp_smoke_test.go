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

// TestRealPiACPInitializeSmoke is deliberately opt-in. It verifies that an
// already installed pi-acp bridge completes the standard ACP initialize
// handshake without requiring a separate --version CLI flag, reports a SemVer
// agentInfo.version, and exits cleanly without creating a session or consuming
// a model turn.
func TestRealPiACPInitializeSmoke(t *testing.T) {
	if os.Getenv("TUTTI_REAL_PI_ACP_SMOKE") != "1" {
		t.Skip("set TUTTI_REAL_PI_ACP_SMOKE=1 to run the local pi-acp initialize smoke")
	}

	binary := strings.TrimSpace(os.Getenv("TUTTI_PI_ACP_BIN"))
	if binary == "" {
		var err error
		binary, err = exec.LookPath("pi-acp")
		if err != nil {
			t.Fatalf("find pi-acp executable: %v", err)
		}
	}

	version, err := ProbeStandardACPInitializeVersion(
		context.Background(),
		[]string{binary},
		nil,
		t.TempDir(),
		nil,
		15*time.Second,
		NewLocalProcessTransport(),
		LegacyHostMetadata(),
	)
	if err != nil {
		t.Fatalf("ProbeStandardACPInitializeVersion(pi-acp) error = %v", err)
	}
	if !regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`).MatchString(version) {
		t.Fatalf("pi-acp initialize agentInfo.version = %q, want SemVer", version)
	}

	adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:                "acp:pi",
		Name:                    "pi-acp-smoke",
		DisplayName:             "Pi Smoke",
		Command:                 []string{binary},
		ModelConfigOptionID:     "model",
		ReasoningConfigOptionID: "thought_level",
		RestrictConfigOptions:   true,
	}, NewLocalProcessTransport(), LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter(pi-acp): %v", err)
	}
	adapter := adapterRaw.(*standardACPAdapter)
	smokeCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	session := standardTestSession("acp:pi")
	session.CWD = t.TempDir()
	client, initializeResult, err := adapter.startInitializedClient(smokeCtx, session)
	if err != nil {
		t.Fatalf("pi-acp initialize: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Fatalf("close pi-acp process: %v", err)
	}

	var initialized struct {
		ProtocolVersion   int `json:"protocolVersion"`
		AgentCapabilities struct {
			LoadSession        bool `json:"loadSession"`
			PromptCapabilities struct {
				Image bool `json:"image"`
			} `json:"promptCapabilities"`
		} `json:"agentCapabilities"`
	}
	if err := json.Unmarshal(initializeResult, &initialized); err != nil {
		t.Fatalf("decode pi-acp initialize result: %v", err)
	}
	if initialized.ProtocolVersion < 1 || !initialized.AgentCapabilities.LoadSession {
		t.Fatalf("pi-acp initialize capabilities = %#v, want protocolVersion>=1 and loadSession=true", initialized)
	}
}
