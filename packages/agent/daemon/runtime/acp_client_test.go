package agentruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	sessionreplay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

func TestACPClientCallSerializesConcurrentRequests(t *testing.T) {
	t.Parallel()

	firstSent := make(chan int64, 1)
	secondSent := make(chan int64, 1)
	releaseResponses := make(chan struct{})
	var sendCount int
	var sendMu sync.Mutex

	client := &acpClient{
		pending: make(map[int64]*acpPendingCall),
		done:    make(chan struct{}),
	}
	client.conn = acpClientTestConnection{
		send: func(data []byte) error {
			var request struct {
				ID int64 `json:"id"`
			}
			if err := json.Unmarshal(bytes.TrimSpace(data), &request); err != nil {
				return err
			}

			sendMu.Lock()
			sendCount++
			count := sendCount
			sendMu.Unlock()

			switch count {
			case 1:
				firstSent <- request.ID
			case 2:
				secondSent <- request.ID
			}

			go func(id int64) {
				<-releaseResponses
				client.dispatchMessage(acpMessage{
					JSONRPC: "2.0",
					ID:      json.RawMessage(strconv.FormatInt(id, 10)),
					Result:  json.RawMessage(`{}`),
				})
			}(request.ID)
			return nil
		},
	}

	errCh := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			_, err := client.Call(context.Background(), "test/method", nil, nil)
			errCh <- err
		}()
	}

	select {
	case <-firstSent:
	case <-time.After(time.Second):
		t.Fatal("first ACP request was not sent")
	}

	select {
	case <-secondSent:
		t.Fatal("second ACP request was sent before the first call completed")
	case <-time.After(50 * time.Millisecond):
	}

	close(releaseResponses)

	for i := 0; i < 2; i++ {
		select {
		case err := <-errCh:
			if err != nil {
				t.Fatalf("ACP call failed: %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("ACP call did not finish")
		}
	}
}

func TestACPClientCallWithTimeoutStartsAfterQueuedCall(t *testing.T) {
	t.Parallel()

	firstSent := make(chan int64, 1)
	secondSent := make(chan int64, 1)
	releaseFirst := make(chan struct{})
	var sendCount int
	var sendMu sync.Mutex

	client := &acpClient{
		pending: make(map[int64]*acpPendingCall),
		done:    make(chan struct{}),
	}
	client.conn = acpClientTestConnection{
		send: func(data []byte) error {
			var request struct {
				ID int64 `json:"id"`
			}
			if err := json.Unmarshal(bytes.TrimSpace(data), &request); err != nil {
				return err
			}

			sendMu.Lock()
			sendCount++
			count := sendCount
			sendMu.Unlock()

			switch count {
			case 1:
				firstSent <- request.ID
				go func(id int64) {
					<-releaseFirst
					client.dispatchMessage(acpMessage{
						JSONRPC: "2.0",
						ID:      json.RawMessage(strconv.FormatInt(id, 10)),
						Result:  json.RawMessage(`{}`),
					})
				}(request.ID)
			case 2:
				secondSent <- request.ID
				go client.dispatchMessage(acpMessage{
					JSONRPC: "2.0",
					ID:      json.RawMessage(strconv.FormatInt(request.ID, 10)),
					Result:  json.RawMessage(`{}`),
				})
			}
			return nil
		},
	}

	firstErr := make(chan error, 1)
	go func() {
		_, err := client.Call(context.Background(), "session/prompt", nil, nil)
		firstErr <- err
	}()

	select {
	case <-firstSent:
	case <-time.After(time.Second):
		t.Fatal("first ACP request was not sent")
	}

	secondErr := make(chan error, 1)
	go func() {
		_, err := client.CallWithTimeout(context.Background(), 20*time.Millisecond, "session/set_mode", nil, nil)
		secondErr <- err
	}()

	select {
	case err := <-secondErr:
		t.Fatalf("queued timeout call returned before first call completed: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	close(releaseFirst)

	select {
	case err := <-firstErr:
		if err != nil {
			t.Fatalf("first ACP call failed: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("first ACP call did not finish")
	}

	select {
	case <-secondSent:
	case <-time.After(time.Second):
		t.Fatal("second ACP request was not sent after first call completed")
	}
	select {
	case err := <-secondErr:
		if err != nil {
			t.Fatalf("queued timeout call failed after it was sent: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("second ACP call did not finish")
	}
}

func TestACPClientLateResultRemainsRecoverableUntilClientCloses(t *testing.T) {
	t.Parallel()

	requestSent := make(chan int64, 1)
	client := &acpClient{
		pending: make(map[int64]*acpPendingCall),
		done:    make(chan struct{}),
	}
	client.conn = acpClientTestConnection{
		send: func(data []byte) error {
			var request struct {
				ID int64 `json:"id"`
			}
			if err := json.Unmarshal(bytes.TrimSpace(data), &request); err != nil {
				return err
			}
			requestSent <- request.ID
			return nil
		},
	}

	lateResult := make(chan string, 1)
	_, err := client.CallNoHandlerWithLateResult(
		context.Background(),
		5*time.Millisecond,
		"resource/create",
		nil,
		func(result json.RawMessage) {
			lateResult <- string(result)
		},
	)
	if err == nil {
		t.Fatal("late-result call unexpectedly completed before timeout")
	}
	var requestID int64
	select {
	case requestID = <-requestSent:
	case <-time.After(time.Second):
		t.Fatal("request was not sent")
	}

	// Exceed the former one-timeout late window. Resource-creating calls must
	// still reconcile their response for as long as the client is alive.
	time.Sleep(20 * time.Millisecond)
	client.dispatchMessage(acpMessage{
		JSONRPC: "2.0",
		ID:      json.RawMessage(strconv.FormatInt(requestID, 10)),
		Result:  json.RawMessage(`{"id":"resource-1"}`),
	})
	select {
	case result := <-lateResult:
		if result != `{"id":"resource-1"}` {
			t.Fatalf("late result = %s", result)
		}
	case <-time.After(time.Second):
		t.Fatal("late result was forgotten while client remained alive")
	}
}

func TestACPClientDispatchesNotificationWithoutActiveCall(t *testing.T) {
	t.Parallel()

	received := make(chan acpMessage, 1)
	client := &acpClient{
		pending: make(map[int64]*acpPendingCall),
		done:    make(chan struct{}),
	}
	client.SetMessageHandler(func(_ context.Context, message acpMessage) error {
		received <- message
		return nil
	})

	client.dispatchMessage(acpMessage{
		JSONRPC: "2.0",
		Method:  acpMethodUpdate,
		Params:  json.RawMessage(`{"update":{"sessionUpdate":"available_commands_update","commands":["web"]}}`),
	})

	select {
	case message := <-received:
		if message.Method != acpMethodUpdate {
			t.Fatalf("method = %q, want %q", message.Method, acpMethodUpdate)
		}
	case <-time.After(time.Second):
		t.Fatal("idle notification was not dispatched")
	}
}

func TestACPClientDispatchLineIgnoresEmptyStdoutLine(t *testing.T) {
	t.Parallel()

	client := newTestACPClientForDispatchLine()
	client.dispatchLine([]byte("  \t  "))
	assertACPClientNotDone(t, client)
}

func TestACPClientDispatchLineIgnoresBenignProviderStdoutLogs(t *testing.T) {
	t.Parallel()

	client := newTestACPClientForDispatchLine()
	client.dispatchLine([]byte("WARNING: provider emitted a startup banner"))
	client.dispatchLine([]byte("Codex App Server ready"))
	assertACPClientNotDone(t, client)
}

func TestACPClientDispatchLineToleratesIsolatedNonObjectJSON(t *testing.T) {
	t.Parallel()

	received := make(chan acpMessage, 1)
	client := newTestACPClientForDispatchLine()
	client.SetMessageHandler(func(_ context.Context, message acpMessage) error {
		received <- message
		return nil
	})

	client.dispatchLine([]byte(`"provider banner encoded as json string"`))
	assertACPClientNotDone(t, client)

	client.dispatchLine([]byte(`{"jsonrpc":"2.0","method":"session/update","params":{"ok":true}}`))
	select {
	case message := <-received:
		if message.Method != "session/update" {
			t.Fatalf("method = %q, want session/update", message.Method)
		}
	case <-time.After(time.Second):
		t.Fatal("valid ACP message after non-object JSON was not dispatched")
	}
	assertACPClientNotDone(t, client)
}

func TestACPClientDispatchLineFinishesAfterConsecutiveProtocolErrorsWithOutputTails(t *testing.T) {
	t.Parallel()

	client := newTestACPClientForDispatchLine()
	client.setStdoutTail([]byte("WARNING: first line\n{broken"))
	client.setStderrTail([]byte("provider stderr tail"))

	for i := 1; i < acpClientStdoutProtocolErrorLimit; i++ {
		client.dispatchLine([]byte("{broken"))
		assertACPClientNotDone(t, client)
	}

	client.dispatchLine([]byte("{broken"))
	select {
	case <-client.Done():
	case <-time.After(time.Second):
		t.Fatal("client did not finish after consecutive malformed ACP stdout lines")
	}

	err := client.Err()
	if err == nil {
		t.Fatal("Err() = nil, want protocol error")
	}
	message := err.Error()
	for _, want := range []string{
		"invalid acp stdout protocol",
		"stdout tail: WARNING: first line",
		"stderr tail: provider stderr tail",
	} {
		if !strings.Contains(message, want) {
			t.Fatalf("Err() = %q, missing %q", message, want)
		}
	}

	diag := client.Diagnostics()
	if !strings.Contains(diag.StdoutTail, "WARNING: first line") {
		t.Fatalf("StdoutTail = %q, want retained stdout tail", diag.StdoutTail)
	}
	if diag.StderrTail != "provider stderr tail" {
		t.Fatalf("StderrTail = %q, want provider stderr tail", diag.StderrTail)
	}
}

func TestACPClientCompletesTwoProtocolUnitsFromOneFrame(t *testing.T) {
	t.Parallel()

	connection := &inputUnitTestConnection{
		frames: []ProcessFrame{{
			ConnectionID: "connection-1",
			ChunkSeq:     7,
			Stdout: []byte(
				"{\"jsonrpc\":\"2.0\",\"method\":\"first\"}\n" +
					"{\"jsonrpc\":\"2.0\",\"method\":\"second\"}\n",
			),
		}},
	}
	client := newACPClientWithStderrMessageMapper(connection, nil)
	client.SetMessageHandler(func(context.Context, acpMessage) error { return nil })
	<-client.Done()

	if len(connection.units) != 2 {
		t.Fatalf("input units = %#v, want 2", connection.units)
	}
	for index, unit := range connection.units {
		if unit.Kind != sessionreplay.ProviderInputUnitProtocolMessage ||
			unit.Position.ConnectionID != "connection-1" ||
			unit.Position.ChunkSeq != 7 ||
			unit.Position.UnitIndex != uint64(index+1) {
			t.Fatalf("input unit %d = %#v", index, unit)
		}
	}
}

func TestACPClientCompletesMappedStderrAndProcessExitUnits(t *testing.T) {
	t.Parallel()

	exitCode := 9
	connection := &inputUnitTestConnection{
		frames: []ProcessFrame{
			{
				ConnectionID: "connection-2",
				ChunkSeq:     3,
				Stderr:       []byte("mapped"),
			},
			{
				ConnectionID: "connection-2",
				ChunkSeq:     4,
				ExitCode:     &exitCode,
			},
		},
	}
	client := newACPClientWithStderrMessageMapper(
		connection,
		func([]byte) (acpMessage, bool) {
			return acpMessage{JSONRPC: "2.0", Method: "mapped"}, true
		},
	)
	client.SetMessageHandler(func(context.Context, acpMessage) error { return nil })
	<-client.Done()

	if len(connection.units) != 2 {
		t.Fatalf("input units = %#v, want 2", connection.units)
	}
	if connection.units[0].Kind != sessionreplay.ProviderInputUnitMappedStderr ||
		connection.units[0].Position.ChunkSeq != 3 ||
		connection.units[1].Kind != sessionreplay.ProviderInputUnitProcessExit ||
		connection.units[1].Position.ChunkSeq != 4 {
		t.Fatalf("input units = %#v", connection.units)
	}
	exitUnit, ok := providerInputUnitFromError(client.Err())
	if !ok ||
		exitUnit.Kind != sessionreplay.ProviderInputUnitProcessExit ||
		exitUnit.Position.ConnectionID != "connection-2" ||
		exitUnit.Position.ChunkSeq != 4 ||
		exitUnit.Position.UnitIndex != 1 {
		t.Fatalf("process exit error unit = %#v, ok=%v", exitUnit, ok)
	}
}

func newTestACPClientForDispatchLine() *acpClient {
	return &acpClient{
		pending: make(map[int64]*acpPendingCall),
		done:    make(chan struct{}),
	}
}

func assertACPClientNotDone(t *testing.T, client *acpClient) {
	t.Helper()
	select {
	case <-client.Done():
		t.Fatalf("client finished unexpectedly: %v", client.Err())
	default:
	}
}

type acpClientTestConnection struct {
	send func([]byte) error
}

type inputUnitTestConnection struct {
	mu     sync.Mutex
	frames []ProcessFrame
	units  []ProviderInputUnit
}

func (*inputUnitTestConnection) Send([]byte) error { return nil }

func (c *inputUnitTestConnection) Recv() (ProcessFrame, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.frames) == 0 {
		return ProcessFrame{}, io.EOF
	}
	frame := c.frames[0]
	c.frames = c.frames[1:]
	return frame, nil
}

func (*inputUnitTestConnection) Close() error { return nil }

func (c *inputUnitTestConnection) CompleteProviderInputUnit(
	_ context.Context,
	unit ProviderInputUnit,
) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.units = append(c.units, unit)
	return nil
}

func (c acpClientTestConnection) Send(data []byte) error {
	if c.send != nil {
		return c.send(data)
	}
	return nil
}

func (acpClientTestConnection) Recv() (ProcessFrame, error) {
	return ProcessFrame{}, io.EOF
}

func (acpClientTestConnection) Close() error {
	return nil
}

func TestAcpTextContentSingleAndArrayBlocks(t *testing.T) {
	t.Parallel()

	if got := acpTextContent(map[string]any{"type": "text", "text": "hi"}); got != "hi" {
		t.Fatalf("single block = %q", got)
	}
	arr := []any{
		map[string]any{"type": "text", "text": "a"},
		map[string]any{"type": "text", "text": "b"},
	}
	if got := acpTextContent(arr); got != "ab" {
		t.Fatalf("array blocks = %q", got)
	}
	if got := acpTextContent(map[string]any{"type": "image"}); got != "" {
		t.Fatalf("non-text = %q", got)
	}
}

func TestAcpTextContentDoesNotInsertNewlinesBetweenAdjacentTextBlocks(t *testing.T) {
	t.Parallel()

	content := []any{
		map[string]any{"type": "text", "text": "现在可直接访问：`http://"},
		map[string]any{"type": "text", "text": "0.0.0.0:4173`"},
	}

	if got := acpTextContent(content); got != "现在可直接访问：`http://0.0.0.0:4173`" {
		t.Fatalf("adjacent text blocks = %q", got)
	}
}
