package agentstatus

import (
	"context"
	"os"
	"path/filepath"
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
		filepath.Join("/Users/x/.nvm/versions/node/v24.12.0", "lib", "node_modules", "@openai", "codex"): "/Users/x/.nvm/versions/node/v24.12.0",
		filepath.Join("/Users/x/.local", "lib", "node_modules", "@openai", "codex"):                      "/Users/x/.local",
		filepath.Join("/usr/local", "lib", "node_modules", "@openai", "codex"):                           "/usr/local",
		// Windows npm global layout: <prefix>/node_modules/@openai/codex (no lib)
		filepath.Join("C:/Users/x/AppData/Roaming/npm", "node_modules", "@openai", "codex"): "C:/Users/x/AppData/Roaming/npm",
		// Not npm's global layout -> no prefix derivable.
		filepath.Join("/tmp/standalone/codex"): "",
		"/node_modules/@openai/codex":          "",
	}
	for in, want := range cases {
		if got := codexNPMPrefixFromPackageDir(in); got != want {
			t.Errorf("codexNPMPrefixFromPackageDir(%q) = %q, want %q", in, got, want)
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
	wantPrefix, wantPrefixOK := codexRepairInstallPrefix(existingCLIPath)
	if !wantPrefixOK {
		t.Fatalf("expected repair prefix to be derivable for %s", existingCLIPath)
	}

	var command InstallCommandInput
	service.InstallCommand = func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		command = input
		return InstallCommandResult{ExitCode: 0, Stdout: "repaired"}, nil
	}

	if _, err := service.runCodexCLILatestInstaller(context.Background(), InstallerSpec{
		Kind:     InstallerKindCodexCLILatest,
		CodexCLI: &CodexCLILatestInstallerSpec{},
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

	if _, ok := codexRepairInstallPrefix(standalone); ok {
		t.Fatalf("standalone codex should not yield a repair prefix")
	}

	var command InstallCommandInput
	service.InstallCommand = func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		command = input
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}

	if _, err := service.runCodexCLILatestInstaller(context.Background(), InstallerSpec{
		Kind:     InstallerKindCodexCLILatest,
		CodexCLI: &CodexCLILatestInstallerSpec{},
	}, standalone); err != nil {
		t.Fatalf("runCodexCLILatestInstaller() error = %v", err)
	}
	wantPrefix := filepath.Join(home, ".local")
	if !strings.Contains(command.Command, "--prefix "+wantPrefix+" ") {
		t.Fatalf("Command = %q, want fresh install at --prefix %s", command.Command, wantPrefix)
	}
}

func TestRunCodexCLILatestInstallerUsesManagedRuntimeNPMWhenUserNPMMissing(t *testing.T) {
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

	if _, err := service.runCodexCLILatestInstaller(context.Background(), InstallerSpec{
		Kind:     InstallerKindCodexCLILatest,
		CodexCLI: &CodexCLILatestInstallerSpec{},
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
}

type staticManagedRuntimeResolver struct {
	runtime managedruntime.ResolvedRuntime
}

func (r staticManagedRuntimeResolver) Resolve(context.Context) (managedruntime.ResolvedRuntime, error) {
	return r.runtime, nil
}

func (r staticManagedRuntimeResolver) ResolveProfile(context.Context, string) (managedruntime.ResolvedRuntime, error) {
	return r.runtime, nil
}
