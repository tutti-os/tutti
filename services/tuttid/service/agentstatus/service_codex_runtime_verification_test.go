package agentstatus

import (
	"context"
	"os"
	"path/filepath"
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
// launcherScript is written verbatim as the codex binary and must implement at
// least the `--version` and `app-server` argv branches the status path
// exercises. It returns the ~/.bun/bin/codex symlink path.
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
// ready-after window is widened past shell-startup latency so a *failing*
// launcher (which exits non-zero) is reliably observed as ProbeFailed rather
// than racing the ready timer; a *healthy* launcher sleeps well past it.
func codexBunInstallStatus(t *testing.T, launcherScript string) ProviderStatus {
	t.Helper()
	home := t.TempDir()
	writeCodexBunInstall(t, home, launcherScript)

	service := probeTestService(home)
	service.ProbeReadyAfter = 1500 * time.Millisecond
	service.ProbeTimeout = 5 * time.Second
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
	"if [ \"$1\" = \"--version\" ]; then echo 'codex 0.142.0'; exit 0; fi\n" +
	"if [ \"$1\" = \"app-server\" ]; then sleep 10; fi\n" +
	"exit 0\n"

// TestCodexAvailabilityBunHoistedInstallVerifiedByProbe is the core regression
// (acceptance Cases 1, 2, 3): a Bun-installed codex (hoisted layout, npm-nested
// platform binary absent) launches `codex app-server` successfully, so the
// probe — not the npm layout — authorizes availability. Tutti must report
// Ready, not codex_platform_pkg_incomplete. PATH is /usr/bin:/bin, so the CLI
// is found via the ~/.bun/bin resolver fallback (the Electron launch case).
func TestCodexAvailabilityBunHoistedInstallVerifiedByProbe(t *testing.T) {
	status := codexBunInstallStatus(t, codexBunReadyLauncher)

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
	status := codexBunInstallStatus(t, launcher)

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
	status := codexBunInstallStatus(t, launcher)

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
