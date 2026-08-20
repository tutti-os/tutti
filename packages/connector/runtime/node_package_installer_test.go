package runtime

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

const larkTestIntegrity = "sha512-qbJYoJtNch6dV8RvYBO2wpcKO9+6Io3Cuf5alYFzvLbtkSntOKqoc+xHI7p6wRq4oH4F9fydgNJbTGy79ibPdg=="

type nodePackageRuntimeStub struct {
	root string
	node ConnectorExecutable
}

func (stub nodePackageRuntimeStub) ResolveProfile(context.Context, string) (ResolvedConnectorRuntime, error) {
	return ResolvedConnectorRuntime{Root: stub.root, Profile: ConnectorNodeProfile,
		ABI: "node22-" + runtime.GOOS + "-" + runtime.GOARCH, Node: &stub.node,
		Components: map[string]string{"node": "22.22.3"}}, nil
}

func (stub nodePackageRuntimeStub) VerifyLaunch(string, string) (ConnectorExecutable, error) {
	return stub.node, nil
}

type nodePackageProcessStub struct {
	mu    sync.Mutex
	specs []agentruntime.ProcessSpec
}

func (stub *nodePackageProcessStub) Start(_ context.Context, spec agentruntime.ProcessSpec) (agentruntime.ProcessConnection, error) {
	stub.mu.Lock()
	stub.specs = append(stub.specs, spec)
	stub.mu.Unlock()
	if len(spec.Command) > 2 && strings.Contains(spec.Command[1], "corepack.js") {
		if err := materializeTestNodePackage(spec.CWD); err != nil {
			return nil, err
		}
	}
	exit := 0
	return &nodePackageProcessConnection{frames: []agentruntime.ProcessFrame{{ExitCode: &exit}}}, nil
}

type nodePackageProcessConnection struct{ frames []agentruntime.ProcessFrame }

func (*nodePackageProcessConnection) Send([]byte) error { return nil }
func (*nodePackageProcessConnection) Close() error      { return nil }
func (*nodePackageProcessConnection) CloseInput() error { return nil }
func (*nodePackageProcessConnection) Terminate() error  { return nil }
func (*nodePackageProcessConnection) Kill() error       { return nil }
func (connection *nodePackageProcessConnection) Recv() (agentruntime.ProcessFrame, error) {
	if len(connection.frames) == 0 {
		return agentruntime.ProcessFrame{}, io.EOF
	}
	frame := connection.frames[0]
	connection.frames = connection.frames[1:]
	return frame, nil
}

func TestNodePackageInstallerUsesOneManagedNodeAndSharedContentStore(t *testing.T) {
	runtimeRoot := t.TempDir()
	nodePath := filepath.Join(runtimeRoot, "node", "bin", "node")
	corepackPath := filepath.Join(runtimeRoot, "node", "lib", "node_modules", "corepack", "dist", "corepack.js")
	for _, path := range []string{nodePath, corepackPath} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("managed"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	processes := &nodePackageProcessStub{}
	runtimeResolver := nodePackageRuntimeStub{root: runtimeRoot, node: ConnectorExecutable{Path: nodePath,
		SHA256: strings.Repeat("a", 64), SizeBytes: 7}}
	root := t.TempDir()
	externalBin := t.TempDir()
	inheritedPath := strings.Join([]string{externalBin, filepath.Join(runtimeRoot, "node", "bin"), ""}, string(os.PathListSeparator))
	installer, err := NewNodePackageInstaller(NodePackageInstallerConfig{RootDir: root, Runtimes: runtimeResolver,
		Processes: processes, PnpmVersion: "10.11.0", Environ: func() []string {
			return []string{"PATH=" + inheritedPath, "HTTPS_PROXY=http://127.0.0.1:7890", "SECRET_TOKEN=hidden"}
		}})
	if err != nil {
		t.Fatal(err)
	}
	first := testNodePackageRelease("lark", strings.Repeat("1", 64))
	second := testNodePackageRelease("lark-enterprise", strings.Repeat("2", 64))
	firstReceipt, err := installer.InstallCLI(context.Background(), market.InstallCLIRequest{OperationID: "install-1", Release: first})
	if err != nil {
		t.Fatal(err)
	}
	secondReceipt, err := installer.InstallCLI(context.Background(), market.InstallCLIRequest{OperationID: "install-2", Release: second})
	if err != nil {
		t.Fatal(err)
	}
	if firstReceipt.NodeSHA256 != secondReceipt.NodeSHA256 || firstReceipt.NodeVersion != secondReceipt.NodeVersion {
		t.Fatalf("receipts use different managed Node runtimes: %#v %#v", firstReceipt, secondReceipt)
	}
	if firstReceipt.StoreRoot != secondReceipt.StoreRoot || firstReceipt.InstallRoot == secondReceipt.InstallRoot {
		t.Fatalf("shared store or isolated install roots are wrong: %#v %#v", firstReceipt, secondReceipt)
	}
	processes.mu.Lock()
	defer processes.mu.Unlock()
	if len(processes.specs) != 4 {
		t.Fatalf("managed package process count = %d, want install and lifecycle for each connector", len(processes.specs))
	}
	packageInstalls := 0
	lifecycleRuns := 0
	for _, spec := range processes.specs {
		if spec.Command[0] != nodePath {
			t.Fatalf("installer command = %q, want the single managed Node %q", spec.Command[0], nodePath)
		}
		if strings.Contains(spec.Command[1], "corepack.js") {
			packageInstalls++
			if !containsCommandPair(spec.Command, "--store-dir", firstReceipt.StoreRoot) {
				t.Fatalf("installer command does not use shared store: %#v", spec.Command)
			}
			if !containsCommandPair(spec.Command, "--package-import-method", "hardlink") {
				t.Fatalf("installer command does not physically reuse shared dependency content: %#v", spec.Command)
			}
		} else {
			lifecycleRuns++
			if !strings.HasSuffix(filepath.ToSlash(spec.Command[1]), "/scripts/install.js") {
				t.Fatalf("lifecycle did not use the typed Node entrypoint: %#v", spec)
			}
		}
		if !containsEnvironmentPrefix(spec.Env, "NPM_CONFIG_CACHE="+filepath.Join(root, "shared", "npm-cache")) {
			t.Fatalf("installer environment does not share npm cache: %#v", spec.Env)
		}
		wantPath := strings.Join([]string{filepath.Join(runtimeRoot, "node", "bin"), externalBin}, string(os.PathListSeparator))
		if !containsEnvironmentPrefix(spec.Env, "PATH="+wantPath) {
			t.Fatalf("installer PATH does not prefer managed Node and preserve user tools: %#v", spec.Env)
		}
		if !containsEnvironmentPrefix(spec.Env, "HTTPS_PROXY=http://127.0.0.1:7890") {
			t.Fatalf("installer environment does not preserve the user proxy: %#v", spec.Env)
		}
		if containsEnvironmentKey(spec.Env, "SECRET_TOKEN") {
			t.Fatalf("installer environment leaked a non-allowlisted value: %#v", spec.Env)
		}
	}
	if packageInstalls != 2 || lifecycleRuns != 2 {
		t.Fatalf("package installs = %d, lifecycle runs = %d", packageInstalls, lifecycleRuns)
	}
	if err := installer.RemoveCLI(context.Background(), market.RemoveCLIRequest{OperationID: "remove-1",
		ConnectorKey: first.ConnectorKey, ReleaseDigest: first.ReleaseDigest}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(firstReceipt.StoreRoot); err != nil {
		t.Fatalf("uninstall removed shared content store: %v", err)
	}
}

func TestNodePackageInstallerRemoveCLIRejectsSymlinkParent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX symbolic-link removal coverage")
	}
	root := t.TempDir()
	installer, err := NewNodePackageInstaller(NodePackageInstallerConfig{
		RootDir: root, Runtimes: nodePackageRuntimeStub{}, Processes: &nodePackageProcessStub{},
	})
	if err != nil {
		t.Fatal(err)
	}
	digest := strings.Repeat("a", 64)
	victim := t.TempDir()
	victimRelease := filepath.Join(victim, digest)
	if err := os.MkdirAll(victimRelease, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(victimRelease, "keep")
	if err := os.WriteFile(marker, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "packages"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(root, "packages", "lark")); err != nil {
		t.Fatal(err)
	}
	err = installer.RemoveCLI(context.Background(), market.RemoveCLIRequest{
		ConnectorKey: "lark", ReleaseDigest: digest,
	})
	if err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("RemoveCLI() error = %v, want symbolic-link rejection", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("RemoveCLI() followed a symlink parent: %v", err)
	}
}

func TestNodeVersionSatisfiesComparatorRange(t *testing.T) {
	if !nodeVersionSatisfies("22.22.3", ">=22.0.0 <23.0.0") {
		t.Fatal("managed Node should satisfy connector range")
	}
	if nodeVersionSatisfies("24.0.0", ">=22.0.0 <23.0.0") {
		t.Fatal("incompatible managed Node unexpectedly satisfied connector range")
	}
}

func testNodePackageRelease(connectorKey, digest string) market.Release {
	return market.Release{
		SchemaVersion: "1", ReleaseID: connectorKey + "@1.0.0", ConnectorKey: connectorKey,
		Version: "1.0.0", ReleaseDigest: digest, ManifestDigest: strings.Repeat("3", 64),
		Artifact: market.Artifact{Key: connectorKey + ".zip",
			SHA256: strings.Repeat("4", 64), SizeBytes: 1, MediaType: "application/zip"},
		PublishedAt: time.Unix(1, 0).UTC(), Status: market.ReleaseStatusAvailable,
		Manifest: market.Manifest{
			SchemaVersion: "1", DisplayName: "Lark", IconURL: "https://cdn.example.test/tutti/connector-market/lark/1.0.0/lark-1.0.0-icon.svg", AuthorizationKind: "none",
			Implementation: market.Implementation{
				Kind: market.ImplementationKindManagedStdio,
				ManagedStdio: &market.ManagedStdioImplementation{
					Runtime: market.RuntimeRequirement{Language: "node", Profile: ConnectorNodeProfile,
						ABI: "node22-" + runtime.GOOS + "-" + runtime.GOARCH, VersionRange: ">=22.0.0 <23.0.0"},
					CLI: &market.ManagedCLIInterface{
						Entrypoint: "lark-cli", TimeoutMS: 120_000,
						Install: &market.CLIInstallation{Kind: "node_package", NodePackage: &market.NodePackageInstallation{
							Package: "@larksuite/cli", Version: "1.0.83", Integrity: larkTestIntegrity,
							Launch: market.NodePackageLaunch{Kind: "native", Entrypoint: "bin/lark-cli",
								SHA256: "c4319606cba410b6e1128bebe27915a7c212a4f8b58faaa38a2f99d31856e046"},
							Lifecycle: []market.NodeLifecycleCommand{{Event: "postinstall", Entrypoint: "scripts/install.js"}},
						}},
					},
				},
			},
		},
	}
}

func materializeTestNodePackage(root string) error {
	packageRoot := filepath.Join(root, "node_modules", "@larksuite", "cli")
	if err := os.MkdirAll(filepath.Join(packageRoot, "scripts"), 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(packageRoot, "bin"), 0o700); err != nil {
		return err
	}
	manifest, _ := json.Marshal(map[string]any{"name": "@larksuite/cli", "version": "1.0.83",
		"bin": map[string]string{"lark-cli": "scripts/run.js"}})
	if err := os.WriteFile(filepath.Join(packageRoot, "package.json"), manifest, 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "scripts", "run.js"), []byte("// lark"), 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "scripts", "install.js"), []byte("// install lark"), 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "bin", "lark-cli"), []byte("native-lark"), 0o700); err != nil {
		return err
	}
	lock := "lockfileVersion: '9.0'\npackages:\n  '@larksuite/cli@1.0.83':\n    resolution:\n      integrity: " + larkTestIntegrity + "\n"
	return os.WriteFile(filepath.Join(root, "pnpm-lock.yaml"), []byte(lock), 0o600)
}

func containsCommandPair(command []string, key, value string) bool {
	for index := 0; index+1 < len(command); index++ {
		if command[index] == key && command[index+1] == value {
			return true
		}
	}
	return false
}

func containsEnvironmentPrefix(environment []string, expected string) bool {
	for _, value := range environment {
		if value == expected {
			return true
		}
	}
	return false
}

func containsEnvironmentKey(environment []string, expected string) bool {
	for _, value := range environment {
		key, _, ok := strings.Cut(value, "=")
		if ok && strings.EqualFold(key, expected) {
			return true
		}
	}
	return false
}

func TestAllowedNodePackageInstallEnvironmentFoldsProxyKeyCase(t *testing.T) {
	got := allowedNodePackageInstallEnvironment([]string{
		"PATH=/usr/bin",
		"http_proxy=http://127.0.0.1:7897",
		"HTTP_PROXY=http://127.0.0.1:7897",
		"https_proxy=http://127.0.0.1:7897",
		"HTTPS_PROXY=http://127.0.0.1:7897",
		"no_proxy=localhost",
	})
	want := []string{
		"HTTPS_PROXY=http://127.0.0.1:7897",
		"HTTP_PROXY=http://127.0.0.1:7897",
		"NO_PROXY=localhost",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("environment = %#v, want %#v", got, want)
	}
}

func TestAllowedNodePackageInstallEnvironmentKeepsLastValueForFoldedKey(t *testing.T) {
	got := allowedNodePackageInstallEnvironment([]string{
		"http_proxy=http://first.invalid:1",
		"HTTP_PROXY=http://second.invalid:2",
	})
	want := []string{"HTTP_PROXY=http://second.invalid:2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("environment = %#v, want %#v", got, want)
	}
}
