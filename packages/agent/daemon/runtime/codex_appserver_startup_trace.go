package agentruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const codexAppServerStartupTraceFileName = "tutti-codex-appserver-startup.jsonl"
const codexAppServerStartupTraceMaxBytes = 64 * 1024 * 1024

var codexAppServerStartupTraceMu sync.Mutex

var codexAppServerStartupSpanNames = map[string]struct{}{
	"app_server.thread_start.attach_listener": {},
	"app_server.thread_start.config_snapshot": {},
	"app_server.thread_start.create_thread":   {},
	"app_server.thread_start.notify_started":  {},
	"app_server.thread_start.resolve_status":  {},
	"app_server.thread_start.send_response":   {},
	"app_server.thread_start.upsert_thread":   {},
	"session_init":                            {},
	"session_init.auth_mcp":                   {},
	"session_init.mcp_manager_init":           {},
	"session_init.network_proxy":              {},
	"session_init.plugin_skill_warmup":        {},
	"session_init.state_db":                   {},
	"session_init.thread_name_lookup":         {},
	"session_init.thread_persistence":         {},
	"shell_snapshot":                          {},
	"thread_spawn":                            {},
}

const codexAppServerStderrLineLimit = 64 * 1024

type codexAppServerStartupTrace struct {
	startedAt          time.Time
	session            Session
	path               string
	spanObserver       CodexAppServerSpanObserver
	startupObserver    CodexAppServerStartupObserver
	stderrMu           sync.Mutex
	stderrLine         []byte
	openSpans          map[string][]codexAppServerOpenSpan
	spanSequence       atomic.Uint64
	completedSpanCount atomic.Int64
}

type codexAppServerOpenSpan struct {
	instanceID string
	startedAt  time.Time
	timestamp  bool
}

func newCodexAppServerStartupTrace(
	session Session,
	spanObserver CodexAppServerSpanObserver,
	startupObserver CodexAppServerStartupObserver,
) *codexAppServerStartupTrace {
	settings := session.SettingsValue()
	trace := &codexAppServerStartupTrace{
		startedAt:       time.Now(),
		session:         session,
		path:            codexAppServerStartupTracePath(),
		spanObserver:    spanObserver,
		startupObserver: startupObserver,
		openSpans:       make(map[string][]codexAppServerOpenSpan),
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
		openSpans: make(map[string][]codexAppServerOpenSpan),
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
	provider := strings.TrimSpace(t.session.Provider)
	if provider == "" {
		provider = ProviderCodex
	}
	record := map[string]any{
		"ts":                  time.Now().Format(time.RFC3339Nano),
		"event":               event,
		"elapsed_ms":          time.Since(t.startedAt).Milliseconds(),
		"provider":            provider,
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
	if err := appendCodexAppServerStartupTrace(t.path, line, codexAppServerStartupTraceMaxBytes); err != nil {
		return
	}
}

func appendCodexAppServerStartupTrace(path string, line []byte, maxBytes int64) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	if info, err := file.Stat(); err != nil {
		return err
	} else if maxBytes > 0 && info.Size()+int64(len(line)+1) > maxBytes {
		if err := file.Truncate(0); err != nil {
			return err
		}
	}
	_, err = file.Write(append(line, '\n'))
	return err
}

func (t *codexAppServerStartupTrace) Finish(err error) {
	if t == nil {
		return
	}
	outcome := "succeeded"
	fields := map[string]any{}
	if err != nil {
		outcome = "failed"
		fields["error"] = err.Error()
		t.Log("start.failed", fields)
	} else {
		t.Log("start.succeeded", fields)
	}
	t.notifyStartupObserver(CodexAppServerStartupObservation{
		Provider:           strings.TrimSpace(t.session.Provider),
		RoomID:             strings.TrimSpace(t.session.RoomID),
		AgentSessionID:     strings.TrimSpace(t.session.AgentSessionID),
		StartedAt:          t.startedAt.UTC().Format(time.RFC3339Nano),
		Outcome:            outcome,
		DurationMS:         time.Since(t.startedAt).Milliseconds(),
		MCPServerCount:     len(t.session.MCPServers),
		CompletedSpanCount: int(t.completedSpanCount.Load()),
	})
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

	t.stderrMu.Lock()
	observations := make([]CodexAppServerSpanObservation, 0)
	t.stderrLine = append(t.stderrLine, chunk...)
	for {
		line, rest, ok := bytes.Cut(t.stderrLine, []byte("\n"))
		if !ok {
			if len(t.stderrLine) > codexAppServerStderrLineLimit {
				t.stderrLine = append([]byte(nil), t.stderrLine[len(t.stderrLine)-codexAppServerStderrLineLimit:]...)
			}
			break
		}
		t.stderrLine = rest
		if observation := t.logCodexAppServerSpan(line); observation != nil {
			observations = append(observations, *observation)
		}
	}
	t.stderrMu.Unlock()
	for _, observation := range observations {
		t.notifySpanObserver(observation)
	}
}

func withCodexAppServerLogging(env []string) []string {
	env = withoutEnvironmentKeyFold(env, "LOG_FORMAT")
	env = withoutEnvironmentKeyFold(env, "RUST_LOG")
	return append(env, codexAppServerLogFormatEnv, codexAppServerRustLogEnv)
}

func withoutEnvironmentKeyFold(env []string, key string) []string {
	filtered := make([]string, 0, len(env))
	for _, entry := range env {
		candidateKey, _, ok := strings.Cut(entry, "=")
		if ok && strings.EqualFold(candidateKey, key) {
			continue
		}
		filtered = append(filtered, entry)
	}
	return filtered
}

func (t *codexAppServerStartupTrace) logCodexAppServerSpan(line []byte) *CodexAppServerSpanObservation {
	var record struct {
		Timestamp string                       `json:"timestamp"`
		Target    string                       `json:"target"`
		Fields    map[string]json.RawMessage   `json:"fields"`
		Span      map[string]json.RawMessage   `json:"span"`
		Spans     []map[string]json.RawMessage `json:"spans"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(line), &record); err != nil {
		return nil
	}
	spanName := codexJSONLogString(record.Span["name"])
	if spanName == "" {
		for index := len(record.Spans) - 1; index >= 0; index-- {
			spanName = codexJSONLogString(record.Spans[index]["name"])
			if spanName != "" {
				break
			}
		}
	}
	if _, ok := codexAppServerStartupSpanNames[spanName]; !ok {
		return nil
	}
	phase := codexJSONLogString(record.Fields["message"])
	if phase != "new" && phase != "close" {
		return nil
	}
	startedAt, parseErr := time.Parse(time.RFC3339Nano, record.Timestamp)
	timestampOK := parseErr == nil
	fields := map[string]any{
		"span_name":  spanName,
		"span_phase": phase,
	}
	var observation *CodexAppServerSpanObservation
	spanInstanceID := ""
	if record.Target != "" {
		fields["span_target"] = record.Target
	}
	if record.Timestamp != "" {
		fields["codex_timestamp"] = record.Timestamp
	}
	if phase == "new" {
		spanInstanceID = t.newSpanInstanceID()
		t.openSpans[spanName] = append(t.openSpans[spanName], codexAppServerOpenSpan{
			instanceID: spanInstanceID,
			startedAt:  startedAt,
			timestamp:  timestampOK,
		})
		fields["span_instance_id"] = spanInstanceID
		if t.spanObserver != nil {
			observation = &CodexAppServerSpanObservation{
				Provider:       strings.TrimSpace(t.session.Provider),
				RoomID:         strings.TrimSpace(t.session.RoomID),
				AgentSessionID: strings.TrimSpace(t.session.AgentSessionID),
				SpanName:       spanName,
				SpanPhase:      phase,
				SpanInstanceID: spanInstanceID,
				SpanTarget:     strings.TrimSpace(record.Target),
				CodexTimestamp: strings.TrimSpace(record.Timestamp),
			}
		}
	} else if openSpans := t.openSpans[spanName]; len(openSpans) > 0 {
		t.completedSpanCount.Add(1)
		openSpan := openSpans[len(openSpans)-1]
		t.openSpans[spanName] = openSpans[:len(openSpans)-1]
		spanInstanceID = openSpan.instanceID
		fields["span_instance_id"] = spanInstanceID
		durationMS := int64(0)
		if timestampOK && openSpan.timestamp {
			durationMS = startedAt.Sub(openSpan.startedAt).Milliseconds()
			fields["duration_ms"] = durationMS
		}
		if busy := codexJSONLogString(record.Fields["time.busy"]); busy != "" {
			fields["span_busy"] = busy
		}
		if idle := codexJSONLogString(record.Fields["time.idle"]); idle != "" {
			fields["span_idle"] = idle
		}
		if t.spanObserver != nil {
			observation = &CodexAppServerSpanObservation{
				Provider:       strings.TrimSpace(t.session.Provider),
				RoomID:         strings.TrimSpace(t.session.RoomID),
				AgentSessionID: strings.TrimSpace(t.session.AgentSessionID),
				SpanName:       spanName,
				SpanPhase:      phase,
				SpanInstanceID: spanInstanceID,
				SpanTarget:     strings.TrimSpace(record.Target),
				CodexTimestamp: strings.TrimSpace(record.Timestamp),
				DurationMS:     durationMS,
				SpanBusy:       codexJSONLogString(record.Fields["time.busy"]),
				SpanIdle:       codexJSONLogString(record.Fields["time.idle"]),
			}
		}
	}
	t.Log("app_server.span", fields)
	return observation
}

func (t *codexAppServerStartupTrace) newSpanInstanceID() string {
	return fmt.Sprintf("startup-%d-%d", t.startedAt.UnixNano(), t.spanSequence.Add(1))
}

func (t *codexAppServerStartupTrace) notifySpanObserver(observation CodexAppServerSpanObservation) {
	if t.spanObserver == nil {
		return
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			slog.Warn("agent session Codex app-server span observer panicked",
				"provider", observation.Provider,
				"agent_session_id", observation.AgentSessionID,
				"span_name", observation.SpanName,
				"panic", recovered,
			)
		}
	}()
	t.spanObserver(observation)
}

func (t *codexAppServerStartupTrace) notifyStartupObserver(observation CodexAppServerStartupObservation) {
	if t.startupObserver == nil {
		return
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			slog.Warn("agent session Codex app-server startup observer panicked",
				"provider", observation.Provider,
				"agent_session_id", observation.AgentSessionID,
				"outcome", observation.Outcome,
				"panic", recovered,
			)
		}
	}()
	t.startupObserver(observation)
}

func codexJSONLogString(raw json.RawMessage) string {
	var value string
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return strings.TrimSpace(value)
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
