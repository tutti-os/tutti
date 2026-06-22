package agentstatus

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	externalagentregistry "github.com/tutti-os/tutti/services/tuttid/service/externalagentregistry"
	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

func TestServiceListReportsInstallActionWhenCLIMissing(t *testing.T) {
	service := testService(func(_ string) (string, error) {
		return "", errors.New("not found")
	}, map[string]bool{})

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.Provider != "codex" {
		t.Fatalf("Provider = %q, want codex", status.Provider)
	}
	if status.Availability.Status != AvailabilityNotInstalled {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityNotInstalled)
	}
	if status.CLI.Installed {
		t.Fatal("CLI.Installed = true, want false")
	}
	if len(status.Actions) != 1 {
		t.Fatalf("Actions length = %d, want 1", len(status.Actions))
	}
	action := firstAction(t, status.Actions)
	if action.ID != ActionInstall {
		t.Fatalf("first action ID = %q, want %q", action.ID, ActionInstall)
	}
	if action.Kind != ActionKindDaemonAction {
		t.Fatalf("first action Kind = %q, want %q", action.Kind, ActionKindDaemonAction)
	}
	if action.Command != nil {
		t.Fatalf("install command = %#v, want nil for daemon-managed install", action.Command)
	}
}

func TestDefaultRegistryUsesOfficialCodexInstallerScript(t *testing.T) {
	specs, err := DefaultRegistry().Select([]string{"codex"})
	if err != nil {
		t.Fatalf("Select() error = %v", err)
	}
	if len(specs) != 1 {
		t.Fatalf("len(specs) = %d, want 1", len(specs))
	}
	install := specs[0].Install
	if install.Kind != InstallerKindOfficialScript {
		t.Fatalf("Install.Kind = %q, want %q", install.Kind, InstallerKindOfficialScript)
	}
	if install.DisplayCommand != "curl -fsSL https://chatgpt.com/codex/install.sh | sh" ||
		install.ScriptURL != "https://chatgpt.com/codex/install.sh" ||
		install.ScriptShell != "sh" {
		t.Fatalf("Install = %#v, want official Codex installer script", install)
	}
}

func TestServiceListReportsLoginAndRefreshActionsWhenAuthMarkerMissing(t *testing.T) {
	service := testService(func(name string) (string, error) {
		return "/usr/local/bin/" + name, nil
	}, map[string]bool{})

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityAuthRequired {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityAuthRequired)
	}
	if status.Auth.Status != AuthRequired {
		t.Fatalf("Auth.Status = %q, want %q", status.Auth.Status, AuthRequired)
	}
	if len(status.Actions) != 2 {
		t.Fatalf("Actions length = %d, want 2", len(status.Actions))
	}
	action := firstAction(t, status.Actions)
	if action.ID != ActionLogin {
		t.Fatalf("first action ID = %q, want %q", action.ID, ActionLogin)
	}
	if action.Command == nil || action.Command.Input != "/usr/local/bin/codex login\n" {
		t.Fatalf("login command = %#v", action.Command)
	}
	if status.Actions[1].ID != ActionRefresh || status.Actions[1].Kind != ActionKindRefresh {
		t.Fatalf("second action = %#v, want refresh", status.Actions[1])
	}
}

func TestServiceListReportsInstallActionWhenACPAdapterMissing(t *testing.T) {
	service := testService(func(name string) (string, error) {
		if name == "codex" {
			return "/usr/local/bin/codex", nil
		}
		return "", errors.New("not found")
	}, map[string]bool{"/home/test/.codex/auth.json": true})

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityNotInstalled {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityNotInstalled)
	}
	if status.Availability.ReasonCode != "acp_adapter_not_found" {
		t.Fatalf("ReasonCode = %q, want acp_adapter_not_found", status.Availability.ReasonCode)
	}
	if !status.CLI.Installed {
		t.Fatal("CLI.Installed = false, want true")
	}
	if status.Adapter.Installed {
		t.Fatal("Adapter.Installed = true, want false")
	}
	if len(status.Actions) != 1 {
		t.Fatalf("Actions length = %d, want 1", len(status.Actions))
	}
	action := firstAction(t, status.Actions)
	if action.ID != ActionInstall {
		t.Fatalf("first action ID = %q, want %q", action.ID, ActionInstall)
	}
	if action.Kind != ActionKindDaemonAction {
		t.Fatalf("first action Kind = %q, want %q", action.Kind, ActionKindDaemonAction)
	}
	if action.Command != nil {
		t.Fatalf("install command = %#v, want nil for daemon-managed install", action.Command)
	}
}

func TestServiceListReportsReadyWhenInstalledAndAuthenticated(t *testing.T) {
	service := testService(func(name string) (string, error) {
		return "/usr/local/bin/" + name, nil
	}, map[string]bool{"/home/test/.codex/auth.json": true})

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityReady {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityReady)
	}
	if status.Auth.Status != AuthAuthenticated {
		t.Fatalf("Auth.Status = %q, want %q", status.Auth.Status, AuthAuthenticated)
	}
	if !status.Adapter.Installed {
		t.Fatal("Adapter.Installed = false, want true")
	}
	if len(status.Actions) != 1 {
		t.Fatalf("Actions length = %d, want 1", len(status.Actions))
	}
	action := firstAction(t, status.Actions)
	if action.ID != ActionLogin {
		t.Fatalf("first action ID = %q, want %q", action.ID, ActionLogin)
	}
	if action.Command == nil || action.Command.Input != "/usr/local/bin/codex login\n" {
		t.Fatalf("login command = %#v", action.Command)
	}
}

func TestServiceListUsesCodexLoginStatusCommand(t *testing.T) {
	service := testService(func(name string) (string, error) {
		return "/usr/local/bin/" + name, nil
	}, map[string]bool{})
	service.RunAuthStatusCommand = func(_ context.Context, spec ProviderSpec, binaryPath string) (AuthInfo, bool) {
		if spec.Provider != "codex" {
			t.Fatalf("Provider = %q, want codex", spec.Provider)
		}
		if strings.Join(spec.AuthStatusCommand, " ") != "login status" {
			t.Fatalf("AuthStatusCommand = %v, want login status", spec.AuthStatusCommand)
		}
		if binaryPath != "/usr/local/bin/codex" {
			t.Fatalf("binaryPath = %q, want /usr/local/bin/codex", binaryPath)
		}
		return parseCodexAuthStatusOutput([]byte("Logged in using ChatGPT"))
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityReady {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityReady)
	}
	if status.Auth.Status != AuthAuthenticated {
		t.Fatalf("Auth.Status = %q, want %q", status.Auth.Status, AuthAuthenticated)
	}
}

func TestServiceListDoesNotUseCodexAuthMarkerAfterConfigError(t *testing.T) {
	service := testService(func(name string) (string, error) {
		return "/usr/local/bin/" + name, nil
	}, map[string]bool{"/home/test/.codex/auth.json": true})
	service.RunAuthStatusCommand = func(_ context.Context, spec ProviderSpec, _ string) (AuthInfo, bool) {
		if spec.Provider != "codex" {
			t.Fatalf("Provider = %q, want codex", spec.Provider)
		}
		return parseAuthStatusCommandOutput("codex", []byte("Error loading configuration: /home/test/.codex/config.toml:8:16: unknown variant `priority`, expected `fast` or `flex`"))
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityAuthRequired {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityAuthRequired)
	}
	if status.Availability.ReasonCode != "auth_unknown" {
		t.Fatalf("ReasonCode = %q, want auth_unknown", status.Availability.ReasonCode)
	}
	if status.Auth.Status != AuthUnknown {
		t.Fatalf("Auth.Status = %q, want %q", status.Auth.Status, AuthUnknown)
	}
}

func TestServiceListReportsInstallActionWhenCodexAdapterCommandFails(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	codexPath := filepath.Join(binDir, "codex")
	adapterPath := filepath.Join(binDir, "codex-acp")
	writeExecutable(t, codexPath, "#!/bin/sh\nexit 0\n")
	writeExecutable(t, adapterPath, "#!/bin/sh\necho 'codex-acp failed to start' >&2\nexit 127\n")

	service := Service{
		Environ: func() []string {
			return []string{"PATH=" + binDir}
		},
		FileExists: func(path string) bool {
			return path == filepath.Join(home, ".codex", "auth.json")
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
		LookPath: func(name string) (string, error) {
			switch name {
			case "codex":
				return codexPath, nil
			case "codex-acp":
				return adapterPath, nil
			default:
				return "", errors.New("not found")
			}
		},
		IsExecutableFile: isTestExecutableUnderHome(home),
		Now: func() time.Time {
			return time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
		},
		ProbeReadyAfter: 10 * time.Second,
		ProbeTimeout:    15 * time.Second,
		RunAuthStatusCommand: func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
			return AuthInfo{Status: AuthAuthenticated}, true
		},
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityNotInstalled {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityNotInstalled)
	}
	if status.Availability.ReasonCode != "acp_adapter_launch_failed" {
		t.Fatalf("ReasonCode = %q, want acp_adapter_launch_failed", status.Availability.ReasonCode)
	}
	if !status.CLI.Installed {
		t.Fatal("CLI.Installed = false, want true")
	}
	if status.Adapter.Installed {
		t.Fatal("Adapter.Installed = true, want false")
	}
	action := firstAction(t, status.Actions)
	if action.ID != ActionInstall || action.Kind != ActionKindDaemonAction {
		t.Fatalf("first action = %#v, want daemon install", action)
	}
}

func TestServiceListIgnoresStaleGlobalClaudeACPAdapter(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	claudePath := filepath.Join(binDir, "claude")
	adapterPath := filepath.Join(binDir, "claude-agent-acp")
	writeExecutable(t, claudePath, "#!/bin/sh\nexit 0\n")
	writeExecutable(t, adapterPath, "#!/bin/sh\nexit 0\n")
	writePackageManifest(t, binDir, "@agentclientprotocol/claude-agent-acp", "0.42.0")

	registryStore, _ := fakeClaudeExternalRegistry(t)
	runtimeRoot := fakeManagedRuntimeRoot(t)
	service := Service{
		Environ: func() []string {
			return []string{"PATH=/usr/bin:/bin"}
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
		LookPath: func(_ string) (string, error) {
			return "", errors.New("not found")
		},
		IsExecutableFile: isTestExecutableUnderHome(home),
		Now: func() time.Time {
			return time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
		},
		RunAuthStatusCommand: func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
			return AuthInfo{Status: AuthAuthenticated}, true
		},
		ExternalAgentRegistry: registryStore,
		ManagedRuntime:        fakeManagedRuntimeResolver(t, runtimeRoot),
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"claude-code"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityNotInstalled {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityNotInstalled)
	}
	if status.Availability.ReasonCode != "acp_adapter_not_found" {
		t.Fatalf("ReasonCode = %q, want acp_adapter_not_found", status.Availability.ReasonCode)
	}
	if status.Adapter.Installed {
		t.Fatal("Adapter.Installed = true, want false when registry-managed prefix is empty")
	}
	if status.Adapter.BinaryPath == adapterPath {
		t.Fatalf("Adapter.BinaryPath = %q, want global adapter path ignored", status.Adapter.BinaryPath)
	}
	if len(status.Adapter.Command) == 0 || status.Adapter.Command[0] != filepath.Join(runtimeRoot, "node", "bin", npmBinaryNameForTest()) {
		t.Fatalf("Adapter.Command = %#v, want managed npm command", status.Adapter.Command)
	}
	action := firstAction(t, status.Actions)
	if action.ID != ActionInstall || action.Kind != ActionKindDaemonAction {
		t.Fatalf("first action = %#v, want daemon install action", action)
	}
}

func TestServiceListReportsInstallActionWhenExternalAdapterCommandFails(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".local", "bin")
	claudePath := filepath.Join(binDir, "claude")
	writeExecutable(t, claudePath, "#!/bin/sh\nexit 0\n")

	registryStore, prefixDir := fakeClaudeExternalRegistry(t)
	runtimeRoot := fakeManagedRuntimeRoot(t)
	writeExecutable(
		t,
		filepath.Join(runtimeRoot, "node", "bin", npmBinaryNameForTest()),
		"#!/bin/sh\necho 'sh: claude-agent-acp: command not found' >&2\nexit 127\n",
	)
	packageDir := npmPackageInstallDir(prefixDir, "@agentclientprotocol/claude-agent-acp")
	writePackageManifest(t, packageDir, "@agentclientprotocol/claude-agent-acp", "0.46.0")

	service := Service{
		Environ: func() []string {
			return []string{"PATH=/usr/bin:/bin"}
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
		LookPath: func(name string) (string, error) {
			if name == "claude" {
				return claudePath, nil
			}
			return "", errors.New("not found")
		},
		IsExecutableFile: isTestExecutableUnderHome(home),
		Now: func() time.Time {
			return time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
		},
		RunAuthStatusCommand: func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
			return AuthInfo{Status: AuthAuthenticated}, true
		},
		ExternalAgentRegistry: registryStore,
		ManagedRuntime:        fakeManagedRuntimeResolver(t, runtimeRoot),
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"claude-code"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityNotInstalled {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityNotInstalled)
	}
	if status.Availability.ReasonCode != "acp_adapter_launch_failed" {
		t.Fatalf("ReasonCode = %q, want acp_adapter_launch_failed", status.Availability.ReasonCode)
	}
	if !status.CLI.Installed {
		t.Fatal("CLI.Installed = false, want true")
	}
	if status.Adapter.Installed {
		t.Fatal("Adapter.Installed = true, want false")
	}
	action := firstAction(t, status.Actions)
	if action.ID != ActionInstall || action.Kind != ActionKindDaemonAction {
		t.Fatalf("first action = %#v, want daemon install action", action)
	}
}

func TestServiceListReportsInstallActionWhenExternalAdapterCommandFailsAfterReadyWindow(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".local", "bin")
	claudePath := filepath.Join(binDir, "claude")
	writeExecutable(t, claudePath, "#!/bin/sh\nexit 0\n")

	registryStore, prefixDir := fakeClaudeExternalRegistry(t)
	runtimeRoot := fakeManagedRuntimeRoot(t)
	writeExecutable(
		t,
		filepath.Join(runtimeRoot, "node", "bin", npmBinaryNameForTest()),
		"#!/bin/sh\nsleep 0.2\necho 'sh: claude-agent-acp: command not found' >&2\nexit 127\n",
	)
	packageDir := npmPackageInstallDir(prefixDir, "@agentclientprotocol/claude-agent-acp")
	writePackageManifest(t, packageDir, "@agentclientprotocol/claude-agent-acp", "0.46.0")

	service := Service{
		Environ: func() []string {
			return []string{"PATH=/usr/bin:/bin"}
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
		LookPath: func(name string) (string, error) {
			if name == "claude" {
				return claudePath, nil
			}
			return "", errors.New("not found")
		},
		IsExecutableFile: isTestExecutableUnderHome(home),
		Now: func() time.Time {
			return time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
		},
		ProbeReadyAfter: 10 * time.Millisecond,
		ProbeTimeout:    2 * time.Second,
		RunAuthStatusCommand: func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
			return AuthInfo{Status: AuthAuthenticated}, true
		},
		ExternalAgentRegistry: registryStore,
		ManagedRuntime:        fakeManagedRuntimeResolver(t, runtimeRoot),
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"claude-code"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityNotInstalled {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityNotInstalled)
	}
	if status.Availability.ReasonCode != "acp_adapter_launch_failed" {
		t.Fatalf("ReasonCode = %q, want acp_adapter_launch_failed", status.Availability.ReasonCode)
	}
	action := firstAction(t, status.Actions)
	if action.ID != ActionInstall || action.Kind != ActionKindDaemonAction {
		t.Fatalf("first action = %#v, want daemon install action", action)
	}
}

func TestServiceListTreatsUnknownAuthAsAuthRequired(t *testing.T) {
	service := testService(func(name string) (string, error) {
		return "/usr/local/bin/" + name, nil
	}, map[string]bool{})
	service.Registry = Registry{Specs: []ProviderSpec{{
		Provider:           "codex",
		BinaryNames:        []string{"codex"},
		AdapterBinaryNames: []string{"codex-acp"},
		AdapterCommand:     []string{"codex-acp"},
		LoginArgs:          []string{"login"},
	}}}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.Auth.Status != AuthUnknown {
		t.Fatalf("Auth.Status = %q, want %q", status.Auth.Status, AuthUnknown)
	}
	if status.Availability.Status != AvailabilityAuthRequired {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityAuthRequired)
	}
	if status.Availability.ReasonCode != "auth_unknown" {
		t.Fatalf("ReasonCode = %q, want auth_unknown", status.Availability.ReasonCode)
	}
	if len(status.Actions) != 2 {
		t.Fatalf("Actions length = %d, want 2", len(status.Actions))
	}
	action := firstAction(t, status.Actions)
	if action.ID != ActionLogin {
		t.Fatalf("first action ID = %q, want %q", action.ID, ActionLogin)
	}
	if action.Command == nil || action.Command.Input != "/usr/local/bin/codex login\n" {
		t.Fatalf("login command = %#v", action.Command)
	}
	if status.Actions[1].ID != ActionRefresh || status.Actions[1].Kind != ActionKindRefresh {
		t.Fatalf("second action = %#v, want refresh", status.Actions[1])
	}
}

func TestServiceListTreatsTemporarilyUnsupportedProvidersAsUnsupported(t *testing.T) {
	service := testService(func(name string) (string, error) {
		return "/usr/local/bin/" + name, nil
	}, map[string]bool{
		"/home/test/.gemini/settings.json":      true,
		"/home/test/.nexight/auth.json":         true,
		"/home/test/.hermes/auth.json":          true,
		"/home/test/.config/openclaw/auth.json": true,
	})

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"gemini", "nexight", "hermes", "openclaw"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(snapshot.Providers) != 4 {
		t.Fatalf("len(providers) = %d, want 4", len(snapshot.Providers))
	}
	for _, status := range snapshot.Providers {
		if status.Availability.Status != AvailabilityUnsupported {
			t.Fatalf("%s Availability.Status = %q, want %q", status.Provider, status.Availability.Status, AvailabilityUnsupported)
		}
		if status.Availability.ReasonCode != DisabledReasonProviderTemporarilyUnsupported {
			t.Fatalf("%s ReasonCode = %q, want %s", status.Provider, status.Availability.ReasonCode, DisabledReasonProviderTemporarilyUnsupported)
		}
		if status.CLI.Installed || status.CLI.BinaryPath != "" {
			t.Fatalf("%s CLI = %#v, want not installed", status.Provider, status.CLI)
		}
		if status.Adapter.Installed || status.Adapter.BinaryPath != "" {
			t.Fatalf("%s Adapter = %#v, want not installed", status.Provider, status.Adapter)
		}
		if status.Auth.Status != AuthUnknown {
			t.Fatalf("%s Auth.Status = %q, want %q", status.Provider, status.Auth.Status, AuthUnknown)
		}
		if len(status.Actions) != 0 {
			t.Fatalf("%s Actions = %#v, want none", status.Provider, status.Actions)
		}
	}
}

func TestServiceListUsesRuntimeCommandResolverForKnownNodeGlobalBin(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	codexPath := filepath.Join(binDir, "codex")
	adapterPath := filepath.Join(binDir, "codex-acp")
	writeExecutable(t, codexPath, "#!/bin/sh\nexit 0\n")
	writeExecutable(t, adapterPath, "#!/bin/sh\nexit 0\n")

	service := Service{
		Environ: func() []string {
			return []string{"PATH=/usr/bin:/bin"}
		},
		FileExists: func(path string) bool {
			return path == filepath.Join(home, ".codex", "auth.json")
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
		LookPath: func(string) (string, error) {
			return "", errors.New("not found")
		},
		IsExecutableFile: isTestExecutableUnderHome(home),
		Now: func() time.Time {
			return time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
		},
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.CLI.BinaryPath != codexPath {
		t.Fatalf("CLI.BinaryPath = %q, want %q", status.CLI.BinaryPath, codexPath)
	}
	if status.Adapter.BinaryPath != adapterPath {
		t.Fatalf("Adapter.BinaryPath = %q, want %q", status.Adapter.BinaryPath, adapterPath)
	}
	if status.Availability.Status != AvailabilityReady {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityReady)
	}
}

func TestServiceProbeReportsReadyWhenAdapterStarts(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	writeExecutable(t, filepath.Join(binDir, "codex"), "#!/bin/sh\nexit 0\n")
	adapterPath := filepath.Join(binDir, "codex-acp")
	writeExecutable(t, adapterPath, "#!/bin/sh\nsleep 5\n")

	result, err := probeTestService(home).Probe(context.Background(), ProbeInput{Provider: "codex"})
	if err != nil {
		t.Fatalf("Probe() error = %v", err)
	}
	if result.Status != ProbeReady {
		t.Fatalf("Status = %q, want %q; result=%#v", result.Status, ProbeReady, result)
	}
	if result.BinaryPath != adapterPath {
		t.Fatalf("BinaryPath = %q, want %q", result.BinaryPath, adapterPath)
	}
}

func TestServiceProbeReportsFailureWhenAdapterCommandCannotStart(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	writeExecutable(t, filepath.Join(binDir, "codex"), "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(binDir, "codex-acp"), "#!/bin/sh\nexit 0\n")
	missingAdapterPath := filepath.Join(binDir, "missing-codex-acp")

	service := probeTestService(home)
	service.Registry = Registry{Specs: []ProviderSpec{{
		Provider:           "codex",
		BinaryNames:        []string{"codex"},
		AdapterBinaryNames: []string{"codex-acp"},
		AdapterCommand:     []string{missingAdapterPath},
		AuthMarkerPaths:    []string{"~/.codex/auth.json"},
		Install: InstallerSpec{
			Kind:           InstallerKindOfficialScript,
			DisplayCommand: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
			ScriptURL:      "https://chatgpt.com/codex/install.sh",
			ScriptShell:    "sh",
		},
		AdapterInstall: codexACPInstallerSpec(),
		LoginArgs:      []string{"login"},
	}}}

	result, err := service.Probe(context.Background(), ProbeInput{Provider: "codex"})
	if err != nil {
		t.Fatalf("Probe() error = %v", err)
	}
	if result.Status != ProbeFailed {
		t.Fatalf("Status = %q, want %q; result=%#v", result.Status, ProbeFailed, result)
	}
	if result.ReasonCode != "probe_start_failed" {
		t.Fatalf("ReasonCode = %q, want probe_start_failed", result.ReasonCode)
	}
	if result.Message == "" {
		t.Fatal("Message is empty, want start failure detail")
	}
}

func TestServiceProbeTreatsTemporarilyUnsupportedProviderAsUnsupported(t *testing.T) {
	service := testService(func(name string) (string, error) {
		return "/usr/local/bin/" + name, nil
	}, map[string]bool{"/home/test/.gemini/settings.json": true})

	result, err := service.Probe(context.Background(), ProbeInput{Provider: "gemini"})
	if err != nil {
		t.Fatalf("Probe() error = %v", err)
	}
	if result.Status != ProbeSkipped {
		t.Fatalf("Status = %q, want %q", result.Status, ProbeSkipped)
	}
	if result.ReasonCode != DisabledReasonProviderTemporarilyUnsupported || result.Message != "Provider is temporarily unsupported" {
		t.Fatalf("probe failure = %#v, want temporarily unsupported", result)
	}
	if result.BinaryPath != "" {
		t.Fatalf("BinaryPath = %q, want empty", result.BinaryPath)
	}
}

func TestServiceRunActionInstallsThenProbesProvider(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	adapterArchive, adapterSHA256 := releaseBinaryArchive(t, "codex-acp", "#!/bin/sh\nsleep 5\n")
	installerServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/install.sh":
			_, _ = writer.Write([]byte("#!/bin/sh\nexit 0\n"))
		case "/codex-acp.tar.gz":
			http.ServeFile(writer, request, adapterArchive)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer installerServer.Close()
	commands := []InstallCommandInput{}
	service := probeTestService(home)
	service.InstallCommand = func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		commands = append(commands, input)
		writeExecutable(t, filepath.Join(binDir, "codex"), "#!/bin/sh\nexit 0\n")
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}
	service.HTTPClient = installerServer.Client()
	service.Registry = Registry{Specs: []ProviderSpec{{
		Provider:           "codex",
		BinaryNames:        []string{"codex"},
		AdapterBinaryNames: []string{"codex-acp"},
		AdapterCommand:     []string{"codex-acp"},
		AuthMarkerPaths:    []string{"~/.codex/auth.json"},
		Install: InstallerSpec{
			Kind:           InstallerKindOfficialScript,
			DisplayCommand: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
			ScriptURL:      installerServer.URL + "/install.sh",
			ScriptShell:    "sh",
		},
		AdapterInstall: InstallerSpec{
			Kind:           InstallerKindGitHubReleaseBinary,
			DisplayCommand: "Install codex-acp test build",
			ReleaseBinary: &ReleaseBinaryInstallerSpec{
				BinaryName: "codex-acp",
				Version:    "test",
				Assets: map[string]ReleaseBinaryAsset{
					releaseBinaryPlatformKey(runtime.GOOS, runtime.GOARCH): {
						URL:    installerServer.URL + "/codex-acp.tar.gz",
						SHA256: adapterSHA256,
					},
				},
			},
		},
		LoginArgs: []string{"login"},
	}}}

	result, err := service.RunAction(context.Background(), RunActionInput{
		Provider: "codex",
		ActionID: ActionInstall,
	})
	if err != nil {
		t.Fatalf("RunAction() error = %v", err)
	}
	if result.Status != RunActionCompleted {
		t.Fatalf("Status = %q, want %q; result=%#v", result.Status, RunActionCompleted, result)
	}
	if result.Command != "curl -fsSL https://chatgpt.com/codex/install.sh | sh && Install codex-acp test build" {
		t.Fatalf("Command = %q, want sequential codex install summary", result.Command)
	}
	if len(commands) != 1 {
		t.Fatalf("len(commands) = %d, want 1", len(commands))
	}
	if commands[0].Env == nil {
		t.Fatal("installer Env is nil, want daemon runtime env")
	}
	if result.Probe == nil || result.Probe.Status != ProbeReady {
		t.Fatalf("Probe = %#v, want ready probe", result.Probe)
	}
	if _, err := os.Stat(filepath.Join(home, ".local", "bin", "codex-acp")); err != nil {
		t.Fatalf("installed adapter missing: %v", err)
	}
}

func TestServiceRunCodexCLILatestInstallerDownloadsLatestAssets(t *testing.T) {
	home := t.TempDir()
	installDir := filepath.Join(home, ".local", "bin")
	archivePath, archiveSHA256 := codexCLIPackageArchive(t)
	target, ok := codexCLIPackageTarget(runtime.GOOS, runtime.GOARCH)
	if !ok {
		t.Skipf("codex CLI package target unavailable for %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	archiveName := "codex-package-" + target + ".tar.gz"
	requestedPaths := []string{}
	installerServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requestedPaths = append(requestedPaths, request.URL.Path)
		switch request.URL.Path {
		case "/" + archiveName:
			http.ServeFile(writer, request, archivePath)
		case "/codex-package_SHA256SUMS":
			_, _ = writer.Write([]byte(archiveSHA256 + "  " + archiveName + "\n"))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer installerServer.Close()

	service := probeTestService(home)
	service.HTTPClient = installerServer.Client()
	result, err := service.runCodexCLILatestInstaller(context.Background(), InstallerSpec{
		Kind: InstallerKindCodexCLILatest,
		CodexCLI: &CodexCLILatestInstallerSpec{
			BaseURL: installerServer.URL,
		},
	}, installDir)
	if err != nil {
		t.Fatalf("runCodexCLILatestInstaller() error = %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("ExitCode = %d, want 0; stderr=%q", result.ExitCode, result.Stderr)
	}
	if result.Stdout == "" {
		t.Fatal("Stdout is empty, want install summary")
	}
	for _, path := range requestedPaths {
		if strings.Contains(path, "api.github.com") || strings.Contains(path, "/api/") {
			t.Fatalf("requested path %q, want latest/download asset paths only", path)
		}
	}
	if !slices.Equal(requestedPaths, []string{"/" + archiveName, "/codex-package_SHA256SUMS"}) {
		t.Fatalf("requestedPaths = %#v, want archive then checksum", requestedPaths)
	}
	if _, err := os.Stat(filepath.Join(home, ".codex", "packages", "standalone", "current", "bin", "codex")); err != nil {
		t.Fatalf("current codex missing: %v", err)
	}
	visiblePath := filepath.Join(installDir, "codex")
	if !service.executableFile(visiblePath) {
		t.Fatalf("visible codex path %s is not executable", visiblePath)
	}
	output, err := exec.Command(visiblePath, "--version").CombinedOutput()
	if err != nil {
		t.Fatalf("run installed codex: %v; output=%s", err, output)
	}
	if strings.TrimSpace(string(output)) != "codex 1.2.3" {
		t.Fatalf("codex --version = %q, want codex 1.2.3", strings.TrimSpace(string(output)))
	}
}

func TestServiceRunActionReportsInstallCommandFailures(t *testing.T) {
	home := t.TempDir()
	service := probeTestService(home)
	service.Registry = Registry{Specs: []ProviderSpec{{
		Provider:    "codex",
		BinaryNames: []string{"codex"},
		Install: InstallerSpec{
			Kind:           InstallerKindShellCommand,
			DisplayCommand: "install codex test",
			ShellCommand:   "install codex test",
		},
		LoginArgs: []string{"login"},
	}}}
	service.InstallCommand = func(context.Context, InstallCommandInput) (InstallCommandResult, error) {
		return InstallCommandResult{
			ExitCode: 42,
			Stderr:   "package not found",
		}, nil
	}

	result, err := service.RunAction(context.Background(), RunActionInput{
		Provider: "codex",
		ActionID: ActionInstall,
	})
	if err != nil {
		t.Fatalf("RunAction() error = %v", err)
	}
	if result.Status != RunActionFailed {
		t.Fatalf("Status = %q, want %q", result.Status, RunActionFailed)
	}
	if result.ReasonCode != "install_command_failed" {
		t.Fatalf("ReasonCode = %q, want install_command_failed", result.ReasonCode)
	}
	if result.Message != "package not found" {
		t.Fatalf("Message = %q, want package not found", result.Message)
	}
	if result.ExitCode == nil || *result.ExitCode != 42 {
		t.Fatalf("ExitCode = %#v, want 42", result.ExitCode)
	}
	if result.Probe != nil {
		t.Fatalf("Probe = %#v, want nil when install command fails", result.Probe)
	}
}

func TestServiceRunActionReportsInstallTimeouts(t *testing.T) {
	home := t.TempDir()
	service := probeTestService(home)
	service.InstallTimeout = 10 * time.Millisecond
	service.Registry = Registry{Specs: []ProviderSpec{{
		Provider:    "codex",
		BinaryNames: []string{"codex"},
		Install: InstallerSpec{
			Kind:           InstallerKindShellCommand,
			DisplayCommand: "install codex test",
			ShellCommand:   "install codex test",
		},
		LoginArgs: []string{"login"},
	}}}
	service.InstallCommand = func(ctx context.Context, _ InstallCommandInput) (InstallCommandResult, error) {
		<-ctx.Done()
		return InstallCommandResult{
			ExitCode: 1,
			Stderr:   "still fetching dependencies",
		}, ctx.Err()
	}

	result, err := service.RunAction(context.Background(), RunActionInput{
		Provider: "codex",
		ActionID: ActionInstall,
	})
	if err != nil {
		t.Fatalf("RunAction() error = %v", err)
	}
	if result.Status != RunActionFailed {
		t.Fatalf("Status = %q, want %q", result.Status, RunActionFailed)
	}
	if result.ReasonCode != "install_timed_out" {
		t.Fatalf("ReasonCode = %q, want install_timed_out", result.ReasonCode)
	}
	if result.Message != "Install command timed out after 10ms" {
		t.Fatalf("Message = %q, want timeout detail", result.Message)
	}
	if result.Stderr != "still fetching dependencies" {
		t.Fatalf("Stderr = %q, want captured installer output", result.Stderr)
	}
	if result.Probe != nil {
		t.Fatalf("Probe = %#v, want nil when install command times out", result.Probe)
	}
}

func TestServiceRunActionUpgradesStaleClaudeACPAdapter(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	writeExecutable(t, filepath.Join(binDir, "claude"), "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(binDir, "claude-agent-acp"), "#!/bin/sh\nsleep 5\n")
	writePackageManifest(t, binDir, "@agentclientprotocol/claude-agent-acp", "0.42.0")

	registryStore, prefixDir := fakeClaudeExternalRegistry(t)
	runtimeRoot := fakeManagedRuntimeRoot(t)
	packageDir := npmPackageInstallDir(prefixDir, "@agentclientprotocol/claude-agent-acp")
	commands := []string{}
	service := probeTestService(home)
	service.ExternalAgentRegistry = registryStore
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	service.InstallCommand = func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		commands = append(commands, input.Command)
		if strings.Contains(input.Command, "@agentclientprotocol/claude-agent-acp") {
			if err := os.MkdirAll(packageDir, 0o755); err != nil {
				t.Fatalf("mkdir package dir: %v", err)
			}
			writePackageManifest(t, packageDir, "@agentclientprotocol/claude-agent-acp", "0.46.0")
		}
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}

	result, err := service.RunAction(context.Background(), RunActionInput{
		Provider: "claude-code",
		ActionID: ActionInstall,
	})
	if err != nil {
		t.Fatalf("RunAction() error = %v", err)
	}
	if result.Status != RunActionCompleted {
		t.Fatalf("Status = %q, want %q; result=%#v", result.Status, RunActionCompleted, result)
	}
	if len(commands) == 0 ||
		!strings.Contains(commands[0], filepath.Join(runtimeRoot, "node", "bin", npmBinaryNameForTest())) ||
		!strings.Contains(commands[0], "--prefix") ||
		!strings.Contains(commands[0], prefixDir) ||
		!strings.Contains(commands[0], "install") ||
		!strings.Contains(commands[0], "@agentclientprotocol/claude-agent-acp") {
		t.Fatalf("commands = %#v, want managed npm prefix install", commands)
	}
	if len(commands) < 2 ||
		!strings.Contains(commands[1], filepath.Join(runtimeRoot, "node", "bin", nodeBinaryNameForTest())) ||
		!strings.Contains(commands[1], "--dist") ||
		!strings.Contains(commands[1], filepath.Join(packageDir, "dist", "acp-agent.js")) {
		t.Fatalf("commands = %#v, want managed node patch against registry package dir", commands)
	}
	if result.Probe == nil || result.Probe.Status != ProbeReady {
		t.Fatalf("Probe = %#v, want ready probe after upgrade", result.Probe)
	}
}

func TestServiceRunActionSerializesConcurrentExternalRegistryNPMInstalls(t *testing.T) {
	t.Setenv("TUTTI_STATE_DIR", t.TempDir())

	home := t.TempDir()
	binDir := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	writeExecutable(t, filepath.Join(binDir, "claude"), "#!/bin/sh\nexit 0\n")

	registryStore, prefixDir := fakeClaudeExternalRegistry(t)
	runtimeRoot := fakeManagedRuntimeRoot(t)
	packageDir := npmPackageInstallDir(prefixDir, "@agentclientprotocol/claude-agent-acp")
	service := probeTestService(home)
	service.ExternalAgentRegistry = registryStore
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}

	firstInstallStarted := make(chan struct{})
	releaseFirstInstall := make(chan struct{})
	var npmInstallCalls atomic.Int32
	var activeNPMInstalls atomic.Int32
	var sawConcurrentInstall atomic.Bool
	service.InstallCommand = func(ctx context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		isClaudeACPInstall := strings.Contains(input.Command, " install ") &&
			strings.Contains(input.Command, "@agentclientprotocol/claude-agent-acp")
		if !isClaudeACPInstall {
			return InstallCommandResult{ExitCode: 0, Stdout: "patched"}, nil
		}

		if active := activeNPMInstalls.Add(1); active != 1 {
			activeNPMInstalls.Add(-1)
			sawConcurrentInstall.Store(true)
			return InstallCommandResult{ExitCode: 90, Stderr: "concurrent npm install"}, nil
		}
		defer activeNPMInstalls.Add(-1)

		callIndex := npmInstallCalls.Add(1)
		if callIndex == 1 {
			close(firstInstallStarted)
			select {
			case <-releaseFirstInstall:
			case <-ctx.Done():
				return InstallCommandResult{ExitCode: 1, Stderr: ctx.Err().Error()}, ctx.Err()
			}
		}

		writePackageManifest(t, packageDir, "@agentclientprotocol/claude-agent-acp", "0.46.0")
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}

	type runResult struct {
		result RunActionResult
		err    error
	}
	firstDone := make(chan runResult, 1)
	go func() {
		result, err := service.RunAction(context.Background(), RunActionInput{
			Provider: "claude-code",
			ActionID: ActionInstall,
		})
		firstDone <- runResult{result: result, err: err}
	}()

	<-firstInstallStarted
	secondDone := make(chan runResult, 1)
	go func() {
		result, err := service.RunAction(context.Background(), RunActionInput{
			Provider: "claude-code",
			ActionID: ActionInstall,
		})
		secondDone <- runResult{result: result, err: err}
	}()

	time.Sleep(50 * time.Millisecond)
	if got := npmInstallCalls.Load(); got != 1 {
		t.Fatalf("npm install calls before releasing first install = %d, want 1", got)
	}
	close(releaseFirstInstall)

	first := <-firstDone
	if first.err != nil {
		t.Fatalf("first RunAction() error = %v", first.err)
	}
	if first.result.Status != RunActionCompleted {
		t.Fatalf("first status = %q, want %q; result=%#v", first.result.Status, RunActionCompleted, first.result)
	}
	second := <-secondDone
	if second.err != nil {
		t.Fatalf("second RunAction() error = %v", second.err)
	}
	if second.result.Status != RunActionCompleted {
		t.Fatalf("second status = %q, want %q; result=%#v", second.result.Status, RunActionCompleted, second.result)
	}
	if got := npmInstallCalls.Load(); got != 2 {
		t.Fatalf("npm install calls = %d, want serialized duplicate installs", got)
	}
	if sawConcurrentInstall.Load() {
		t.Fatal("external registry npm installs overlapped")
	}
}

func TestServiceResolveProviderCommandCreatesExternalRegistryNPMPrefix(t *testing.T) {
	home := t.TempDir()
	registryStore, prefixDir := fakeClaudeExternalRegistry(t)
	runtimeRoot := fakeManagedRuntimeRoot(t)
	service := probeTestService(home)
	service.ExternalAgentRegistry = registryStore
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)

	if _, err := os.Stat(prefixDir); !os.IsNotExist(err) {
		t.Fatalf("prefix dir exists before resolve: err=%v", err)
	}

	result, err := service.ResolveProviderCommand(context.Background(), "claude-code")
	if err != nil {
		t.Fatalf("ResolveProviderCommand() error = %v", err)
	}
	if _, err := os.Stat(prefixDir); err != nil {
		t.Fatalf("prefix dir was not created before npm exec: %v", err)
	}
	if len(result.Command) == 0 ||
		!slices.Contains(result.Command, "--prefix") ||
		!slices.Contains(result.Command, prefixDir) ||
		!slices.Contains(result.Command, "exec") {
		t.Fatalf("Command = %#v, want managed npm exec with prefix", result.Command)
	}
}

func TestServiceResolveProviderCommandUsesInstalledExternalRegistryNPMBin(t *testing.T) {
	home := t.TempDir()
	registryStore, prefixDir := fakeClaudeExternalRegistry(t)
	runtimeRoot := fakeManagedRuntimeRoot(t)
	packageDir := npmPackageInstallDir(prefixDir, "@agentclientprotocol/claude-agent-acp")
	binPath := filepath.Join(prefixDir, "node_modules", ".bin", "claude-agent-acp")
	writePackageManifestWithBin(
		t,
		packageDir,
		"@agentclientprotocol/claude-agent-acp",
		"0.46.0",
		"claude-agent-acp",
		"dist/index.js",
	)
	writeExecutable(t, binPath, "#!/bin/sh\nexit 0\n")

	service := probeTestService(home)
	service.ExternalAgentRegistry = registryStore
	service.IsExecutableFile = func(path string) bool {
		stat, err := os.Stat(path)
		return err == nil && !stat.IsDir() && stat.Mode().Perm()&0111 != 0
	}
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)

	result, err := service.ResolveProviderCommand(context.Background(), "claude-code")
	if err != nil {
		t.Fatalf("ResolveProviderCommand() error = %v", err)
	}
	if len(result.Command) == 0 || result.Command[0] != binPath {
		t.Fatalf("Command = %#v, want installed npm bin %q", result.Command, binPath)
	}
	if slices.Contains(result.Command, "exec") {
		t.Fatalf("Command = %#v, want installed bin without npm exec", result.Command)
	}
}

func TestServiceRunActionDoesNotInstallTemporarilyUnsupportedProvider(t *testing.T) {
	service := testService(func(name string) (string, error) {
		return "/usr/local/bin/" + name, nil
	}, map[string]bool{"/home/test/.gemini/settings.json": true})
	installCalled := false
	service.InstallCommand = func(context.Context, InstallCommandInput) (InstallCommandResult, error) {
		installCalled = true
		return InstallCommandResult{ExitCode: 0}, nil
	}

	result, err := service.RunAction(context.Background(), RunActionInput{
		Provider: "gemini",
		ActionID: ActionInstall,
	})
	if err != nil {
		t.Fatalf("RunAction() error = %v", err)
	}
	if installCalled {
		t.Fatal("InstallCommand was called, want unsupported provider to short-circuit")
	}
	if result.Status != RunActionFailed {
		t.Fatalf("Status = %q, want %q", result.Status, RunActionFailed)
	}
	if result.ReasonCode != DisabledReasonProviderTemporarilyUnsupported || result.Message != "Provider is temporarily unsupported" {
		t.Fatalf("result = %#v, want temporarily unsupported", result)
	}
	if result.Probe == nil || result.Probe.ReasonCode != DisabledReasonProviderTemporarilyUnsupported {
		t.Fatalf("Probe = %#v, want temporarily unsupported probe", result.Probe)
	}
}

func TestInstallCommandLockSerializesConcurrentNPMGlobalInstalls(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "run", "locks", "npm-global-install.lock")
	lock := installCommandLock{
		command:      "npm install -g @openai/codex",
		lockPath:     lockPath,
		now:          time.Now,
		pollInterval: 10 * time.Millisecond,
	}
	releaseFirst, err := lock.Acquire(context.Background())
	if err != nil {
		t.Fatalf("Acquire() first error = %v", err)
	}
	defer releaseFirst()

	secondAcquired := make(chan struct{})
	secondReleased := make(chan struct{})
	go func() {
		releaseSecond, acquireErr := lock.Acquire(context.Background())
		if acquireErr != nil {
			t.Errorf("Acquire() second error = %v", acquireErr)
			close(secondAcquired)
			close(secondReleased)
			return
		}
		close(secondAcquired)
		releaseSecond()
		close(secondReleased)
	}()

	select {
	case <-secondAcquired:
		t.Fatal("second install lock acquired before first release")
	case <-time.After(50 * time.Millisecond):
	}

	releaseFirst()

	select {
	case <-secondAcquired:
	case <-time.After(time.Second):
		t.Fatal("second install lock did not acquire after first release")
	}
	select {
	case <-secondReleased:
	case <-time.After(time.Second):
		t.Fatal("second install lock did not release")
	}
}

func TestInstallCommandLockSerializesConcurrentExternalRegistryNPMInstalls(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "run", "locks", "agent-provider-install.lock")
	lock := installCommandLock{
		command:      "external_agent_registry_npm:claude-acp:@agentclientprotocol/claude-agent-acp@0.46.0:/tmp/claude-acp",
		lockPath:     lockPath,
		now:          time.Now,
		pollInterval: 10 * time.Millisecond,
	}
	releaseFirst, err := lock.Acquire(context.Background())
	if err != nil {
		t.Fatalf("Acquire() first error = %v", err)
	}
	defer releaseFirst()

	secondAcquired := make(chan struct{})
	secondReleased := make(chan struct{})
	go func() {
		releaseSecond, acquireErr := lock.Acquire(context.Background())
		if acquireErr != nil {
			t.Errorf("Acquire() second error = %v", acquireErr)
			close(secondAcquired)
			close(secondReleased)
			return
		}
		close(secondAcquired)
		releaseSecond()
		close(secondReleased)
	}()

	select {
	case <-secondAcquired:
		t.Fatal("second install lock acquired before first release")
	case <-time.After(50 * time.Millisecond):
	}

	releaseFirst()

	select {
	case <-secondAcquired:
	case <-time.After(time.Second):
		t.Fatal("second install lock did not acquire after first release")
	}
	select {
	case <-secondReleased:
	case <-time.After(time.Second):
		t.Fatal("second install lock did not release")
	}
}

func TestInstallCommandLockSkipsNonNPMCommands(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "run", "locks", "npm-global-install.lock")
	var called atomic.Bool
	lock := installCommandLock{
		command:  "codex login",
		lockPath: lockPath,
		now: func() time.Time {
			called.Store(true)
			return time.Now()
		},
	}

	releaseLock, err := lock.Acquire(context.Background())
	if err != nil {
		t.Fatalf("Acquire() error = %v", err)
	}
	releaseLock()

	if called.Load() {
		t.Fatal("Acquire() evaluated lock timing for non-npm command")
	}
	if _, err := os.Stat(lockPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("lock file exists for non-npm command, err = %v", err)
	}
}

func TestInstallCommandLockUsesPackageSpecificPathForExternalRegistryNPM(t *testing.T) {
	first := installCommandLockPath("external_agent_registry_npm:claude-acp:@agentclientprotocol/claude-agent-acp@0.46.0:/tmp/claude-acp")
	second := installCommandLockPath("external_agent_registry_npm:other-agent:other-package@1.0.0:/tmp/other-agent")
	if filepath.Base(first) == "npm-global-install.lock" {
		t.Fatalf("external registry npm lock path = %q, want package-specific lock", first)
	}
	if filepath.Base(first) == filepath.Base(second) {
		t.Fatalf("lock paths = %q and %q, want distinct package-specific locks", first, second)
	}
}

func TestInstallCommandLockRecoverRemovesLockWhenPIDIsDead(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "run", "locks", "npm-global-install.lock")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(lockPath, []byte("pid=999999999\ncommand=npm install -g @openai/codex\n"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	result, err := (installCommandLock{
		lockPath: lockPath,
		processExists: func(_ int) bool {
			return false
		},
	}).Recover()
	if err != nil {
		t.Fatalf("Recover() error = %v", err)
	}
	if !result.Removed {
		t.Fatalf("Removed = false, want true; result=%#v", result)
	}
	if result.PID != 999999999 {
		t.Fatalf("PID = %d, want 999999999", result.PID)
	}
	if result.Reason != "dead_pid" {
		t.Fatalf("Reason = %q, want dead_pid", result.Reason)
	}
	if _, err := os.Stat(lockPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("lock file exists after recovery, err = %v", err)
	}
}

func TestInstallCommandLockRecoverKeepsLockWhenPIDIsLive(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "run", "locks", "npm-global-install.lock")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(lockPath, []byte("pid=123\ncommand=npm install -g @openai/codex\n"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	result, err := (installCommandLock{
		lockPath: lockPath,
		processExists: func(_ int) bool {
			return true
		},
	}).Recover()
	if err != nil {
		t.Fatalf("Recover() error = %v", err)
	}
	if result.Removed {
		t.Fatalf("Removed = true, want false; result=%#v", result)
	}
	if result.PID != 123 {
		t.Fatalf("PID = %d, want 123", result.PID)
	}
	if result.Reason != "" {
		t.Fatalf("Reason = %q, want empty", result.Reason)
	}
	if _, err := os.Stat(lockPath); err != nil {
		t.Fatalf("lock file missing after recovery, err = %v", err)
	}
}

func TestInstallCommandLockRecoverRemovesInvalidPIDMetadataAfterRetry(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "run", "locks", "npm-global-install.lock")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(lockPath, []byte("created_at=2026-06-09T10:00:00Z\n"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	result, err := (installCommandLock{
		lockPath:   lockPath,
		sleep:      func(time.Duration) {},
		retryDelay: time.Millisecond,
	}).Recover()
	if err != nil {
		t.Fatalf("Recover() error = %v", err)
	}
	if !result.Removed {
		t.Fatalf("Removed = false, want true; result=%#v", result)
	}
	if result.Reason != "invalid_metadata" {
		t.Fatalf("Reason = %q, want invalid_metadata", result.Reason)
	}
	if _, err := os.Stat(lockPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("lock file exists after invalid metadata recovery, err = %v", err)
	}
}

func TestInstallCommandLockRecoverRetriesMalformedMetadataBeforeRemoving(t *testing.T) {
	readCount := 0
	result, err := (installCommandLock{
		lockPath: "/tmp/npm-global-install.lock",
		readFile: func(string) ([]byte, error) {
			readCount++
			if readCount == 1 {
				return []byte("created_at=2026-06-09T10:00:00Z\n"), nil
			}
			return []byte("pid=42\ncommand=npm install -g @openai/codex\n"), nil
		},
		processExists: func(pid int) bool {
			return pid == 42
		},
		removeFile: func(string) error {
			t.Fatal("removeFile() called, want retry to preserve valid lock")
			return nil
		},
		sleep:      func(time.Duration) {},
		retryDelay: time.Millisecond,
	}).Recover()
	if err != nil {
		t.Fatalf("Recover() error = %v", err)
	}
	if readCount != 2 {
		t.Fatalf("readCount = %d, want 2", readCount)
	}
	if result.Removed {
		t.Fatalf("Removed = true, want false; result=%#v", result)
	}
	if result.PID != 42 {
		t.Fatalf("PID = %d, want 42", result.PID)
	}
}

func TestServiceRunActionStartsInstallTimeoutAfterLockAcquisition(t *testing.T) {
	const (
		installTimeout        = 2 * time.Second
		firstInstallHold      = 800 * time.Millisecond
		secondInstallDuration = 1400 * time.Millisecond
	)

	home := t.TempDir()
	binDir := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	service := probeTestService(home)
	service.InstallTimeout = installTimeout
	service.Registry = Registry{Specs: []ProviderSpec{{
		Provider:           "codex",
		BinaryNames:        []string{"codex"},
		AdapterBinaryNames: []string{"codex-acp"},
		AdapterCommand:     []string{"codex-acp"},
		AuthMarkerPaths:    []string{"~/.codex/auth.json"},
		Install: InstallerSpec{
			Kind:           InstallerKindShellCommand,
			DisplayCommand: "npm install -g @openai/codex",
			ShellCommand:   "npm install -g @openai/codex",
		},
		LoginArgs: []string{"login"},
	}}}

	var installCallCount atomic.Int32
	firstInstallStarted := make(chan struct{})
	releaseFirstInstall := make(chan struct{})
	var startMu sync.Mutex
	startedAt := make([]time.Time, 0, 2)
	service.InstallCommand = func(ctx context.Context, _ InstallCommandInput) (InstallCommandResult, error) {
		callIndex := installCallCount.Add(1)
		startMu.Lock()
		startedAt = append(startedAt, time.Now())
		startMu.Unlock()
		if callIndex == 1 {
			close(firstInstallStarted)
			select {
			case <-releaseFirstInstall:
			case <-ctx.Done():
				return InstallCommandResult{ExitCode: 1, Stderr: ctx.Err().Error()}, ctx.Err()
			}
		} else {
			time.Sleep(secondInstallDuration)
		}
		writeExecutable(t, filepath.Join(binDir, "codex"), "#!/bin/sh\nexit 0\n")
		writeExecutable(t, filepath.Join(binDir, "codex-acp"), "#!/bin/sh\nsleep 5\n")
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}

	type runResult struct {
		result RunActionResult
		err    error
	}
	firstDone := make(chan runResult, 1)
	go func() {
		result, err := service.RunAction(context.Background(), RunActionInput{
			Provider: "codex",
			ActionID: ActionInstall,
		})
		firstDone <- runResult{result: result, err: err}
	}()

	<-firstInstallStarted
	secondDone := make(chan runResult, 1)
	secondStartedAt := time.Now()
	go func() {
		result, err := service.RunAction(context.Background(), RunActionInput{
			Provider: "codex",
			ActionID: ActionInstall,
		})
		secondDone <- runResult{result: result, err: err}
	}()

	time.Sleep(firstInstallHold)
	close(releaseFirstInstall)

	first := <-firstDone
	if first.err != nil {
		t.Fatalf("first RunAction() error = %v", first.err)
	}
	if first.result.Status != RunActionCompleted {
		t.Fatalf("first status = %q, want %q; result=%#v", first.result.Status, RunActionCompleted, first.result)
	}

	second := <-secondDone
	if second.err != nil {
		t.Fatalf("second RunAction() error = %v", second.err)
	}
	if second.result.Status != RunActionCompleted {
		t.Fatalf("second status = %q, want %q; result=%#v", second.result.Status, RunActionCompleted, second.result)
	}
	if got := installCallCount.Load(); got != 2 {
		t.Fatalf("install call count = %d, want 2", got)
	}

	startMu.Lock()
	defer startMu.Unlock()
	if len(startedAt) != 2 {
		t.Fatalf("len(startedAt) = %d, want 2", len(startedAt))
	}
	if wait := startedAt[1].Sub(secondStartedAt); wait < firstInstallHold-100*time.Millisecond {
		t.Fatalf("second install started too early after %v, want it to wait for the lock", wait)
	}
}

func TestServiceListReportsAuthRequiredFromClaudeAuthStatusCommand(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	claudePath := filepath.Join(binDir, "claude")
	writeExecutable(t, claudePath, "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(binDir, "claude-agent-acp"), "#!/bin/sh\nexit 0\n")
	writePackageManifest(t, binDir, "@agentclientprotocol/claude-agent-acp", "0.46.0")
	registryStore, prefixDir := fakeClaudeExternalRegistry(t)
	runtimeRoot := fakeManagedRuntimeRoot(t)
	packageDir := npmPackageInstallDir(prefixDir, "@agentclientprotocol/claude-agent-acp")
	if err := os.MkdirAll(packageDir, 0o755); err != nil {
		t.Fatalf("mkdir package dir: %v", err)
	}
	writePackageManifest(t, packageDir, "@agentclientprotocol/claude-agent-acp", "0.46.0")

	service := Service{
		Environ: func() []string {
			return []string{"PATH=/usr/bin:/bin"}
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
		LookPath: func(_ string) (string, error) {
			return "", errors.New("not found")
		},
		Now: func() time.Time {
			return time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
		},
		RunAuthStatusCommand: func(_ context.Context, spec ProviderSpec, binaryPath string) (AuthInfo, bool) {
			if spec.Provider != "claude-code" {
				t.Fatalf("auth status provider = %q, want claude-code", spec.Provider)
			}
			if binaryPath != claudePath {
				t.Fatalf("auth status binaryPath = %q, want %q", binaryPath, claudePath)
			}
			return AuthInfo{Status: AuthRequired}, true
		},
		ExternalAgentRegistry: registryStore,
		ManagedRuntime:        fakeManagedRuntimeResolver(t, runtimeRoot),
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"claude-code"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.CLI.BinaryPath != claudePath {
		t.Fatalf("CLI.BinaryPath = %q, want %q", status.CLI.BinaryPath, claudePath)
	}
	if status.Availability.Status != AvailabilityAuthRequired {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityAuthRequired)
	}
	if status.Auth.Status != AuthRequired {
		t.Fatalf("Auth.Status = %q, want %q", status.Auth.Status, AuthRequired)
	}
}

func TestServiceListRetriesClaudeAuthStatusCommandWhenOutputIsUnrecognized(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	claudePath := filepath.Join(binDir, "claude")
	writeExecutable(t, claudePath, "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(binDir, "claude-agent-acp"), "#!/bin/sh\nexit 0\n")
	writePackageManifest(t, binDir, "@agentclientprotocol/claude-agent-acp", "0.46.0")
	registryStore, prefixDir := fakeClaudeExternalRegistry(t)
	runtimeRoot := fakeManagedRuntimeRoot(t)
	packageDir := npmPackageInstallDir(prefixDir, "@agentclientprotocol/claude-agent-acp")
	if err := os.MkdirAll(packageDir, 0o755); err != nil {
		t.Fatalf("mkdir package dir: %v", err)
	}
	writePackageManifest(t, packageDir, "@agentclientprotocol/claude-agent-acp", "0.46.0")
	authStatusCommandCalls := 0

	service := Service{
		Environ: func() []string {
			return []string{"PATH=/usr/bin:/bin"}
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
		LookPath: func(_ string) (string, error) {
			return "", errors.New("not found")
		},
		Now: func() time.Time {
			return time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
		},
		AuthStatusCommandRetryDelay: time.Nanosecond,
		RunAuthStatusCommand: func(_ context.Context, spec ProviderSpec, binaryPath string) (AuthInfo, bool) {
			if spec.Provider != "claude-code" {
				t.Fatalf("auth status provider = %q, want claude-code", spec.Provider)
			}
			if binaryPath != claudePath {
				t.Fatalf("auth status binaryPath = %q, want %q", binaryPath, claudePath)
			}
			authStatusCommandCalls++
			if authStatusCommandCalls == 1 {
				return AuthInfo{}, false
			}
			return AuthInfo{Status: AuthAuthenticated, AccountLabel: "dev@example.com"}, true
		},
		ExternalAgentRegistry: registryStore,
		ManagedRuntime:        fakeManagedRuntimeResolver(t, runtimeRoot),
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"claude-code"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityReady {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityReady)
	}
	if status.Auth.Status != AuthAuthenticated {
		t.Fatalf("Auth.Status = %q, want %q", status.Auth.Status, AuthAuthenticated)
	}
	if status.Auth.AccountLabel != "dev@example.com" {
		t.Fatalf("AccountLabel = %q, want dev@example.com", status.Auth.AccountLabel)
	}
	if authStatusCommandCalls != 2 {
		t.Fatalf("auth status command calls = %d, want 2", authStatusCommandCalls)
	}
}

func TestServiceListFallsBackToClaudeAuthMarkerWhenAuthStatusCommandIsUnrecognized(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	claudePath := filepath.Join(binDir, "claude")
	writeExecutable(t, claudePath, "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(binDir, "claude-agent-acp"), "#!/bin/sh\nexit 0\n")
	writePackageManifest(t, binDir, "@agentclientprotocol/claude-agent-acp", "0.46.0")
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"userID":"user_123"}`), 0o600); err != nil {
		t.Fatalf("write claude marker: %v", err)
	}
	registryStore, prefixDir := fakeClaudeExternalRegistry(t)
	runtimeRoot := fakeManagedRuntimeRoot(t)
	packageDir := npmPackageInstallDir(prefixDir, "@agentclientprotocol/claude-agent-acp")
	if err := os.MkdirAll(packageDir, 0o755); err != nil {
		t.Fatalf("mkdir package dir: %v", err)
	}
	writePackageManifest(t, packageDir, "@agentclientprotocol/claude-agent-acp", "0.46.0")

	service := Service{
		Environ: func() []string {
			return []string{"PATH=/usr/bin:/bin"}
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
		LookPath: func(_ string) (string, error) {
			return "", errors.New("not found")
		},
		Now: func() time.Time {
			return time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
		},
		AuthStatusCommandRetryDelay: time.Nanosecond,
		RunAuthStatusCommand: func(_ context.Context, spec ProviderSpec, binaryPath string) (AuthInfo, bool) {
			if spec.Provider != "claude-code" {
				t.Fatalf("auth status provider = %q, want claude-code", spec.Provider)
			}
			if binaryPath != claudePath {
				t.Fatalf("auth status binaryPath = %q, want %q", binaryPath, claudePath)
			}
			return AuthInfo{}, false
		},
		ExternalAgentRegistry: registryStore,
		ManagedRuntime:        fakeManagedRuntimeResolver(t, runtimeRoot),
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"claude-code"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityReady {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityReady)
	}
	if status.Auth.Status != AuthAuthenticated {
		t.Fatalf("Auth.Status = %q, want %q", status.Auth.Status, AuthAuthenticated)
	}
}

func TestParseClaudeAuthStatusOutputReportsAuthenticated(t *testing.T) {
	auth, ok := parseClaudeAuthStatusOutput([]byte(`{"loggedIn":true,"authMethod":"oauth"}`))
	if !ok {
		t.Fatal("parseClaudeAuthStatusOutput ok = false, want true")
	}
	if auth.Status != AuthAuthenticated {
		t.Fatalf("Status = %q, want %q", auth.Status, AuthAuthenticated)
	}
	if auth.AccountLabel != "oauth" {
		t.Fatalf("AccountLabel = %q, want oauth", auth.AccountLabel)
	}
}

func TestParseClaudeAuthMarkerContentReportsAuthenticated(t *testing.T) {
	auth, ok := parseClaudeAuthMarkerContent([]byte(`{"loggedIn":true,"email":"dev@example.com"}`))
	if !ok {
		t.Fatal("parseClaudeAuthMarkerContent ok = false, want true")
	}
	if auth.Status != AuthAuthenticated {
		t.Fatalf("Status = %q, want %q", auth.Status, AuthAuthenticated)
	}
	if auth.AccountLabel != "dev@example.com" {
		t.Fatalf("AccountLabel = %q, want dev@example.com", auth.AccountLabel)
	}
}

func TestParseClaudeAuthMarkerContentUsesUserIDFallback(t *testing.T) {
	auth, ok := parseClaudeAuthMarkerContent([]byte(`{"userID":"user_123"}`))
	if !ok {
		t.Fatal("parseClaudeAuthMarkerContent ok = false, want true")
	}
	if auth.Status != AuthAuthenticated {
		t.Fatalf("Status = %q, want %q", auth.Status, AuthAuthenticated)
	}
	if auth.AccountLabel != "user_123" {
		t.Fatalf("AccountLabel = %q, want user_123", auth.AccountLabel)
	}
}

func TestRegistrySelectNormalizesAndDeduplicatesProviders(t *testing.T) {
	specs, err := DefaultRegistry().Select([]string{"claude", "claude-code", "gemini-cli"})
	if err != nil {
		t.Fatalf("Select() error = %v", err)
	}
	if len(specs) != 2 {
		t.Fatalf("len(specs) = %d, want 2", len(specs))
	}
	if specs[0].Provider != "claude-code" {
		t.Fatalf("specs[0].Provider = %q, want claude-code", specs[0].Provider)
	}
	if specs[1].Provider != "gemini" {
		t.Fatalf("specs[1].Provider = %q, want gemini", specs[1].Provider)
	}
}

func TestServiceSelectInstallDirPrefersWritablePathDir(t *testing.T) {
	home := t.TempDir()
	pathDir := filepath.Join(home, "custom-bin")
	if err := os.MkdirAll(pathDir, 0o755); err != nil {
		t.Fatalf("mkdir path dir: %v", err)
	}
	service := Service{
		Environ: func() []string {
			return []string{"PATH=" + pathDir}
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
	}

	installDir, err := service.selectInstallDir()
	if err != nil {
		t.Fatalf("selectInstallDir() error = %v", err)
	}
	if installDir != pathDir {
		t.Fatalf("installDir = %q, want %q", installDir, pathDir)
	}
}

func TestServiceSelectInstallDirFallsBackToLocalBin(t *testing.T) {
	home := t.TempDir()
	service := Service{
		Environ: func() []string {
			return []string{"PATH=/usr/bin:/bin"}
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
	}

	installDir, err := service.selectInstallDir()
	if err != nil {
		t.Fatalf("selectInstallDir() error = %v", err)
	}
	if installDir != filepath.Join(home, ".local", "bin") {
		t.Fatalf("installDir = %q, want ~/.local/bin fallback", installDir)
	}
}

func testService(lookPath func(string) (string, error), files map[string]bool) Service {
	return Service{
		FileExists: func(path string) bool {
			return files[path]
		},
		HomeDir: func() (string, error) {
			return "/home/test", nil
		},
		LookPath: lookPath,
		IsExecutableFile: func(string) bool {
			return false
		},
		Now: func() time.Time {
			return time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
		},
	}
}

func probeTestService(home string) Service {
	return Service{
		Environ: func() []string {
			return []string{"PATH=/usr/bin:/bin"}
		},
		FileExists: func(path string) bool {
			return path == filepath.Join(home, ".codex", "auth.json")
		},
		HomeDir: func() (string, error) {
			return home, nil
		},
		LookPath: func(string) (string, error) {
			return "", errors.New("not found")
		},
		IsExecutableFile: isTestExecutableUnderHome(home),
		Now: func() time.Time {
			return time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
		},
		ProbeReadyAfter: 200 * time.Millisecond,
		ProbeTimeout:    time.Second,
	}
}

func onlyStatus(t *testing.T, snapshot Snapshot) ProviderStatus {
	t.Helper()
	if len(snapshot.Providers) != 1 {
		t.Fatalf("len(snapshot.Providers) = %d, want 1", len(snapshot.Providers))
	}
	return snapshot.Providers[0]
}

func firstAction(t *testing.T, actions []Action) Action {
	t.Helper()
	if len(actions) == 0 {
		t.Fatal("actions is empty")
	}
	return actions[0]
}

func isTestExecutableUnderHome(home string) func(string) bool {
	return func(path string) bool {
		rel, err := filepath.Rel(home, path)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			return false
		}
		stat, err := os.Stat(path)
		return err == nil && !stat.IsDir() && stat.Mode().Perm()&0111 != 0
	}
}

func writeExecutable(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("create executable parent %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o755); err != nil {
		t.Fatalf("write executable %s: %v", path, err)
	}
}

func writePackageManifest(t *testing.T, dir string, name string, version string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("create package manifest dir: %v", err)
	}
	content := `{"name":` + quoteJSONString(name) + `,"version":` + quoteJSONString(version) + `}`
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(content), 0o644); err != nil {
		t.Fatalf("write package manifest: %v", err)
	}
}

func writePackageManifestWithBin(t *testing.T, dir string, name string, version string, binName string, binTarget string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("create package manifest dir: %v", err)
	}
	content := `{"name":` + quoteJSONString(name) +
		`,"version":` + quoteJSONString(version) +
		`,"bin":{` + quoteJSONString(binName) + `:` + quoteJSONString(binTarget) + `}}`
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(content), 0o644); err != nil {
		t.Fatalf("write package manifest: %v", err)
	}
}

func fakeClaudeExternalRegistry(t *testing.T) (externalagentregistry.Store, string) {
	t.Helper()
	root := t.TempDir()
	sourcePath := filepath.Join(root, "registry.json")
	content := `{
  "version": "test",
  "agents": [{
    "id": "claude-acp",
    "name": "Claude Agent",
    "version": "0.46.0",
    "description": "ACP wrapper for Anthropic's Claude",
    "distribution": {
      "npx": {
        "package": "@agentclientprotocol/claude-agent-acp@0.46.0"
      }
    }
  }]
}`
	if err := os.WriteFile(sourcePath, []byte(content), 0o644); err != nil {
		t.Fatalf("write fake registry: %v", err)
	}
	store := externalagentregistry.Store{
		SourceURL: sourcePath,
		CacheRoot: filepath.Join(root, "cache"),
		Now: func() time.Time {
			return time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
		},
	}
	return store, store.PackagePrefix("claude-acp")
}

func fakeManagedRuntimeRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeExecutable(t, filepath.Join(root, "python", "bin", pythonBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(root, "node", "bin", nodeBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(root, "node", "bin", npmBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	return root
}

func fakeManagedRuntimeResolver(t *testing.T, runtimeRoot string) managedruntime.DefaultResolver {
	t.Helper()
	cacheRoot := t.TempDir()
	return managedruntime.DefaultResolver{
		RuntimeRoot: runtimeRoot,
		Environ: func() []string {
			return []string{
				"PATH=/usr/bin:/bin",
				"TUTTI_APP_RUNTIME_CACHE_ROOT=" + cacheRoot,
				"TUTTI_APP_RUNTIME_CATALOG=",
			}
		},
	}
}

func pythonBinaryNameForTest() string {
	if runtime.GOOS == "windows" {
		return "python.exe"
	}
	return "python3"
}

func nodeBinaryNameForTest() string {
	if runtime.GOOS == "windows" {
		return "node.exe"
	}
	return "node"
}

func npmBinaryNameForTest() string {
	if runtime.GOOS == "windows" {
		return "npm.cmd"
	}
	return "npm"
}

func quoteJSONString(value string) string {
	quoted, _ := json.Marshal(value)
	return string(quoted)
}

func releaseBinaryArchive(t *testing.T, binaryName string, contents string) (string, string) {
	t.Helper()
	archivePath := filepath.Join(t.TempDir(), binaryName+".tar.gz")
	file, err := os.Create(archivePath)
	if err != nil {
		t.Fatalf("create archive: %v", err)
	}
	gzipWriter := gzip.NewWriter(file)
	tarWriter := tar.NewWriter(gzipWriter)
	contentBytes := []byte(contents)
	header := &tar.Header{
		Name: binaryName,
		Mode: 0o755,
		Size: int64(len(contentBytes)),
	}
	if err := tarWriter.WriteHeader(header); err != nil {
		t.Fatalf("write archive header: %v", err)
	}
	if _, err := tarWriter.Write(contentBytes); err != nil {
		t.Fatalf("write archive contents: %v", err)
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatalf("close tar writer: %v", err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatalf("close gzip writer: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close archive file: %v", err)
	}
	data, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatalf("read archive: %v", err)
	}
	sum := sha256.Sum256(data)
	return archivePath, hex.EncodeToString(sum[:])
}

func codexCLIPackageArchive(t *testing.T) (string, string) {
	t.Helper()
	archivePath := filepath.Join(t.TempDir(), "codex-package.tar.gz")
	file, err := os.Create(archivePath)
	if err != nil {
		t.Fatalf("create codex package archive: %v", err)
	}
	gzipWriter := gzip.NewWriter(file)
	tarWriter := tar.NewWriter(gzipWriter)
	files := map[string]struct {
		mode     int64
		contents string
	}{
		"codex-package.json": {
			mode:     0o644,
			contents: `{"name":"codex-package","version":"1.2.3"}`,
		},
		"bin/codex": {
			mode:     0o755,
			contents: "#!/bin/sh\necho 'codex 1.2.3'\n",
		},
		"codex-path/rg": {
			mode:     0o755,
			contents: "#!/bin/sh\necho rg\n",
		},
	}
	for name, file := range files {
		contentBytes := []byte(file.contents)
		header := &tar.Header{
			Name: name,
			Mode: file.mode,
			Size: int64(len(contentBytes)),
		}
		if err := tarWriter.WriteHeader(header); err != nil {
			t.Fatalf("write codex package header: %v", err)
		}
		if _, err := tarWriter.Write(contentBytes); err != nil {
			t.Fatalf("write codex package contents: %v", err)
		}
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatalf("close codex package tar writer: %v", err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatalf("close codex package gzip writer: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close codex package archive file: %v", err)
	}
	data, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatalf("read codex package archive: %v", err)
	}
	sum := sha256.Sum256(data)
	return archivePath, hex.EncodeToString(sum[:])
}
