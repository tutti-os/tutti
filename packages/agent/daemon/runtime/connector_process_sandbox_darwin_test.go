//go:build darwin

package agentruntime

import (
	"debug/macho"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func sandboxCompatibleNodePathForTest(t *testing.T) string {
	t.Helper()
	nodePath, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node runtime is unavailable")
	}
	nodePath, err = filepath.EvalSymlinks(nodePath)
	if err != nil {
		t.Fatal(err)
	}
	binary, err := macho.Open(nodePath)
	if err != nil {
		t.Skipf("node runtime is not a Mach-O executable: %v", err)
	}
	t.Cleanup(func() { _ = binary.Close() })
	libraries, err := binary.ImportedLibraries()
	if err != nil {
		t.Skipf("node runtime dependencies are unavailable: %v", err)
	}
	for _, library := range libraries {
		if strings.HasPrefix(library, "/System/") || strings.HasPrefix(library, "/usr/lib/") {
			continue
		}
		t.Skipf("node runtime is not self-contained managed Node: depends on %s", library)
	}
	return nodePath
}

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

func TestDarwinConnectorSandboxProfileAllowsOnlyExplicitSecondaryExecutable(t *testing.T) {
	profile, err := darwinConnectorSandboxProfile(ConnectorSandboxPolicy{ReadOnlyPaths: []string{"/bin"},
		AllowedExecutables: []string{"/bin/echo"}}, "/usr/bin/true")
	if err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command(connectorSandboxExecutable, "-p", profile, "/bin/echo", "allowed").CombinedOutput(); err != nil {
		t.Fatalf("explicit executable was denied: %v: %s", err, output)
	}
	if output, err := exec.Command(connectorSandboxExecutable, "-p", profile, "/usr/bin/touch", t.TempDir()+"/denied").CombinedOutput(); err == nil {
		t.Fatalf("undeclared executable was admitted: %s", output)
	}
}

func TestDarwinConnectorSandboxProfileAllowsManagedNodeToSpawnExplicitLifecycleTools(t *testing.T) {
	nodePath := sandboxCompatibleNodePathForTest(t)
	digest, err := fileSHA256(nodePath)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(nodePath)
	if err != nil {
		t.Fatal(err)
	}
	preparedNode, err := prepareProcessExecutable(nodePath, &ExecutableIdentity{SHA256: digest, SizeBytes: info.Size()})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = preparedNode.Close() }()
	artifactRoot := t.TempDir()
	entrypoint := filepath.Join(artifactRoot, "lifecycle-tools-check.js")
	script := `
const {execFileSync} = require("node:child_process");
try {
  const options = {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    timeout: 5000,
  };
  const curlOutput = execFileSync("curl", ["--version"], options);
  const tarOutput = execFileSync("tar", ["--version"], options);
  process.stdout.write(curlOutput.startsWith("curl ") && tarOutput.length > 0 ? "tools-ok" : "tools-failed");
} catch (error) {
  process.stderr.write(error.message);
  process.exit(1);
}
`
	if err := os.WriteFile(entrypoint, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	entrypoint, _ = filepath.EvalSymlinks(entrypoint)
	profile, err := darwinConnectorSandboxProfile(ConnectorSandboxPolicy{
		ReadOnlyPaths:      []string{artifactRoot, filepath.Dir(nodePath)},
		AllowedExecutables: []string{"/usr/bin/curl", "/usr/bin/tar"},
	}, preparedNode.path)
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(connectorSandboxExecutable, "-p", profile, preparedNode.path, entrypoint)
	if preparedNode.file != nil {
		command.ExtraFiles = []*os.File{preparedNode.file}
	}
	command.Env = []string{"PATH=" + filepath.Dir(nodePath) + ":/usr/bin"}
	output, err := command.CombinedOutput()
	if err != nil || string(output) != "tools-ok" {
		t.Fatalf("managed Node explicit lifecycle tools fixture = %v: %s\n%s", err, output, profile)
	}
}

func TestDarwinConnectorSandboxProfileRunsManagedNodeEntrypoint(t *testing.T) {
	nodePath := sandboxCompatibleNodePathForTest(t)
	artifactRoot := t.TempDir()
	entrypoint := filepath.Join(artifactRoot, "connector.js")
	if err := os.WriteFile(entrypoint, []byte(`process.stdout.write("node-sandbox-ok")`), 0o600); err != nil {
		t.Fatal(err)
	}
	resolvedEntrypoint, err := filepath.EvalSymlinks(entrypoint)
	if err != nil {
		t.Fatal(err)
	}
	entrypoint = resolvedEntrypoint
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

func TestDarwinConnectorSandboxNetworkAllowsDNSResolution(t *testing.T) {
	nodePath := sandboxCompatibleNodePathForTest(t)
	artifactRoot := t.TempDir()
	entrypoint := filepath.Join(artifactRoot, "dns-check.js")
	script := `
require("node:dns").lookup("localhost", (error) => {
  if (error) {
    process.stderr.write(error.code || String(error));
    process.exit(1);
  }
  process.stdout.write("dns-ok");
});
`
	if err := os.WriteFile(entrypoint, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	entrypoint, _ = filepath.EvalSymlinks(entrypoint)
	profile, err := darwinConnectorSandboxProfile(ConnectorSandboxPolicy{
		ReadOnlyPaths: []string{artifactRoot, filepath.Dir(nodePath)},
		Network:       true,
	}, nodePath)
	if err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command(connectorSandboxExecutable, "-p", profile, nodePath, entrypoint).CombinedOutput()
	if err != nil || string(output) != "dns-ok" {
		t.Fatalf("sandbox DNS fixture = %v: %s", err, output)
	}
}

func TestDarwinConnectorSandboxDeniesNodeNetworkAndSecondaryExec(t *testing.T) {
	nodePath := sandboxCompatibleNodePathForTest(t)
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
