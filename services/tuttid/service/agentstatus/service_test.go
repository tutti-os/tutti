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

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerstatus"
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
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
	if install.ManagedNPM.BinaryName != "tutti-agent" {
		t.Fatalf("BinaryName = %q, want tutti-agent", install.ManagedNPM.BinaryName)
	}
	if install.ManagedNPM.PackageVersion != providerregistry.TuttiAgentRecommendedVersion {
		t.Fatalf("PackageVersion = %q, want %q", install.ManagedNPM.PackageVersion, providerregistry.TuttiAgentRecommendedVersion)
	}
	if !install.ManagedNPM.IncludeOptional {
		t.Fatalf("IncludeOptional = false, want true")
	}
	if specs[0].LoginActionKind != ActionKindDaemonAction {
		t.Fatalf("LoginActionKind = %q, want %q", specs[0].LoginActionKind, ActionKindDaemonAction)
	}
}

func TestServiceListUsesDescriptorOwnedDaemonLoginAction(t *testing.T) {
	service, _ := updateTestService(t, providerregistry.TuttiAgentMinVersion)

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"tutti-agent"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	action := firstAction(t, onlyStatus(t, snapshot).Actions)
	if action.ID != ActionLogin || action.Kind != ActionKindDaemonAction || action.Command != nil {
		t.Fatalf("login action = %#v, want descriptor-owned daemon action", action)
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

func TestParseCursorAboutJSON(t *testing.T) {
	output := []byte(`{
		"cliVersion": "2026.07.01-41b2de7",
		"subscriptionTier": "Ultra",
		"userEmail": "user@example.com"
	}`)
	auth, cliVersion, ok := parseCursorAboutJSONWithVersion(output)
	if !ok {
		t.Fatal("parseCursorAboutJSONWithVersion() ok = false, want true")
	}
	if cliVersion != "2026.07.01-41b2de7" {
		t.Fatalf("cliVersion = %q, want 2026.07.01-41b2de7", cliVersion)
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
	auth, cliVersion, ok := parseCursorAboutTextWithVersion([]byte(`About Cursor CLI

CLI Version         2026.07.01-41b2de7
Subscription Tier   Ultra
User Email          user@example.com
`))
	if !ok {
		t.Fatal("parseCursorAboutTextWithVersion() ok = false, want true")
	}
	if cliVersion != "2026.07.01-41b2de7" {
		t.Fatalf("cliVersion = %q, want 2026.07.01-41b2de7", cliVersion)
	}
	if auth.AccountLabel != "Cursor Ultra · user@example.com" {
		t.Fatalf("accountLabel = %q, want Cursor Ultra · user@example.com", auth.AccountLabel)
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
	service.CodexAuthProbe = func(context.Context, []string, []string) CodexAuthProbeEvidence {
		return CodexAuthProbeEvidence{State: agentruntime.CodexAppServerAccountRequired}
	}

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
	// Codex repair is deliberately stricter. This preserves the existing
	// separate-adapter behavior for providers that do not have Codex's
	// first-party app-server diagnostics.
	spec.Provider = "nexight"
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
	service.CodexAuthProbe = func(context.Context, []string, []string) CodexAuthProbeEvidence {
		return CodexAuthProbeEvidence{
			State:        agentruntime.CodexAppServerAccountAuthenticated,
			AccountLabel: "dev@example.com",
			AuthMethod:   "chatgpt",
		}
	}
	service.RemoteAuthProbe = func(context.Context, ProviderSpec) (providerstatus.AuthEvidence, bool) {
		return providerstatus.AuthEvidence{Kind: providerstatus.AuthEvidenceRemoteSuccess}, true
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

func TestServiceListUsesCodexAppServerAccountCommand(t *testing.T) {
	service := testService(func(name string) (string, error) {
		return "/usr/local/bin/" + name, nil
	}, map[string]bool{})
	service.RunAuthStatusCommand = func(_ context.Context, spec ProviderSpec, binaryPath string) (AuthInfo, bool) {
		if spec.Provider != "codex" {
			t.Fatalf("Provider = %q, want codex", spec.Provider)
		}
		if strings.Join(spec.AuthStatusCommand, " ") != `-c service_tier="fast" app-server` {
			t.Fatalf("AuthStatusCommand = %v, want app-server with service tier override", spec.AuthStatusCommand)
		}
		if spec.AuthCommandRunnerKind != providerregistry.AuthCommandRunnerKindCodexAppServerAccount {
			t.Fatalf("AuthCommandRunnerKind = %q, want Codex app-server account probe", spec.AuthCommandRunnerKind)
		}
		if binaryPath != "/usr/local/bin/codex" {
			t.Fatalf("binaryPath = %q, want /usr/local/bin/codex", binaryPath)
		}
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	service.RemoteAuthProbe = func(context.Context, ProviderSpec) (providerstatus.AuthEvidence, bool) {
		return providerstatus.AuthEvidence{Kind: providerstatus.AuthEvidenceRemoteSuccess}, true
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

func TestServiceListReportsCodexAPIKeyAsConfiguredWithoutRemoteEvidence(t *testing.T) {
	service := testService(func(name string) (string, error) {
		return "/usr/local/bin/" + name, nil
	}, map[string]bool{})
	service.Environ = func() []string {
		return []string{"OPENAI_API_KEY=sk-test"}
	}
	service.RunAuthStatusCommand = func(
		context.Context,
		ProviderSpec,
		string,
	) (AuthInfo, bool) {
		return AuthInfo{Status: AuthRequired}, true
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityReady {
		t.Fatalf("availability = %q, want %q", status.Availability.Status, AvailabilityReady)
	}
	if status.Auth.Status != AuthConfigured ||
		status.Auth.AuthMethod != "apiKey" ||
		status.Auth.AccountLabel != "API Usage Billing" {
		t.Fatalf("auth = %#v, want configured API billing credentials", status.Auth)
	}
}

func TestServiceStatusReportsOpenCodeConfigAPIKeyAsConfiguredWithoutRemoteEvidence(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".config", "opencode", "opencode.json"), `{
		"provider": {
			"newapi": {"options": {"apiKey": "sk-test"}}
		}
	}`)

	service := customConfigService(home)
	service.LookPath = func(string) (string, error) {
		return filepath.Join(home, "opencode"), nil
	}
	service.IsExecutableFile = func(string) bool { return true }
	service.RunOutcomes = NewRunOutcomeStore()
	specs, err := DefaultRegistry().Select([]string{agentprovider.OpenCode})
	if err != nil {
		t.Fatalf("Select(opencode) error = %v", err)
	}
	status := service.statusForSpec(
		context.Background(),
		specs[0],
		time.Now(),
		statusDetectionOptions{skipAdapterProbe: true},
	)
	if status.Availability.Status != AvailabilityReady {
		t.Fatalf("availability = %q, want %q", status.Availability.Status, AvailabilityReady)
	}
	if status.Auth.Status != AuthConfigured ||
		status.Auth.AuthMethod != "apiKey" ||
		status.Auth.AccountLabel != "API Usage Billing" {
		t.Fatalf("auth = %#v, want configured API billing credentials", status.Auth)
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
		return providerstatus.ParseAuthStatusOutput(
			spec.AuthOutputParserKind,
			[]byte("Error loading configuration: /home/test/.codex/config.toml:8:16: unknown variant `priority`, expected `fast` or `flex`"),
		)
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
	writeExecutable(t, codexPath, codexAppServerFakeScript("if [ \"$1\" = \"--version\" ]; then echo 'codex 0.100.0'; exit 0; fi\nexit 0\n"))
	visiblePath := filepath.Join(binDir, "codex")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	if err := os.Symlink(codexPath, visiblePath); err != nil {
		t.Fatalf("symlink codex: %v", err)
	}
	service := probeTestService(home)
	// The default 1s probe timeout is tuned for the old "still alive after
	// 200ms" liveness check; the real ACP handshake needs to actually spawn,
	// write, and read a response, which is slower under test-suite load.
	service.ProbeTimeout = 5 * time.Second
	service.Environ = func() []string {
		return []string{"PATH=" + binDir}
	}
	service.IsExecutableFile = isTestExecutable
	service.CodexProtocolProbe = codexProtocolReadyFixture
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
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
	if status.Availability.Status != AvailabilityUnsupported {
		t.Fatalf("Availability.Status = %q, want unsupported", status.Availability.Status)
	}
}

// TestServiceListReportsCodexNotReadyWhenAppServerNeverRespondsToInitialize
// covers Agent 可用性需求摘要 issue #1: a `codex` binary can be present on
// PATH and start successfully (e.g. a launcher shim bundled with a desktop
// app) without ever actually being able to serve ACP. The old probe only
// checked that the process stayed alive, which this fake satisfies; the real
// `initialize` handshake must still catch it and report "not installed"
// instead of "ready".
func TestServiceListReportsCodexNotReadyWhenAppServerNeverRespondsToInitialize(t *testing.T) {
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
	writeExecutable(t, platformBinary, "#!/bin/sh\nexit 0\n")

	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{"PATH=" + binDir}
	}
	service.IsExecutableFile = isTestExecutable
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if !status.CLI.Installed {
		t.Fatal("CLI.Installed = false, want true (the binary is on PATH)")
	}
	if status.Adapter.Installed {
		t.Fatal("Adapter.Installed = true, want false (it never answered the ACP handshake)")
	}
	if status.Availability.Status != AvailabilityNotInstalled {
		t.Fatalf("Availability.Status = %q, want %q; status=%#v", status.Availability.Status, AvailabilityNotInstalled, status)
	}
	if status.Availability.ReasonCode != "acp_adapter_launch_failed" {
		t.Fatalf("ReasonCode = %q, want acp_adapter_launch_failed", status.Availability.ReasonCode)
	}
}

// TestServiceListReportsCodexNotReadyWhenAppServerRejectsInitialize covers the
// same gap for a binary that does speak JSON-RPC but answers `initialize`
// with a protocol error instead of a real result.
func TestServiceListReportsCodexNotReadyWhenAppServerRejectsInitialize(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	pkgDir := filepath.Join(home, "lib", "node_modules", "@openai", "codex")
	writePackageManifest(t, pkgDir, "@openai/codex", MinSupportedCodexVersion)
	codexPath := filepath.Join(pkgDir, "bin", "codex")
	writeExecutable(t, codexPath, "#!/bin/sh\n"+
		"if [ \"$1\" = \"--version\" ]; then echo 'codex "+MinSupportedCodexVersion+"'; exit 0; fi\n"+
		"case \"$*\" in\n"+
		"*app-server*) echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"unsupported\"}}'; exit 1 ;;\n"+
		"esac\n"+
		"exit 0\n")
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
		return []string{"PATH=" + binDir}
	}
	service.IsExecutableFile = isTestExecutable
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityNotInstalled {
		t.Fatalf("Availability.Status = %q, want %q; status=%#v", status.Availability.Status, AvailabilityNotInstalled, status)
	}
	if status.Availability.ReasonCode != "acp_adapter_launch_failed" {
		t.Fatalf("ReasonCode = %q, want acp_adapter_launch_failed", status.Availability.ReasonCode)
	}
}

// TestServiceListReportsCodexNotReadyWhenAppServerSpoofsHandshake covers a
// "fake shell" binary that never reads stdin (so it cannot possibly have
// parsed our `initialize` request, let alone learned the unpredictable id
// this probe run generated for it) but still races to print a
// response-shaped line before exiting. Every case below hardcodes id 1,
// which the one-shot runtime probe deliberately never generates, so these
// can never accidentally match by chance; the handshake match must still
// reject them for the reasons in each case's name. Unlike Standard
// ACP, this deliberately does NOT test a missing "jsonrpc" field: the real
// codex app-server wire format omits that field too (see
// TestServiceListReportsCodexReadyWhenAppServerOmitsJSONRPCVersion), so
// that alone must not be treated as a spoof signal.
func TestServiceListReportsCodexNotReadyWhenAppServerSpoofsHandshake(t *testing.T) {
	for _, tt := range []struct {
		name string
		line string
	}{
		{name: "hardcoded id, never reads the request", line: `{"id":1,"result":{}}`},
		{name: "hardcoded id and echoes a method", line: `{"id":1,"method":"initialize","result":{}}`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			home := t.TempDir()
			binDir := filepath.Join(home, "bin")
			pkgDir := filepath.Join(home, "lib", "node_modules", "@openai", "codex")
			writePackageManifest(t, pkgDir, "@openai/codex", MinSupportedCodexVersion)
			codexPath := filepath.Join(pkgDir, "bin", "codex")
			writeExecutable(t, codexPath, "#!/bin/sh\n"+
				"if [ \"$1\" = \"--version\" ]; then echo 'codex "+MinSupportedCodexVersion+"'; exit 0; fi\n"+
				"case \"$*\" in\n"+
				"*app-server*) echo '"+tt.line+"'; exit 0 ;;\n"+
				"esac\n"+
				"exit 0\n")
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
				return []string{"PATH=" + binDir}
			}
			service.IsExecutableFile = isTestExecutable
			service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
				return AuthInfo{Status: AuthAuthenticated}, true
			}

			snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
			if err != nil {
				t.Fatalf("List() error = %v", err)
			}

			status := onlyStatus(t, snapshot)
			if status.Availability.Status != AvailabilityNotInstalled {
				t.Fatalf("Availability.Status = %q, want %q; status=%#v", status.Availability.Status, AvailabilityNotInstalled, status)
			}
			if status.Availability.ReasonCode != "acp_adapter_launch_failed" {
				t.Fatalf("ReasonCode = %q, want acp_adapter_launch_failed", status.Availability.ReasonCode)
			}
		})
	}
}

// TestServiceListReportsCodexReadyWhenAppServerOmitsJSONRPCVersion locks in
// that the real codex app-server wire format - which omits the "jsonrpc"
// version header entirely (see
// TestCodexAppServerAdapterWireFormatOmitsJSONRPCVersion in
// packages/agent/daemon/runtime) - is accepted by the handshake probe. The
// probe must not require a "jsonrpc" field the way the Standard ACP probe
// does, or it would misreport a working codex install as not installed.
func TestServiceListReportsCodexReadyWhenAppServerOmitsJSONRPCVersion(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	pkgDir := filepath.Join(home, "lib", "node_modules", "@openai", "codex")
	writePackageManifest(t, pkgDir, "@openai/codex", MinSupportedCodexVersion)
	codexPath := filepath.Join(pkgDir, "bin", "codex")
	// codexAppServerFakeScript omits "jsonrpc" (this test's whole point) but
	// still reads stdin and echoes back the real request id.
	writeExecutable(t, codexPath, codexAppServerFakeScript(
		"if [ \"$1\" = \"--version\" ]; then echo 'codex "+MinSupportedCodexVersion+"'; exit 0; fi\nexit 0\n"))
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
		return []string{"PATH=" + binDir}
	}
	service.IsExecutableFile = isTestExecutable
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityReady {
		t.Fatalf("Availability.Status = %q, want %q; status=%#v", status.Availability.Status, AvailabilityReady, status)
	}
}
func TestProbeTimeoutForSpecUsesProviderSpecificColdStartBounds(t *testing.T) {
	service := Service{ProbeTimeout: 3 * time.Second}
	for _, test := range []struct {
		name     string
		provider string
		want     time.Duration
	}{
		{name: "codex app-server", provider: "codex", want: 10 * time.Second},
		{name: "opencode npm shim", provider: "opencode", want: 30 * time.Second},
		{name: "cursor npm shim", provider: "cursor", want: 35 * time.Second},
		{name: "other standard ACP", provider: "nexight", want: 15 * time.Second},
		{name: "unknown provider keeps configured timeout", provider: "unknown", want: 3 * time.Second},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := service.probeTimeoutForSpec(ProviderSpec{Provider: test.provider}); got != test.want {
				t.Fatalf("probe timeout = %s, want %s", got, test.want)
			}
		})
	}

	configured := Service{ProbeTimeout: 40 * time.Second}
	for _, provider := range []string{"codex", "opencode"} {
		if got := configured.probeTimeoutForSpec(ProviderSpec{Provider: provider}); got != 40*time.Second {
			t.Fatalf("configured %s probe timeout = %s, want 40s", provider, got)
		}
	}
}

// TestServiceListStandardACPHandshakeProbe covers cursor and opencode: both
// are RuntimeKindStandardACP providers where the CLI binary itself, invoked
// as `<binary> acp`, IS the ACP adapter (the same "CLI is the adapter" shape
// codex has). Each gets the same three scenarios already covered for codex
// above: a real handshake succeeds, the adapter starts but never answers
// `initialize`, and the adapter answers with a JSON-RPC error.
func TestServiceListStandardACPHandshakeProbe(t *testing.T) {
	for _, tt := range []struct {
		name       string
		provider   string
		binaryName string
		script     string
		wantStatus AvailabilityStatus
		wantReason string
	}{
		{
			name:       "cursor ready when handshake succeeds",
			provider:   "cursor",
			binaryName: "cursor-agent",
			script:     standardACPFakeScript("exit 0\n"),
			wantStatus: AvailabilityReady,
		},
		{
			name:       "cursor not ready when acp never responds to initialize",
			provider:   "cursor",
			binaryName: "cursor-agent",
			script:     "#!/bin/sh\ncase \"$*\" in\n*acp*) sleep 5 ;;\nesac\nexit 0\n",
			wantStatus: AvailabilityUnknown,
			wantReason: "acp_adapter_launch_failed",
		},
		{
			name:       "cursor not ready when acp rejects initialize",
			provider:   "cursor",
			binaryName: "cursor-agent",
			script: "#!/bin/sh\ncase \"$*\" in\n" +
				"*acp*) echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"unsupported\"}}'; exit 1 ;;\n" +
				"esac\nexit 0\n",
			wantStatus: AvailabilityUnknown,
			wantReason: "acp_adapter_launch_failed",
		},
		{
			name:       "opencode ready when handshake succeeds",
			provider:   "opencode",
			binaryName: "opencode",
			script:     standardACPFakeScript("exit 0\n"),
			wantStatus: AvailabilityReady,
		},
		{
			name:       "opencode not ready when acp never responds to initialize",
			provider:   "opencode",
			binaryName: "opencode",
			script:     "#!/bin/sh\ncase \"$*\" in\n*acp*) sleep 5 ;;\nesac\nexit 0\n",
			wantStatus: AvailabilityUnknown,
			wantReason: "acp_adapter_launch_failed",
		},
		{
			name:       "opencode not ready when acp rejects initialize",
			provider:   "opencode",
			binaryName: "opencode",
			script: "#!/bin/sh\ncase \"$*\" in\n" +
				"*acp*) echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"unsupported\"}}'; exit 1 ;;\n" +
				"esac\nexit 0\n",
			wantStatus: AvailabilityUnknown,
			wantReason: "acp_adapter_launch_failed",
		},
		{
			// A "fake shell" that never reads stdin but races to print a
			// response-shaped line with the wrong id before exiting must
			// not be able to satisfy the handshake match.
			// newStandardACPHandshakeRequestID never generates 1 (see its doc
			// comment), so this hardcoded id can never accidentally match by
			// chance. This is the exact "never reads stdin" shim shape a
			// canned/fake ACP adapter would use.
			name:       "cursor not ready when acp spoofs handshake with hardcoded id, never reads the request",
			provider:   "cursor",
			binaryName: "cursor-agent",
			script: "#!/bin/sh\ncase \"$*\" in\n" +
				"*acp*) echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}'; exit 0 ;;\n" +
				"esac\nexit 0\n",
			wantStatus: AvailabilityUnknown,
			wantReason: "acp_adapter_launch_failed",
		},
		{
			name:       "cursor not ready when acp spoofs handshake without jsonrpc version",
			provider:   "cursor",
			binaryName: "cursor-agent",
			script: "#!/bin/sh\ncase \"$*\" in\n" +
				"*acp*) echo '{\"id\":1,\"result\":{}}'; exit 0 ;;\n" +
				"esac\nexit 0\n",
			wantStatus: AvailabilityUnknown,
			wantReason: "acp_adapter_launch_failed",
		},
		{
			name:       "opencode not ready when acp spoofs handshake with hardcoded id, never reads the request",
			provider:   "opencode",
			binaryName: "opencode",
			script: "#!/bin/sh\ncase \"$*\" in\n" +
				"*acp*) echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}'; exit 0 ;;\n" +
				"esac\nexit 0\n",
			wantStatus: AvailabilityUnknown,
			wantReason: "acp_adapter_launch_failed",
		},
		{
			name:       "opencode not ready when acp spoofs handshake without jsonrpc version",
			provider:   "opencode",
			binaryName: "opencode",
			script: "#!/bin/sh\ncase \"$*\" in\n" +
				"*acp*) echo '{\"id\":1,\"result\":{}}'; exit 0 ;;\n" +
				"esac\nexit 0\n",
			wantStatus: AvailabilityUnknown,
			wantReason: "acp_adapter_launch_failed",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			home := t.TempDir()
			binDir := filepath.Join(home, "bin")
			writeExecutable(t, filepath.Join(binDir, tt.binaryName), tt.script)

			service := probeTestService(home)
			service.Environ = func() []string {
				return []string{"PATH=" + binDir}
			}
			service.IsExecutableFile = isTestExecutable
			service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
				return AuthInfo{Status: AuthAuthenticated}, true
			}

			snapshot, err := service.List(context.Background(), ListInput{Providers: []string{tt.provider}})
			if err != nil {
				t.Fatalf("List() error = %v", err)
			}

			status := onlyStatus(t, snapshot)
			if status.Availability.Status != tt.wantStatus {
				t.Fatalf("Availability.Status = %q, want %q; status=%#v", status.Availability.Status, tt.wantStatus, status)
			}
			if tt.wantReason != "" && status.Availability.ReasonCode != tt.wantReason {
				t.Fatalf("ReasonCode = %q, want %q", status.Availability.ReasonCode, tt.wantReason)
			}
		})
	}
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
	writeExecutable(t, managedNode, codexAppServerFakeScript("if [ \"$2\" = \"--version\" ]; then echo 'codex "+MinSupportedCodexVersion+"'; exit 0; fi\nexit 0\n"))

	service := probeTestService(home)
	// The handshake probe execs through an extra `env`+managed-node hop here
	// (unlike the direct-binary fakes elsewhere in this file), which is
	// measurably slower under test-suite load; give it more headroom than the
	// default 1s probe timeout so this isn't flaky.
	service.ProbeTimeout = 15 * time.Second
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
	// The launcher simulates the field ENOENT: `codex app-server` fails because
	// the @openai/codex-<platform> subpackage is missing. The structural nested
	// platform binary is also absent (genuine incomplete install). Under the
	// behavior-first availability model the probe — not the npm layout — detects
	// this, classifying the ENOENT as codex_platform_pkg_incomplete.
	writeExecutable(t, codexPath, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex "+MinSupportedCodexVersion+"'; exit 0; fi\nif [ \"$1\" = \"app-server\" ]; then echo 'Cannot find module @openai/codex-darwin-arm64 (enoent)' >&2; exit 127; fi\nexit 0\n")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	writeExecutable(t, filepath.Join(binDir, npmBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(binDir, nodeBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	if err := os.Symlink(codexPath, filepath.Join(binDir, "codex")); err != nil {
		t.Fatalf("symlink codex: %v", err)
	}

	service := probeTestService(home)
	// Widen the probe ready-after window past shell-startup latency so a failing
	// app-server (exit 127) is observed as ProbeFailed rather than racing the
	// ready timer.
	service.ProbeReadyAfter = 1500 * time.Millisecond
	service.ProbeTimeout = 5 * time.Second
	service.Environ = func() []string {
		return []string{"PATH=" + binDir}
	}
	service.IsExecutableFile = isTestExecutable
	service.CodexProtocolProbe = codexProtocolFixture(codexPlatformENOENTFixture())
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
}

func TestServiceRunActionReinstallsCodexWhenPlatformPackageIncomplete(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	pkgDir := filepath.Join(home, "lib", "node_modules", "@openai", "codex")
	writePackageManifest(t, pkgDir, "@openai/codex", MinSupportedCodexVersion)
	codexPath := filepath.Join(pkgDir, "bin", "codex")
	writeExecutable(t, codexPath, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex "+MinSupportedCodexVersion+"'; exit 0; fi\nif [ \"$1\" = \"app-server\" ]; then echo 'Cannot find module @openai/codex-darwin-arm64 (enoent)' >&2; exit 127; fi\nexit 0\n")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	if err := os.Symlink(codexPath, filepath.Join(binDir, "codex")); err != nil {
		t.Fatalf("symlink codex: %v", err)
	}
	platformBinary := requireTestCodexPlatformBinaryPath(t, pkgDir)

	service := probeTestService(home)
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, fakeManagedRuntimeRoot(t))
	// The default 1s probe timeout is tuned for the old "still alive after
	// 200ms" liveness check; the real ACP handshake needs to actually spawn,
	// write, and read a response, which is slower under test-suite load.
	service.ProbeReadyAfter = 1500 * time.Millisecond
	service.ProbeTimeout = 5 * time.Second
	service.Environ = func() []string {
		return []string{"PATH=" + binDir, agentNPMRegistryEnv + "=https://registry.example.test"}
	}
	service.IsExecutableFile = isTestExecutable
	service.CodexProtocolProbe = codexProtocolSequence(
		codexPlatformENOENTFixture(),
		codexPlatformENOENTFixture(),
		CodexProbeEvidence{CommandStarted: true, ProtocolReady: true},
	)
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

func TestServiceRunActionDoesNotRepairCodexForGenericAppServerFailure(t *testing.T) {
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
	// The default 1s probe timeout is tuned for the old "still alive after
	// 200ms" liveness check; the real ACP handshake needs to actually spawn,
	// write, and read a response, which is slower under test-suite load.
	service.ProbeReadyAfter = 1500 * time.Millisecond
	service.ProbeTimeout = 5 * time.Second
	service.Environ = func() []string {
		return []string{"PATH=" + binDir, agentNPMRegistryEnv + "=https://registry.example.test"}
	}
	service.IsExecutableFile = isTestExecutable
	service.CodexProtocolProbe = codexProtocolFixture(CodexProbeEvidence{CommandStarted: true, Category: "process_exited_early", Message: "app-server failed"})
	// A stale, previously repairable status cannot authorize a new repair. The
	// install path always takes fresh structured probe/layout evidence.
	service.StatusCache = NewProviderStatusCache()
	service.StatusCache.set("codex", service.Now().Add(-time.Hour), "", ProviderStatus{Provider: "codex"})
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}

	var command InstallCommandInput
	service.InstallCommand = func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		command = input
		t.Fatal("InstallCommand called for a generic app-server failure without triple repair evidence")
		return InstallCommandResult{}, nil
	}

	result, err := service.RunAction(context.Background(), RunActionInput{
		Provider: "codex",
		ActionID: ActionInstall,
	})
	if err != nil {
		t.Fatalf("RunAction() error = %v", err)
	}
	if result.Status != RunActionFailed {
		t.Fatalf("Status = %q, want %q; result=%#v", result.Status, RunActionFailed, result)
	}
	if command.Command != "" {
		t.Fatalf("Command = %q, want no repair installer", command.Command)
	}
	if result.ReasonCode != "post_install_probe_failed" {
		t.Fatalf("ReasonCode = %q, want post_install_probe_failed", result.ReasonCode)
	}
}

func TestServiceListReportsRuntimeBugWhenCodexAppServerFails(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	codexPath := filepath.Join(binDir, "codex")
	writeExecutable(t, codexPath, "#!/bin/sh\nexit 0\n")

	service := Service{
		Registry: Registry{Specs: []ProviderSpec{{
			Provider:       "codex",
			BinaryNames:    []string{"codex"},
			AdapterCommand: []string{"codex", "app-server"},
			LoginArgs:      []string{"login"},
		}}},
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
			if name == "codex" {
				return codexPath, nil
			}
			return "", errors.New("not found")
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
		CodexProtocolProbe: codexProtocolFixture(CodexProbeEvidence{CommandStarted: true, Category: "process_exited_early", Message: "app-server failed"}),
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
	action := firstAction(t, status.Actions)
	if action.ID != ActionRefresh || action.Kind != ActionKindRefresh {
		t.Fatalf("first action = %#v, want refresh; generic Codex failure is not repairable", action)
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
		"/home/test/.config/openclaw/auth.json": true,
	})

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"nexight", "openclaw"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(snapshot.Providers) != 2 {
		t.Fatalf("len(providers) = %d, want 2", len(snapshot.Providers))
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
		CodexProtocolProbe: codexProtocolReadyFixture,
		RemoteAuthProbe: func(context.Context, ProviderSpec) (providerstatus.AuthEvidence, bool) {
			return providerstatus.AuthEvidence{}, false
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
	service.CodexProtocolProbe = codexProtocolReadyFixture
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
	service.CodexProtocolProbe = codexProtocolFixture(CodexProbeEvidence{Category: "spawn_failed", Message: "missing command"})
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
	if result.ReasonCode != "acp_adapter_launch_failed" {
		t.Fatalf("ReasonCode = %q, want acp_adapter_launch_failed", result.ReasonCode)
	}
	if result.Message == "" {
		t.Fatal("Message is empty, want start failure detail")
	}
}

func TestServiceProbeTreatsTemporarilyUnsupportedProviderAsUnsupported(t *testing.T) {
	service := testService(func(name string) (string, error) {
		return "/usr/local/bin/" + name, nil
	}, map[string]bool{"/home/test/.config/openclaw/auth.json": true})

	result, err := service.Probe(context.Background(), ProbeInput{Provider: "openclaw"})
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
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fixture and POSIX adapter probe are not a native Windows test")
	}
	home := t.TempDir()
	binDir := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	adapterArchive, adapterSHA256 := releaseBinaryArchive(t, "codex-acp", "#!/bin/sh\nread -r line\nid=$(printf '%s' \"$line\" | sed -n 's/.*\"id\":\\([0-9]*\\).*/\\1/p')\nprintf '{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{}}\\n' \"$id\"\n")
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
		writeExecutable(t, filepath.Join(binDir, "nexight"), "#!/bin/sh\nexit 0\n")
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}
	service.HTTPClient = installerServer.Client()
	service.Registry = Registry{Specs: []ProviderSpec{{
		Provider:           "nexight",
		BinaryNames:        []string{"nexight"},
		AdapterBinaryNames: []string{"codex-acp"},
		AdapterCommand:     []string{"codex-acp"},
		AuthMarkerPaths:    []string{"~/.nexight/auth.json"},
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
		Provider: "nexight",
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
	result, err := service.runCodexCLILatestInstaller(context.Background(), "codex", InstallerSpec{
		Kind:     InstallerKindCodexCLILatest,
		CodexCLI: codexCLIInstallerSpec().CodexCLI,
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
	const provider = "codex"
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	writeExecutable(t, filepath.Join(binDir, npmBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(binDir, nodeBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	runtimeRoot := fakeManagedRuntimeRoot(t)
	managedNPM := filepath.Join(runtimeRoot, "node", "bin", npmBinaryNameForTest())
	managedNode := filepath.Join(runtimeRoot, "node", "bin", nodeBinaryNameForTest())
	service := probeTestService(home)
	// The default 1s probe timeout is tuned for the old "still alive after
	// 200ms" liveness check; the real ACP handshake needs to actually spawn,
	// write, and read a response, which is slower under test-suite load.
	service.ProbeTimeout = 5 * time.Second
	service.Environ = func() []string {
		return []string{"PATH=" + binDir, agentNPMRegistryEnv + "=https://registry.example.test"}
	}
	service.IsExecutableFile = isTestExecutableUnderHome(home)
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	service.Registry = Registry{Specs: []ProviderSpec{{
		Provider:           provider,
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
		writeExecutable(t, codexPath, codexAppServerFakeScript("if [ \"$1\" = \"--version\" ]; then echo 'codex "+MinSupportedCodexVersion+"'; exit 0; fi\nexit 0\n"))
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
			Provider: provider,
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
	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{provider}})
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
	service.ClaudeCodeStateDir = t.TempDir()
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

func TestServiceRunActionClassifiesInstallFailureFromDescriptorMarkers(t *testing.T) {
	home := t.TempDir()
	service := probeTestService(home)
	service.Registry = Registry{Specs: []ProviderSpec{{
		Provider:    "opencode",
		BinaryNames: []string{"opencode"},
		Install: InstallerSpec{
			Kind:           InstallerKindShellCommand,
			DisplayCommand: "install opencode test",
			ShellCommand:   "install opencode test",
			FailureReasonMarkers: map[string][]string{
				"install_unavailable_in_region": {"unavailable-in-test-region"},
			},
		},
	}}}
	service.InstallCommand = func(context.Context, InstallCommandInput) (InstallCommandResult, error) {
		return InstallCommandResult{ExitCode: 42, Stderr: "Unavailable-In-Test-Region"}, nil
	}

	result, err := service.RunAction(context.Background(), RunActionInput{
		Provider: "opencode",
		ActionID: ActionInstall,
	})
	if err != nil {
		t.Fatalf("RunAction() error = %v", err)
	}
	if result.ReasonCode != "install_unavailable_in_region" {
		t.Fatalf("ReasonCode = %q, want install_unavailable_in_region", result.ReasonCode)
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
	if !slices.Equal(result.Command, []string{filepath.Join(binDir, "codex"), "app-server"}) {
		t.Fatalf("Command = %#v, want resolved codex app-server", result.Command)
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
	if !slices.Equal(result.Command, []string{filepath.Join(binDir, "codex"), "app-server"}) {
		t.Fatalf("Command = %#v, want resolved codex app-server", result.Command)
	}
	managedNode := filepath.Join(runtimeRoot, "node", "bin", nodeBinaryNameForTest())
	if !slices.Contains(result.Env, "TUTTI_APP_NODE="+managedNode) {
		t.Fatalf("Env = %#v, want managed node fallback", result.Env)
	}
}

func TestServiceResolveProviderCommandFallsBackToManagedNodeForTuttiAgent(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	agentBinaryName := "tutti-agent"
	if runtime.GOOS == "windows" {
		agentBinaryName += ".cmd"
	}
	agentContents := "#!/usr/bin/env node\n"
	if runtime.GOOS == "windows" {
		agentContents = "@echo off\r\ncall \"%TUTTI_APP_NODE%\" --version\r\n"
	}
	writeExecutable(t, filepath.Join(binDir, agentBinaryName), agentContents)
	runtimeRoot := fakeManagedRuntimeRoot(t)

	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{"PATH=" + binDir}
	}
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)

	result, err := service.ResolveProviderCommand(context.Background(), "tutti-agent")
	if err != nil {
		t.Fatalf("ResolveProviderCommand() error = %v", err)
	}
	if !slices.Equal(result.Command, []string{"tutti-agent", "app-server"}) {
		t.Fatalf("Command = %#v, want tutti-agent app-server", result.Command)
	}
	managedNode := filepath.Join(runtimeRoot, "node", "bin", nodeBinaryNameForTest())
	if !slices.Contains(result.Env, "TUTTI_APP_NODE="+managedNode) {
		t.Fatalf("Env = %#v, want managed node fallback", result.Env)
	}
	pathValue := managedruntime.EnvValue(result.Env, "PATH")
	if !slices.Contains(filepath.SplitList(pathValue), filepath.Dir(managedNode)) {
		t.Fatalf("PATH = %q, want managed node directory", pathValue)
	}
}

func TestServiceListUsesManagedNodeForTuttiAgentVersionProbe(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	agentBinaryName := "tutti-agent"
	if runtime.GOOS == "windows" {
		agentBinaryName += ".cmd"
	}
	agentContents := "#!/usr/bin/env node\n"
	if runtime.GOOS == "windows" {
		agentContents = "@echo off\r\ncall \"%TUTTI_APP_NODE%\" --version\r\n"
	}
	writeExecutable(t, filepath.Join(binDir, agentBinaryName), agentContents)
	runtimeRoot := fakeManagedRuntimeRoot(t)

	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{"PATH=" + binDir}
	}
	if runtime.GOOS == "windows" {
		nodePath := filepath.Join(home, "managed-node.cmd")
		writeExecutable(t, nodePath, "@echo off\r\necho tutti-agent "+providerregistry.TuttiAgentMinVersion+"\r\n")
		service.ManagedRuntime = staticManagedRuntimeResolver{runtime: managedruntime.ResolvedRuntime{
			Root:    runtimeRoot,
			Node:    nodePath,
			NPM:     filepath.Join(home, "npm.cmd"),
			BinDirs: []string{filepath.Dir(nodePath)},
			EnvOverrides: []string{
				"TUTTI_APP_NODE=" + nodePath,
				"PATH=" + filepath.Dir(nodePath),
			},
		}}
	} else {
		writeExecutable(
			t,
			filepath.Join(runtimeRoot, "node", "bin", nodeBinaryNameForTest()),
			"#!/bin/sh\necho 'tutti-agent "+providerregistry.TuttiAgentMinVersion+"'\n",
		)
		service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)
	}
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	snapshot, err := service.List(context.Background(), ListInput{
		Providers:    []string{"tutti-agent"},
		ForceRefresh: true,
	})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	status := onlyStatus(t, snapshot)
	if status.CLI.Version != providerregistry.TuttiAgentMinVersion {
		t.Fatalf("CLI.Version = %q, want %s", status.CLI.Version, providerregistry.TuttiAgentMinVersion)
	}
	if status.Availability.Status != AvailabilityReady {
		t.Fatalf(
			"Availability = %#v, want ready with managed Node version probe",
			status.Availability,
		)
	}
}

func TestServiceResolveProviderCommandDefaultsClaudeCodeToSDKSidecar(t *testing.T) {
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
}

func TestServiceListClaudeCodeSDKAvailability(t *testing.T) {
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
	if !status.Adapter.Installed {
		t.Fatalf("Adapter.Installed = false, want SDK sidecar runtime installed; status=%#v", status)
	}
}

func TestServiceListClaudeCodeSDKReportsMissingSidecarEntry(t *testing.T) {
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
	}, map[string]bool{"/home/test/.config/openclaw/auth.json": true})
	installCalled := false
	service.InstallCommand = func(context.Context, InstallCommandInput) (InstallCommandResult, error) {
		installCalled = true
		return InstallCommandResult{ExitCode: 0}, nil
	}

	result, err := service.RunAction(context.Background(), RunActionInput{
		Provider: "openclaw",
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
		command:      "external_agent_registry_npm:sample-agent:@agentclientprotocol/sample-agent-acp@0.46.0:/tmp/sample-agent",
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
	first := installCommandLockPath("external_agent_registry_npm:sample-agent:@agentclientprotocol/sample-agent-acp@0.46.0:/tmp/sample-agent")
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

func TestInstallCommandLockRecoverKeepsRecreatedLock(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "run", "locks", "claude-code-runtime-binary.lock")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	recreated := []byte("pid=4242\ncommand=claude-code-runtime-binary\n")
	if err := os.WriteFile(lockPath, recreated, 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	// First read observes a stale dead-pid lock; before removal a concurrent
	// process recovers it and creates its own live lock at the same path. The
	// identity re-check must keep the recreated lock intact.
	reads := 0
	result, err := (installCommandLock{
		lockPath: lockPath,
		readFile: func(path string) ([]byte, error) {
			reads++
			if reads == 1 {
				return []byte("pid=999999999\ncommand=claude-code-runtime-binary\n"), nil
			}
			return os.ReadFile(path)
		},
		processExists: func(_ int) bool {
			return false
		},
	}).Recover()
	if err != nil {
		t.Fatalf("Recover() error = %v", err)
	}
	if result.Removed {
		t.Fatalf("Removed = true, want false; result=%#v", result)
	}
	content, err := os.ReadFile(lockPath)
	if err != nil {
		t.Fatalf("recreated lock missing after recovery: %v", err)
	}
	if string(content) != string(recreated) {
		t.Fatalf("recreated lock content = %q, want untouched", string(content))
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

func TestServiceRunActionCoalescesConcurrentInstallsForSameProvider(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	service := probeTestService(home)
	service.CodexProtocolProbe = codexProtocolReadyFixture
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
	service.InstallCommand = func(ctx context.Context, _ InstallCommandInput) (InstallCommandResult, error) {
		installCallCount.Add(1)
		close(firstInstallStarted)
		select {
		case <-releaseFirstInstall:
		case <-ctx.Done():
			return InstallCommandResult{ExitCode: 1, Stderr: ctx.Err().Error()}, ctx.Err()
		}
		writeExecutable(t, filepath.Join(binDir, "codex"), "#!/bin/sh\nexit 0\n")
		writeExecutable(t, filepath.Join(binDir, "codex-acp"), "#!/bin/sh\nsleep 5\n")
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}

	type runResult struct {
		result RunActionResult
		err    error
	}
	firstCtx, cancelFirst := context.WithCancel(context.Background())
	defer cancelFirst()
	firstDone := make(chan runResult, 1)
	go func() {
		result, err := service.RunAction(firstCtx, RunActionInput{
			Provider: "codex",
			ActionID: ActionInstall,
		})
		firstDone <- runResult{result: result, err: err}
	}()

	<-firstInstallStarted
	secondDone := make(chan runResult, 1)
	go func() {
		result, err := service.RunAction(context.Background(), RunActionInput{
			Provider: "codex",
			ActionID: ActionInstall,
		})
		secondDone <- runResult{result: result, err: err}
	}()

	select {
	case second := <-secondDone:
		t.Fatalf("second RunAction() returned before the shared install completed: %#v", second)
	case <-time.After(100 * time.Millisecond):
	}
	cancelFirst()
	select {
	case first := <-firstDone:
		t.Fatalf("first RunAction() returned after its request was canceled but before the shared install completed: %#v", first)
	case <-time.After(100 * time.Millisecond):
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
	if got := installCallCount.Load(); got != 1 {
		t.Fatalf("install call count = %d, want 1", got)
	}
	if !reflect.DeepEqual(second.result, first.result) {
		t.Fatalf("second result = %#v, want shared first result %#v", second.result, first.result)
	}
}

type claudeAuthCommandResult struct {
	auth AuthInfo
	ok   bool
}

type claudeAuthListHarness struct {
	t          *testing.T
	home       string
	claudePath string
	service    Service
	calls      int
	responses  []claudeAuthCommandResult
}

func newClaudeAuthListHarness(
	t *testing.T,
	environ []string,
	responses ...claudeAuthCommandResult,
) *claudeAuthListHarness {
	t.Helper()
	home := t.TempDir()
	binDir := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	claudePath := filepath.Join(binDir, "claude")
	writeExecutable(t, claudePath, "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(binDir, "sample-agent-acp"), "#!/bin/sh\nexit 0\n")
	writePackageManifest(t, binDir, "@agentclientprotocol/sample-agent-acp", "0.46.0")
	registryStore, prefixDir := fakeExternalAgentRegistry(t)
	runtimeRoot := fakeManagedRuntimeRoot(t)
	packageDir := npmPackageInstallDir(prefixDir, "@agentclientprotocol/sample-agent-acp")
	if err := os.MkdirAll(packageDir, 0o755); err != nil {
		t.Fatalf("mkdir package dir: %v", err)
	}
	writePackageManifest(t, packageDir, "@agentclientprotocol/sample-agent-acp", "0.46.0")

	harness := &claudeAuthListHarness{
		t:          t,
		home:       home,
		claudePath: claudePath,
		responses:  responses,
	}
	harness.service = Service{
		Environ:  func() []string { return environ },
		HomeDir:  func() (string, error) { return home, nil },
		LookPath: func(_ string) (string, error) { return "", errors.New("not found") },
		Now:      func() time.Time { return time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC) },
		RunAuthStatusCommand: func(_ context.Context, spec ProviderSpec, binaryPath string) (AuthInfo, bool) {
			if spec.Provider != "claude-code" {
				t.Fatalf("auth status provider = %q, want claude-code", spec.Provider)
			}
			if binaryPath != claudePath {
				t.Fatalf("auth status binaryPath = %q, want %q", binaryPath, claudePath)
			}
			if harness.calls >= len(harness.responses) {
				t.Fatalf("unexpected auth status command call %d", harness.calls+1)
			}
			response := harness.responses[harness.calls]
			harness.calls++
			return response.auth, response.ok
		},
		ExternalAgentRegistry: registryStore,
		ManagedRuntime:        fakeManagedRuntimeResolver(t, runtimeRoot),
	}
	return harness
}

func (h *claudeAuthListHarness) writeSettings(content string) {
	h.t.Helper()
	settingsDir := filepath.Join(h.home, ".claude")
	if err := os.MkdirAll(settingsDir, 0o755); err != nil {
		h.t.Fatalf("mkdir .claude dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(settingsDir, "settings.json"), []byte(content), 0o600); err != nil {
		h.t.Fatalf("write settings.json: %v", err)
	}
}

func (h *claudeAuthListHarness) writeMarker(content string) {
	h.t.Helper()
	if err := os.WriteFile(filepath.Join(h.home, ".claude.json"), []byte(content), 0o600); err != nil {
		h.t.Fatalf("write claude marker: %v", err)
	}
}

func (h *claudeAuthListHarness) list() ProviderStatus {
	h.t.Helper()
	snapshot, err := h.service.List(context.Background(), ListInput{Providers: []string{"claude-code"}})
	if err != nil {
		h.t.Fatalf("List() error = %v", err)
	}
	return onlyStatus(h.t, snapshot)
}

func assertClaudeAuthListStatus(
	t *testing.T,
	status ProviderStatus,
	claudePath string,
	availability AvailabilityStatus,
	authStatus AuthStatus,
	authMethod string,
	accountLabel string,
) {
	t.Helper()
	if status.Availability.Status != availability {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, availability)
	}
	if status.Auth.Status != authStatus {
		t.Fatalf("Auth.Status = %q, want %q", status.Auth.Status, authStatus)
	}
	if status.Auth.AuthMethod != authMethod {
		t.Fatalf("Auth.AuthMethod = %q, want %q", status.Auth.AuthMethod, authMethod)
	}
	if status.Auth.AccountLabel != accountLabel {
		t.Fatalf("Auth.AccountLabel = %q, want %q", status.Auth.AccountLabel, accountLabel)
	}
	if status.CLI.BinaryPath != claudePath {
		t.Fatalf("CLI.BinaryPath = %q, want %q", status.CLI.BinaryPath, claudePath)
	}
}

func TestServiceListReportsClaudeAuthentication(t *testing.T) {
	tests := []struct {
		name         string
		environ      []string
		settings     string
		commandAuth  AuthInfo
		availability AvailabilityStatus
		authStatus   AuthStatus
		authMethod   string
		accountLabel string
	}{
		{
			name:         "auth required from CLI status",
			environ:      []string{"PATH=/usr/bin:/bin"},
			commandAuth:  AuthInfo{Status: AuthRequired},
			availability: AvailabilityAuthRequired,
			authStatus:   AuthRequired,
		},
		{
			name:         "environment API key uses API billing",
			environ:      []string{"PATH=/usr/bin:/bin", "ANTHROPIC_API_KEY=sk-test"},
			commandAuth:  AuthInfo{Status: AuthRequired},
			availability: AvailabilityReady,
			authStatus:   AuthConfigured,
			authMethod:   "apiKey",
			accountLabel: "API Usage Billing",
		},
		{
			name:         "settings API key uses API billing",
			environ:      []string{"PATH=/usr/bin:/bin"},
			settings:     `{"env":{"ANTHROPIC_API_KEY":"sk-test"}}`,
			commandAuth:  AuthInfo{Status: AuthRequired},
			availability: AvailabilityReady,
			authStatus:   AuthConfigured,
			authMethod:   "apiKey",
			accountLabel: "API Usage Billing",
		},
		{
			name:         "settings token and base URL override CLI OAuth",
			environ:      []string{"PATH=/usr/bin:/bin"},
			settings:     `{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-test","ANTHROPIC_BASE_URL":"https://api.moonshot.cn/anthropic"}}`,
			commandAuth:  AuthInfo{Status: AuthAuthenticated, AuthMethod: "oauth_token", AccountLabel: "oauth_token"},
			availability: AvailabilityReady,
			authStatus:   AuthConfigured,
			authMethod:   "apiKey",
			accountLabel: "API Usage Billing",
		},
		{
			name:         "bare endpoint preserves CLI OAuth identity",
			environ:      []string{"PATH=/usr/bin:/bin"},
			settings:     `{"env":{"ANTHROPIC_BASE_URL":"https://gw.local"}}`,
			commandAuth:  AuthInfo{Status: AuthAuthenticated, AuthMethod: "oauth", AccountLabel: "me@x.com"},
			availability: AvailabilityReady,
			authStatus:   AuthConfigured,
			authMethod:   "oauth",
			accountLabel: "me@x.com",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			harness := newClaudeAuthListHarness(t, tt.environ, claudeAuthCommandResult{auth: tt.commandAuth, ok: true})
			if tt.settings != "" {
				harness.writeSettings(tt.settings)
			}

			status := harness.list()
			assertClaudeAuthListStatus(
				t,
				status,
				harness.claudePath,
				tt.availability,
				tt.authStatus,
				tt.authMethod,
				tt.accountLabel,
			)
			if harness.calls != 1 {
				t.Fatalf("auth status command calls = %d, want 1", harness.calls)
			}
		})
	}
}

func TestServiceListRetriesClaudeAuthStatusCommandWhenOutputIsUnrecognized(t *testing.T) {
	harness := newClaudeAuthListHarness(
		t,
		[]string{"PATH=/usr/bin:/bin"},
		claudeAuthCommandResult{auth: AuthInfo{}, ok: false},
		claudeAuthCommandResult{auth: AuthInfo{Status: AuthAuthenticated, AccountLabel: "dev@example.com"}, ok: true},
	)
	harness.service.AuthStatusCommandRetryDelay = time.Nanosecond

	status := harness.list()
	assertClaudeAuthListStatus(
		t,
		status,
		harness.claudePath,
		AvailabilityReady,
		AuthConfigured,
		"",
		"dev@example.com",
	)
	if harness.calls != 2 {
		t.Fatalf("auth status command calls = %d, want 2", harness.calls)
	}
}

func TestServiceListFallsBackToClaudeAuthMarkerWhenAuthStatusCommandIsUnrecognized(t *testing.T) {
	harness := newClaudeAuthListHarness(
		t,
		[]string{"PATH=/usr/bin:/bin"},
		claudeAuthCommandResult{auth: AuthInfo{}, ok: false},
		claudeAuthCommandResult{auth: AuthInfo{}, ok: false},
	)
	harness.service.AuthStatusCommandRetryDelay = time.Nanosecond
	harness.writeMarker(`{"userID":"user_123"}`)

	status := harness.list()
	assertClaudeAuthListStatus(
		t,
		status,
		harness.claudePath,
		AvailabilityReady,
		AuthConfigured,
		"",
		"user_123",
	)
	if harness.calls != 2 {
		t.Fatalf("auth status command calls = %d, want 2", harness.calls)
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
	if runtime.GOOS == "windows" {
		if _, err := service.selectInstallDir(); err == nil {
			t.Fatal("selectInstallDir() error = nil, want Windows canonical home directory error")
		}
		return
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
		CodexProtocolProbe: codexProtocolReadyFixture,
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
		ClaudeCodeStateDir: home,
		LookPath: func(string) (string, error) {
			return "", errors.New("not found")
		},
		IsExecutableFile: isTestExecutableUnderHome(home),
		Now: func() time.Time {
			return time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
		},
		ProbeReadyAfter: 200 * time.Millisecond,
		// Match production defaultProbeTimeout (3s). 1s was too tight for the
		// real ACP initialize round-trip in fake shell scripts under parallel
		// `go test` load and caused flaky acp_adapter_launch_failed failures.
		ProbeTimeout: defaultProbeTimeout,
		RemoteAuthProbe: func(context.Context, ProviderSpec) (providerstatus.AuthEvidence, bool) {
			return providerstatus.AuthEvidence{}, false
		},
	}
}

// The service layer consumes the same structured command/protocol evidence as
// production. It never treats a shell process surviving for a short interval
// as readiness; formal JSON-RPC lifecycle coverage lives in the runtime probe
// tests, while these fixtures make product-policy scenarios explicit.
func codexProtocolFixture(evidence CodexProbeEvidence) func(context.Context, []string, []string) CodexProbeEvidence {
	return func(context.Context, []string, []string) CodexProbeEvidence { return evidence }
}

func codexProtocolReadyFixture(context.Context, []string, []string) CodexProbeEvidence {
	return CodexProbeEvidence{CommandStarted: true, ProtocolReady: true}
}

func codexProtocolSequence(evidence ...CodexProbeEvidence) func(context.Context, []string, []string) CodexProbeEvidence {
	var next atomic.Int32
	return func(context.Context, []string, []string) CodexProbeEvidence {
		index := int(next.Add(1) - 1)
		if index >= len(evidence) {
			return evidence[len(evidence)-1]
		}
		return evidence[index]
	}
}

func codexPlatformENOENTFixture() CodexProbeEvidence {
	return CodexProbeEvidence{
		Category:            "platform_package_enoent",
		PlatformPackageName: "@openai/" + testCodexPlatformPackageName(),
		Message:             "ENOENT: cannot find @openai/" + testCodexPlatformPackageName(),
	}
}

func testCodexPlatformPackageName() string {
	platform, ok := codexNpmPlatformDir(runtime.GOOS, runtime.GOARCH)
	if !ok {
		return "codex-unknown"
	}
	return platform
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

// codexAppServerHandshakeOKCase is a POSIX `case` arm that answers the Codex
// runtime probe's `initialize` request by actually reading the request line
// from stdin, extracting the id the probe generated for this run, and echoing
// it back. It then consumes the formal `initialized` notification before
// exiting. The probe uses an unpredictable id per run specifically so a
// canned response (one that never reads stdin) cannot pass as a real
// handshake reply.
const codexAppServerHandshakeOKCase = `*app-server*) read -r line; id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p'); printf '{"id":%s,"result":{}}\n' "$id"; read -r initialized; exit 0 ;;`

// codexAppServerFakeScript builds a POSIX shell fake CLI that answers the
// real ACP handshake probe for any invocation whose args contain
// "app-server" (matching the probe's request instead of just staying alive),
// then falls through to extraBody for every other invocation (e.g.
// `--version`).
func codexAppServerFakeScript(extraBody string) string {
	return "#!/bin/sh\ncase \"$*\" in\n" + codexAppServerHandshakeOKCase + "\nesac\n" + extraBody
}

// standardACPHandshakeOKCase is the Standard ACP equivalent of
// codexAppServerHandshakeOKCase: it reads the `initialize` request from
// stdin and echoes back the id it was sent, rather than a hardcoded value.
const standardACPHandshakeOKCase = `*acp*) read -r line; id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p'); printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id"; exit 0 ;;`

// standardACPFakeScript builds a POSIX shell fake CLI that answers the real
// ACP handshake probe for any invocation whose args contain "acp" (matching
// cursor-agent/opencode's `<binary> acp` adapter command), then falls
// through to extraBody for every other invocation (e.g. `--version`).
func standardACPFakeScript(extraBody string) string {
	return "#!/bin/sh\ncase \"$*\" in\n" + standardACPHandshakeOKCase + "\nesac\n" + extraBody
}

func isTestExecutable(path string) bool {
	stat, err := os.Stat(path)
	if err != nil || stat.IsDir() {
		return false
	}
	// Windows does not expose Unix executable permission bits. The production
	// implementation uses the Windows platform rule as well, so test fixtures
	// must not reject an ordinary file merely because Mode().Perm() has no 0111
	// bits.
	if runtime.GOOS == "windows" {
		return true
	}
	return stat.Mode().Perm()&0111 != 0
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
		if err != nil || stat.IsDir() {
			return false
		}
		if runtime.GOOS == "windows" {
			return true
		}
		return stat.Mode().Perm()&0111 != 0
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

func fakeExternalAgentRegistry(t *testing.T) (externalagentregistry.Store, string) {
	t.Helper()
	root := t.TempDir()
	sourcePath := filepath.Join(root, "registry.json")
	content := `{
  "version": "test",
  "agents": [{
    "id": "sample-agent",
    "name": "Sample Agent",
    "version": "0.46.0",
    "description": "ACP wrapper for sample agent",
    "distribution": {
      "npx": {
        "package": "@agentclientprotocol/sample-agent-acp@0.46.0"
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
	return store, store.PackagePrefix("sample-agent")
}

func fakeManagedRuntimeRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeExecutable(t, filepath.Join(root, "python", "bin", pythonBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(root, "node", "bin", nodeBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(root, "node", "bin", npmBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	corepackContents := "#!/bin/sh\nexec \"$(dirname \"$0\")/node\" \"$(dirname \"$0\")/../lib/node_modules/corepack/dist/corepack.js\" \"$@\"\n"
	if runtime.GOOS == "windows" {
		corepackContents = `@IF EXIST "%~dp0\node.exe" ("%~dp0\node.exe" "%~dp0\node_modules\corepack\dist\corepack.js" %*)`
	}
	writeExecutable(
		t,
		filepath.Join(root, "node", "bin", corepackBinaryNameForTest()),
		corepackContents,
	)
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

func corepackBinaryNameForTest() string {
	if runtime.GOOS == "windows" {
		return "corepack.cmd"
	}
	return "corepack"
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
