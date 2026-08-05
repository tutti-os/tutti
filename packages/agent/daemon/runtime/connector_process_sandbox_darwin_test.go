//go:build darwin

package agentruntime

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestDarwinConnectorSandboxProfileRunsOnlyThePinnedExecutableWithoutBroadProcessOrMachAccess(t *testing.T) {
	profile, err := darwinConnectorSandboxProfile(ConnectorSandboxPolicy{ReadOnlyPaths: []string{"/bin"}}, "/bin/echo")
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"(allow process*)", "(allow mach-lookup)", "(allow network*)"} {
		if strings.Contains(profile, forbidden) {
			t.Fatalf("profile contains broad permission %q:\n%s", forbidden, profile)
		}
	}
	if output, err := exec.Command(connectorSandboxExecutable, "-p", profile, "/bin/echo", "sandbox-ok").CombinedOutput(); err != nil {
		t.Fatalf("sandbox smoke test failed: %v: %s", err, output)
	}
	if output, err := exec.Command(connectorSandboxExecutable, "-p", profile, "/usr/bin/touch", t.TempDir()+"/denied").CombinedOutput(); err == nil {
		t.Fatalf("sandbox admitted an unpinned executable: %s", output)
	}
}

func TestDarwinConnectorSandboxProfileRunsManagedNodeEntrypoint(t *testing.T) {
	nodePath, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node runtime is unavailable")
	}
	nodePath, err = filepath.EvalSymlinks(nodePath)
	if err != nil {
		t.Fatal(err)
	}
	artifactRoot := t.TempDir()
	entrypoint := filepath.Join(artifactRoot, "connector.js")
	if err := os.WriteFile(entrypoint, []byte(`process.stdout.write("node-sandbox-ok")`), 0o600); err != nil {
		t.Fatal(err)
	}
	entrypoint, err = filepath.EvalSymlinks(entrypoint)
	if err != nil {
		t.Fatal(err)
	}
	profile, err := darwinConnectorSandboxProfile(ConnectorSandboxPolicy{ReadOnlyPaths: []string{artifactRoot, filepath.Dir(nodePath)}}, nodePath)
	if err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command(connectorSandboxExecutable, "-p", profile, nodePath, entrypoint).CombinedOutput()
	if err != nil {
		t.Fatalf("managed node sandbox smoke test failed: %v: %s", err, output)
	}
	if string(output) != "node-sandbox-ok" {
		t.Fatalf("managed node output = %q", output)
	}
}

func TestDarwinConnectorSandboxDeniesNodeNetworkAndSecondaryExec(t *testing.T) {
	nodePath, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node runtime is unavailable")
	}
	nodePath, err = filepath.EvalSymlinks(nodePath)
	if err != nil {
		t.Fatal(err)
	}
	artifactRoot := t.TempDir()
	entrypoint := filepath.Join(artifactRoot, "deny-check.js")
	script := `
const child = require("node:child_process").spawnSync("/bin/echo", ["forbidden"]);
const socket = require("node:net").connect({host: "8.8.8.8", port: 53});
socket.once("connect", () => { process.stdout.write("network-allowed"); process.exit(2); });
socket.once("error", (error) => {
  const execDenied = child.error && (child.error.code === "EPERM" || child.error.code === "EACCES");
  const networkDenied = error.code === "EPERM" || error.code === "EACCES";
  process.stdout.write(execDenied && networkDenied ? "denied" : "unexpected:" + child.error?.code + ":" + error.code);
  process.exit(execDenied && networkDenied ? 0 : 3);
});
setTimeout(() => { process.stdout.write("network-timeout"); process.exit(4); }, 2000);
`
	if err := os.WriteFile(entrypoint, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	entrypoint, _ = filepath.EvalSymlinks(entrypoint)
	profile, err := darwinConnectorSandboxProfile(ConnectorSandboxPolicy{ReadOnlyPaths: []string{artifactRoot, filepath.Dir(nodePath)}}, nodePath)
	if err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command(connectorSandboxExecutable, "-p", profile, nodePath, entrypoint).CombinedOutput()
	if err != nil || string(output) != "denied" {
		t.Fatalf("sandbox denial fixture = %v: %s", err, output)
	}
}

func TestDarwinConnectorSandboxProfileRunsManagedPythonEntrypoint(t *testing.T) {
	pythonPath, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 runtime is unavailable")
	}
	pythonPath, err = filepath.EvalSymlinks(pythonPath)
	if err != nil {
		t.Fatal(err)
	}
	prefixOutput, err := exec.Command(pythonPath, "-c", "import sys; print(sys.prefix); print(sys.base_prefix)").Output()
	if err != nil {
		t.Skipf("python runtime prefix is unavailable: %v", err)
	}
	readPaths := []string{filepath.Dir(pythonPath)}
	prefixes := strings.Fields(string(prefixOutput))
	for _, prefix := range prefixes {
		if filepath.IsAbs(prefix) {
			readPaths = append(readPaths, prefix)
		}
	}
	// Homebrew's bin/python launcher performs a secondary exec into the
	// framework app. Production profiles pin the resolved runtime executable,
	// so use that real interpreter when this packaging layout is present.
	if len(prefixes) != 0 {
		candidate := filepath.Join(prefixes[0], "Resources", "Python.app", "Contents", "MacOS", "Python")
		if info, statErr := os.Stat(candidate); statErr == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0 {
			pythonPath, err = filepath.EvalSymlinks(candidate)
			if err != nil {
				t.Fatal(err)
			}
			readPaths = append(readPaths, filepath.Dir(candidate))
		}
	}
	artifactRoot := t.TempDir()
	entrypoint := filepath.Join(artifactRoot, "connector.py")
	if err := os.WriteFile(entrypoint, []byte(`print("python-sandbox-ok", end="")`), 0o600); err != nil {
		t.Fatal(err)
	}
	entrypoint, _ = filepath.EvalSymlinks(entrypoint)
	readPaths = append(readPaths, artifactRoot)
	profile, err := darwinConnectorSandboxProfile(ConnectorSandboxPolicy{ReadOnlyPaths: readPaths}, pythonPath)
	if err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command(connectorSandboxExecutable, "-p", profile, pythonPath, entrypoint).CombinedOutput()
	if err != nil {
		t.Fatalf("managed python sandbox smoke test failed: %v: %s", err, output)
	}
	if string(output) != "python-sandbox-ok" {
		t.Fatalf("managed python output = %q", output)
	}
}
