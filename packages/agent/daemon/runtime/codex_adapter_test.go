package agentruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

func readSessionTestdataJSON(t *testing.T, name string) map[string]any {
	t.Helper()

	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(file), "testdata", name))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read session testdata %s: %v", path, err)
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("unmarshal session testdata %s: %v", path, err)
	}
	return body
}

func TestCodexAdapterStartCreatesRealACPSession(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	adapter := NewCodexAdapter(transport)

	events, err := adapter.Start(context.Background(), testSession())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	spec := transport.specs[0]
	if len(spec.Command) == 0 || spec.Command[0] != codexACPCommand {
		t.Fatalf("command = %#v, want %q", spec.Command, codexACPCommand)
	}
	if len(spec.Command) != 1 {
		t.Fatalf("command = %#v, want no implicit sandbox config overrides", spec.Command)
	}
	if spec.CWD != "/workspace" {
		t.Fatalf("cwd = %q, want /workspace", spec.CWD)
	}
	if !containsString(spec.Env, codexAgentRoutingEnv) {
		t.Fatalf("env = %#v, want agent routing env", spec.Env)
	}
	if !containsString(spec.Env, codexRoutingPreload) {
		t.Fatalf("env = %#v, want routing preload env", spec.Env)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("events = %#v, want session.started", events)
	}
	if events[0].ProviderSessionID != "codex-acp-session-1" {
		t.Fatalf("provider session id = %q", events[0].ProviderSessionID)
	}
	if got := acpRequestParamCWD(t, transport.conn, acpMethodNewSession); got != "/workspace" {
		t.Fatalf("ACP session/new cwd = %q, want /workspace", got)
	}
}

func TestCodexAdapterStartAddsConfigOverridesForModelAndReasoning(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	adapter := NewCodexAdapter(transport)
	session := testSession()
	session.Settings = &SessionSettings{
		Model:            "gpt-5",
		ReasoningEffort:  "max",
		PermissionModeID: "auto",
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}

	command := transport.specs[0].Command
	if !containsCommandSequence(command, []string{codexConfigFlag, "model=gpt-5"}) {
		t.Fatalf("command = %#v, want model config override", command)
	}
	if !containsCommandSequence(command, []string{codexConfigFlag, "model_reasoning_effort=xhigh"}) {
		t.Fatalf("command = %#v, want reasoning config override", command)
	}
}

func TestCodexAdapterStartIgnoresUnsupportedPlanMode(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	adapter := NewCodexAdapter(transport)
	session := testSession()
	session.PermissionModeID = "full-access"
	session.Settings = &SessionSettings{
		PermissionModeID: "full-access",
		PlanMode:         true,
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	params := acpRequestParams(t, transport.conn, acpMethodSetMode)
	if got := asString(params["modeId"]); got != "full-access" {
		t.Fatalf("ACP set_mode modeId = %q, want full-access", got)
	}
}

func TestCodexAdapterApplySessionSettingsDoesNotApplyUnsupportedPlanMode(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	adapter := NewCodexAdapter(transport)
	session := testSession()
	session.PermissionModeID = "full-access"
	session.Settings = &SessionSettings{
		PermissionModeID: "full-access",
		PlanMode:         false,
	}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "codex-acp-session-1"
	initialSetModeRequests := len(acpRequestParamsList(t, transport.conn, acpMethodSetMode))

	planMode := true
	session.Settings.PlanMode = planMode
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		PlanMode: &planMode,
	}); err != nil {
		t.Fatalf("ApplySessionSettings plan on: %v", err)
	}

	planMode = false
	session.Settings.PlanMode = planMode
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		PlanMode: &planMode,
	}); err != nil {
		t.Fatalf("ApplySessionSettings plan off: %v", err)
	}
	if got := len(acpRequestParamsList(t, transport.conn, acpMethodSetMode)); got != initialSetModeRequests {
		t.Fatalf("ACP set_mode request count = %d, want %d", got, initialSetModeRequests)
	}
}

func TestCodexAdapterStartDisablesReasoningSummaryForSparkModel(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	adapter := NewCodexAdapter(transport)
	session := testSession()
	session.Settings = &SessionSettings{
		Model:            "gpt-5.3-codex-spark",
		ReasoningEffort:  "high",
		PermissionModeID: "auto",
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}

	command := transport.specs[0].Command
	if !containsCommandSequence(command, []string{codexConfigFlag, "model=gpt-5.3-codex-spark"}) {
		t.Fatalf("command = %#v, want spark model config override", command)
	}
	if !containsCommandSequence(command, []string{codexConfigFlag, "model_reasoning_summary=none"}) {
		t.Fatalf("command = %#v, want reasoning summary disabled for spark model", command)
	}
	if !containsCommandSequence(command, []string{codexConfigFlag, "model_reasoning_effort=high"}) {
		t.Fatalf("command = %#v, want reasoning effort preserved for spark model", command)
	}
}

func TestCodexAdapterSessionStateIncludesACPConfigOptions(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	transport.conn.configOptions = []map[string]any{{
		"id":           "reasoning_effort",
		"name":         "Reasoning Effort",
		"type":         "select",
		"category":     "thought_level",
		"currentValue": "medium",
		"options": []any{
			map[string]any{"value": "low", "name": "Low"},
			map[string]any{"value": "medium", "name": "Medium"},
			map[string]any{"value": "high", "name": "High"},
		},
	}}
	adapter := NewCodexAdapter(transport)
	session := testSession()

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	snapshot := adapter.SessionState(session)
	options, _ := snapshot.RuntimeContext["configOptions"].([]map[string]any)
	if len(options) != 1 {
		t.Fatalf("runtime configOptions = %#v, want one reasoning option", snapshot.RuntimeContext["configOptions"])
	}
	if snapshot.Settings == nil || snapshot.Settings.ReasoningEffort != "medium" {
		t.Fatalf("snapshot settings = %#v, want medium reasoning", snapshot.Settings)
	}
}

func TestCodexACPReasoningEffortValueNormalizesAliases(t *testing.T) {
	t.Parallel()

	tests := map[string]string{
		"":        "",
		"  ":      "",
		"minimal": "minimal",
		"low":     "low",
		"medium":  "medium",
		"high":    "high",
		"max":     "xhigh",
		"xhigh":   "xhigh",
		"weird":   "",
	}

	for input, want := range tests {
		if got := codexACPReasoningEffortValue(input); got != want {
			t.Fatalf("codexACPReasoningEffortValue(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestCodexAdapterApplySessionSettingsUpdatesLiveACPConfig(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	adapter := NewCodexAdapter(transport)
	session := testSession()

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	session.Settings = &SessionSettings{
		Model:            "gpt-5.4",
		ReasoningEffort:  "high",
		PermissionModeID: "full-access",
	}
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		Model:           stringPtr("gpt-5.4"),
		ReasoningEffort: stringPtr("high"),
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	calls := transport.conn.setConfigOptionCalls()
	if len(calls) != 2 {
		t.Fatalf("config option calls = %#v, want model + reasoning", calls)
	}
	if got, _ := calls[1]["configId"].(string); got != "reasoning_effort" {
		t.Fatalf("reasoning config id = %q, want reasoning_effort", got)
	}

	snapshot := adapter.SessionState(session)
	if snapshot.Settings == nil {
		t.Fatal("snapshot settings = nil, want live ACP settings")
	}
	if snapshot.Settings.Model != "gpt-5.4" {
		t.Fatalf("snapshot settings model = %q, want gpt-5.4", snapshot.Settings.Model)
	}
	if snapshot.Settings.ReasoningEffort != "high" {
		t.Fatalf("snapshot settings reasoning = %q, want high", snapshot.Settings.ReasoningEffort)
	}
}

func TestCodexAdapterApplySessionSettingsSkipsUnchangedLiveACPConfig(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	transport.conn.configOptions = []map[string]any{
		{"id": "reasoning_effort", "currentValue": "high"},
	}
	adapter := NewCodexAdapter(transport)
	session := testSession()

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	session.Settings = &SessionSettings{ReasoningEffort: "high"}
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		ReasoningEffort: stringPtr("high"),
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	if calls := transport.conn.setConfigOptionCalls(); len(calls) != 0 {
		t.Fatalf("config option calls = %#v, want unchanged live reasoning no-op", calls)
	}
}

func TestCodexAdapterApplySessionSettingsSendsChangedLiveACPConfig(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	transport.conn.configOptions = []map[string]any{
		{"id": "reasoning_effort", "currentValue": "high"},
	}
	adapter := NewCodexAdapter(transport)
	session := testSession()

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	session.Settings = &SessionSettings{ReasoningEffort: "low"}
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		ReasoningEffort: stringPtr("low"),
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	calls := transport.conn.setConfigOptionCalls()
	if len(calls) != 1 {
		t.Fatalf("config option calls = %#v, want changed live reasoning update", calls)
	}
	if got, _ := calls[0]["value"].(string); got != "low" {
		t.Fatalf("reasoning config value = %q, want low", got)
	}
}

func TestCodexAdapterRequiresNewSessionWhenReasoningSummarySupportChanges(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAdapter(newScriptedACPTransport())
	session := testSession()
	session.Settings = &SessionSettings{
		Model:            "gpt-5.3-codex-spark",
		PermissionModeID: "full-access",
	}

	if adapter.RequiresNewSessionForSettings(session, SessionSettingsPatch{
		Model: stringPtr("gpt-5.3-codex-spark"),
	}) {
		t.Fatal("RequiresNewSessionForSettings = true for unchanged spark model, want false")
	}
	if !adapter.RequiresNewSessionForSettings(session, SessionSettingsPatch{
		Model: stringPtr("gpt-5.3-codex"),
	}) {
		t.Fatal("RequiresNewSessionForSettings = false for spark -> non-spark model, want true")
	}

	session.Settings.Model = "gpt-5.3-codex"
	if !adapter.RequiresNewSessionForSettings(session, SessionSettingsPatch{
		Model: stringPtr("gpt-5.3-codex-spark"),
	}) {
		t.Fatal("RequiresNewSessionForSettings = false for non-spark -> spark model, want true")
	}
}

func TestCodexAdapterApplySessionSettingsRejectsNewSessionOnlyModelChange(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAdapter(newScriptedACPTransport())
	session := testSession()
	session.Settings = &SessionSettings{
		Model:            "gpt-5.3-codex",
		PermissionModeID: "full-access",
	}

	err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		Model: stringPtr("gpt-5.3-codex-spark"),
	})
	if !errors.Is(err, ErrSessionSettingsRequireNewSession) {
		t.Fatalf("ApplySessionSettings error = %v, want ErrSessionSettingsRequireNewSession", err)
	}
}

func TestCodexAdapterStartPreservesCommandsAdvertisedDuringNewSession(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	transport.conn.commandUpdateOnNewSession = true
	adapter := NewCodexAdapter(transport)
	session := testSession()

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

func TestControllerPublishesIdleCodexCommandUpdatesAfterStart(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	adapter := NewCodexAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	session := testSession()

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
			if len(snapshot.Commands) != 1 || snapshot.Commands[0].Name != "web" {
				t.Fatalf("command snapshot = %#v, want web command", snapshot)
			}
			return
		case <-deadline:
			t.Fatal("idle available_commands_update was not published")
		}
	}
}

func TestControllerPublishesIdleCodexConfigOptionsUpdatesAfterStart(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	adapter := NewCodexAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	session := testSession()

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

func TestCodexAdapterResumePreservesCommandsAdvertisedDuringLoadSession(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	transport.conn.commandUpdateOnLoadSession = true
	adapter := NewCodexAdapter(transport)
	session := testSession()

	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}

	snapshot, ok := adapter.SessionCommandSnapshot(session)
	if !ok || len(snapshot.Commands) != 1 || snapshot.Commands[0].Name != "web" {
		t.Fatalf("command snapshot = %#v ok=%v, want command update preserved from resume", snapshot, ok)
	}
}

func TestCodexAdapterResumeClassifiesMissingProviderSession(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	transport.conn.loadSessionError = &acpError{
		Code:    -32002,
		Message: "Resource not found",
	}
	adapter := NewCodexAdapter(transport)
	session := testSession()

	err := adapter.Resume(context.Background(), session)
	if AppErrorCode(err) != AppErrorProviderSessionNotFound {
		t.Fatalf("app error code = %q, want %q (err=%v)", AppErrorCode(err), AppErrorProviderSessionNotFound, err)
	}
	debugMessage := AppErrorDebugMessage(err)
	if !strings.Contains(debugMessage, "provider_session_id="+session.ProviderSessionID) {
		t.Fatalf("debug message = %q, want provider session detail", debugMessage)
	}
	if !strings.Contains(debugMessage, "method=session/load") {
		t.Fatalf("debug message = %q, want restore method", debugMessage)
	}
}

func TestCodexAdapterResumeClassifiesUnsupportedRestoreAsProviderSessionNotFound(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	transport.conn.supportsSessionRestore = false
	adapter := NewCodexAdapter(transport)
	session := testSession()

	err := adapter.Resume(context.Background(), session)
	if AppErrorCode(err) != AppErrorResumeSessionNotLocal {
		t.Fatalf("app error code = %q, want %q (err=%v)", AppErrorCode(err), AppErrorResumeSessionNotLocal, err)
	}
	debugMessage := AppErrorDebugMessage(err)
	if !strings.Contains(debugMessage, "resume/load unsupported") {
		t.Fatalf("debug message = %q, want unsupported restore detail", debugMessage)
	}
}

func TestCodexAdapterResumeRequiresProviderSessionID(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	adapter := NewCodexAdapter(transport)
	session := testSession()
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

func TestNexightAdapterResumeClassifiesMissingProviderSession(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	transport.conn.loadSessionError = &acpError{
		Code:    -32002,
		Message: "Resource not found",
	}
	adapter := NewNexightAdapter(transport)
	session := testSession()
	session.Provider = ProviderNexight
	session.ProviderSessionID = "persisted-nexight-session-id"

	err := adapter.Resume(context.Background(), session)
	if AppErrorCode(err) != AppErrorProviderSessionNotFound {
		t.Fatalf("app error code = %q, want %q (err=%v)", AppErrorCode(err), AppErrorProviderSessionNotFound, err)
	}
	debugMessage := AppErrorDebugMessage(err)
	if !strings.Contains(debugMessage, "provider=nexight") {
		t.Fatalf("debug message = %q, want nexight provider detail", debugMessage)
	}
}

func TestNexightAdapterStartCreatesRealACPSession(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	adapter := NewNexightAdapter(transport)
	session := testSession()
	session.Provider = ProviderNexight
	session.Title = "Nexight"

	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	spec := transport.specs[0]
	if len(spec.Command) == 0 || spec.Command[0] != nexightACPCommand {
		t.Fatalf("command = %#v, want %q", spec.Command, nexightACPCommand)
	}
	if len(spec.Command) != 1 {
		t.Fatalf("command = %#v, want no implicit sandbox config overrides", spec.Command)
	}
	if spec.Provider != ProviderNexight {
		t.Fatalf("provider = %q, want %q", spec.Provider, ProviderNexight)
	}
	if spec.CWD != "/workspace/room-1" {
		t.Fatalf("cwd = %q, want /workspace/room-1", spec.CWD)
	}
	if !containsString(spec.Env, codexAgentRoutingEnv) || !containsString(spec.Env, codexRoutingPreload) {
		t.Fatalf("env = %#v, want nexight routing env with preload", spec.Env)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("events = %#v, want session.started", events)
	}
	if events[0].ProviderSessionID != "codex-acp-session-1" {
		t.Fatalf("provider session id = %q", events[0].ProviderSessionID)
	}
	if got := acpRequestParamCWD(t, transport.conn, acpMethodNewSession); got != "/workspace/room-1" {
		t.Fatalf("ACP session/new cwd = %q, want /workspace/room-1", got)
	}
}

func TestCodexAdapterStartContinuesWhenSetModeDoesNotRespond(t *testing.T) {
	originalTimeout := acpPermissionModeTimeout
	acpPermissionModeTimeout = 20 * time.Millisecond
	t.Cleanup(func() {
		acpPermissionModeTimeout = originalTimeout
	})

	transport := newScriptedACPTransport()
	transport.conn.respondSetMode = false
	adapter := NewCodexAdapter(transport)
	session := testSession()
	session.PermissionModeID = "full-access"

	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("events = %#v, want session.started", events)
	}
	if events[0].ProviderSessionID != "codex-acp-session-1" {
		t.Fatalf("provider session id = %q", events[0].ProviderSessionID)
	}
}

func TestCodexACPModeIDMapsPermissionModes(t *testing.T) {
	t.Parallel()

	for _, tt := range []struct {
		input string
		want  string
	}{
		{input: "", want: ""},
		{input: "read-only", want: "read-only"},
		{input: "auto", want: "auto"},
		{input: "full-access", want: "full-access"},
		{input: "unexpected", want: ""},
	} {
		if got := codexACPModeID(tt.input); got != tt.want {
			t.Fatalf("codexACPModeID(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestCodexAdapterStartAuthRequiredCreatesSessionState(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	transport.conn.authRequiredOnNewSession = true
	adapter := NewCodexAdapter(transport)
	session := testSession()

	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("events = %#v, want session.started", events)
	}

	snapshot := adapter.SessionState(session)
	if snapshot.AuthState != "auth_required" {
		t.Fatalf("auth state = %q, want auth_required", snapshot.AuthState)
	}
	if got := asString(snapshot.RuntimeContext["authMessage"]); !strings.Contains(got, "Sync the Codex host credentials") {
		t.Fatalf("auth message = %q, want credential sync guidance", got)
	}
}

func TestCodexAdapterExecStreamsACPUpdates(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAdapter(newScriptedACPTransport())
	session := testSession()
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "codex-acp-session-1"

	var emittedActivity []activityshared.Event
	activityEvents, err := adapter.Exec(context.Background(), session, textPrompt(" inspect repo "), "", "turn-1", func(events []activityshared.Event) {
		emittedActivity = append(emittedActivity, events...)
	}, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	if !hasActivityMessage(emittedActivity, activityshared.MessageRoleUser, "inspect repo") {
		t.Fatalf("emitted events = %#v, missing user message", emittedActivity)
	}
	titleEvents := activityEventsWithType(emittedActivity, activityshared.EventSessionUpdated)
	if len(titleEvents) == 0 || titleEvents[0].Payload.Title != "inspect repo" {
		t.Fatalf("title events = %#v, want prompt fallback title", titleEvents)
	}
	if len(titleEvents) < 2 || titleEvents[1].Payload.Title != "Inspect repository structure" {
		t.Fatalf("title events = %#v, want provider title update after fallback", titleEvents)
	}
	if !hasActivityMessage(emittedActivity, activityshared.MessageRoleAssistant, "I'll check the repo.") {
		t.Fatalf("emitted events = %#v, missing streamed assistant message", emittedActivity)
	}
	assistantMessages := activityMessagesWithRole(emittedActivity, activityshared.MessageRoleAssistant)
	if len(assistantMessages) != 4 {
		t.Fatalf("assistant messages = %#v, want streaming snapshots and completed snapshot", assistantMessages)
	}
	if assistantMessages[0].EventID == "" ||
		assistantMessages[1].EventID != assistantMessages[0].EventID ||
		assistantMessages[2].EventID != assistantMessages[0].EventID ||
		assistantMessages[3].EventID != assistantMessages[0].EventID {
		t.Fatalf("assistant messages = %#v; want stable stream id", assistantMessages)
	}
	if assistantMessages[0].Payload.Content != "I'll " ||
		assistantMessages[1].Payload.Content != "I'll check " ||
		assistantMessages[2].Payload.Content != "I'll check the repo." ||
		assistantMessages[3].Payload.Content != "I'll check the repo." {
		t.Fatalf("assistant message contents = %#v, want accumulated snapshots", assistantMessages)
	}
	if assistantMessages[0].Payload.Metadata["streamState"] != messageStreamStateStreaming ||
		assistantMessages[1].Payload.Metadata["streamState"] != messageStreamStateStreaming ||
		assistantMessages[2].Payload.Metadata["streamState"] != messageStreamStateStreaming ||
		assistantMessages[3].Payload.Metadata["streamState"] != messageStreamStateCompleted {
		t.Fatalf("assistant stream states = %#v, want streaming snapshots and completed", assistantMessages)
	}
	thinkingMessages := activityMessagesWithRole(emittedActivity, activityshared.MessageRoleAssistantThinking)
	if len(thinkingMessages) != 3 {
		t.Fatalf("thinking messages = %#v, want streaming snapshots and completed snapshot", thinkingMessages)
	}
	if thinkingMessages[0].Payload.Content != "Need " ||
		thinkingMessages[1].Payload.Content != "Need context." ||
		thinkingMessages[2].Payload.Content != "Need context." {
		t.Fatalf("thinking message contents = %#v, want accumulated snapshots", thinkingMessages)
	}
	if thinkingMessages[0].Payload.Metadata["streamState"] != messageStreamStateStreaming ||
		thinkingMessages[1].Payload.Metadata["streamState"] != messageStreamStateStreaming ||
		thinkingMessages[2].Payload.Metadata["streamState"] != messageStreamStateCompleted {
		t.Fatalf("thinking stream states = %#v, want streaming snapshots and completed", thinkingMessages)
	}
	toolEvents := activityEventsWithType(emittedActivity, activityshared.EventCallStarted)
	if len(toolEvents) != 1 {
		t.Fatalf("tool events = %#v, want one call.started event", toolEvents)
	}
	if toolEvents[0].Payload.CallID != "tool-1" || toolEvents[0].Payload.CallType != "tool" || toolEvents[0].Payload.Name != "Reading files" {
		t.Fatalf("tool event payload = %#v, want call contract", toolEvents[0].Payload)
	}
	if activityEvents[len(activityEvents)-1].Type != activityshared.EventTurnCompleted {
		t.Fatalf("last event = %#v, want turn completed", activityEvents[len(activityEvents)-1])
	}
	reportCalls := []agentsessionstore.ReportActivityInput{reportActivityInput(session, activityEvents)}
	reports := reportsWithTimelineItem(reportCalls, "message.assistant")
	if len(reports) == 0 {
		t.Fatal("assistant reports = 0, want assistant message updates")
	}
	if !hasTimelineItem(reports[len(reports)-1], "message.assistant", "completed", "") {
		t.Fatalf("assistant reports = %#v, want completed assistant update", reports)
	}
}

func TestCodexAdapterExecCompletesAssistantMessageFromPromptResult(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	transport.conn.promptFinalContent = "I'll check the repo. Source note."
	adapter := NewCodexAdapter(transport)
	session := testSession()
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "codex-acp-session-1"

	var emittedActivity []activityshared.Event
	activityEvents, err := adapter.Exec(context.Background(), session, textPrompt(" inspect repo "), "", "turn-1", func(events []activityshared.Event) {
		emittedActivity = append(emittedActivity, events...)
	}, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	assistantMessages := activityMessagesWithRole(emittedActivity, activityshared.MessageRoleAssistant)
	if len(assistantMessages) != 4 {
		t.Fatalf("assistant messages = %#v, want streaming snapshots and completed snapshot", assistantMessages)
	}
	completed := assistantMessages[len(assistantMessages)-1]
	if completed.Payload.Content != "I'll check the repo. Source note." {
		t.Fatalf("completed assistant content = %q, want prompt result content", completed.Payload.Content)
	}
	if completed.Payload.Metadata["streamState"] != messageStreamStateCompleted {
		t.Fatalf("completed assistant metadata = %#v, want completed stream state", completed.Payload.Metadata)
	}

	report := reportActivityInput(session, activityEvents)
	var assistantUpdate agentsessionstore.WorkspaceAgentMessageUpdate
	for _, update := range report.MessageUpdates {
		if update.Role == "assistant" && update.Kind == "text" {
			assistantUpdate = update
		}
	}
	if assistantUpdate.Payload["text"] != "I'll check the repo. Source note." {
		t.Fatalf("assistant message update = %#v, want prompt result content", assistantUpdate)
	}
}

func TestCodexAdapterExecPreservesLongAssistantMessageContent(t *testing.T) {
	t.Parallel()

	longContent := "I'll check the repo." + strings.Repeat("完整回答", 3000)
	transport := newScriptedACPTransport()
	transport.conn.promptFinalContent = longContent
	adapter := NewCodexAdapter(transport)
	session := testSession()
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "codex-acp-session-1"

	var emittedActivity []activityshared.Event
	activityEvents, err := adapter.Exec(context.Background(), session, textPrompt(" inspect repo "), "", "turn-1", func(events []activityshared.Event) {
		emittedActivity = append(emittedActivity, events...)
	}, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	assistantMessages := activityMessagesWithRole(emittedActivity, activityshared.MessageRoleAssistant)
	if len(assistantMessages) == 0 {
		t.Fatal("assistant messages = 0, want completed long assistant message")
	}
	completed := assistantMessages[len(assistantMessages)-1]
	if completed.Payload.Content != longContent {
		t.Fatalf("completed assistant content length = %d, want full length %d", len(completed.Payload.Content), len(longContent))
	}

	report := reportActivityInput(session, activityEvents)
	var assistantUpdate agentsessionstore.WorkspaceAgentMessageUpdate
	for _, update := range report.MessageUpdates {
		if update.Role == "assistant" && update.Kind == "text" {
			assistantUpdate = update
		}
	}
	if assistantUpdate.Payload["text"] != longContent {
		got, _ := assistantUpdate.Payload["text"].(string)
		t.Fatalf("assistant message update content length = %d, want full length %d", len(got), len(longContent))
	}
}

func TestCodexAdapterExecUsesDisplayPromptForUserMessageOnly(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	adapter := NewCodexAdapter(transport)
	session := testSession()
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "codex-acp-session-1"

	var emittedActivity []activityshared.Event
	_, err := adapter.Exec(
		context.Background(),
		session,
		textPrompt("real automation prompt"),
		"Run Automation",
		"turn-1",
		func(events []activityshared.Event) {
			emittedActivity = append(emittedActivity, events...)
		},
		nil,
	)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	if !hasActivityMessage(emittedActivity, activityshared.MessageRoleUser, "Run Automation") {
		t.Fatalf("emitted events = %#v, missing display prompt user message", emittedActivity)
	}
	userMessages := activityMessagesWithRole(emittedActivity, activityshared.MessageRoleUser)
	if len(userMessages) == 0 || userMessages[0].Payload.Metadata["displayPrompt"] != "Run Automation" {
		t.Fatalf("user message metadata = %#v, want display prompt", userMessages)
	}
	if hasActivityMessage(emittedActivity, activityshared.MessageRoleUser, "real automation prompt") {
		t.Fatalf("emitted events = %#v, leaked provider prompt as user message", emittedActivity)
	}
	titleEvents := activityEventsWithType(emittedActivity, activityshared.EventSessionUpdated)
	if len(titleEvents) == 0 || titleEvents[0].Payload.Title != "Run Automation" {
		t.Fatalf("title events = %#v, want display prompt fallback title", titleEvents)
	}

	params := acpRequestParams(t, transport.conn, acpMethodPrompt)
	promptBlocks, _ := params["prompt"].([]any)
	if len(promptBlocks) != 1 {
		t.Fatalf("ACP prompt blocks = %#v, want one block", params["prompt"])
	}
	block, _ := promptBlocks[0].(map[string]any)
	if got := asString(block["text"]); got != "real automation prompt" {
		t.Fatalf("ACP prompt text = %q, want provider prompt", got)
	}
}

func TestCodexAdapterAllowsImagePromptWithoutInitializeCapability(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	adapter := NewCodexAdapter(transport)
	session := testSession()
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "codex-acp-session-1"

	content := []PromptContentBlock{{
		Type: "text",
		Text: "what is in this image?",
	}, {
		Type:     "image",
		MimeType: "image/png",
		Data:     "aW1hZ2U=",
	}}
	if err := adapter.ValidatePromptContent(session, content); err != nil {
		t.Fatalf("ValidatePromptContent: %v", err)
	}
	snapshot := adapter.SessionState(session)
	// The legacy codex-acp adapter reports no capabilities list; image input
	// rides the permissive null default while ValidatePromptContent accepts it.
	if _, ok := snapshot.RuntimeContext["capabilities"]; ok {
		t.Fatalf("legacy codex adapter unexpectedly reports capabilities: %#v", snapshot.RuntimeContext["capabilities"])
	}

	_, err := adapter.Exec(
		context.Background(),
		session,
		content,
		"",
		"turn-1",
		func([]activityshared.Event) {},
		nil,
	)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	params := acpRequestParams(t, transport.conn, acpMethodPrompt)
	promptBlocks, _ := params["prompt"].([]any)
	if len(promptBlocks) != 2 {
		t.Fatalf("ACP prompt blocks = %#v, want text and image blocks", params["prompt"])
	}
	textBlock, _ := promptBlocks[0].(map[string]any)
	if got := asString(textBlock["text"]); got != "what is in this image?" {
		t.Fatalf("ACP prompt text = %q, want original text", got)
	}
	imageBlock, _ := promptBlocks[1].(map[string]any)
	if got := asString(imageBlock["type"]); got != "image" {
		t.Fatalf("ACP image block type = %q, want image", got)
	}
	if got := asString(imageBlock["mimeType"]); got != "image/png" {
		t.Fatalf("ACP image mimeType = %q, want image/png", got)
	}
	if got := asString(imageBlock["data"]); got != "aW1hZ2U=" {
		t.Fatalf("ACP image data = %q, want original base64", got)
	}
}

func TestPromptTitleSnippetHumanizesMentionMarkdownBeforeTruncation(t *testing.T) {
	t.Parallel()

	got := promptTitleSnippet(
		"[@wang jomes & Codex hi](mention://session?roomId=room-1&id=session-1)",
	)

	if got != "@wang jomes & Codex hi" {
		t.Fatalf("promptTitleSnippet() = %q, want mention label", got)
	}
}

func TestPromptTitleSnippetHumanizesWorkspaceMarkdownLinkBeforeTruncation(t *testing.T) {
	t.Parallel()

	got := promptTitleSnippet(
		"[@aa.md](/workspace/ccb5cd30-b863-4b61-ab17-ccab/aa.md) 这是什么内容",
	)

	if got != "@aa.md 这是什么内容" {
		t.Fatalf("promptTitleSnippet() = %q, want file link label", got)
	}
}

func TestCodexACPNormalizerSegmentsAssistantMessagesAroundToolCalls(t *testing.T) {
	t.Parallel()

	session := testSession()
	session.ProviderSessionID = "codex-acp-session-1"
	normalizer := newACPTurnNormalizer()

	var events []activityshared.Event
	events = append(events, normalizer.AppendAssistantChunk(session, "turn-1", "Before tool. ")...)
	toolEvents, ok := normalizer.ToolCallEvents(session, "turn-1", map[string]any{
		"toolCallId": "tool-1",
		"title":      "Read files",
		"status":     "in_progress",
	})
	if !ok {
		t.Fatal("ToolCallEvents() returned !ok")
	}
	events = append(events, toolEvents...)
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
		t.Fatalf("assistant event IDs = %#v, want distinct IDs for text separated by tool calls", assistantMessages)
	}
	if assistantMessages[0].Payload.Content != "Before tool. " ||
		assistantMessages[1].Payload.Content != "Before tool. " ||
		assistantMessages[2].Payload.Content != "After tool." ||
		assistantMessages[3].Payload.Content != "After tool." {
		t.Fatalf("assistant contents = %#v, want separate message segments", assistantMessages)
	}
	if events[1].Type != activityshared.EventMessageAppended ||
		events[2].Type != activityshared.EventCallStarted ||
		events[3].Type != activityshared.EventMessageAppended {
		t.Fatalf("event order = %#v, want message completion, tool call, then next message", events)
	}
}

func TestCodexACPNormalizerSplitsAssistantMessagesWhenTerminalToolUpdateIsInferredFromRawOutput(t *testing.T) {
	t.Parallel()

	session := testSession()
	session.ProviderSessionID = "codex-acp-session-2"
	normalizer := newACPTurnNormalizer()

	var events []activityshared.Event
	events = append(events, normalizer.AppendAssistantChunk(session, "turn-1", "构建已经开始，我在等产物输出；如果这里过了，下一步就直接起本地预览，把核心流程点一遍。")...)
	toolEvents, ok := normalizer.ToolCallEvents(session, "turn-1", readSessionTestdataJSON(t, "codex_acp_tool_call_update_completed_without_status.json"))
	if !ok {
		t.Fatal("ToolCallEvents() returned !ok")
	}
	events = append(events, toolEvents...)
	events = append(events, normalizer.AppendAssistantChunk(session, "turn-1", "构建通过了。我再起一个本地预览服务，确认页面能正常对外提供，再补一遍项目文件和设计图路径给你。")...)
	events = append(events, normalizer.Finish(session, "turn-1", messageStreamStateCompleted)...)

	assistantMessages := activityMessagesWithRole(events, activityshared.MessageRoleAssistant)
	if len(assistantMessages) != 4 {
		t.Fatalf("assistant messages = %#v, want two completed assistant segments split by inferred terminal tool event", assistantMessages)
	}
	if assistantMessages[1].EventID == assistantMessages[3].EventID {
		t.Fatalf("assistant event IDs = %#v, want distinct message ids after inferred terminal tool event", assistantMessages)
	}
	if assistantMessages[1].Payload.Content != "构建已经开始，我在等产物输出；如果这里过了，下一步就直接起本地预览，把核心流程点一遍。" {
		t.Fatalf("assistant messages = %#v, want first commentary preserved as its own segment", assistantMessages)
	}
	if assistantMessages[3].Payload.Content != "构建通过了。我再起一个本地预览服务，确认页面能正常对外提供，再补一遍项目文件和设计图路径给你。" {
		t.Fatalf("assistant messages = %#v, want second commentary preserved as its own segment", assistantMessages)
	}
}

func TestACPToolCallEventPreservesStructuredInputAndOutput(t *testing.T) {
	t.Parallel()

	session := testSession()
	started, ok := acpToolCallEventWithID(session, "event-start", "turn-1", map[string]any{
		"sessionUpdate": "tool_call",
		"toolCallId":    "tool-1",
		"title":         "Run command",
		"kind":          "execute",
		"status":        "in_progress",
		"rawInput": map[string]any{
			"command": []any{"/bin/zsh", "-lc", "rg TODO"},
			"cwd":     "/workspace/project",
		},
		"locations": []any{
			map[string]any{"path": "README.md", "line": float64(12)},
		},
	})
	if !ok {
		t.Fatal("acpToolCallEventWithID(started) returned !ok")
	}
	if started.Type != activityshared.EventCallStarted {
		t.Fatalf("started event type = %s, want call.started", started.Type)
	}
	if got := started.Payload.Input["command"]; got != "rg TODO" {
		t.Fatalf("started input = %#v, want normalized shell command", started.Payload.Input)
	}
	if got := started.Payload.Input["cwd"]; got != "/workspace/project" {
		t.Fatalf("started input = %#v, want cwd preserved", started.Payload.Input)
	}
	if got := started.Payload.Metadata["kind"]; got != "execute" {
		t.Fatalf("started metadata = %#v, want ACP kind", started.Payload.Metadata)
	}
	if got := started.Payload.Metadata["toolName"]; got != "Bash" {
		t.Fatalf("started metadata = %#v, want canonical toolName", started.Payload.Metadata)
	}
	acpMetadata, ok := started.Payload.Metadata["acp"].(map[string]any)
	if !ok || acpMetadata["sessionUpdate"] != "tool_call" || acpMetadata["kind"] != "execute" {
		t.Fatalf("started metadata = %#v, want ACP metadata envelope", started.Payload.Metadata)
	}
	if _, ok := started.Payload.Metadata["locations"].([]any); !ok {
		t.Fatalf("started metadata = %#v, want ACP locations", started.Payload.Metadata)
	}

	completed, ok := acpToolCallEventWithID(session, "event-complete", "turn-1", map[string]any{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "tool-1",
		"title":         "Run command",
		"kind":          "execute",
		"status":        "completed",
		"rawOutput": map[string]any{
			"stdout":   "README.md\n",
			"stderr":   "",
			"exitCode": float64(0),
		},
		"content": []any{
			map[string]any{
				"type":       "terminal",
				"terminalId": "term-1",
			},
		},
	})
	if !ok {
		t.Fatal("acpToolCallEventWithID(completed) returned !ok")
	}
	if completed.Type != activityshared.EventCallCompleted {
		t.Fatalf("completed event type = %s, want call.completed", completed.Type)
	}
	if got := completed.Payload.Output["stdout"]; got != "README.md\n" {
		t.Fatalf("completed output = %#v, want stdout preserved", completed.Payload.Output)
	}
	if _, ok := completed.Payload.Output["content"].([]any); !ok {
		t.Fatalf("completed output = %#v, want ACP content preserved", completed.Payload.Output)
	}
	if got := completed.Payload.Metadata["kind"]; got != "execute" {
		t.Fatalf("completed metadata = %#v, want ACP kind", completed.Payload.Metadata)
	}
	if got := completed.Payload.Metadata["toolName"]; got != "Bash" {
		t.Fatalf("completed metadata = %#v, want canonical toolName", completed.Payload.Metadata)
	}
}

func TestACPToolCallEventFailedPreservesVisibleOutputAndError(t *testing.T) {
	t.Parallel()

	session := testSession()
	failed, ok := acpToolCallEventWithID(session, "event-failed", "turn-1", map[string]any{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "tool-1",
		"title":         "Run command",
		"kind":          "execute",
		"status":        "failed",
		"rawOutput": map[string]any{
			"stdout":            "",
			"stderr":            "fatal: not a git repository\n",
			"aggregated_output": "fatal: not a git repository\n",
			"exitCode":          float64(128),
		},
		"content": []any{
			map[string]any{
				"type": "output_text",
				"text": "fatal: not a git repository\n",
			},
		},
	})
	if !ok {
		t.Fatal("acpToolCallEventWithID(failed) returned !ok")
	}
	if failed.Type != activityshared.EventCallFailed {
		t.Fatalf("failed event type = %s, want call.failed", failed.Type)
	}
	if got := failed.Payload.Error["aggregated_output"]; got != "fatal: not a git repository\n" {
		t.Fatalf("failed error = %#v, want aggregated_output preserved", failed.Payload.Error)
	}
	if got := failed.Payload.Output["aggregated_output"]; got != "fatal: not a git repository\n" {
		t.Fatalf("failed output = %#v, want visible output mirrored", failed.Payload.Output)
	}
	if got := failed.Payload.Output["stderr"]; got != "fatal: not a git repository\n" {
		t.Fatalf("failed output = %#v, want stderr mirrored", failed.Payload.Output)
	}
	if got := failed.Payload.Metadata["toolName"]; got != "Bash" {
		t.Fatalf("failed metadata = %#v, want canonical toolName", failed.Payload.Metadata)
	}
}

func TestACPFailureMetadataPrefersProviderErrorDataMessage(t *testing.T) {
	t.Parallel()

	payload := acpFailureMetadata(&acpCallError{
		Method: acpMethodPrompt,
		Err: acpError{
			Code:    -32603,
			Message: "Internal error",
			Data:    []byte(`{"message":"You've hit your usage limit. Upgrade to Plus to continue using Codex.","codex_error_info":"usage_limit_exceeded"}`),
		},
	})

	if got := payload["error"]; got != "You've hit your usage limit. Upgrade to Plus to continue using Codex." {
		t.Fatalf("error = %#v, want provider message", got)
	}
	if got := payload["errorMessage"]; got != payload["error"] {
		t.Fatalf("errorMessage = %#v, want %q", got, payload["error"])
	}
	if got := payload["codexErrorInfo"]; got != "usage_limit_exceeded" {
		t.Fatalf("codexErrorInfo = %#v, want usage_limit_exceeded", got)
	}
	if got := payload["acpErrorMessage"]; got != "Internal error" {
		t.Fatalf("acpErrorMessage = %#v, want Internal error", got)
	}
}

func TestACPToolCallEventInfersCompletedStatusFromRawOutput(t *testing.T) {
	t.Parallel()

	session := testSession()
	completed, ok := acpToolCallEventWithID(session, "event-complete-inferred", "turn-1", readSessionTestdataJSON(t, "codex_acp_tool_call_update_completed_without_status.json"))
	if !ok {
		t.Fatal("acpToolCallEventWithID(inferred complete) returned !ok")
	}
	if completed.Type != activityshared.EventCallCompleted {
		t.Fatalf("completed event type = %s, want call.completed", completed.Type)
	}
	if got := completed.Payload.Output["stdout"]; got != "README.md\n" {
		t.Fatalf("completed output = %#v, want stdout preserved", completed.Payload.Output)
	}
}

func TestACPToolCallEventInfersFailedStatusFromRawOutput(t *testing.T) {
	t.Parallel()

	session := testSession()
	failed, ok := acpToolCallEventWithID(session, "event-failed-inferred", "turn-1", readSessionTestdataJSON(t, "codex_acp_tool_call_update_failed_without_status.json"))
	if !ok {
		t.Fatal("acpToolCallEventWithID(inferred failed) returned !ok")
	}
	if failed.Type != activityshared.EventCallFailed {
		t.Fatalf("failed event type = %s, want call.failed", failed.Type)
	}
	if got := failed.Payload.Error["output"]; got != "Exit code 137" {
		t.Fatalf("failed error = %#v, want raw output preserved", failed.Payload.Error)
	}
}

func TestACPToolCallEventSanitizesImageBytesFromInputAndContent(t *testing.T) {
	t.Parallel()

	session := testSession()
	started, ok := acpToolCallEventWithID(session, "event-image-start", "turn-1", map[string]any{
		"sessionUpdate": "tool_call",
		"toolCallId":    "image-tool-1",
		"title":         "Image generation",
		"kind":          "other",
		"status":        "in_progress",
		"rawInput": map[string]any{
			"prompt": "a joyful little girl dancing",
			"content": []any{
				map[string]any{
					"type":     "image",
					"uri":      "/workspace/output/generated.png",
					"mimeType": "image/png",
					"data":     "input-image-bytes",
				},
			},
		},
	})
	if !ok {
		t.Fatal("acpToolCallEventWithID(image start) returned !ok")
	}
	startedContent := payloadArray(started.Payload.Input["content"])
	if len(startedContent) != 1 {
		t.Fatalf("started input content = %#v, want 1 image block", started.Payload.Input["content"])
	}
	if _, exists := startedContent[0]["data"]; exists {
		t.Fatalf("started input retained image data bytes: %#v", started.Payload.Input["content"])
	}

	completed, ok := acpToolCallEventWithID(session, "event-image-complete", "turn-1", map[string]any{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "image-tool-1",
		"title":         "Image generation",
		"kind":          "other",
		"status":        "completed",
		"rawOutput": map[string]any{
			"ok": true,
		},
		"content": []any{
			map[string]any{
				"type": "output_text",
				"text": "Revised prompt: a joyful little girl dancing",
			},
			map[string]any{
				"type":     "image",
				"uri":      "/workspace/output/generated.png",
				"mimeType": "image/png",
				"data":     "output-image-bytes",
			},
		},
	})
	if !ok {
		t.Fatal("acpToolCallEventWithID(image complete) returned !ok")
	}
	metadataContent := payloadArray(completed.Payload.Metadata["content"])
	if len(metadataContent) != 2 {
		t.Fatalf("completed metadata content = %#v, want 2 content blocks", completed.Payload.Metadata["content"])
	}
	if _, exists := metadataContent[1]["data"]; exists {
		t.Fatalf("completed metadata retained image data bytes: %#v", completed.Payload.Metadata["content"])
	}
	outputContent := payloadArray(completed.Payload.Output["content"])
	if len(outputContent) != 2 {
		t.Fatalf("completed output content = %#v, want 2 content blocks", completed.Payload.Output["content"])
	}
	if _, exists := outputContent[1]["data"]; exists {
		t.Fatalf("completed output retained image data bytes: %#v", completed.Payload.Output["content"])
	}
}

func TestACPToolCallEventInfersCompletedStatusFromImageGenerationContent(t *testing.T) {
	t.Parallel()

	session := testSession()
	completed, ok := acpToolCallEventWithID(session, "event-image-complete-inferred", "turn-1", map[string]any{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "ig_1234567890abcdef",
		"title":         "Image generation",
		"kind":          "other",
		"status":        "generating",
		"content": []any{
			map[string]any{
				"type": "output_text",
				"text": "Revised prompt: a joyful little girl dancing",
			},
			map[string]any{
				"type":     "image",
				"uri":      "/home/user/.codex/generated_images/session/ig_1234567890abcdef.png",
				"mimeType": "image/png",
			},
		},
	})
	if !ok {
		t.Fatal("acpToolCallEventWithID(image inferred complete) returned !ok")
	}
	if completed.Type != activityshared.EventCallCompleted {
		t.Fatalf("completed event type = %s, want call.completed", completed.Type)
	}
	outputContent := payloadArray(completed.Payload.Output["content"])
	if len(outputContent) != 2 {
		t.Fatalf("completed output content = %#v, want 2 content blocks", completed.Payload.Output["content"])
	}
	if got := payloadString(outputContent[0], "text"); got != "Revised prompt: a joyful little girl dancing" {
		t.Fatalf("completed output text = %q, want revised prompt", got)
	}
	if got := payloadString(outputContent[1], "uri"); got != "/home/user/.codex/generated_images/session/ig_1234567890abcdef.png" {
		t.Fatalf("completed output image = %#v, want uri preserved", outputContent[1])
	}
}

func TestACPToolCallEventInfersCompletedStatusFromImageGenerationSavedPath(t *testing.T) {
	t.Parallel()

	session := testSession()
	completed, ok := acpToolCallEventWithID(session, "event-image-saved-path-inferred", "turn-1", map[string]any{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "ig_abcdef1234567890",
		"status":        "generating",
		"saved_path":    "/home/user/.codex/generated_images/session/ig_abcdef1234567890.png",
	})
	if !ok {
		t.Fatal("acpToolCallEventWithID(image saved_path inferred) returned !ok")
	}
	if completed.Type != activityshared.EventCallCompleted {
		t.Fatalf("completed event type = %s, want call.completed", completed.Type)
	}
}

func TestACPToolCallEventMapsFetchActionsToWebToolNames(t *testing.T) {
	t.Parallel()

	session := testSession()
	searchEvent, ok := acpToolCallEventWithID(session, "event-search", "turn-1", map[string]any{
		"sessionUpdate": "tool_call",
		"toolCallId":    "tool-search",
		"title":         "Searching the Web",
		"kind":          "fetch",
		"status":        "in_progress",
		"rawInput": map[string]any{
			"action": map[string]any{
				"type":  "search",
				"query": "today top news",
			},
		},
	})
	if !ok {
		t.Fatal("acpToolCallEventWithID(searchEvent) returned !ok")
	}
	if got := searchEvent.Payload.Metadata["toolName"]; got != "WebSearch" {
		t.Fatalf("search metadata = %#v, want WebSearch", searchEvent.Payload.Metadata)
	}
	if got := searchEvent.Payload.Input["query"]; got != "today top news" {
		t.Fatalf("search input = %#v, want normalized query", searchEvent.Payload.Input)
	}

	fetchEvent, ok := acpToolCallEventWithID(session, "event-fetch", "turn-1", map[string]any{
		"sessionUpdate": "tool_call",
		"toolCallId":    "tool-fetch",
		"title":         "Searching the Web",
		"kind":          "fetch",
		"status":        "in_progress",
		"rawInput": map[string]any{
			"action": map[string]any{
				"type": "open_page",
				"url":  "https://example.com/story",
			},
		},
	})
	if !ok {
		t.Fatal("acpToolCallEventWithID(fetchEvent) returned !ok")
	}
	if got := fetchEvent.Payload.Metadata["toolName"]; got != "WebFetch" {
		t.Fatalf("fetch metadata = %#v, want WebFetch", fetchEvent.Payload.Metadata)
	}
	if got := fetchEvent.Payload.Input["url"]; got != "https://example.com/story" {
		t.Fatalf("fetch input = %#v, want normalized url", fetchEvent.Payload.Input)
	}
}

func TestACPToolNameMapsCanonicalKinds(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		title    string
		kind     string
		rawInput any
		want     string
	}{
		{
			name:     "read pattern becomes glob",
			kind:     "read",
			rawInput: map[string]any{"pattern": "*.ts"},
			want:     "Glob",
		},
		{
			name: "move becomes edit",
			kind: "move",
			want: "Edit",
		},
		{
			name:  "search grep title becomes grep",
			title: "rg",
			kind:  "search",
			want:  "Grep",
		},
		{
			name:  "search glob title becomes glob",
			title: "fd",
			kind:  "search",
			want:  "Glob",
		},
		{
			name:     "think todos becomes todo write",
			kind:     "think",
			rawInput: map[string]any{"todos": []any{map[string]any{"content": "ship parity"}}},
			want:     "TodoWrite",
		},
		{
			name:  "other task title becomes agent",
			title: "task",
			kind:  "other",
			want:  "Agent",
		},
		{
			name:  "other agent title becomes agent",
			title: "agent",
			kind:  "other",
			want:  "Agent",
		},
		{
			name:  "searching for title becomes web search without kind",
			title: "Searching for: renderer parity harness",
			want:  "WebSearch",
		},
		{
			name:  "enter plan mode synthetic title stays canonical",
			title: "EnterPlanMode",
			want:  "EnterPlanMode",
		},
		{
			name:  "tool search synthetic title stays canonical",
			title: "ToolSearch",
			want:  "ToolSearch",
		},
		{
			name:  "skill synthetic title stays canonical",
			title: "Skill",
			want:  "Skill",
		},
		{
			name: "missing hints falls back to generic tool label",
			want: "Tool",
		},
		{
			name:  "unknown mcp tool title is preserved",
			title: "mcp__Atlassian__searchJiraIssuesUsingJql",
			want:  "mcp__Atlassian__searchJiraIssuesUsingJql",
		},
		{
			name:     "execute agent input becomes agent",
			kind:     "execute",
			rawInput: map[string]any{"agentName": "reviewer"},
			want:     "Agent",
		},
		{
			name:  "run subagent title becomes agent",
			title: "run_subagent",
			want:  "Agent",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			if got := acpToolName("", tt.title, tt.kind, tt.rawInput); got != tt.want {
				t.Fatalf("acpToolName(%q, %q, %#v) = %q, want %q", tt.title, tt.kind, tt.rawInput, got, tt.want)
			}
		})
	}
}

func TestACPToolNameMapsSyntheticCallIDsAndCommandInputs(t *testing.T) {
	t.Parallel()

	if got := acpToolName("web_search_123", "today headlines", "search", nil); got != "WebSearch" {
		t.Fatalf("acpToolName(web_search_123, ...) = %q, want WebSearch", got)
	}
	if got := acpToolName("call_123", "exec_command", "", map[string]any{"cmd": "pwd"}); got != "Bash" {
		t.Fatalf("acpToolName(exec_command) = %q, want Bash", got)
	}
}

func TestACPNormalizeToolInputCanonicalizesCmd(t *testing.T) {
	t.Parallel()

	input := acpNormalizeToolInput(map[string]any{
		"cmd": "pwd",
		"cwd": "/workspace/project",
	}, "execute", nil)

	if got := asString(input["command"]); got != "pwd" {
		t.Fatalf("normalized command = %q, want pwd", got)
	}
	if _, ok := input["cmd"]; ok {
		t.Fatalf("normalized input = %#v, want cmd removed after canonicalization", input)
	}
}

func TestACPInteractiveToolNameMapsSyntheticTools(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		call map[string]any
		want string
	}{
		{
			name: "enter plan mode",
			call: map[string]any{"title": "EnterPlanMode"},
			want: "EnterPlanMode",
		},
		{
			name: "ask user question",
			call: map[string]any{"title": "AskUserQuestion"},
			want: "AskUserQuestion",
		},
		{
			name: "exit plan mode",
			call: map[string]any{"title": "ExitPlanMode"},
			want: "ExitPlanMode",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := acpInteractiveToolName(tt.call); got != tt.want {
				t.Fatalf("acpInteractiveToolName(%#v) = %q, want %q", tt.call, got, tt.want)
			}
		})
	}
}

func TestACPPermissionEventsCarryCanonicalToolName(t *testing.T) {
	t.Parallel()

	session := testSession()
	adapter := NewCodexAdapter(newScriptedACPTransport())

	approvalEvents, pendingApproval, err := adapter.acpPermissionRequested(
		session,
		"turn-approval",
		json.RawMessage(`"permission-approval"`),
		json.RawMessage(`{
			"toolCall": {
				"toolCallId": "approval-1",
				"title": "Run command",
				"input": {
					"command": ["touch", "/workspace/project/approval-check.txt"],
					"description": "Create a temporary approval check file."
				}
			},
			"options": [{"optionId": "allow_once", "label": "Allow once"}]
		}`),
	)
	if err != nil {
		t.Fatalf("acpPermissionRequested(approval): %v", err)
	}
	approvalStarted := activityEventsWithType(approvalEvents, activityshared.EventCallStarted)
	if len(approvalStarted) != 1 {
		t.Fatalf("approval started events = %#v, want one call.started event", approvalStarted)
	}
	if got := approvalStarted[0].Payload.Metadata["toolName"]; got != "Approval" {
		t.Fatalf("approval metadata = %#v, want Approval toolName", approvalStarted[0].Payload.Metadata)
	}
	approvalInput := payloadMap(approvalStarted[0].Payload.Metadata, "input")
	if got := asString(approvalInput["command"]); got != "touch /workspace/project/approval-check.txt" {
		t.Fatalf("approval input = %#v, want normalized command", approvalInput)
	}
	if got := asString(approvalInput["description"]); got != "Create a temporary approval check file." {
		t.Fatalf("approval input = %#v, want description", approvalInput)
	}
	if got := asString(pendingApproval.snapshotPrompt().Input["command"]); got != "touch /workspace/project/approval-check.txt" {
		t.Fatalf("pending approval input = %#v, want normalized command", pendingApproval.snapshotPrompt().Input)
	}
	approvalResolved := acpPermissionResolvedEvents(session, "turn-approval", pendingApproval, pendingACPResponse{
		optionID: "allow_once",
		result:   acpPermissionResponseResult("allow_once"),
	}, nil)
	approvalCompleted := activityEventsWithType(approvalResolved, activityshared.EventCallCompleted)
	if len(approvalCompleted) != 1 {
		t.Fatalf("approval resolved events = %#v, want one call.completed event", approvalResolved)
	}
	if got := approvalCompleted[0].Payload.Metadata["toolName"]; got != "Approval" {
		t.Fatalf("approval completion metadata = %#v, want Approval toolName", approvalCompleted[0].Payload.Metadata)
	}

	interactiveEvents, pendingInteractive, err := adapter.acpPermissionRequested(
		session,
		"turn-interactive",
		json.RawMessage(`"permission-interactive"`),
		json.RawMessage(`{
			"toolCall": {
				"toolCallId": "interactive-1",
				"title": "AskUserQuestion",
				"input": {
					"questions": [{"id": "q1", "question": "Pick one"}]
				}
			},
			"options": [{"optionId": "submit", "label": "Submit"}]
		}`),
	)
	if err != nil {
		t.Fatalf("acpPermissionRequested(interactive): %v", err)
	}
	interactiveStarted := activityEventsWithType(interactiveEvents, activityshared.EventCallStarted)
	if len(interactiveStarted) != 1 {
		t.Fatalf("interactive started events = %#v, want one call.started event", interactiveStarted)
	}
	if got := interactiveStarted[0].Payload.Metadata["toolName"]; got != "AskUserQuestion" {
		t.Fatalf("interactive metadata = %#v, want AskUserQuestion toolName", interactiveStarted[0].Payload.Metadata)
	}
	interactiveResolved := acpPermissionResolvedEvents(session, "turn-interactive", pendingInteractive, pendingACPResponse{
		action: "submit",
		payload: map[string]any{
			"answersByQuestionId": map[string]any{"q1": "Renderer A"},
		},
		result: acpInteractiveResponseResult("submit", "", map[string]any{
			"answersByQuestionId": map[string]any{"q1": "Renderer A"},
		}),
	}, nil)
	interactiveCompleted := activityEventsWithType(interactiveResolved, activityshared.EventCallCompleted)
	if len(interactiveCompleted) != 1 {
		t.Fatalf("interactive resolved events = %#v, want one call.completed event", interactiveResolved)
	}
	if got := interactiveCompleted[0].Payload.Metadata["toolName"]; got != "AskUserQuestion" {
		t.Fatalf("interactive completion metadata = %#v, want AskUserQuestion toolName", interactiveCompleted[0].Payload.Metadata)
	}
}

func TestACPToolCallDiagnosticEnabledHonorsEnvironment(t *testing.T) {
	t.Setenv("TUTTI_ACP_TOOL_DEBUG", "1")
	if !acpToolCallDiagnosticEnabled() {
		t.Fatal("acpToolCallDiagnosticEnabled() = false, want true when env is enabled")
	}

	t.Setenv("TUTTI_ACP_TOOL_DEBUG", "0")
	if acpToolCallDiagnosticEnabled() {
		t.Fatal("acpToolCallDiagnosticEnabled() = true, want false when env is disabled")
	}
}

func TestLogACPToolCallDiagnosticIncludesRawAndNormalizedPayloads(t *testing.T) {
	t.Setenv("TUTTI_ACP_TOOL_DEBUG", "1")

	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	previous := slog.Default()
	slog.SetDefault(logger)
	t.Cleanup(func() {
		slog.SetDefault(previous)
	})

	logACPToolCallDiagnostic(
		testSession(),
		"turn-1",
		map[string]any{"kind": "execute", "rawInput": map[string]any{"cmd": "pwd"}},
		map[string]any{"toolName": "Bash", "input": map[string]any{"command": "pwd"}},
	)

	output := logs.String()
	if !strings.Contains(output, "raw=") {
		t.Fatalf("diagnostic log = %q, want raw payload", output)
	}
	if !strings.Contains(output, "normalized=") {
		t.Fatalf("diagnostic log = %q, want normalized payload", output)
	}
	if !strings.Contains(output, "command:pwd") {
		t.Fatalf("diagnostic log = %q, want normalized command payload", output)
	}
}

func TestPendingACPRequestResolvesPermissionDecisionAliases(t *testing.T) {
	t.Parallel()

	pending := &pendingACPRequest{
		options: []map[string]any{
			{"optionId": "allow_once", "label": "Allow once", "kind": "allow_once"},
			{"optionId": "reject", "name": "Reject", "kind": "custom_reject"},
			{"optionId": "abort", "label": "No, and tell Codex what to do differently", "kind": "reject_once"},
		},
	}

	tests := []struct {
		name     string
		optionID string
		want     string
		wantOK   bool
	}{
		{name: "exact option id", optionID: "allow_once", want: "allow_once", wantOK: true},
		{name: "exact abort option id", optionID: "abort", want: "abort", wantOK: true},
		{name: "approved decision alias", optionID: "approve", want: "allow_once", wantOK: true},
		{name: "denied decision alias from ACP name", optionID: "deny", want: "reject", wantOK: true},
		{name: "unknown alias", optionID: "maybe", wantOK: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, ok := pending.resolvePermissionOptionID(tt.optionID)
			if ok != tt.wantOK || got != tt.want {
				t.Fatalf("resolvePermissionOptionID(%q) = %q, %v; want %q, %v", tt.optionID, got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

func TestCodexAdapterPermissionRequestWaitsForUserSelection(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	transport.conn.promptPermission = true
	adapter := NewCodexAdapter(transport)
	session := testSession()
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "codex-acp-session-1"

	var mu sync.Mutex
	var emittedActivity []activityshared.Event
	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("run tests"), "", "turn-1", func(events []activityshared.Event) {
			mu.Lock()
			emittedActivity = append(emittedActivity, events...)
			mu.Unlock()
		}, nil)
		execDone <- err
	}()

	waitForCondition(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		streamEvents := ProjectActivityEventsToStreamEvents(session, emittedActivity)
		return hasStreamCallEvent(streamEvents, "approval", "waiting_approval")
	})

	select {
	case err := <-execDone:
		t.Fatalf("Exec finished before permission response: %v", err)
	default:
	}

	if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		RequestID: "permission-1",
		OptionID:  "approve",
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if err := <-execDone; err != nil {
		t.Fatalf("Exec after permission response: %v", err)
	}

	mu.Lock()
	streamEvents := ProjectActivityEventsToStreamEvents(session, emittedActivity)
	mu.Unlock()
	if !hasStreamCallEvent(streamEvents, "approval", "completed") {
		t.Fatalf("events = %#v, missing completed approval event", streamEvents)
	}
	approvalItems := approvalMessageUpdates(streamEvents)
	if len(approvalItems) < 2 {
		t.Fatalf("approval message updates = %#v, want start and completion", approvalItems)
	}
	if approvalItems[0].MessageID == "" || approvalItems[1].MessageID != approvalItems[0].MessageID {
		t.Fatalf("approval message ids = %#v, want stable message id", approvalItems)
	}
	if got := transport.conn.permissionOptionID(); got != "allow_once" {
		t.Fatalf("permission option id = %q, want allow_once", got)
	}
}

func TestCodexAdapterPermissionRequestPreservesAbortInteractiveSelection(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	transport.conn.promptPermission = true
	adapter := NewCodexAdapter(transport)
	session := testSession()
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "codex-acp-session-1"

	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("run tests"), "", "turn-1", func([]activityshared.Event) {}, nil)
		execDone <- err
	}()

	waitForCondition(t, func() bool {
		return adapter.getPendingRequest(session.AgentSessionID, "permission-1") != nil
	})

	if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		RequestID: "permission-1",
		Action:    "deny",
		OptionID:  "abort",
		Payload: map[string]any{
			"denyMessage": "Please split the work into smaller steps.",
		},
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if err := <-execDone; err != nil {
		t.Fatalf("Exec after permission response: %v", err)
	}
	if got := transport.conn.permissionOptionID(); got != "abort" {
		t.Fatalf("permission option id = %q, want abort", got)
	}
	outcome := transport.conn.interactiveOutcome()
	if outcome["outcome"] != "selected" || outcome["optionId"] != "abort" {
		t.Fatalf("permission outcome = %#v, want selected abort", outcome)
	}
	if payload, ok := outcome["payload"].(map[string]any); ok && payload["denyMessage"] != nil {
		t.Fatalf("permission payload = %#v, want deny feedback kept outside ACP permission response", payload)
	}
}

func TestCodexAdapterCancelRejectsPendingPermissionRequest(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	transport.conn.promptPermission = true
	adapter := NewCodexAdapter(transport)
	session := testSession()
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "codex-acp-session-1"

	var mu sync.Mutex
	var emittedActivity []activityshared.Event
	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("run tests"), "", "turn-1", func(events []activityshared.Event) {
			mu.Lock()
			emittedActivity = append(emittedActivity, events...)
			mu.Unlock()
		}, nil)
		execDone <- err
	}()

	waitForCondition(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		streamEvents := ProjectActivityEventsToStreamEvents(session, emittedActivity)
		return hasStreamCallEvent(streamEvents, "approval", "waiting_approval")
	})

	if _, err := adapter.Cancel(context.Background(), session, "user"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	select {
	case err := <-execDone:
		if err != nil {
			t.Fatalf("Exec after cancel: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Exec did not finish after cancel rejected pending permission")
	}
	if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		RequestID: "permission-1",
		OptionID:  "allow_once",
	}); err == nil {
		t.Fatal("SubmitInteractive after cancel returned nil error, want no longer live")
	}
	mu.Lock()
	streamEvents := ProjectActivityEventsToStreamEvents(session, emittedActivity)
	mu.Unlock()
	if !hasStreamCallEvent(streamEvents, "approval", "failed") {
		t.Fatalf("events = %#v, missing failed approval event", streamEvents)
	}
}

func TestCodexAdapterExecTreatsContextCanceledAsInterrupted(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	gate := make(chan struct{})
	transport.conn.pauseBeforePromptResult = gate
	adapter := NewCodexAdapter(transport)
	session := testSession()
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "codex-acp-session-1"

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var releaseGate sync.Once
	time.AfterFunc(200*time.Millisecond, func() {
		releaseGate.Do(func() { close(gate) })
	})

	var mu sync.Mutex
	var emittedActivity []activityshared.Event
	_, err := adapter.Exec(ctx, session, textPrompt("run tests"), "", "turn-1", func(events []activityshared.Event) {
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
	if !hasStreamCallEvent(streamEvents, "tool", SessionStatusCanceled) {
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

func TestCodexAdapterRejectsPermissionOutsidePromptTurn(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAdapter(newScriptedACPTransport())
	session := testSession()
	client := newACPClient(newScriptedACPTransport().conn)
	_, err := adapter.handleACPMessage(
		context.Background(),
		client,
		session,
		"",
		acpMessage{
			ID:     json.RawMessage(`"permission-1"`),
			Method: acpMethodPermission,
			Params: json.RawMessage(`{
				"toolCall": {"toolCallId": "approval-1", "title": "Run command"},
				"options": [{"optionId": "allow_once", "label": "Allow once"}]
			}`),
		},
		nil,
		nil,
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "outside active prompt turn") {
		t.Fatalf("handleACPMessage error = %v, want outside active prompt turn", err)
	}
	if pending := adapter.getPendingRequest(session.AgentSessionID, "permission-1"); pending != nil {
		t.Fatalf("pending request = %#v, want none", pending)
	}
}

func TestCodexAdapterSessionStateExposesPendingAskUserPromptAndSubmitsPayload(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	transport.conn.promptKind = "ask-user"
	adapter := NewCodexAdapter(transport)
	session := testSession()
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "codex-acp-session-1"

	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("choose plan"), "", "turn-ask-user", func([]activityshared.Event) {}, nil)
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
		Payload: map[string]any{
			"answers":             []string{"Renderer A"},
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

func TestCodexAdapterSessionStateExposesPendingExitPlanPrompt(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	transport.conn.promptKind = "exit-plan"
	adapter := NewCodexAdapter(transport)
	session := testSession()
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "codex-acp-session-1"

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

func TestCodexAdapterSessionStateIncludesModeCommandsAndConfigUpdates(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAdapter(newScriptedACPTransport())
	session := testSession()
	codexHome := t.TempDir()
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(`
model_provider = "proxy"

[model_providers.proxy]
base_url = "https://openai.proxy.test/v1"
`), 0o600); err != nil {
		t.Fatalf("write codex config: %v", err)
	}
	session.Env = []string{"CODEX_HOME=" + codexHome}
	session.Settings = &SessionSettings{
		Model:           "gpt-5.5",
		ReasoningEffort: "high",
	}
	adapter.storeSession(session.AgentSessionID, &codexACPSession{
		providerSessionID: session.ProviderSessionID,
	})

	adapter.applyACPUpdate(session.AgentSessionID, json.RawMessage(`{
		"update": {
			"sessionUpdate": "current_mode_update",
			"modeId": "plan"
		}
	}`))
	adapter.applyACPUpdate(session.AgentSessionID, json.RawMessage(`{
		"update": {
			"sessionUpdate": "available_commands_update",
			"commands": [
				{"name": "read_file", "description": "Read a file", "input": {"hint": "path"}},
				"exec_command",
				{"name": "   "},
				{"name": "read_file", "description": "Duplicate"}
			]
		}
	}`))
	adapter.applyACPUpdate(session.AgentSessionID, json.RawMessage(`{
		"update": {
			"sessionUpdate": "config_option_update",
			"key": "model",
			"value": "gpt-5.4"
		}
	}`))
	adapter.applyACPUpdate(session.AgentSessionID, json.RawMessage(`{
		"update": {
			"sessionUpdate": "config_option_update",
			"key": "model_reasoning_effort",
			"value": "xhigh"
		}
	}`))
	adapter.applyACPUpdate(session.AgentSessionID, json.RawMessage(`{
		"update": {
			"sessionUpdate": "config_option_update",
			"key": "approval_policy",
			"value": "on-request"
		}
	}`))
	adapter.applyACPUpdate(session.AgentSessionID, json.RawMessage(`{
		"update": {
			"sessionUpdate": "usage_update",
			"used": 97100,
			"size": 258000
		}
	}`))

	snapshot := adapter.SessionState(session)
	if got := asString(snapshot.RuntimeContext["mode"]); got != "plan" {
		t.Fatalf("runtime context mode = %q, want plan", got)
	}
	commands, _ := snapshot.RuntimeContext["commands"].([]string)
	if len(commands) != 2 || commands[0] != "read_file" || commands[1] != "exec_command" {
		t.Fatalf("runtime context commands = %#v, want deduped commands", snapshot.RuntimeContext["commands"])
	}
	commandSnapshot, ok := adapter.SessionCommandSnapshot(session)
	if !ok {
		t.Fatal("SessionCommandSnapshot ok=false, want parsed command snapshot")
	}
	if len(commandSnapshot.Commands) != 2 ||
		commandSnapshot.Commands[0].Name != "read_file" ||
		commandSnapshot.Commands[0].Description != "Read a file" ||
		commandSnapshot.Commands[0].InputHint != "path" ||
		commandSnapshot.Commands[1].Name != "exec_command" {
		t.Fatalf("command snapshot = %#v, want structured deduped commands", commandSnapshot)
	}
	adapter.applyACPUpdate(session.AgentSessionID, json.RawMessage(`{
		"update": {
			"sessionUpdate": "available_commands_update",
			"commands": [
				{"name": "   "},
				42
			]
		}
	}`))
	commandSnapshot, ok = adapter.SessionCommandSnapshot(session)
	if !ok || len(commandSnapshot.Commands) != 2 || commandSnapshot.Commands[0].Name != "read_file" {
		t.Fatalf("command snapshot after malformed entries = %#v ok=%v, want previous snapshot", commandSnapshot, ok)
	}
	config, _ := snapshot.RuntimeContext["config"].(map[string]any)
	if config == nil || asString(config["approval_policy"]) != "on-request" {
		t.Fatalf("runtime context config = %#v, want approval_policy", snapshot.RuntimeContext["config"])
	}
	providerConfig, _ := snapshot.RuntimeContext["providerConfig"].(map[string]any)
	if got := asString(providerConfig["baseUrl"]); got != "https://openai.proxy.test/v1" {
		t.Fatalf("runtime context providerConfig baseUrl = %q, want Codex base URL", got)
	}
	if snapshot.Settings == nil {
		t.Fatal("snapshot settings = nil, want live ACP model settings")
	}
	if snapshot.Settings.Model != "gpt-5.4" {
		t.Fatalf("snapshot settings model = %q, want gpt-5.4", snapshot.Settings.Model)
	}
	if snapshot.Settings.ReasoningEffort != "xhigh" {
		t.Fatalf("snapshot settings reasoning = %q, want xhigh", snapshot.Settings.ReasoningEffort)
	}
	usage, _ := snapshot.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if got, ok := acpInt64Value(contextWindow["usedTokens"]); !ok || got != 97100 {
		t.Fatalf("runtime context usage usedTokens = %#v, want 97100", contextWindow["usedTokens"])
	}
	if got, ok := acpInt64Value(contextWindow["totalTokens"]); !ok || got != 258000 {
		t.Fatalf("runtime context usage totalTokens = %#v, want 258000", contextWindow["totalTokens"])
	}
	adapter.applyACPUpdate(session.AgentSessionID, json.RawMessage(`{
		"update": {
			"sessionUpdate": "available_commands_update",
			"commands": []
		}
	}`))
	commandSnapshot, ok = adapter.SessionCommandSnapshot(session)
	if !ok || len(commandSnapshot.Commands) != 0 {
		t.Fatalf("cleared command snapshot = %#v ok=%v, want empty known snapshot", commandSnapshot, ok)
	}
}

func TestCodexACPConfigOptionUpdateSignalsSessionStateReload(t *testing.T) {
	t.Parallel()

	session := testSession()
	session.ProviderSessionID = "codex-session-1"

	events := acpUpdateEvents(session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "config_option_update",
			"key": "model",
			"value": "gpt-5.4"
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

func TestCodexACPSystemNoticeMessageFromStderrDetectsStreamError(t *testing.T) {
	t.Parallel()

	message, ok := codexACPSystemNoticeMessageFromStderr([]byte(
		`ERROR codex_acp::thread: Handled error during turn: ResponseStreamDisconnected Some(ResponseStreamDisconnected { http_status_code: None }) Some("failed to send websocket request: IO error: Broken pipe")`,
	))
	if !ok {
		t.Fatal("stderr notice ok = false, want true")
	}
	if message.Method != acpMethodUpdate {
		t.Fatalf("method = %q, want %q", message.Method, acpMethodUpdate)
	}
	var params struct {
		Update map[string]any `json:"update"`
	}
	if err := json.Unmarshal(message.Params, &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if got := params.Update["sessionUpdate"]; got != "stream_error" {
		t.Fatalf("sessionUpdate = %#v, want stream_error", got)
	}
	if got := params.Update["message"]; got != "ResponseStreamDisconnected" {
		t.Fatalf("message = %#v, want ResponseStreamDisconnected", got)
	}
	if got := params.Update["noticeKind"]; got != "transport_retry" {
		t.Fatalf("noticeKind = %#v, want transport_retry", got)
	}
	if got := params.Update["retryable"]; got != true {
		t.Fatalf("retryable = %#v, want true", got)
	}
}

func TestCodexACPSystemNoticeMessageFromStderrDetectsReconnectAttempt(t *testing.T) {
	t.Parallel()

	message, ok := codexACPSystemNoticeMessageFromStderr([]byte(
		`2026-05-29T09:05:51.179821Z ERROR codex_acp::thread: Handled error during turn: Reconnecting... 1/5 Some(ResponseStreamDisconnected { http_status_code: Some(401) }) Some("unexpected status 401 Unauthorized: Missing Authentication header, url: https://openrouter.ai/api/v1/responses")`,
	))
	if !ok {
		t.Fatal("stderr notice ok = false, want true")
	}
	var params struct {
		Update map[string]any `json:"update"`
	}
	if err := json.Unmarshal(message.Params, &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if got := params.Update["kind"]; got != "agent_system_notice" {
		t.Fatalf("kind = %#v, want agent_system_notice", got)
	}
	if got := params.Update["noticeKind"]; got != "transport_retry" {
		t.Fatalf("noticeKind = %#v, want transport_retry", got)
	}
	if got := params.Update["source"]; got != "acp_stderr" {
		t.Fatalf("source = %#v, want acp_stderr", got)
	}
}

func TestCodexACPSystemNoticeMessageFromStderrIgnoresGenericLogs(t *testing.T) {
	t.Parallel()

	if _, ok := codexACPSystemNoticeMessageFromStderr([]byte("WARN unrelated")); ok {
		t.Fatal("stderr notice ok = true, want false")
	}
}

func TestCodexACPSystemNoticeChunkProjectsAssistantNotice(t *testing.T) {
	t.Parallel()

	session := testSession()
	events := acpUpdateEvents(session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "agent_message_chunk",
			"content": {
				"type": "text",
				"text": "Codex connection interrupted. Reconnecting..."
			},
			"_meta": {
				"tsh": {
					"kind": "agent_system_notice",
					"noticeKind": "transport_retry",
					"severity": "warning",
					"title": "Codex connection interrupted. Reconnecting...",
					"detail": "ResponseStreamDisconnected: IO error: Broken pipe",
					"retryable": true
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
	if got := event.Payload.Metadata["noticeKind"]; got != "transport_retry" {
		t.Fatalf("noticeKind = %#v, want transport_retry", got)
	}
	if got := event.Payload.Metadata["detail"]; got != "ResponseStreamDisconnected: IO error: Broken pipe" {
		t.Fatalf("detail = %#v, want broken pipe detail", got)
	}
	if got := event.Payload.Metadata["retryable"]; got != true {
		t.Fatalf("retryable = %#v, want true", got)
	}
}

func TestCodexACPStreamErrorUpdateProjectsAssistantNotice(t *testing.T) {
	t.Parallel()

	session := testSession()
	events := acpUpdateEvents(session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "stream_error",
			"message": "ResponseStreamDisconnected",
			"additionalDetails": "websocket IO error: Broken pipe"
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
	if got := events[0].Payload.Metadata["additionalDetails"]; got != "websocket IO error: Broken pipe" {
		t.Fatalf("additionalDetails = %#v, want websocket detail", got)
	}
	if got := events[0].Payload.Metadata["detail"]; got != "websocket IO error: Broken pipe" {
		t.Fatalf("detail = %#v, want websocket detail", got)
	}
}

func TestCodexACPSystemNoticeDoesNotSplitAssistantStream(t *testing.T) {
	t.Parallel()

	session := testSession()
	normalizer := newACPTurnNormalizer()
	first := acpUpdateEvents(session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "agent_message_chunk",
			"content": {
				"type": "text",
				"text": "Working "
			}
		}
	}`), normalizer)
	notice := acpUpdateEvents(session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "stream_error",
			"message": "ResponseStreamDisconnected",
			"additionalDetails": "websocket IO error: Broken pipe"
		}
	}`), normalizer)
	second := acpUpdateEvents(session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "agent_message_chunk",
			"content": {
				"type": "text",
				"text": "again."
			}
		}
	}`), normalizer)
	finished := normalizer.Finish(session, "turn-1", messageStreamStateCompleted)

	if len(first) != 1 || len(notice) != 1 || len(second) != 1 || len(finished) != 1 {
		t.Fatalf("event counts = first:%d notice:%d second:%d finished:%d, want 1 each", len(first), len(notice), len(second), len(finished))
	}
	assistantID := first[0].EventID
	if assistantID == "" {
		t.Fatal("assistant event id is empty")
	}
	if notice[0].EventID == assistantID {
		t.Fatalf("notice event id = assistant id %q, want distinct side-band event", assistantID)
	}
	if got := notice[0].Payload.Metadata["kind"]; got != "agent_system_notice" {
		t.Fatalf("notice kind = %#v, want agent_system_notice", got)
	}
	for label, event := range map[string]activityshared.Event{
		"second":   second[0],
		"finished": finished[0],
	} {
		if event.EventID != assistantID {
			t.Fatalf("%s assistant event id = %q, want original stream id %q", label, event.EventID, assistantID)
		}
	}
	if got := second[0].Payload.Content; got != "Working again." {
		t.Fatalf("second content = %q, want accumulated assistant stream", got)
	}
	if got := finished[0].Payload.Metadata["streamState"]; got != messageStreamStateCompleted {
		t.Fatalf("finished stream state = %#v, want completed", got)
	}
}

func TestCodexACPReconnectThoughtChunkProjectsAssistantNotice(t *testing.T) {
	t.Parallel()

	session := testSession()
	events := acpUpdateEvents(session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "agent_thought_chunk",
			"content": {
				"type": "text",
				"text": "Handled error during turn: Reconnecting... 2/5 Some(ResponseStreamDisconnected { http_status_code: None }) Some(\"websocket IO error: Broken pipe\")"
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
	if got := events[0].Payload.Metadata["retryable"]; got != true {
		t.Fatalf("retryable = %#v, want true", got)
	}
	if got := events[0].Payload.Content; got != "Codex connection interrupted. Reconnecting..." {
		t.Fatalf("content = %q, want reconnect title", got)
	}
}

func TestCodexACPTransportFallbackTextProjectsAssistantNotice(t *testing.T) {
	t.Parallel()

	session := testSession()
	events := acpUpdateEvents(session, "turn-1", json.RawMessage(`{
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
	if got := events[0].Payload.Content; got != "Codex switched to HTTPS transport." {
		t.Fatalf("content = %q, want HTTPS fallback title", got)
	}
}

func testSession() Session {
	return Session{
		RoomID:            "room-1",
		AgentSessionID:    "agent-session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "agent-session-1",
		CWD:               "/workspace/room-1",
		Status:            SessionStatusReady,
	}
}

type scriptedACPTransport struct {
	mu    sync.Mutex
	specs []ProcessSpec
	conn  *scriptedACPConnection
}

func newScriptedACPTransport() *scriptedACPTransport {
	return &scriptedACPTransport{conn: &scriptedACPConnection{
		recv:                   make(chan ProcessFrame, 32),
		supportsSessionRestore: true,
		respondSetMode:         true,
	}}
}

func (t *scriptedACPTransport) Start(_ context.Context, spec ProcessSpec) (ProcessConnection, error) {
	t.mu.Lock()
	t.specs = append(t.specs, spec)
	t.mu.Unlock()
	return t.conn, nil
}

func acpRequestParamCWD(t *testing.T, conn *scriptedACPConnection, method string) string {
	t.Helper()
	return asString(acpRequestParams(t, conn, method)["cwd"])
}

func acpRequestParams(t *testing.T, conn *scriptedACPConnection, method string) map[string]any {
	t.Helper()

	requests := acpRequestParamsList(t, conn, method)
	if len(requests) == 0 {
		t.Fatalf("missing ACP request method %q", method)
	}
	return requests[0]
}

func lastACPRequestParams(t *testing.T, conn *scriptedACPConnection, method string) map[string]any {
	t.Helper()

	requests := acpRequestParamsList(t, conn, method)
	if len(requests) == 0 {
		t.Fatalf("missing ACP request method %q", method)
	}
	return requests[len(requests)-1]
}

func acpRequestParamsList(t *testing.T, conn *scriptedACPConnection, method string) []map[string]any {
	t.Helper()

	conn.mu.Lock()
	sent := append([][]byte(nil), conn.sent...)
	conn.mu.Unlock()

	var matches []map[string]any
	for _, data := range sent {
		for _, line := range acpScanLines(data) {
			var request struct {
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if err := json.Unmarshal([]byte(line), &request); err != nil {
				t.Fatalf("unmarshal ACP request: %v", err)
			}
			if request.Method == method {
				matches = append(matches, request.Params)
			}
		}
	}
	return matches
}

type scriptedACPConnection struct {
	mu                         sync.Mutex
	sent                       [][]byte
	setConfigOptionSnapshots   []map[string]any
	configOptions              []map[string]any
	recv                       chan ProcessFrame
	supportsSessionRestore     bool
	respondSetMode             bool
	authRequiredOnNewSession   bool
	commandUpdateOnNewSession  bool
	commandUpdateOnLoadSession bool
	loadSessionError           *acpError
	promptPermission           bool
	promptKind                 string
	pauseBeforePromptResult    chan struct{}
	promptFinalContent         string
	pendingPermissionPromptID  json.RawMessage
	selectedPermissionOption   string
	selectedInteractiveResult  map[string]any
	appServerTurnStatus        string
}

func (c *scriptedACPConnection) Send(data []byte) error {
	c.mu.Lock()
	c.sent = append(c.sent, append([]byte(nil), data...))
	c.mu.Unlock()

	for _, line := range acpScanLines(data) {
		var message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Result json.RawMessage `json:"result"`
		}
		_ = json.Unmarshal([]byte(line), &message)
		if c.handleAppServerMessage(line, message.ID, message.Method) {
			continue
		}
		switch message.Method {
		case acpMethodInitialize:
			result := map[string]any{
				"protocolVersion": acpProtocolVersion,
				"agentInfo": map[string]any{
					"name":  "codex-acp",
					"title": "Codex",
				},
			}
			if c.supportsSessionRestore {
				result["agentCapabilities"] = map[string]any{
					"loadSession": true,
				}
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  result,
			})
		case acpMethodNewSession:
			if c.authRequiredOnNewSession {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"error": map[string]any{
						"code":    -32001,
						"message": "auth required",
						"data": map[string]any{
							"authRequired": true,
						},
					},
				})
				return nil
			}
			if c.commandUpdateOnNewSession {
				c.sendAvailableCommandsUpdate()
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result": map[string]any{
					"sessionId":     "codex-acp-session-1",
					"configOptions": c.defaultConfigOptions(),
				},
			})
		case acpMethodLoadSession, acpMethodResume:
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
			if c.respondSetMode {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"result":  map[string]any{},
				})
			}
		case acpMethodSetConfigOption:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			c.setConfigOptionSnapshots = append(c.setConfigOptionSnapshots, clonePayload(request.Params))
			c.mu.Unlock()
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  map[string]any{},
			})
		case acpMethodPrompt:
			if c.promptPermission || c.promptKind != "" {
				c.mu.Lock()
				c.pendingPermissionPromptID = append(json.RawMessage(nil), message.ID...)
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
			if c.pauseBeforePromptResult != nil {
				<-c.pauseBeforePromptResult
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  acpMethodUpdate,
				"params": map[string]any{
					"sessionId": "codex-acp-session-1",
					"update": map[string]any{
						"sessionUpdate": "tool_call",
						"toolCallId":    "tool-1",
						"title":         "Reading files",
						"kind":          "read",
						"status":        "in_progress",
					},
				},
			})
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  acpMethodUpdate,
				"params": map[string]any{
					"sessionId": "codex-acp-session-1",
					"update": map[string]any{
						"sessionUpdate": "session_info_update",
						"title":         "Inspect repository structure",
					},
				},
			})
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  acpMethodUpdate,
				"params": map[string]any{
					"sessionId": "codex-acp-session-1",
					"update": map[string]any{
						"sessionUpdate": "agent_thought_chunk",
						"content": map[string]any{
							"type": "text",
							"text": "Need ",
						},
					},
				},
			})
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  acpMethodUpdate,
				"params": map[string]any{
					"sessionId": "codex-acp-session-1",
					"update": map[string]any{
						"sessionUpdate": "agent_thought_chunk",
						"content": map[string]any{
							"type": "text",
							"text": "context.",
						},
					},
				},
			})
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  acpMethodUpdate,
				"params": map[string]any{
					"sessionId": "codex-acp-session-1",
					"update": map[string]any{
						"sessionUpdate": "agent_message_chunk",
						"content": map[string]any{
							"type": "text",
							"text": "I'll ",
						},
					},
				},
			})
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  acpMethodUpdate,
				"params": map[string]any{
					"sessionId": "codex-acp-session-1",
					"update": map[string]any{
						"sessionUpdate": "agent_message_chunk",
						"content": map[string]any{
							"type": "text",
							"text": "check ",
						},
					},
				},
			})
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  acpMethodUpdate,
				"params": map[string]any{
					"sessionId": "codex-acp-session-1",
					"update": map[string]any{
						"sessionUpdate": "agent_message_chunk",
						"content": map[string]any{
							"type": "text",
							"text": "the repo.",
						},
					},
				},
			})
			result := map[string]any{
				"stopReason": "end_turn",
			}
			if strings.TrimSpace(c.promptFinalContent) != "" {
				result["content"] = []map[string]any{{
					"type": "text",
					"text": c.promptFinalContent,
				}}
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  result,
			})
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
					"payload":  response.Result.Outcome.Payload,
				}
				promptID := append(json.RawMessage(nil), c.pendingPermissionPromptID...)
				c.mu.Unlock()
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      promptID,
					"result": map[string]any{
						"stopReason": "end_turn",
					},
				})
			}
		}
	}
	return nil
}

// handleAppServerMessage lets the shared scripted connection answer the codex
// app-server protocol next to ACP, so controller tests can exercise the
// app-server-backed codex adapter with the same fake. Returns true when the
// message was consumed.
func (c *scriptedACPConnection) handleAppServerMessage(line string, id json.RawMessage, method string) bool {
	switch method {
	case appServerMethodInitialized:
		return true
	case appServerMethodAccountRead:
		requiresAuth := c.authRequiredOnNewSession
		result := map[string]any{
			"requiresOpenaiAuth": requiresAuth,
		}
		if !requiresAuth {
			result["account"] = map[string]any{"type": "chatgpt", "planType": "pro"}
		}
		c.sendJSON(map[string]any{"id": id, "result": result})
		return true
	case appServerMethodModelList:
		c.sendJSON(map[string]any{"id": id, "result": map[string]any{"data": []any{}}})
		return true
	case appServerMethodRateLimitsRead:
		c.sendJSON(map[string]any{"id": id, "result": map[string]any{"rateLimits": map[string]any{}}})
		return true
	case appServerMethodThreadStart:
		c.sendJSON(map[string]any{
			"id": id,
			"result": map[string]any{
				"thread": map[string]any{"id": "codex-thread-1"},
			},
		})
		return true
	case appServerMethodThreadResume:
		var request struct {
			Params map[string]any `json:"params"`
		}
		_ = json.Unmarshal([]byte(line), &request)
		c.sendJSON(map[string]any{
			"id": id,
			"result": map[string]any{
				"thread": map[string]any{"id": asString(request.Params["threadId"])},
			},
		})
		return true
	case appServerMethodTurnStart:
		c.mu.Lock()
		c.appServerTurnStatus = "completed"
		c.mu.Unlock()
		// Mirror the real app-server: respond immediately with the
		// inProgress turn; output streams as notifications afterwards.
		c.sendJSON(map[string]any{
			"id": id,
			"result": map[string]any{
				"turn": map[string]any{"id": "turn-1", "status": "inProgress", "items": []any{}},
			},
		})
		c.sendJSON(map[string]any{
			"method": appServerNotifyTurnStarted,
			"params": map[string]any{
				"threadId": "codex-thread-1",
				"turn":     map[string]any{"id": "turn-1", "status": "inProgress", "items": []any{}},
			},
		})
		if c.promptPermission || c.promptKind != "" {
			c.sendJSON(map[string]any{
				"id":     "permission-1",
				"method": appServerMethodCommandApproval,
				"params": map[string]any{
					"threadId":    "codex-thread-1",
					"turnId":      "turn-1",
					"itemId":      "item-cmd",
					"command":     "make test",
					"cwd":         "/workspace",
					"startedAtMs": 1750000000000,
				},
			})
			return true
		}
		if c.pauseBeforePromptResult != nil {
			<-c.pauseBeforePromptResult
		}
		for _, delta := range []string{"Need ", "context."} {
			c.sendJSON(map[string]any{
				"method": appServerNotifyReasoningDelta,
				"params": map[string]any{
					"threadId": "codex-thread-1", "turnId": "turn-1",
					"itemId": "item-think", "contentIndex": 0, "delta": delta,
				},
			})
		}
		for _, delta := range []string{"I'll ", "check ", "the repo."} {
			c.sendJSON(map[string]any{
				"method": appServerNotifyAgentMessageDelta,
				"params": map[string]any{
					"threadId": "codex-thread-1", "turnId": "turn-1",
					"itemId": "item-msg", "delta": delta,
				},
			})
		}
		c.sendJSON(map[string]any{
			"method": appServerNotifyItemStarted,
			"params": map[string]any{
				"threadId": "codex-thread-1", "turnId": "turn-1", "startedAtMs": 1750000000000,
				"item": map[string]any{
					"type": "commandExecution", "id": "item-cmd",
					"command": "ls -la", "cwd": "/workspace", "status": "inProgress",
				},
			},
		})
		c.sendJSON(map[string]any{
			"method": appServerNotifyThreadNameUpdated,
			"params": map[string]any{
				"threadId":   "codex-thread-1",
				"threadName": "Inspect repository structure",
			},
		})
		c.completeAppServerTurn()
		return true
	case appServerMethodTurnInterrupt:
		c.mu.Lock()
		c.appServerTurnStatus = "interrupted"
		c.mu.Unlock()
		c.sendJSON(map[string]any{"id": id, "result": map[string]any{}})
		c.completeAppServerTurn()
		return true
	case appServerMethodTurnSteer:
		c.sendJSON(map[string]any{"id": id, "result": map[string]any{"turnId": "turn-1"}})
		return true
	case appServerMethodThreadCompact:
		c.sendJSON(map[string]any{"id": id, "result": map[string]any{}})
		return true
	case appServerMethodThreadRollback:
		c.sendJSON(map[string]any{
			"id":     id,
			"result": map[string]any{"thread": map[string]any{"id": "codex-thread-1"}},
		})
		return true
	case appServerMethodReviewStart:
		c.sendJSON(map[string]any{
			"id": id,
			"result": map[string]any{
				"reviewThreadId": "codex-thread-1",
				"turn": map[string]any{
					"id": "turn-review", "status": "completed",
					"items": []any{map[string]any{"type": "agentMessage", "id": "item-review", "text": "Review finished."}},
				},
			},
		})
		return true
	case "":
		if acpRequestID(id) != "permission-1" {
			return false
		}
		var response struct {
			Result struct {
				Decision string `json:"decision"`
			} `json:"result"`
			Error json.RawMessage `json:"error"`
		}
		_ = json.Unmarshal([]byte(line), &response)
		if response.Result.Decision == "" {
			if len(response.Error) > 0 {
				// App-server approval rejected (for example on cancel); the
				// turn finishes through turn/interrupt instead.
				return true
			}
			return false
		}
		optionID := map[string]string{
			"accept":           "allow_once",
			"acceptForSession": "allow_always",
			"decline":          "reject_once",
			"cancel":           "reject_always",
		}[response.Result.Decision]
		c.mu.Lock()
		c.selectedPermissionOption = optionID
		c.mu.Unlock()
		c.completeAppServerTurn()
		return true
	default:
		return false
	}
}

// completeAppServerTurn finishes the in-flight app-server turn the way the
// real server does: with a turn/completed notification (the turn/start RPC
// already responded immediately).
func (c *scriptedACPConnection) completeAppServerTurn() {
	c.mu.Lock()
	status := firstNonEmpty(c.appServerTurnStatus, "completed")
	finalContent := firstNonEmpty(strings.TrimSpace(c.promptFinalContent), "I'll check the repo.")
	c.mu.Unlock()
	c.sendJSON(map[string]any{
		"method": appServerNotifyItemCompleted,
		"params": map[string]any{
			"threadId": "codex-thread-1", "turnId": "turn-1", "completedAtMs": 1750000001000,
			"item": map[string]any{
				"type": "commandExecution", "id": "item-cmd",
				"command": "ls -la", "cwd": "/workspace", "status": "completed",
				"aggregatedOutput": "README.md\n", "exitCode": 0,
			},
		},
	})
	c.sendJSON(map[string]any{
		"method": appServerNotifyTurnCompleted,
		"params": map[string]any{
			"threadId": "codex-thread-1",
			"turn": map[string]any{
				"id":     "turn-1",
				"status": status,
				"items": []any{
					map[string]any{"type": "agentMessage", "id": "item-msg", "text": finalContent},
				},
			},
		},
	})
}

func (c *scriptedACPConnection) Recv() (ProcessFrame, error) {
	frame, ok := <-c.recv
	if !ok {
		return ProcessFrame{}, io.EOF
	}
	return frame, nil
}

func (c *scriptedACPConnection) Close() error {
	close(c.recv)
	return nil
}

func (c *scriptedACPConnection) sendAvailableCommandsUpdate() {
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": "codex-acp-session-1",
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

func (c *scriptedACPConnection) sendConfigOptionsUpdate(key string, value string) {
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": "codex-acp-session-1",
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

func (c *scriptedACPConnection) sendJSON(value any) {
	raw, _ := json.Marshal(value)
	raw = append(raw, '\n')
	c.recv <- ProcessFrame{Stdout: raw}
}

func (c *scriptedACPConnection) permissionOptionID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.selectedPermissionOption
}

func (c *scriptedACPConnection) interactiveOutcome() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return clonePayload(c.selectedInteractiveResult)
}

func (c *scriptedACPConnection) setConfigOptionCalls() []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.setConfigOptionSnapshots) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(c.setConfigOptionSnapshots))
	for _, snapshot := range c.setConfigOptionSnapshots {
		out = append(out, clonePayload(snapshot))
	}
	return out
}

func (c *scriptedACPConnection) defaultConfigOptions() []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return cloneConfigOptionDescriptors(c.configOptions)
}

func (c *scriptedACPConnection) promptRequest() (map[string]any, []map[string]any) {
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
				"title":      "Run command",
			}, []map[string]any{{
				"optionId": "allow_once",
				"label":    "Allow once",
				"kind":     "allow_once",
			}, {
				"optionId": "reject",
				"label":    "No, continue without running",
				"kind":     "reject_once",
			}, {
				"optionId": "abort",
				"label":    "No, and tell Codex what to do differently",
				"kind":     "reject_once",
			}}
	}
}

func hasActivityMessage(events []activityshared.Event, role activityshared.MessageRole, content string) bool {
	for _, event := range events {
		if event.Type != activityshared.EventMessageAppended && event.Type != activityshared.EventMessageCreated {
			continue
		}
		if role != "" && event.Payload.Role != role {
			continue
		}
		if strings.TrimSpace(event.Payload.Content) == content {
			return true
		}
	}
	return false
}

func activityMessagesWithRole(events []activityshared.Event, role activityshared.MessageRole) []activityshared.Event {
	var out []activityshared.Event
	for _, event := range events {
		if (event.Type == activityshared.EventMessageAppended || event.Type == activityshared.EventMessageCreated) && (role == "" || event.Payload.Role == role) {
			out = append(out, event)
		}
	}
	return out
}

func activityEventsWithType(events []activityshared.Event, eventType activityshared.EventType) []activityshared.Event {
	var out []activityshared.Event
	for _, event := range events {
		if event.Type == eventType {
			out = append(out, event)
		}
	}
	return out
}

func hasStreamCallEvent(events []StreamEvent, callType string, status string) bool {
	for _, event := range events {
		if event.EventType != StreamEventMessageUpdate {
			continue
		}
		update, ok := event.Data.(agentsessionstore.WorkspaceAgentMessageUpdate)
		if !ok {
			continue
		}
		if update.Kind != "tool_call" {
			continue
		}
		if callType != "" && asString(update.Payload["callType"]) != callType {
			continue
		}
		if status != "" && update.Status != status && asString(update.Payload["status"]) != status {
			continue
		}
		return true
	}
	return false
}

func hasStreamMessageEvent(events []StreamEvent, role string, content string) bool {
	for _, event := range events {
		if event.EventType != StreamEventMessageUpdate {
			continue
		}
		update, ok := event.Data.(agentsessionstore.WorkspaceAgentMessageUpdate)
		if !ok {
			continue
		}
		if role != "" && update.Role != role {
			continue
		}
		if content != "" && asString(update.Payload["content"]) != content {
			continue
		}
		return true
	}
	return false
}

func reportsWithTimelineItem(reports []agentsessionstore.ReportActivityInput, itemType string) []agentsessionstore.ReportActivityInput {
	var out []agentsessionstore.ReportActivityInput
	for _, report := range reports {
		for _, update := range report.MessageUpdates {
			if messageUpdateMatchesLegacyItemType(update, itemType) {
				out = append(out, report)
				break
			}
		}
	}
	return out
}

func approvalMessageUpdates(events []StreamEvent) []agentsessionstore.WorkspaceAgentMessageUpdate {
	var out []agentsessionstore.WorkspaceAgentMessageUpdate
	for _, event := range events {
		if event.EventType != StreamEventMessageUpdate {
			continue
		}
		update, ok := event.Data.(agentsessionstore.WorkspaceAgentMessageUpdate)
		if !ok || asString(update.Payload["callType"]) != "approval" {
			continue
		}
		out = append(out, update)
	}
	return out
}

func waitForCondition(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition was not met")
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func containsCommandSequence(values []string, sequence []string) bool {
	if len(sequence) == 0 {
		return true
	}
	for index := 0; index+len(sequence) <= len(values); index++ {
		match := true
		for offset := range sequence {
			if values[index+offset] != sequence[offset] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
