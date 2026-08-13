package implementationhost

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	market "github.com/tutti-os/tutti/packages/connector/host"
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
