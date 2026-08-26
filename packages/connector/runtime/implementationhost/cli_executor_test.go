package implementationhost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
)

const cliExecutorTestDigest = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
const cliExecutorTestContractHash = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

type cliExecutionTransportStub struct {
	mu         sync.Mutex
	specs      []agentruntime.ProcessSpec
	connection *cliExecutionConnectionStub
}

func (transport *cliExecutionTransportStub) Start(_ context.Context, spec agentruntime.ProcessSpec) (agentruntime.ProcessConnection, error) {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	transport.specs = append(transport.specs, spec)
	transport.connection = &cliExecutionConnectionStub{}
	return transport.connection, nil
}

type cliExecutionConnectionStub struct {
	mu             sync.Mutex
	closed         int
	inputClosed    int
	terminated     int
	killed         int
	recvContextual int
	blockRecv      bool
}

func (*cliExecutionConnectionStub) Send([]byte) error { return nil }
func (*cliExecutionConnectionStub) Recv() (agentruntime.ProcessFrame, error) {
	return agentruntime.ProcessFrame{}, io.EOF
}
func (connection *cliExecutionConnectionStub) RecvContext(ctx context.Context) (agentruntime.ProcessFrame, error) {
	connection.mu.Lock()
	connection.recvContextual++
	block := connection.blockRecv
	connection.mu.Unlock()
	if block {
		<-ctx.Done()
		return agentruntime.ProcessFrame{}, ctx.Err()
	}
	return agentruntime.ProcessFrame{}, io.EOF
}
func (connection *cliExecutionConnectionStub) Close() error {
	connection.mu.Lock()
	connection.closed++
	connection.mu.Unlock()
	return nil
}
func (connection *cliExecutionConnectionStub) CloseInput() error {
	connection.mu.Lock()
	connection.inputClosed++
	connection.mu.Unlock()
	return nil
}
func (connection *cliExecutionConnectionStub) Terminate() error {
	connection.mu.Lock()
	connection.terminated++
	connection.mu.Unlock()
	return nil
}
func (connection *cliExecutionConnectionStub) Kill() error {
	connection.mu.Lock()
	connection.killed++
	connection.mu.Unlock()
	return nil
}

func TestStartCLIExecutesExactCurrentRouteAndOwnsLifecycle(t *testing.T) {
	host, route, transport, request := newCLIExecutionTestHost(t)
	connection, err := host.StartCLI(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if route.processes.ActiveCount() != 1 {
		t.Fatalf("active processes = %d, want 1", route.processes.ActiveCount())
	}
	transport.mu.Lock()
	spec := transport.specs[0]
	inner := transport.connection
	transport.mu.Unlock()
	wantCommand := append([]string{route.cliLaunch.executable.Path}, route.cliLaunch.arguments...)
	wantCommand = append(wantCommand, request.Arguments...)
	if !reflect.DeepEqual(spec.Command, wantCommand) {
		t.Fatalf("command = %#v, want %#v", spec.Command, wantCommand)
	}
	if spec.CWD != request.WorkingDirectory || !reflect.DeepEqual(spec.Env, []string{
		"TUTTI_CONNECTOR_CONNECTION_ID=connection-1", "TUTTI_CONNECTOR_KEY=lark-cli", "TUTTI_CONNECTOR_LANGUAGE=node",
		"TUTTI_CONNECTOR_STATE_DIR=" + route.cliLaunch.stateDir, "HOME=" + route.userHome, "USERPROFILE=" + route.userHome,
	}) {
		t.Fatalf("process spec = %#v", spec)
	}
	if _, ok := connection.(agentruntime.ContextProcessConnection); !ok {
		t.Fatal("context process capability was not preserved")
	}
	graceful, ok := connection.(agentruntime.GracefulProcessConnection)
	if !ok {
		t.Fatal("graceful process capability was not preserved")
	}
	if err := graceful.CloseInput(); err != nil {
		t.Fatal(err)
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	inner.mu.Lock()
	defer inner.mu.Unlock()
	if inner.closed != 1 || inner.inputClosed != 1 || route.processes.ActiveCount() != 0 {
		t.Fatalf("closed=%d inputClosed=%d active=%d", inner.closed, inner.inputClosed, route.processes.ActiveCount())
	}
}

func TestStartCLIFailsClosedForStaleOrInvalidIdentity(t *testing.T) {
	host, _, transport, request := newCLIExecutionTestHost(t)

	stale := request
	stale.CLIContractHash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if _, err := host.StartCLI(context.Background(), stale); !errors.Is(err, ErrCLIExecutionIdentityMismatch) {
		t.Fatalf("stale identity error = %v", err)
	}
	invalid := request
	invalid.Arguments = []string{"bad\x00argument"}
	if _, err := host.StartCLI(context.Background(), invalid); !errors.Is(err, ErrCLIExecutionInvalid) {
		t.Fatalf("invalid argument error = %v", err)
	}
	invalid = request
	invalid.WorkingDirectory = "relative/workspace"
	if _, err := host.StartCLI(context.Background(), invalid); !errors.Is(err, ErrCLIExecutionInvalid) {
		t.Fatalf("relative working directory error = %v", err)
	}
	invalid = request
	invalid.WorkingDirectory += "\x00suffix"
	if _, err := host.StartCLI(context.Background(), invalid); !errors.Is(err, ErrCLIExecutionInvalid) {
		t.Fatalf("NUL working directory error = %v", err)
	}
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if len(transport.specs) != 0 {
		t.Fatalf("unexpected process starts = %d", len(transport.specs))
	}
}

func TestStartCLIEnforcesManifestTimeout(t *testing.T) {
	host, route, transport, request := newCLIExecutionTestHost(t)
	route.cliLaunch.timeout = 20 * time.Millisecond
	connection, err := host.StartCLI(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	transport.connection.mu.Lock()
	transport.connection.blockRecv = true
	transport.connection.mu.Unlock()
	contextual, ok := connection.(agentruntime.ContextProcessConnection)
	if !ok {
		t.Fatal("timed CLI connection is not contextual")
	}
	if _, err := contextual.RecvContext(context.Background()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timed CLI receive error = %v, want deadline exceeded", err)
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestStartCLIUsesWorkingDirectoryForRelativePathResolution(t *testing.T) {
	workspace := t.TempDir()
	workingDirectory := filepath.Join(workspace, "project", "reports")
	if err := os.MkdirAll(workingDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workingDirectory, "report.pdf"), []byte("workspace-relative-content"), 0o600); err != nil {
		t.Fatal(err)
	}
	executable, identity := copyCLIExecutorTestExecutable(t)
	processes, err := agentruntime.NewConnectorProcessTransport()
	if err != nil {
		t.Fatal(err)
	}
	generation := market.HostGeneration{BootEpoch: "boot-fixture", Generation: 1}
	route := &connectorRoute{
		id: connectorRouteKey("cwd-fixture", "fixture-cli"), connectionID: "cwd-fixture", connectorKey: "fixture-cli",
		connectorVersion: "1.0.0", releaseDigest: cliExecutorTestDigest, generation: generation,
		processes: connectorruntime.NewProcessGroup(), userHome: filepath.Join(workspace, "connector-home"),
		cliContractHash: cliExecutorTestContractHash,
		cliLaunch: &managedCLILaunch{
			executable: connectorruntime.ConnectorExecutable{Path: executable, SHA256: identity.SHA256, SizeBytes: identity.SizeBytes},
			cwd:        filepath.Join(workspace, "connector-installation"), language: "native", stateDir: filepath.Join(workspace, "state"),
		},
	}
	table := connectorruntime.NewRouteTable()
	if err := table.Commit(route); err != nil {
		t.Fatal(err)
	}
	host := &Host{routes: table, processes: processes}
	connection, err := host.StartCLI(context.Background(), CLIExecutionRequest{
		ConnectionID: route.connectionID, ConnectorKey: route.connectorKey, ConnectorVersion: route.connectorVersion,
		ReleaseDigest: route.releaseDigest, Generation: route.generation, CLIContractHash: route.cliContractHash,
		WorkingDirectory: workingDirectory, Arguments: []string{"-test.run=^TestCLIExecutorWorkingDirectoryFixture$"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	var stdout strings.Builder
	for {
		frame, err := connection.Recv()
		if err != nil {
			t.Fatal(err)
		}
		stdout.Write(frame.Stdout)
		if frame.ExitCode == nil {
			continue
		}
		if *frame.ExitCode != 0 {
			t.Fatalf("fixture exit code = %d, stderr = %q", *frame.ExitCode, frame.Stderr)
		}
		break
	}
	if !strings.Contains(stdout.String(), "workspace-relative-content") {
		t.Fatalf("fixture stdout = %q", stdout.String())
	}
}

func TestCLIExecutorWorkingDirectoryFixture(t *testing.T) {
	if os.Getenv("TUTTI_CONNECTOR_CONNECTION_ID") != "cwd-fixture" {
		return
	}
	contents, err := os.ReadFile("report.pdf")
	if err != nil {
		t.Fatal(err)
	}
	fmt.Print(string(contents))
}

func copyCLIExecutorTestExecutable(t *testing.T) (string, *agentruntime.ExecutableIdentity) {
	t.Helper()
	source, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "connector-cli-fixture"+filepath.Ext(source))
	if err := os.WriteFile(target, contents, 0o755); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(contents)
	return target, &agentruntime.ExecutableIdentity{SHA256: hex.EncodeToString(digest[:]), SizeBytes: int64(len(contents))}
}

func newCLIExecutionTestHost(t *testing.T) (*Host, *connectorRoute, *cliExecutionTransportStub, CLIExecutionRequest) {
	t.Helper()
	root := t.TempDir()
	snapshot := filepath.Join(root, "snapshot")
	generation := market.HostGeneration{BootEpoch: "boot-1", Generation: 7}
	transport := &cliExecutionTransportStub{}
	table := connectorruntime.NewRouteTable()
	route := &connectorRoute{
		id: connectorRouteKey("connection-1", "lark-cli"), connectionID: "connection-1", connectorKey: "lark-cli",
		connectorVersion: "1.2.3", releaseDigest: cliExecutorTestDigest, generation: generation,
		processes: connectorruntime.NewProcessGroup(), userHome: filepath.Join(root, "home", "owner"), cliContractHash: cliExecutorTestContractHash,
		cliLaunch: &managedCLILaunch{
			arguments: []string{filepath.Join(snapshot, "lark-cli.mjs"), "--json"}, cwd: snapshot, language: "node",
			stateDir:   filepath.Join(root, "state"),
			executable: connectorruntime.ConnectorExecutable{Path: filepath.Join(root, "managed", "node"), SHA256: "node-digest", SizeBytes: 42},
		},
	}
	if err := table.Commit(route); err != nil {
		t.Fatal(err)
	}
	host := &Host{routes: table, processes: transport}
	request := CLIExecutionRequest{
		ConnectionID: "connection-1", ConnectorKey: "lark-cli", ConnectorVersion: "1.2.3", ReleaseDigest: cliExecutorTestDigest,
		Generation: generation, CLIContractHash: cliExecutorTestContractHash,
		WorkingDirectory: filepath.Join(root, "workspace", "project", "reports"),
		Arguments:        []string{"message", "send", "--text", "hello"},
	}
	return host, route, transport, request
}
