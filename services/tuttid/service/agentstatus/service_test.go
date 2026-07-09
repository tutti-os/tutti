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
	"net/url"
	"os"
	"path/filepath"
	"reflect"
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

func TestServiceListReturnsLatestActiveActionAfterNetworkProbe(t *testing.T) {
	service := testService(func(_ string) (string, error) {
		return "", errors.New("not found")
	}, map[string]bool{})
	activeCtx := withActiveActionToken(context.Background(), nextActiveActionToken())
	// A login (not install) active action: List skips the network probe only
	// while a provider is installing, so a non-install action keeps the probe
	// running — which is what this test exercises (the active action is read
	// after the probe, so output appended during it is surfaced).
	claimActiveAction(activeCtx, "codex", ActiveAction{
		ID:     ActionLogin,
		Status: "running",
		Step:   "cli",
	})
	t.Cleanup(func() { clearActiveAction(activeCtx, "codex") })
	var appended atomic.Bool
	service.HTTPClient = &http.Client{Transport: networkRoundTripFunc(func(*http.Request) (*http.Response, error) {
		if appended.CompareAndSwap(false, true) {
			appendActiveActionStdout(activeCtx, "codex", "installer output\n")
		}
		return &http.Response{StatusCode: http.StatusNoContent, Body: http.NoBody}, nil
	})}
	service.ResolveProxy = func(*http.Request) (*url.URL, error) {
		return nil, nil
	}

	snapshot, err := service.List(context.Background(), ListInput{
		Providers:      []string{"codex"},
		IncludeNetwork: true,
	})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.ActiveAction == nil {
		t.Fatal("ActiveAction = nil, want running action")
	}
	if !strings.Contains(status.ActiveAction.Stdout, "installer output") {
		t.Fatalf("ActiveAction.Stdout = %q, want latest output", status.ActiveAction.Stdout)
	}
}

func TestDefaultRegistryUsesCodexCLILatestInstaller(t *testing.T) {
	specs, err := DefaultRegistry().Select([]string{"codex"})
	if err != nil {
		t.Fatalf("Select() error = %v", err)
	}
	if len(specs) != 1 {
		t.Fatalf("len(specs) = %d, want 1", len(specs))
	}
	install := specs[0].Install
	if install.Kind != InstallerKindCodexCLILatest {
		t.Fatalf("Install.Kind = %q, want %q", install.Kind, InstallerKindCodexCLILatest)
	}
	if install.CodexCLI == nil {
		t.Fatalf("Install.CodexCLI = nil, want daemon-managed codex CLI installer spec")
	}
}

func TestDefaultRegistryUsesTuttiAgentManagedNPMInstaller(t *testing.T) {
	specs, err := DefaultRegistry().Select([]string{"tutti-agent"})
	if err != nil {
		t.Fatalf("Select() error = %v", err)
	}
	if len(specs) != 1 {
		t.Fatalf("len(specs) = %d, want 1", len(specs))
	}
	install := specs[0].Install
	if install.Kind != InstallerKindManagedNPMPackage {
		t.Fatalf("Install.Kind = %q, want %q", install.Kind, InstallerKindManagedNPMPackage)
	}
	if install.ManagedNPM == nil {
		t.Fatalf("Install.ManagedNPM = nil, want managed npm installer spec")
	}
	if install.ManagedNPM.PackageName != "@tutti-os/tutti-agent" {
		t.Fatalf("PackageName = %q, want @tutti-os/tutti-agent", install.ManagedNPM.PackageName)
	}
	if install.ManagedNPM.PackageVersion != minTuttiAgentVersion {
		t.Fatalf("PackageVersion = %q, want %q", install.ManagedNPM.PackageVersion, minTuttiAgentVersion)
	}
	if install.ManagedNPM.BinaryName != "tutti-agent" {
		t.Fatalf("BinaryName = %q, want tutti-agent", install.ManagedNPM.BinaryName)
	}
	if !install.ManagedNPM.IncludeOptional {
		t.Fatalf("IncludeOptional = false, want true")
	}
	if specs[0].AdapterPackage.Name != "@tutti-os/tutti-agent" || specs[0].AdapterPackage.Version != minTuttiAgentVersion {
		t.Fatalf("AdapterPackage = %+v, want @tutti-os/tutti-agent >= %s", specs[0].AdapterPackage, minTuttiAgentVersion)
	}
}

func TestTuttiAgentAdapterVersionMismatchRequiresInstall(t *testing.T) {
	home := t.TempDir()
	packageDir := filepath.Join(home, "lib", "node_modules", "@tutti-os", "tutti-agent")
	binPath := filepath.Join(packageDir, "bin", "tutti-agent")
	writePackageManifest(t, packageDir, "@tutti-os/tutti-agent", "0.0.1")
	writeExecutable(t, binPath, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'tutti-agent 0.0.1'; exit 0; fi\nexit 0\n")

	service := probeTestService(home)
	service.LookPath = func(name string) (string, error) {
		if name == "tutti-agent" {
			return binPath, nil
		}
		return "", errors.New("not found")
	}
	service.FileExists = func(path string) bool {
		return path == filepath.Join(home, ".tutti-agent", "auth.json")
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"tutti-agent"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityNotInstalled {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityNotInstalled)
	}
	if status.Availability.ReasonCode != "acp_adapter_version_mismatch" {
		t.Fatalf("ReasonCode = %q, want acp_adapter_version_mismatch", status.Availability.ReasonCode)
	}
	if status.Adapter.Version != "0.0.1" {
		t.Fatalf("Adapter.Version = %q, want 0.0.1", status.Adapter.Version)
	}
	if status.Adapter.RequiredVersion != minTuttiAgentVersion {
		t.Fatalf("Adapter.RequiredVersion = %q, want %q", status.Adapter.RequiredVersion, minTuttiAgentVersion)
	}
	action := firstAction(t, status.Actions)
	if action.ID != ActionInstall {
		t.Fatalf("first action ID = %q, want %q", action.ID, ActionInstall)
	}
}

func TestTuttiAgentAdapterAboveMinimumVersionDoesNotRequireInstall(t *testing.T) {
	home := t.TempDir()
	packageDir := filepath.Join(home, "lib", "node_modules", "@tutti-os", "tutti-agent")
	binPath := filepath.Join(packageDir, "bin", "tutti-agent")
	writePackageManifest(t, packageDir, "@tutti-os/tutti-agent", "0.0.3")
	writeExecutable(t, binPath, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'tutti-agent 0.0.3'; exit 0; fi\nexit 0\n")

	service := probeTestService(home)
	service.LookPath = func(name string) (string, error) {
		if name == "tutti-agent" {
			return binPath, nil
		}
		return "", errors.New("not found")
	}
	service.FileExists = func(path string) bool {
		return path == filepath.Join(home, ".tutti-agent", "auth.json")
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"tutti-agent"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityAuthRequired {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityAuthRequired)
	}
	if status.Availability.ReasonCode != "auth_required" {
		t.Fatalf("ReasonCode = %q, want auth_required", status.Availability.ReasonCode)
	}
	if status.Adapter.Version != "0.0.3" {
		t.Fatalf("Adapter.Version = %q, want 0.0.3", status.Adapter.Version)
	}
	if status.Adapter.RequiredVersion != minTuttiAgentVersion {
		t.Fatalf("Adapter.RequiredVersion = %q, want %q", status.Adapter.RequiredVersion, minTuttiAgentVersion)
	}
	action := firstAction(t, status.Actions)
	if action.ID != ActionLogin {
		t.Fatalf("first action ID = %q, want %q", action.ID, ActionLogin)
	}
}

func TestDefaultRegistryIncludesCursorSpec(t *testing.T) {
	specs, err := DefaultRegistry().Select([]string{"cursor"})
	if err != nil {
		t.Fatalf("Select() error = %v", err)
	}
	if len(specs) != 1 {
		t.Fatalf("len(specs) = %d, want 1", len(specs))
	}
	spec := specs[0]
	if spec.SupportStatus == ProviderSupportStatusUnsupported {
		t.Fatal("SupportStatus = unsupported, want cursor enabled by default")
	}
	if !reflect.DeepEqual(spec.BinaryNames, []string{"cursor-agent", "agent"}) {
		t.Fatalf("BinaryNames = %#v", spec.BinaryNames)
	}
	if !reflect.DeepEqual(spec.AdapterCommand, []string{"cursor-agent", "acp"}) {
		t.Fatalf("AdapterCommand = %#v", spec.AdapterCommand)
	}
	if spec.Install.Kind != InstallerKindOfficialScript || spec.Install.ScriptURL != "https://cursor.com/install" {
		t.Fatalf("Install = %#v, want official cursor.com install script", spec.Install)
	}
	if !reflect.DeepEqual(spec.LoginArgs, []string{"login"}) {
		t.Fatalf("LoginArgs = %#v", spec.LoginArgs)
	}
}

func TestParseCursorAuthStatusOutput(t *testing.T) {
	for _, tt := range []struct {
		output       string
		status       AuthStatus
		accountLabel string
		ok           bool
	}{
		{output: "Logged in as user@example.com", status: AuthAuthenticated, accountLabel: "user@example.com", ok: true},
		{output: "cursor-agent 2026.06.10\nStatus: Authenticated", status: AuthAuthenticated, ok: true},
		{output: "Not logged in. Run cursor-agent login to sign in.", status: AuthRequired, ok: true},
		{output: "You are currently logged out", status: AuthRequired, ok: true},
		{output: "", ok: false},
		{output: "unrecognized output", ok: false},
	} {
		auth, ok := parseCursorAuthStatusOutput([]byte(tt.output))
		if ok != tt.ok {
			t.Fatalf("parseCursorAuthStatusOutput(%q) ok = %v, want %v", tt.output, ok, tt.ok)
		}
		if ok && auth.Status != tt.status {
			t.Fatalf("parseCursorAuthStatusOutput(%q) status = %q, want %q", tt.output, auth.Status, tt.status)
		}
		if ok && auth.AccountLabel != tt.accountLabel {
			t.Fatalf("parseCursorAuthStatusOutput(%q) accountLabel = %q, want %q", tt.output, auth.AccountLabel, tt.accountLabel)
		}
	}
}

func TestParseCursorAboutJSON(t *testing.T) {
	auth, ok := parseCursorAboutJSON([]byte(`{
		"cliVersion": "2026.07.01-41b2de7",
		"subscriptionTier": "Ultra",
		"userEmail": "user@example.com"
	}`))
	if !ok {
		t.Fatal("parseCursorAboutJSON() ok = false, want true")
	}
	if auth.Status != AuthAuthenticated {
		t.Fatalf("status = %q, want authenticated", auth.Status)
	}
	if auth.AccountLabel != "Cursor Ultra · user@example.com" {
		t.Fatalf("accountLabel = %q, want Cursor Ultra · user@example.com", auth.AccountLabel)
	}
	if auth.AuthMethod != "cursor_login" {
		t.Fatalf("authMethod = %q, want cursor_login", auth.AuthMethod)
	}

	auth, ok = parseCursorAboutJSON([]byte(`{"userEmail": null}`))
	if !ok || auth.Status != AuthRequired {
		t.Fatalf("null userEmail = %#v, want required auth", auth)
	}
}

func TestParseCursorAboutText(t *testing.T) {
	auth, ok := parseCursorAboutText([]byte(`About Cursor CLI

CLI Version         2026.07.01-41b2de7
Subscription Tier   Ultra
User Email          user@example.com
`))
	if !ok {
		t.Fatal("parseCursorAboutText() ok = false, want true")
	}
	if auth.AccountLabel != "Cursor Ultra · user@example.com" {
		t.Fatalf("accountLabel = %q, want Cursor Ultra · user@example.com", auth.AccountLabel)
	}
}

func TestParseOpenCodeAuthStatusOutput(t *testing.T) {
	for _, tt := range []struct {
		output string
		status AuthStatus
		ok     bool
	}{
		{output: "Logged in as user@example.com", status: AuthAuthenticated, ok: true},
		{output: "Status: authenticated", status: AuthAuthenticated, ok: true},
		{output: "Not authenticated. Run opencode auth login.", status: AuthRequired, ok: true},
		{output: "No providers are authenticated", status: AuthRequired, ok: true},
		{output: "", ok: false},
		{output: "unexpected opencode error", ok: false},
	} {
		auth, ok := parseOpenCodeAuthStatusOutput([]byte(tt.output))
		if ok != tt.ok {
			t.Fatalf("parseOpenCodeAuthStatusOutput(%q) ok = %v, want %v", tt.output, ok, tt.ok)
		}
		if ok && auth.Status != tt.status {
			t.Fatalf("parseOpenCodeAuthStatusOutput(%q) status = %q, want %q", tt.output, auth.Status, tt.status)
		}
	}
}

func TestResolveProviderCommandSwapsInstalledCursorBinary(t *testing.T) {
	service := testService(func(name string) (string, error) {
		if name == "agent" {
			return "/home/test/.local/bin/agent", nil
		}
		return "", errors.New("not found")
	}, map[string]bool{})

	resolved, err := service.ResolveProviderCommand(context.Background(), "cursor")
	if err != nil {
		t.Fatalf("ResolveProviderCommand() error = %v", err)
	}
	if !reflect.DeepEqual(resolved.Command, []string{"/home/test/.local/bin/agent", "acp"}) {
		t.Fatalf("Command = %#v, want resolved agent binary", resolved.Command)
	}
}

func TestResolveProviderCommandKeepsCursorDefaultWhenBinaryMissing(t *testing.T) {
	service := testService(func(string) (string, error) {
		return "", errors.New("not found")
	}, map[string]bool{})

	resolved, err := service.ResolveProviderCommand(context.Background(), "cursor")
	if err != nil {
		t.Fatalf("ResolveProviderCommand() error = %v", err)
	}
	if !reflect.DeepEqual(resolved.Command, []string{"cursor-agent", "acp"}) {
		t.Fatalf("Command = %#v, want default cursor-agent command", resolved.Command)
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
	if action.Command == nil || action.Command.Input != `/usr/local/bin/codex login -c 'service_tier="fast"'
` {
		t.Fatalf("login command = %#v", action.Command)
	}
	if status.Actions[1].ID != ActionRefresh || status.Actions[1].Kind != ActionKindRefresh {
		t.Fatalf("second action = %#v, want refresh", status.Actions[1])
	}
}

// specWithSeparateAdapter returns a synthetic provider spec that ships a
// distinct ACP adapter binary (separate from its CLI). The codex provider no
// longer has one — it talks to the codex app-server directly — but the
// separate-adapter machinery is still exercised by other providers (e.g.
// nexight), so these tests pin a local spec rather than DefaultRegistry's codex.
func specWithSeparateAdapter() ProviderSpec {
	return ProviderSpec{
		Provider:           "codex",
		BinaryNames:        []string{"codex"},
		AdapterBinaryNames: []string{"codex-acp"},
		AdapterCommand:     []string{"codex-acp"},
		AuthMarkerPaths:    []string{"~/.codex/auth.json"},
		Install: InstallerSpec{
			Kind:           InstallerKindOfficialScript,
			DisplayCommand: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
			ScriptURL:      "https://chatgpt.com/codex/install.sh",
			ScriptShell:    "sh",
		},
		AdapterInstall: InstallerSpec{
			Kind:           InstallerKindGitHubReleaseBinary,
			DisplayCommand: "Install test adapter from GitHub releases",
			ReleaseBinary: &ReleaseBinaryInstallerSpec{
				BinaryName: "codex-acp",
				Version:    "v0.0.0-test",
				Assets:     map[string]ReleaseBinaryAsset{},
			},
		},
		LoginArgs: []string{"login"},
	}
}

func TestNextMissingInstallerRepairsAdapterLaunchFailureBeforeCLI(t *testing.T) {
	spec := specWithSeparateAdapter()
	installer, missing, target := (Service{}).nextMissingInstaller(spec, providerRuntimeResolution{
		ReasonCode: "acp_adapter_launch_failed",
	})
	if !missing {
		t.Fatal("missing = false, want true")
	}
	if target != "adapter" {
		t.Fatalf("target = %q, want adapter", target)
	}
	if installer.Kind != spec.AdapterInstall.Kind {
		t.Fatalf("installer.Kind = %q, want %q", installer.Kind, spec.AdapterInstall.Kind)
	}
}

func TestServiceListReportsInstallActionWhenACPAdapterMissing(t *testing.T) {
	service := testService(func(name string) (string, error) {
		if name == "codex" {
			return "/usr/local/bin/codex", nil
		}
		return "", errors.New("not found")
	}, map[string]bool{"/home/test/.codex/auth.json": true})
	service.Registry = Registry{Specs: []ProviderSpec{specWithSeparateAdapter()}}

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
	if action.Command == nil || action.Command.Input != `/usr/local/bin/codex login -c 'service_tier="fast"'
` {
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
		if strings.Join(spec.AuthStatusCommand, " ") != `login -c service_tier="fast" status` {
			t.Fatalf("AuthStatusCommand = %v, want login service tier override status", spec.AuthStatusCommand)
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

func TestServiceListReportsCodexChecksVersionAndLastError(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	pkgDir := filepath.Join(home, "lib", "node_modules", "@openai", "codex")
	writePackageManifest(t, pkgDir, "@openai/codex", "0.100.0")
	codexPath := filepath.Join(pkgDir, "bin", "codex")
	writeExecutable(t, codexPath, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex 0.100.0'; exit 0; fi\nsleep 5\n")
	visiblePath := filepath.Join(binDir, "codex")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	if err := os.Symlink(codexPath, visiblePath); err != nil {
		t.Fatalf("symlink codex: %v", err)
	}
	platformPath := requireTestCodexPlatformBinaryPath(t, pkgDir)
	writeExecutable(t, platformPath, "#!/bin/sh\nexit 0\n")

	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{"PATH=" + binDir}
	}
	service.IsExecutableFile = isTestExecutable
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	if _, ok := service.codexPlatformBinaryComplete(pkgDir, runtime.GOOS, runtime.GOARCH); !ok {
		t.Fatalf("test codex platform binary is not complete at %s", platformPath)
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.CLI.Version != "0.100.0" {
		t.Fatalf("CLI.Version = %q, want 0.100.0", status.CLI.Version)
	}
	if status.LastError == nil || status.LastError.Code != string(CodexErrVersionTooOld) {
		t.Fatalf("LastError = %#v, CLI.BinaryPath=%q, packageDir=%q, want codex version too old", status.LastError, status.CLI.BinaryPath, codexPackageDirForBinary(status.CLI.BinaryPath))
	}
	assertProviderCheck(t, status.Checks, "cli_present", true)
	assertProviderCheck(t, status.Checks, "platform_binary", true)
	assertProviderCheck(t, status.Checks, "version_floor", false)
	assertProviderCheck(t, status.Checks, "auth", true)
}

func TestServiceListRunsCodexLauncherWithManagedNodePath(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	pkgDir := filepath.Join(home, "lib", "node_modules", "@openai", "codex")
	writePackageManifest(t, pkgDir, "@openai/codex", MinSupportedCodexVersion)
	codexPath := filepath.Join(pkgDir, "bin", "codex")
	writeExecutable(t, codexPath, "#!/usr/bin/env node\n")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	if err := os.Symlink(codexPath, filepath.Join(binDir, "codex")); err != nil {
		t.Fatalf("symlink codex: %v", err)
	}
	platformPath := requireTestCodexPlatformBinaryPath(t, pkgDir)
	writeExecutable(t, platformPath, "#!/bin/sh\nexit 0\n")

	runtimeRoot := fakeManagedRuntimeRoot(t)
	managedNode := filepath.Join(runtimeRoot, "node", "bin", nodeBinaryNameForTest())
	writeExecutable(t, managedNode, "#!/bin/sh\nif [ \"$2\" = \"--version\" ]; then echo 'codex "+MinSupportedCodexVersion+"'; exit 0; fi\nexit 0\n")

	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{"PATH=" + binDir}
	}
	service.IsExecutableFile = isTestExecutable
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityReady {
		t.Fatalf("Availability.Status = %q, want ready; reason=%q lastError=%#v", status.Availability.Status, status.Availability.ReasonCode, status.LastError)
	}
	if status.CLI.Version != MinSupportedCodexVersion {
		t.Fatalf("CLI.Version = %q, want %q", status.CLI.Version, MinSupportedCodexVersion)
	}
}

func TestServiceProbeReportsCodexPlatformPackageIncomplete(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	pkgDir := filepath.Join(home, "lib", "node_modules", "@openai", "codex")
	writePackageManifest(t, pkgDir, "@openai/codex", MinSupportedCodexVersion)
	codexPath := filepath.Join(pkgDir, "bin", "codex")
	writeExecutable(t, codexPath, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex "+MinSupportedCodexVersion+"'; exit 0; fi\nsleep 5\n")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	writeExecutable(t, filepath.Join(binDir, npmBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(binDir, nodeBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	if err := os.Symlink(codexPath, filepath.Join(binDir, "codex")); err != nil {
		t.Fatalf("symlink codex: %v", err)
	}

	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{"PATH=" + binDir}
	}
	service.IsExecutableFile = isTestExecutable
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}

	result, err := service.Probe(context.Background(), ProbeInput{Provider: "codex"})
	if err != nil {
		t.Fatalf("Probe() error = %v", err)
	}
	if result.Status != ProbeFailed {
		t.Fatalf("Status = %q, want failed; result=%#v", result.Status, result)
	}
	if result.LastError == nil || result.LastError.Code != string(CodexErrPlatformPkgIncomplete) {
		t.Fatalf("LastError = %#v, want platform package incomplete", result.LastError)
	}
	assertProviderCheck(t, result.Checks, "platform_binary", false)
}

func TestServiceRunActionReinstallsCodexWhenPlatformPackageIncomplete(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	pkgDir := filepath.Join(home, "lib", "node_modules", "@openai", "codex")
	writePackageManifest(t, pkgDir, "@openai/codex", MinSupportedCodexVersion)
	codexPath := filepath.Join(pkgDir, "bin", "codex")
	writeExecutable(t, codexPath, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex "+MinSupportedCodexVersion+"'; exit 0; fi\nsleep 5\n")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	if err := os.Symlink(codexPath, filepath.Join(binDir, "codex")); err != nil {
		t.Fatalf("symlink codex: %v", err)
	}
	platformBinary := requireTestCodexPlatformBinaryPath(t, pkgDir)

	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{"PATH=" + binDir, agentNPMRegistryEnv + "=https://registry.example.test"}
	}
	service.IsExecutableFile = isTestExecutable
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	// The broken install lives under <home>/lib/node_modules, so repair-in-place
	// must install at the npm global prefix that owns it — not duplicate the
	// package in ~/.local. Derive the expected prefix the same way production does
	// (via EvalSymlinks, so it matches on macOS where /var -> /private/var).
	wantPrefix, wantPrefixOK := managedNPMRepairInstallPrefix(filepath.Join(binDir, "codex"), "@openai/codex")
	if !wantPrefixOK {
		t.Fatalf("expected repair prefix to be derivable for %s", filepath.Join(binDir, "codex"))
	}

	var command InstallCommandInput
	var activeStep string
	service.InstallCommand = func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		command = input
		if snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}}); err == nil {
			if status := onlyStatus(t, snapshot); status.ActiveAction != nil {
				activeStep = status.ActiveAction.Step
			}
		}
		writeExecutable(t, platformBinary, "#!/bin/sh\nexit 0\n")
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}

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
	if !strings.Contains(command.Command, "@openai/codex") ||
		!strings.Contains(command.Command, "--include=optional") ||
		!strings.Contains(command.Command, "--prefix "+wantPrefix+" ") {
		t.Fatalf("Command = %q, want Codex CLI install with optional deps repaired in place at --prefix %s", command.Command, wantPrefix)
	}
	if activeStep != "repair" {
		t.Fatalf("active action step = %q, want %q (repair-in-place)", activeStep, "repair")
	}
	if result.Probe == nil || result.Probe.Status != ProbeReady {
		t.Fatalf("Probe = %#v, want ready probe", result.Probe)
	}
}

func TestServiceRunActionRepairsCodexWhenAppServerLaunchFails(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	pkgDir := filepath.Join(home, "lib", "node_modules", "@openai", "codex")
	writePackageManifest(t, pkgDir, "@openai/codex", MinSupportedCodexVersion)
	codexPath := filepath.Join(pkgDir, "bin", "codex")
	writeExecutable(t, codexPath, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex "+MinSupportedCodexVersion+"'; exit 0; fi\nif [ \"$1\" = \"app-server\" ]; then echo 'app-server failed' >&2; exit 127; fi\nexit 0\n")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	if err := os.Symlink(codexPath, filepath.Join(binDir, "codex")); err != nil {
		t.Fatalf("symlink codex: %v", err)
	}
	platformBinary := requireTestCodexPlatformBinaryPath(t, pkgDir)
	writeExecutable(t, platformBinary, "#!/bin/sh\nexit 0\n")

	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{"PATH=" + binDir, agentNPMRegistryEnv + "=https://registry.example.test"}
	}
	service.IsExecutableFile = isTestExecutable
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}

	var command InstallCommandInput
	service.InstallCommand = func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		command = input
		writeExecutable(t, codexPath, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex "+MinSupportedCodexVersion+"'; exit 0; fi\nif [ \"$1\" = \"app-server\" ]; then sleep 5; fi\nexit 0\n")
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}

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
	if !strings.Contains(command.Command, "@openai/codex") ||
		!strings.Contains(command.Command, "--include=optional") {
		t.Fatalf("Command = %q, want Codex CLI repair install with optional deps", command.Command)
	}
	if result.Probe == nil || result.Probe.Status != ProbeReady {
		t.Fatalf("Probe = %#v, want ready probe", result.Probe)
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
		Registry: Registry{Specs: []ProviderSpec{specWithSeparateAdapter()}},
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
	forceClaudeACPRuntime(t)

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
		ProbeTimeout: 10 * time.Second,
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
	forceClaudeACPRuntime(t)

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

func TestServiceListExternalAdapterCommandUsesRankedRegistry(t *testing.T) {
	forceClaudeACPRuntime(t)

	home := t.TempDir()
	binDir := filepath.Join(home, ".local", "bin")
	claudePath := filepath.Join(binDir, "claude")
	writeExecutable(t, claudePath, "#!/bin/sh\nexit 0\n")

	registryStore, prefixDir := fakeClaudeExternalRegistry(t)
	runtimeRoot := fakeManagedRuntimeRoot(t)
	registryCapturePath := filepath.Join(home, "npm-registry.txt")
	writeExecutable(
		t,
		filepath.Join(runtimeRoot, "node", "bin", npmBinaryNameForTest()),
		"#!/bin/sh\nprintf '%s' \"$npm_config_registry\" > "+shellQuote(registryCapturePath)+"\necho 'sh: claude-agent-acp: command not found' >&2\nexit 127\n",
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
		HTTPClient: agentNPMRegistryProbeHTTPClient(map[string]bool{
			"registry.npmjs.org": true,
		}),
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"claude-code"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	status := onlyStatus(t, snapshot)
	if status.Availability.ReasonCode != "acp_adapter_launch_failed" {
		t.Fatalf("ReasonCode = %q, want acp_adapter_launch_failed", status.Availability.ReasonCode)
	}
	registryBytes, err := os.ReadFile(registryCapturePath)
	if err != nil {
		t.Fatalf("read captured npm registry: %v", err)
	}
	if got := string(registryBytes); got != "https://repo.huaweicloud.com/repository/npm/" {
		t.Fatalf("npm_config_registry = %q, want ranked mirror registry", got)
	}
}

func TestServiceListReportsInstallActionWhenExternalAdapterCommandFailsAfterReadyWindow(t *testing.T) {
	forceClaudeACPRuntime(t)

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
		ProbeTimeout:    10 * time.Second,
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
		"/home/test/.nexight/auth.json":         true,
		"/home/test/.hermes/auth.json":          true,
		"/home/test/.config/openclaw/auth.json": true,
	})

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"nexight", "hermes", "openclaw"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(snapshot.Providers) != 3 {
		t.Fatalf("len(providers) = %d, want 3", len(snapshot.Providers))
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
		Registry: Registry{Specs: []ProviderSpec{specWithSeparateAdapter()}},
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

	service := probeTestService(home)
	service.Registry = Registry{Specs: []ProviderSpec{specWithSeparateAdapter()}}
	result, err := service.Probe(context.Background(), ProbeInput{Provider: "codex"})
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
		AdapterInstall: InstallerSpec{
			Kind:           InstallerKindShellCommand,
			DisplayCommand: "install adapter",
			ShellCommand:   "true",
		},
		LoginArgs: []string{"login"},
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
	}, map[string]bool{"/home/test/.hermes/auth.json": true})

	result, err := service.Probe(context.Background(), ProbeInput{Provider: "hermes"})
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

func TestServiceRunCodexCLILatestInstallerPrefersManagedNPM(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	writeExecutable(t, filepath.Join(binDir, npmBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	runtimeRoot := fakeManagedRuntimeRoot(t)
	managedNPM := filepath.Join(runtimeRoot, "node", "bin", npmBinaryNameForTest())
	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{"PATH=" + binDir, agentNPMRegistryEnv + "=https://registry.example.test"}
	}
	service.IsExecutableFile = isTestExecutableUnderHome(home)
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	service.Registry = Registry{Specs: []ProviderSpec{{
		Provider:           "codex",
		BinaryNames:        []string{"codex-test"},
		AdapterBinaryNames: []string{"codex-test"},
		AdapterCommand:     []string{"codex-test", "app-server"},
		AuthStatusCommand:  []string{"login", "status"},
		Install:            codexCLIInstallerSpec(),
		LoginArgs:          []string{"login"},
	}}}
	var command InstallCommandInput
	service.InstallCommand = func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		command = input
		input.OnStdout("installed")
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}
	result, err := service.runCodexCLILatestInstaller(context.Background(), InstallerSpec{
		Kind:     InstallerKindCodexCLILatest,
		CodexCLI: &CodexCLILatestInstallerSpec{},
	}, "")
	if err != nil {
		t.Fatalf("runCodexCLILatestInstaller() error = %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("ExitCode = %d, want 0; stderr=%q", result.ExitCode, result.Stderr)
	}
	if !strings.Contains(command.Command, managedNPM) ||
		!strings.Contains(command.Command, "install") ||
		!strings.Contains(command.Command, "-g") ||
		!strings.Contains(command.Command, "@openai/codex") ||
		!strings.Contains(command.Command, "--include=optional") ||
		!strings.Contains(command.Command, "--prefix") {
		t.Fatalf("Command = %q, want managed npm install with optional deps pinned to a searched --prefix", command.Command)
	}
	if !slices.Contains(command.Env, "npm_config_registry=https://registry.example.test") {
		t.Fatalf("Env = %#v, want selected npm registry", command.Env)
	}
}

func TestServiceRunCodexInstallerReportsManagedNPMActiveAction(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	writeExecutable(t, filepath.Join(binDir, npmBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(binDir, nodeBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	runtimeRoot := fakeManagedRuntimeRoot(t)
	managedNPM := filepath.Join(runtimeRoot, "node", "bin", npmBinaryNameForTest())
	managedNode := filepath.Join(runtimeRoot, "node", "bin", nodeBinaryNameForTest())
	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{"PATH=" + binDir, agentNPMRegistryEnv + "=https://registry.example.test"}
	}
	service.IsExecutableFile = isTestExecutableUnderHome(home)
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	service.Registry = Registry{Specs: []ProviderSpec{{
		Provider:           "codex",
		BinaryNames:        []string{"codex-test"},
		AdapterBinaryNames: []string{"codex-test"},
		AdapterCommand:     []string{"codex-test", "app-server"},
		AuthStatusCommand:  []string{"login", "status"},
		Install:            codexCLIInstallerSpec(),
		LoginArgs:          []string{"login"},
	}}}

	installStarted := make(chan struct{})
	releaseInstall := make(chan struct{})
	var releaseInstallOnce sync.Once
	done := make(chan RunActionResult, 1)
	pkgDir := filepath.Join(home, "lib", "node_modules", "@openai", "codex")
	service.InstallCommand = func(ctx context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		// This callback runs on the RunAction goroutine, so it must never call
		// t.Fatalf/t.Skipf — those Goexit only this goroutine and hang the test on
		// <-done. Use t.Errorf and return so the test goroutine unblocks.
		if !strings.Contains(input.Command, managedNPM) ||
			!strings.Contains(input.Command, "install") ||
			!strings.Contains(input.Command, "-g") ||
			!strings.Contains(input.Command, "@openai/codex") ||
			!strings.Contains(input.Command, "--include=optional") ||
			!strings.Contains(input.Command, "--prefix") {
			t.Errorf("Command = %q, want managed npm install with optional deps pinned to a searched --prefix", input.Command)
		}
		if !slices.Contains(input.Env, "TUTTI_APP_NODE="+managedNode) {
			t.Errorf("Env = %#v, want managed node marker", input.Env)
		}
		if !slices.Contains(input.Env, "npm_config_registry=https://registry.example.test") {
			t.Errorf("Env = %#v, want selected npm registry", input.Env)
		}
		input.OnStdout("fetching @openai/codex")
		close(installStarted)
		select {
		case <-releaseInstall:
		case <-ctx.Done():
			return InstallCommandResult{ExitCode: 1, Stderr: ctx.Err().Error()}, ctx.Err()
		}
		writePackageManifest(t, pkgDir, "@openai/codex", MinSupportedCodexVersion)
		codexPath := filepath.Join(pkgDir, "bin", "codex")
		writeExecutable(t, codexPath, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex "+MinSupportedCodexVersion+"'; exit 0; fi\nsleep 5\n")
		// Platform support was already checked on the test goroutine below, so ok
		// is true here.
		platformPath := requireTestCodexPlatformBinaryPath(t, pkgDir)
		writeExecutable(t, platformPath, "#!/bin/sh\nexit 0\n")
		if err := os.Symlink(codexPath, filepath.Join(binDir, "codex-test")); err != nil {
			t.Errorf("symlink codex: %v", err)
			return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, err
		}
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}
	_ = requireTestCodexPlatformBinaryPath(t, pkgDir)
	go func() {
		result, err := service.RunAction(context.Background(), RunActionInput{
			Provider: "codex",
			ActionID: ActionInstall,
		})
		if err != nil {
			t.Errorf("RunAction() error = %v", err)
		}
		done <- result
	}()

	select {
	case <-installStarted:
	case result := <-done:
		t.Fatalf("RunAction completed before install started: %#v", result)
	}
	defer releaseInstallOnce.Do(func() { close(releaseInstall) })
	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	status := onlyStatus(t, snapshot)
	if status.ActiveAction == nil {
		t.Fatal("ActiveAction = nil, want running install action")
	}
	if status.ActiveAction.Registry != "https://registry.example.test" {
		t.Fatalf("ActiveAction.Registry = %q, want registry override", status.ActiveAction.Registry)
	}
	if status.ActiveAction.NodeTarget != managedNode {
		t.Fatalf("ActiveAction.NodeTarget = %q, want %q", status.ActiveAction.NodeTarget, managedNode)
	}
	if !strings.Contains(status.ActiveAction.Stdout, "fetching @openai/codex") {
		t.Fatalf("ActiveAction.Stdout = %q, want npm stdout", status.ActiveAction.Stdout)
	}

	releaseInstallOnce.Do(func() { close(releaseInstall) })
	result := <-done
	if result.Status != RunActionCompleted {
		t.Fatalf("Status = %q, want completed; result=%#v", result.Status, result)
	}
}

func TestServiceRunActionReportsActiveActionForClaudeInstall(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	entry := filepath.Join(home, "claude-sdk-sidecar", "src", "main.ts")
	if err := os.MkdirAll(filepath.Dir(entry), 0o755); err != nil {
		t.Fatalf("mkdir sidecar entry dir: %v", err)
	}
	if err := os.WriteFile(entry, []byte("export {};"), 0o644); err != nil {
		t.Fatalf("write sidecar entry: %v", err)
	}
	runtimeRoot := fakeManagedRuntimeRoot(t)
	service := probeTestService(home)
	service.FileExists = fileExistsForTest
	service.Environ = func() []string {
		return []string{"PATH=" + binDir, claudeSDKSidecarEntryPathEnv + "=" + entry}
	}
	service.IsExecutableFile = isTestExecutable
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)
	service.Registry = Registry{Specs: []ProviderSpec{{
		Provider:       "claude-code",
		BinaryNames:    []string{"claude-test"},
		AdapterCommand: []string{"claude-test"},
		Install: InstallerSpec{
			Kind:           InstallerKindShellCommand,
			DisplayCommand: "install claude test",
			ShellCommand:   "install claude test",
		},
		LoginArgs: []string{"auth", "login"},
	}}}

	installStarted := make(chan struct{})
	releaseInstall := make(chan struct{})
	done := make(chan RunActionResult, 1)
	var closeStartedOnce sync.Once
	service.InstallCommand = func(ctx context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		input.OnStdout("installing claude")
		closeStartedOnce.Do(func() { close(installStarted) })
		select {
		case <-releaseInstall:
		case <-ctx.Done():
			return InstallCommandResult{ExitCode: 1, Stderr: ctx.Err().Error()}, ctx.Err()
		}
		writeExecutable(t, filepath.Join(binDir, "claude-test"), "#!/bin/sh\nexit 0\n")
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}
	go func() {
		result, err := service.RunAction(context.Background(), RunActionInput{
			Provider: "claude-code",
			ActionID: ActionInstall,
		})
		if err != nil {
			t.Errorf("RunAction() error = %v", err)
		}
		done <- result
	}()

	select {
	case <-installStarted:
	case result := <-done:
		t.Fatalf("RunAction completed before install started: %#v", result)
	}
	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"claude-code"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	status := onlyStatus(t, snapshot)
	if status.ActiveAction == nil {
		t.Fatal("ActiveAction = nil, want running install action")
	}
	if status.ActiveAction.Step != "cli" {
		t.Fatalf("ActiveAction.Step = %q, want cli", status.ActiveAction.Step)
	}
	if !strings.Contains(status.ActiveAction.Stdout, "installing claude") {
		t.Fatalf("ActiveAction.Stdout = %q, want installer stdout", status.ActiveAction.Stdout)
	}

	close(releaseInstall)
	result := <-done
	if result.Status != RunActionCompleted {
		t.Fatalf("Status = %q, want completed; result=%#v", result.Status, result)
	}
	snapshot, err = service.List(context.Background(), ListInput{Providers: []string{"claude-code"}})
	if err != nil {
		t.Fatalf("List() after install error = %v", err)
	}
	if activeAction := onlyStatus(t, snapshot).ActiveAction; activeAction != nil {
		t.Fatalf("ActiveAction = %#v, want cleared", activeAction)
	}
}

func TestServiceDownloadFileRetriesRetryableStatus(t *testing.T) {
	var attempts atomic.Int32
	installerServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		if attempts.Add(1) < 3 {
			http.Error(writer, "try again", http.StatusInternalServerError)
			return
		}
		_, _ = writer.Write([]byte("downloaded"))
	}))
	defer installerServer.Close()

	service := Service{HTTPClient: installerServer.Client()}
	destinationPath := filepath.Join(t.TempDir(), "asset.txt")
	if err := service.downloadFile(context.Background(), installerServer.URL+"/asset.txt", destinationPath); err != nil {
		t.Fatalf("downloadFile() error = %v", err)
	}
	if attempts.Load() != 3 {
		t.Fatalf("attempts = %d, want 3", attempts.Load())
	}
	content, err := os.ReadFile(destinationPath)
	if err != nil {
		t.Fatalf("read destination: %v", err)
	}
	if string(content) != "downloaded" {
		t.Fatalf("downloaded content = %q, want downloaded", string(content))
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
	forceClaudeACPRuntime(t)

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
	forceClaudeACPRuntime(t)
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

	// Give the second install attempt enough time to reach the install lock. The
	// lock polls, so a short sleep can let the second goroutine start only after
	// the first install has completed.
	time.Sleep(2 * npmGlobalInstallLockPollInterval)
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
	forceClaudeACPRuntime(t)

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
	forceClaudeACPRuntime(t)

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

func TestServiceResolveProviderCommandPrefersUserNodeForCodex(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	writeExecutable(t, filepath.Join(binDir, "codex"), "#!/usr/bin/env node\n")
	writeExecutable(t, filepath.Join(binDir, nodeBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	runtimeRoot := fakeManagedRuntimeRoot(t)

	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{"PATH=" + binDir}
	}
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)

	result, err := service.ResolveProviderCommand(context.Background(), "codex")
	if err != nil {
		t.Fatalf("ResolveProviderCommand() error = %v", err)
	}
	if !slices.Equal(result.Command, []string{"codex", "app-server"}) {
		t.Fatalf("Command = %#v, want codex app-server", result.Command)
	}
	managedNode := filepath.Join(runtimeRoot, "node", "bin", nodeBinaryNameForTest())
	if slices.Contains(result.Env, "TUTTI_APP_NODE="+managedNode) {
		t.Fatalf("Env = %#v, must not inject managed node when user node is available", result.Env)
	}
}

func TestServiceResolveProviderCommandFallsBackToManagedNodeForCodex(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	writeExecutable(t, filepath.Join(binDir, "codex"), "#!/usr/bin/env node\n")
	runtimeRoot := fakeManagedRuntimeRoot(t)

	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{"PATH=" + binDir}
	}
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)

	result, err := service.ResolveProviderCommand(context.Background(), "codex")
	if err != nil {
		t.Fatalf("ResolveProviderCommand() error = %v", err)
	}
	if !slices.Equal(result.Command, []string{"codex", "app-server"}) {
		t.Fatalf("Command = %#v, want codex app-server", result.Command)
	}
	managedNode := filepath.Join(runtimeRoot, "node", "bin", nodeBinaryNameForTest())
	if !slices.Contains(result.Env, "TUTTI_APP_NODE="+managedNode) {
		t.Fatalf("Env = %#v, want managed node fallback", result.Env)
	}
}

func TestServiceResolveProviderCommandDefaultsClaudeCodeToSDKSidecar(t *testing.T) {
	t.Setenv(claudeCodeRuntimeEnv, "")

	home := t.TempDir()
	entry := filepath.Join(home, "claude-sdk-sidecar", "src", "main.ts")
	if err := os.MkdirAll(filepath.Dir(entry), 0o755); err != nil {
		t.Fatalf("mkdir sidecar entry dir: %v", err)
	}
	if err := os.WriteFile(entry, []byte("export {};"), 0o644); err != nil {
		t.Fatalf("write sidecar entry: %v", err)
	}
	runtimeRoot := fakeManagedRuntimeRoot(t)
	service := probeTestService(home)
	service.FileExists = fileExistsForTest
	service.Environ = func() []string {
		return []string{"PATH=/usr/bin:/bin", claudeSDKSidecarEntryPathEnv + "=" + entry}
	}
	service.ExternalAgentRegistry = externalagentregistry.Store{
		SourceURL: filepath.Join(home, "missing-registry.json"),
	}
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)

	result, err := service.ResolveProviderCommand(context.Background(), "claude-code")
	if err != nil {
		t.Fatalf("ResolveProviderCommand() error = %v", err)
	}
	managedNode := filepath.Join(runtimeRoot, "node", "bin", nodeBinaryNameForTest())
	if !slices.Equal(result.Command, []string{managedNode, claudeSDKSidecarDefaultNodeArg, entry}) {
		t.Fatalf("Command = %#v, want SDK sidecar command", result.Command)
	}
	if slices.Contains(result.Command, "exec") || slices.Contains(result.Command, "@agentclientprotocol/claude-agent-acp") {
		t.Fatalf("Command = %#v, must not use ACP registry package in SDK mode", result.Command)
	}
}

func TestServiceListClaudeCodeSDKDoesNotRequireACPAdapter(t *testing.T) {
	t.Setenv(claudeCodeRuntimeEnv, "")

	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	claudePath := filepath.Join(binDir, "claude")
	writeExecutable(t, claudePath, "#!/bin/sh\nexit 0\n")
	entry := filepath.Join(home, "claude-sdk-sidecar", "src", "main.ts")
	if err := os.MkdirAll(filepath.Dir(entry), 0o755); err != nil {
		t.Fatalf("mkdir sidecar entry dir: %v", err)
	}
	if err := os.WriteFile(entry, []byte("export {};"), 0o644); err != nil {
		t.Fatalf("write sidecar entry: %v", err)
	}
	runtimeRoot := fakeManagedRuntimeRoot(t)
	service := probeTestService(home)
	service.FileExists = fileExistsForTest
	service.Environ = func() []string {
		return []string{"PATH=" + binDir, claudeSDKSidecarEntryPathEnv + "=" + entry}
	}
	service.LookPath = func(name string) (string, error) {
		if name == "claude" {
			return claudePath, nil
		}
		return "", errors.New("not found")
	}
	service.IsExecutableFile = isTestExecutable
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	service.ExternalAgentRegistry = externalagentregistry.Store{
		SourceURL: filepath.Join(home, "missing-registry.json"),
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"claude-code"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityReady {
		t.Fatalf("Availability.Status = %q, want ready; reason=%q", status.Availability.Status, status.Availability.ReasonCode)
	}
	if strings.HasPrefix(status.Availability.ReasonCode, "acp_adapter") {
		t.Fatalf("ReasonCode = %q, must not report ACP adapter in SDK mode", status.Availability.ReasonCode)
	}
	if !status.Adapter.Installed {
		t.Fatalf("Adapter.Installed = false, want SDK sidecar runtime installed; status=%#v", status)
	}
	if strings.Contains(strings.Join(status.Adapter.Command, " "), "claude-agent-acp") {
		t.Fatalf("Adapter.Command = %#v, must not use ACP adapter", status.Adapter.Command)
	}
}

func TestServiceListClaudeCodeSDKReportsMissingSidecarEntry(t *testing.T) {
	t.Setenv(claudeCodeRuntimeEnv, "")

	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	claudePath := filepath.Join(binDir, "claude")
	writeExecutable(t, claudePath, "#!/bin/sh\nexit 0\n")
	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{"PATH=" + binDir, claudeSDKSidecarEntryPathEnv + "=" + filepath.Join(home, "missing-main.ts")}
	}
	service.LookPath = func(name string) (string, error) {
		if name == "claude" {
			return claudePath, nil
		}
		return "", errors.New("not found")
	}
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"claude-code"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityNotInstalled {
		t.Fatalf("Availability.Status = %q, want not_installed", status.Availability.Status)
	}
	if status.Availability.ReasonCode != ReasonClaudeSDKSidecarUnavailable {
		t.Fatalf("ReasonCode = %q, want %q", status.Availability.ReasonCode, ReasonClaudeSDKSidecarUnavailable)
	}
	if status.Adapter.Installed {
		t.Fatal("Adapter.Installed = true, want false when SDK sidecar entry is missing")
	}
}

func TestServiceRunActionDoesNotInstallTemporarilyUnsupportedProvider(t *testing.T) {
	service := testService(func(name string) (string, error) {
		return "/usr/local/bin/" + name, nil
	}, map[string]bool{"/home/test/.hermes/auth.json": true})
	installCalled := false
	service.InstallCommand = func(context.Context, InstallCommandInput) (InstallCommandResult, error) {
		installCalled = true
		return InstallCommandResult{ExitCode: 0}, nil
	}

	result, err := service.RunAction(context.Background(), RunActionInput{
		Provider: "hermes",
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

func TestServiceListReportsReadyForClaudeAPIBillingWithEnvKey(t *testing.T) {
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
			return []string{"PATH=/usr/bin:/bin", "ANTHROPIC_API_KEY=sk-test"}
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
	if status.Availability.Status != AvailabilityReady {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityReady)
	}
	if status.Auth.Status != AuthAuthenticated {
		t.Fatalf("Auth.Status = %q, want %q", status.Auth.Status, AuthAuthenticated)
	}
	if status.Auth.AccountLabel != "API Usage Billing" {
		t.Fatalf("Auth.AccountLabel = %q, want %q", status.Auth.AccountLabel, "API Usage Billing")
	}
}

func TestServiceListReportsReadyForClaudeAPIBillingWithSettingsKey(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	claudePath := filepath.Join(binDir, "claude")
	writeExecutable(t, claudePath, "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(binDir, "claude-agent-acp"), "#!/bin/sh\nexit 0\n")
	writePackageManifest(t, binDir, "@agentclientprotocol/claude-agent-acp", "0.46.0")
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o755); err != nil {
		t.Fatalf("mkdir .claude dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude", "settings.json"), []byte(`{"env":{"ANTHROPIC_API_KEY":"sk-test"}}`), 0o600); err != nil {
		t.Fatalf("write settings.json: %v", err)
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
	if status.Availability.Status != AvailabilityReady {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityReady)
	}
	if status.Auth.Status != AuthAuthenticated {
		t.Fatalf("Auth.Status = %q, want %q", status.Auth.Status, AuthAuthenticated)
	}
	if status.Auth.AccountLabel != "API Usage Billing" {
		t.Fatalf("Auth.AccountLabel = %q, want %q", status.Auth.AccountLabel, "API Usage Billing")
	}
}

func TestServiceListReportsReadyForClaudeAPIBillingDespiteOauthTokenStatus(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	claudePath := filepath.Join(binDir, "claude")
	writeExecutable(t, claudePath, "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(binDir, "claude-agent-acp"), "#!/bin/sh\nexit 0\n")
	writePackageManifest(t, binDir, "@agentclientprotocol/claude-agent-acp", "0.46.0")
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o755); err != nil {
		t.Fatalf("mkdir .claude dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude", "settings.json"), []byte(`{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-test","ANTHROPIC_BASE_URL":"https://api.moonshot.cn/anthropic"}}`), 0o600); err != nil {
		t.Fatalf("write settings.json: %v", err)
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
		RunAuthStatusCommand: func(_ context.Context, spec ProviderSpec, binaryPath string) (AuthInfo, bool) {
			if spec.Provider != "claude-code" {
				t.Fatalf("auth status provider = %q, want claude-code", spec.Provider)
			}
			if binaryPath != claudePath {
				t.Fatalf("auth status binaryPath = %q, want %q", binaryPath, claudePath)
			}
			// Simulate a CLI that reports an OAuth-style authMethod even though
			// the user is actually configured for API Usage Billing.
			return AuthInfo{Status: AuthAuthenticated, AuthMethod: "oauth_token", AccountLabel: "oauth_token"}, true
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
	if status.Auth.AuthMethod != "apiKey" {
		t.Fatalf("Auth.AuthMethod = %q, want %q", status.Auth.AuthMethod, "apiKey")
	}
	if status.Auth.AccountLabel != "API Usage Billing" {
		t.Fatalf("Auth.AccountLabel = %q, want %q", status.Auth.AccountLabel, "API Usage Billing")
	}
}

// Codex can run with OPENAI_API_KEY (or config.toml api_key) without a ChatGPT
// login. `codex login status` only reflects the OAuth session, so an API-key
// user is reported as "Not logged in" even though the CLI can already run.
// Detect the credential and treat the provider as ready instead of blocking.
func TestServiceListReportsReadyForCodexAPIKeyWithoutLogin(t *testing.T) {
	service := testService(func(name string) (string, error) {
		return "/usr/local/bin/" + name, nil
	}, map[string]bool{})
	service.Environ = func() []string {
		return []string{"OPENAI_API_KEY=sk-test"}
	}
	service.RunAuthStatusCommand = func(_ context.Context, spec ProviderSpec, binaryPath string) (AuthInfo, bool) {
		if spec.Provider != "codex" {
			t.Fatalf("Provider = %q, want codex", spec.Provider)
		}
		if binaryPath != "/usr/local/bin/codex" {
			t.Fatalf("binaryPath = %q, want /usr/local/bin/codex", binaryPath)
		}
		return parseCodexAuthStatusOutput([]byte("Not logged in"))
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
	if status.Auth.AuthMethod != "apiKey" {
		t.Fatalf("Auth.AuthMethod = %q, want %q", status.Auth.AuthMethod, "apiKey")
	}
	if status.Auth.AccountLabel != "API Usage Billing" {
		t.Fatalf("Auth.AccountLabel = %q, want %q", status.Auth.AccountLabel, "API Usage Billing")
	}
}

func TestServiceListReportsReadyForCodexConfigTomlAPIKeyWithoutLogin(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o755); err != nil {
		t.Fatalf("mkdir .codex: %v", err)
	}
	if err := os.WriteFile(filepath.Join(home, ".codex", "config.toml"), []byte("api_key = \"sk-inline\"\n"), 0o600); err != nil {
		t.Fatalf("write config.toml: %v", err)
	}
	service := testService(func(name string) (string, error) {
		return "/usr/local/bin/" + name, nil
	}, map[string]bool{})
	service.HomeDir = func() (string, error) { return home, nil }
	service.Environ = func() []string { return []string{} }
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return parseCodexAuthStatusOutput([]byte("Not logged in"))
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
	if status.Auth.AuthMethod != "apiKey" {
		t.Fatalf("Auth.AuthMethod = %q, want apiKey", status.Auth.AuthMethod)
	}
	if status.Auth.AccountLabel != "API Usage Billing" {
		t.Fatalf("Auth.AccountLabel = %q, want %q", status.Auth.AccountLabel, "API Usage Billing")
	}
}

// A bare custom endpoint (no API credential) must NOT be mislabeled as API
// Usage Billing. The user may be on an OAuth/subscription session against that
// endpoint, so the CLI-reported auth status and label must be preserved.
func TestServiceListDoesNotMislabelCustomEndpointOnlyAsAPIBilling(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	claudePath := filepath.Join(binDir, "claude")
	writeExecutable(t, claudePath, "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(binDir, "claude-agent-acp"), "#!/bin/sh\nexit 0\n")
	writePackageManifest(t, binDir, "@agentclientprotocol/claude-agent-acp", "0.46.0")
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o755); err != nil {
		t.Fatalf("mkdir .claude dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude", "settings.json"), []byte(`{"env":{"ANTHROPIC_BASE_URL":"https://gw.local"}}`), 0o600); err != nil {
		t.Fatalf("write settings.json: %v", err)
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
		RunAuthStatusCommand: func(_ context.Context, _ ProviderSpec, _ string) (AuthInfo, bool) {
			return AuthInfo{Status: AuthAuthenticated, AuthMethod: "oauth", AccountLabel: "me@x.com"}, true
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
	if status.Auth.AuthMethod != "oauth" {
		t.Fatalf("Auth.AuthMethod = %q, want oauth (not overridden to apiKey)", status.Auth.AuthMethod)
	}
	if status.Auth.AccountLabel != "me@x.com" {
		t.Fatalf("Auth.AccountLabel = %q, want me@x.com (CLI label preserved)", status.Auth.AccountLabel)
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
	if auth.AuthMethod != "oauth" {
		t.Fatalf("AuthMethod = %q, want oauth", auth.AuthMethod)
	}
}

func TestParseClaudeAuthStatusOutputReportsAuthMethodWhenNotLoggedIn(t *testing.T) {
	auth, ok := parseClaudeAuthStatusOutput([]byte(`{"loggedIn":false,"authMethod":"apiKey"}`))
	if !ok {
		t.Fatal("parseClaudeAuthStatusOutput ok = false, want true")
	}
	if auth.Status != AuthRequired {
		t.Fatalf("Status = %q, want %q", auth.Status, AuthRequired)
	}
	if auth.AuthMethod != "apiKey" {
		t.Fatalf("AuthMethod = %q, want apiKey", auth.AuthMethod)
	}
}

func TestParseClaudeAuthMarkerContentReportsAuthenticated(t *testing.T) {
	auth, ok := parseClaudeAuthMarkerContent([]byte(`{"loggedIn":true,"email":"dev@example.com","authMethod":"oauth"}`))
	if !ok {
		t.Fatal("parseClaudeAuthMarkerContent ok = false, want true")
	}
	if auth.Status != AuthAuthenticated {
		t.Fatalf("Status = %q, want %q", auth.Status, AuthAuthenticated)
	}
	if auth.AccountLabel != "dev@example.com" {
		t.Fatalf("AccountLabel = %q, want dev@example.com", auth.AccountLabel)
	}
	if auth.AuthMethod != "oauth" {
		t.Fatalf("AuthMethod = %q, want oauth", auth.AuthMethod)
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
	specs, err := DefaultRegistry().Select([]string{"claude", "claude-code", "cursor-agent"})
	if err != nil {
		t.Fatalf("Select() error = %v", err)
	}
	if len(specs) != 2 {
		t.Fatalf("len(specs) = %d, want 2", len(specs))
	}
	if specs[0].Provider != "claude-code" {
		t.Fatalf("specs[0].Provider = %q, want claude-code", specs[0].Provider)
	}
	if specs[1].Provider != "cursor" {
		t.Fatalf("specs[1].Provider = %q, want cursor", specs[1].Provider)
	}
}

func TestServiceSelectInstallDirPrefersUserLocalBin(t *testing.T) {
	home := t.TempDir()
	// A writable directory on PATH must NOT be preferred over the stable
	// user-global ~/.local/bin (created on demand).
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
	want := filepath.Join(home, ".local", "bin")
	if installDir != want {
		t.Fatalf("installDir = %q, want %q", installDir, want)
	}
}

func TestServiceSelectInstallDirFallsBackToPathDirWhenHomeUnavailable(t *testing.T) {
	root := t.TempDir()
	pathDir := filepath.Join(root, "custom-bin")
	if err := os.MkdirAll(pathDir, 0o755); err != nil {
		t.Fatalf("mkdir path dir: %v", err)
	}
	service := Service{
		Environ: func() []string {
			return []string{"PATH=" + pathDir}
		},
		HomeDir: func() (string, error) {
			return "", errors.New("home unavailable")
		},
	}

	installDir, err := service.selectInstallDir()
	if err != nil {
		t.Fatalf("selectInstallDir() error = %v", err)
	}
	if installDir != pathDir {
		t.Fatalf("installDir = %q, want %q (PATH fallback)", installDir, pathDir)
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

func forceClaudeACPRuntime(t *testing.T) {
	t.Helper()
	t.Setenv(claudeCodeRuntimeEnv, claudeCodeRuntimeACP)
}

func assertProviderCheck(t *testing.T, checks []ProviderCheck, name string, passed bool) {
	t.Helper()
	for _, check := range checks {
		if check.Name == name {
			if check.Passed != passed {
				t.Fatalf("check %q passed = %v, want %v; checks=%#v", name, check.Passed, passed, checks)
			}
			return
		}
	}
	t.Fatalf("check %q missing in %#v", name, checks)
}

func isTestExecutable(path string) bool {
	stat, err := os.Stat(path)
	return err == nil && !stat.IsDir() && stat.Mode().Perm()&0111 != 0
}

func fileExistsForTest(path string) bool {
	stat, err := os.Stat(path)
	return err == nil && !stat.IsDir()
}

func isTestExecutableUnderHome(home string) func(string) bool {
	return func(path string) bool {
		homePath, err := filepath.EvalSymlinks(home)
		if err != nil {
			homePath = home
		}
		resolvedPath, err := filepath.EvalSymlinks(path)
		if err != nil {
			resolvedPath = path
		}
		rel, err := filepath.Rel(homePath, resolvedPath)
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
