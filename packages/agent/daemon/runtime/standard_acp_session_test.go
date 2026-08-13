package agentruntime

import (
	"context"
	"reflect"
	"strings"
	"sync"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestStandardACPAdapterProviderLaunchPrepareMutatesSpecAndCleansUpOnClose(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-1")
	adapter := newHermesExtensionTestAdapter(transport)
	cleanupCalls := 0
	adapter.SetProviderLaunchPreparer(func(_ context.Context, input ProviderLaunchPrepareInput) (ProviderLaunchPrepareResult, error) {
		if input.Provider != hermesExtensionTestProvider {
			t.Fatalf("Provider = %q, want %q", input.Provider, hermesExtensionTestProvider)
		}
		if input.DirectStart {
			t.Fatal("DirectStart = true, want false for Hermes")
		}
		return ProviderLaunchPrepareResult{
			Command: []string{"prepared-hermes", "acp"},
			Env:     append(append([]string(nil), input.Env...), "HOOK_ENV=1"),
			CWD:     "/prepared/hermes",
			Cleanup: func(context.Context) error {
				cleanupCalls++
				return nil
			},
		}, nil
	})
	session := standardTestSession(hermesExtensionTestProvider)
	session.Env = []string{"SESSION_ENV=1"}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if cleanupCalls != 0 {
		t.Fatalf("cleanup calls before close = %d, want 0", cleanupCalls)
	}
	transport.mu.Lock()
	specs := append([]ProcessSpec(nil), transport.specs...)
	transport.mu.Unlock()
	if len(specs) != 1 {
		t.Fatalf("transport starts = %d, want 1", len(specs))
	}
	spec := specs[0]
	if !reflect.DeepEqual(spec.Command, []string{"prepared-hermes", "acp"}) {
		t.Fatalf("Command = %#v", spec.Command)
	}
	if spec.CWD != "/prepared/hermes" {
		t.Fatalf("CWD = %q", spec.CWD)
	}
	if !reflect.DeepEqual(spec.Env[len(spec.Env)-2:], []string{"SESSION_ENV=1", "HOOK_ENV=1"}) {
		t.Fatalf("Env tail = %#v", spec.Env)
	}

	if err := adapter.Close(context.Background(), session); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if cleanupCalls != 1 {
		t.Fatalf("cleanup calls after close = %d, want 1", cleanupCalls)
	}
}

func TestStandardACPAdapterConcurrentStartsLeaveSingleLiveProcess(t *testing.T) {
	t.Parallel()

	transport := &multiProcStandardACPTransport{
		agentTitle: "Hermes Agent",
		sessionID:  "hermes-session-1",
	}
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)

	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = adapter.Start(context.Background(), session)
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("Start[%d]: %v", i, err)
		}
	}
	spawned, live := transport.snapshot()
	if spawned != 2 {
		t.Fatalf("spawned processes = %d, want 2", spawned)
	}
	if len(live) != 1 {
		t.Fatalf("live ACP processes = %d, want exactly 1", len(live))
	}
	if !adapter.HasLiveSession(session) {
		t.Fatal("HasLiveSession = false, want true after concurrent starts")
	}
}

func TestStandardACPAdapterHasLiveSessionRejectsClosedClient(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-1")
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	acpSession := adapter.getSession(session.AgentSessionID)
	if acpSession == nil || acpSession.client == nil {
		t.Fatal("started session has no client")
	}
	if err := transport.conn.Close(); err != nil {
		t.Fatal(err)
	}
	waitForCondition(t, func() bool {
		select {
		case <-acpSession.client.Done():
			return true
		default:
			return false
		}
	})
	if adapter.HasLiveSession(session) {
		t.Fatal("HasLiveSession = true after ACP client terminated")
	}
}

func TestStandardACPAdapterCarriesExecutableIdentityToProcessStart(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Example Agent", "example-session-1")
	identity := &ExecutableIdentity{SHA256: strings.Repeat("a", 64), SizeBytes: 42}
	adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider: "acp:example", Name: "example-acp", DisplayName: "Example Agent",
		Command: []string{"example", "--acp"}, ExecutableIdentity: identity,
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatal(err)
	}
	identity.SHA256 = strings.Repeat("b", 64)
	if _, err := adapterRaw.Start(context.Background(), standardTestSession("acp:example")); err != nil {
		t.Fatal(err)
	}
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if len(transport.specs) != 1 || transport.specs[0].ExecutableIdentity == nil ||
		transport.specs[0].ExecutableIdentity.SHA256 != strings.Repeat("a", 64) ||
		transport.specs[0].ExecutableIdentity.SizeBytes != 42 {
		t.Fatalf("process executable identity = %#v", transport.specs)
	}
}

func TestStandardACPAdapterIntersectsOpenProviderDeclaredCapabilitiesWithRuntimeFacts(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Example Agent", "example-session-1")
	transport.conn.commandUpdateOnNewSession = true
	transport.conn.availableCommands = []AgentSessionCommand{{Name: "compact"}}
	transport.conn.configOptions = []map[string]any{{
		"id":           "mode",
		"currentValue": "default",
		"options": []any{
			map[string]any{"name": "Default", "value": "default"},
			map[string]any{"name": "Plan", "value": "plan"},
		},
	}}
	adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:     "acp:example",
		Name:         "example-acp",
		DisplayName:  "Example Agent",
		Command:      []string{"example", "--acp"},
		Capabilities: []string{CapabilityCompact, CapabilityPlanMode, CapabilityCompact, "unknownCapability"},
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	adapter := adapterRaw.(*standardACPAdapter)
	session := standardTestSession("acp:example")
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	state := adapter.SessionState(session)
	capabilities := capabilitySnapshotValues(state.Capabilities)
	if !containsString(capabilities, CapabilityCompact) || !containsString(capabilities, CapabilityPlanMode) {
		t.Fatalf("capabilities = %#v, want negotiated compact+planMode", capabilities)
	}
	if len(capabilities) != 2 {
		t.Fatalf("capabilities = %#v, want known deduplicated effective capabilities", capabilities)
	}
}

func TestCursorAdapterStartCreatesStandardACPSession(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-1")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	session.PermissionModeID = "agent"

	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	spec := transport.specs[0]
	if got := strings.Join(spec.Command, " "); got != "cursor-agent acp" {
		t.Fatalf("command = %q, want %q", got, "cursor-agent acp")
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("events = %#v, want session.started", events)
	}
	if events[0].ProviderSessionID != "cursor-session-1" {
		t.Fatalf("provider session id = %q", events[0].ProviderSessionID)
	}
	if transport.conn.lastModeID() != "agent" {
		t.Fatalf("mode id = %q, want agent", transport.conn.lastModeID())
	}
	if got := transport.conn.authenticatedMethodID(); got != "" {
		t.Fatalf("authenticated method id = %q, want empty", got)
	}
}

func TestHermesAdapterStartPreservesCommandsAdvertisedDuringNewSession(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-commands")
	transport.conn.commandUpdateOnNewSession = true
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)

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
	state := adapter.SessionState(session)
	commands, ok := state.RuntimeContext["availableCommands"].([]map[string]any)
	if !ok || len(commands) != 1 || commands[0]["name"] != "web" || commands[0]["description"] != "Search the web" || commands[0]["inputHint"] != "query" {
		t.Fatalf("runtime availableCommands = %#v", state.RuntimeContext["availableCommands"])
	}
}

func TestStandardACPAdapterResumePreservesCommandsAdvertisedDuringLoadSession(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenClaw", "openclaw-session-resume-commands")
	transport.conn.commandUpdateOnLoadSession = true
	adapter := NewOpenClawAdapter(transport)
	session := standardTestSession(ProviderOpenClaw)
	session.ProviderSessionID = "persisted-openclaw-session-id"
	transport.conn.sessionID = session.ProviderSessionID

	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}

	snapshot, ok := adapter.SessionCommandSnapshot(session)
	if !ok || len(snapshot.Commands) != 1 || snapshot.Commands[0].Name != "web" {
		t.Fatalf("command snapshot = %#v ok=%v, want command update preserved from resume", snapshot, ok)
	}
}

func TestStandardACPAdapterCloseSendsProtocolSessionCloseBeforeTransportClose(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-close")
	transport.conn.supportsCloseSession = true
	transport.conn.closeSessionExits = true
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := adapter.Close(context.Background(), session); err != nil {
		t.Fatalf("Close: %v", err)
	}

	params := transport.conn.closeSessionParams()
	if got := asString(params["sessionId"]); got != "hermes-session-close" {
		t.Fatalf("session/close sessionId = %q, want provider session id", got)
	}
	if !transport.conn.closed() {
		t.Fatal("transport was not closed after protocol session close")
	}
}

func TestStandardACPAdapterReleaseLiveSessionClosesOnlyTransport(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-release")
	transport.conn.supportsCloseSession = true
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := adapter.ReleaseLiveSession(context.Background(), session); err != nil {
		t.Fatalf("ReleaseLiveSession: %v", err)
	}
	if params := transport.conn.closeSessionParams(); len(params) != 0 {
		t.Fatalf("ReleaseLiveSession sent destructive session/close params %#v", params)
	}
	if !transport.conn.closed() {
		t.Fatal("ReleaseLiveSession did not close ACP transport")
	}
	if adapter.HasLiveSession(session) {
		t.Fatal("HasLiveSession = true after release")
	}
}

func TestStandardACPAdapterCloseFallsBackWhenProtocolSessionCloseFails(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-close-failure")
	transport.conn.supportsCloseSession = true
	transport.conn.closeSessionError = &acpError{Code: -32601, Message: "session close unavailable"}
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := adapter.Close(context.Background(), session); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if got := asString(transport.conn.closeSessionParams()["sessionId"]); got != "hermes-session-close-failure" {
		t.Fatalf("session/close sessionId = %q, want provider session id", got)
	}
	if !transport.conn.closed() {
		t.Fatal("transport was not closed after protocol close failure")
	}
}
