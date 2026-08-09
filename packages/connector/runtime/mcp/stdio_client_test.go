package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
)

type scriptedConnection struct {
	frames chan agentruntime.ProcessFrame
	mu     sync.Mutex
	sent   [][]byte
}

func newScriptedConnection() *scriptedConnection {
	return &scriptedConnection{frames: make(chan agentruntime.ProcessFrame, 16)}
}

func (connection *scriptedConnection) Send(data []byte) error {
	connection.mu.Lock()
	connection.sent = append(connection.sent, append([]byte(nil), data...))
	connection.mu.Unlock()
	return nil
}

func (connection *scriptedConnection) Recv() (agentruntime.ProcessFrame, error) {
	frame, ok := <-connection.frames
	if !ok {
		return agentruntime.ProcessFrame{}, context.Canceled
	}
	return frame, nil
}

func (connection *scriptedConnection) Close() error { close(connection.frames); return nil }

func (connection *scriptedConnection) push(value any) {
	data, _ := json.Marshal(value)
	connection.frames <- agentruntime.ProcessFrame{Stdout: append(data, '\n')}
}

func TestStdioClientDeliversNotificationsAndDeclinesServerRequestsByDefault(t *testing.T) {
	connection := newScriptedConnection()
	notifications := make(chan Notification, 1)
	client, err := NewStdioClient(StdioClientConfig{
		Connection: connection,
		NotificationHandler: func(notification Notification) {
			notifications <- notification
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if client == nil {
		t.Fatal("stdio client was not created")
	}
	connection.push(map[string]any{"jsonrpc": "2.0", "method": "notifications/tools/list_changed", "params": map[string]any{}})
	connection.push(map[string]any{"jsonrpc": "2.0", "id": 42, "method": "elicitation/create", "params": map[string]any{}})

	select {
	case notification := <-notifications:
		if notification.Method != "notifications/tools/list_changed" {
			t.Fatalf("notification = %#v", notification)
		}
	case <-time.After(time.Second):
		t.Fatal("notification was not delivered")
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		connection.mu.Lock()
		sent := append([][]byte(nil), connection.sent...)
		connection.mu.Unlock()
		if len(sent) != 0 {
			var response struct {
				Error *RPCError `json:"error"`
			}
			if err := json.Unmarshal(sent[0], &response); err != nil {
				t.Fatal(err)
			}
			if response.Error == nil || response.Error.Code != -32601 {
				t.Fatalf("response = %s", sent[0])
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("server request response was not sent")
}

func TestStdioClientFailsClosedOnOversizedMessage(t *testing.T) {
	connection := newScriptedConnection()
	client, err := NewStdioClient(StdioClientConfig{Connection: connection, MaxMessageBytes: 16})
	if err != nil {
		t.Fatal(err)
	}
	connection.frames <- agentruntime.ProcessFrame{Stdout: []byte(strings.Repeat("x", 17))}
	deadline := time.Now().Add(time.Second)
	for !client.IsClosed() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if err := client.ClosedError(); err == nil || !strings.Contains(err.Error(), "exceeds limit") {
		t.Fatalf("ClosedError() = %v", err)
	}
}

func TestStdioClientNotificationHandlerCanIssueNestedCall(t *testing.T) {
	connection := newScriptedConnection()
	completed := make(chan error, 1)
	var client *StdioClient
	client, err := NewStdioClient(StdioClientConfig{
		Connection: connection,
		NotificationHandler: func(Notification) {
			_, callErr := client.Call(context.Background(), "tools/list", map[string]any{})
			completed <- callErr
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	connection.push(map[string]any{"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})

	deadline := time.Now().Add(time.Second)
	var request struct {
		ID int64 `json:"id"`
	}
	for time.Now().Before(deadline) {
		connection.mu.Lock()
		sent := append([][]byte(nil), connection.sent...)
		connection.mu.Unlock()
		if len(sent) != 0 {
			if err := json.Unmarshal(sent[0], &request); err != nil {
				t.Fatal(err)
			}
			break
		}
		time.Sleep(time.Millisecond)
	}
	if request.ID == 0 {
		t.Fatal("notification handler did not issue nested call")
	}
	connection.push(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": map[string]any{"tools": []any{}}})
	select {
	case err := <-completed:
		if err != nil {
			t.Fatalf("nested Call: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("nested Call deadlocked the protocol reader")
	}
}
