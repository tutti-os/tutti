package agentruntime

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const codexAppServerStartupTraceFileName = "tutti-codex-appserver-startup.jsonl"

var codexAppServerStartupTraceMu sync.Mutex

type codexAppServerStartupTrace struct {
	startedAt time.Time
	session   Session
	path      string
}

func newCodexAppServerStartupTrace(session Session) *codexAppServerStartupTrace {
	settings := session.SettingsValue()
	trace := &codexAppServerStartupTrace{
		startedAt: time.Now(),
		session:   session,
		path:      codexAppServerStartupTracePath(),
	}
	trace.Log("start.begin", map[string]any{
		"permission_mode_id": session.PermissionModeID,
		"settings_model":     settings.Model,
		"settings_plan_mode": settings.PlanMode,
		"log_path":           trace.path,
	})
	return trace
}

func newCodexAppServerTurnTrace(session Session, turnID string, metadata map[string]any) *codexAppServerStartupTrace {
	settings := session.SettingsValue()
	trace := &codexAppServerStartupTrace{
		startedAt: time.Now(),
		session:   session,
		path:      codexAppServerStartupTracePath(),
	}
	fields := map[string]any{
		"turn_id":            strings.TrimSpace(turnID),
		"permission_mode_id": session.PermissionModeID,
		"settings_model":     settings.Model,
		"settings_plan_mode": settings.PlanMode,
	}
	if clientSubmitID := metadataString(metadata, "clientSubmitId"); clientSubmitID != "" {
		fields["client_submit_id"] = clientSubmitID
	}
	if submittedAt := metadataInt64(metadata, "clientSubmittedAtUnixMs"); submittedAt > 0 {
		fields["client_submitted_at_unix_ms"] = submittedAt
		fields["elapsed_since_client_submit_ms"] = time.Now().UnixMilli() - submittedAt
	}
	trace.Log("turn.begin", fields)
	return trace
}

func codexAppServerStartupTracePath() string {
	return filepath.Join(os.TempDir(), codexAppServerStartupTraceFileName)
}

func (t *codexAppServerStartupTrace) Log(event string, fields map[string]any) {
	if t == nil || t.path == "" {
		return
	}
	record := map[string]any{
		"ts":                  time.Now().Format(time.RFC3339Nano),
		"event":               event,
		"elapsed_ms":          time.Since(t.startedAt).Milliseconds(),
		"provider":            ProviderCodex,
		"room_id":             t.session.RoomID,
		"agent_session_id":    t.session.AgentSessionID,
		"provider_session_id": t.session.ProviderSessionID,
		"cwd":                 t.session.CWD,
	}
	for key, value := range fields {
		record[key] = value
	}
	line, err := json.Marshal(record)
	if err != nil {
		return
	}
	codexAppServerStartupTraceMu.Lock()
	defer codexAppServerStartupTraceMu.Unlock()
	if err := os.MkdirAll(filepath.Dir(t.path), 0o755); err != nil {
		return
	}
	file, err := os.OpenFile(t.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer func() { _ = file.Close() }()
	_, _ = file.Write(append(line, '\n'))
}

func (t *codexAppServerStartupTrace) Finish(err error) {
	fields := map[string]any{}
	if err != nil {
		fields["error"] = err.Error()
		t.Log("start.failed", fields)
		return
	}
	t.Log("start.succeeded", fields)
}

func (t *codexAppServerStartupTrace) LogMessage(method string, hasID bool, paramsSize int) {
	t.Log("message.received", map[string]any{
		"method":      method,
		"has_id":      hasID,
		"params_size": paramsSize,
	})
}

func (t *codexAppServerStartupTrace) LogStderr(chunk []byte) {
	text := strings.TrimSpace(string(chunk))
	if text == "" {
		return
	}
	t.Log("process.stderr", map[string]any{
		"message": truncateACPLogValue(text, 2000),
		"size":    len(chunk),
	})
}

func (t *codexAppServerStartupTrace) Call(
	ctx context.Context,
	client *acpClient,
	timeout time.Duration,
	method string,
	params any,
	handler func(context.Context, acpMessage) error,
) (json.RawMessage, error) {
	t.Log("rpc.begin", map[string]any{
		"method":     method,
		"timeout_ms": timeout.Milliseconds(),
	})
	startedAt := time.Now()
	result, err := client.CallWithTimeout(ctx, timeout, method, params, handler)
	fields := map[string]any{
		"method":      method,
		"duration_ms": time.Since(startedAt).Milliseconds(),
	}
	if result != nil {
		fields["result_size"] = len(result)
	}
	if err != nil {
		fields["error"] = err.Error()
		t.Log("rpc.failed", fields)
		return nil, err
	}
	t.Log("rpc.succeeded", fields)
	return result, nil
}

func (t *codexAppServerStartupTrace) CallNoHandler(
	ctx context.Context,
	client *acpClient,
	timeout time.Duration,
	method string,
	params any,
) (json.RawMessage, error) {
	t.Log("background_rpc.begin", map[string]any{
		"method":     method,
		"timeout_ms": timeout.Milliseconds(),
	})
	startedAt := time.Now()
	result, err := client.CallNoHandlerWithTimeout(ctx, timeout, method, params)
	fields := map[string]any{
		"method":      method,
		"duration_ms": time.Since(startedAt).Milliseconds(),
	}
	if result != nil {
		fields["result_size"] = len(result)
	}
	if err != nil {
		fields["error"] = err.Error()
		t.Log("background_rpc.failed", fields)
		return nil, err
	}
	t.Log("background_rpc.succeeded", fields)
	return result, nil
}

func (t *codexAppServerStartupTrace) TypedCall(
	timeout time.Duration,
	method string,
	call func() (json.RawMessage, error),
) (json.RawMessage, error) {
	return t.logTypedCall("rpc", timeout, method, call)
}

func (t *codexAppServerStartupTrace) TypedCallNoHandler(
	timeout time.Duration,
	method string,
	call func() (json.RawMessage, error),
) (json.RawMessage, error) {
	return t.logTypedCall("background_rpc", timeout, method, call)
}

func (t *codexAppServerStartupTrace) logTypedCall(
	prefix string,
	timeout time.Duration,
	method string,
	call func() (json.RawMessage, error),
) (json.RawMessage, error) {
	t.Log(prefix+".begin", map[string]any{
		"method":     method,
		"timeout_ms": timeout.Milliseconds(),
	})
	startedAt := time.Now()
	result, err := call()
	fields := map[string]any{
		"method":      method,
		"duration_ms": time.Since(startedAt).Milliseconds(),
	}
	if result != nil {
		fields["result_size"] = len(result)
	}
	if err != nil {
		fields["error"] = err.Error()
		t.Log(prefix+".failed", fields)
		return nil, err
	}
	t.Log(prefix+".succeeded", fields)
	return result, nil
}
