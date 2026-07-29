package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	agentdaemon "github.com/tutti-os/tutti/packages/agent/daemon"
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
)

type cassetteWiringTestTransport struct {
	mu    sync.Mutex
	specs []agentruntime.ProcessSpec
}

func (t *cassetteWiringTestTransport) Start(
	_ context.Context,
	spec agentruntime.ProcessSpec,
) (agentruntime.ProcessConnection, error) {
	t.mu.Lock()
	t.specs = append(t.specs, spec)
	t.mu.Unlock()
	return cassetteWiringTestConnection{}, nil
}

type cassetteWiringTestConnection struct{}

func (cassetteWiringTestConnection) Send([]byte) error {
	return nil
}

func (cassetteWiringTestConnection) Recv() (agentruntime.ProcessFrame, error) {
	return agentruntime.ProcessFrame{}, io.EOF
}

func (cassetteWiringTestConnection) Close() error {
	return nil
}

func TestNewAgentProcessTransportUsesLocalTransportByDefault(t *testing.T) {
	local := &cassetteWiringTestTransport{}
	got, err := newAgentProcessTransport("", "", local)
	if err != nil {
		t.Fatal(err)
	}
	if got != local {
		t.Fatal("default transport did not preserve the local transport")
	}
}

func TestRecordAgentProcessTransportCapturesOnlySessionConnections(t *testing.T) {
	local := &cassetteWiringTestTransport{}
	directory := t.TempDir()
	transport, err := newAgentProcessTransport(
		agentCassetteModeRecord,
		directory,
		local,
	)
	if err != nil {
		t.Fatal(err)
	}
	probe, err := transport.Start(
		context.Background(),
		agentruntime.ProcessSpec{Provider: agentruntime.ProviderCodex},
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := probe.Close(); err != nil {
		t.Fatal(err)
	}
	session, err := transport.Start(context.Background(), agentruntime.ProcessSpec{
		Provider:       agentruntime.ProviderCodex,
		AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	finalizer, ok := transport.(interface{ Finalize() error })
	if !ok {
		t.Fatal("record transport has no finalizer")
	}
	if err := finalizer.Finalize(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(directory, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Status      string `json:"status"`
		Connections []struct {
			AgentSessionID string `json:"agentSessionId"`
		} `json:"connections"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Status != "complete" {
		t.Fatalf("manifest status = %q, want complete", manifest.Status)
	}
	if len(manifest.Connections) != 1 ||
		manifest.Connections[0].AgentSessionID != "session-1" {
		t.Fatalf("manifest connections = %#v, want only session-1", manifest.Connections)
	}
}

func TestNewAgentProcessTransportRejectsInvalidConfiguration(t *testing.T) {
	local := agentdaemon.NewLocalProcessTransport()
	for _, test := range []struct {
		name string
		mode string
		path string
		want string
	}{
		{name: "record without path", mode: agentCassetteModeRecord, want: agentCassettePathEnv},
		{name: "replay without path", mode: agentCassetteModeReplay, want: agentCassettePathEnv},
		{name: "unknown mode", mode: "invalid", path: t.TempDir(), want: "unsupported"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := newAgentProcessTransport(test.mode, test.path, local)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("newAgentProcessTransport() error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestReplayAgentProcessTransportRejectsNonSessionProcessLaunch(t *testing.T) {
	directory := t.TempDir()
	writeCompleteProcessCassette(t, directory)
	local := &cassetteWiringTestTransport{}
	transport, err := newAgentProcessTransport(
		agentCassetteModeReplay,
		directory,
		local,
	)
	if err != nil {
		t.Fatal(err)
	}
	_, err = transport.Start(
		context.Background(),
		agentruntime.ProcessSpec{Provider: agentruntime.ProviderCodex},
	)
	if err == nil || !strings.Contains(err.Error(), "non-session process launch") {
		t.Fatalf("Start() error = %v, want fail-closed replay error", err)
	}
	local.mu.Lock()
	defer local.mu.Unlock()
	if len(local.specs) != 0 {
		t.Fatalf("local transport received %d replay launches, want none", len(local.specs))
	}
}

func writeCompleteProcessCassette(t *testing.T, directory string) {
	t.Helper()
	recorder, err := agentdaemon.NewRecordingProcessTransport(
		&cassetteWiringTestTransport{},
		directory,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := recorder.Finalize(); err != nil {
		t.Fatal(err)
	}
}
