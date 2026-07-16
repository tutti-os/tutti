package computer

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
)

type recordedNativeToolCall struct {
	name string
	args map[string]any
}

type adapterRecordingConn struct {
	mu        sync.Mutex
	frames    chan agentruntime.ProcessFrame
	closeOnce sync.Once
	calls     []recordedNativeToolCall
}

func newAdapterRecordingConn() *adapterRecordingConn {
	return &adapterRecordingConn{frames: make(chan agentruntime.ProcessFrame, 8)}
}

func (c *adapterRecordingConn) Send(data []byte) error {
	var message struct {
		ID     any            `json:"id"`
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
	}
	if err := json.Unmarshal(data, &message); err != nil {
		return err
	}
	if message.Method != "tools/call" {
		return nil
	}
	name, _ := message.Params["name"].(string)
	args, _ := message.Params["arguments"].(map[string]any)
	c.mu.Lock()
	c.calls = append(c.calls, recordedNativeToolCall{name: name, args: args})
	c.mu.Unlock()
	response, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      message.ID,
		"result": map[string]any{
			"isError":           false,
			"content":           []map[string]any{{"type": "text", "text": "ok"}},
			"structuredContent": map[string]any{"driver": "kept"},
		},
	})
	if err != nil {
		return err
	}
	c.frames <- agentruntime.ProcessFrame{Stdout: append(response, '\n')}
	return nil
}

func (c *adapterRecordingConn) Recv() (agentruntime.ProcessFrame, error) {
	frame, ok := <-c.frames
	if !ok {
		return agentruntime.ProcessFrame{}, context.Canceled
	}
	return frame, nil
}

func (c *adapterRecordingConn) Close() error {
	c.closeOnce.Do(func() { close(c.frames) })
	return nil
}

func (c *adapterRecordingConn) recordedCalls() []recordedNativeToolCall {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]recordedNativeToolCall(nil), c.calls...)
}

func newAdapterTestSession(t *testing.T) (*computerSession, *adapterRecordingConn) {
	t.Helper()
	conn := newAdapterRecordingConn()
	session := &computerSession{client: newMCPClient(conn)}
	t.Cleanup(func() { _ = conn.Close() })
	return session, conn
}

func TestStableAdapterRejectsUnknownToolInsteadOfFallingThrough(t *testing.T) {
	_, err := (&computerSession{}).adaptToolCall(context.Background(), "kill_app", nil)
	if err == nil || !strings.Contains(err.Error(), "unsupported stable computer tool") {
		t.Fatalf("err = %v", err)
	}
}

func TestStableAdapterExplicitlyRoutesMoveCursor(t *testing.T) {
	_, err := (&computerSession{}).adaptToolCall(context.Background(), "move_cursor", map[string]any{"x": 12, "y": 34})
	if err == nil || strings.Contains(err.Error(), "unsupported stable computer tool") {
		t.Fatalf("err = %v, want routed session-not-started error", err)
	}
}

func TestStableScreenshotAlwaysUsesWindowCapture(t *testing.T) {
	session, conn := newAdapterTestSession(t)

	result, err := session.adaptToolCall(context.Background(), "screenshot", map[string]any{
		"scope": "desktop", "pid": 42, "window_id": 99,
	})
	if err != nil {
		t.Fatalf("adaptToolCall(screenshot): %v", err)
	}
	path, _ := result.StructuredContent["screenshot_file_path"].(string)
	if path == "" {
		t.Fatalf("structured content = %#v, want screenshot_file_path", result.StructuredContent)
	}
	defer os.Remove(path)
	if _, ok := result.StructuredContent["scope"]; ok {
		t.Fatalf("structured content unexpectedly contains synthetic scope: %#v", result.StructuredContent)
	}
	if result.StructuredContent["driver"] != "kept" {
		t.Fatalf("structured content = %#v, want native fields preserved", result.StructuredContent)
	}

	calls := conn.recordedCalls()
	if len(calls) != 1 || calls[0].name != "get_window_state" {
		t.Fatalf("calls = %#v, want one get_window_state call", calls)
	}
	wantFixedArgs := map[string]any{
		"pid":          float64(42),
		"window_id":    float64(99),
		"capture_mode": "vision",
	}
	for key, want := range wantFixedArgs {
		if !reflect.DeepEqual(calls[0].args[key], want) {
			t.Fatalf("get_window_state argument %q = %#v, want %#v", key, calls[0].args[key], want)
		}
	}
	if _, ok := calls[0].args["scope"]; ok {
		t.Fatalf("get_window_state arguments unexpectedly contain scope: %#v", calls[0].args)
	}
}

func TestStableWindowActionsNeverUseDesktopScope(t *testing.T) {
	tests := []struct {
		name string
		tool string
		args map[string]any
		want recordedNativeToolCall
	}{
		{
			name: "click keeps window coordinates",
			tool: "click",
			args: map[string]any{"scope": "desktop", "pid": 42, "window_id": 99, "x": 120, "y": 240},
			want: recordedNativeToolCall{name: "click", args: map[string]any{
				"pid": float64(42), "window_id": float64(99), "x": float64(120), "y": float64(240),
			}},
		},
		{
			name: "scroll keeps targeted pixel wheel coordinates",
			tool: "scroll",
			args: map[string]any{
				"scope": "desktop", "pid": 42, "window_id": 99,
				"x": 120, "y": 240, "direction": "down", "amount": 4,
			},
			want: recordedNativeToolCall{name: "scroll", args: map[string]any{
				"pid": float64(42), "window_id": float64(99),
				"x": float64(120), "y": float64(240), "direction": "down", "amount": float64(4),
			}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			session, conn := newAdapterTestSession(t)
			if _, err := session.adaptToolCall(context.Background(), tt.tool, tt.args); err != nil {
				t.Fatalf("adaptToolCall(%s): %v", tt.tool, err)
			}
			calls := conn.recordedCalls()
			if len(calls) != 1 || !reflect.DeepEqual(calls[0], tt.want) {
				t.Fatalf("calls = %#v, want %#v", calls, []recordedNativeToolCall{tt.want})
			}
		})
	}
}

func TestSplitKeySpec(t *testing.T) {
	tests := []struct {
		in   string
		want []string
	}{
		{"cmd+space", []string{"cmd", "space"}},
		{"cmd+c", []string{"cmd", "c"}},
		{"return", []string{"return"}},
		{"Command+Shift+4", []string{"cmd", "shift", "4"}},
	}
	for _, tc := range tests {
		got := splitKeySpec(tc.in)
		if len(got) != len(tc.want) {
			t.Fatalf("splitKeySpec(%q) = %#v, want %#v", tc.in, got, tc.want)
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Fatalf("splitKeySpec(%q)[%d] = %q, want %q", tc.in, i, got[i], tc.want[i])
			}
		}
	}
}

func TestDecodeStructuredPayload(t *testing.T) {
	payload, err := decodeStructuredPayload[windowStatePayload](`{"screenshot_file_path":"/tmp/test.png"}`)
	if err != nil {
		t.Fatalf("decodeStructuredPayload: %v", err)
	}
	if payload.ScreenshotFilePath != "/tmp/test.png" {
		t.Fatalf("ScreenshotFilePath = %q", payload.ScreenshotFilePath)
	}
}

func TestParseAccessibilityTreeWindows(t *testing.T) {
	text := "Windows:\n- Cua Driver (pid 59271) (no title) [window_id: 22516]\n- Warp (pid 40206) \"Title\" [window_id: 6392]\n"
	windows, err := parseAccessibilityTreeWindows(text)
	if err != nil {
		t.Fatalf("parseAccessibilityTreeWindows: %v", err)
	}
	if len(windows) != 2 {
		t.Fatalf("windows = %d, want 2", len(windows))
	}
	if windows[0].AppName != "Warp" || windows[0].PID != 40206 || windows[0].WindowID != 6392 {
		t.Fatalf("frontmost window = %+v, want Warp 40206/6392", windows[0])
	}
}

func TestSelectAutomationWindowUsesStructuredZOrderAndFiltersDriverWindows(t *testing.T) {
	t.Setenv("TUTTI_DESKTOP_PARENT_PID", "11")
	windows := []windowRecord{
		{PID: 10, WindowID: 100, ZIndex: 100, AppName: "Cua Driver", Title: "Overlay", IsOnScreen: true},
		{PID: 11, WindowID: 101, ZIndex: 90, AppName: "Electron", Title: "Tutti", IsOnScreen: true},
		{PID: 12, WindowID: 102, ZIndex: 80, AppName: "Lark", Title: "Chat", IsOnScreen: true},
		{PID: 13, WindowID: 103, ZIndex: 70, AppName: "Safari", Title: "Off Space", IsOnScreen: false},
	}

	window, err := selectAutomationWindow(windows)
	if err != nil {
		t.Fatalf("selectAutomationWindow: %v", err)
	}
	if window.PID != 12 || window.WindowID != 102 {
		t.Fatalf("window = %#v, want Lark 12/102", window)
	}
}

func TestSelectAutomationWindowKeepsUnrelatedElectronApps(t *testing.T) {
	t.Setenv("TUTTI_DESKTOP_PARENT_PID", "99")
	windows := []windowRecord{
		{PID: 11, WindowID: 101, ZIndex: 90, AppName: "Electron", Title: "VS Code", IsOnScreen: true},
		{PID: 12, WindowID: 102, ZIndex: 80, AppName: "Safari", Title: "Docs", IsOnScreen: true},
	}

	window, err := selectAutomationWindow(windows)
	if err != nil {
		t.Fatalf("selectAutomationWindow: %v", err)
	}
	if window.PID != 11 {
		t.Fatalf("window = %#v, want unrelated Electron pid 11", window)
	}
}

func TestNumericArg(t *testing.T) {
	value, ok := numericArg(map[string]any{"x": "120"}, "x")
	if !ok || value != 120 {
		t.Fatalf("numericArg = (%v, %v)", value, ok)
	}
}
