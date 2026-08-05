//go:build !windows

package agentstatus

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

func TestManagedNPMInstallerExecutesPOSIXLauncherWithInheritedPath(t *testing.T) {
	home := t.TempDir()
	runtimeRoot := fakeManagedRuntimeRoot(t)
	npmPath := filepath.Join(runtimeRoot, "node", "bin", npmBinaryNameForTest())
	writeExecutable(t, npmPath, `#!/bin/sh
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
printf 'npm-dir=%s' "$script_dir"
`)

	service := probeTestService(home)
	service.Environ = nil
	service.ManagedRuntime = managedruntime.DefaultResolver{RuntimeRoot: runtimeRoot}
	service.HTTPClient = agentNPMRegistryProbeHTTPClient(nil)

	result, err := service.runManagedNPMPackageInstaller(
		context.Background(),
		"tutti-agent",
		ManagedNPMPackageInstallerSpec{
			PackageName:     "@tutti-os/tutti-agent",
			BinaryName:      "tutti-agent",
			IncludeOptional: true,
		},
		"",
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", result.ExitCode, result.Stderr)
	}
	wantDir := filepath.Join(runtimeRoot, "node", "bin")
	if !strings.Contains(result.Stdout, "npm-dir="+wantDir) {
		t.Fatalf("stdout = %q, want launcher directory %q", result.Stdout, wantDir)
	}
	if _, err := os.Stat(npmPath); err != nil {
		t.Fatalf("npm launcher missing after install: %v", err)
	}
}
