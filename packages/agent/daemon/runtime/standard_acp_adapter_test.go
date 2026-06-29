//nolint:unused // Retain migrated test fixtures until the next agent-daemon decomposition pass.
package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

func TestGeminiAdapterStartCreatesStandardACPSession(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Gemini CLI", "gemini-session-1")
	adapter := NewGeminiAdapter(transport)
	session := standardTestSession(ProviderGemini)
	session.PermissionModeID = "full-access"

	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	spec := transport.specs[0]
	if got := strings.Join(spec.Command, " "); got != "gemini --acp" {
		t.Fatalf("command = %q, want %q", got, "gemini --acp")
	}
	if !containsString(spec.Env, codexAgentRoutingEnv) || !containsString(spec.Env, codexRoutingPreload) {
		t.Fatalf("env = %#v, want standard ACP routing env with preload", spec.Env)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("events = %#v, want session.started", events)
	}
	if events[0].ProviderSessionID != "gemini-session-1" {
		t.Fatalf("provider session id = %q", events[0].ProviderSessionID)
	}
	if transport.conn.lastModeID() != "yolo" {
		t.Fatalf("mode id = %q, want yolo", transport.conn.lastModeID())
	}
	if _, has := transport.conn.lastNewSessionParams["_meta"]; has {
		t.Fatalf("Gemini session/new must not send OpenClaw-only _meta.sessionKey")
	}
	if got := transport.conn.authenticatedMethodID(); got != "gemini-api-key" {
		t.Fatalf("authenticated method id = %q, want gemini-api-key", got)
	}
}

func TestClaudeCodeAdapterStartUsesInjectedProviderCommand(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-managed")
	adapter := newClaudeCodeAdapterWithHostMetadata(
		transport,
		LegacyHostMetadata(),
		func(_ context.Context, provider string) (ProviderCommand, error) {
			if provider != ProviderClaudeCode {
				t.Fatalf("provider = %q, want %q", provider, ProviderClaudeCode)
			}
			return ProviderCommand{
				Command: []string{"/managed/node/bin/npm", "--prefix", "/state/claude-acp", "exec", "--yes", "--", "@agentclientprotocol/claude-agent-acp@0.0.0 - 0.46.0"},
				Env:     []string{"PATH=/managed/node/bin:/usr/bin", "TUTTI_APP_NPM=/managed/node/bin/npm"},
			}, nil
		},
	)
	session := standardTestSession(ProviderClaudeCode)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	spec := transport.specs[0]
	if got := strings.Join(spec.Command, " "); !strings.Contains(got, "/managed/node/bin/npm --prefix /state/claude-acp exec") {
		t.Fatalf("command = %q, want injected managed npm command", got)
	}
	if !containsString(spec.Env, "TUTTI_APP_NPM=/managed/node/bin/npm") {
		t.Fatalf("env = %#v, want injected managed runtime env", spec.Env)
	}
}

func TestGeminiAdapterStartCoercesReadOnlyModeToYolo(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Gemini CLI", "gemini-session-plan")
	adapter := NewGeminiAdapter(transport)
	session := standardTestSession(ProviderGemini)
	session.PermissionModeID = "read-only"

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if transport.conn.lastModeID() != "yolo" {
		t.Fatalf("mode id = %q, want yolo", transport.conn.lastModeID())
	}
}

func TestGeminiAdapterStartCoercesAutoModeToYolo(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Gemini CLI", "gemini-session-auto")
	adapter := NewGeminiAdapter(transport)
	session := standardTestSession(ProviderGemini)
	session.PermissionModeID = "auto"

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if transport.conn.lastModeID() != "yolo" {
		t.Fatalf("mode id = %q, want yolo", transport.conn.lastModeID())
	}
}

func TestGeminiAdapterStartAppliesModelAndReasoningConfigOptions(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Gemini CLI", "gemini-session-1")
	adapter := NewGeminiAdapter(transport)
	session := standardTestSession(ProviderGemini)
	session.Settings = &SessionSettings{
		Model:           "gemini-2.5-pro",
		ReasoningEffort: "high",
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	calls := transport.conn.setConfigOptionCalls()
	if len(calls) != 2 {
		t.Fatalf("config option calls = %#v, want model + effort", calls)
	}
	if got, _ := calls[0]["configId"].(string); got != "model" {
		t.Fatalf("first config id = %q, want model", got)
	}
	if got, _ := calls[0]["value"].(string); got != "gemini-2.5-pro" {
		t.Fatalf("first config value = %q, want gemini-2.5-pro", got)
	}
	if got, _ := calls[1]["configId"].(string); got != "effort" {
		t.Fatalf("second config id = %q, want effort", got)
	}
	if got, _ := calls[1]["value"].(string); got != "high" {
		t.Fatalf("second config value = %q, want high", got)
	}
}

func TestHermesAdapterStartCreatesStandardACPSession(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-1")
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)
	session.PermissionModeID = "full-access"

	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	spec := transport.specs[0]
	if got := strings.Join(spec.Command, " "); got != "hermes acp" {
		t.Fatalf("command = %q, want %q", got, "hermes acp")
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("events = %#v, want session.started", events)
	}
	if events[0].ProviderSessionID != "hermes-session-1" {
		t.Fatalf("provider session id = %q", events[0].ProviderSessionID)
	}
	if transport.conn.lastModeID() != "yolo" {
		t.Fatalf("mode id = %q, want yolo", transport.conn.lastModeID())
	}
	if got := transport.conn.authenticatedMethodID(); got != "" {
		t.Fatalf("authenticated method id = %q, want empty", got)
	}
}

func TestHermesAdapterStartCoercesReadOnlyModeToYolo(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-default")
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)
	session.PermissionModeID = "read-only"

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if transport.conn.lastModeID() != "yolo" {
		t.Fatalf("mode id = %q, want yolo", transport.conn.lastModeID())
	}
}

func TestHermesAdapterStartCoercesAutoModeToYolo(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-auto")
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)
	session.PermissionModeID = "auto"

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if transport.conn.lastModeID() != "yolo" {
		t.Fatalf("mode id = %q, want yolo", transport.conn.lastModeID())
	}
}

func TestOpenClawAdapterStartCreatesStandardACPSession(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenClaw", "openclaw-session-1")
	adapter := NewOpenClawAdapter(transport)
	session := standardTestSession(ProviderOpenClaw)
	session.PermissionModeID = "full-access"

	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	spec := transport.specs[0]
	if got := strings.Join(spec.Command, " "); got != "openclaw acp -v" {
		t.Fatalf("command = %q, want %q", got, "openclaw acp -v")
	}
	if !containsString(spec.Env, "NODE_DISABLE_COMPILE_CACHE=1") {
		t.Fatalf("env = %#v, want OpenClaw Node compile cache disabled for routed ACP startup", spec.Env)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("events = %#v, want session.started", events)
	}
	if events[0].ProviderSessionID != "openclaw-session-1" {
		t.Fatalf("provider session id = %q", events[0].ProviderSessionID)
	}
	if transport.conn.lastModeID() != "" {
		t.Fatalf("mode id = %q, want empty because openclaw permission mode must not use session/set_mode", transport.conn.lastModeID())
	}
	if got := transport.conn.authenticatedMethodID(); got != "" {
		t.Fatalf("authenticated method id = %q, want empty", got)
	}
	meta, ok := transport.conn.lastNewSessionParams["_meta"].(map[string]any)
	if !ok {
		t.Fatalf("session/new missing _meta params snapshot")
	}
	sk, _ := meta["sessionKey"].(string)
	wantKey := "agent:main:tsh-" + session.AgentSessionID
	if sk != wantKey {
		t.Fatalf("session/new sessionKey = %q, want %q", sk, wantKey)
	}
}

func TestOpenClawAdapterResumePassesGatewayChatSessionKeyMeta(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenClaw", "openclaw-session-resume")
	adapter := NewOpenClawAdapter(transport)
	session := standardTestSession(ProviderOpenClaw)
	session.ProviderSessionID = "persisted-openclaw-acp-session-id"

	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	meta, ok := transport.conn.lastLoadSessionParams["_meta"].(map[string]any)
	if !ok {
		t.Fatalf("session/load missing _meta params snapshot")
	}
	sk, _ := meta["sessionKey"].(string)
	wantKey := "agent:main:tsh-" + session.AgentSessionID
	if sk != wantKey {
		t.Fatalf("session/load sessionKey = %q, want %q", sk, wantKey)
	}
}

func TestOpenClawAdapterResumeClassifiesMissingProviderSession(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenClaw", "openclaw-session-resume")
	transport.conn.loadSessionError = &acpError{
		Code:    -32002,
		Message: "Resource not found",
	}
	adapter := NewOpenClawAdapter(transport)
	session := standardTestSession(ProviderOpenClaw)
	session.ProviderSessionID = "persisted-openclaw-acp-session-id"

	err := adapter.Resume(context.Background(), session)
	if AppErrorCode(err) != AppErrorProviderSessionNotFound {
		t.Fatalf("app error code = %q, want %q (err=%v)", AppErrorCode(err), AppErrorProviderSessionNotFound, err)
	}
}

func TestStandardACPProvidersResumeClassifyMissingProviderSession(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		provider string
		build    func(ProcessTransport) *standardACPAdapter
		session  func() Session
	}{
		{
			name:     "gemini",
			provider: ProviderGemini,
			build:    NewGeminiAdapter,
			session: func() Session {
				session := standardTestSession(ProviderGemini)
				session.ProviderSessionID = "persisted-gemini-session-id"
				return session
			},
		},
		{
			name:     "hermes",
			provider: ProviderHermes,
			build:    NewHermesAdapter,
			session: func() Session {
				session := standardTestSession(ProviderHermes)
				session.ProviderSessionID = "persisted-hermes-session-id"
				return session
			},
		},
		{
			name:     "claude-code",
			provider: ProviderClaudeCode,
			build:    NewClaudeCodeAdapter,
			session: func() Session {
				session := standardTestSession(ProviderClaudeCode)
				session.ProviderSessionID = "persisted-claude-session-id"
				return session
			},
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			transport := newStandardACPTransport(tc.provider, tc.session().ProviderSessionID)
			transport.conn.supportsLoadSession = true
			transport.conn.loadSessionError = &acpError{
				Code:    -32002,
				Message: "Resource not found",
			}
			adapter := tc.build(transport)
			err := adapter.Resume(context.Background(), tc.session())
			if AppErrorCode(err) != AppErrorProviderSessionNotFound {
				t.Fatalf("app error code = %q, want %q (err=%v)", AppErrorCode(err), AppErrorProviderSessionNotFound, err)
			}
		})
	}
}

func TestStandardACPProvidersResumeClassifyUnsupportedRestoreAsResumeSessionNotLocal(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-resume")
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)
	session.ProviderSessionID = "persisted-hermes-session-id"

	err := adapter.Resume(context.Background(), session)
	if AppErrorCode(err) != AppErrorResumeSessionNotLocal {
		t.Fatalf("app error code = %q, want %q (err=%v)", AppErrorCode(err), AppErrorResumeSessionNotLocal, err)
	}
	debugMessage := AppErrorDebugMessage(err)
	if !strings.Contains(debugMessage, "resume/load unsupported") {
		t.Fatalf("debug message = %q, want unsupported restore detail", debugMessage)
	}
}

func TestStandardACPProvidersResumeRequireProviderSessionID(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-resume")
	adapter := NewHermesAdapter(transport)
	session := standardTestSession(ProviderHermes)
	session.ProviderSessionID = ""

	err := adapter.Resume(context.Background(), session)
	if AppErrorCode(err) != AppErrorResumeSessionNotLocal {
		t.Fatalf("app error code = %q, want %q (err=%v)", AppErrorCode(err), AppErrorResumeSessionNotLocal, err)
	}
	if len(transport.specs) != 0 {
		t.Fatalf("process starts = %d, want 0", len(transport.specs))
	}
	debugMessage := AppErrorDebugMessage(err)
	if !strings.Contains(debugMessage, "provider_session_id missing") {
		t.Fatalf("debug message = %q, want missing provider session detail", debugMessage)
	}
}

func TestOpenClawAdapterStartSkipsSessionSetModeForDefaultPermission(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenClaw", "openclaw-session-default")
	adapter := NewOpenClawAdapter(transport)
	session := standardTestSession(ProviderOpenClaw)
	// PermissionMode omitted → approve-reads for OpenClaw.

	_, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if transport.conn.lastModeID() != "" {
		t.Fatalf("mode id = %q, want empty because openclaw permission mode must not use session/set_mode", transport.conn.lastModeID())
	}
}

func TestOpenClawAdapterStartIgnoresSetModeErrorsBecauseNoSetModeIsSent(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenClaw", "openclaw-session-fail")
	transport.conn.setModeError = &acpError{
		Code:    -32603,
		Message: "Internal error",
		Data:    json.RawMessage(`{"details":"invalid thinkingLevel"}`),
	}
	adapter := NewOpenClawAdapter(transport)
	session := standardTestSession(ProviderOpenClaw)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start() error = %v, want nil because openclaw should not call session/set_mode", err)
	}
	if transport.conn.lastModeID() != "" {
		t.Fatalf("mode id = %q, want empty because openclaw should not call session/set_mode", transport.conn.lastModeID())
	}
}

func TestClaudeCodeAdapterExecWaitsForPermissionAndStreamsUpdates(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-1")
	transport.conn.promptPermission = true
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.Title = "Claude Code"
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "claude-session-1"

	var mu sync.Mutex
	var emittedActivity []activityshared.Event
	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("review workspace"), "", "turn-1", func(events []activityshared.Event) {
			mu.Lock()
			emittedActivity = append(emittedActivity, events...)
			mu.Unlock()
		}, nil)
		execDone <- err
	}()

	waitForCondition(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		events := ProjectActivityEventsToStreamEvents(session, emittedActivity)
		return hasStreamCallEvent(events, "approval", "waiting_approval")
	})

	if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		RequestID: "permission-1",
		OptionID:  "approve",
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	select {
	case err := <-execDone:
		if err != nil {
			t.Fatalf("Exec: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Exec did not finish after permission response")
	}

	mu.Lock()
	events := ProjectActivityEventsToStreamEvents(session, emittedActivity)
	titleEvents := activityEventsWithType(emittedActivity, activityshared.EventSessionUpdated)
	mu.Unlock()
	if len(titleEvents) == 0 || titleEvents[0].Payload.Title != "review workspace" {
		t.Fatalf("title events = %#v, want prompt fallback title", titleEvents)
	}
	if !hasStreamMessageEvent(events, "assistant", "Inspecting files.") {
		t.Fatalf("events = %#v, missing assistant stream", events)
	}
	if !hasStreamCallEvent(events, "approval", "completed") {
		t.Fatalf("events = %#v, missing approval completion", events)
	}
	if !hasStreamCallEvent(events, "execute", "completed") {
		t.Fatalf("events = %#v, missing tool completion", events)
	}
	if got := transport.conn.permissionOptionID(); got != "allow" {
		t.Fatalf("permission option id = %q, want allow", got)
	}
}

func TestClaudeCodeAdapterSessionLevelMessageReusesRecentTurnID(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-1")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "claude-session-1"

	var mu sync.Mutex
	var sinkEvents []activityshared.Event
	adapter.SetSessionEventSink(func(agentSessionID string, events []activityshared.Event) {
		if agentSessionID != session.AgentSessionID {
			return
		}
		mu.Lock()
		sinkEvents = append(sinkEvents, events...)
		mu.Unlock()
	})

	if _, err := adapter.Exec(context.Background(), session, textPrompt("monitor a job"), "", "turn-monitor", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}

	transport.conn.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": "claude-session-1",
			"update": map[string]any{
				"sessionUpdate": "tool_call_update",
				"toolCallId":    "monitor-result",
				"title":         "Bash",
				"kind":          "execute",
				"status":        "completed",
				"rawOutput": map[string]any{
					"stdout": `{"job":{"status":"succeeded"}}`,
				},
			},
		},
	})

	waitForCondition(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		for _, event := range sinkEvents {
			if event.Payload.CallID == "monitor-result" && event.Payload.TurnID == "turn-monitor" {
				return true
			}
		}
		return false
	})
}

func TestClaudeCodeAdapterAllowsImagePromptWithoutInitializeCapability(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-1")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "claude-session-1"

	content := []PromptContentBlock{{
		Type: "text",
		Text: "what is in this screenshot?",
	}, {
		Type:     "image",
		MimeType: "image/png",
		Data:     "aW1hZ2U=",
	}}
	if err := adapter.ValidatePromptContent(session, content); err != nil {
		t.Fatalf("ValidatePromptContent error = %v, want nil", err)
	}
	snapshot := adapter.SessionState(session)
	capabilities, _ := snapshot.RuntimeContext["capabilities"].([]string)
	if !containsString(capabilities, CapabilityImageInput) {
		t.Fatalf("runtime capabilities = %#v, want imageInput", snapshot.RuntimeContext["capabilities"])
	}
}

func TestStandardACPAdapterRejectsImagePromptWithoutCapability(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Gemini CLI", "gemini-session-1")
	adapter := NewGeminiAdapter(transport)
	session := standardTestSession(ProviderGemini)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "gemini-session-1"

	content := []PromptContentBlock{{
		Type:     "image",
		MimeType: "image/png",
		Data:     "aW1hZ2U=",
	}}
	if err := adapter.ValidatePromptContent(session, content); !errors.Is(err, ErrPromptImageUnsupported) {
		t.Fatalf("ValidatePromptContent error = %v, want ErrPromptImageUnsupported", err)
	}
	snapshot := adapter.SessionState(session)
	capabilities, _ := snapshot.RuntimeContext["capabilities"].([]string)
	if containsString(capabilities, CapabilityImageInput) {
		t.Fatalf("runtime promptCapabilities = %#v, want image unsupported", snapshot.RuntimeContext["promptCapabilities"])
	}
}

func TestClaudeCodeAdapterPermissionRequestAcceptsInteractiveSelection(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-1")
	transport.conn.promptPermission = true
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "claude-session-1"

	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("review workspace"), "", "turn-1", func([]activityshared.Event) {}, nil)
		execDone <- err
	}()

	waitForCondition(t, func() bool {
		return adapter.getPendingApproval(session.AgentSessionID, "permission-1") != nil
	})

	if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		RequestID: "permission-1",
		Action:    "deny",
		OptionID:  "reject",
		Payload: map[string]any{
			"denyMessage": "Please inspect first and avoid running the command.",
		},
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if err := <-execDone; err != nil {
		t.Fatalf("Exec after permission response: %v", err)
	}
	if got := transport.conn.permissionOptionID(); got != "reject" {
		t.Fatalf("permission option id = %q, want reject", got)
	}
	outcome := transport.conn.interactiveOutcome()
	if outcome["outcome"] != "selected" || outcome["optionId"] != "reject" {
		t.Fatalf("permission outcome = %#v, want selected reject", outcome)
	}
	if payload, ok := outcome["payload"].(map[string]any); ok && payload["denyMessage"] != nil {
		t.Fatalf("permission payload = %#v, want deny feedback kept outside ACP permission response", payload)
	}
}

func TestClaudeCodeAdapterExecTreatsContextCanceledAsInterrupted(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-1")
	gate := make(chan struct{})
	transport.conn.pauseBeforeToolCallCompletion = gate
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "claude-session-1"

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var releaseGate sync.Once
	time.AfterFunc(200*time.Millisecond, func() {
		releaseGate.Do(func() { close(gate) })
	})

	var mu sync.Mutex
	var emittedActivity []activityshared.Event
	_, err := adapter.Exec(ctx, session, textPrompt("review workspace"), "", "turn-1", func(events []activityshared.Event) {
		mu.Lock()
		emittedActivity = append(emittedActivity, events...)
		mu.Unlock()
		if len(activityEventsWithType(events, activityshared.EventCallStarted)) > 0 {
			cancel()
			releaseGate.Do(func() { close(gate) })
		}
	}, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	mu.Lock()
	streamEvents := ProjectActivityEventsToStreamEvents(session, emittedActivity)
	rawEvents := append([]activityshared.Event(nil), emittedActivity...)
	mu.Unlock()
	if !hasStreamCallEvent(streamEvents, "execute", SessionStatusCanceled) {
		t.Fatalf("events = %#v, want canceled tool call", streamEvents)
	}
	turnCanceled := activityEventsWithType(rawEvents, EventTurnCanceled)
	turnCompleted := activityEventsWithType(rawEvents, activityshared.EventTurnCompleted)
	if len(turnCanceled) == 0 {
		if len(turnCompleted) == 0 || turnCompleted[len(turnCompleted)-1].Payload.TurnOutcome != string(activityshared.TurnOutcomeInterrupted) {
			t.Fatalf("events = %#v, want interrupted terminal turn", rawEvents)
		}
	}
	for _, event := range streamEvents {
		patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
		if !ok {
			continue
		}
		if patch.LifecycleStatus == "ended" && patch.CurrentPhase == "idle" && patch.LastError != "" {
			t.Fatalf("terminal cancel patch = %#v, want empty last error", patch)
		}
	}
}

func TestClaudeCodeStandardACPUpdateKeepsTerminalToolUpdateWithoutCurrentTurnStart(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "claude-session-1"
	normalizer := newACPTurnNormalizer()

	stale := standardACPUpdateEvents(standardACPClaudeCodeConfig(), session, "turn-new", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call_update",
			"toolCallId": "call_function_stale_1",
			"title": "call_function_stale_1",
			"status": "failed",
			"rawOutput": {"output": "Exit code 137"}
		}
	}`), normalizer)
	if len(stale) != 1 || stale[0].Type != activityshared.EventCallFailed {
		t.Fatalf("stale events = %#v, want terminal call.failed", stale)
	}
	if stale[0].Payload.CallID != "call_function_stale_1" ||
		stale[0].Payload.Status != messageStreamStateFailed {
		t.Fatalf("stale event = %#v, want failed terminal payload", stale[0])
	}

	started := standardACPUpdateEvents(standardACPClaudeCodeConfig(), session, "turn-new", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call",
			"toolCallId": "tool-current",
			"title": "Bash",
			"status": "pending"
		}
	}`), normalizer)
	if len(started) != 1 || started[0].Type != activityshared.EventCallStarted {
		t.Fatalf("started events = %#v, want call.started", started)
	}

	failed := standardACPUpdateEvents(standardACPClaudeCodeConfig(), session, "turn-new", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call_update",
			"toolCallId": "tool-current",
			"title": "Bash",
			"status": "failed",
			"rawOutput": {"output": "Exit code 1"}
		}
	}`), normalizer)
	if len(failed) != 1 || failed[0].Type != activityshared.EventCallFailed {
		t.Fatalf("failed events = %#v, want current-turn call.failed", failed)
	}
}

func TestClaudeCodeStandardACPUpdatePreservesAskUserQuestionToolEvents(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "claude-session-ask-user"
	normalizer := newACPTurnNormalizer()

	started := standardACPUpdateEvents(standardACPClaudeCodeConfig(), session, "turn-ask-user", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call",
			"toolCallId": "tool-ask-user",
			"title": "AskUserQuestion",
			"status": "pending"
		}
	}`), normalizer)
	if len(started) != 1 || started[0].Type != activityshared.EventCallStarted {
		t.Fatalf("started events = %#v, want call.started for AskUserQuestion", started)
	}

	failed := standardACPUpdateEvents(standardACPClaudeCodeConfig(), session, "turn-ask-user", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call_update",
			"toolCallId": "tool-ask-user",
			"title": "AskUserQuestion",
			"status": "failed",
			"rawOutput": {"message": "AskUserQuestion is not available"}
		}
	}`), normalizer)
	if len(failed) != 1 || failed[0].Type != activityshared.EventCallFailed {
		t.Fatalf("failed events = %#v, want AskUserQuestion failure to surface", failed)
	}
}

func TestStandardACPToolCallEventInfersCompletedStatusFromRawOutput(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderGemini)
	completed, ok := standardACPToolCallEventWithID(session, "event-complete-inferred", "turn-1", "tool_call_update", readSessionTestdataJSON(t, "standard_acp_tool_call_update_completed_without_status.json"))
	if !ok {
		t.Fatal("standardACPToolCallEventWithID(inferred complete) returned !ok")
	}
	if completed.Type != activityshared.EventCallCompleted {
		t.Fatalf("completed event type = %s, want call.completed", completed.Type)
	}
	rawOutput, ok := completed.Payload.Output["rawOutput"].(map[string]any)
	if !ok || rawOutput["stdout"] != "/workspace/app\n" {
		t.Fatalf("completed output = %#v, want stdout preserved", completed.Payload.Output)
	}
}

func TestStandardACPToolCallEventInfersFailedStatusFromRawOutput(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderGemini)
	failed, ok := standardACPToolCallEventWithID(session, "event-failed-inferred", "turn-1", "tool_call_update", readSessionTestdataJSON(t, "standard_acp_tool_call_update_failed_without_status.json"))
	if !ok {
		t.Fatal("standardACPToolCallEventWithID(inferred failed) returned !ok")
	}
	if failed.Type != activityshared.EventCallFailed {
		t.Fatalf("failed event type = %s, want call.failed", failed.Type)
	}
	rawOutput, ok := failed.Payload.Error["rawOutput"].(map[string]any)
	if !ok || rawOutput["output"] != "Exit code 137" {
		t.Fatalf("failed error = %#v, want raw output preserved", failed.Payload.Error)
	}
}

func TestClaudeCodeStandardACPImageGenerationSanitizesImageBytes(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderClaudeCode)
	completed, ok := standardACPToolCallEventWithID(session, "event-image-generation", "turn-1", "tool_call_update", map[string]any{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "ig_1234567890abcdef",
		"title":         "ig_1234567890abcdef",
		"status":        "completed",
		"content": []any{
			map[string]any{
				"type": "content",
				"content": map[string]any{
					"type": "text",
					"text": "Revised prompt: cheerful child dancing",
				},
			},
			map[string]any{
				"type": "content",
				"content": map[string]any{
					"type":     "image",
					"uri":      "/workspace/output/preview.png",
					"mimeType": "image/png",
					"data":     "base64-image-bytes",
				},
			},
		},
		"rawOutput": map[string]any{
			"_meta": map[string]any{
				"claudeCode": map[string]any{
					"toolName": "ig_1234567890abcdef",
					"toolResponse": map[string]any{
						"content": []any{
							map[string]any{
								"type":     "image",
								"uri":      "/workspace/output/preview.png",
								"mimeType": "image/png",
								"data":     "tool-response-image-bytes",
							},
						},
					},
				},
			},
		},
	})
	if !ok {
		t.Fatal("standardACPToolCallEventWithID(image generation) returned !ok")
	}
	if completed.Type != activityshared.EventCallCompleted {
		t.Fatalf("completed event type = %s, want call.completed", completed.Type)
	}
	if got := completed.Payload.Metadata["toolName"]; got != "ImageGeneration" {
		t.Fatalf("metadata toolName = %#v, want ImageGeneration", got)
	}

	content := payloadArray(completed.Payload.Metadata["content"])
	if len(content) != 2 {
		t.Fatalf("metadata content = %#v, want 2 content blocks", completed.Payload.Metadata["content"])
	}
	imageBlock := payloadObject(content[1]["content"])
	if _, exists := imageBlock["data"]; exists {
		t.Fatalf("metadata image block retained data bytes: %#v", imageBlock)
	}
	if imageBlock["uri"] != "/workspace/output/preview.png" {
		t.Fatalf("metadata image uri = %#v, want preview path", imageBlock["uri"])
	}
	if imageBlock["mimeType"] != "image/png" {
		t.Fatalf("metadata image mimeType = %#v, want image/png", imageBlock["mimeType"])
	}

	outputContent := payloadArray(completed.Payload.Output["content"])
	if len(outputContent) != 2 {
		t.Fatalf("output content = %#v, want 2 content blocks", completed.Payload.Output["content"])
	}
	outputImageBlock := payloadObject(outputContent[1]["content"])
	if _, exists := outputImageBlock["data"]; exists {
		t.Fatalf("output image block retained data bytes: %#v", outputImageBlock)
	}
	if text := payloadString(payloadObject(outputContent[0]["content"]), "text"); text != "Revised prompt: cheerful child dancing" {
		t.Fatalf("output text block = %q, want revised prompt", text)
	}

	toolResponse := payloadMap(payloadMap(completed.Payload.Metadata, "metadata"), "claudeToolResponse")
	toolResponseContent := payloadArray(toolResponse["content"])
	if len(toolResponseContent) != 1 {
		t.Fatalf("tool response content = %#v, want 1 image block", toolResponse["content"])
	}
	if _, exists := payloadObject(toolResponseContent[0])["data"]; exists {
		t.Fatalf("tool response retained image data bytes: %#v", toolResponse["content"])
	}
}

func TestClaudeCodeStandardACPImageGenerationInfersCompletedStatusFromContent(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderClaudeCode)
	completed, ok := standardACPToolCallEventWithID(session, "event-image-generation-inferred", "turn-1", "tool_call_update", map[string]any{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "ig_1234567890abcdef",
		"title":         "ig_1234567890abcdef",
		"status":        "generating",
		"content": []any{
			map[string]any{
				"type": "content",
				"content": map[string]any{
					"type": "text",
					"text": "Revised prompt: cheerful child dancing",
				},
			},
			map[string]any{
				"type": "content",
				"content": map[string]any{
					"type":     "image",
					"uri":      "/home/user/.codex/generated_images/session/ig_1234567890abcdef.png",
					"mimeType": "image/png",
				},
			},
		},
	})
	if !ok {
		t.Fatal("standardACPToolCallEventWithID(image generation inferred) returned !ok")
	}
	if completed.Type != activityshared.EventCallCompleted {
		t.Fatalf("completed event type = %s, want call.completed", completed.Type)
	}
	if got := completed.Payload.Metadata["toolName"]; got != "ImageGeneration" {
		t.Fatalf("metadata toolName = %#v, want ImageGeneration", got)
	}
	outputContent := payloadArray(completed.Payload.Output["content"])
	if len(outputContent) != 2 {
		t.Fatalf("output content = %#v, want 2 content blocks", completed.Payload.Output["content"])
	}
	outputImageBlock := payloadObject(outputContent[1]["content"])
	if outputImageBlock["uri"] != "/home/user/.codex/generated_images/session/ig_1234567890abcdef.png" {
		t.Fatalf("output image uri = %#v, want generated image path", outputImageBlock["uri"])
	}
}

func TestStandardACPNonClaudeToolCallSanitizesImageBytes(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderGemini)
	completed, ok := standardACPToolCallEventWithID(session, "event-image-standard", "turn-1", "tool_call_update", map[string]any{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "image-tool-1",
		"title":         "Image generation",
		"kind":          "other",
		"status":        "completed",
		"content": []any{
			map[string]any{
				"type":     "image",
				"uri":      "/workspace/output/generated.png",
				"mimeType": "image/png",
				"data":     "output-image-bytes",
			},
		},
	})
	if !ok {
		t.Fatal("standardACPToolCallEventWithID(non-claude image generation) returned !ok")
	}
	if completed.Type != activityshared.EventCallCompleted {
		t.Fatalf("completed event type = %s, want call.completed", completed.Type)
	}
	content := payloadArray(completed.Payload.Output["content"])
	if len(content) != 1 {
		t.Fatalf("completed output content = %#v, want 1 image block", completed.Payload.Output["content"])
	}
	if _, exists := content[0]["data"]; exists {
		t.Fatalf("completed output retained image data bytes: %#v", completed.Payload.Output["content"])
	}
	if got := content[0]["uri"]; got != "/workspace/output/generated.png" {
		t.Fatalf("completed output uri = %#v, want generated image path", got)
	}
}

func TestClaudeCodeStandardACPToolCallEventCanonicalizesSkillPayload(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderClaudeCode)
	completed, ok := standardACPToolCallEventWithID(session, "event-skill-complete", "turn-1", "tool_call_update", map[string]any{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "call_skill_1",
		"title":         "Skill",
		"status":        "completed",
		"kind":          "other",
		"rawInput": map[string]any{
			"skill": "init",
			"args":  "帮我写一个 todo-list",
		},
		"rawOutput": "Launching skill: init",
	})
	if !ok {
		t.Fatal("standardACPToolCallEventWithID(skill) returned !ok")
	}
	if completed.Type != activityshared.EventCallCompleted {
		t.Fatalf("completed event type = %s, want call.completed", completed.Type)
	}
	if got := completed.Payload.Name; got != "Skill" {
		t.Fatalf("completed name = %q, want Skill", got)
	}
	if got := completed.Payload.Metadata["toolName"]; got != "Skill" {
		t.Fatalf("completed metadata = %#v, want Skill toolName", completed.Payload.Metadata)
	}
	if got := completed.Payload.Output["commandName"]; got != "init" {
		t.Fatalf("completed output = %#v, want commandName init", completed.Payload.Output)
	}
	if got := completed.Payload.Output["success"]; got != true {
		t.Fatalf("completed output = %#v, want success=true", completed.Payload.Output)
	}
	if got := completed.Payload.Output["output"]; got != "Launching skill: init" {
		t.Fatalf("completed output = %#v, want canonical output text", completed.Payload.Output)
	}
}

func TestClaudeCodeStandardACPToolCallEventPreservesParentToolUseID(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderClaudeCode)
	completed, ok := standardACPToolCallEventWithID(session, "event-child-tool", "turn-1", "tool_call_update", map[string]any{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "call_child_1",
		"title":         "call_child_1",
		"status":        "completed",
		"kind":          "search",
		"rawInput": map[string]any{
			"pattern": "**/*",
			"_meta": map[string]any{
				"claudeCode": map[string]any{
					"toolName":        "Glob",
					"parentToolUseId": "call_parent_1",
				},
			},
		},
		"rawOutput": map[string]any{
			"stdout": "index.html\nCLAUDE.md\n",
		},
	})
	if !ok {
		t.Fatal("standardACPToolCallEventWithID(child) returned !ok")
	}
	if got := completed.Payload.Name; got != "Glob" {
		t.Fatalf("completed name = %q, want Glob", got)
	}
	if got := completed.Payload.Metadata["toolName"]; got != "Glob" {
		t.Fatalf("completed metadata = %#v, want Glob toolName", completed.Payload.Metadata)
	}
	metadata, ok := completed.Payload.Metadata["metadata"].(map[string]any)
	if !ok {
		t.Fatalf("completed metadata = %#v, want nested metadata map", completed.Payload.Metadata)
	}
	if got := metadata["parentToolUseId"]; got != "call_parent_1" {
		t.Fatalf("metadata = %#v, want parentToolUseId preserved", metadata)
	}
}

func TestStandardACPAdapterSessionStateExposesPendingAskUserPrompt(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Gemini CLI", "gemini-session-interactive-1")
	transport.conn.promptKind = "ask-user"
	adapter := NewGeminiAdapter(transport)
	session := standardTestSession(ProviderGemini)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "gemini-session-interactive-1"

	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("choose renderer"), "", "turn-ask-user", func([]activityshared.Event) {}, nil)
		execDone <- err
	}()

	waitForCondition(t, func() bool {
		snapshot := adapter.SessionState(session)
		return snapshot.PendingInteractive != nil &&
			snapshot.PendingInteractive.Kind == "ask-user" &&
			snapshot.PendingInteractive.RequestID == "permission-1"
	})

	snapshot := adapter.SessionState(session)
	if snapshot.PendingInteractive == nil {
		t.Fatal("pending interactive = nil, want ask-user prompt")
	}
	if snapshot.PendingInteractive.ToolName != "AskUserQuestion" {
		t.Fatalf("tool name = %q, want AskUserQuestion", snapshot.PendingInteractive.ToolName)
	}
	questions, _ := snapshot.PendingInteractive.Input["questions"].([]any)
	if len(questions) == 0 {
		t.Fatalf("interactive input = %#v, want questions", snapshot.PendingInteractive.Input)
	}

	_, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		RoomID:         session.RoomID,
		AgentSessionID: session.AgentSessionID,
		RequestID:      "permission-1",
		Action:         "submit",
		// Canonical GUI ask-user payload: flat display list + keyed map.
		Payload: map[string]any{
			"answers":             []any{"Renderer A"},
			"answersByQuestionId": map[string]any{"render-path": "Renderer A"},
		},
	})
	if err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if err := <-execDone; err != nil {
		t.Fatalf("Exec after interactive submission: %v", err)
	}
	outcome := transport.conn.interactiveOutcome()
	if got := asString(outcome["outcome"]); got != "submit" {
		t.Fatalf("interactive outcome = %#v, want submit", outcome)
	}
	payload, _ := outcome["payload"].(map[string]any)
	if payload == nil || payload["answersByQuestionId"] == nil {
		t.Fatalf("interactive payload = %#v, want answersByQuestionId", outcome)
	}
}

func TestStandardACPAdapterSessionStateExposesPendingExitPlanPrompt(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Gemini CLI", "gemini-session-plan-1")
	transport.conn.promptKind = "exit-plan"
	adapter := NewGeminiAdapter(transport)
	session := standardTestSession(ProviderGemini)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "gemini-session-plan-1"

	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("review plan"), "", "turn-plan", func([]activityshared.Event) {}, nil)
		execDone <- err
	}()

	waitForCondition(t, func() bool {
		snapshot := adapter.SessionState(session)
		return snapshot.PendingInteractive != nil &&
			snapshot.PendingInteractive.Kind == "exit-plan" &&
			snapshot.PendingInteractive.RequestID == "permission-1"
	})

	snapshot := adapter.SessionState(session)
	if snapshot.PendingInteractive == nil || snapshot.PendingInteractive.ToolName != "ExitPlanMode" {
		t.Fatalf("pending interactive = %#v, want ExitPlanMode", snapshot.PendingInteractive)
	}

	_, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		RoomID:         session.RoomID,
		AgentSessionID: session.AgentSessionID,
		RequestID:      "permission-1",
		Action:         "allow",
		OptionID:       "acceptEdits",
	})
	if err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if err := <-execDone; err != nil {
		t.Fatalf("Exec after exit-plan submission: %v", err)
	}
	outcome := transport.conn.interactiveOutcome()
	if got := asString(outcome["optionId"]); got != "acceptEdits" {
		t.Fatalf("interactive outcome = %#v, want optionId acceptEdits", outcome)
	}
}

func TestStandardACPToolCallLifecycleReusesStableEventID(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name     string
		provider string
		config   standardACPConfig
	}{
		{
			name:     "gemini",
			provider: ProviderGemini,
			config:   standardACPConfig{provider: ProviderGemini},
		},
		{
			name:     "hermes",
			provider: ProviderHermes,
			config:   standardACPConfig{provider: ProviderHermes},
		},
		{
			name:     "openclaw",
			provider: ProviderOpenClaw,
			config:   standardACPConfig{provider: ProviderOpenClaw},
		},
		{
			name:     "claude-code",
			provider: ProviderClaudeCode,
			config:   standardACPClaudeCodeConfig(),
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			session := standardTestSession(tc.provider)
			session.ProviderSessionID = tc.name + "-session-1"
			normalizer := newACPTurnNormalizer()

			started := standardACPUpdateEvents(tc.config, session, "turn-1", json.RawMessage(`{
				"update": {
					"sessionUpdate": "tool_call",
					"toolCallId": "tool-current",
					"title": "Bash",
					"status": "pending",
					"kind": "tool",
					"rawInput": {"command": "pwd"}
				}
			}`), normalizer)
			if len(started) != 1 || started[0].Type != activityshared.EventCallStarted {
				t.Fatalf("started events = %#v, want one call.started", started)
			}

			completed := standardACPUpdateEvents(tc.config, session, "turn-1", json.RawMessage(`{
				"update": {
					"sessionUpdate": "tool_call_update",
					"toolCallId": "tool-current",
					"title": "Bash",
					"status": "completed",
					"kind": "tool",
					"rawOutput": {"stdout": "/workspace/app\n"}
				}
			}`), normalizer)
			if len(completed) != 1 || completed[0].Type != activityshared.EventCallCompleted {
				t.Fatalf("completed events = %#v, want one call.completed", completed)
			}
			if started[0].EventID == "" {
				t.Fatalf("started event id = empty, want stable event id")
			}
			if completed[0].EventID != started[0].EventID {
				t.Fatalf("event ids = %q / %q, want same stable tool event id", started[0].EventID, completed[0].EventID)
			}
		})
	}
}

func TestStandardACPNormalizerSegmentsAssistantAndThinkingAroundToolCalls(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderGemini)
	session.ProviderSessionID = "gemini-session-segment-1"
	normalizer := newACPTurnNormalizer()

	var events []activityshared.Event
	events = append(events, normalizer.AppendThinkingChunk(session, "turn-1", "Thinking before tool. ")...)
	events = append(events, normalizer.AppendAssistantChunk(session, "turn-1", "Before tool. ")...)
	events = append(events, standardACPUpdateEvents(standardACPConfig{provider: ProviderGemini}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call",
			"toolCallId": "tool-segment-1",
			"title": "Bash",
			"status": "pending"
		}
	}`), normalizer)...)
	events = append(events, normalizer.AppendThinkingChunk(session, "turn-1", "Thinking after tool. ")...)
	events = append(events, normalizer.AppendAssistantChunk(session, "turn-1", "After tool.")...)
	events = append(events, normalizer.Finish(session, "turn-1", messageStreamStateCompleted)...)

	assistantMessages := activityMessagesWithRole(events, activityshared.MessageRoleAssistant)
	if len(assistantMessages) != 4 {
		t.Fatalf("assistant messages = %#v, want streaming+completed before tool and streaming+completed after tool", assistantMessages)
	}
	if assistantMessages[0].EventID == "" ||
		assistantMessages[1].EventID != assistantMessages[0].EventID ||
		assistantMessages[2].EventID == "" ||
		assistantMessages[3].EventID != assistantMessages[2].EventID ||
		assistantMessages[2].EventID == assistantMessages[0].EventID {
		t.Fatalf("assistant event IDs = %#v, want distinct IDs split by tool boundary", assistantMessages)
	}
	if assistantMessages[1].Payload.Content != "Before tool. " ||
		assistantMessages[3].Payload.Content != "After tool." {
		t.Fatalf("assistant contents = %#v, want text split around tool call", assistantMessages)
	}

	thinkingMessages := activityMessagesWithRole(events, activityshared.MessageRoleAssistantThinking)
	if len(thinkingMessages) != 4 {
		t.Fatalf("thinking messages = %#v, want streaming+completed before tool and streaming+completed after tool", thinkingMessages)
	}
	if thinkingMessages[0].EventID == "" ||
		thinkingMessages[1].EventID != thinkingMessages[0].EventID ||
		thinkingMessages[2].EventID == "" ||
		thinkingMessages[3].EventID != thinkingMessages[2].EventID ||
		thinkingMessages[2].EventID == thinkingMessages[0].EventID {
		t.Fatalf("thinking event IDs = %#v, want distinct IDs split by tool boundary", thinkingMessages)
	}
	if thinkingMessages[1].Payload.Content != "Thinking before tool. " ||
		thinkingMessages[3].Payload.Content != "Thinking after tool. " {
		t.Fatalf("thinking contents = %#v, want thinking split around tool call", thinkingMessages)
	}

	if events[2].Type != activityshared.EventMessageAppended ||
		events[3].Type != activityshared.EventMessageAppended ||
		events[4].Type != activityshared.EventCallStarted ||
		events[5].Type != activityshared.EventMessageAppended ||
		events[6].Type != activityshared.EventMessageAppended {
		t.Fatalf("event order = %#v, want thinking completion, assistant completion, tool call, then next segments", events)
	}
}

func TestClaudeCodeStandardACPUpdateKeepsCancelledTerminalToolUpdateWithoutPriorStart(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "claude-session-1"

	events := standardACPUpdateEvents(standardACPClaudeCodeConfig(), session, "turn-new", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call_update",
			"toolCallId": "tool-cancelled",
			"title": "Bash",
			"status": "cancelled",
			"rawOutput": {"output": "Cancelled by user"}
		}
	}`), newACPTurnNormalizer())
	if len(events) != 1 || events[0].Type != activityshared.EventCallFailed {
		t.Fatalf("events = %#v, want cancelled terminal call.failed", events)
	}
	if events[0].Payload.CallID != "tool-cancelled" ||
		events[0].Payload.Status != messageStreamStateFailed {
		t.Fatalf("event = %#v, want failed terminal payload", events[0])
	}

	report := reportActivityInput(session, events)
	if len(report.MessageUpdates) != 1 {
		t.Fatalf("message updates = %#v, want one terminal tool update", report.MessageUpdates)
	}
	update := report.MessageUpdates[0]
	if update.MessageID != "toolcall:tool-cancelled" ||
		update.Kind != "tool_call" ||
		update.Status != string(activityshared.ActivityStatusFailed) ||
		update.CompletedAtUnixMS == 0 {
		t.Fatalf("message update = %#v, want failed terminal tool update", update)
	}
}

func TestClaudeCodeStandardACPUpdateDoesNotProjectSyntheticInterruptTitleAsSessionTitle(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "claude-session-1"
	for _, title := range []string{
		"[Request interrupted by user]",
		"[Request interrupted by user for tool use]",
		"Claude Code mention handoff routing for this user turn: - Treat `mention://...` links as internal Tutti references.",
	} {
		events := standardACPUpdateEvents(standardACPClaudeCodeConfig(), session, "turn-1", json.RawMessage(`{
			"update": {
				"sessionUpdate": "session_info_update",
				"title": "`+title+`"
			}
		}`), newACPTurnNormalizer())
		for _, event := range events {
			if event.Payload.Title == title {
				t.Fatalf("events = %#v, want synthetic interrupt title %q excluded from title updates", events, title)
			}
		}
	}
}

func TestClaudeCodeStandardACPUpdateDoesNotOverwritePromptTitle(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "claude-session-1"
	session.Title = "帮我做一个这周行业报告的ppt出来"

	events := standardACPUpdateEvents(standardACPClaudeCodeConfig(), session, "turn-2", json.RawMessage(`{
		"update": {
			"sessionUpdate": "session_info_update",
			"title": "继续多生成一些多个版本的ppt 看看"
		}
	}`), newACPTurnNormalizer())

	if len(events) != 0 {
		t.Fatalf("events = %#v, want no title overwrite", events)
	}
}

func TestClaudeCodeStandardACPUpdateMarksSyntheticInterruptTitleAsInterrupted(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "claude-session-1"

	events := standardACPUpdateEvents(standardACPClaudeCodeConfig(), session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "session_info_update",
			"title": "[Request interrupted by user for tool use]"
		}
	}`), newACPTurnNormalizer())

	if len(events) != 1 {
		t.Fatalf("events = %#v, want interrupted turn only", events)
	}
	if events[0].Type != activityshared.EventTurnCompleted ||
		events[0].Payload.TurnID != "turn-1" ||
		events[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeInterrupted) {
		t.Fatalf("turn event = %#v, want interrupted turn completion", events[0])
	}
}

func TestClaudeCodeStandardACPUpdateMarksSyntheticInterruptChunkAsInterrupted(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "claude-session-1"

	events := standardACPUpdateEvents(standardACPClaudeCodeConfig(), session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "agent_message_chunk",
			"content": {
				"type": "text",
				"text": "[Request interrupted by user]"
			}
		}
	}`), newACPTurnNormalizer())

	if len(events) != 1 {
		t.Fatalf("events = %#v, want interrupted turn only", events)
	}
	if events[0].Type != activityshared.EventTurnCompleted ||
		events[0].Payload.TurnID != "turn-1" ||
		events[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeInterrupted) {
		t.Fatalf("turn event = %#v, want interrupted turn completion", events[0])
	}
}

func TestStandardACPSystemNoticeChunkProjectsAssistantNotice(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderGemini)
	session.ProviderSessionID = "gemini-session-1"

	events := standardACPUpdateEvents(standardACPConfig{provider: ProviderGemini}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "agent_message_chunk",
			"content": {
				"type": "text",
				"text": "Codex switched to HTTPS transport."
			},
			"_meta": {
				"tsh": {
					"kind": "agent_system_notice",
					"noticeKind": "transport_fallback",
					"severity": "warning",
					"title": "Codex switched to HTTPS transport.",
					"detail": "Falling back from WebSockets to HTTPS transport."
				}
			}
		}
	}`), newACPTurnNormalizer())

	if len(events) != 1 {
		t.Fatalf("events = %#v, want one system notice message", events)
	}
	event := events[0]
	if event.Type != activityshared.EventMessageAppended || event.Payload.Role != activityshared.MessageRoleAssistant {
		t.Fatalf("event = %#v, want assistant message", event)
	}
	if got := event.Payload.Metadata["kind"]; got != "agent_system_notice" {
		t.Fatalf("notice kind marker = %#v, want agent_system_notice", got)
	}
	if got := event.Payload.Metadata["noticeKind"]; got != "transport_fallback" {
		t.Fatalf("noticeKind = %#v, want transport_fallback", got)
	}
}

func TestStandardACPTransportFallbackTextProjectsAssistantNotice(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderCodex)
	session.ProviderSessionID = "codex-session-1"

	events := standardACPUpdateEvents(standardACPConfig{provider: ProviderCodex}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "agent_message_chunk",
			"content": {
				"type": "text",
				"text": "Falling back from WebSockets to HTTPS transport."
			}
		}
	}`), newACPTurnNormalizer())

	if len(events) != 1 {
		t.Fatalf("events = %#v, want one system notice message", events)
	}
	if got := events[0].Payload.Metadata["kind"]; got != "agent_system_notice" {
		t.Fatalf("notice kind marker = %#v, want agent_system_notice", got)
	}
	if got := events[0].Payload.Metadata["noticeKind"]; got != "transport_fallback" {
		t.Fatalf("noticeKind = %#v, want transport_fallback", got)
	}
}

func TestStandardACPTransportFallbackTextStaysProviderScoped(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderGemini)
	session.ProviderSessionID = "gemini-session-1"

	events := standardACPUpdateEvents(standardACPConfig{provider: ProviderGemini}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "agent_message_chunk",
			"content": {
				"type": "text",
				"text": "Falling back from WebSockets to HTTPS transport."
			}
		}
	}`), newACPTurnNormalizer())

	if len(events) != 1 {
		t.Fatalf("events = %#v, want normal assistant chunk for non-Codex providers", events)
	}
	if got := events[0].Payload.Metadata["kind"]; got == "agent_system_notice" {
		t.Fatalf("notice kind marker = %#v, want ordinary assistant message", got)
	}
	if got := events[0].Payload.Content; got != "Falling back from WebSockets to HTTPS transport." {
		t.Fatalf("content = %q, want ordinary assistant content", got)
	}
}

func TestStandardACPReconnectThoughtChunkProjectsAssistantNotice(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderCodex)
	session.ProviderSessionID = "codex-session-1"

	events := standardACPUpdateEvents(standardACPConfig{provider: ProviderCodex}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "agent_thought_chunk",
			"content": {
				"type": "text",
				"text": "Reconnecting... 1/5 Some(ResponseStreamDisconnected { http_status_code: None })"
			}
		}
	}`), newACPTurnNormalizer())

	if len(events) != 1 {
		t.Fatalf("events = %#v, want one system notice message", events)
	}
	if got := events[0].Payload.Metadata["kind"]; got != "agent_system_notice" {
		t.Fatalf("notice kind marker = %#v, want agent_system_notice", got)
	}
	if got := events[0].Payload.Metadata["noticeKind"]; got != "transport_retry" {
		t.Fatalf("noticeKind = %#v, want transport_retry", got)
	}
}

func TestStandardACPConfigOptionUpdateSignalsSessionStateReload(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "claude-session-1"

	events := standardACPUpdateEvents(standardACPClaudeCodeConfig(), session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "config_option_update",
			"key": "model",
			"value": "opus"
		}
	}`), newACPTurnNormalizer())

	if len(events) != 1 {
		t.Fatalf("events = %#v, want one session update signal", events)
	}
	if events[0].Type != activityshared.EventSessionUpdated {
		t.Fatalf("event type = %q, want session updated", events[0].Type)
	}
	if got := events[0].Payload.Metadata["acpSessionUpdate"]; got != "config_option_update" {
		t.Fatalf("metadata acpSessionUpdate = %#v, want config_option_update", got)
	}
	if got := events[0].Payload.Metadata["configOptionKey"]; got != "model" {
		t.Fatalf("metadata configOptionKey = %#v, want model", got)
	}
}

func standardACPClaudeCodeConfig() standardACPConfig {
	return standardACPConfig{provider: ProviderClaudeCode}
}

func TestClaudeCodeAdapterStartAppliesDontAskMode(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-default")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.PermissionModeID = "dontAsk"

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if transport.conn.lastModeID() != "dontAsk" {
		t.Fatalf("mode id = %q, want dontAsk", transport.conn.lastModeID())
	}
}

func TestClaudeCodeAdapterStartAppliesDefaultMode(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-auto")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.PermissionModeID = "default"

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if transport.conn.lastModeID() != "default" {
		t.Fatalf("mode id = %q, want default", transport.conn.lastModeID())
	}
}

func TestClaudeCodeAdapterStartExposesReviewCommandBaseline(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-review")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	snapshot, ok := adapter.SessionCommandSnapshot(session)
	if !ok {
		t.Fatal("SessionCommandSnapshot ok=false, want Claude Code review baseline")
	}
	names := agentSessionCommandNames(snapshot.Commands)
	for _, want := range []string{"review", "compact"} {
		if !containsString(names, want) {
			t.Fatalf("commands = %#v, want %q", names, want)
		}
	}

	state := adapter.SessionState(session)
	commands, _ := state.RuntimeContext["commands"].([]string)
	for _, want := range []string{"review", "compact"} {
		if !containsString(commands, want) {
			t.Fatalf("runtime context commands = %#v, want %q", commands, want)
		}
	}
	capabilities, _ := state.RuntimeContext["capabilities"].([]string)
	if !containsString(capabilities, "review") {
		t.Fatalf("capabilities = %#v, want review", capabilities)
	}
}

func TestClaudeCodeAdapterResumeExposesReviewCommandBaseline(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-review-resume")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "persisted-claude-session-id"

	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}

	snapshot, ok := adapter.SessionCommandSnapshot(session)
	if !ok {
		t.Fatal("SessionCommandSnapshot ok=false, want Claude Code review baseline")
	}
	names := agentSessionCommandNames(snapshot.Commands)
	for _, want := range []string{"review", "compact"} {
		if !containsString(names, want) {
			t.Fatalf("commands = %#v, want %q", names, want)
		}
	}
}

func TestClaudeCodeAdapterStartAppliesPlanMode(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-plan")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.PermissionModeID = "dontAsk"
	session.Settings = &SessionSettings{
		PermissionModeID: "dontAsk",
		PlanMode:         true,
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if transport.conn.lastModeID() != "plan" {
		t.Fatalf("mode id = %q, want plan", transport.conn.lastModeID())
	}
	meta, ok := transport.conn.lastNewSessionParams["_meta"].(map[string]any)
	if !ok {
		t.Fatalf("session/new missing _meta params snapshot")
	}
	claudeCode, ok := meta["claudeCode"].(map[string]any)
	if !ok {
		t.Fatalf("claudeCode = %#v, want map", meta["claudeCode"])
	}
	options, ok := claudeCode["options"].(map[string]any)
	if !ok {
		t.Fatalf("claudeCode.options = %#v, want map", claudeCode["options"])
	}
	instructions, ok := options["planModeInstructions"].(string)
	if !ok || !strings.Contains(instructions, "do not edit files") || !strings.Contains(instructions, "implementation plan") {
		t.Fatalf("planModeInstructions = %#v, want Tutti plan workflow instructions", options["planModeInstructions"])
	}
	disallowedTools, ok := options["disallowedTools"].([]any)
	monitorDisallowed := false
	for _, tool := range disallowedTools {
		monitorDisallowed = monitorDisallowed || asString(tool) == "Monitor"
	}
	if !ok || !monitorDisallowed {
		t.Fatalf("disallowedTools = %#v, want Monitor disabled", options["disallowedTools"])
	}
}

func TestClaudeCodeAdapterApplySessionSettingsTogglesPlanMode(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-plan-toggle")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.PermissionModeID = "default"
	session.Settings = &SessionSettings{
		PermissionModeID: "default",
		PlanMode:         false,
	}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	planMode := true
	session.ProviderSessionID = "claude-session-plan-toggle"
	session.Settings.PlanMode = planMode
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		PlanMode: &planMode,
	}); err != nil {
		t.Fatalf("ApplySessionSettings plan on: %v", err)
	}
	if transport.conn.lastModeID() != "plan" {
		t.Fatalf("mode id = %q, want plan", transport.conn.lastModeID())
	}

	planMode = false
	session.Settings.PlanMode = planMode
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		PlanMode: &planMode,
	}); err != nil {
		t.Fatalf("ApplySessionSettings plan off: %v", err)
	}
	if transport.conn.lastModeID() != "default" {
		t.Fatalf("mode id = %q, want default", transport.conn.lastModeID())
	}
}

func TestClaudeCodeAdapterStartAppliesBypassPermissionsMode(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-full-access")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.PermissionModeID = "bypassPermissions"

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if transport.conn.lastModeID() != "bypassPermissions" {
		t.Fatalf("mode id = %q, want bypassPermissions", transport.conn.lastModeID())
	}
}

func TestClaudeCodeAdapterStartEnablesSandboxBypassEnv(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-sandbox-env")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.PermissionModeID = "bypassPermissions"

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	if !containsString(transport.specs[0].Env, "IS_SANDBOX=1") {
		t.Fatalf("env = %#v, want IS_SANDBOX=1 for Claude ACP bypassPermissions availability", transport.specs[0].Env)
	}
}

func TestClaudeCodeAdapterStartFailsWhenPermissionModeRejected(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-mode-error")
	transport.conn.setModeError = &acpError{
		Code:    -32602,
		Message: "Mode bypassPermissions is not available in this session",
	}
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.PermissionModeID = "bypassPermissions"

	if _, err := adapter.Start(context.Background(), session); err == nil {
		t.Fatal("Start() error = nil, want permission mode rejection")
	}
}

func TestClaudeCodeACPModeIDMapsPermissionModes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "empty", input: "", want: ""},
		{name: "default", input: "default", want: "default"},
		{name: "accept edits", input: "acceptEdits", want: "acceptEdits"},
		{name: "dont ask", input: "dontAsk", want: "dontAsk"},
		{name: "bypass permissions", input: "bypassPermissions", want: "bypassPermissions"},
		{name: "unexpected", input: "unexpected", want: ""},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			if got := claudeCodeACPModeID(tt.input); got != tt.want {
				t.Fatalf("claudeCodeACPModeID(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestClaudeCodeAdapterInitializeDeclaresTerminalAuthCapabilities(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-init")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	params := transport.conn.lastInitializeParams()
	if params == nil {
		t.Fatal("initialize params = nil, want snapshot")
	}
	clientCapabilities, ok := params["clientCapabilities"].(map[string]any)
	if !ok {
		t.Fatalf("clientCapabilities = %#v, want map", params["clientCapabilities"])
	}
	if got, _ := clientCapabilities["terminal"].(bool); !got {
		t.Fatalf("terminal capability = %#v, want true", clientCapabilities["terminal"])
	}
	authCapabilities, ok := clientCapabilities["auth"].(map[string]any)
	if !ok {
		t.Fatalf("auth capabilities = %#v, want map", clientCapabilities["auth"])
	}
	if got, _ := authCapabilities["terminal"].(bool); !got {
		t.Fatalf("auth.terminal = %#v, want true", authCapabilities["terminal"])
	}
	fsCapabilities, ok := clientCapabilities["fs"].(map[string]any)
	if !ok {
		t.Fatalf("fs capabilities = %#v, want map", clientCapabilities["fs"])
	}
	if got, _ := fsCapabilities["readTextFile"].(bool); !got {
		t.Fatalf("fs.readTextFile = %#v, want true", fsCapabilities["readTextFile"])
	}
	if got, _ := fsCapabilities["writeTextFile"].(bool); !got {
		t.Fatalf("fs.writeTextFile = %#v, want true", fsCapabilities["writeTextFile"])
	}
	metaCapabilities, ok := clientCapabilities["_meta"].(map[string]any)
	if !ok {
		t.Fatalf("_meta capabilities = %#v, want map", clientCapabilities["_meta"])
	}
	if got, _ := metaCapabilities["terminal_output"].(bool); !got {
		t.Fatalf("_meta.terminal_output = %#v, want true", metaCapabilities["terminal_output"])
	}
	if got, _ := metaCapabilities["terminal-auth"].(bool); !got {
		t.Fatalf("_meta.terminal-auth = %#v, want true", metaCapabilities["terminal-auth"])
	}
}

func TestClaudeCodeAdapterStartAppendsSessionScopedSystemPrompt(t *testing.T) {
	t.Parallel()

	systemPromptPath := filepath.Join(t.TempDir(), "claude-system-prompt.md")
	if err := os.WriteFile(systemPromptPath, []byte("Use Tutti CLI for issue context."), 0o600); err != nil {
		t.Fatal(err)
	}
	pluginDir := filepath.Join(t.TempDir(), "tutti-cli-plugin")
	if err := os.MkdirAll(pluginDir, 0o700); err != nil {
		t.Fatal(err)
	}
	transport := newStandardACPTransport("Claude Agent", "claude-session-system-prompt")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.PermissionModeID = "default"
	session.Env = []string{
		claudeSystemPromptFileEnv + "=" + systemPromptPath,
		claudePluginDirEnv + "=" + pluginDir,
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	meta, ok := transport.conn.lastNewSessionParams["_meta"].(map[string]any)
	if !ok {
		t.Fatalf("session/new missing _meta params snapshot")
	}
	systemPrompt, ok := meta["systemPrompt"].(map[string]any)
	if !ok {
		t.Fatalf("systemPrompt = %#v, want map", meta["systemPrompt"])
	}
	if got, _ := systemPrompt["type"].(string); got != "preset" {
		t.Fatalf("systemPrompt.type = %q, want preset", got)
	}
	if got, _ := systemPrompt["preset"].(string); got != "claude_code" {
		t.Fatalf("systemPrompt.preset = %q, want claude_code", got)
	}
	if got, _ := systemPrompt["append"].(string); got != "Use Tutti CLI for issue context." {
		t.Fatalf("systemPrompt.append = %q, want prompt file content", got)
	}
	claudeCode, ok := meta["claudeCode"].(map[string]any)
	if !ok {
		t.Fatalf("claudeCode = %#v, want map", meta["claudeCode"])
	}
	options, ok := claudeCode["options"].(map[string]any)
	if !ok {
		t.Fatalf("claudeCode.options = %#v, want map", claudeCode["options"])
	}
	plugins, ok := options["plugins"].([]any)
	if !ok || len(plugins) != 1 {
		t.Fatalf("claudeCode.options.plugins = %#v, want local plugin list", options["plugins"])
	}
	plugin, _ := plugins[0].(map[string]any)
	if got, _ := plugin["type"].(string); got != "local" {
		t.Fatalf("claudeCode.options.plugins = %#v, want local plugin type", plugins)
	}
	if got, _ := plugin["path"].(string); got != pluginDir {
		t.Fatalf("claudeCode.options.plugins = %#v, want local plugin path %q", plugins, pluginDir)
	}
	filters, ok := claudeCode["emitRawSDKMessages"].([]any)
	if !ok || len(filters) != 2 {
		t.Fatalf("claudeCode.emitRawSDKMessages = %#v, want system/init + result filters", claudeCode["emitRawSDKMessages"])
	}
	filter, _ := filters[0].(map[string]any)
	if got, _ := filter["type"].(string); got != "system" {
		t.Fatalf("claudeCode.emitRawSDKMessages = %#v, want system init filter first", filters)
	}
	if got, _ := filter["subtype"].(string); got != "init" {
		t.Fatalf("claudeCode.emitRawSDKMessages = %#v, want system init filter first", filters)
	}
	emittedTypes := map[string]bool{}
	for _, f := range filters {
		m, _ := f.(map[string]any)
		emittedTypes[asString(m["type"])] = true
	}
	for _, want := range []string{"system", "result"} {
		if !emittedTypes[want] {
			t.Fatalf("claudeCode.emitRawSDKMessages = %#v, want %q included for auth-failure capture", filters, want)
		}
	}
	instructions, ok := options["planModeInstructions"].(string)
	if !ok || !strings.Contains(instructions, "do not edit files") || !strings.Contains(instructions, "implementation plan") {
		t.Fatalf("planModeInstructions = %#v, want Tutti plan workflow instructions", options["planModeInstructions"])
	}
}

func TestClaudeCodeAdapterExecAddsInternalMentionRoutingPromptOnlyForProvider(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-mention-routing")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.PermissionModeID = "default"
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	prompt := "[@User & Codex story](mention://agent-session/session-1?workspaceId=workspace-1&provider=codex) 这里有什么内容？"

	events, err := adapter.Exec(context.Background(), session, textPrompt(prompt), "", "turn-mention", func([]activityshared.Event) {}, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	texts := promptTexts(t, transport.conn.lastPromptParamsSnapshot)
	if len(texts) < 2 {
		t.Fatalf("prompt texts = %#v, want internal routing plus user prompt", texts)
	}
	if !strings.Contains(texts[0], "Claude Code mention handoff routing for this user turn:") ||
		!strings.Contains(texts[0], "Skill(skill=\"tutti-cli:tutti-cli\")") {
		t.Fatalf("routing prompt = %q, want internal Claude mention routing", texts[0])
	}
	if texts[1] != prompt {
		t.Fatalf("user prompt text = %q, want unmodified prompt %q", texts[1], prompt)
	}
	userContent := firstUserMessageContent(t, events)
	if !strings.Contains(userContent, prompt) ||
		strings.Contains(userContent, "Claude Code mention handoff routing") {
		t.Fatalf("user activity event = %#v, want original user prompt only", events)
	}
}

func TestClaudeCodeAdapterExecRoutesWorkspaceReferenceMention(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-workspace-reference-routing")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.PermissionModeID = "default"
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	prompt := "请读取 [@设计稿](mention://workspace-reference/app-1?source=app&workspaceId=workspace-1&groupId=group-1)"

	if _, err := adapter.Exec(context.Background(), session, textPrompt(prompt), "", "turn-reference", func([]activityshared.Event) {}, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}

	texts := promptTexts(t, transport.conn.lastPromptParamsSnapshot)
	if len(texts) < 2 {
		t.Fatalf("prompt texts = %#v, want internal routing plus user prompt", texts)
	}
	if !strings.Contains(texts[0], "Skill(skill=\"tutti-cli:reference\")") {
		t.Fatalf("routing prompt = %q, want reference skill routing", texts[0])
	}
	if texts[1] != prompt {
		t.Fatalf("user prompt text = %q, want unmodified prompt %q", texts[1], prompt)
	}
}

func TestStandardACPAdapterExecDoesNotPrependClaudeMentionRoutingForGemini(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Gemini CLI", "gemini-session-mention-routing")
	adapter := NewGeminiAdapter(transport)
	session := standardTestSession(ProviderGemini)
	session.PermissionModeID = "full-access"
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	prompt := "[@User & Codex story](mention://agent-session/session-1?workspaceId=workspace-1&provider=codex) 这里有什么内容？"

	if _, err := adapter.Exec(context.Background(), session, textPrompt(prompt), "", "turn-mention", func([]activityshared.Event) {}, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}

	text := firstPromptText(t, transport.conn.lastPromptParamsSnapshot)
	if text != prompt {
		t.Fatalf("prompt text = %q, want unmodified prompt %q", text, prompt)
	}
}

func TestClaudeCodeAdapterMirrorsGoalSlashPromptIntoRuntimeContext(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-goal")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	prompt := "/goal ship native goal"
	events, err := adapter.Exec(context.Background(), session, textPrompt(prompt), "", "turn-goal", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if len(activityEventsWithType(events, activityshared.EventSessionUpdated)) == 0 {
		t.Fatalf("events = %#v, want session.updated for goal mirror", events)
	}
	if text := firstPromptText(t, transport.conn.lastPromptParamsSnapshot); text != prompt {
		t.Fatalf("prompt text = %q, want original prompt %q", text, prompt)
	}
	snapshot := adapter.SessionState(session)
	goal := payloadObject(snapshot.RuntimeContext["goal"])
	if asString(goal["objective"]) != "ship native goal" || asString(goal["status"]) != "active" {
		t.Fatalf("runtime goal = %#v, want active objective", goal)
	}

	if _, err := adapter.Exec(context.Background(), session, textPrompt("/goal clear"), "", "turn-clear", nil, nil); err != nil {
		t.Fatalf("Exec clear: %v", err)
	}
	snapshot = adapter.SessionState(session)
	if goal := payloadObject(snapshot.RuntimeContext["goal"]); len(goal) != 0 {
		t.Fatalf("runtime goal after clear = %#v, want empty", goal)
	}
}

func TestClaudeCodeAdapterMirrorsSDKGoalStatusIntoRuntimeContext(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-sdk-goal")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	activeRaw, err := json.Marshal(map[string]any{
		"message": map[string]any{
			"type": "attachment",
			"attachment": map[string]any{
				"type":      "goal_status",
				"met":       false,
				"sentinel":  true,
				"condition": "ship native goal",
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal active goal status: %v", err)
	}
	events, err := adapter.handleACPMessage(context.Background(), nil, session, "turn-goal", acpMessage{
		Method: claudeSDKMessageMethod,
		Params: activeRaw,
	}, nil, nil, nil)
	if err != nil {
		t.Fatalf("handle active goal status: %v", err)
	}
	if len(activityEventsWithType(events, activityshared.EventSessionUpdated)) == 0 {
		t.Fatalf("events = %#v, want session.updated for SDK goal status", events)
	}
	snapshot := adapter.SessionState(session)
	goal := payloadObject(snapshot.RuntimeContext["goal"])
	if asString(goal["objective"]) != "ship native goal" || asString(goal["status"]) != "active" || goal["sentinel"] != true {
		t.Fatalf("runtime goal = %#v, want active SDK goal status", goal)
	}

	completeRaw, err := json.Marshal(map[string]any{
		"message": map[string]any{
			"type": "attachment",
			"attachment": map[string]any{
				"type":       "goal_status",
				"met":        true,
				"condition":  "ship native goal",
				"reason":     "done",
				"iterations": float64(1),
				"durationMs": float64(42),
				"tokens":     float64(123),
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal complete goal status: %v", err)
	}
	if _, err := adapter.handleACPMessage(context.Background(), nil, session, "turn-goal", acpMessage{
		Method: claudeSDKMessageMethod,
		Params: completeRaw,
	}, nil, nil, nil); err != nil {
		t.Fatalf("handle complete goal status: %v", err)
	}
	snapshot = adapter.SessionState(session)
	goal = payloadObject(snapshot.RuntimeContext["goal"])
	if asString(goal["objective"]) != "ship native goal" || asString(goal["status"]) != "complete" || asString(goal["reason"]) != "done" {
		t.Fatalf("runtime goal = %#v, want complete SDK goal status", goal)
	}

	topLevelRaw, err := json.Marshal(map[string]any{
		"type": "attachment",
		"attachment": map[string]any{
			"type":      "goal_status",
			"met":       true,
			"condition": "ship native goal from transcript",
			"reason":    "top-level done",
		},
	})
	if err != nil {
		t.Fatalf("marshal top-level goal status: %v", err)
	}
	events, err = adapter.handleACPMessage(context.Background(), nil, session, "turn-goal", acpMessage{
		Method: claudeSDKMessageMethod,
		Params: topLevelRaw,
	}, nil, nil, nil)
	if err != nil {
		t.Fatalf("handle top-level goal status: %v", err)
	}
	if len(activityEventsWithType(events, activityshared.EventSessionUpdated)) == 0 {
		t.Fatalf("events = %#v, want session.updated for top-level SDK goal status", events)
	}
	snapshot = adapter.SessionState(session)
	goal = payloadObject(snapshot.RuntimeContext["goal"])
	if asString(goal["objective"]) != "ship native goal from transcript" || asString(goal["status"]) != "complete" || asString(goal["reason"]) != "top-level done" {
		t.Fatalf("runtime goal = %#v, want complete top-level SDK goal status", goal)
	}
}

func firstPromptText(t *testing.T, params map[string]any) string {
	t.Helper()
	texts := promptTexts(t, params)
	if len(texts) == 0 {
		t.Fatalf("prompt params = %#v, want prompt text", params)
	}
	return texts[0]
}

func promptTexts(t *testing.T, params map[string]any) []string {
	t.Helper()
	items, ok := params["prompt"].([]any)
	if !ok || len(items) == 0 {
		t.Fatalf("prompt params = %#v, want prompt items", params)
	}
	texts := make([]string, 0, len(items))
	for _, item := range items {
		block, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("prompt item = %#v, want map", item)
		}
		text, ok := block["text"].(string)
		if !ok {
			continue
		}
		texts = append(texts, text)
	}
	return texts
}

func firstUserMessageContent(t *testing.T, events []activityshared.Event) string {
	t.Helper()
	for _, event := range events {
		if event.Type == activityshared.EventMessageAppended && event.Payload.Role == activityshared.MessageRoleUser {
			return event.Payload.Content
		}
	}
	t.Fatalf("events = %#v, want user message event", events)
	return ""
}

func TestClaudeCodeAdapterStartFailsWhenSystemPromptFileIsMissing(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-missing-system-prompt")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.Env = []string{claudeSystemPromptFileEnv + "=" + filepath.Join(t.TempDir(), "missing.md")}

	if _, err := adapter.Start(context.Background(), session); err == nil {
		t.Fatal("Start() error = nil, want missing system prompt error")
	} else if !strings.Contains(err.Error(), "read claude system prompt") {
		t.Fatalf("Start() error = %v, want read claude system prompt", err)
	}
}

func TestClaudeCodeAdapterStartFailsWhenPluginDirIsMissing(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-missing-plugin")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.Env = []string{claudePluginDirEnv + "=" + filepath.Join(t.TempDir(), "missing-plugin")}

	if _, err := adapter.Start(context.Background(), session); err == nil {
		t.Fatal("Start() error = nil, want missing plugin dir error")
	} else if !strings.Contains(err.Error(), "stat claude plugin dir") {
		t.Fatalf("Start() error = %v, want stat claude plugin dir", err)
	}
}

func TestClaudeCodeAdapterStartAppliesModelAndReasoningConfigOptions(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-model")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.Env = []string{"ANTHROPIC_BASE_URL=https://anthropic.proxy.test"}
	session.Settings = &SessionSettings{
		Model:           "sonnet",
		ReasoningEffort: "high",
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	calls := transport.conn.setConfigOptionCalls()
	if len(calls) != 2 {
		t.Fatalf("config option calls = %#v, want model + effort", calls)
	}
	if got, _ := calls[0]["configId"].(string); got != "model" {
		t.Fatalf("first config id = %q, want model", got)
	}
	if got, _ := calls[0]["value"].(string); got != "sonnet" {
		t.Fatalf("first config value = %q, want sonnet", got)
	}
	if got, _ := calls[1]["configId"].(string); got != "effort" {
		t.Fatalf("second config id = %q, want effort", got)
	}
	if got, _ := calls[1]["value"].(string); got != "high" {
		t.Fatalf("second config value = %q, want high", got)
	}
}

func TestClaudeCodeAdapterResumeAppliesModelAndReasoningConfigOptions(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-resume")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "persisted-claude-session-1"
	session.Settings = &SessionSettings{
		Model:           "sonnet",
		ReasoningEffort: "high",
	}

	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}

	calls := transport.conn.setConfigOptionCalls()
	if len(calls) != 2 {
		t.Fatalf("config option calls = %#v, want model + effort", calls)
	}
}

func TestClaudeCodeAdapterApplySessionSettingsUpdatesLiveACPConfig(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-live")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.PermissionModeID = "full-access"

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	session.Settings = &SessionSettings{
		Model:            "sonnet",
		ReasoningEffort:  "low",
		PermissionModeID: "full-access",
	}
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		Model:           stringPtr("sonnet"),
		ReasoningEffort: stringPtr("low"),
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	calls := transport.conn.setConfigOptionCalls()
	if len(calls) != 2 {
		t.Fatalf("config option calls = %#v, want model + effort", calls)
	}

	snapshot := adapter.SessionState(session)
	if snapshot.Settings == nil {
		t.Fatal("snapshot settings = nil, want live ACP settings")
	}
	if snapshot.Settings.Model != "sonnet" {
		t.Fatalf("snapshot settings model = %q, want sonnet", snapshot.Settings.Model)
	}
	if snapshot.Settings.ReasoningEffort != "low" {
		t.Fatalf("snapshot settings reasoning = %q, want low", snapshot.Settings.ReasoningEffort)
	}
}

func TestClaudeCodeAdapterApplySessionSettingsSkipsUnchangedLiveACPConfig(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-live")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	adapter.updateSessionConfigOption(session.AgentSessionID, "effort", "low")

	session.Settings = &SessionSettings{ReasoningEffort: "low"}
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		ReasoningEffort: stringPtr("low"),
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	if calls := transport.conn.setConfigOptionCalls(); len(calls) != 0 {
		t.Fatalf("config option calls = %#v, want unchanged live effort no-op", calls)
	}
}

func TestClaudeCodeAdapterApplySessionSettingsSendsChangedLiveACPConfig(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-live")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	adapter.updateSessionConfigOption(session.AgentSessionID, "effort", "high")

	session.Settings = &SessionSettings{ReasoningEffort: "low"}
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		ReasoningEffort: stringPtr("low"),
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	calls := transport.conn.setConfigOptionCalls()
	if len(calls) != 1 {
		t.Fatalf("config option calls = %#v, want changed live effort update", calls)
	}
	if got, _ := calls[0]["value"].(string); got != "low" {
		t.Fatalf("effort config value = %q, want low", got)
	}
}

func TestClaudeCodeAdapterApplySessionSettingsSkipsUnsupportedLiveSpeedConfig(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-live-speed-unsupported")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	session.Settings = &SessionSettings{Speed: "fast"}
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		Speed: stringPtr("fast"),
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	if calls := transport.conn.setConfigOptionCalls(); len(calls) != 0 {
		t.Fatalf("config option calls = %#v, want unsupported live speed no-op", calls)
	}
}

func TestClaudeCodeAdapterApplySessionSettingsSendsAdvertisedLiveSpeedConfig(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-live-speed-supported")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	adapter.applyACPUpdate(session.AgentSessionID, json.RawMessage(`{
		"update": {
			"sessionUpdate": "config_option_update",
			"key": "fast",
			"value": "standard",
			"configOptions": [
				{
					"id": "fast",
					"currentValue": "standard",
					"options": [
						{"value": "standard", "name": "Standard"},
						{"value": "fast", "name": "Fast"}
					]
				}
			]
		}
	}`))

	session.Settings = &SessionSettings{Speed: "fast"}
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		Speed: stringPtr("fast"),
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	calls := transport.conn.setConfigOptionCalls()
	if len(calls) != 1 {
		t.Fatalf("config option calls = %#v, want advertised live speed update", calls)
	}
	if got, _ := calls[0]["configId"].(string); got != "fast" {
		t.Fatalf("config id = %q, want fast", got)
	}
	if got, _ := calls[0]["value"].(string); got != "fast" {
		t.Fatalf("config value = %q, want fast", got)
	}
}

func TestClaudeCodeAdapterStartSkipsCustomModelConfigOption(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-custom-model")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.Env = []string{"ANTHROPIC_BASE_URL=https://anthropic.proxy.test"}
	session.Settings = &SessionSettings{
		Model:           "MiniMax-M2.7",
		ReasoningEffort: "high",
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	if containsString(transport.specs[0].Env, "ANTHROPIC_MODEL=MiniMax-M2.7") {
		t.Fatalf("env = %#v, want selected custom model passed as Claude Code --model arg", transport.specs[0].Env)
	}
	meta, ok := transport.conn.lastNewSessionParams["_meta"].(map[string]any)
	if !ok {
		t.Fatalf("session/new missing _meta params snapshot")
	}
	claudeCode, ok := meta["claudeCode"].(map[string]any)
	if !ok {
		t.Fatalf("claudeCode = %#v, want map", meta["claudeCode"])
	}
	options, ok := claudeCode["options"].(map[string]any)
	if !ok {
		t.Fatalf("claudeCode.options = %#v, want map", claudeCode["options"])
	}
	extraArgs, ok := options["extraArgs"].(map[string]any)
	if !ok {
		t.Fatalf("claudeCode.options.extraArgs = %#v, want map", options["extraArgs"])
	}
	if got, _ := extraArgs["model"].(string); got != "MiniMax-M2.7" {
		t.Fatalf("claudeCode.options.extraArgs.model = %q, want MiniMax-M2.7", got)
	}
	calls := transport.conn.setConfigOptionCalls()
	if len(calls) != 1 {
		t.Fatalf("config option calls = %#v, want effort only", calls)
	}
	if got, _ := calls[0]["configId"].(string); got != "effort" {
		t.Fatalf("config id = %q, want effort", got)
	}
	if got, _ := calls[0]["value"].(string); got != "high" {
		t.Fatalf("config value = %q, want high", got)
	}
}

func TestClaudeCodeAdapterSessionStateKeepsCustomModelOverLiveACPModel(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-custom-state-model")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.Settings = &SessionSettings{
		Model:           "MiniMax-M2.7",
		ReasoningEffort: "high",
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	adapter.applyACPUpdate(session.AgentSessionID, json.RawMessage(`{
		"update": {
			"sessionUpdate": "config_option_update",
			"key": "model",
			"value": "opus"
		}
	}`))

	snapshot := adapter.SessionState(session)
	if snapshot.Settings == nil {
		t.Fatal("snapshot settings = nil, want launch custom model settings")
	}
	if snapshot.Settings.Model != "MiniMax-M2.7" {
		t.Fatalf("snapshot settings model = %q, want MiniMax-M2.7", snapshot.Settings.Model)
	}
	if got := asString(snapshot.RuntimeContext["model"]); got != "MiniMax-M2.7" {
		t.Fatalf("runtime context model = %q, want MiniMax-M2.7", got)
	}
}

func TestClaudeCodeAdapterSessionStateHidesDirectCustomModelOption(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-direct-custom-option")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.Settings = &SessionSettings{
		Model:           "haiku",
		ReasoningEffort: "high",
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	adapter.applyACPUpdate(session.AgentSessionID, json.RawMessage(`{
		"update": {
			"sessionUpdate": "config_option_update",
			"key": "model",
			"value": "haiku",
			"configOptions": [
				{
					"id": "model",
					"currentValue": "haiku",
					"options": [
						{"value": "default", "name": "Default (recommended)", "description": "Opus 4.8 with 1M context"},
						{"value": "opus", "name": "MiniMax-M2.7", "description": "Custom Opus model"},
						{"value": "sonnet", "name": "MiniMax-M2.7", "description": "Custom Sonnet model"},
						{"value": "haiku", "name": "MiniMax-M2.7", "description": "Custom Haiku model"},
						{"value": "MiniMax-M2.7", "name": "MiniMax-M2.7", "description": "Custom model"}
					]
				}
			]
		}
	}`))

	snapshot := adapter.SessionState(session)
	configOptions, ok := snapshot.RuntimeContext["configOptions"].([]map[string]any)
	if !ok {
		t.Fatalf("runtime configOptions = %#v, want descriptors", snapshot.RuntimeContext["configOptions"])
	}
	modelOptions := configOptionDescriptorValues(configOptions, "model")
	if containsString(modelOptions, "MiniMax-M2.7") {
		t.Fatalf("model options = %#v, want direct custom model hidden", modelOptions)
	}
	for _, want := range []string{"default", "opus", "sonnet", "haiku"} {
		if !containsString(modelOptions, want) {
			t.Fatalf("model options = %#v, missing %q", modelOptions, want)
		}
	}
	if got := configOptionDescriptorOptionDescription(configOptions, "model", "default"); got != "Opus 4.8 with 1M context" {
		t.Fatalf("default model description = %q, want Opus 4.8 with 1M context", got)
	}
	if got := configOptionDescriptorOptionDescription(configOptions, "model", "opus"); got != "Custom Opus model" {
		t.Fatalf("opus model description = %q, want Custom Opus model", got)
	}
}

func TestClaudeCodeAdapterApplySessionSettingsRejectsCustomModel(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-live-custom-model")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.Settings = &SessionSettings{
		Model: "sonnet",
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		Model: stringPtr("MiniMax-M2.7"),
	})
	if err == nil {
		t.Fatal("ApplySessionSettings: expected error for Claude custom model update")
	}
	if !strings.Contains(err.Error(), "require a new session") {
		t.Fatalf("ApplySessionSettings error = %q, want custom-model restart guidance", err)
	}

	calls := transport.conn.setConfigOptionCalls()
	if len(calls) != 1 {
		t.Fatalf("config option calls = %#v, want startup model call only", calls)
	}
	if got, _ := calls[0]["configId"].(string); got != "model" {
		t.Fatalf("config id = %q, want model", got)
	}
	if got, _ := calls[0]["value"].(string); got != "sonnet" {
		t.Fatalf("config value = %q, want sonnet", got)
	}
}

func TestClaudeCodeAdapterApplySessionSettingsSwitchesToAdvertisedModel(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-advertised-model")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.Settings = &SessionSettings{
		Model: "sonnet",
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	// The live agent advertises a concrete model id (e.g. Opus 4.6) that is
	// not one of the static aliases.
	adapter.applyACPUpdate(session.AgentSessionID, json.RawMessage(`{
		"update": {
			"sessionUpdate": "config_option_update",
			"key": "model",
			"value": "default",
			"configOptions": [
				{
					"id": "model",
					"currentValue": "default",
					"options": [
						{"value": "default", "name": "Default"},
						{"value": "claude-opus-4-6", "name": "Opus 4.6"}
					]
				}
			]
		}
	}`))

	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		Model: stringPtr("claude-opus-4-6"),
	}); err != nil {
		t.Fatalf("ApplySessionSettings should switch to an advertised model, got: %v", err)
	}

	calls := transport.conn.setConfigOptionCalls()
	if len(calls) == 0 {
		t.Fatal("config option calls = none, want an advertised model switch call")
	}
	last := calls[len(calls)-1]
	if got, _ := last["configId"].(string); got != "model" {
		t.Fatalf("config id = %q, want model", got)
	}
	if got, _ := last["value"].(string); got != "claude-opus-4-6" {
		t.Fatalf("config value = %q, want claude-opus-4-6", got)
	}
}

func TestClaudeCodeAdapterApplySessionSettingsRemapsLegacyOpusToDefault(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-legacy-opus")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.Settings = &SessionSettings{
		Model: "haiku",
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Mirrors claude-agent-acp 0.42+ live model options: Opus is "default",
	// the legacy "opus" alias is no longer accepted.
	adapter.applyACPUpdate(session.AgentSessionID, json.RawMessage(`{
		"update": {
			"sessionUpdate": "config_option_update",
			"key": "model",
			"value": "haiku",
			"configOptions": [
				{
					"id": "model",
					"currentValue": "haiku",
					"options": [
						{"value": "default", "name": "Default (recommended)"},
						{"value": "sonnet", "name": "Sonnet"},
						{"value": "sonnet[1m]", "name": "Sonnet (1M context)"},
						{"value": "haiku", "name": "Haiku"}
					]
				}
			]
		}
	}`))

	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		Model: stringPtr("opus"),
	}); err != nil {
		t.Fatalf("ApplySessionSettings should remap legacy opus to default, got: %v", err)
	}

	calls := transport.conn.setConfigOptionCalls()
	if len(calls) == 0 {
		t.Fatal("config option calls = none, want remapped default model switch call")
	}
	last := calls[len(calls)-1]
	if got, _ := last["configId"].(string); got != "model" {
		t.Fatalf("config id = %q, want model", got)
	}
	if got, _ := last["value"].(string); got != "default" {
		t.Fatalf("config value = %q, want default", got)
	}
}

func TestClaudeCodeAdapterApplySessionSettingsRemapsLegacyOpusToOpus1M(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-legacy-opus-1m")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.Settings = &SessionSettings{
		Model: "haiku",
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Mirrors claude-agent-acp 0.46 live model options on Claude Code 2.1.x.
	adapter.applyACPUpdate(session.AgentSessionID, json.RawMessage(`{
		"update": {
			"sessionUpdate": "config_option_update",
			"key": "model",
			"value": "haiku",
			"configOptions": [
				{
					"id": "model",
					"currentValue": "haiku",
					"options": [
						{"value": "default", "name": "Default (recommended)"},
						{"value": "opus[1m]", "name": "Opus"},
						{"value": "sonnet", "name": "Sonnet"},
						{"value": "sonnet[1m]", "name": "Sonnet (1M context)"},
						{"value": "haiku", "name": "Haiku"}
					]
				}
			]
		}
	}`))

	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		Model: stringPtr("opus"),
	}); err != nil {
		t.Fatalf("ApplySessionSettings should remap legacy opus to opus[1m], got: %v", err)
	}

	calls := transport.conn.setConfigOptionCalls()
	last := calls[len(calls)-1]
	if got, _ := last["value"].(string); got != "opus[1m]" {
		t.Fatalf("config value = %q, want opus[1m]", got)
	}
}

func TestClaudeCodeAdapterStartToleratesRejectedModelConfig(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-reject-model")
	transport.conn.rejectModelValue = "opus"
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.Settings = &SessionSettings{
		Model: "opus",
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start should tolerate a rejected model config option, got: %v", err)
	}

	if adapter.getSession(session.AgentSessionID) == nil {
		t.Fatal("session should remain live after a tolerated model rejection")
	}

	calls := transport.conn.setConfigOptionCalls()
	if len(calls) != 1 {
		t.Fatalf("config option calls = %#v, want one rejected model attempt", calls)
	}
	if got, _ := calls[0]["value"].(string); got != "opus" {
		t.Fatalf("config value = %q, want opus", got)
	}
}

func configOptionDescriptorValues(descriptors []map[string]any, configID string) []string {
	for _, descriptor := range descriptors {
		if strings.TrimSpace(asString(descriptor["id"])) != configID {
			continue
		}
		switch options := descriptor["options"].(type) {
		case []any:
			values := make([]string, 0, len(options))
			for _, option := range options {
				record, ok := option.(map[string]any)
				if !ok {
					continue
				}
				if value := strings.TrimSpace(asString(record["value"])); value != "" {
					values = append(values, value)
				}
			}
			return values
		case []map[string]any:
			values := make([]string, 0, len(options))
			for _, option := range options {
				if value := strings.TrimSpace(asString(option["value"])); value != "" {
					values = append(values, value)
				}
			}
			return values
		default:
			return nil
		}
	}
	return nil
}

func configOptionDescriptorOptionDescription(descriptors []map[string]any, configID string, value string) string {
	for _, descriptor := range descriptors {
		if strings.TrimSpace(asString(descriptor["id"])) != configID {
			continue
		}
		switch options := descriptor["options"].(type) {
		case []any:
			for _, option := range options {
				record, ok := option.(map[string]any)
				if !ok {
					continue
				}
				if strings.TrimSpace(asString(record["value"])) == value {
					return strings.TrimSpace(asString(record["description"]))
				}
			}
		case []map[string]any:
			for _, option := range options {
				if strings.TrimSpace(asString(option["value"])) == value {
					return strings.TrimSpace(asString(option["description"]))
				}
			}
		}
	}
	return ""
}

func TestClaudeCodeAdapterSessionStateIncludesLiveConfigUpdates(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-state")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.Env = []string{"ANTHROPIC_BASE_URL=https://anthropic.proxy.test"}
	session.Settings = &SessionSettings{
		Model:           "sonnet",
		ReasoningEffort: "high",
	}
	adapter.storeSession(session.AgentSessionID, &standardACPSession{
		providerSessionID: session.ProviderSessionID,
	})

	adapter.applyACPUpdate(session.AgentSessionID, json.RawMessage(`{
		"update": {
			"sessionUpdate": "config_option_update",
			"key": "model",
			"value": "opus"
		}
	}`))
	adapter.applyACPUpdate(session.AgentSessionID, json.RawMessage(`{
		"update": {
			"sessionUpdate": "config_option_update",
			"key": "effort",
			"value": "low"
		}
	}`))
	adapter.applyACPUpdate(session.AgentSessionID, json.RawMessage(`{
		"update": {
			"sessionUpdate": "usage_update",
			"contextWindow": {
				"usedTokens": "132881",
				"totalTokens": "258000"
			},
			"_meta": {
				"_claude/rateLimit": {
					"rate_limit_type": "five_hour",
					"resets_at": 1781187000,
					"utilization": 0.21
				}
			}
		}
	}`))
	adapter.applyACPUpdate(session.AgentSessionID, json.RawMessage(`{
		"update": {
			"sessionUpdate": "usage_update",
			"_meta": {
				"_claude/rateLimit": {
					"rate_limit_type": "seven_day",
					"resets_at": 1781705400,
					"utilization": 42
				}
			}
		}
	}`))

	snapshot := adapter.SessionState(session)
	if snapshot.Settings == nil {
		t.Fatal("snapshot settings = nil, want live ACP model settings")
	}
	if snapshot.Settings.Model != "opus" {
		t.Fatalf("snapshot settings model = %q, want opus", snapshot.Settings.Model)
	}
	if snapshot.Settings.ReasoningEffort != "low" {
		t.Fatalf("snapshot settings reasoning = %q, want low", snapshot.Settings.ReasoningEffort)
	}
	if got := asString(snapshot.RuntimeContext["model"]); got != "opus" {
		t.Fatalf("runtime context model = %q, want opus", got)
	}
	if got := asString(snapshot.RuntimeContext["reasoningEffort"]); got != "low" {
		t.Fatalf("runtime context reasoningEffort = %q, want low", got)
	}
	providerConfig, _ := snapshot.RuntimeContext["providerConfig"].(map[string]any)
	if got := asString(providerConfig["baseUrl"]); got != "https://anthropic.proxy.test" {
		t.Fatalf("runtime context providerConfig baseUrl = %q, want Claude base URL", got)
	}
	usage, _ := snapshot.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if got, ok := acpInt64Value(contextWindow["usedTokens"]); !ok || got != 132881 {
		t.Fatalf("runtime context usage usedTokens = %#v, want 132881", contextWindow["usedTokens"])
	}
	if got, ok := acpInt64Value(contextWindow["totalTokens"]); !ok || got != 258000 {
		t.Fatalf("runtime context usage totalTokens = %#v, want 258000", contextWindow["totalTokens"])
	}
	quotas, _ := usage["quotas"].([]map[string]any)
	if len(quotas) != 1 {
		t.Fatalf("runtime context usage quotas = %#v, want one Claude rate limit quota", usage["quotas"])
	}
	if got := asString(quotas[0]["quotaType"]); got != "weekly" {
		t.Fatalf("runtime context usage quotaType = %q, want weekly", got)
	}
	if got, ok := acpInt64Value(quotas[0]["percentRemaining"]); !ok || got != 58 {
		t.Fatalf("runtime context usage percentRemaining = %#v, want 58", quotas[0]["percentRemaining"])
	}
	if got, ok := acpInt64Value(quotas[0]["resetsAtUnixMs"]); !ok || got != 1781705400000 {
		t.Fatalf("runtime context usage resetsAtUnixMs = %#v, want 1781705400000", quotas[0]["resetsAtUnixMs"])
	}
}

func TestGeminiAdapterStartPreservesCommandsAdvertisedDuringNewSession(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Gemini CLI", "gemini-session-commands")
	transport.conn.commandUpdateOnNewSession = true
	adapter := NewGeminiAdapter(transport)
	session := standardTestSession(ProviderGemini)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	snapshot, ok := adapter.SessionCommandSnapshot(session)
	if !ok || len(snapshot.Commands) != 1 ||
		snapshot.Commands[0].Name != "web" ||
		snapshot.Commands[0].Description != "Search the web" ||
		snapshot.Commands[0].InputHint != "query" {
		t.Fatalf("command snapshot = %#v ok=%v, want command update preserved from session/new", snapshot, ok)
	}
}

func TestControllerPublishesIdleStandardACPCommandUpdatesAfterStart(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-idle-commands")
	adapter := NewClaudeCodeAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	session := standardTestSession(ProviderClaudeCode)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           session.RoomID,
		AgentSessionID:   session.AgentSessionID,
		Provider:         session.Provider,
		CWD:              session.CWD,
		PermissionModeID: session.PermissionModeID,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	stream, unsubscribe, ok := controller.Subscribe(started.Session.RoomID, started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe ok=false, want live session stream")
	}
	defer unsubscribe()

	transport.conn.sendAvailableCommandsUpdate()

	deadline := time.After(time.Second)
	for {
		select {
		case event := <-stream:
			if event.EventType != StreamEventAvailableCommands {
				continue
			}
			snapshot, ok := event.Data.(AgentSessionCommandSnapshot)
			if !ok {
				t.Fatalf("event data = %#v, want AgentSessionCommandSnapshot", event.Data)
			}
			if len(snapshot.Commands) == 1 && snapshot.Commands[0].Name == "web" {
				return
			}
		case <-deadline:
			t.Fatal("idle available_commands_update was not published")
		}
	}
}

func TestControllerPublishesIdleStandardACPGoalUpdatesAfterStart(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-idle-goal")
	adapter := NewClaudeCodeAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	session := standardTestSession(ProviderClaudeCode)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           session.RoomID,
		AgentSessionID:   session.AgentSessionID,
		Provider:         session.Provider,
		CWD:              session.CWD,
		PermissionModeID: session.PermissionModeID,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	stream, unsubscribe, ok := controller.Subscribe(started.Session.RoomID, started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe ok=false, want live session stream")
	}
	defer unsubscribe()

	transport.conn.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": transport.conn.sessionID,
			"update": map[string]any{
				"sessionUpdate": "thread_goal_update",
				"goal": map[string]any{
					"objective": "ship slash commands",
					"status":    "active",
				},
			},
		},
	})

	deadline := time.After(time.Second)
	for {
		select {
		case event := <-stream:
			if event.EventType != StreamEventStatePatch {
				continue
			}
			patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
			if !ok {
				t.Fatalf("event data = %#v, want WorkspaceAgentStatePatch", event.Data)
			}
			goal := payloadObject(patch.RuntimeContext["goal"])
			if asString(goal["objective"]) == "ship slash commands" {
				return
			}
		case <-deadline:
			t.Fatal("idle thread_goal_update was not published")
		}
	}
}

func TestControllerPublishesIdleStandardACPConfigOptionsUpdatesAfterStart(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-idle-config-options")
	adapter := NewClaudeCodeAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	session := standardTestSession(ProviderClaudeCode)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           session.RoomID,
		AgentSessionID:   session.AgentSessionID,
		Provider:         session.Provider,
		CWD:              session.CWD,
		PermissionModeID: session.PermissionModeID,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	stream, unsubscribe, ok := controller.Subscribe(started.Session.RoomID, started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe ok=false, want live session stream")
	}
	defer unsubscribe()

	transport.conn.sendConfigOptionsUpdate("model", "opus")

	event := waitForStreamEventType(t, stream, StreamEventConfigOptions)
	update, ok := event.Data.(AgentSessionConfigOptionsUpdate)
	if !ok {
		t.Fatalf("event data = %#v, want AgentSessionConfigOptionsUpdate", event.Data)
	}
	if update.AgentSessionID != started.Session.AgentSessionID || update.ConfigOptionKey != "model" {
		t.Fatalf("config options update = %#v, want model update for session", update)
	}
}

func TestStandardACPAdapterResumePreservesCommandsAdvertisedDuringLoadSession(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenClaw", "openclaw-session-resume-commands")
	transport.conn.commandUpdateOnLoadSession = true
	adapter := NewOpenClawAdapter(transport)
	session := standardTestSession(ProviderOpenClaw)
	session.ProviderSessionID = "persisted-openclaw-session-id"

	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}

	snapshot, ok := adapter.SessionCommandSnapshot(session)
	if !ok || len(snapshot.Commands) != 1 || snapshot.Commands[0].Name != "web" {
		t.Fatalf("command snapshot = %#v ok=%v, want command update preserved from resume", snapshot, ok)
	}
}

func TestSelectGeminiACPAuthMethodPrefersAPIKey(t *testing.T) {
	t.Parallel()

	raw, err := json.Marshal(map[string]any{
		"authMethods": []map[string]any{
			{"id": "gemini-api-key"},
			{"id": "oauth-personal"},
		},
	})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if got := selectGeminiACPAuthMethod(raw); got != "gemini-api-key" {
		t.Fatalf("method id = %q, want gemini-api-key", got)
	}
}

func TestSelectGeminiACPAuthMethodFallsBackToAPIKey(t *testing.T) {
	t.Parallel()

	raw, err := json.Marshal(map[string]any{
		"authMethods": []map[string]any{
			{"id": "gemini-api-key"},
		},
	})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if got := selectGeminiACPAuthMethod(raw); got != "gemini-api-key" {
		t.Fatalf("method id = %q, want gemini-api-key", got)
	}
}

func standardTestSession(provider string) Session {
	return Session{
		RoomID:            "room-1",
		AgentSessionID:    "agent-session-1",
		Provider:          provider,
		ProviderSessionID: "agent-session-1",
		CWD:               "/workspace/room-1",
		Status:            SessionStatusReady,
		Title:             provider,
	}
}

type standardACPTransport struct {
	mu    sync.Mutex
	specs []ProcessSpec
	conn  *standardACPConnection
}

func newStandardACPTransport(agentTitle string, sessionID string) *standardACPTransport {
	return &standardACPTransport{
		conn: &standardACPConnection{
			recv:       make(chan ProcessFrame, 32),
			agentTitle: agentTitle,
			sessionID:  sessionID,
		},
	}
}

func (t *standardACPTransport) Start(_ context.Context, spec ProcessSpec) (ProcessConnection, error) {
	t.mu.Lock()
	t.specs = append(t.specs, spec)
	t.mu.Unlock()
	return t.conn, nil
}

type standardACPConnection struct {
	mu                            sync.Mutex
	recv                          chan ProcessFrame
	agentTitle                    string
	sessionID                     string
	lastInitializeParamsSnapshot  map[string]any
	commandUpdateOnNewSession     bool
	commandUpdateOnLoadSession    bool
	promptPermission              bool
	promptKind                    string
	pauseBeforePromptResult       chan struct{}
	pauseBeforeToolCallCompletion chan struct{}
	pendingPermissionCallID       json.RawMessage
	selectedPermissionOption      string
	selectedInteractiveResult     map[string]any
	appliedModeID                 string
	lastSetModeParamsSnapshot     map[string]any
	lastAuthenticatedMethodID     string
	setModeError                  *acpError
	loadSessionError              *acpError
	rejectModelValue              string
	supportsLoadSession           bool
	isClosed                      bool
	lastNewSessionParams          map[string]any
	lastLoadSessionParams         map[string]any
	lastPromptParamsSnapshot      map[string]any
	setConfigOptionSnapshots      []map[string]any
}

func (c *standardACPConnection) Send(data []byte) error {
	for _, line := range acpScanLines(data) {
		var message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.Unmarshal([]byte(line), &message)
		switch message.Method {
		case acpMethodInitialize:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				c.lastInitializeParamsSnapshot = maps.Clone(request.Params)
			}
			c.mu.Unlock()
			result := map[string]any{
				"protocolVersion": acpProtocolVersion,
				"agentInfo": map[string]any{
					"name":  strings.ToLower(strings.ReplaceAll(c.agentTitle, " ", "-")),
					"title": c.agentTitle,
				},
			}
			if strings.EqualFold(c.agentTitle, "Gemini CLI") {
				result["authMethods"] = []map[string]any{
					{"id": "oauth-personal", "name": "Login with Google"},
					{"id": "gemini-api-key", "name": "Gemini API Key"},
				}
				result["sessionCapabilities"] = map[string]any{"load": true}
			}
			if strings.EqualFold(c.agentTitle, "Claude Agent") {
				result["sessionCapabilities"] = map[string]any{"resume": true}
			}
			if c.supportsLoadSession || strings.EqualFold(strings.TrimSpace(c.agentTitle), "OpenClaw") {
				result["sessionCapabilities"] = map[string]any{"load": true}
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  result,
			})
		case acpMethodAuthenticate:
			var request struct {
				Params struct {
					MethodID string `json:"methodId"`
				} `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			c.lastAuthenticatedMethodID = request.Params.MethodID
			c.mu.Unlock()
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  map[string]any{},
			})
		case acpMethodNewSession:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				c.lastNewSessionParams = maps.Clone(request.Params)
			}
			c.mu.Unlock()
			if c.commandUpdateOnNewSession {
				c.sendAvailableCommandsUpdate()
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result": map[string]any{
					"sessionId":     c.sessionID,
					"configOptions": c.defaultConfigOptions(),
				},
			})
		case acpMethodLoadSession, acpMethodResume:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				c.lastLoadSessionParams = maps.Clone(request.Params)
			}
			c.mu.Unlock()
			if c.commandUpdateOnLoadSession {
				c.sendAvailableCommandsUpdate()
			}
			if c.loadSessionError != nil {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"error":   c.loadSessionError,
				})
				return nil
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result": map[string]any{
					"configOptions": c.defaultConfigOptions(),
				},
			})
		case acpMethodSetMode:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				if mid, ok := request.Params["modeId"].(string); ok {
					c.appliedModeID = mid
				}
				c.lastSetModeParamsSnapshot = maps.Clone(request.Params)
			}
			setModeError := c.setModeError
			c.mu.Unlock()
			if setModeError != nil {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"error":   setModeError,
				})
				return nil
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  map[string]any{},
			})
		case "session/set_config_option":
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				c.setConfigOptionSnapshots = append(c.setConfigOptionSnapshots, maps.Clone(request.Params))
			}
			rejectModelValue := c.rejectModelValue
			c.mu.Unlock()
			if rejectModelValue != "" && request.Params != nil {
				configID, _ := request.Params["configId"].(string)
				value, _ := request.Params["value"].(string)
				if configID == "model" && value == rejectModelValue {
					c.sendJSON(map[string]any{
						"jsonrpc": "2.0",
						"id":      message.ID,
						"error": &acpError{
							Code:    -32603,
							Message: "Internal error",
							Data:    json.RawMessage(`{"details":"Invalid value for config option model: ` + value + `"}`),
						},
					})
					return nil
				}
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  map[string]any{},
			})
		case acpMethodPrompt:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				c.lastPromptParamsSnapshot = maps.Clone(request.Params)
			}
			c.mu.Unlock()
			if c.promptPermission || c.promptKind != "" {
				c.mu.Lock()
				c.pendingPermissionCallID = append(json.RawMessage(nil), message.ID...)
				c.mu.Unlock()
				toolCall, options := c.promptRequest()
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      "permission-1",
					"method":  acpMethodPermission,
					"params": map[string]any{
						"toolCall": toolCall,
						"options":  options,
					},
				})
				return nil
			}
			c.streamPromptResult(message.ID)
		default:
			if (c.promptPermission || c.promptKind != "") && acpRequestID(message.ID) == "permission-1" {
				var response struct {
					Result struct {
						Outcome struct {
							OptionID string         `json:"optionId"`
							Outcome  string         `json:"outcome"`
							Payload  map[string]any `json:"payload"`
						} `json:"outcome"`
					} `json:"result"`
				}
				_ = json.Unmarshal([]byte(line), &response)
				c.mu.Lock()
				c.selectedPermissionOption = response.Result.Outcome.OptionID
				c.selectedInteractiveResult = map[string]any{
					"outcome":  response.Result.Outcome.Outcome,
					"optionId": response.Result.Outcome.OptionID,
					"payload":  clonePayload(response.Result.Outcome.Payload),
				}
				promptID := append(json.RawMessage(nil), c.pendingPermissionCallID...)
				c.mu.Unlock()
				c.streamPromptResult(promptID)
			}
		}
	}
	return nil
}

func (c *standardACPConnection) streamPromptResult(promptID json.RawMessage) {
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": c.sessionID,
			"update": map[string]any{
				"sessionUpdate": "session_info_update",
				"title":         "Inspect workspace state",
			},
		},
	})
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": c.sessionID,
			"update": map[string]any{
				"sessionUpdate": "agent_thought_chunk",
				"content": map[string]any{
					"type": "text",
					"text": "Need more context.",
				},
			},
		},
	})
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": c.sessionID,
			"update": map[string]any{
				"sessionUpdate": "tool_call",
				"toolCallId":    "tool-1",
				"title":         "Read workspace files",
				"kind":          "execute",
				"status":        "pending",
				"rawInput": map[string]any{
					"path": "/workspace/room-1",
				},
			},
		},
	})
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": c.sessionID,
			"update": map[string]any{
				"sessionUpdate": "agent_message_chunk",
				"content": map[string]any{
					"type": "text",
					"text": "Inspecting files.",
				},
			},
		},
	})
	if c.pauseBeforeToolCallCompletion != nil {
		<-c.pauseBeforeToolCallCompletion
	}
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": c.sessionID,
			"update": map[string]any{
				"sessionUpdate": "tool_call_update",
				"toolCallId":    "tool-1",
				"title":         "Read workspace files",
				"kind":          "execute",
				"status":        "completed",
				"rawOutput": map[string]any{
					"filesRead": 3,
				},
			},
		},
	})
	if c.pauseBeforePromptResult != nil {
		<-c.pauseBeforePromptResult
	}
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"id":      promptID,
		"result": map[string]any{
			"stopReason": "end_turn",
		},
	})
}

func (c *standardACPConnection) Recv() (ProcessFrame, error) {
	frame, ok := <-c.recv
	if !ok {
		return ProcessFrame{}, io.EOF
	}
	return frame, nil
}

func (c *standardACPConnection) Close() error {
	c.mu.Lock()
	c.isClosed = true
	c.mu.Unlock()
	close(c.recv)
	return nil
}

func (c *standardACPConnection) sendJSON(value any) {
	raw, _ := json.Marshal(value)
	raw = append(raw, '\n')
	c.recv <- ProcessFrame{Stdout: raw}
}

func (c *standardACPConnection) sendAvailableCommandsUpdate() {
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": c.sessionID,
			"update": map[string]any{
				"sessionUpdate": "available_commands_update",
				"availableCommands": []any{
					map[string]any{
						"name":        "web",
						"description": "Search the web",
						"input": map[string]any{
							"hint": "query",
						},
					},
				},
			},
		},
	})
}

func (c *standardACPConnection) sendConfigOptionsUpdate(key string, value string) {
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": c.sessionID,
			"update": map[string]any{
				"sessionUpdate": "config_option_update",
				"key":           key,
				"value":         value,
				"configOptions": []any{
					map[string]any{
						"id":           key,
						"currentValue": value,
						"options": []any{
							map[string]any{"value": value, "name": value},
						},
					},
				},
			},
		},
	})
}

func (c *standardACPConnection) defaultConfigOptions() []map[string]any {
	title := strings.TrimSpace(c.agentTitle)
	if strings.EqualFold(title, "Claude Agent") || strings.EqualFold(title, "Gemini CLI") {
		return []map[string]any{
			{"id": "model"},
			{"id": "effort"},
		}
	}
	return nil
}

func (c *standardACPConnection) permissionOptionID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.selectedPermissionOption
}

func (c *standardACPConnection) interactiveOutcome() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return clonePayload(c.selectedInteractiveResult)
}

func (c *standardACPConnection) promptRequest() (map[string]any, []map[string]any) {
	switch c.promptKind {
	case "ask-user":
		return map[string]any{
			"toolCallId": "interactive-ask-1",
			"title":      "AskUserQuestion",
			"input": map[string]any{
				"questions": []map[string]any{{
					"id":       "render-path",
					"header":   "Renderer",
					"question": "Which renderer should we use?",
					"options": []map[string]any{
						{"label": "Renderer A", "description": "Shared transcript renderer"},
						{"label": "Renderer B", "description": "Legacy room renderer"},
					},
				}},
			},
		}, nil
	case "exit-plan":
		return map[string]any{
			"toolCallId": "interactive-plan-1",
			"title":      "ExitPlanMode",
			"input": map[string]any{
				"plan": "Implement the shared renderer",
			},
		}, nil
	default:
		return map[string]any{
				"toolCallId": "approval-1",
				"title":      "Allow Bash",
			}, []map[string]any{
				{"optionId": "allow", "label": "Allow", "kind": "allow_once"},
				{"optionId": "reject", "label": "Reject", "kind": "reject_once"},
			}
	}
}

func (c *standardACPConnection) lastModeID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.appliedModeID
}

func (c *standardACPConnection) lastPromptParams() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastPromptParamsSnapshot == nil {
		return nil
	}
	return maps.Clone(c.lastPromptParamsSnapshot)
}

func (c *standardACPConnection) lastSetModeParams() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastSetModeParamsSnapshot == nil {
		return nil
	}
	return maps.Clone(c.lastSetModeParamsSnapshot)
}

func (c *standardACPConnection) authenticatedMethodID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastAuthenticatedMethodID
}

func (c *standardACPConnection) lastInitializeParams() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastInitializeParamsSnapshot == nil {
		return nil
	}
	return maps.Clone(c.lastInitializeParamsSnapshot)
}

func (c *standardACPConnection) setConfigOptionCalls() []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.setConfigOptionSnapshots) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(c.setConfigOptionSnapshots))
	for _, snapshot := range c.setConfigOptionSnapshots {
		out = append(out, maps.Clone(snapshot))
	}
	return out
}

func (c *standardACPConnection) closed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.isClosed
}
