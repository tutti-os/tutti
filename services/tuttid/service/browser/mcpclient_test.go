package browser

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agentactivity/daemon/runtime"
)

type lockedScriptedConn struct {
	mu     sync.Mutex
	frames chan agentruntime.ProcessFrame
	sent   [][]byte
}

func newLockedScriptedConn() *lockedScriptedConn {
	return &lockedScriptedConn{frames: make(chan agentruntime.ProcessFrame, 64)}
}

func (c *lockedScriptedConn) push(v map[string]any) {
	data, _ := json.Marshal(v)
	c.frames <- agentruntime.ProcessFrame{Stdout: append(data, '\n')}
}

func (c *lockedScriptedConn) Send(data []byte) error {
	c.mu.Lock()
	c.sent = append(c.sent, append([]byte(nil), data...))
	c.mu.Unlock()

	var msg map[string]any
	if err := json.Unmarshal(data, &msg); err != nil {
		return err
	}
	method, _ := msg["method"].(string)
	id := msg["id"]
	switch method {
	case "initialize":
		c.push(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
			"protocolVersion": mcpProtocolVersion, "capabilities": map[string]any{},
		}})
	case "notifications/initialized":
		return nil
	default:
		c.push(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
			"isError": false,
			"content": []map[string]any{{"type": "text", "text": "ok"}},
		}})
	}
	return nil
}

func (c *lockedScriptedConn) Recv() (agentruntime.ProcessFrame, error) {
	frame, ok := <-c.frames
	if !ok {
		return agentruntime.ProcessFrame{}, context.Canceled
	}
	return frame, nil
}

func (c *lockedScriptedConn) Close() error { close(c.frames); return nil }

func TestMCPClientConcurrentSendUsesWriteLock(t *testing.T) {
	conn := newLockedScriptedConn()
	client := newMCPClient(conn)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = client.call(ctx, "tools/call", map[string]any{"name": "list_pages"})
		}()
	}
	wg.Wait()

	for _, frame := range conn.sent {
		if len(frame) == 0 || frame[len(frame)-1] != '\n' {
			t.Fatalf("corrupt frame without trailing newline: %q", frame)
		}
		var msg map[string]any
		if err := json.Unmarshal(frame[:len(frame)-1], &msg); err != nil {
			t.Fatalf("invalid json frame: %v (%q)", err, frame)
		}
	}
}
