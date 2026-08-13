package agentruntime

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	sessionreplay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

func TestACPClientDrainsSyntheticGoalGetWhileProviderCursorHeld(t *testing.T) {
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
			stdout(`{"id":6,"result":{"rateLimits":{}}}`),
		},
	}})
	connection, err := replay.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex, AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	replayConn := connection.(*replayProcessConnection)
	// Fence turn/started before the read loop can race past it.
	if err := replay.SetReplayProviderCursor([]sessionreplay.ProviderUnitPosition{{
		ConnectionID: replayConn.connectionID,
		ChunkSeq:     3,
		UnitIndex:    1,
	}}); err != nil {
		t.Fatal(err)
	}
	client := newACPClientWithStderrMessageMapper(connection, nil)
	if err := connection.Send([]byte("{\"id\":1,\"method\":\"initialize\"}\n")); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		tail := client.Diagnostics().StdoutTail
		if strings.Contains(tail, "turn/started") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for turn/started in stdout tail: %q", tail)
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Read loop should now be blocked in CompleteProviderInputUnit at chunk 3.
	time.Sleep(50 * time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	result, err := client.CallNoHandler(ctx, "thread/goal/get", map[string]any{
		"threadId": "thread-1",
	})
	if err != nil {
		t.Fatalf("CallNoHandler goal/get error = %v (stdout=%q)", err, client.Diagnostics().StdoutTail)
	}
	if len(result) == 0 {
		t.Fatal("expected non-empty goal/get result")
	}
	replay.ClearReplayProviderCursor()
}

func TestACPClientSyntheticRateLimitsDoesNotRewindProviderCursor(t *testing.T) {
	request := func(seq uint64, value string) processCassetteChunk {
		return processCassetteChunk{
			ChunkSeq: seq,
			Kind:     "outbound",
			Data:     base64.StdEncoding.EncodeToString([]byte(value + "\n")),
		}
	}
	stdout := func(seq uint64, value string) processCassetteChunk {
		return processCassetteChunk{
			ChunkSeq: seq,
			Kind:     "stdout",
			Data:     base64.StdEncoding.EncodeToString([]byte(value + "\n")),
		}
	}
	replay := replayProcessTransportWithChunksForTest(t, []replayConnectionChunksForTest{{
		spec: ProcessSpec{Provider: ProviderCodex, AgentSessionID: "session-1"},
		chunks: []processCassetteChunk{
			request(1, `{"id":1,"method":"initialize"}`),
			stdout(2, `{"id":1,"result":{}}`),
			request(3, `{"id":2,"method":"account/rateLimits/read"}`),
			stdout(4, `{"method":"turn/started","params":{"turn":{"id":"turn-1"}}}`),
			stdout(5, `{"id":2,"result":{"rateLimits":{"limitId":"codex"}}}`),
		},
	}})
	connection, err := replay.Start(context.Background(), ProcessSpec{
		Provider: ProviderCodex, AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	client := newACPClientWithStderrMessageMapper(connection, nil)
	if err := connection.Send([]byte("{\"id\":1,\"method\":\"initialize\"}\n")); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		tail := client.Diagnostics().StdoutTail
		if strings.Contains(tail, `"id":1`) && strings.Contains(tail, `"result"`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for initialize result: %q", tail)
		}
		time.Sleep(10 * time.Millisecond)
	}

	if err := connection.Send([]byte("{\"id\":2,\"method\":\"account/rateLimits/read\"}\n")); err != nil {
		t.Fatal(err)
	}

	deadline = time.Now().Add(2 * time.Second)
	sawRateLimits := false
	for {
		tail := client.Diagnostics().StdoutTail
		if strings.Contains(tail, `"id":2`) && strings.Contains(tail, "rateLimits") {
			sawRateLimits = true
		}
		if sawRateLimits && strings.Contains(tail, "turn/started") {
			return
		}
		if strings.Contains(tail, "position moved backward") ||
			strings.Contains(tail, "checkpoint_provider_overshot") {
			t.Fatalf("provider cursor rewound after synthetic rateLimits: %q", tail)
		}
		if time.Now().After(deadline) {
			t.Fatalf(
				"timed out after synthetic rateLimits (sawRateLimits=%v): %q",
				sawRateLimits,
				tail,
			)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
