package implementationhost

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
)

func TestConnectorCLIShimExecutesVerifiedEntrypointThroughNormalShellPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix shim execution test")
	}
	root := t.TempDir()
	working := filepath.Join(root, "working directory")
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(working, 0o700); err != nil {
		t.Fatal(err)
	}
	entrypoint := filepath.Join(root, "connector executable")
	entrypointContent := "#!/bin/sh\nprintf '%s|%s|%s|%s' \"$TUTTI_CONNECTOR_KEY\" \"$PWD\" \"$1\" \"$2\"\n"
	if err := os.WriteFile(entrypoint, []byte(entrypointContent), 0o700); err != nil {
		t.Fatal(err)
	}
	route := &connectorRoute{
		connectionID: "default", connectorKey: "github", userHome: root,
		generation: market.HostGeneration{BootEpoch: "boot", Generation: 1},
		cliLaunch: &managedCLILaunch{executable: connectorruntime.ConnectorExecutable{Path: entrypoint},
			arguments: []string{"fixed argument"}, cwd: working, stateDir: filepath.Join(root, "state"), language: "node"},
	}
	if err := route.prepareCLIShim(binDir); err != nil {
		t.Fatal(err)
	}
	if err := route.activateCLIShim(); err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command(route.cliShimPath, "user argument").CombinedOutput()
	if err != nil {
		t.Fatalf("execute CLI shim: %v: %s", err, output)
	}
	want := strings.Join([]string{"github", working, "fixed argument", "user argument"}, "|")
	if string(output) != want {
		t.Fatalf("CLI output = %q, want %q", output, want)
	}
	route.removeCLIShimIfCurrent()
	if _, err := os.Stat(route.cliShimPath); !os.IsNotExist(err) {
		t.Fatalf("CLI shim remained after route removal: %v", err)
	}
}

func TestAttachCLIUsesArtifactNativeExecutableWithoutManagedRuntimeArgument(t *testing.T) {
	root := t.TempDir()
	entrypointRelative := "runtime/windows-amd64/gh.exe"
	entrypoint := filepath.Join(root, filepath.FromSlash(entrypointRelative))
	if err := os.MkdirAll(filepath.Dir(entrypoint), 0o700); err != nil {
		t.Fatal(err)
	}
	content := []byte("verified gh fixture")
	if err := os.WriteFile(entrypoint, content, 0o600); err != nil {
		t.Fatal(err)
	}
	managed := &market.ManagedStdioImplementation{Runtime: market.RuntimeRequirement{Language: "node"},
		CLI: &market.ManagedCLIInterface{Entrypoint: entrypointRelative, Command: "gh", TimeoutMS: 30_000,
			Launch: &market.CLIArtifactLaunch{Kind: market.CLIArtifactLaunchKindNative,
				SHA256: strings.Repeat("a", 64), SizeBytes: int64(len(content))}}}
	route := &connectorRoute{}
	if err := (&Host{}).attachCLI(route, managed, market.PreparedArtifactReceipt{PreparedPath: root}, nil,
		connectorruntime.ConnectorExecutable{Path: filepath.Join(root, "node")}, filepath.Join(root, "state"), nil); err != nil {
		t.Fatal(err)
	}
	if route.cliLaunch.executable.Path != entrypoint || route.cliLaunch.executable.SHA256 != strings.Repeat("a", 64) ||
		route.cliLaunch.executable.SizeBytes != int64(len(content)) || len(route.cliLaunch.arguments) != 0 ||
		route.cliInvocationCommand != "gh" {
		t.Fatalf("artifact-native CLI launch = %#v", route.cliLaunch)
	}
}
