package agentstatus

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func TestOpenCodeAuthUsesXDGMarkerWithoutStartingCLI(t *testing.T) {
	dataHome := t.TempDir()
	authPath := filepath.Join(dataHome, "opencode", "auth.json")
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatalf("mkdir auth dir: %v", err)
	}
	if err := os.WriteFile(authPath, []byte(`{"openai":{"type":"oauth"}}`), 0o600); err != nil {
		t.Fatalf("write auth marker: %v", err)
	}
	service := Service{
		Environ: func() []string {
			return []string{"XDG_DATA_HOME=" + dataHome}
		},
		HomeDir: func() (string, error) {
			return t.TempDir(), nil
		},
	}
	auth := service.resolveAuth(context.Background(), ProviderSpec{
		Provider:             providerregistry.OpenCodeProviderID,
		AuthMarkerParserKind: providerregistry.AuthMarkerParserKindOpenCode,
		AuthStatusCommand:    []string{"auth", "list"},
		AuthMarkerPaths:      []string{"~/.local/share/opencode/auth.json"},
	}, true, "/definitely/not/an/opencode-binary")

	if auth.Status != AuthAuthenticated {
		t.Fatalf("Status = %q, want %q", auth.Status, AuthAuthenticated)
	}
}

func TestOpenCodeAuthMarkerEmptyObjectRequiresLogin(t *testing.T) {
	path := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(path, []byte(`{}`), 0o600); err != nil {
		t.Fatalf("write auth marker: %v", err)
	}
	auth, ok := parseOpenCodeAuthMarkerFile(path)
	if !ok || auth.Status != AuthRequired {
		t.Fatalf("parseOpenCodeAuthMarkerFile() = %#v, %v", auth, ok)
	}
}

func TestTuttiAuthUsesValidatedMarkerWithoutStartingCLI(t *testing.T) {
	home := t.TempDir()
	authPath := filepath.Join(home, ".tutti-agent", "auth.json")
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatalf("mkdir auth dir: %v", err)
	}
	if err := os.WriteFile(authPath, []byte(`{
		"tutti_llm":{
			"app_id":"app",
			"access_token":"access",
			"refresh_token":"refresh"
		}
	}`), 0o600); err != nil {
		t.Fatalf("write auth marker: %v", err)
	}
	service := Service{
		HomeDir: func() (string, error) {
			return home, nil
		},
	}
	auth := service.resolveAuth(context.Background(), ProviderSpec{
		Provider:             providerregistry.TuttiAgentProviderID,
		AuthMarkerParserKind: providerregistry.AuthMarkerParserKindTuttiToken,
		AuthStatusCommand:    []string{"login", "status"},
		AuthMarkerPaths:      []string{"~/.tutti-agent/auth.json"},
	}, true, "/definitely/not/a/tutti-agent-binary")

	if auth.Status != AuthAuthenticated || auth.AccountLabel != "app" {
		t.Fatalf("Auth = %#v, want authenticated app", auth)
	}
}
