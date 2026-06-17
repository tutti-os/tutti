package browser

import (
	"context"
	"encoding/json"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agentactivity/daemon/runtime"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

// scriptedConn fakes an MCP server over the process connection: it answers
// initialize, and on tools/call it first sends a server-initiated
// elicitation/create request (to exercise the client's auto-accept) and then
// the tool result.
type scriptedConn struct {
	mu     sync.Mutex
	frames chan agentruntime.ProcessFrame
	sent   []map[string]any
}

func newScriptedConn() *scriptedConn {
	return &scriptedConn{frames: make(chan agentruntime.ProcessFrame, 16)}
}

func (c *scriptedConn) push(v map[string]any) {
	data, _ := json.Marshal(v)
	c.frames <- agentruntime.ProcessFrame{Stdout: append(data, '\n')}
}

func (c *scriptedConn) Send(data []byte) error {
	var msg map[string]any
	if err := json.Unmarshal(data, &msg); err != nil {
		return err
	}
	c.mu.Lock()
	c.sent = append(c.sent, msg)
	c.mu.Unlock()

	method, _ := msg["method"].(string)
	id := msg["id"]
	switch method {
	case "initialize":
		c.push(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
			"protocolVersion": mcpProtocolVersion, "capabilities": map[string]any{},
		}})
	case "tools/call":
		// Server asks the client to elicit; the client must auto-accept.
		c.push(map[string]any{"jsonrpc": "2.0", "id": 999, "method": "elicitation/create", "params": map[string]any{}})
		c.push(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
			"isError": false,
			"content": []map[string]any{{"type": "text", "text": "Successfully navigated to https://example.com"}},
		}})
	}
	return nil
}

func (c *scriptedConn) Recv() (agentruntime.ProcessFrame, error) {
	frame, ok := <-c.frames
	if !ok {
		return agentruntime.ProcessFrame{}, context.Canceled
	}
	return frame, nil
}

func (c *scriptedConn) Close() error { close(c.frames); return nil }

func (c *scriptedConn) sentMessages() []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]map[string]any(nil), c.sent...)
}

type scriptedTransport struct {
	mu       sync.Mutex
	conns    []*scriptedConn
	specs    []agentruntime.ProcessSpec
	startCnt int
}

func (t *scriptedTransport) Start(_ context.Context, spec agentruntime.ProcessSpec) (agentruntime.ProcessConnection, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.startCnt++
	t.specs = append(t.specs, spec)
	conn := newScriptedConn()
	t.conns = append(t.conns, conn)
	return conn, nil
}

func newTestService(transport agentruntime.ProcessTransport) *Service {
	svc := &Service{transport: transport, idleTTL: time.Hour, sessions: make(map[string]*browserSession)}
	svc.autoConnectPreflight = func() error { return nil }
	return svc
}

func TestCallToolNavigatesAndAutoAcceptsElicitation(t *testing.T) {
	transport := &scriptedTransport{}
	svc := newTestService(transport)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	res, err := svc.CallTool(ctx, "ws-1", "/tmp", "navigate_page", map[string]any{"url": "https://example.com"})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if !strings.Contains(res.Text, "Successfully navigated") {
		t.Fatalf("unexpected result text: %q", res.Text)
	}

	// The client must have auto-accepted the elicitation request (id 999).
	var accepted bool
	for _, msg := range transport.conns[0].sentMessages() {
		if _, isReq := msg["method"]; isReq {
			continue
		}
		if idOf(msg["id"]) == 999 {
			result, _ := msg["result"].(map[string]any)
			if result != nil && result["action"] == "accept" {
				accepted = true
			}
		}
	}
	if !accepted {
		t.Fatal("expected the client to auto-accept the elicitation/create request")
	}
}

func TestCallToolReusesSession(t *testing.T) {
	transport := &scriptedTransport{}
	svc := newTestService(transport)
	ctx := context.Background()

	for i := 0; i < 2; i++ {
		if _, err := svc.CallTool(ctx, "ws-1", "", "navigate_page", map[string]any{"url": "https://example.com"}); err != nil {
			t.Fatalf("CallTool #%d: %v", i, err)
		}
	}
	if transport.startCnt != 1 {
		t.Fatalf("expected the subprocess to start once and be reused, got %d starts", transport.startCnt)
	}

	// A different workspace gets its own subprocess.
	if _, err := svc.CallTool(ctx, "ws-2", "", "navigate_page", map[string]any{"url": "https://example.com"}); err != nil {
		t.Fatalf("CallTool ws-2: %v", err)
	}
	if transport.startCnt != 2 {
		t.Fatalf("expected a second subprocess for ws-2, got %d starts", transport.startCnt)
	}
}

func TestCallToolUsesAutoConnectWhenDesktopPreferenceReusesChrome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	transport := &scriptedTransport{}
	svc := newTestService(transport)
	svc.preferences = staticPreferencesReader{
		preferences: preferencesbiz.DesktopPreferences{
			BrowserUseConnectionMode: "autoConnect",
		},
	}
	ctx := context.Background()

	if _, err := svc.CallTool(ctx, "ws-1", "", "list_pages", nil); err != nil {
		t.Fatalf("CallTool: %v", err)
	}

	if len(transport.specs) != 1 {
		t.Fatalf("started specs len = %d, want 1", len(transport.specs))
	}
	command := transport.specs[0].Command
	if !slices.Contains(command, "--autoConnect") && !slices.Contains(command, "--wsEndpoint") {
		t.Fatalf("command = %#v, want --autoConnect or --wsEndpoint", command)
	}
	if slices.Contains(command, "--isolated") {
		t.Fatalf("command = %#v, did not want --isolated", command)
	}
}

func TestCallToolRestartsSessionWhenConnectionModeChanges(t *testing.T) {
	transport := &scriptedTransport{}
	svc := newTestService(transport)
	prefs := &mutablePreferencesReader{
		preferences: preferencesbiz.DesktopPreferences{
			BrowserUseConnectionMode: "isolated",
		},
	}
	svc.preferences = prefs
	ctx := context.Background()

	if _, err := svc.CallTool(ctx, "ws-1", "", "list_pages", nil); err != nil {
		t.Fatalf("CallTool isolated: %v", err)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("started specs len = %d, want 1", len(transport.specs))
	}
	if !slices.Contains(transport.specs[0].Command, "--isolated") {
		t.Fatalf("first command = %#v, want --isolated", transport.specs[0].Command)
	}

	prefs.setMode("autoConnect")
	if _, err := svc.CallTool(ctx, "ws-1", "", "list_pages", nil); err != nil {
		t.Fatalf("CallTool autoConnect: %v", err)
	}
	if transport.startCnt != 2 {
		t.Fatalf("start count = %d, want 2 after connection mode change", transport.startCnt)
	}
	if !slices.Contains(transport.specs[1].Command, "--autoConnect") && !slices.Contains(transport.specs[1].Command, "--wsEndpoint") {
		t.Fatalf("second command = %#v, want --autoConnect or --wsEndpoint", transport.specs[1].Command)
	}
}

func TestCallToolRestartsAfterProcessExit(t *testing.T) {
	transport := &exitAfterFirstToolTransport{}
	svc := newTestService(transport)
	ctx := context.Background()

	if _, err := svc.CallTool(ctx, "ws-1", "", "list_pages", nil); err != nil {
		t.Fatalf("first CallTool: %v", err)
	}
	if transport.startCnt != 1 {
		t.Fatalf("start count = %d, want 1", transport.startCnt)
	}
	if _, err := svc.CallTool(ctx, "ws-1", "", "list_pages", nil); err != nil {
		t.Fatalf("second CallTool after process exit: %v", err)
	}
	if transport.startCnt != 2 {
		t.Fatalf("start count = %d, want restart after process exit", transport.startCnt)
	}
}

func TestIdleTimerDoesNotShutdownDuringInFlightCall(t *testing.T) {
	transport := &slowToolTransport{}
	svc := newTestService(transport)
	svc.idleTTL = 25 * time.Millisecond
	ctx := context.Background()

	done := make(chan error, 1)
	go func() {
		_, err := svc.CallTool(ctx, "ws-1", "", "list_pages", nil)
		done <- err
	}()

	time.Sleep(60 * time.Millisecond)
	if transport.startCnt != 1 {
		t.Fatalf("start count = %d during in-flight call, want 1", transport.startCnt)
	}
	close(transport.release)
	if err := <-done; err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if transport.startCnt != 1 {
		t.Fatalf("start count = %d after call completed, want 1", transport.startCnt)
	}
}

func idOf(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	}
	return -1
}

type exitAfterFirstToolTransport struct {
	mu       sync.Mutex
	startCnt int
	conn     *exitAfterFirstToolConn
}

func (t *exitAfterFirstToolTransport) Start(_ context.Context, _ agentruntime.ProcessSpec) (agentruntime.ProcessConnection, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.startCnt++
	if t.conn == nil {
		t.conn = newExitAfterFirstToolConn()
	} else {
		t.conn = newExitAfterFirstToolConn()
	}
	return t.conn, nil
}

type exitAfterFirstToolConn struct {
	*scriptedConn
	toolCalls int
}

func newExitAfterFirstToolConn() *exitAfterFirstToolConn {
	return &exitAfterFirstToolConn{scriptedConn: newScriptedConn()}
}

func (c *exitAfterFirstToolConn) Send(data []byte) error {
	var msg map[string]any
	_ = json.Unmarshal(data, &msg)
	method, _ := msg["method"].(string)
	err := c.scriptedConn.Send(data)
	if method == "tools/call" {
		c.toolCalls++
		if c.toolCalls == 1 {
			code := 1
			c.frames <- agentruntime.ProcessFrame{ExitCode: &code}
		}
	}
	return err
}

type slowToolTransport struct {
	mu       sync.Mutex
	startCnt int
	release  chan struct{}
	conn     *slowToolConn
}

func (t *slowToolTransport) Start(_ context.Context, _ agentruntime.ProcessSpec) (agentruntime.ProcessConnection, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.startCnt++
	if t.release == nil {
		t.release = make(chan struct{})
	}
	t.conn = newSlowToolConn(t.release)
	return t.conn, nil
}

type slowToolConn struct {
	*scriptedConn
	release <-chan struct{}
}

func newSlowToolConn(release <-chan struct{}) *slowToolConn {
	return &slowToolConn{scriptedConn: newScriptedConn(), release: release}
}

func (c *slowToolConn) Send(data []byte) error {
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
	case "tools/call":
		<-c.release
		c.push(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
			"isError": false,
			"content": []map[string]any{{"type": "text", "text": "slow ok"}},
		}})
	}
	return nil
}

type staticPreferencesReader struct {
	preferences preferencesbiz.DesktopPreferences
}

func (r staticPreferencesReader) GetDesktopPreferences(context.Context) (preferencesbiz.DesktopPreferences, error) {
	return r.preferences, nil
}

type mutablePreferencesReader struct {
	mu          sync.Mutex
	preferences preferencesbiz.DesktopPreferences
}

func (r *mutablePreferencesReader) GetDesktopPreferences(context.Context) (preferencesbiz.DesktopPreferences, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.preferences, nil
}

func (r *mutablePreferencesReader) setMode(mode string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.preferences.BrowserUseConnectionMode = mode
}

// TestE2ENavigateRealChrome drives a real chrome-devtools-mcp + Chrome through
// the production transport. Skipped unless TUTTI_BROWSER_E2E=1 (slow; needs
// npx + Chrome).
func TestE2ENavigateRealChrome(t *testing.T) {
	if os.Getenv("TUTTI_BROWSER_E2E") != "1" {
		t.Skip("set TUTTI_BROWSER_E2E=1 to run the real-Chrome integration test")
	}
	svc := NewService()
	defer svc.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	res, err := svc.CallTool(ctx, "e2e-ws", "", "navigate_page", map[string]any{"url": "https://example.com"})
	if err != nil {
		t.Fatalf("navigate: %v", err)
	}
	t.Logf("navigate result: %s", res.Text)
	if !strings.Contains(res.Text, "example.com") {
		t.Fatalf("unexpected navigate result: %q", res.Text)
	}
	snap, err := svc.CallTool(ctx, "e2e-ws", "", "take_snapshot", map[string]any{})
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	t.Logf("snapshot (first 200): %s", truncate(snap.Text, 200))
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
