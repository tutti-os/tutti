package agentruntime

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func TestCursorAdapterInjectsPreparedContextIntoFirstProviderPromptOnly(t *testing.T) {
	t.Parallel()

	contextPath := filepath.Join(t.TempDir(), "cursor-context.md")
	contextText := "resolved provider context with a dynamic Skill catalog"
	if err := os.WriteFile(contextPath, []byte(contextText), 0o600); err != nil {
		t.Fatal(err)
	}
	transport := newStandardACPTransport("Cursor Agent", "cursor-session-context")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	session.Env = []string{cursorPromptContextFileEnv + "=" + contextPath}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "cursor-session-context"
	if _, err := adapter.Exec(context.Background(), session, textPrompt("first user prompt"), "", "turn-1", nil, nil); err != nil {
		t.Fatalf("first Exec: %v", err)
	}
	if _, err := adapter.Exec(context.Background(), session, textPrompt("second user prompt"), "", "turn-2", nil, nil); err != nil {
		t.Fatalf("second Exec: %v", err)
	}

	transport.conn.mu.Lock()
	snapshots := append([]map[string]any(nil), transport.conn.promptParamsSnapshots...)
	transport.conn.mu.Unlock()
	if len(snapshots) != 2 {
		t.Fatalf("provider prompt count = %d, want 2", len(snapshots))
	}
	if first := acpTestPromptText(snapshots[0]); !strings.Contains(first, "first user prompt") || !strings.Contains(first, contextText) {
		t.Fatalf("first provider prompt = %q, want user content plus prepared context", first)
	}
	if second := acpTestPromptText(snapshots[1]); !strings.Contains(second, "second user prompt") || strings.Contains(second, contextText) {
		t.Fatalf("second provider prompt = %q, want user content without repeated prepared context", second)
	}
}

func TestCursorAdapterStartUsesInjectedProviderCommand(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-resolved")
	adapter := newCursorAdapterWithHostMetadata(
		transport,
		LegacyHostMetadata(),
		func(_ context.Context, provider string) (ProviderCommand, error) {
			if provider != ProviderCursor {
				t.Fatalf("provider = %q, want %q", provider, ProviderCursor)
			}
			return ProviderCommand{Command: []string{"/home/user/.local/bin/agent", "acp"}}, nil
		},
	)
	session := standardTestSession(ProviderCursor)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	if got := strings.Join(transport.specs[0].Command, " "); got != "/home/user/.local/bin/agent acp" {
		t.Fatalf("command = %q, want resolved cursor binary", got)
	}
}

func TestCursorAdapterStartUsesPluginDirWithInjectedProviderCommand(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-resolved-plugin")
	adapter := newCursorAdapterWithHostMetadata(
		transport,
		LegacyHostMetadata(),
		func(_ context.Context, provider string) (ProviderCommand, error) {
			if provider != ProviderCursor {
				t.Fatalf("provider = %q, want %q", provider, ProviderCursor)
			}
			return ProviderCommand{Command: []string{"/home/user/.local/bin/agent", "acp"}}, nil
		},
	)
	session := standardTestSession(ProviderCursor)
	session.Env = []string{cursorPluginDirEnv + "=/state/cursor-plugin/tutti-cli"}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got := strings.Join(transport.specs[0].Command, " "); got != "/home/user/.local/bin/agent --plugin-dir /state/cursor-plugin/tutti-cli acp" {
		t.Fatalf("command = %q, want resolved cursor binary with plugin-dir", got)
	}
}

func TestCursorAdapterStartAppliesModelConfigOption(t *testing.T) {
	t.Parallel()

	// Mirrors cursor-agent 2026.07 session/new output: a `model` config
	// option with parameterized ids in {value, name} entries.
	transport := newStandardACPTransport("Cursor Agent", "cursor-session-model")
	transport.conn.configOptions = []map[string]any{
		{
			"id":           "model",
			"name":         "Model",
			"category":     "model",
			"type":         "select",
			"currentValue": "composer-2.5[fast=true]",
			"options": []any{
				map[string]any{"value": "default[]", "name": "Auto"},
				map[string]any{"value": "composer-2.5[fast=true]", "name": "composer-2.5"},
				map[string]any{"value": "claude-sonnet-5[thinking=true,context=300k,effort=high]", "name": "claude-sonnet-5"},
			},
		},
	}
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	session.Settings = &SessionSettings{Model: "claude-sonnet-5[thinking=true,context=300k,effort=high]"}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	calls := transport.conn.setConfigOptionCalls()
	if len(calls) != 1 {
		t.Fatalf("config option calls = %#v, want one model update", calls)
	}
	if got, _ := calls[0]["configId"].(string); got != "model" {
		t.Fatalf("config id = %q, want model", got)
	}
	if got, _ := calls[0]["value"].(string); got != "claude-sonnet-5[thinking=true,context=300k,effort=high]" {
		t.Fatalf("config value = %q, want parameterized cursor model id", got)
	}
}

func TestCursorACPModeID(t *testing.T) {
	t.Parallel()

	for mode, want := range map[string]string{
		"read-only":   "ask",
		"agent":       "agent",
		"full-access": "agent",
		" agent ":     "agent",
		"":            "",
		"yolo":        "",
		"plan":        "",
		"ask":         "",
	} {
		if got := cursorACPModeID(mode); got != want {
			t.Fatalf("cursorACPModeID(%q) = %q, want %q", mode, got, want)
		}
	}
}

func TestCursorPlanModeFromACPModeID(t *testing.T) {
	t.Parallel()
	descriptor, ok := providerregistry.Find(ProviderCursor)
	if !ok {
		t.Fatal("cursor descriptor missing")
	}

	for modeID, wantPlanMode := range map[string]bool{
		"plan":  true,
		"agent": false,
		"ask":   false,
	} {
		got, ok := projectCurrentPlanModeFromACPModeID(descriptor.Runtime.StandardACP, modeID)
		if !ok {
			t.Fatalf("cursorPlanModeFromACPModeID(%q) ok=false, want true", modeID)
		}
		if got != wantPlanMode {
			t.Fatalf("cursorPlanModeFromACPModeID(%q) = %v, want %v", modeID, got, wantPlanMode)
		}
	}
	if _, ok := projectCurrentPlanModeFromACPModeID(descriptor.Runtime.StandardACP, "auto"); ok {
		t.Fatal("cursorPlanModeFromACPModeID(auto) ok=true, want false")
	}
}

func TestCursorAdapterApplySessionSettingsTogglesPlanMode(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-plan-toggle")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	session.PermissionModeID = "agent"
	session.Settings = &SessionSettings{
		PermissionModeID: "agent",
		PlanMode:         false,
	}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	planMode := true
	session.ProviderSessionID = "cursor-session-plan-toggle"
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
	if transport.conn.lastModeID() != "agent" {
		t.Fatalf("mode id = %q, want agent", transport.conn.lastModeID())
	}
}

func TestCursorAdapterReadOnlyReturnsFromPlanModeToAsk(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-read-only-plan-toggle")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	session.PermissionModeID = cursorPermissionReadOnly
	session.Settings = &SessionSettings{
		PermissionModeID: cursorPermissionReadOnly,
		PlanMode:         false,
	}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if transport.conn.lastModeID() != "ask" {
		t.Fatalf("initial mode id = %q, want ask", transport.conn.lastModeID())
	}

	session.ProviderSessionID = "cursor-session-read-only-plan-toggle"
	planMode := true
	session.Settings.PlanMode = planMode
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		PlanMode: &planMode,
	}); err != nil {
		t.Fatalf("ApplySessionSettings plan on: %v", err)
	}
	if transport.conn.lastModeID() != "plan" {
		t.Fatalf("plan mode id = %q, want plan", transport.conn.lastModeID())
	}

	planMode = false
	session.Settings.PlanMode = planMode
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		PlanMode: &planMode,
	}); err != nil {
		t.Fatalf("ApplySessionSettings plan off: %v", err)
	}
	if transport.conn.lastModeID() != "ask" {
		t.Fatalf("restored mode id = %q, want ask", transport.conn.lastModeID())
	}
}

func TestHermesAdapterStartCreatesStandardACPSession(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-1")
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)
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
	if transport.conn.lastModeID() != "dont_ask" {
		t.Fatalf("mode id = %q, want dont_ask", transport.conn.lastModeID())
	}
	if got := transport.conn.authenticatedMethodID(); got != "" {
		t.Fatalf("authenticated method id = %q, want empty", got)
	}
}

func TestHermesAdapterStartCoercesReadOnlyModeToDontAsk(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-default")
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)
	session.PermissionModeID = "read-only"

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if transport.conn.lastModeID() != "dont_ask" {
		t.Fatalf("mode id = %q, want dont_ask", transport.conn.lastModeID())
	}
}

func TestHermesAdapterStartCoercesAutoModeToDontAsk(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-auto")
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)
	session.PermissionModeID = "auto"

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if transport.conn.lastModeID() != "dont_ask" {
		t.Fatalf("mode id = %q, want dont_ask", transport.conn.lastModeID())
	}
}

func TestExtensionAdapterInstallsSignedAutomaticPermissionDecisions(t *testing.T) {
	t.Parallel()

	adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider: "acp:hermes", Name: "hermes-acp", DisplayName: "Hermes Agent",
		Command: []string{"hermes", "acp"},
		AutomaticPermissionDecisions: map[string]string{
			"full-access": "approved",
			"read-only":   "denied",
			"unsafe":      "execute-arbitrary-code",
		},
	}, newStandardACPTransport("Hermes Agent", "extension-hermes"), LegacyHostMetadata())
	if err != nil {
		t.Fatal(err)
	}
	adapter := adapterRaw.(*standardACPAdapter)
	if got := adapter.config.automaticPermissionDecision("FULL-ACCESS"); got != "approved" {
		t.Fatalf("full-access decision = %q, want approved", got)
	}
	if got := adapter.config.automaticPermissionDecision("read-only"); got != "denied" {
		t.Fatalf("read-only decision = %q, want denied", got)
	}
	if got := adapter.config.automaticPermissionDecision("unsafe"); got != "" {
		t.Fatalf("unsafe decision = %q, want prompt", got)
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
			name:     "hermes",
			provider: hermesExtensionTestProvider,
			build:    newHermesExtensionTestAdapter,
			session: func() Session {
				session := standardTestSession(hermesExtensionTestProvider)
				session.ProviderSessionID = "persisted-hermes-session-id"
				return session
			},
		},
		{
			name:     "opencode",
			provider: ProviderOpenCode,
			build:    newOpenCodeTestAdapter,
			session: func() Session {
				session := standardTestSession(ProviderOpenCode)
				session.ProviderSessionID = "persisted-opencode-session-id"
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
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)
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
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)
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
