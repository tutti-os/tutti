package agentruntime

import (
	"bytes"
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

	sessionreplay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

func codexReplayDescriptorForCassetteTest(
	t *testing.T,
) sessionreplay.ProviderReplayDescriptor {
	t.Helper()
	descriptor, ok := sessionreplay.FindProviderReplayByProvider(ProviderCodex)
	if !ok {
		t.Fatal("Codex replay descriptor is missing")
	}
	return descriptor
}

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

func TestRecordingProcessTransportProjectsAccountEmailOnlyInPersistedCopy(t *testing.T) {
	const privateEmail = "developer@example.com"
	accountResponse := []byte(
		`{"id":2,"result":{"account":{"type":"chatgpt","email":"` +
			privateEmail +
			`","planType":"pro"},"requiresOpenaiAuth":true}}` + "\n",
	)
	split := len(accountResponse) / 2
	unrelated := []byte(
		`{"method":"item/agentMessage/delta","params":{"text":"keep ` +
			privateEmail +
			` unchanged"}}` + "\n",
	)
	baseConnection := &cassetteTestConnection{
		received: []ProcessFrame{
			{Stdout: append([]byte(nil), accountResponse[:split]...)},
			{Stdout: append([]byte(nil), accountResponse[split:]...)},
			{Stdout: unrelated},
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
	connection, err := recording.Start(context.Background(), ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	accountRequest := []byte(
		`{"id":2,"method":"account/read","params":{"refreshToken":false}}` + "\n",
	)
	if err := connection.Send(accountRequest); err != nil {
		t.Fatal(err)
	}
	unrelatedOutbound := []byte(
		`{"id":3,"method":"turn/start","params":{"prompt":"keep ` +
			privateEmail +
			` and /Users/developer/private unchanged"}}` + "\n",
	)
	if err := connection.Send(unrelatedOutbound); err != nil {
		t.Fatal(err)
	}
	var liveStdout []byte
	for range 3 {
		frame, recvErr := connection.Recv()
		if recvErr != nil {
			t.Fatal(recvErr)
		}
		liveStdout = append(liveStdout, frame.Stdout...)
	}
	if !bytes.Contains(liveStdout, []byte(privateEmail)) {
		t.Fatalf("live Adapter copy was projected: %s", liveStdout)
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	if err := recording.Finalize(); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(filepath.Join(directory, processCassetteChunksName))
	if err != nil {
		t.Fatal(err)
	}
	var persistedStdout []byte
	var persistedOutbound []byte
	for _, line := range bytes.Split(bytes.TrimSpace(raw), []byte{'\n'}) {
		var chunk processCassetteChunk
		if err := json.Unmarshal(line, &chunk); err != nil {
			t.Fatal(err)
		}
		data, err := base64.StdEncoding.DecodeString(chunk.Data)
		if err != nil {
			t.Fatal(err)
		}
		switch chunk.Kind {
		case "stdout":
			persistedStdout = append(persistedStdout, data...)
		case "outbound":
			persistedOutbound = append(persistedOutbound, data...)
		}
	}
	if bytes.Contains(
		persistedStdout,
		[]byte(`"email":"`+privateEmail+`"`),
	) {
		t.Fatalf("unexpected persisted private account email: %s", persistedStdout)
	}
	if !bytes.Contains(persistedStdout, []byte(portableProcessCassetteAccountEmail)) {
		t.Fatalf("persisted account response was not projected: %s", persistedStdout)
	}
	if !bytes.Contains(persistedStdout, []byte("keep "+privateEmail+" unchanged")) {
		t.Fatalf("unrelated Provider text was rewritten: %s", persistedStdout)
	}
	if !bytes.Contains(
		persistedOutbound,
		[]byte("keep "+privateEmail+" and /Users/developer/private unchanged"),
	) {
		t.Fatalf("outbound prompt text was rewritten: %s", persistedOutbound)
	}
}

func TestRecordingProcessTransportRejectsCredentialBearingProtocolMethod(t *testing.T) {
	recording, err := NewRecordingProcessTransport(
		cassetteTestTransport{connection: &cassetteTestConnection{}},
		t.TempDir(),
	)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := recording.Start(context.Background(), ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	err = connection.Send([]byte(
		`{"id":1,"method":"account/login/start","params":{"apiKey":"secret"}}` + "\n",
	))
	if err == nil || !strings.Contains(err.Error(), "credential-bearing method") {
		t.Fatalf("Send() error = %v, want credential-bearing method rejection", err)
	}
}

func TestRecordingAndReplayProcessTransportMapStructuredHomePath(t *testing.T) {
	directory := t.TempDir()
	recording, err := NewRecordingProcessTransport(
		cassetteTestTransport{connection: &cassetteTestConnection{}},
		directory,
	)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := recording.Start(context.Background(), ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: "session-1",
		CWD:            "/Users/developer/workspace",
		Env:            []string{"HOME=/Users/developer"},
	})
	if err != nil {
		t.Fatal(err)
	}
	err = connection.Send([]byte(
		`{"id":1,"method":"turn/start","params":{"path":"/Users/developer/private"}}` + "\n",
	))
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	if err := recording.Finalize(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(directory, processCassetteChunksName))
	if err != nil {
		t.Fatal(err)
	}
	var persisted []byte
	for _, line := range bytes.Split(bytes.TrimSpace(raw), []byte{'\n'}) {
		var chunk processCassetteChunk
		if err := json.Unmarshal(line, &chunk); err != nil {
			t.Fatal(err)
		}
		data, err := base64.StdEncoding.DecodeString(chunk.Data)
		if err != nil {
			t.Fatal(err)
		}
		persisted = append(persisted, data...)
	}
	if bytes.Contains(persisted, []byte("/Users/developer")) ||
		!bytes.Contains(persisted, []byte(portableProcessCassetteHomeToken)) {
		t.Fatalf("persisted cassette did not project HOME path: %s", persisted)
	}

	replay, err := NewReplayProcessTransport(directory)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := replay.Start(context.Background(), ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: "session-1",
		CWD:            "/Users/replay/workspace",
		Env:            []string{"HOME=/Users/replay"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := replayed.Send([]byte(
		`{"id":1,"method":"turn/start","params":{"path":"/Users/replay/private"}}` + "\n",
	)); err != nil {
		t.Fatalf("Send() error = %v, want replay HOME mapping", err)
	}
}

func TestRecordingAndReplayProcessTransportMapGeneratedImagePathToCodexHome(
	t *testing.T,
) {
	directory := t.TempDir()
	recording, err := NewRecordingProcessTransport(
		cassetteTestTransport{connection: &cassetteTestConnection{}},
		directory,
	)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := recording.Start(context.Background(), ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: "session-1",
		CWD:            "/Users/developer/workspace",
		Env: []string{
			"HOME=/Users/developer",
			"CODEX_HOME=/recording/codex-home",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	generatedPath := "/recording/codex-home/generated_images/call-1/image.png"
	if err := connection.Send([]byte(
		`{"id":1,"method":"turn/start","params":{"savedPath":"` +
			generatedPath + `"}}` + "\n",
	)); err != nil {
		t.Fatal(err)
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	if err := recording.Finalize(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(directory, processCassetteChunksName))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(generatedPath)) {
		t.Fatalf("persisted cassette retained generated image path: %s", raw)
	}

	replay, err := NewReplayProcessTransport(directory)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := replay.Start(context.Background(), ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: "session-1",
		CWD:            "/Users/replay/workspace",
		Env: []string{
			"HOME=/Users/replay",
			"CODEX_HOME=/replay/codex-home",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := replayed.Send([]byte(
		`{"id":1,"method":"turn/start","params":{"savedPath":` +
			`"/replay/codex-home/generated_images/call-1/image.png"}}` + "\n",
	)); err != nil {
		t.Fatalf("Send() error = %v, want replay CODEX_HOME mapping", err)
	}
}

func TestRecordingProcessTransportRejectsUnknownAbsolutePath(t *testing.T) {
	recording, err := NewRecordingProcessTransport(
		cassetteTestTransport{connection: &cassetteTestConnection{}},
		t.TempDir(),
	)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := recording.Start(context.Background(), ProcessSpec{
		Provider:       ProviderCodex,
		AgentSessionID: "session-1",
		CWD:            "/Users/developer/workspace",
		Env:            []string{"HOME=/Users/developer"},
	})
	if err != nil {
		t.Fatal(err)
	}
	err = connection.Send([]byte(
		`{"id":1,"method":"turn/start","params":{"path":"/Volumes/private"}}` + "\n",
	))
	if err == nil || !strings.Contains(err.Error(), "non-portable path at $.params.path") {
		t.Fatalf("Send() error = %v, want non-portable path rejection", err)
	}
	if strings.Contains(err.Error(), "/Volumes/private") {
		t.Fatalf("Send() error exposed the rejected path: %v", err)
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
		"{\"id\":1,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/workspace/recorded-session/subdirectory\",\"unknown\":\"strict\"}}\n",
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
		"{\"params\":{\"unknown\":\"strict\",\"cwd\":\"/workspace/replay-session/subdirectory\"},\"method\":\"thread/start\",\"id\":1}\n",
	)); err != nil {
		t.Fatalf("Send() error = %v, want mapped semantic match", err)
	}
}

func TestReplayProcessTransportMatchesJSONRPCRequestSemanticsAndMapsResponseID(t *testing.T) {
	expected := []byte(
		`{"id":18,"method":"turn/start","params":{"approvalPolicy":"on-request","input":[{"text":"请回答：1+2=?","type":"text"}],"model":"gpt-5.3-codex-spark","threadId":"thread-1"}}` + "\n",
	)
	actual := []byte(
		`{"id":9,"method":"turn/start","params":{"threadId":"thread-1","input":[{"text":"请回答：1+2=?","type":"text"}],"approvalPolicy":"on-request","model":"gpt-5.3-codex-spark"}}` + "\n",
	)

	descriptor := codexReplayDescriptorForCassetteTest(t)
	responseIDs, _, matches := processCassetteJSONMatch(
		descriptor,
		expected,
		actual,
		"",
		"",
		"",
		nil,
	)
	if !matches {
		t.Fatal("semantically identical JSON-RPC request did not match")
	}
	if got := responseIDs["18"]; got != json.Number("9") {
		t.Fatalf("mapped response id = %#v, want 9", got)
	}

	changedPrompt := bytes.Replace(actual, []byte("1+2"), []byte("3+1"), 1)
	if _, _, matches := processCassetteJSONMatch(
		descriptor,
		expected,
		changedPrompt,
		"",
		"",
		"",
		nil,
	); matches {
		t.Fatal("JSON-RPC request with changed prompt matched")
	}
}

func TestReplayProcessTransportIgnoresVolatileInitializeClientInfo(t *testing.T) {
	expected := []byte(
		`{"id":1,"method":"initialize","params":{"clientInfo":{"name":"codex-cli","title":"Codex","version":"0.146.0"},"capabilities":{"experimentalApi":true}}}` + "\n",
	)
	actual := []byte(
		`{"id":7,"method":"initialize","params":{"capabilities":{"experimentalApi":true},"clientInfo":{"name":"codex-cli","title":"TSH","version":"0.146.1"}}}` + "\n",
	)

	descriptor := codexReplayDescriptorForCassetteTest(t)
	responseIDs, _, matches := processCassetteJSONMatch(
		descriptor,
		expected,
		actual,
		"",
		"",
		"",
		nil,
	)
	if !matches {
		t.Fatal("initialize clientInfo version/title drift did not match")
	}
	if got := responseIDs["1"]; got != json.Number("7") {
		t.Fatalf("mapped response id = %#v, want 7", got)
	}

	changedName := bytes.Replace(actual, []byte(`"name":"codex-cli"`), []byte(`"name":"other-cli"`), 1)
	if _, _, matches := processCassetteJSONMatch(
		descriptor,
		expected,
		changedName,
		"",
		"",
		"",
		nil,
	); matches {
		t.Fatal("initialize clientInfo.name mismatch matched")
	}
}

func TestClaudeSidecarRecordingAndReplayProjectsEnvironmentAndGeneratedIdentities(t *testing.T) {
	directory := t.TempDir()
	base := &cassetteTestConnection{received: []ProcessFrame{
		{Stdout: []byte(`{"version":10,"id":"request-recorded","type":"ok","payload":{"providerSessionId":"provider-recorded"}}` + "\n")},
		{Stdout: []byte(`{"version":10,"id":"exec-recorded","type":"ok"}` + "\n")},
	}}
	recording, err := NewRecordingProcessTransport(
		cassetteTestTransport{connection: base},
		directory,
	)
	if err != nil {
		t.Fatal(err)
	}
	recordedSpec := ProcessSpec{
		Provider:       ProviderClaudeCode,
		AgentSessionID: "session-recorded",
		CWD:            "/Users/recorded/project",
		Env: []string{
			"ANTHROPIC_API_KEY=secret-recorded",
			"CLAUDE_CONFIG_DIR=/Users/recorded/.claude",
			"IS_SANDBOX=1",
		},
	}
	connection, err := recording.Start(context.Background(), recordedSpec)
	if err != nil {
		t.Fatal(err)
	}
	recordedStart := []byte(`{"version":10,"id":"request-recorded","type":"start","payload":{"agentSessionId":"session-recorded","providerSessionId":"provider-recorded","cwd":"/Users/recorded/project","env":{"ANTHROPIC_API_KEY":"secret-recorded","CLAUDE_CONFIG_DIR":"/Users/recorded/.claude","IS_SANDBOX":"1"}}}` + "\n")
	if err := connection.Send(recordedStart); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Recv(); err != nil {
		t.Fatal(err)
	}
	recordedExec := []byte(`{"version":10,"id":"exec-recorded","type":"exec","payload":{"agentSessionId":"session-recorded","turnId":"turn-recorded","promptCorrelationId":"submit-recorded","prompt":"REPLAY_EXACT"}}` + "\n")
	if err := connection.Send(recordedExec); err != nil {
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

	frames, err := os.ReadFile(filepath.Join(directory, processCassetteChunksName))
	if err != nil {
		t.Fatal(err)
	}
	var projectedPayload bytes.Buffer
	for _, line := range bytes.Split(bytes.TrimSpace(frames), []byte("\n")) {
		var chunk processCassetteChunk
		if err := json.Unmarshal(line, &chunk); err != nil {
			t.Fatal(err)
		}
		if chunk.Data == "" {
			continue
		}
		decoded, err := base64.StdEncoding.DecodeString(chunk.Data)
		if err != nil {
			t.Fatal(err)
		}
		projectedPayload.Write(decoded)
	}
	for _, forbidden := range []string{
		"secret-recorded",
		"/Users/recorded/.claude",
		"ANTHROPIC_API_KEY",
		"CLAUDE_CONFIG_DIR",
		"IS_SANDBOX",
	} {
		if bytes.Contains(projectedPayload.Bytes(), []byte(forbidden)) {
			t.Fatalf("projected Claude tape retained %q", forbidden)
		}
	}

	replay, err := NewReplayProcessTransport(directory)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := replay.Start(context.Background(), ProcessSpec{
		Provider:       ProviderClaudeCode,
		AgentSessionID: "session-replayed",
		CWD:            "/isolated/project",
	})
	if err != nil {
		t.Fatal(err)
	}
	replayStart := []byte(`{"payload":{"env":{"ANTHROPIC_API_KEY":"different-secret","CLAUDE_CONFIG_DIR":"/isolated/.claude","IS_SANDBOX":"1"},"cwd":"/isolated/project","providerSessionId":"provider-replayed","agentSessionId":"session-replayed"},"type":"start","id":"request-replayed","version":10}` + "\n")
	if err := replayed.Send(replayStart); err != nil {
		t.Fatal(err)
	}
	frame, err := replayed.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(frame.Stdout, []byte(`"id":"request-replayed"`)) ||
		!bytes.Contains(frame.Stdout, []byte(`"providerSessionId":"provider-recorded"`)) {
		t.Fatalf("mapped Claude start response = %s", frame.Stdout)
	}
	replayExec := []byte(`{"version":10,"id":"exec-replayed","type":"exec","payload":{"agentSessionId":"session-replayed","turnId":"turn-replayed","promptCorrelationId":"submit-replayed","prompt":"REPLAY_EXACT"}}` + "\n")
	if err := replayed.Send(replayExec); err != nil {
		t.Fatal(err)
	}
	frame, err = replayed.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(frame.Stdout, []byte(`"id":"exec-replayed"`)) {
		t.Fatalf("mapped Claude exec response = %s", frame.Stdout)
	}
	if err := replayed.Close(); err != nil {
		t.Fatal(err)
	}
	if err := replay.VerifyComplete(); err != nil {
		t.Fatal(err)
	}

	mismatchReplay, err := NewReplayProcessTransport(directory)
	if err != nil {
		t.Fatal(err)
	}
	mismatch, err := mismatchReplay.Start(context.Background(), ProcessSpec{
		Provider:       ProviderClaudeCode,
		AgentSessionID: "session-replayed",
		CWD:            "/isolated/project",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := mismatch.Send(replayStart); err != nil {
		t.Fatal(err)
	}
	if _, err := mismatch.Recv(); err != nil {
		t.Fatal(err)
	}
	changedPrompt := bytes.Replace(replayExec, []byte("REPLAY_EXACT"), []byte("WRONG"), 1)
	if err := mismatch.Send(changedPrompt); err == nil ||
		!strings.Contains(err.Error(), "outbound mismatch") {
		t.Fatalf("changed Claude prompt error = %v, want outbound mismatch", err)
	}
}

func TestRecordingAndReplayProcessTransportProjectsPlanDecisionClientUserMessageID(t *testing.T) {
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
	recorded := []byte(
		`{"id":9,"method":"turn/start","params":{"input":[{"text":"Implement the plan.","type":"text"}],"clientUserMessageId":"plan-decision:recorded-operation"}}` + "\n",
	)
	if err := connection.Send(recorded); err != nil {
		t.Fatal(err)
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	if err := recording.Finalize(); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(filepath.Join(directory, processCassetteChunksName))
	if err != nil {
		t.Fatal(err)
	}
	var frame processCassetteChunk
	if err := json.Unmarshal(bytes.TrimSpace(raw), &frame); err != nil {
		t.Fatal(err)
	}
	projected, err := base64.StdEncoding.DecodeString(frame.Data)
	if err != nil {
		t.Fatal(err)
	}
	var projectedMessage map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(projected), &projectedMessage); err != nil {
		t.Fatal(err)
	}
	params, _ := projectedMessage["params"].(map[string]any)
	descriptor := codexReplayDescriptorForCassetteTest(t)
	wantPortableID := descriptor.Tape.GeneratedRequestFields[0].PortableValue
	if got := payloadString(params, "clientUserMessageId"); got != wantPortableID {
		t.Fatalf("persisted clientUserMessageId = %q, want portable marker", got)
	}

	replay, err := NewReplayProcessTransport(directory)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := replay.Start(
		context.Background(),
		ProcessSpec{Provider: ProviderCodex},
	)
	if err != nil {
		t.Fatal(err)
	}
	actual := []byte(
		`{"id":21,"method":"turn/start","params":{"input":[{"text":"Implement the plan.","type":"text"}],"clientUserMessageId":"plan-decision:replay-operation"}}` + "\n",
	)
	if err := replayed.Send(actual); err != nil {
		t.Fatalf("Send() error = %v, want projected runtime-operation match", err)
	}
}

func TestReplayProcessTransportRemapsOrdinaryClientUserMessageIDConsistently(t *testing.T) {
	expected := []byte(
		`{"id":9,"method":"turn/start","params":{"clientUserMessageId":"user-submit-1"}}` + "\n",
	)
	actual := []byte(
		`{"id":10,"method":"turn/start","params":{"clientUserMessageId":"user-submit-2"}}` + "\n",
	)
	descriptor := codexReplayDescriptorForCassetteTest(t)
	_, learned, matches := processCassetteJSONMatch(
		descriptor,
		expected,
		actual,
		"",
		"",
		"",
		nil,
	)
	if !matches {
		t.Fatal("ordinary clientUserMessageId runtime identity did not match")
	}
	if got := learned["user-submit-1"]; got != "user-submit-2" {
		t.Fatalf("learned clientUserMessageId = %q, want user-submit-2", got)
	}

	followupExpected := []byte(
		`{"id":11,"method":"turn/start","params":{"clientUserMessageId":"user-submit-1"}}` + "\n",
	)
	followupActual := []byte(
		`{"id":12,"method":"turn/start","params":{"clientUserMessageId":"user-submit-2"}}` + "\n",
	)
	if _, _, matches := processCassetteJSONMatch(
		descriptor,
		followupExpected,
		followupActual,
		"",
		"",
		"",
		learned,
	); !matches {
		t.Fatal("consistent clientUserMessageId mapping did not match")
	}

	conflictingActual := bytes.Replace(
		followupActual,
		[]byte("user-submit-2"),
		[]byte("user-submit-3"),
		1,
	)
	if _, _, matches := processCassetteJSONMatch(
		descriptor,
		followupExpected,
		conflictingActual,
		"",
		"",
		"",
		learned,
	); matches {
		t.Fatal("conflicting clientUserMessageId mapping matched")
	}

	mappedInbound := mapProcessCassetteFrameJSON(
		[]byte(`{"method":"turn/completed","params":{"clientUserMessageId":"user-submit-1"}}`+"\n"),
		"",
		"",
		"",
		descriptor,
		learned,
	)
	var inboundMessage map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(mappedInbound), &inboundMessage); err != nil {
		t.Fatal(err)
	}
	inboundParams, _ := inboundMessage["params"].(map[string]any)
	if got := payloadString(inboundParams, "clientUserMessageId"); got != "user-submit-2" {
		t.Fatalf("mapped inbound clientUserMessageId = %q, want user-submit-2", got)
	}
}

func TestReplayProcessTransportMapsProtocolCWDWhenProcessCWDIsEmpty(t *testing.T) {
	directory := t.TempDir()
	recording, err := NewRecordingProcessTransport(
		cassetteTestTransport{connection: &cassetteTestConnection{}},
		directory,
	)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := recording.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex, ProtocolCWD: "/recorded/project",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Send([]byte(
		`{"id":1,"method":"session/load","params":{"cwd":"/recorded/project"}}` + "\n",
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
	replayed, err := replay.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex, ProtocolCWD: "/",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := replayed.Send([]byte(
		`{"id":1,"method":"session/load","params":{"cwd":"/"}}` + "\n",
	)); err != nil {
		t.Fatal(err)
	}
}

func TestRecordingProcessTransportRejectsProviderWithoutReplayAdapter(t *testing.T) {
	recording, err := NewRecordingProcessTransport(
		cassetteTestTransport{connection: &cassetteTestConnection{}},
		t.TempDir(),
	)
	if err != nil {
		t.Fatal(err)
	}
	_, err = recording.Start(context.Background(), ProcessSpec{
		Provider: ProviderCursor,
	})
	if err == nil || !strings.Contains(err.Error(), "no replay adapter") {
		t.Fatalf("Start() error = %v, want missing replay adapter", err)
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

func TestReplayProcessTransportSkipsAbsentObservationalRPC(t *testing.T) {
	request := func(value string) processCassetteChunk {
		return processCassetteChunk{
			Kind: "outbound",
			Data: base64.StdEncoding.EncodeToString([]byte(value + "\n")),
		}
	}
	stdout := func(value string) processCassetteChunk {
		return processCassetteChunk{
			Kind: "stdout",
			Data: base64.StdEncoding.EncodeToString([]byte(value + "\n")),
		}
	}
	replay := replayProcessTransportWithChunksForTest(t, []replayConnectionChunksForTest{{
		spec: ProcessSpec{Provider: ProviderCodex, AgentSessionID: "session-1"},
		chunks: []processCassetteChunk{
			request(`{"id":1,"method":"initialize"}`),
			stdout(`{"id":1,"result":{}}`),
			request(`{"id":2,"method":"thread/read","params":{"includeTurns":true}}`),
			stdout(`{"id":2,"result":{"thread":{}}}`),
			stdout(`{"method":"turn/started","params":{"turn":{"id":"turn-1"}}}`),
			request(`{"id":30,"method":"turn/start"}`),
			stdout(`{"id":30,"result":{"turn":{"id":"turn-1"}}}`),
		},
	}})
	connection, err := replay.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex, AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Send([]byte("{\"id\":1,\"method\":\"initialize\"}\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Recv(); err != nil {
		t.Fatal(err)
	}
	frame, err := connection.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(frame.Stdout), "turn/started") ||
		strings.Contains(string(frame.Stdout), `"id":2`) {
		t.Fatalf("stdout = %q, want notification without skipped response", frame.Stdout)
	}
	if err := connection.Send([]byte("{\"id\":3,\"method\":\"turn/start\"}\n")); err != nil {
		t.Fatal(err)
	}
	response, err := connection.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(response.Stdout), `"id":3`) ||
		strings.Contains(string(response.Stdout), `"id":30`) {
		t.Fatalf("stdout = %q, want replay request id", response.Stdout)
	}
	if err := replay.VerifyComplete(); err != nil {
		t.Fatal(err)
	}
}

func TestReplayProcessTransportSkipsOneAbsentObservationalProbeRunWithoutPerProbeDelay(
	t *testing.T,
) {
	request := func(value string) processCassetteChunk {
		return processCassetteChunk{
			Kind: "outbound",
			Data: base64.StdEncoding.EncodeToString([]byte(value + "\n")),
		}
	}
	stdout := func(value string) processCassetteChunk {
		return processCassetteChunk{
			Kind: "stdout",
			Data: base64.StdEncoding.EncodeToString([]byte(value + "\n")),
		}
	}
	chunks := []processCassetteChunk{
		request(`{"id":1,"method":"initialize"}`),
		stdout(`{"id":1,"result":{}}`),
	}
	for id := 2; id <= 5; id++ {
		chunks = append(
			chunks,
			request(fmt.Sprintf(`{"id":%d,"method":"thread/read"}`, id)),
			stdout(fmt.Sprintf(`{"id":%d,"result":{"thread":{}}}`, id)),
		)
	}
	chunks = append(
		chunks,
		stdout(`{"method":"turn/started","params":{"turn":{"id":"turn-1"}}}`),
	)
	replay := replayProcessTransportWithChunksForTest(t, []replayConnectionChunksForTest{{
		spec:   ProcessSpec{Provider: ProviderCodex, AgentSessionID: "session-1"},
		chunks: chunks,
	}})
	connection, err := replay.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex, AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Send([]byte("{\"id\":1,\"method\":\"initialize\"}\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Recv(); err != nil {
		t.Fatal(err)
	}
	startedAt := time.Now()
	frame, err := connection.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(startedAt); elapsed >= 150*time.Millisecond {
		t.Fatalf("absent probe run took %s, want one grace interval", elapsed)
	}
	if !strings.Contains(string(frame.Stdout), "turn/started") {
		t.Fatalf("stdout = %q, want turn/started", frame.Stdout)
	}
	if err := replay.VerifyComplete(); err != nil {
		t.Fatal(err)
	}
}

func TestReplayProcessTransportLetsAnInboundResponseOvertakeAnObservationalRPC(t *testing.T) {
	request := func(value string) processCassetteChunk {
		return processCassetteChunk{
			Kind: "outbound",
			Data: base64.StdEncoding.EncodeToString([]byte(value + "\n")),
		}
	}
	stdout := func(value string) processCassetteChunk {
		return processCassetteChunk{
			Kind: "stdout",
			Data: base64.StdEncoding.EncodeToString([]byte(value + "\n")),
		}
	}
	replay := replayProcessTransportWithChunksForTest(t, []replayConnectionChunksForTest{{
		spec: ProcessSpec{Provider: ProviderCodex, AgentSessionID: "session-1"},
		chunks: []processCassetteChunk{
			request(`{"id":1,"method":"initialize"}`),
			stdout(`{"id":1,"result":{}}`),
			request(`{"id":2,"method":"thread/read","params":{"includeTurns":true}}`),
			stdout(`{"id":2,"result":{"thread":{}}}`),
			request(`{"id":0,"result":{"decision":"accept"}}`),
			stdout(`{"method":"serverRequest/resolved","params":{"requestId":0}}`),
		},
	}})
	connection, err := replay.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex, AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Send([]byte("{\"id\":1,\"method\":\"initialize\"}\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Recv(); err != nil {
		t.Fatal(err)
	}
	sent := make(chan error, 1)
	go func() {
		sent <- connection.Send([]byte(
			"{\"id\":0,\"result\":{\"decision\":\"accept\"}}\n",
		))
	}()
	resolved, err := connection.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(resolved.Stdout), "serverRequest/resolved") ||
		strings.Contains(string(resolved.Stdout), `"id":2`) {
		t.Fatalf("stdout = %q, want resolved notification without probe response", resolved.Stdout)
	}
	if err := <-sent; err != nil {
		t.Fatal(err)
	}
	if err := replay.VerifyComplete(); err != nil {
		t.Fatal(err)
	}
}

func TestReplayProcessTransportDoesNotRequireUnlaunchedProbeConnection(t *testing.T) {
	jsonChunk := func(kind string, value string) processCassetteChunk {
		return processCassetteChunk{
			Kind: kind,
			Data: base64.StdEncoding.EncodeToString([]byte(value + "\n")),
		}
	}
	exitCode := 0
	replay := replayProcessTransportWithChunksForTest(t, []replayConnectionChunksForTest{
		{
			spec: ProcessSpec{Provider: ProviderCodex, AgentSessionID: "session-1"},
			chunks: []processCassetteChunk{
				jsonChunk("outbound", `{"id":1,"method":"initialize"}`),
				jsonChunk("stdout", `{"id":1,"result":{}}`),
			},
		},
		{
			spec: ProcessSpec{Provider: ProviderCodex, AgentSessionID: "session-1"},
			chunks: []processCassetteChunk{
				jsonChunk("outbound", `{"id":1,"method":"initialize"}`),
				jsonChunk("stdout", `{"id":1,"result":{}}`),
				jsonChunk("outbound", `{"method":"initialized"}`),
				jsonChunk("outbound", `{"id":2,"method":"thread/read"}`),
				jsonChunk("stdout", `{"id":2,"result":{"thread":{}}}`),
				{Kind: "exit", ExitCode: &exitCode},
			},
		},
	})
	connection, err := replay.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex, AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Send([]byte("{\"id\":1,\"method\":\"initialize\"}\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Recv(); err != nil {
		t.Fatal(err)
	}
	if err := replay.VerifyComplete(); err != nil {
		t.Fatal(err)
	}
}

func TestReplayProcessTransportAbsorbsExtraOptionalProbeDuringInbound(t *testing.T) {
	request := func(value string) processCassetteChunk {
		return processCassetteChunk{
			Kind: "outbound",
			Data: base64.StdEncoding.EncodeToString([]byte(value + "\n")),
		}
	}
	stdout := func(value string) processCassetteChunk {
		return processCassetteChunk{
			Kind: "stdout",
			Data: base64.StdEncoding.EncodeToString([]byte(value + "\n")),
		}
	}
	replay := replayProcessTransportWithChunksForTest(t, []replayConnectionChunksForTest{{
		spec: ProcessSpec{Provider: ProviderCodex, AgentSessionID: "session-1"},
		chunks: []processCassetteChunk{
			request(`{"id":1,"method":"initialize"}`),
			stdout(`{"id":1,"result":{}}`),
			stdout(`{"method":"turn/started","params":{"turn":{"id":"turn-1"}}}`),
			request(`{"id":30,"method":"turn/start"}`),
			stdout(`{"id":30,"result":{"turn":{"id":"turn-1"}}}`),
		},
	}})
	connection, err := replay.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex, AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Send([]byte("{\"id\":1,\"method\":\"initialize\"}\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Recv(); err != nil {
		t.Fatal(err)
	}
	// Extra nickname-style probes arrive while the tape is delivering inbound.
	if err := connection.Send([]byte(
		"{\"id\":9,\"method\":\"thread/read\",\"params\":{\"threadId\":\"child-1\"}}\n",
	)); err != nil {
		t.Fatal(err)
	}
	frame, err := connection.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(frame.Stdout), `"id":9`) ||
		!strings.Contains(string(frame.Stdout), `"result"`) {
		t.Fatalf("synthetic probe stdout = %q, want id=9 result", frame.Stdout)
	}
	frame, err = connection.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(frame.Stdout), "turn/started") {
		t.Fatalf("stdout = %q, want turn/started", frame.Stdout)
	}
	if err := connection.Send([]byte("{\"id\":3,\"method\":\"turn/start\"}\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Recv(); err != nil {
		t.Fatal(err)
	}
	if state := replay.ReplayPlaybackState(); !state.Drained {
		t.Fatalf("playback state = %#v, want drained", state)
	}
	if err := replay.VerifyComplete(); err != nil {
		t.Fatal(err)
	}
}

func TestReplayProcessTransportSynthesizesOptionalGoalGetDuringInbound(t *testing.T) {
	request := func(value string) processCassetteChunk {
		return processCassetteChunk{
			Kind: "outbound",
			Data: base64.StdEncoding.EncodeToString([]byte(value + "\n")),
		}
	}
	stdout := func(value string) processCassetteChunk {
		return processCassetteChunk{
			Kind: "stdout",
			Data: base64.StdEncoding.EncodeToString([]byte(value + "\n")),
		}
	}
	replay := replayProcessTransportWithChunksForTest(t, []replayConnectionChunksForTest{{
		spec: ProcessSpec{Provider: ProviderCodex, AgentSessionID: "session-1"},
		chunks: []processCassetteChunk{
			request(`{"id":1,"method":"initialize"}`),
			stdout(`{"id":1,"result":{}}`),
			stdout(`{"method":"turn/started","params":{"turn":{"id":"turn-1"}}}`),
			request(`{"id":30,"method":"turn/start"}`),
			stdout(`{"id":30,"result":{"turn":{"id":"turn-1"}}}`),
		},
	}})
	connection, err := replay.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex, AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Send([]byte("{\"id\":1,\"method\":\"initialize\"}\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Recv(); err != nil {
		t.Fatal(err)
	}
	// Activation metadata refresh may probe goal/get before the provider cursor
	// reaches later taped traffic. Absorbing must still unblock NoHandler waits.
	if err := connection.Send([]byte(
		`{"id":42,"method":"thread/goal/get","params":{"threadId":"thread-1"}}` + "\n",
	)); err != nil {
		t.Fatal(err)
	}
	frame, err := connection.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(frame.Stdout), `"id":42`) ||
		!strings.Contains(string(frame.Stdout), `"result"`) {
		t.Fatalf("synthetic goal/get stdout = %q, want id=42 result", frame.Stdout)
	}
	frame, err = connection.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(frame.Stdout), "turn/started") {
		t.Fatalf("stdout = %q, want turn/started", frame.Stdout)
	}
	if err := connection.Send([]byte("{\"id\":3,\"method\":\"turn/start\"}\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Recv(); err != nil {
		t.Fatal(err)
	}
	if state := replay.ReplayPlaybackState(); !state.Drained {
		t.Fatalf("playback state = %#v, want drained", state)
	}
	if err := replay.VerifyComplete(); err != nil {
		t.Fatal(err)
	}
}

func TestReplayProcessTransportSynthesizesOptionalProbeWhileInboundPaused(t *testing.T) {
	request := func(value string) processCassetteChunk {
		return processCassetteChunk{
			Kind: "outbound",
			Data: base64.StdEncoding.EncodeToString([]byte(value + "\n")),
		}
	}
	stdout := func(value string) processCassetteChunk {
		return processCassetteChunk{
			Kind: "stdout",
			Data: base64.StdEncoding.EncodeToString([]byte(value + "\n")),
		}
	}
	replay := replayProcessTransportWithChunksForTest(t, []replayConnectionChunksForTest{{
		spec: ProcessSpec{Provider: ProviderCodex, AgentSessionID: "session-1"},
		chunks: []processCassetteChunk{
			request(`{"id":1,"method":"initialize"}`),
			stdout(`{"id":1,"result":{}}`),
			stdout(`{"method":"turn/started","params":{"turn":{"id":"turn-1"}}}`),
		},
	}})
	connection, err := replay.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex, AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Send([]byte("{\"id\":1,\"method\":\"initialize\"}\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Recv(); err != nil {
		t.Fatal(err)
	}
	if err := replay.PauseReplayPlayback(); err != nil {
		t.Fatal(err)
	}
	type recvResult struct {
		frame ProcessFrame
		err   error
	}
	result := make(chan recvResult, 1)
	go func() {
		frame, recvErr := connection.Recv()
		result <- recvResult{frame: frame, err: recvErr}
	}()
	time.Sleep(20 * time.Millisecond)
	if err := connection.Send([]byte(
		`{"id":42,"method":"thread/goal/get","params":{"threadId":"thread-1"}}` + "\n",
	)); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-result:
		if got.err != nil {
			t.Fatal(got.err)
		}
		if !strings.Contains(string(got.frame.Stdout), `"id":42`) ||
			!strings.Contains(string(got.frame.Stdout), `"result"`) {
			t.Fatalf(
				"synthetic goal/get while paused stdout = %q, want id=42 result",
				got.frame.Stdout,
			)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Recv() did not drain synthetic optional probe while inbound paused")
	}
	if err := replay.ResumeReplayPlayback(); err != nil {
		t.Fatal(err)
	}
	frame, err := connection.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(frame.Stdout), "turn/started") {
		t.Fatalf("stdout = %q, want turn/started after resume", frame.Stdout)
	}
	if err := replay.VerifyComplete(); err != nil {
		t.Fatal(err)
	}
}

func TestReplayProcessTransportCompleteUnitYieldsForSyntheticWhileHeld(t *testing.T) {
	request := func(value string) processCassetteChunk {
		return processCassetteChunk{
			Kind: "outbound",
			Data: base64.StdEncoding.EncodeToString([]byte(value + "\n")),
		}
	}
	stdout := func(value string) processCassetteChunk {
		return processCassetteChunk{
			Kind: "stdout",
			Data: base64.StdEncoding.EncodeToString([]byte(value + "\n")),
		}
	}
	replay := replayProcessTransportWithChunksForTest(t, []replayConnectionChunksForTest{{
		spec: ProcessSpec{Provider: ProviderCodex, AgentSessionID: "session-1"},
		chunks: []processCassetteChunk{
			request(`{"id":1,"method":"initialize"}`),
			stdout(`{"id":1,"result":{}}`),
			stdout(`{"method":"turn/started","params":{"turn":{"id":"turn-1"}}}`),
		},
	}})
	connection, err := replay.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex, AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	replayConn, ok := connection.(*replayProcessConnection)
	if !ok {
		t.Fatal("connection is not replayProcessConnection")
	}
	if err := connection.Send([]byte("{\"id\":1,\"method\":\"initialize\"}\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Recv(); err != nil {
		t.Fatal(err)
	}
	frame, err := connection.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(frame.Stdout), "turn/started") {
		t.Fatalf("stdout = %q, want turn/started", frame.Stdout)
	}
	if err := replay.SetReplayProviderCursor([]sessionreplay.ProviderUnitPosition{{
		ConnectionID: frame.ConnectionID,
		ChunkSeq:     frame.ChunkSeq,
		UnitIndex:    1,
	}}); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		done <- replayConn.CompleteProviderInputUnit(context.Background(), ProviderInputUnit{
			Position: sessionreplay.ProviderUnitPosition{
				ConnectionID: frame.ConnectionID,
				ChunkSeq:     frame.ChunkSeq,
				UnitIndex:    1,
			},
			Kind: sessionreplay.ProviderInputUnitProtocolMessage,
		})
	}()
	time.Sleep(20 * time.Millisecond)
	if err := connection.Send([]byte(
		`{"id":42,"method":"thread/goal/get","params":{"threadId":"thread-1"}}` + "\n",
	)); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, errReplaySyntheticPending) {
			t.Fatalf("CompleteProviderInputUnit error = %v, want synthetic pending", err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("CompleteProviderInputUnit did not yield for synthetic optional probe")
	}
	synthetic, err := connection.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(synthetic.Stdout), `"id":42`) {
		t.Fatalf("synthetic stdout = %q, want id=42", synthetic.Stdout)
	}
	replay.ClearReplayProviderCursor()
}

func TestReplayProcessTransportAbsorbsExtraOptionalProbeAfterCassetteEnd(t *testing.T) {
	request := func(value string) processCassetteChunk {
		return processCassetteChunk{
			Kind: "outbound",
			Data: base64.StdEncoding.EncodeToString([]byte(value + "\n")),
		}
	}
	stdout := func(value string) processCassetteChunk {
		return processCassetteChunk{
			Kind: "stdout",
			Data: base64.StdEncoding.EncodeToString([]byte(value + "\n")),
		}
	}
	replay := replayProcessTransportWithChunksForTest(t, []replayConnectionChunksForTest{{
		spec: ProcessSpec{Provider: ProviderCodex, AgentSessionID: "session-1"},
		chunks: []processCassetteChunk{
			request(`{"id":1,"method":"initialize"}`),
			stdout(`{"id":1,"result":{}}`),
			request(`{"id":2,"method":"thread/read","params":{"threadId":"child-1"}}`),
			stdout(`{"id":2,"result":{"thread":{"nickname":"helper"}}}`),
		},
	}})
	connection, err := replay.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex, AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Send([]byte("{\"id\":1,\"method\":\"initialize\"}\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Recv(); err != nil {
		t.Fatal(err)
	}
	if err := connection.Send([]byte(
		"{\"id\":2,\"method\":\"thread/read\",\"params\":{\"threadId\":\"child-1\"}}\n",
	)); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Recv(); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int{12, 13, 14} {
		if err := connection.Send([]byte(fmt.Sprintf(
			`{"id":%d,"method":"thread/read","params":{"threadId":"child-1"}}`+"\n",
			id,
		))); err != nil {
			t.Fatalf("extra thread/read id=%d error = %v", id, err)
		}
	}
	if state := replay.ReplayPlaybackState(); !state.Drained {
		t.Fatalf("playback state = %#v, want drained after absorbed probes", state)
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
	if err := transport.Arm("session-1", "recording-1", directory); err != nil {
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
	checkpoint, ok := replayConnection.(ProcessCassetteCheckpointConnection)
	if !ok ||
		checkpoint.ProcessCassetteCaptureOrigin() != ProcessCassetteCaptureOriginProcessStart {
		t.Fatalf(
			"capture origin = %q, want %q",
			processCassetteCaptureOrigin(replayConnection),
			ProcessCassetteCaptureOriginProcessStart,
		)
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

func TestSessionRecordingProcessTransportKeepsInputUnitRecordingGeneration(
	t *testing.T,
) {
	baseConnection := &cassetteTestConnection{
		received: []ProcessFrame{{Stdout: []byte("{\"method\":\"turn/started\"}\n")}},
	}
	transport, err := NewSessionRecordingProcessTransport(
		cassetteTestTransport{connection: baseConnection},
	)
	if err != nil {
		t.Fatal(err)
	}
	var received ProviderInputUnit
	transport.SetProviderInputUnitSink(func(unit ProviderInputUnit) error {
		received = unit
		return nil
	})
	if err := transport.Arm(
		"session-1",
		"recording-1",
		t.TempDir(),
	); err != nil {
		t.Fatal(err)
	}
	connection, err := transport.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex, AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	frame, err := connection.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if frame.RecordingID != "recording-1" {
		t.Fatalf("frame recording ID = %q", frame.RecordingID)
	}
	if err := transport.Cancel("session-1"); err != nil {
		t.Fatal(err)
	}
	if err := transport.Arm(
		"session-1",
		"recording-2",
		t.TempDir(),
	); err != nil {
		t.Fatal(err)
	}
	unit := providerInputUnit(
		frame,
		1,
		sessionreplay.ProviderInputUnitProtocolMessage,
	)
	if err := connection.(ProviderInputUnitCompletion).
		CompleteProviderInputUnit(context.Background(), unit); err != nil {
		t.Fatal(err)
	}
	if received.RecordingID != "recording-1" {
		t.Fatalf("delayed unit recording ID = %q", received.RecordingID)
	}
	if err := transport.Cancel("session-1"); err != nil {
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
	if err := transport.Arm("root-session", "recording-1", directory); err != nil {
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
	if err := transport.Arm("existing-session", "recording-1", directory); err != nil {
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
	checkpoint, ok := replayed.(ProcessCassetteCheckpointConnection)
	if !ok ||
		checkpoint.ProcessCassetteCaptureOrigin() != ProcessCassetteCaptureOriginAttachedLiveConnection {
		t.Fatalf(
			"capture origin = %q, want %q",
			processCassetteCaptureOrigin(replayed),
			ProcessCassetteCaptureOriginAttachedLiveConnection,
		)
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
	if err := transport.Arm("session-1", "recording-1", t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if err := transport.Arm("session-2", "recording-2", t.TempDir()); !errors.Is(err, ErrSessionRecordingBusy) {
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

func TestNilSessionRecordingProcessTransportIgnoresInputUnitSink(t *testing.T) {
	var transport *SessionRecordingProcessTransport
	transport.SetProviderInputUnitSink(func(ProviderInputUnit) error {
		t.Fatal("nil recording transport invoked input unit sink")
		return nil
	})
}

func TestReplayProcessTransportRejectsIncompleteCassette(t *testing.T) {
	directory := recordCassetteForTestWithoutFinalize(t)
	_, err := NewReplayProcessTransport(directory)
	if err == nil || !strings.Contains(err.Error(), "want complete") {
		t.Fatalf("NewReplayProcessTransport() error = %v, want incomplete rejection", err)
	}
}

func TestReplayProcessTransportRejectsMissingProjectionVersion(t *testing.T) {
	directory := recordCassetteForTest(t, []byte("recorded\n"))
	manifestPath := filepath.Join(directory, processCassetteManifestName)
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest ProcessCassetteManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.ProjectionVersion = 0
	raw, err = json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifestPath, append(raw, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = NewReplayProcessTransport(directory)
	if err == nil || !strings.Contains(err.Error(), "projection version 0") {
		t.Fatalf("NewReplayProcessTransport() error = %v, want projection version rejection", err)
	}
}

func TestReplayProcessTransportRejectsMissingCaptureOrigin(t *testing.T) {
	directory := t.TempDir()
	writer, err := newProcessCassetteWriter(directory)
	if err != nil {
		t.Fatal(err)
	}
	connectionID, err := writer.start(
		ProcessSpec{Provider: ProviderCodex, AgentSessionID: "session-1"},
		ProcessCassetteCaptureOriginProcessStart,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.append(processCassetteChunk{
		ConnectionID: connectionID,
		ChunkSeq:     1,
		Kind:         "outbound",
		Data:         base64.StdEncoding.EncodeToString([]byte("initialize")),
	}); err != nil {
		t.Fatal(err)
	}
	if err := writer.finishConnection(); err != nil {
		t.Fatal(err)
	}
	if err := writer.finalize(); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(directory, processCassetteManifestName)
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest ProcessCassetteManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Connections[0].CaptureOrigin = ""
	raw, err = json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifestPath, append(raw, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = NewReplayProcessTransport(directory)
	if err == nil || !strings.Contains(err.Error(), "capture origin") {
		t.Fatalf("NewReplayProcessTransport() error = %v, want capture-origin rejection", err)
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
	}, ProcessCassetteCaptureOriginProcessStart)
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
		connectionID, err := writer.start(
			connection.spec,
			ProcessCassetteCaptureOriginProcessStart,
		)
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
