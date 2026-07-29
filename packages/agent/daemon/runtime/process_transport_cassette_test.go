package agentruntime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type cassetteTestTransport struct {
	connection *cassetteTestConnection
}

type cassetteTestQueueTransport struct {
	mu          sync.Mutex
	connections []*cassetteTestConnection
}

func (t *cassetteTestQueueTransport) Start(context.Context, ProcessSpec) (ProcessConnection, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.connections) == 0 {
		return nil, errors.New("no test connection")
	}
	connection := t.connections[0]
	t.connections = t.connections[1:]
	return connection, nil
}

func (t cassetteTestTransport) Start(context.Context, ProcessSpec) (ProcessConnection, error) {
	return t.connection, nil
}

type cassetteFinalizingTestTransport struct {
	cassetteTestTransport
	finalized bool
}

func (t *cassetteFinalizingTestTransport) Finalize() error {
	t.finalized = true
	return nil
}

type cassetteReplayControlTestTransport struct {
	cassetteTestTransport
	paused      bool
	fastForward bool
}

func (t *cassetteReplayControlTestTransport) PauseReplayPlayback() error {
	t.paused = true
	return nil
}

func (t *cassetteReplayControlTestTransport) ResumeReplayPlayback() error {
	t.paused = false
	return nil
}

func (t *cassetteReplayControlTestTransport) SetReplayPlaybackFastForward(enabled bool) error {
	t.fastForward = enabled
	return nil
}

type cassetteTestConnection struct {
	mu       sync.Mutex
	sent     [][]byte
	received []ProcessFrame
	closed   bool
}

func (c *cassetteTestConnection) Send(data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sent = append(c.sent, append([]byte(nil), data...))
	return nil
}

func (c *cassetteTestConnection) Recv() (ProcessFrame, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.received) == 0 {
		return ProcessFrame{}, io.EOF
	}
	frame := c.received[0]
	c.received = c.received[1:]
	return frame, nil
}

func (c *cassetteTestConnection) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	return nil
}

func TestRecordingAndReplayProcessTransportPreserveChunks(t *testing.T) {
	exitCode := 0
	baseConnection := &cassetteTestConnection{
		received: []ProcessFrame{
			{Stdout: []byte("{\"jsonrpc\":\"2.0\",")},
			{Stdout: []byte("\"id\":1,\"result\":{}}\n")},
			{Stderr: []byte("diagnostic\n")},
			{ExitCode: &exitCode},
		},
	}
	directory := t.TempDir()
	recording, err := NewRecordingProcessTransport(
		cassetteTestTransport{connection: baseConnection},
		directory,
	)
	if err != nil {
		t.Fatal(err)
	}
	spec := ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: "session-recorded",
		CWD:            "/workspace/recorded",
	}
	connection, err := recording.Start(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	outbound := []byte("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n")
	if err := connection.Send(outbound); err != nil {
		t.Fatal(err)
	}
	var recordedFrames []ProcessFrame
	for range baseConnection.received {
		frame, err := connection.Recv()
		if err != nil {
			t.Fatal(err)
		}
		recordedFrames = append(recordedFrames, frame)
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	if err := recording.Finalize(); err != nil {
		t.Fatal(err)
	}
	manifestRaw, err := os.ReadFile(filepath.Join(directory, processCassetteManifestName))
	if err != nil {
		t.Fatal(err)
	}
	var manifest ProcessCassetteManifest
	if err := json.Unmarshal(manifestRaw, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.FrameCount != 5 ||
		manifest.PayloadBytes == 0 ||
		manifest.StoredBytes == 0 ||
		manifest.MaxFrameBytes == 0 {
		t.Fatalf("manifest size accounting = %#v", manifest)
	}
	if manifest.FramesByKind["outbound"].FrameCount != 1 ||
		manifest.FramesByKind["stdout"].FrameCount != 2 ||
		manifest.FramesByKind["stderr"].FrameCount != 1 ||
		manifest.FramesByKind["exit"].FrameCount != 1 {
		t.Fatalf("manifest kind accounting = %#v", manifest.FramesByKind)
	}
	if manifest.Limits.MaxFrameBytes != processCassetteMaxPayloadBytes ||
		manifest.Limits.MaxStoredBytes != processCassetteMaxStoredBytes {
		t.Fatalf("manifest limits = %#v", manifest.Limits)
	}

	replay, err := NewReplayProcessTransport(directory)
	if err != nil {
		t.Fatal(err)
	}
	replayConnection, err := replay.Start(context.Background(), ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: "session-recorded",
		CWD:            "/workspace/replayed",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := replayConnection.Send(outbound); err != nil {
		t.Fatal(err)
	}
	for index, want := range recordedFrames {
		got, err := replayConnection.Recv()
		if err != nil {
			t.Fatalf("receive frame %d: %v", index, err)
		}
		assertProcessFrameEqual(t, got, want)
	}
	if _, err := replayConnection.Recv(); !errors.Is(err, io.EOF) {
		t.Fatalf("Recv() error = %v, want EOF", err)
	}
	if err := replayConnection.Close(); err != nil {
		t.Fatal(err)
	}
	if err := replay.VerifyComplete(); err != nil {
		t.Fatal(err)
	}
}

func TestProcessCassetteWriterRejectsOversizedFrameBeforeWriting(t *testing.T) {
	writer, err := newProcessCassetteWriter(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	writer.maxPayloadBytes = 3
	writer.maxStoredBytes = 1024
	err = writer.append(processCassetteChunk{
		ConnectionID: "connection-1",
		ChunkSeq:     1,
		Kind:         "stdout",
		Data:         "dG9vbGFyZ2U=",
	})
	if !errors.Is(err, ErrProcessCassetteSizeLimit) {
		t.Fatalf("append() error = %v, want size limit", err)
	}
	info, statErr := writer.chunks.Stat()
	if statErr != nil {
		t.Fatal(statErr)
	}
	if info.Size() != 0 || writer.manifest.StoredBytes != 0 || writer.manifest.FrameCount != 0 {
		t.Fatalf(
			"oversized frame was partially recorded: size=%d manifest=%#v",
			info.Size(),
			writer.manifest,
		)
	}
	if err := writer.abort(); err != nil {
		t.Fatal(err)
	}
}

func TestProcessCassetteWriterRejectsTotalStoredSizeBeforeWriting(t *testing.T) {
	writer, err := newProcessCassetteWriter(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	writer.maxPayloadBytes = 1024
	writer.maxStoredBytes = 1
	err = writer.append(processCassetteChunk{
		ConnectionID: "connection-1",
		ChunkSeq:     1,
		Kind:         "exit",
		ExitCode:     intPointer(0),
	})
	if !errors.Is(err, ErrProcessCassetteSizeLimit) {
		t.Fatalf("append() error = %v, want size limit", err)
	}
	info, statErr := writer.chunks.Stat()
	if statErr != nil {
		t.Fatal(statErr)
	}
	if info.Size() != 0 || writer.manifest.StoredBytes != 0 {
		t.Fatalf("oversized total was partially recorded: size=%d", info.Size())
	}
	if err := writer.abort(); err != nil {
		t.Fatal(err)
	}
}

func intPointer(value int) *int {
	return &value
}

func TestReplayProcessTransportFailsClosedOnOutboundMismatch(t *testing.T) {
	directory := recordCassetteForTest(t, []byte("recorded\n"))
	replay, err := NewReplayProcessTransport(directory)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := replay.Start(context.Background(), ProcessSpec{Provider: ProviderCodex})
	if err != nil {
		t.Fatal(err)
	}
	err = connection.Send([]byte("different\n"))
	if err == nil || !strings.Contains(err.Error(), "outbound mismatch") {
		t.Fatalf("Send() error = %v, want outbound mismatch", err)
	}
	if err := replay.VerifyComplete(); err == nil || !strings.Contains(err.Error(), "outbound mismatch") {
		t.Fatalf("VerifyComplete() error = %v, want original outbound mismatch", err)
	}
}

func TestReplayProcessTransportMapsRecordedCWDInStrictJSONMatch(t *testing.T) {
	directory := t.TempDir()
	recording, err := NewRecordingProcessTransport(
		cassetteTestTransport{connection: &cassetteTestConnection{}},
		directory,
	)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := recording.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex,
		CWD:      "/workspace/recorded-session",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Send([]byte(
		"{\"id\":1,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/workspace/recorded-session\",\"unknown\":\"strict\"}}\n",
	)); err != nil {
		t.Fatal(err)
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	if err := recording.Finalize(); err != nil {
		t.Fatal(err)
	}

	replay, err := NewReplayProcessTransport(directory)
	if err != nil {
		t.Fatal(err)
	}
	replayConnection, err := replay.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex,
		CWD:      "/workspace/replay-session",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := replayConnection.Send([]byte(
		"{\"params\":{\"unknown\":\"strict\",\"cwd\":\"/workspace/replay-session\"},\"method\":\"thread/start\",\"id\":1}\n",
	)); err != nil {
		t.Fatalf("Send() error = %v, want mapped semantic match", err)
	}
}

func TestReplayProcessConnectionRecvContextCancelsWhileWaitingForOutbound(t *testing.T) {
	directory := recordCassetteForTest(t, []byte("recorded\n"))
	replay, err := NewReplayProcessTransport(directory)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := replay.Start(
		context.Background(),
		ProcessSpec{Provider: ProviderCodex},
	)
	if err != nil {
		t.Fatal(err)
	}
	contextual, ok := connection.(ContextProcessConnection)
	if !ok {
		t.Fatal("replay connection does not implement ContextProcessConnection")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := contextual.RecvContext(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("RecvContext() error = %v, want context canceled", err)
	}
	if err := connection.Send([]byte("recorded\n")); err != nil {
		t.Fatalf("Send() after canceled receive = %v", err)
	}
}

func TestReplayProcessTransportWaitsForRecordedInboundBeforeNextOutbound(t *testing.T) {
	replay := replayProcessTransportWithChunksForTest(t, []replayConnectionChunksForTest{{
		spec: ProcessSpec{Provider: ProviderCodex, AgentSessionID: "session-1"},
		chunks: []processCassetteChunk{
			{Kind: "outbound", Data: base64.StdEncoding.EncodeToString([]byte("first"))},
			{Kind: "stdout", Data: base64.StdEncoding.EncodeToString([]byte("notification"))},
			{Kind: "outbound", Data: base64.StdEncoding.EncodeToString([]byte("second"))},
		},
	}})
	connection, err := replay.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex, AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Send([]byte("first")); err != nil {
		t.Fatal(err)
	}
	sendResult := make(chan error, 1)
	go func() {
		sendResult <- connection.Send([]byte("second"))
	}()
	select {
	case err := <-sendResult:
		t.Fatalf("second Send() completed before inbound receive: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	frame, err := connection.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if string(frame.Stdout) != "notification" {
		t.Fatalf("stdout = %q, want notification", frame.Stdout)
	}
	select {
	case err := <-sendResult:
		if err != nil {
			t.Fatalf("second Send() error = %v", err)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("second Send() did not continue after inbound receive")
	}
	if err := replay.VerifyComplete(); err != nil {
		t.Fatal(err)
	}
}

func TestSessionRecordingProcessTransportCompletesWithoutClosingProvider(t *testing.T) {
	baseConnection := &cassetteTestConnection{
		received: []ProcessFrame{
			{Stdout: []byte("recorded\n")},
			{Stdout: []byte("not-recorded\n")},
		},
	}
	transport, err := NewSessionRecordingProcessTransport(
		cassetteTestTransport{connection: baseConnection},
	)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	if err := transport.Arm("session-1", directory); err != nil {
		t.Fatal(err)
	}
	connection, err := transport.Start(context.Background(), ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Send([]byte("initialize\n")); err != nil {
		t.Fatal(err)
	}
	frame, err := connection.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if string(frame.Stdout) != "recorded\n" {
		t.Fatalf("first stdout = %q", frame.Stdout)
	}
	if err := transport.Complete("session-1"); err != nil {
		t.Fatal(err)
	}
	if baseConnection.closed {
		t.Fatal("completing recording closed the provider connection")
	}
	if err := connection.Send([]byte("after-complete\n")); err != nil {
		t.Fatal(err)
	}
	frame, err = connection.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if string(frame.Stdout) != "not-recorded\n" {
		t.Fatalf("second stdout = %q", frame.Stdout)
	}

	replay, err := NewReplayProcessTransport(directory)
	if err != nil {
		t.Fatal(err)
	}
	replayConnection, err := replay.Start(context.Background(), ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := replayConnection.Send([]byte("initialize\n")); err != nil {
		t.Fatal(err)
	}
	replayed, err := replayConnection.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if string(replayed.Stdout) != "recorded\n" {
		t.Fatalf("replayed stdout = %q", replayed.Stdout)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := replayConnection.(ContextProcessConnection).RecvContext(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("RecvContext() after capture end = %v, want context canceled", err)
	}
	if err := replay.VerifyComplete(); err != nil {
		t.Fatal(err)
	}
}

func TestSessionGraphProcessTapeMatchesParallelAndNestedSessionsByIdentity(t *testing.T) {
	base := &cassetteTestQueueTransport{
		connections: []*cassetteTestConnection{{}, {}, {}, {}},
	}
	transport, err := NewSessionRecordingProcessTransport(base)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	if err := transport.Arm("root-session", directory); err != nil {
		t.Fatal(err)
	}
	root, err := transport.Start(context.Background(), ProcessSpec{
		Provider:           ProviderCodex,
		AgentSessionID:     "root-session",
		RootAgentSessionID: "root-session",
	})
	if err != nil {
		t.Fatal(err)
	}
	childA, err := transport.Start(context.Background(), ProcessSpec{
		Provider:           ProviderCodex,
		AgentSessionID:     "child-a",
		RootAgentSessionID: "root-session",
	})
	if err != nil {
		t.Fatal(err)
	}
	childB, err := transport.Start(context.Background(), ProcessSpec{
		Provider:           ProviderCodex,
		AgentSessionID:     "child-b",
		RootAgentSessionID: "root-session",
	})
	if err != nil {
		t.Fatal(err)
	}
	grandchild, err := transport.Start(context.Background(), ProcessSpec{
		Provider:           ProviderCodex,
		AgentSessionID:     "grandchild-of-a",
		RootAgentSessionID: "root-session",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := root.Send([]byte("root-outbound")); err != nil {
		t.Fatal(err)
	}
	if err := childA.Send([]byte("child-a-outbound")); err != nil {
		t.Fatal(err)
	}
	if err := childB.Send([]byte("child-b-outbound")); err != nil {
		t.Fatal(err)
	}
	if err := grandchild.Send([]byte("grandchild-outbound")); err != nil {
		t.Fatal(err)
	}
	if err := transport.Complete("root-session"); err != nil {
		t.Fatal(err)
	}

	replay, err := NewReplayProcessTransport(directory)
	if err != nil {
		t.Fatal(err)
	}
	// Start in the opposite global order. Session identity prevents cassettes
	// from crossing when child launches race.
	replayedGrandchild, err := replay.Start(context.Background(), ProcessSpec{
		Provider:           ProviderCodex,
		AgentSessionID:     "grandchild-of-a",
		RootAgentSessionID: "root-session",
	})
	if err != nil {
		t.Fatal(err)
	}
	replayedChildB, err := replay.Start(context.Background(), ProcessSpec{
		Provider:           ProviderCodex,
		AgentSessionID:     "child-b",
		RootAgentSessionID: "root-session",
	})
	if err != nil {
		t.Fatal(err)
	}
	replayedRoot, err := replay.Start(context.Background(), ProcessSpec{
		Provider:           ProviderCodex,
		AgentSessionID:     "root-session",
		RootAgentSessionID: "root-session",
	})
	if err != nil {
		t.Fatal(err)
	}
	replayedChildA, err := replay.Start(context.Background(), ProcessSpec{
		Provider:           ProviderCodex,
		AgentSessionID:     "child-a",
		RootAgentSessionID: "root-session",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := replayedGrandchild.Send([]byte("grandchild-outbound")); err != nil {
		t.Fatal(err)
	}
	if err := replayedChildB.Send([]byte("child-b-outbound")); err != nil {
		t.Fatal(err)
	}
	if err := replayedRoot.Send([]byte("root-outbound")); err != nil {
		t.Fatal(err)
	}
	if err := replayedChildA.Send([]byte("child-a-outbound")); err != nil {
		t.Fatal(err)
	}
	if err := replay.VerifyComplete(); err != nil {
		t.Fatal(err)
	}
}

func TestSessionRecordingAttachesToExistingProviderConnection(t *testing.T) {
	baseConnection := &cassetteTestConnection{}
	transport, err := NewSessionRecordingProcessTransport(
		cassetteTestTransport{connection: baseConnection},
	)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := transport.Start(context.Background(), ProcessSpec{
		Provider:           ProviderCodex,
		AgentSessionID:     "existing-session",
		RootAgentSessionID: "existing-session",
	})
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	if err := transport.Arm("existing-session", directory); err != nil {
		t.Fatal(err)
	}
	if err := connection.Send([]byte("continued-turn")); err != nil {
		t.Fatal(err)
	}
	if err := transport.Complete("existing-session"); err != nil {
		t.Fatal(err)
	}
	replay, err := NewReplayProcessTransport(directory)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := replay.Start(context.Background(), ProcessSpec{
		Provider:           ProviderCodex,
		AgentSessionID:     "existing-session",
		RootAgentSessionID: "existing-session",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := replayed.Send([]byte("continued-turn")); err != nil {
		t.Fatal(err)
	}
	if err := replay.VerifyComplete(); err != nil {
		t.Fatal(err)
	}
}

func TestSessionRecordingProcessTransportRejectsConcurrentArm(t *testing.T) {
	transport, err := NewSessionRecordingProcessTransport(
		cassetteTestTransport{connection: &cassetteTestConnection{}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := transport.Arm("session-1", t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if err := transport.Arm("session-2", t.TempDir()); !errors.Is(err, ErrSessionRecordingBusy) {
		t.Fatalf("Arm() error = %v, want busy", err)
	}
	if err := transport.Cancel("session-1"); err != nil {
		t.Fatal(err)
	}
}

func TestSessionRecordingProcessTransportFinalizesWrappedTransport(t *testing.T) {
	base := &cassetteFinalizingTestTransport{
		cassetteTestTransport: cassetteTestTransport{
			connection: &cassetteTestConnection{},
		},
	}
	transport, err := NewSessionRecordingProcessTransport(base)
	if err != nil {
		t.Fatal(err)
	}
	if err := transport.Finalize(); err != nil {
		t.Fatal(err)
	}
	if !base.finalized {
		t.Fatal("wrapped transport was not finalized")
	}
}

func TestSessionRecordingProcessTransportDelegatesReplayPlaybackControls(t *testing.T) {
	base := &cassetteReplayControlTestTransport{
		cassetteTestTransport: cassetteTestTransport{
			connection: &cassetteTestConnection{},
		},
	}
	transport, err := NewSessionRecordingProcessTransport(base)
	if err != nil {
		t.Fatal(err)
	}
	if err := transport.PauseReplayPlayback(); err != nil {
		t.Fatal(err)
	}
	if !base.paused {
		t.Fatal("PauseReplayPlayback() was not delegated")
	}
	if err := transport.SetReplayPlaybackFastForward(true); err != nil {
		t.Fatal(err)
	}
	if !base.fastForward {
		t.Fatal("SetReplayPlaybackFastForward() was not delegated")
	}
	if err := transport.ResumeReplayPlayback(); err != nil {
		t.Fatal(err)
	}
	if base.paused {
		t.Fatal("ResumeReplayPlayback() was not delegated")
	}
}

func TestReplayProcessTransportRejectsIncompleteCassette(t *testing.T) {
	directory := recordCassetteForTestWithoutFinalize(t)
	_, err := NewReplayProcessTransport(directory)
	if err == nil || !strings.Contains(err.Error(), "want complete") {
		t.Fatalf("NewReplayProcessTransport() error = %v, want incomplete rejection", err)
	}
}

func TestReplayProcessTransportUsesElapsedTimeAtConfiguredSpeed(t *testing.T) {
	directory := t.TempDir()
	writer, err := newProcessCassetteWriter(directory)
	if err != nil {
		t.Fatal(err)
	}
	connectionID, err := writer.start(ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.append(processCassetteChunk{
		ConnectionID: connectionID,
		ChunkSeq:     1,
		ElapsedMS:    1_000,
		Kind:         "outbound",
		Data:         base64.StdEncoding.EncodeToString([]byte("start")),
	}); err != nil {
		t.Fatal(err)
	}
	if err := writer.append(processCassetteChunk{
		ConnectionID: connectionID,
		ChunkSeq:     2,
		ElapsedMS:    1_120,
		Kind:         "stdout",
		Data:         base64.StdEncoding.EncodeToString([]byte("ready")),
	}); err != nil {
		t.Fatal(err)
	}
	if err := writer.finishConnection(); err != nil {
		t.Fatal(err)
	}
	if err := writer.finalize(); err != nil {
		t.Fatal(err)
	}

	replay, err := NewReplayProcessTransport(directory)
	if err != nil {
		t.Fatal(err)
	}
	if state := replay.ReplayPlaybackState(); state.Speed != 1 {
		t.Fatalf("default playback speed = %v, want 1", state.Speed)
	}
	if err := replay.SetReplayPlaybackSpeed(4); err != nil {
		t.Fatal(err)
	}
	connection, err := replay.Start(context.Background(), ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Send([]byte("start")); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	frame, err := connection.Recv()
	if err != nil {
		t.Fatal(err)
	}
	elapsed := time.Since(started)
	if string(frame.Stdout) != "ready" {
		t.Fatalf("stdout = %q, want ready", frame.Stdout)
	}
	if elapsed < 20*time.Millisecond {
		t.Fatalf("elapsed = %v, want recorded timing at 4x", elapsed)
	}
	if elapsed > 250*time.Millisecond {
		t.Fatalf("elapsed = %v, want approximately 30ms at 4x", elapsed)
	}
	if state := replay.ReplayPlaybackState(); !state.Drained {
		t.Fatalf("playback state = %#v, want drained", state)
	}
	if err := replay.SetReplayPlaybackSpeed(3); !errors.Is(err, ErrReplayPlaybackSpeed) {
		t.Fatalf("unsupported speed error = %v", err)
	}
}

func TestReplayProcessTransportPauseBlocksNextInboundUntilResume(t *testing.T) {
	replay := replayProcessTransportWithChunksForTest(t, []replayConnectionChunksForTest{{
		spec: ProcessSpec{Provider: ProviderCodex, AgentSessionID: "session-1"},
		chunks: []processCassetteChunk{
			{ElapsedMS: 0, Kind: "outbound", Data: base64.StdEncoding.EncodeToString([]byte("start"))},
			{ElapsedMS: 120, Kind: "stdout", Data: base64.StdEncoding.EncodeToString([]byte("ready"))},
		},
	}})
	connection, err := replay.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex, AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Send([]byte("start")); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		frame, recvErr := connection.Recv()
		if recvErr == nil && string(frame.Stdout) != "ready" {
			recvErr = fmt.Errorf("stdout = %q, want ready", frame.Stdout)
		}
		result <- recvErr
	}()
	time.Sleep(20 * time.Millisecond)
	if err := replay.PauseReplayPlayback(); err != nil {
		t.Fatal(err)
	}
	if state := replay.ReplayPlaybackState(); !state.Paused || state.FastForward {
		t.Fatalf("paused playback state = %#v", state)
	}
	select {
	case err := <-result:
		t.Fatalf("Recv() returned while paused: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	if err := replay.ResumeReplayPlayback(); err != nil {
		t.Fatal(err)
	}
	resumedAt := time.Now()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
		if elapsed := time.Since(resumedAt); elapsed < 60*time.Millisecond {
			t.Fatalf("Recv() returned %v after resume, want paused time excluded", elapsed)
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("Recv() did not return after resume")
	}
}

func TestReplayProcessTransportPauseIsSharedAcrossConnections(t *testing.T) {
	replay := replayProcessTransportWithChunksForTest(t, []replayConnectionChunksForTest{
		{
			spec: ProcessSpec{Provider: ProviderCodex, AgentSessionID: "session-1"},
			chunks: []processCassetteChunk{{
				Kind: "stdout",
				Data: base64.StdEncoding.EncodeToString([]byte("one")),
			}},
		},
		{
			spec: ProcessSpec{Provider: ProviderCodex, AgentSessionID: "session-2"},
			chunks: []processCassetteChunk{{
				Kind: "stdout",
				Data: base64.StdEncoding.EncodeToString([]byte("two")),
			}},
		},
	})
	if err := replay.PauseReplayPlayback(); err != nil {
		t.Fatal(err)
	}
	results := make(chan string, 2)
	for _, sessionID := range []string{"session-1", "session-2"} {
		connection, err := replay.Start(context.Background(), ProcessSpec{
			Provider: ProviderCodex, AgentSessionID: sessionID,
		})
		if err != nil {
			t.Fatal(err)
		}
		go func() {
			frame, recvErr := connection.Recv()
			if recvErr != nil {
				results <- "error: " + recvErr.Error()
				return
			}
			results <- string(frame.Stdout)
		}()
	}
	select {
	case result := <-results:
		t.Fatalf("connection returned while shared playback was paused: %q", result)
	case <-time.After(50 * time.Millisecond):
	}
	if err := replay.ResumeReplayPlayback(); err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for range 2 {
		select {
		case result := <-results:
			got[result] = true
		case <-time.After(200 * time.Millisecond):
			t.Fatal("connection did not resume")
		}
	}
	if !got["one"] || !got["two"] {
		t.Fatalf("resumed frames = %#v, want both connections", got)
	}
}

func TestReplayProcessTransportPausedReceiveCanCancelAndClose(t *testing.T) {
	replay := replayProcessTransportWithChunksForTest(t, []replayConnectionChunksForTest{{
		spec: ProcessSpec{Provider: ProviderCodex, AgentSessionID: "session-1"},
		chunks: []processCassetteChunk{
			{Kind: "outbound", Data: base64.StdEncoding.EncodeToString([]byte("start"))},
			{Kind: "stdout", Data: base64.StdEncoding.EncodeToString([]byte("ready"))},
		},
	}})
	connection, err := replay.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex, AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := replay.PauseReplayPlayback(); err != nil {
		t.Fatal(err)
	}
	if err := connection.Send([]byte("start")); err != nil {
		t.Fatalf("outbound validation was blocked while paused: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	canceled := make(chan error, 1)
	go func() {
		_, recvErr := connection.(ContextProcessConnection).RecvContext(ctx)
		canceled <- recvErr
	}()
	cancel()
	select {
	case err := <-canceled:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("RecvContext() error = %v, want context canceled", err)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("paused RecvContext() did not cancel")
	}

	closed := make(chan error, 1)
	received := make(chan error, 1)
	go func() {
		_, recvErr := connection.Recv()
		received <- recvErr
	}()
	go func() {
		closed <- connection.Close()
	}()
	select {
	case err := <-closed:
		if err == nil || !strings.Contains(err.Error(), "consumed 1 of 2 chunks") {
			t.Fatalf("Close() error = %v, want incomplete cassette error", err)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("Close() deadlocked while paused")
	}
	select {
	case err := <-received:
		if !errors.Is(err, io.EOF) {
			t.Fatalf("Recv() after Close() error = %v, want EOF", err)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("paused Recv() did not unblock after Close()")
	}
}

func TestReplayProcessTransportFastForwardConsumesFramesAndValidatesOutbound(t *testing.T) {
	replay := replayProcessTransportWithChunksForTest(t, []replayConnectionChunksForTest{{
		spec: ProcessSpec{Provider: ProviderCodex, AgentSessionID: "session-1"},
		chunks: []processCassetteChunk{
			{ElapsedMS: 10_000, Kind: "outbound", Data: base64.StdEncoding.EncodeToString([]byte("first"))},
			{ElapsedMS: 20_000, Kind: "stdout", Data: base64.StdEncoding.EncodeToString([]byte("one"))},
			{ElapsedMS: 30_000, Kind: "outbound", Data: base64.StdEncoding.EncodeToString([]byte("second"))},
			{ElapsedMS: 40_000, Kind: "stdout", Data: base64.StdEncoding.EncodeToString([]byte("two"))},
		},
	}})
	connection, err := replay.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex, AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := replay.PauseReplayPlayback(); err != nil {
		t.Fatal(err)
	}
	if err := replay.SetReplayPlaybackFastForward(true); err != nil {
		t.Fatal(err)
	}
	if state := replay.ReplayPlaybackState(); !state.Paused || !state.FastForward {
		t.Fatalf("fast-forward playback state = %#v", state)
	}
	started := time.Now()
	if err := connection.Send([]byte("first")); err != nil {
		t.Fatal(err)
	}
	first, err := connection.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if string(first.Stdout) != "one" {
		t.Fatalf("first stdout = %q, want one", first.Stdout)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := connection.(ContextProcessConnection).RecvContext(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("RecvContext() before required outbound error = %v, want context canceled", err)
	}
	if err := connection.Send([]byte("second")); err != nil {
		t.Fatal(err)
	}
	second, err := connection.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if string(second.Stdout) != "two" {
		t.Fatalf("second stdout = %q, want two", second.Stdout)
	}
	if elapsed := time.Since(started); elapsed > 200*time.Millisecond {
		t.Fatalf("fast-forward took %v, want recorded waits skipped", elapsed)
	}
	if err := replay.SetReplayPlaybackFastForward(false); err != nil {
		t.Fatal(err)
	}
	if state := replay.ReplayPlaybackState(); !state.Paused || state.FastForward || !state.Drained {
		t.Fatalf("finished playback state = %#v", state)
	}
	if err := replay.VerifyComplete(); err != nil {
		t.Fatal(err)
	}
}

func TestReplayProcessTransportRejectsChunkSequenceGap(t *testing.T) {
	directory := recordCassetteForTest(t, []byte("recorded\n"))
	chunksPath := filepath.Join(directory, processCassetteChunksName)
	raw, err := os.ReadFile(chunksPath)
	if err != nil {
		t.Fatal(err)
	}
	raw = []byte(strings.Replace(string(raw), `"chunkSeq":1`, `"chunkSeq":2`, 1))
	if err := os.WriteFile(chunksPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = NewReplayProcessTransport(directory)
	if err == nil || !strings.Contains(err.Error(), "integrity mismatch") {
		t.Fatalf("NewReplayProcessTransport() error = %v, want integrity rejection", err)
	}
}

func TestReplayProcessTransportRejectsMissingInboundFrame(t *testing.T) {
	directory := t.TempDir()
	base := &cassetteTestConnection{
		received: []ProcessFrame{{Stdout: []byte("provider response")}},
	}
	recording, err := NewRecordingProcessTransport(
		cassetteTestTransport{connection: base},
		directory,
	)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := recording.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex, AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Send([]byte("request")); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Recv(); err != nil {
		t.Fatal(err)
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	if err := recording.Finalize(); err != nil {
		t.Fatal(err)
	}
	framesPath := filepath.Join(directory, processCassetteChunksName)
	raw, err := os.ReadFile(framesPath)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 2 {
		t.Fatalf("frames = %d, want outbound and inbound", len(lines))
	}
	if err := os.WriteFile(framesPath, []byte(lines[0]+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = NewReplayProcessTransport(directory)
	if err == nil || !strings.Contains(err.Error(), "integrity mismatch") {
		t.Fatalf("NewReplayProcessTransport() error = %v, want missing inbound rejection", err)
	}
}

type replayConnectionChunksForTest struct {
	spec   ProcessSpec
	chunks []processCassetteChunk
}

func replayProcessTransportWithChunksForTest(
	t *testing.T,
	connections []replayConnectionChunksForTest,
) *ReplayProcessTransport {
	t.Helper()
	directory := t.TempDir()
	writer, err := newProcessCassetteWriter(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, connection := range connections {
		connectionID, err := writer.start(connection.spec)
		if err != nil {
			t.Fatal(err)
		}
		for index, chunk := range connection.chunks {
			chunk.ConnectionID = connectionID
			chunk.ChunkSeq = uint64(index + 1)
			if err := writer.append(chunk); err != nil {
				t.Fatal(err)
			}
		}
		if err := writer.finishConnection(); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.finalize(); err != nil {
		t.Fatal(err)
	}
	replay, err := NewReplayProcessTransport(directory)
	if err != nil {
		t.Fatal(err)
	}
	return replay
}

func recordCassetteForTest(t *testing.T, outbound []byte) string {
	t.Helper()
	directory := t.TempDir()
	recording, err := NewRecordingProcessTransport(
		cassetteTestTransport{connection: &cassetteTestConnection{}},
		directory,
	)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := recording.Start(
		context.Background(),
		ProcessSpec{Provider: ProviderCodex},
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Send(outbound); err != nil {
		t.Fatal(err)
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	if err := recording.Finalize(); err != nil {
		t.Fatal(err)
	}
	return directory
}

func recordCassetteForTestWithoutFinalize(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	recording, err := NewRecordingProcessTransport(
		cassetteTestTransport{connection: &cassetteTestConnection{}},
		directory,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := recording.writer.chunks.Close(); err != nil {
		t.Fatal(err)
	}
	return directory
}

func assertProcessFrameEqual(t *testing.T, got, want ProcessFrame) {
	t.Helper()
	if string(got.Stdout) != string(want.Stdout) ||
		string(got.Stderr) != string(want.Stderr) ||
		got.Message != want.Message {
		t.Fatalf("frame = %#v, want %#v", got, want)
	}
	switch {
	case got.ExitCode == nil && want.ExitCode == nil:
	case got.ExitCode == nil || want.ExitCode == nil:
		t.Fatalf("frame exit = %v, want %v", got.ExitCode, want.ExitCode)
	case *got.ExitCode != *want.ExitCode:
		t.Fatalf("frame exit = %d, want %d", *got.ExitCode, *want.ExitCode)
	}
}
