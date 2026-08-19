package implementationhost

import (
	"context"
	"errors"
	"io"
	"reflect"
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
	wantCommand := []string{"/managed/node", "/snapshot/lark-cli.mjs", "--json", "message", "send", "--text", "hello"}
	if !reflect.DeepEqual(spec.Command, wantCommand) {
		t.Fatalf("command = %#v, want %#v", spec.Command, wantCommand)
	}
	if spec.CWD != "/snapshot" || !reflect.DeepEqual(spec.Env, []string{
		"TUTTI_CONNECTOR_CONNECTION_ID=connection-1", "TUTTI_CONNECTOR_KEY=lark-cli", "TUTTI_CONNECTOR_LANGUAGE=node",
		"TUTTI_CONNECTOR_STATE_DIR=/state", "HOME=/home/owner", "USERPROFILE=/home/owner",
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

func newCLIExecutionTestHost(t *testing.T) (*Host, *connectorRoute, *cliExecutionTransportStub, CLIExecutionRequest) {
	t.Helper()
	generation := market.HostGeneration{BootEpoch: "boot-1", Generation: 7}
	transport := &cliExecutionTransportStub{}
	table := connectorruntime.NewRouteTable()
	route := &connectorRoute{
		id: connectorRouteKey("connection-1", "lark-cli"), connectionID: "connection-1", connectorKey: "lark-cli",
		connectorVersion: "1.2.3", releaseDigest: cliExecutorTestDigest, generation: generation,
		processes: connectorruntime.NewProcessGroup(), userHome: "/home/owner", cliContractHash: cliExecutorTestContractHash,
		cliLaunch: &managedCLILaunch{
			arguments: []string{"/snapshot/lark-cli.mjs", "--json"}, cwd: "/snapshot", language: "node", stateDir: "/state",
			executable: connectorruntime.ConnectorExecutable{Path: "/managed/node", SHA256: "node-digest", SizeBytes: 42},
		},
	}
	if err := table.Commit(route); err != nil {
		t.Fatal(err)
	}
	host := &Host{routes: table, processes: transport}
	request := CLIExecutionRequest{
		ConnectionID: "connection-1", ConnectorKey: "lark-cli", ConnectorVersion: "1.2.3", ReleaseDigest: cliExecutorTestDigest,
		Generation: generation, CLIContractHash: cliExecutorTestContractHash, Arguments: []string{"message", "send", "--text", "hello"},
	}
	return host, route, transport, request
}
