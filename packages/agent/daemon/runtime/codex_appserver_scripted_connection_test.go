package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

type scriptedAppServerTransport struct {
	mu     sync.Mutex
	specs  []ProcessSpec
	conn   *scriptedAppServerConnection
	server *fakeCodexAppServer
}

func newScriptedAppServerTransport() *scriptedAppServerTransport {
	conn, server := newScriptedAppServerHarness()
	return &scriptedAppServerTransport{conn: conn, server: server}
}

func newScriptedAppServerConnection() *scriptedAppServerConnection {
	conn, _ := newScriptedAppServerHarness()
	return conn
}

func newScriptedAppServerHarness() (*scriptedAppServerConnection, *fakeCodexAppServer) {
	conn := &scriptedAppServerConnection{
		recv:   make(chan ProcessFrame, 128),
		closed: make(chan struct{}),
	}
	server := newFakeCodexAppServer(conn, &conn.mu)
	conn.server = server
	return conn, server
}

func (t *scriptedAppServerTransport) Start(_ context.Context, spec ProcessSpec) (ProcessConnection, error) {
	t.mu.Lock()
	t.specs = append(t.specs, spec)
	t.mu.Unlock()
	return t.conn, nil
}

type scriptedAppServerConnection struct {
	mu                   sync.Mutex
	sent                 [][]byte
	recv                 chan ProcessFrame
	closed               chan struct{}
	closeOnce            sync.Once
	closeCount           int
	closeFailures        int
	server               *fakeCodexAppServer
	providerProgressWait func(context.Context, time.Duration) error
}

func (c *scriptedAppServerConnection) WaitForProviderProgress(
	ctx context.Context,
	duration time.Duration,
) error {
	if c.providerProgressWait != nil {
		return c.providerProgressWait(ctx, duration)
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-c.closed:
		return context.Canceled
	case <-timer.C:
		return nil
	}
}

func (c *scriptedAppServerConnection) Send(data []byte) error {
	c.mu.Lock()
	c.sent = append(c.sent, append([]byte(nil), data...))
	c.mu.Unlock()
	return c.server.handle(data)
}

func (c *scriptedAppServerConnection) sendJSON(value map[string]any) {
	c.sendJSONWithWaitSignal(value, nil)
}

// sendJSONBatch mirrors stdio coalescing adjacent JSON-RPC lines into one
// frame, so response/request ordering cannot depend on goroutine scheduling.
func (c *scriptedAppServerConnection) sendJSONBatch(values ...map[string]any) {
	var raw []byte
	for _, value := range values {
		line, err := json.Marshal(value)
		if err != nil {
			return
		}
		raw = append(raw, line...)
		raw = append(raw, '\n')
	}
	select {
	case <-c.closed:
		return
	case c.recv <- ProcessFrame{Stdout: raw}:
	}
}

func (c *scriptedAppServerConnection) sendJSONWithWaitSignal(value map[string]any, waitEntered chan<- struct{}) {
	raw, err := json.Marshal(value)
	if err != nil {
		return
	}
	select {
	case <-c.closed:
		return
	default:
	}
	for {
		select {
		case <-c.closed:
			return
		case c.recv <- ProcessFrame{Stdout: append(raw, '\n')}:
			return
		case waitEntered <- struct{}{}:
			waitEntered = nil
		}
	}
}

func (c *scriptedAppServerConnection) notify(method string, params map[string]any) {
	c.sendJSON(map[string]any{"method": method, "params": params})
}

func (c *scriptedAppServerConnection) Recv() (ProcessFrame, error) {
	return c.recvWithWaitSignal(nil)
}

func (c *scriptedAppServerConnection) recvWithWaitSignal(waitEntered chan<- struct{}) (ProcessFrame, error) {
	select {
	case <-c.closed:
		return ProcessFrame{}, io.EOF
	default:
	}
	for {
		select {
		case <-c.closed:
			return ProcessFrame{}, io.EOF
		case frame := <-c.recv:
			return frame, nil
		case waitEntered <- struct{}{}:
			waitEntered = nil
		}
	}
}

func (c *scriptedAppServerConnection) Close() error {
	c.mu.Lock()
	c.closeCount++
	if c.closeFailures > 0 {
		c.closeFailures--
		c.mu.Unlock()
		return errors.New("injected app-server close failure")
	}
	c.mu.Unlock()
	c.closeOnce.Do(func() { close(c.closed) })
	return nil
}

func TestScriptedAppServerConnectionCloseUnblocksSendAndReceive(t *testing.T) {
	t.Run("send", func(t *testing.T) {
		connection := newScriptedAppServerConnection()
		for index := 0; index < cap(connection.recv); index++ {
			connection.sendJSON(map[string]any{"index": index})
		}
		waitEntered := make(chan struct{})
		sendReturned := make(chan struct{})
		go func() {
			connection.sendJSONWithWaitSignal(map[string]any{"afterBuffer": true}, waitEntered)
			close(sendReturned)
		}()
		<-waitEntered
		if err := connection.Close(); err != nil {
			t.Fatal(err)
		}
		select {
		case <-sendReturned:
		case <-time.After(time.Second):
			t.Fatal("connection close did not unblock a pending scripted send")
		}
	})

	t.Run("receive", func(t *testing.T) {
		connection := newScriptedAppServerConnection()
		waitEntered := make(chan struct{})
		receiveReturned := make(chan error, 1)
		go func() {
			_, err := connection.recvWithWaitSignal(waitEntered)
			receiveReturned <- err
		}()
		<-waitEntered
		if err := connection.Close(); err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-receiveReturned:
			if !errors.Is(err, io.EOF) {
				t.Fatalf("receive after close error = %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("connection close did not unblock a pending scripted receive")
		}
	})
}
