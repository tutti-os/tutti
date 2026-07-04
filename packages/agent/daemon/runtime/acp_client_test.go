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
