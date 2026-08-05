package agentstatus

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

func TestRunOfficialScriptInstallerRejectsUnixScriptOnNativeWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("native Windows installer policy")
	}

	installCommandCalled := false
	service := Service{
		InstallCommand: func(context.Context, InstallCommandInput) (InstallCommandResult, error) {
			installCommandCalled = true
			return InstallCommandResult{ExitCode: 0}, nil
		},
	}
	result, err := service.runOfficialScriptInstaller(context.Background(), "cursor", InstallerSpec{
		Kind:        InstallerKindOfficialScript,
		ScriptURL:   "https://cursor.com/install",
		ScriptShell: "bash",
	})
	if err != nil {
		t.Fatalf("runOfficialScriptInstaller() error = %v", err)
	}
	if result.ExitCode == 0 || !strings.Contains(result.Stderr, "Unix-only") {
		t.Fatalf("result = %#v, want fail-closed native Windows message", result)
	}
	if installCommandCalled {
		t.Fatal("InstallCommand was called for a Unix-only native Windows installer")
	}
}

func TestRunOfficialScriptInstallerUsesManagedNPMFallbackOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("native Windows installer policy")
	}

	home := t.TempDir()
	runtimeRoot := fakeManagedRuntimeRoot(t)
	managedNPM := filepath.Join(runtimeRoot, "node", "bin", npmBinaryNameForTest())
	managedNode := filepath.Join(runtimeRoot, "node", "bin", nodeBinaryNameForTest())
	managedNodeBinDir := filepath.Dir(managedNode)
	service := probeTestService(home)
	service.HTTPClient = agentNPMRegistryProbeHTTPClient(nil)
	service.Environ = func() []string {
		return []string{"PATH=" + managedNodeBinDir, agentNPMRegistryEnv + "=https://registry.example.test"}
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
				"PATH=" + managedNodeBinDir + string(os.PathListSeparator) + "/usr/bin",
			},
		},
	}
	service.IsExecutableFile = isTestExecutableUnderHome(home)

	var command InstallCommandInput
	service.InstallCommand = func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		command = input
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}

	result, err := service.runOfficialScriptInstaller(context.Background(), "opencode", InstallerSpec{
		Kind:            InstallerKindOfficialScript,
		ScriptURL:       "https://opencode.ai/install",
		ScriptShell:     "bash",
		WindowsFallback: providerregistry.InstallerWindowsFallbackManagedNPM,
		ManagedNPM: &ManagedNPMPackageInstallerSpec{
			PackageName: "opencode-ai",
			BinaryName:  "opencode",
		},
	})
	if err != nil {
		t.Fatalf("runOfficialScriptInstaller() error = %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("result = %#v, want managed npm success", result)
	}
	if !strings.Contains(command.Command, "opencode-ai") || !strings.Contains(command.Command, "install") {
		t.Fatalf("Command = %q, want managed npm install", command.Command)
	}
}

func TestRunOfficialScriptInstallerUsesPowerShellFallbackOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("native Windows installer policy")
	}

	service := probeTestService(t.TempDir())
	var command InstallCommandInput
	service.InstallCommand = func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
		command = input
		return InstallCommandResult{ExitCode: 0, Stdout: "installed"}, nil
	}

	result, err := service.runOfficialScriptInstaller(context.Background(), "cursor", InstallerSpec{
		Kind:                     InstallerKindOfficialScript,
		ScriptURL:                "https://cursor.com/install",
		ScriptShell:              "bash",
		WindowsFallback:          providerregistry.InstallerWindowsFallbackPowerShell,
		WindowsPowerShellCommand: "irm 'https://cursor.com/install?win32=true' | iex",
	})
	if err != nil {
		t.Fatalf("runOfficialScriptInstaller() error = %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("result = %#v, want PowerShell success", result)
	}
	if command.Command != "" {
		t.Fatalf("Command = %q, want empty when Args carries executable", command.Command)
	}
	if len(command.Args) == 0 || !strings.EqualFold(command.Args[0], "powershell.exe") {
		t.Fatalf("Args = %#v, want powershell.exe as executable", command.Args)
	}
	joined := strings.Join(command.Args, " ")
	if !strings.Contains(joined, "cursor.com/install?win32=true") || !strings.Contains(joined, "iex") {
		t.Fatalf("Args = %#v, want Cursor native Windows install command", command.Args)
	}
}
