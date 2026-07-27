package agentstatus

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// writeCodexBunInstall lays out a Bun-style global install of @openai/codex.
//
// Bun installs the @openai/codex launcher under a hoisted package directory
// and symlinks it from ~/.bun/bin/codex; the per-platform subpackage
// (@openai/codex-<platform>) is a *sibling* of @openai/codex, not nested
// beneath it. That means the npm-nested platform-binary path inspected by
// codexPlatformBinaryOK is intentionally absent here — this is the layout that
// used to make Tutti reject a fully-working Bun install.
//
// launcherScript is written verbatim as the codex binary and only needs the
// version branch used by CLI discovery. The structured protocol fixture below
// supplies app-server evidence; it intentionally does not infer readiness from
// a shell process staying alive.
func writeCodexBunInstall(t *testing.T, home, launcherScript string) string {
	t.Helper()
	pkgDir := filepath.Join(home, ".bun", "install", "global", "node_modules", "@openai", "codex")
	writePackageManifest(t, pkgDir, "@openai/codex", MinSupportedCodexVersion)
	launcherPath := filepath.Join(pkgDir, "bin", "codex")
	writeExecutable(t, launcherPath, launcherScript)
	bunBin := filepath.Join(home, ".bun", "bin")
	if err := os.MkdirAll(bunBin, 0o755); err != nil {
		t.Fatalf("mkdir bun bin %s: %v", bunBin, err)
	}
	codexLink := filepath.Join(bunBin, "codex")
	if err := os.Symlink(launcherPath, codexLink); err != nil {
		t.Fatalf("symlink codex -> %s: %v", launcherPath, err)
	}
	return codexLink
}

// codexBunInstallStatus builds a Service against a Bun-style install described
// by launcherScript and returns the codex provider status from a single List.
//
// PATH is intentionally /usr/bin:/bin (the minimal GUI/Dock PATH) so the test
// proves the resolver's ~/.bun/bin fallback — not the inherited PATH —
// discovers the CLI, matching the Electron/desktop launch scenario. The probe
func codexBunInstallStatus(t *testing.T, launcherScript string, probe CodexProbeEvidence) ProviderStatus {
	t.Helper()
	home := t.TempDir()
	writeCodexBunInstall(t, home, launcherScript)

	service := probeTestService(home)
	service.CodexProtocolProbe = codexProtocolFixture(probe)
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	return onlyStatus(t, snapshot)
}

const codexBunReadyLauncher = "#!/bin/sh\n" +
	"if [ \"$1\" = \"--version\" ]; then echo 'codex 0.142.0'; exit 0; fi\nexit 1\n"

// TestCodexAvailabilityBunHoistedInstallVerifiedByProbe is the core regression
// (acceptance Cases 1, 2, 3): a Bun-installed codex (hoisted layout, npm-nested
// platform binary absent) launches `codex app-server` successfully, so the
// probe — not the npm layout — authorizes availability. Tutti must report
// Ready, not codex_platform_pkg_incomplete. PATH is /usr/bin:/bin, so the CLI
// is found via the ~/.bun/bin resolver fallback (the Electron launch case).
func TestCodexAvailabilityBunHoistedInstallVerifiedByProbe(t *testing.T) {
	status := codexBunInstallStatus(t, codexBunReadyLauncher, CodexProbeEvidence{CommandStarted: true, ProtocolReady: true})

	if status.Availability.Status != AvailabilityReady {
		t.Fatalf("Availability.Status = %q, want %q (probe-verified runtime must not be blocked by npm layout); reasonCode=%q",
			status.Availability.Status, AvailabilityReady, status.Availability.ReasonCode)
	}
	if status.Availability.ReasonCode != "" {
		t.Fatalf("ReasonCode = %q, want empty for a ready provider", status.Availability.ReasonCode)
	}
	if !status.CLI.Installed {
		t.Fatal("CLI.Installed = false, want true")
	}
	// The resolver must have discovered the CLI via the ~/.bun/bin fallback
	// (PATH is /usr/bin:/bin), proving the Electron/minimal-PATH scenario.
	if !strings.HasSuffix(filepath.ToSlash(status.CLI.BinaryPath), "/.bun/bin/codex") {
		t.Fatalf("CLI.BinaryPath = %q, want it to resolve through ~/.bun/bin/codex", status.CLI.BinaryPath)
	}
	// `codex --version` must have succeeded (acceptance Case 3).
	if status.CLI.Version != "0.142.0" {
		t.Fatalf("CLI.Version = %q, want 0.142.0", status.CLI.Version)
	}
	// The platform-binary check must be reported as passed once the probe
	// verified the runtime, even though the nested platform binary is absent.
	assertProviderCheck(t, status.Checks, "platform_binary", true)
}

func TestCodexAvailabilityUnsupportedAppServerRequiresUpgrade(t *testing.T) {
	status := codexBunInstallStatus(t, codexBunReadyLauncher, CodexProbeEvidence{
		CommandStarted: true,
		Category:       "app_server_unsupported",
		Message:        "unrecognized subcommand app-server",
	})

	if status.Availability.Status != AvailabilityUnsupported ||
		status.Availability.ReasonCode != "app_server_unsupported" {
		t.Fatalf("availability = %#v, want unsupported app-server", status.Availability)
	}
	if len(status.Actions) != 1 || status.Actions[0].ID != ActionUpdate {
		t.Fatalf("actions = %#v, want update", status.Actions)
	}
}

func TestCodexAvailabilityCompleteBunRuntimeProtocolFailureIsBug(t *testing.T) {
	home := t.TempDir()
	writeCodexBunInstall(t, home, codexBunReadyLauncher)
	platform, platformOK := codexNpmPlatformDir(runtime.GOOS, runtime.GOARCH)
	triple, tripleOK := codexPlatformTargetTriple(runtime.GOOS, runtime.GOARCH)
	if !platformOK || !tripleOK {
		t.Skip("unsupported platform")
	}
	platformRoot := filepath.Join(home, ".bun", "install", "global", "node_modules", "@openai", platform)
	writePackageManifest(t, platformRoot, "@openai/"+platform, MinSupportedCodexVersion)
	binaryName := "codex"
	if runtime.GOOS == "windows" {
		binaryName = "codex.exe"
	}
	writeExecutable(t, filepath.Join(platformRoot, "vendor", triple, "bin", binaryName), "#!/bin/sh\n")

	service := probeTestService(home)
	service.CodexProtocolProbe = codexProtocolFixture(CodexProbeEvidence{
		CommandStarted: true,
		Category:       "protocol_failure",
		Message:        "initialize failed",
	})
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityUnknown ||
		status.Availability.ReasonCode != "codex_runtime_bug" {
		t.Fatalf("availability = %#v, want runtime bug", status.Availability)
	}
	if status.LastError == nil || status.LastError.Code != string(CodexErrRuntimeBug) {
		t.Fatalf("last error = %#v, want %s", status.LastError, CodexErrRuntimeBug)
	}
	if status.CodexDiagnostics == nil || status.CodexDiagnostics.RepairPlan.Allowed {
		t.Fatalf("diagnostics = %#v, runtime bug must not authorize repair", status.CodexDiagnostics)
	}
}

func TestCodexAvailabilityBunInstallVerifiedByProductionProbe(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell launcher fixture is Unix-only")
	}
	home := t.TempDir()
	launcher := "#!/bin/sh\n" +
		"if [ \"$1\" = \"--version\" ]; then echo 'codex 0.142.0'; exit 0; fi\n" +
		"if [ \"$1\" = \"app-server\" ]; then TUTTI_CODEX_APP_SERVER_TEST_HELPER=1 exec \"$TUTTI_CODEX_TEST_BINARY\" -test.run=^TestCodexAppServerBlackBoxHelper$; fi\n" +
		"exit 1\n"
	writeCodexBunInstall(t, home, launcher)

	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{
			"PATH=/usr/bin:/bin",
			"TUTTI_CODEX_TEST_BINARY=" + os.Args[0],
		}
	}
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityReady || status.CodexDiagnostics == nil ||
		!status.CodexDiagnostics.Diagnosis.RuntimeReady {
		t.Fatalf("status = %#v, want production app-server handshake to verify Bun runtime", status)
	}
}

func TestCodexAppServerBlackBoxHelper(_ *testing.T) {
	if os.Getenv("TUTTI_CODEX_APP_SERVER_TEST_HELPER") != "1" {
		return
	}
	decoder := json.NewDecoder(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	for {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if err := decoder.Decode(&request); err != nil {
			os.Exit(2)
		}
		switch request.Method {
		case "initialize":
			if err := encoder.Encode(map[string]any{
				"id": request.ID,
				"result": map[string]any{
					"userAgent":      "codex/test",
					"codexHome":      filepath.Join(os.TempDir(), ".codex"),
					"platformOs":     runtime.GOOS,
					"platformFamily": "unix",
				},
			}); err != nil {
				os.Exit(3)
			}
		case "initialized":
			os.Exit(0)
		}
	}
}

// TestCodexInstallSkipsWorkingBunHoistedInstall ensures an explicit install or
// repair action uses the same capability check as status. A working Bun layout
// must not be overwritten by Tutti's npm installer merely because it lacks
// npm's nested platform-package path.
func TestCodexInstallSkipsWorkingBunHoistedInstall(t *testing.T) {
	home := t.TempDir()
	writeCodexBunInstall(t, home, codexBunReadyLauncher)

	service := probeTestService(home)
	service.ProbeReadyAfter = 1500 * time.Millisecond
	service.ProbeTimeout = 5 * time.Second
	service.CodexProtocolProbe = func(context.Context, []string, []string) CodexProbeEvidence {
		return CodexProbeEvidence{CommandStarted: true, ProtocolReady: true}
	}
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	service.InstallCommand = func(context.Context, InstallCommandInput) (InstallCommandResult, error) {
		t.Fatal("InstallCommand called for a probe-verified Bun install")
		return InstallCommandResult{}, nil
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
	if result.Command != "" {
		t.Fatalf("Command = %q, want empty when no install is needed", result.Command)
	}
	if result.Probe == nil || result.Probe.Status != ProbeReady {
		t.Fatalf("Probe = %#v, want a ready runtime probe", result.Probe)
	}
}

func TestCodexInstallDoesNotTreatVersionUpgradeAsNPMRepair(t *testing.T) {
	home := t.TempDir()
	launcher := "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex 0.1.0'; exit 0; fi\nexit 1\n"
	writeCodexBunInstall(t, home, launcher)

	service := probeTestService(home)
	service.CodexProtocolProbe = codexProtocolReadyFixture
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	service.InstallCommand = func(context.Context, InstallCommandInput) (InstallCommandResult, error) {
		t.Fatal("InstallCommand called for a protocol-capable Codex requiring an upgrade")
		return InstallCommandResult{}, nil
	}

	result, err := service.RunAction(context.Background(), RunActionInput{
		Provider: "codex",
		ActionID: ActionInstall,
	})
	if err != nil {
		t.Fatalf("RunAction() error = %v", err)
	}
	if result.Status != RunActionFailed || result.ReasonCode != "codex_version_unsupported" {
		t.Fatalf("result = %#v, want an upgrade-required failure without installation", result)
	}
}

func TestCodexInstallDoesNotOverwriteUnsupportedRuntimeAfterProtocolFailure(t *testing.T) {
	home := t.TempDir()
	launcher := "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex 0.1.0'; exit 0; fi\nexit 1\n"
	writeCodexBunInstall(t, home, launcher)

	service := probeTestService(home)
	service.CodexProtocolProbe = codexProtocolFixture(CodexProbeEvidence{
		CommandStarted: true,
		Category:       "handshake_timeout",
		Message:        "Codex App Server did not respond",
	})
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	service.InstallCommand = func(context.Context, InstallCommandInput) (InstallCommandResult, error) {
		t.Fatal("InstallCommand called for an unsupported Codex runtime without repair authorization")
		return InstallCommandResult{}, nil
	}

	result, err := service.RunAction(context.Background(), RunActionInput{
		Provider: "codex",
		ActionID: ActionInstall,
	})
	if err != nil {
		t.Fatalf("RunAction() error = %v", err)
	}
	if result.Status != RunActionFailed || result.ReasonCode != "post_install_probe_failed" {
		t.Fatalf("result = %#v, want a failed re-probe without installation", result)
	}
	if result.Command != "" {
		t.Fatalf("Command = %q, want no installer command", result.Command)
	}
}

func TestCodexInstallDoesNotNPMRepairBrokenBunInstall(t *testing.T) {
	home := t.TempDir()
	writeCodexBunInstall(t, home, codexBunReadyLauncher)

	service := probeTestService(home)
	service.CodexProtocolProbe = codexProtocolFixture(codexPlatformENOENTFixture())
	service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	service.InstallCommand = func(context.Context, InstallCommandInput) (InstallCommandResult, error) {
		t.Fatal("npm installer called for a Bun-owned Codex package")
		return InstallCommandResult{}, nil
	}

	result, err := service.RunAction(context.Background(), RunActionInput{
		Provider: "codex",
		ActionID: ActionInstall,
	})
	if err != nil {
		t.Fatalf("RunAction() error = %v", err)
	}
	if result.Status != RunActionFailed || result.Command != "" {
		t.Fatalf("result = %#v, want failed diagnosis without npm mutation", result)
	}
}

func TestCodexStandaloneLayoutIsNotApplicableAndNeverRepairable(t *testing.T) {
	for _, test := range []struct {
		name  string
		probe CodexProbeEvidence
		ready bool
	}{
		{name: "protocol ready", probe: CodexProbeEvidence{CommandStarted: true, ProtocolReady: true}, ready: true},
		{name: "protocol failure", probe: CodexProbeEvidence{CommandStarted: true, Category: "handshake_timeout", Message: "timed out"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			home := t.TempDir()
			bin := filepath.Join(home, "bin", "codex")
			writeExecutable(t, bin, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex 0.142.0'; fi\n")
			service := probeTestService(home)
			service.Environ = func() []string { return []string{"PATH=" + filepath.Dir(bin)} }
			service.CodexProtocolProbe = codexProtocolFixture(test.probe)
			service.RunAuthStatusCommand = func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
				return AuthInfo{Status: AuthAuthenticated}, true
			}
			result, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
			if err != nil {
				t.Fatalf("List() error = %v", err)
			}
			status := onlyStatus(t, result)
			if (status.Availability.Status == AvailabilityReady) != test.ready {
				t.Fatalf("availability = %#v, want ready=%v", status.Availability, test.ready)
			}
			if status.CodexDiagnostics == nil {
				t.Fatal("CodexDiagnostics = nil")
			}
			for _, check := range status.CodexDiagnostics.Checks {
				if check.ID == codexCheckPlatformBinary && check.Status != CodexCheckNotApplicable {
					t.Fatalf("platform binary check = %#v, want not_applicable", check)
				}
			}
			if status.CodexDiagnostics.RepairPlan.Allowed {
				t.Fatalf("repair = %#v, want denied for standalone layout", status.CodexDiagnostics.RepairPlan)
			}
		})
	}
}

// TestCodexAvailabilityMissingPlatformPackageReportsIncomplete preserves the
// original diagnostic (acceptance Case B): when `codex app-server` genuinely
// fails because the platform subpackage is missing (ENOENT), the probe
// classifies it and Tutti reports codex_platform_pkg_incomplete — even under a
// Bun/hoisted layout where the structural check alone could not locate the
// nested binary.
func TestCodexAvailabilityMissingPlatformPackageReportsIncomplete(t *testing.T) {
	launcher := "#!/bin/sh\n" +
		"if [ \"$1\" = \"--version\" ]; then echo 'codex 0.142.0'; exit 0; fi\n" +
		"if [ \"$1\" = \"app-server\" ]; then echo 'Cannot find module @openai/codex-darwin-arm64 (enoent)' >&2; exit 127; fi\n" +
		"exit 0\n"
	status := codexBunInstallStatus(t, launcher, codexPlatformENOENTFixture())

	if status.Availability.Status != AvailabilityNotInstalled {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityNotInstalled)
	}
	if status.Availability.ReasonCode != "codex_platform_pkg_incomplete" {
		t.Fatalf("ReasonCode = %q, want codex_platform_pkg_incomplete (classified from probe ENOENT)", status.Availability.ReasonCode)
	}
}

// TestCodexAvailabilityUnclassifiedLaunchFailureReportsGeneric proves
// acceptance Case C / Case 4: the CLI is found and `--version` works, but the
// runtime fails to launch for an unclassified reason. Tutti must keep the
// generic launch-failed reason code (not cli_not_found, not a false
// platform-incomplete) and still report the CLI as installed — "found but
// unavailable".
func TestCodexAvailabilityUnclassifiedLaunchFailureReportsGeneric(t *testing.T) {
	launcher := "#!/bin/sh\n" +
		"if [ \"$1\" = \"--version\" ]; then echo 'codex 0.142.0'; exit 0; fi\n" +
		"if [ \"$1\" = \"app-server\" ]; then echo 'app-server failed' >&2; exit 127; fi\n" +
		"exit 0\n"
	status := codexBunInstallStatus(t, launcher, CodexProbeEvidence{CommandStarted: true, Category: "process_exited_early", Message: "app-server failed"})

	if status.Availability.Status != AvailabilityNotInstalled {
		t.Fatalf("Availability.Status = %q, want %q", status.Availability.Status, AvailabilityNotInstalled)
	}
	if status.Availability.ReasonCode != "acp_adapter_launch_failed" {
		t.Fatalf("ReasonCode = %q, want acp_adapter_launch_failed for an unclassified launch failure", status.Availability.ReasonCode)
	}
	if !status.CLI.Installed {
		t.Fatal("CLI.Installed = false, want true (CLI found but runtime unavailable)")
	}
}
