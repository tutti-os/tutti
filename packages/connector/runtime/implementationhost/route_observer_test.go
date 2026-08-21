package implementationhost

import (
	"context"
	"io"
	"sync"
	"testing"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
	"github.com/tutti-os/tutti/packages/connector/runtime/mcp"
)

const routeObserverTestDigest = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"

type routeObservationRecorder struct {
	mu           sync.Mutex
	observations []RouteObservation
}

func (recorder *routeObservationRecorder) ObserveRoute(_ context.Context, observation RouteObservation) {
	recorder.mu.Lock()
	recorder.observations = append(recorder.observations, observation)
	recorder.mu.Unlock()
}

type exitedMCPConnection struct{ delivered bool }

func (*exitedMCPConnection) Send([]byte) error { return nil }
func (*exitedMCPConnection) Close() error      { return nil }
func (*exitedMCPConnection) CloseInput() error { return nil }
func (*exitedMCPConnection) Terminate() error  { return nil }
func (*exitedMCPConnection) Kill() error       { return nil }
func (connection *exitedMCPConnection) Recv() (agentruntime.ProcessFrame, error) {
	if connection.delivered {
		return agentruntime.ProcessFrame{}, io.EOF
	}
	connection.delivered = true
	exitCode := 17
	return agentruntime.ProcessFrame{ExitCode: &exitCode}, nil
}

func TestMonitorMCPRouteObservesOnlyUnexpectedCurrentRouteExit(t *testing.T) {
	recorder := &routeObservationRecorder{}
	routes := connectorruntime.NewRouteTable()
	host := &Host{routes: routes, routeObserver: recorder}
	generation := market.HostGeneration{BootEpoch: "boot-1", Generation: 4}
	route := &connectorRoute{id: connectorRouteKey("connection-1", "calendar"), connectionID: "connection-1",
		connectorKey: "calendar", releaseDigest: routeObserverTestDigest, generation: generation,
		processes: connectorruntime.NewProcessGroup()}
	if err := routes.Commit(route); err != nil {
		t.Fatal(err)
	}
	client, err := mcp.NewStdioClient(mcp.StdioClientConfig{Connection: &exitedMCPConnection{}, ProcessName: "calendar"})
	if err != nil {
		t.Fatal(err)
	}
	host.monitorMCPRoute(route, client)
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	if len(recorder.observations) != 1 {
		t.Fatalf("route observations = %+v", recorder.observations)
	}
	observation := recorder.observations[0]
	if observation.ConnectorKey != "calendar" || observation.ConnectionID != "connection-1" ||
		observation.ReleaseDigest != routeObserverTestDigest || observation.Generation != generation ||
		observation.ObservedAt.IsZero() {
		t.Fatalf("route observation = %+v", observation)
	}
	if routes.IsCurrent(route) {
		t.Fatal("exited MCP route remained current")
	}
}

func TestMonitorMCPRouteDoesNotObserveIntentionalRemoval(t *testing.T) {
	recorder := &routeObservationRecorder{}
	routes := connectorruntime.NewRouteTable()
	host := &Host{routes: routes, routeObserver: recorder}
	generation := market.HostGeneration{BootEpoch: "boot-1", Generation: 1}
	route := &connectorRoute{id: connectorRouteKey("connection-1", "calendar"), connectionID: "connection-1",
		connectorKey: "calendar", releaseDigest: routeObserverTestDigest, generation: generation,
		processes: connectorruntime.NewProcessGroup()}
	if err := routes.Commit(route); err != nil {
		t.Fatal(err)
	}
	if err := routes.Remove(route.id, generation, routeObserverTestDigest, time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	client, err := mcp.NewStdioClient(mcp.StdioClientConfig{Connection: &exitedMCPConnection{}, ProcessName: "calendar"})
	if err != nil {
		t.Fatal(err)
	}
	host.monitorMCPRoute(route, client)
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	if len(recorder.observations) != 0 {
		t.Fatalf("intentional removal observations = %+v", recorder.observations)
	}
}
