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
	sessionreplay "github.com/tutti-os/tutti/packages/agent/session-replay"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
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

func TestBuildAgentProcessCompositionDisabledUsesRawTransport(t *testing.T) {
	t.Setenv(agentCassetteModeEnv, "")
	t.Setenv(agentCassettePathEnv, "")

	composition, err := buildAgentProcessComposition(false)
	if err != nil {
		t.Fatal(err)
	}
	if composition.transport == nil || composition.recorder != nil ||
		composition.replay != nil || len(composition.replayRegistrations) != 0 {
		t.Fatalf("disabled composition = %#v, want transport only", composition)
	}
	tracking, ok := composition.transport.(agentruntime.ProviderInputUnitTrackingTransport)
	if ok && tracking.TracksProviderInputUnits() {
		t.Fatalf("disabled composition transport %T enables provider input tracking", composition.transport)
	}
}

func TestBuildAgentProcessCompositionEnabledCreatesRecorder(t *testing.T) {
	t.Setenv(agentCassetteModeEnv, "")
	t.Setenv(agentCassettePathEnv, "")

	composition, err := buildAgentProcessComposition(true)
	if err != nil {
		t.Fatal(err)
	}
	if composition.recorder == nil || composition.transport != composition.recorder {
		t.Fatalf("enabled composition = %#v, want recording transport", composition)
	}
	tracking, ok := composition.transport.(agentruntime.ProviderInputUnitTrackingTransport)
	if !ok || !tracking.TracksProviderInputUnits() {
		t.Fatalf("enabled composition transport %T does not enable provider input tracking", composition.transport)
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

func TestBuildAgentProcessCompositionCreatesFixedReplayRouter(t *testing.T) {
	directoryA := t.TempDir()
	directoryB := t.TempDir()
	writeCompleteProcessCassette(t, directoryA)
	writeCompleteProcessCassette(t, directoryB)
	registrations, err := json.Marshal([]agentSessionReplayRegistration{
		{
			CassetteID:         "cassette-a",
			RootAgentSessionID: "session-a",
			CassetteDirectory:  directoryA,
			Providers:          []string{"codex"},
			FrozenModel:        "gpt-5.3-codex-spark",
		},
		{
			CassetteID:         "cassette-b",
			RootAgentSessionID: "session-b",
			CassetteDirectory:  directoryB,
			Providers:          []string{"codex"},
			FrozenModel:        "gpt-5-codex",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(agentCassetteModeEnv, agentCassetteModeReplay)
	t.Setenv(agentSessionReplayRegistrationsEnv, string(registrations))

	composition, err := buildAgentProcessComposition(false)
	if err != nil {
		t.Fatal(err)
	}
	if composition.replay == nil || composition.recorder != nil ||
		composition.transport == composition.replay {
		t.Fatalf("composition = %#v, want replay router only", composition)
	}
	models, err := composition.replayModelCatalog.ListModels(
		context.Background(),
		agentservice.AgentModelCatalogInput{Provider: "codex"},
	)
	if err != nil {
		t.Fatalf("replay model catalog error = %v", err)
	}
	if len(models.Models) != 2 ||
		models.Models[0].ID != "gpt-5.3-codex-spark" ||
		models.Models[1].ID != "gpt-5-codex" {
		t.Fatalf("replay model catalog = %#v, want frozen cassette models", models.Models)
	}
	tracking, ok := composition.transport.(agentruntime.ProviderInputUnitTrackingTransport)
	if !ok || !tracking.TracksProviderInputUnits() {
		t.Fatalf("replay composition transport %T does not enable provider input tracking", composition.transport)
	}
	if _, err := composition.replay.ReplayPlaybackState("cassette-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := composition.replay.ReplayPlaybackState("cassette-b"); err != nil {
		t.Fatal(err)
	}
}

func TestReplayProviderHomeTransportInjectsIsolatedProviderHome(t *testing.T) {
	for _, provider := range []string{
		agentruntime.ProviderCodex,
		agentruntime.ProviderClaudeCode,
	} {
		t.Run(provider, func(t *testing.T) {
			base := &cassetteWiringTestTransport{}
			stateDir := t.TempDir()
			transport := &agentReplayProviderHomeTransport{
				base: base, stateDir: stateDir,
			}
			descriptor, found := sessionreplay.FindProviderReplayByProvider(provider)
			if !found {
				t.Fatalf("%s replay descriptor is unavailable", provider)
			}
			envName := descriptor.PortableRuntime.HomeEnvVars[0]
			connection, err := transport.Start(
				context.Background(),
				agentruntime.ProcessSpec{
					Provider:       provider,
					AgentSessionID: "session-1",
					Env: []string{
						"HOME=/Users/recording",
						envName + "=/Users/recording/provider-home",
					},
				},
			)
			if err != nil {
				t.Fatal(err)
			}
			if err := connection.Close(); err != nil {
				t.Fatal(err)
			}
			base.mu.Lock()
			defer base.mu.Unlock()
			if len(base.specs) != 1 {
				t.Fatalf("spec count = %d, want 1", len(base.specs))
			}
			want := envName + "=" + filepath.Join(
				stateDir,
				"agent",
				"runs",
				"session-1",
				descriptor.PortableRuntime.SessionHomeDirectory,
			)
			count := 0
			for _, entry := range base.specs[0].Env {
				if strings.HasPrefix(entry, envName+"=") {
					count++
					if entry != want {
						t.Fatalf("%s = %q, want %q", envName, entry, want)
					}
				}
			}
			if count != 1 {
				t.Fatalf("%s count = %d, want 1", envName, count)
			}
		})
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
