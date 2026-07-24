package agentstatus

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

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

func TestOpenCodeConfigAPIKeyOverridesMissingAuthMarker(t *testing.T) {
	home := t.TempDir()
	binaryPath := filepath.Join(home, "bin", "opencode")
	if err := os.MkdirAll(filepath.Dir(binaryPath), 0o755); err != nil {
		t.Fatalf("mkdir binary dir: %v", err)
	}
	if err := os.WriteFile(binaryPath, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write OpenCode binary: %v", err)
	}
	configPath := filepath.Join(home, ".config", "opencode", "opencode.jsonc")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatalf("mkdir config dir: %v", err)
	}
	if err := os.WriteFile(configPath, []byte(`{
		"provider": {
			"openai": {
				"options": { "apiKey": "sk-test", },
			},
		},
	}`), 0o600); err != nil {
		t.Fatalf("write OpenCode config: %v", err)
	}

	service := Service{
		Environ: func() []string { return []string{"PATH=" + filepath.Dir(binaryPath)} },
		HomeDir: func() (string, error) { return home, nil },
		LookPath: func(name string) (string, error) {
			if name == "opencode" {
				return binaryPath, nil
			}
			return "", errors.New("not found")
		},
		IsExecutableFile: func(path string) bool { return path == binaryPath },
		RunAuthStatusCommand: func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
			return AuthInfo{Status: AuthRequired}, true
		},
	}
	status := service.statusForSpec(
		context.Background(),
		ProviderSpec{
			Kind:               providerregistry.StatusKindOpenCodeCLI,
			Provider:           providerregistry.OpenCodeProviderID,
			BinaryNames:        []string{"opencode"},
			AdapterBinaryNames: []string{"opencode"},
			AdapterCommand:     []string{"opencode", "acp"},
			LoginArgs:          []string{"auth", "login"},
		},
		time.Date(2026, 7, 24, 12, 0, 0, 0, time.UTC),
		statusDetectionOptions{skipAdapterProbe: true},
	)

	if status.Availability.Status != AvailabilityReady {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityReady)
	}
	if status.Auth.Status != AuthAuthenticated ||
		status.Auth.AuthMethod != "apiKey" ||
		status.Auth.AccountLabel != "API Usage Billing" {
		t.Fatalf("Auth = %#v, want configured API billing", status.Auth)
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
