package agentstatus

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

func TestDisplayNPMRegistryStripsCredentials(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		// Plain registries (and the test override) pass through unchanged.
		"https://registry.npmjs.org":    "https://registry.npmjs.org",
		"https://registry.example.test": "https://registry.example.test",
		"registry.example.test":         "registry.example.test",
		// Embedded credentials are stripped before status/log exposure.
		"https://user:token@registry.foo/path": "https://registry.foo/path",
		"https://token@registry.foo":           "https://registry.foo",
	}
	for in, want := range cases {
		if got := displayNPMRegistry(in); got != want {
			t.Errorf("displayNPMRegistry(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCodexNPMPrefixFromPackageDir(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		// Unix npm global layout: <prefix>/lib/node_modules/@openai/codex
		filepath.FromSlash("/Users/x/.nvm/versions/node/v24.12.0/lib/node_modules/@openai/codex"): filepath.FromSlash("/Users/x/.nvm/versions/node/v24.12.0"),
		filepath.FromSlash("/Users/x/.local/lib/node_modules/@openai/codex"):                      filepath.FromSlash("/Users/x/.local"),
		filepath.FromSlash("/usr/local/lib/node_modules/@openai/codex"):                           filepath.FromSlash("/usr/local"),
		// Windows npm global layout: <prefix>/node_modules/@openai/codex (no lib)
		filepath.FromSlash("C:/Users/x/AppData/Roaming/npm/node_modules/@openai/codex"): filepath.FromSlash("C:/Users/x/AppData/Roaming/npm"),
		// Not npm's global layout -> no prefix derivable.
		filepath.Join("/tmp/standalone/codex"):            "",
		filepath.FromSlash("/node_modules/@openai/codex"): "",
	}
	for in, want := range cases {
		if got := npmGlobalPrefixFromPackageDir(in); got != want {
			t.Errorf("npmGlobalPrefixFromPackageDir(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestManagedNPMGlobalPackageDirRejectsUnsafePackageNames(t *testing.T) {
	t.Parallel()

	for _, packageName := range []string{
		"",
		".",
		"..",
		"../tutti-agent",
		"@tutti-os",
		"@tutti-os/../tutti-agent",
		"@tutti-os/tutti-agent/extra",
		`@tutti-os\tutti-agent`,
	} {
		if path, ok := managedNPMGlobalPackageDir("/safe/prefix", packageName); ok {
			t.Errorf("managedNPMGlobalPackageDir(%q) = %q, want rejected", packageName, path)
		}
	}
}

// TestRunCodexCLILatestInstallerRepairsInPlace verifies that when an existing
// @openai/codex install is resolved but incomplete, the installer reinstalls
// into the npm global prefix that already owns it (repair-in-place) rather than
// duplicating the package in ~/.local.
func TestRunCodexCLILatestInstallerRepairsInPlace(t *testing.T) {
	home := t.TempDir()
	// Mimic an nvm-style global install with a missing platform subpackage.
	nvmPrefix := filepath.Join(home, ".nvm", "versions", "node", "v24.12.0")
	pkgDir := filepath.Join(nvmPrefix, "lib", "node_modules", "@openai", "codex")
	writePackageManifest(t, pkgDir, "@openai/codex", MinSupportedCodexVersion)
	codexBin := filepath.Join(pkgDir, "bin", "codex")
	writeExecutable(t, codexBin, "#!/bin/sh\nexit 0\n")
	binDir := filepath.Join(nvmPrefix, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}
	if err := os.Symlink(codexBin, filepath.Join(binDir, "codex")); err != nil {
		t.Fatalf("symlink codex: %v", err)
	}
	// Fake npm/node on PATH so the resolver finds them.
	writeExecutable(t, filepath.Join(binDir, npmBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(binDir, nodeBinaryNameForTest()), "#!/bin/sh\nexit 0\n")

	service := probeTestService(home)
	service.HTTPClient = agentNPMRegistryProbeHTTPClient(nil)
	service.Environ = func() []string { return []string{"PATH=" + binDir} }
	service.IsExecutableFile = isTestExecutableUnderHome(home)

	existingCLIPath := filepath.Join(binDir, "codex")
	wantPrefix, wantPrefixOK := managedNPMRepairInstallPrefix(existingCLIPath, "@openai/codex")
	if !wantPrefixOK {
		t.Fatalf("expected repair prefix to be derivable for %s", existingCLIPath)
	}

	var command InstallCommandInput
	service.InstallCommand = func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		command = input
		return InstallCommandResult{ExitCode: 0, Stdout: "repaired"}, nil
	}

	if _, err := service.runCodexCLILatestInstaller(context.Background(), "codex", InstallerSpec{
		Kind:     InstallerKindCodexCLILatest,
		CodexCLI: codexCLIInstallerSpec().CodexCLI,
	}, existingCLIPath); err != nil {
		t.Fatalf("runCodexCLILatestInstaller() error = %v", err)
	}
	if !strings.Contains(command.Command, "--prefix "+wantPrefix+" ") {
		t.Fatalf("Command = %q, want repair-in-place at --prefix %s", command.Command, wantPrefix)
	}
	if strings.Contains(command.Command, filepath.Join(home, ".local")) {
		t.Fatalf("Command = %q, repair-in-place must not duplicate the package in ~/.local", command.Command)
	}
}

func TestManagedNPMResultHasReplacementLock(t *testing.T) {
	if !managedNPMResultHasReplacementLock(InstallCommandResult{
		ExitCode: 0,
		Stderr:   "npm warn cleanup EPERM: operation not permitted, unlink 'tutti-agent.exe'",
	}) {
		t.Fatal("EPERM executable replacement warning was not classified as a partial install")
	}
	if managedNPMResultHasReplacementLock(InstallCommandResult{
		ExitCode: 0,
		Stderr:   "npm WARN deprecated package@1.0.0: this package is deprecated",
	}) {
		t.Fatal("unrelated npm warning was classified as a replacement lock")
	}
}

func TestRunManagedNPMPackageInstallerRejectsPersistentLockedExecutableReplacement(t *testing.T) {
	home := t.TempDir()
	runtimeRoot := fakeManagedRuntimeRoot(t)
	managedNPM := filepath.Join(runtimeRoot, "node", "bin", npmBinaryNameForTest())
	managedNode := filepath.Join(runtimeRoot, "node", "bin", nodeBinaryNameForTest())
	managedNodeBinDir := filepath.Dir(managedNode)

	service := probeTestService(home)
	service.HTTPClient = agentNPMRegistryProbeHTTPClient(nil)
	service.Environ = func() []string {
		return []string{"PATH=/usr/bin:/bin", agentNPMRegistryEnv + "=https://registry.example.test"}
	}
	service.ManagedRuntime = staticManagedRuntimeResolver{
		runtime: managedruntime.ResolvedRuntime{
			Root:    runtimeRoot,
			Node:    managedNode,
			NPM:     managedNPM,
			BinDirs: []string{managedNodeBinDir},
			EnvOverrides: []string{
				"TUTTI_APP_RUNTIME_ROOT=" + runtimeRoot,
				"TUTTI_APP_NODE=" + managedNode,
				"TUTTI_APP_NPM=" + managedNPM,
				"PATH=" + managedNodeBinDir + string(os.PathListSeparator) + "/usr/bin" + string(os.PathListSeparator) + "/bin",
			},
		},
	}
	service.IsExecutableFile = isTestExecutableUnderHome(home)
	installCalls := 0
	service.InstallCommand = func(_ context.Context, _ InstallCommandInput) (InstallCommandResult, error) {
		installCalls++
		return InstallCommandResult{
			ExitCode: 0,
			Stderr:   "npm warn cleanup EPERM: operation not permitted, unlink 'tutti-agent.exe'",
		}, nil
	}

	result, err := service.runManagedNPMPackageInstaller(context.Background(), "tutti-agent", ManagedNPMPackageInstallerSpec{
		PackageName:     "@tutti-os/tutti-agent",
		BinaryName:      "tutti-agent",
		IncludeOptional: true,
	}, "")
	if err != nil {
		t.Fatalf("runManagedNPMPackageInstaller() error = %v", err)
	}
	if installCalls != 2 {
		t.Fatalf("install command calls = %d, want one retry after locked replacement", installCalls)
	}
	if result.ExitCode == 0 {
		t.Fatalf("result = %#v, want persistent locked replacement to fail", result)
	}
}

// TestRunCodexCLILatestInstallerFallsBackToLocalBin verifies that when the
// existing codex binary is not from an npm global install (no package layout to
// derive a prefix from), the installer falls back to a fresh install in ~/.local.
func TestRunCodexCLILatestInstallerFallsBackToLocalBin(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	// Standalone codex binary with no @openai/codex package.json above it.
	standalone := filepath.Join(binDir, "codex")
	writeExecutable(t, standalone, "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(binDir, npmBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(binDir, nodeBinaryNameForTest()), "#!/bin/sh\nexit 0\n")

	service := probeTestService(home)
	service.HTTPClient = agentNPMRegistryProbeHTTPClient(nil)
	service.Environ = func() []string { return []string{"PATH=" + binDir} }
	service.IsExecutableFile = isTestExecutableUnderHome(home)

	if _, ok := managedNPMRepairInstallPrefix(standalone, "@openai/codex"); ok {
		t.Fatalf("standalone codex should not yield a repair prefix")
	}

	var command InstallCommandInput
	service.InstallCommand = func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		command = input
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}

	if _, err := service.runCodexCLILatestInstaller(context.Background(), "codex", InstallerSpec{
		Kind:     InstallerKindCodexCLILatest,
		CodexCLI: codexCLIInstallerSpec().CodexCLI,
	}, standalone); err != nil {
		t.Fatalf("runCodexCLILatestInstaller() error = %v", err)
	}
	wantPrefix := managedNPMInstallPrefixForTest(home)
	if !strings.Contains(command.Command, wantPrefix) {
		t.Fatalf("Command = %q, want fresh install at --prefix %s", command.Command, wantPrefix)
	}
}

func TestRunCodexCLILatestInstallerUsesManagedRuntimeNPMWhenUserNPMMissing(t *testing.T) {
	const provider = "descriptor-codex"
	home := t.TempDir()
	runtimeRoot := fakeManagedRuntimeRoot(t)
	managedNPM := filepath.Join(runtimeRoot, "node", "bin", npmBinaryNameForTest())
	managedNode := filepath.Join(runtimeRoot, "node", "bin", nodeBinaryNameForTest())
	managedNodeBinDir := filepath.Dir(managedNode)

	service := probeTestService(home)
	service.HTTPClient = agentNPMRegistryProbeHTTPClient(nil)
	service.Environ = func() []string {
		return []string{"PATH=/usr/bin:/bin", agentNPMRegistryEnv + "=https://registry.example.test"}
	}
	service.ManagedRuntime = staticManagedRuntimeResolver{
		runtime: managedruntime.ResolvedRuntime{
			Root:    runtimeRoot,
			Node:    managedNode,
			NPM:     managedNPM,
			BinDirs: []string{managedNodeBinDir},
			EnvOverrides: []string{
				"TUTTI_APP_RUNTIME_ROOT=" + runtimeRoot,
				"TUTTI_APP_NODE=" + managedNode,
				"TUTTI_APP_NPM=" + managedNPM,
				"PATH=" + managedNodeBinDir + string(os.PathListSeparator) + "/usr/bin" + string(os.PathListSeparator) + "/bin",
			},
		},
	}
	service.IsExecutableFile = isTestExecutableUnderHome(home)

	var command InstallCommandInput
	service.InstallCommand = func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		command = input
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}

	ctx := withActiveActionToken(context.Background(), nextActiveActionToken())
	claimActiveAction(ctx, provider, ActiveAction{ID: ActionInstall, Status: "running"})
	defer clearActiveAction(ctx, provider)
	if _, err := service.runCodexCLILatestInstaller(ctx, provider, InstallerSpec{
		Kind:     InstallerKindCodexCLILatest,
		CodexCLI: codexCLIInstallerSpec().CodexCLI,
	}, ""); err != nil {
		t.Fatalf("runCodexCLILatestInstaller() error = %v", err)
	}
	if !strings.Contains(command.Command, managedNPM) ||
		!strings.Contains(command.Command, "install") ||
		!strings.Contains(command.Command, "@openai/codex") ||
		!strings.Contains(command.Command, "--include=optional") ||
		!strings.Contains(command.Command, "--prefix") {
		t.Fatalf("Command = %q, want managed runtime npm install", command.Command)
	}
	if !slices.Contains(command.Env, "TUTTI_APP_NPM="+managedNPM) {
		t.Fatalf("Env = %#v, want managed runtime npm marker", command.Env)
	}
	if !slices.Contains(command.Env, "TUTTI_APP_NODE="+managedNode) {
		t.Fatalf("Env = %#v, want managed runtime node marker", command.Env)
	}
	if !slices.Contains(command.Env, "npm_config_registry=https://registry.example.test") {
		t.Fatalf("Env = %#v, want selected npm registry", command.Env)
	}
	action := activeActionForProvider(provider)
	if action == nil {
		t.Fatal("custom provider active action missing")
	}
	if action.Registry != "https://registry.example.test" || action.NodeTarget != managedNode {
		t.Fatalf("custom provider active action = %#v", action)
	}
}

func TestRunManagedNPMPackageInstallerInstallsTuttiAgentWithManagedRuntime(t *testing.T) {
	home := t.TempDir()
	runtimeRoot := fakeManagedRuntimeRoot(t)
	managedNPM := filepath.Join(runtimeRoot, "node", "bin", npmBinaryNameForTest())
	managedNode := filepath.Join(runtimeRoot, "node", "bin", nodeBinaryNameForTest())
	managedNodeBinDir := filepath.Dir(managedNode)

	service := probeTestService(home)
	service.HTTPClient = agentNPMRegistryProbeHTTPClient(nil)
	service.Environ = func() []string {
		return []string{"PATH=/usr/bin:/bin", agentNPMRegistryEnv + "=https://registry.example.test"}
	}
	service.ManagedRuntime = staticManagedRuntimeResolver{
		runtime: managedruntime.ResolvedRuntime{
			Root:    runtimeRoot,
			Node:    managedNode,
			NPM:     managedNPM,
			BinDirs: []string{managedNodeBinDir},
			EnvOverrides: []string{
				"TUTTI_APP_RUNTIME_ROOT=" + runtimeRoot,
				"TUTTI_APP_NODE=" + managedNode,
				"TUTTI_APP_NPM=" + managedNPM,
				"PATH=" + managedNodeBinDir + string(os.PathListSeparator) + "/usr/bin" + string(os.PathListSeparator) + "/bin",
			},
		},
	}
	service.IsExecutableFile = isTestExecutableUnderHome(home)

	var command InstallCommandInput
	service.InstallCommand = func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		command = input
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}

	if _, err := service.runManagedNPMPackageInstaller(context.Background(), "tutti-agent", ManagedNPMPackageInstallerSpec{
		PackageName:     "@tutti-os/tutti-agent",
		BinaryName:      "tutti-agent",
		IncludeOptional: true,
	}, ""); err != nil {
		t.Fatalf("runManagedNPMPackageInstaller() error = %v", err)
	}
	if !strings.Contains(command.Command, managedNPM) ||
		!strings.Contains(command.Command, "install") ||
		!strings.Contains(command.Command, "@tutti-os/tutti-agent") ||
		!strings.Contains(command.Command, "--include=optional") ||
		!strings.Contains(command.Command, "--prefix") {
		t.Fatalf("Command = %q, want managed runtime npm install", command.Command)
	}
	if !slices.Contains(command.Env, "TUTTI_APP_NPM="+managedNPM) {
		t.Fatalf("Env = %#v, want managed runtime npm marker", command.Env)
	}
	if !slices.Contains(command.Env, "TUTTI_APP_NODE="+managedNode) {
		t.Fatalf("Env = %#v, want managed runtime node marker", command.Env)
	}
	if !slices.Contains(command.Env, "npm_config_registry=https://registry.example.test") {
		t.Fatalf("Env = %#v, want selected npm registry", command.Env)
	}
}

func TestRunManagedNPMPackageInstallerCleansOnlyOwnStaleStagingDirectories(t *testing.T) {
	home := t.TempDir()
	runtimeRoot := fakeManagedRuntimeRoot(t)
	managedNPM := filepath.Join(runtimeRoot, "node", "bin", npmBinaryNameForTest())
	managedNode := filepath.Join(runtimeRoot, "node", "bin", nodeBinaryNameForTest())
	managedNodeBinDir := filepath.Dir(managedNode)
	installPrefix := managedNPMInstallPrefixForTest(home)
	packageDir, ok := managedNPMGlobalPackageDir(installPrefix, "@tutti-os/tutti-agent")
	if !ok {
		t.Fatal("managed npm package directory was not resolved")
	}
	staleDir := filepath.Join(filepath.Dir(packageDir), ".tutti-agent-8IDARXyS")
	unrelatedStagingDir := filepath.Join(filepath.Dir(packageDir), ".other-package-12345678")
	for _, dir := range []string{packageDir, staleDir, unrelatedStagingDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}

	service := probeTestService(home)
	service.HTTPClient = agentNPMRegistryProbeHTTPClient(nil)
	service.Environ = func() []string {
		return []string{"PATH=/usr/bin:/bin", agentNPMRegistryEnv + "=https://registry.example.test"}
	}
	service.ManagedRuntime = staticManagedRuntimeResolver{
		runtime: managedruntime.ResolvedRuntime{
			Root:    runtimeRoot,
			Node:    managedNode,
			NPM:     managedNPM,
			BinDirs: []string{managedNodeBinDir},
			EnvOverrides: []string{
				"TUTTI_APP_RUNTIME_ROOT=" + runtimeRoot,
				"TUTTI_APP_NODE=" + managedNode,
				"TUTTI_APP_NPM=" + managedNPM,
				"PATH=" + managedNodeBinDir + string(os.PathListSeparator) + "/usr/bin" + string(os.PathListSeparator) + "/bin",
			},
		},
	}
	service.IsExecutableFile = isTestExecutableUnderHome(home)
	service.InstallCommand = func(_ context.Context, _ InstallCommandInput) (InstallCommandResult, error) {
		if _, err := os.Stat(staleDir); !os.IsNotExist(err) {
			t.Fatalf("stale package staging directory still exists before install: %v", err)
		}
		for _, path := range []string{packageDir, unrelatedStagingDir} {
			if _, err := os.Stat(path); err != nil {
				t.Fatalf("unrelated path %s was removed: %v", path, err)
			}
		}
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}

	if _, err := service.runManagedNPMPackageInstaller(context.Background(), "tutti-agent", ManagedNPMPackageInstallerSpec{
		PackageName:     "@tutti-os/tutti-agent",
		BinaryName:      "tutti-agent",
		IncludeOptional: true,
	}, ""); err != nil {
		t.Fatalf("runManagedNPMPackageInstaller() error = %v", err)
	}
}

func TestRunManagedNPMPackageInstallerCleansStagingAfterInterruptedAttempt(t *testing.T) {
	home := t.TempDir()
	runtimeRoot := fakeManagedRuntimeRoot(t)
	managedNPM := filepath.Join(runtimeRoot, "node", "bin", npmBinaryNameForTest())
	managedNode := filepath.Join(runtimeRoot, "node", "bin", nodeBinaryNameForTest())
	managedNodeBinDir := filepath.Dir(managedNode)
	installPrefix := managedNPMInstallPrefixForTest(home)
	packageDir, ok := managedNPMGlobalPackageDir(installPrefix, "@tutti-os/tutti-agent")
	if !ok {
		t.Fatal("managed npm package directory was not resolved")
	}
	staleDir := filepath.Join(filepath.Dir(packageDir), ".tutti-agent-canceled")

	service := probeTestService(home)
	service.HTTPClient = agentNPMRegistryProbeHTTPClient(nil)
	service.Environ = func() []string {
		return []string{"PATH=/usr/bin:/bin", agentNPMRegistryEnv + "=https://registry.example.test"}
	}
	service.ManagedRuntime = staticManagedRuntimeResolver{
		runtime: managedruntime.ResolvedRuntime{
			Root:    runtimeRoot,
			Node:    managedNode,
			NPM:     managedNPM,
			BinDirs: []string{managedNodeBinDir},
			EnvOverrides: []string{
				"TUTTI_APP_RUNTIME_ROOT=" + runtimeRoot,
				"TUTTI_APP_NODE=" + managedNode,
				"TUTTI_APP_NPM=" + managedNPM,
				"PATH=" + managedNodeBinDir + string(os.PathListSeparator) + "/usr/bin" + string(os.PathListSeparator) + "/bin",
			},
		},
	}
	service.IsExecutableFile = isTestExecutableUnderHome(home)
	service.InstallCommand = func(_ context.Context, _ InstallCommandInput) (InstallCommandResult, error) {
		if err := os.MkdirAll(staleDir, 0o755); err != nil {
			t.Fatalf("mkdir stale staging directory: %v", err)
		}
		return InstallCommandResult{ExitCode: -1}, context.Canceled
	}

	if _, err := service.runManagedNPMPackageInstaller(context.Background(), "tutti-agent", ManagedNPMPackageInstallerSpec{
		PackageName:     "@tutti-os/tutti-agent",
		BinaryName:      "tutti-agent",
		IncludeOptional: true,
	}, ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("runManagedNPMPackageInstaller() error = %v, want context canceled", err)
	}
	if _, err := os.Stat(staleDir); !os.IsNotExist(err) {
		t.Fatalf("stale staging directory remains after interrupted install: %v", err)
	}
}

func TestRunManagedNPMPackageInstallerRepairsManagedBinEEXIST(t *testing.T) {
	home := t.TempDir()
	runtimeRoot := fakeManagedRuntimeRoot(t)
	managedNPM := filepath.Join(runtimeRoot, "node", "bin", npmBinaryNameForTest())
	managedNode := filepath.Join(runtimeRoot, "node", "bin", nodeBinaryNameForTest())
	managedNodeBinDir := filepath.Dir(managedNode)
	conflictPath := filepath.Join(home, ".local", "bin", "tutti-agent")
	writeExecutable(t, conflictPath, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'tutti-agent 0.0.5.1'; exit 0; fi\nexit 0\n")

	service := probeTestService(home)
	service.HTTPClient = agentNPMRegistryProbeHTTPClient(nil)
	service.Environ = func() []string {
		return []string{"PATH=/usr/bin:/bin", agentNPMRegistryEnv + "=https://registry.example.test"}
	}
	service.ManagedRuntime = staticManagedRuntimeResolver{
		runtime: managedruntime.ResolvedRuntime{
			Root:    runtimeRoot,
			Node:    managedNode,
			NPM:     managedNPM,
			BinDirs: []string{managedNodeBinDir},
			EnvOverrides: []string{
				"TUTTI_APP_RUNTIME_ROOT=" + runtimeRoot,
				"TUTTI_APP_NODE=" + managedNode,
				"TUTTI_APP_NPM=" + managedNPM,
				"PATH=" + managedNodeBinDir + string(os.PathListSeparator) + "/usr/bin" + string(os.PathListSeparator) + "/bin",
			},
		},
	}
	service.IsExecutableFile = isTestExecutableUnderHome(home)

	var commands []InstallCommandInput
	service.InstallCommand = func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		commands = append(commands, input)
		if len(commands) == 1 {
			return InstallCommandResult{
				ExitCode: 1,
				Stderr:   "npm error code EEXIST\nnpm error path " + conflictPath + "\nnpm error File exists: " + conflictPath,
			}, nil
		}
		if _, err := os.Stat(conflictPath); !os.IsNotExist(err) {
			t.Fatalf("conflict path still exists before retry: %v", err)
		}
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}

	if _, err := service.runManagedNPMPackageInstaller(context.Background(), "tutti-agent", ManagedNPMPackageInstallerSpec{
		PackageName:     "@tutti-os/tutti-agent",
		PackageVersion:  "0.0.5",
		BinaryName:      "tutti-agent",
		IncludeOptional: true,
	}, conflictPath); err != nil {
		t.Fatalf("runManagedNPMPackageInstaller() error = %v", err)
	}
	if len(commands) != 2 {
		t.Fatalf("install command calls = %d, want EEXIST retry", len(commands))
	}
}

type staticManagedRuntimeResolver struct {
	runtime managedruntime.ResolvedRuntime
}

func TestManagedNPMRepairInstallPrefixFindsWindowsNPMShim(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows npm shims use a different global layout")
	}
	home := t.TempDir()
	prefix := filepath.Join(home, ".local", "bin")
	packageDir := filepath.Join(prefix, "node_modules", "@openai", "codex")
	writePackageManifest(t, packageDir, "@openai/codex", MinSupportedCodexVersion)
	shim := filepath.Join(prefix, "codex.cmd")
	if err := os.WriteFile(shim, []byte("@echo off\r\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got, ok := managedNPMRepairInstallPrefix(shim, "@openai/codex"); !ok || got != prefix {
		t.Fatalf("managedNPMRepairInstallPrefix() = %q, %t; want %q, true", got, ok, prefix)
	}
}

func TestRunCodexCLILatestInstallerRepairsLegacyWindowsPrefixInPlace(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows legacy npm prefix behavior")
	}
	home := t.TempDir()
	legacyPrefix := filepath.Join(home, ".local")
	packageDir := filepath.Join(legacyPrefix, "node_modules", "@openai", "codex")
	writePackageManifest(t, packageDir, "@openai/codex", MinSupportedCodexVersion)
	legacyShim := filepath.Join(legacyPrefix, "codex.cmd")
	writeExecutable(t, legacyShim, "@echo off\r\n")

	runtimeRoot := fakeManagedRuntimeRoot(t)
	managedNPM := filepath.Join(runtimeRoot, "node", "bin", npmBinaryNameForTest())
	managedNode := filepath.Join(runtimeRoot, "node", "bin", nodeBinaryNameForTest())
	service := probeTestService(home)
	service.HTTPClient = agentNPMRegistryProbeHTTPClient(nil)
	service.ManagedRuntime = staticManagedRuntimeResolver{runtime: managedruntime.ResolvedRuntime{
		Root:         runtimeRoot,
		Node:         managedNode,
		NPM:          managedNPM,
		BinDirs:      []string{filepath.Dir(managedNode)},
		EnvOverrides: []string{"PATH=" + filepath.Dir(managedNode)},
	}}

	var command InstallCommandInput
	service.InstallCommand = func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		command = input
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}
	if _, err := service.runCodexCLILatestInstaller(context.Background(), "codex", InstallerSpec{
		Kind:     InstallerKindCodexCLILatest,
		CodexCLI: codexCLIInstallerSpec().CodexCLI,
	}, legacyShim); err != nil {
		t.Fatalf("runCodexCLILatestInstaller() error = %v", err)
	}
	wantPrefix := legacyPrefix
	if len(command.Args) < 2 || command.Args[0] == "" {
		t.Fatalf("Command args = %#v, want npm install arguments", command.Args)
	}
	gotPrefix := ""
	for index, arg := range command.Args {
		if arg == "--prefix" && index+1 < len(command.Args) {
			gotPrefix = command.Args[index+1]
			break
		}
	}
	if gotPrefix != wantPrefix {
		t.Fatalf("Command args = %#v, want legacy Windows prefix repaired in place at %s", command.Args, wantPrefix)
	}
}

func managedNPMInstallPrefixForTest(home string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(home, ".local", "bin")
	}
	return filepath.Join(home, ".local")
}

func (r staticManagedRuntimeResolver) Resolve(context.Context) (managedruntime.ResolvedRuntime, error) {
	return r.runtime, nil
}

func (r staticManagedRuntimeResolver) ResolveProfile(context.Context, string) (managedruntime.ResolvedRuntime, error) {
	return r.runtime, nil
}
