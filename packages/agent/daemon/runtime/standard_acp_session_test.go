package agentruntime

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

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
	transport.conn.supportsAgentLoadSession = true
	transport.conn.supportsCloseSession = true
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !adapter.CanReleaseLiveSession(session) {
		t.Fatal("CanReleaseLiveSession = false, want load-capable Hermes session releasable")
	}
	if err := adapter.ReleaseLiveSession(context.Background(), session); err != nil {
		t.Fatalf("ReleaseLiveSession: %v", err)
	}
	if !transport.conn.closed() {
		t.Fatal("transport was not closed by live-session release")
	}
	if params := transport.conn.closeSessionParams(); params != nil {
		t.Fatalf("session/close params = %#v, want no destructive protocol close", params)
	}
	if adapter.HasLiveSession(session) {
		t.Fatal("adapter still reports a live session after release")
	}
}

func TestStandardACPAdapterDisconnectLiveSessionClosesOnlyTransport(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-disconnect")
	transport.conn.supportsCloseSession = true
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := adapter.DisconnectLiveSession(context.Background(), session); err != nil {
		t.Fatalf("DisconnectLiveSession: %v", err)
	}
	if params := transport.conn.closeSessionParams(); params != nil {
		t.Fatalf("DisconnectLiveSession sent destructive session/close params %#v", params)
	}
	if !transport.conn.closed() || adapter.HasLiveSession(session) {
		t.Fatal("DisconnectLiveSession did not drop the ACP transport")
	}
}

func TestStandardACPAdapterDisconnectLiveSessionRetriesCloseFailedHandle(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Kimi Code", "kimi-session-disconnect-retry")
	transport.conn.closeFailures = 1
	adapter := newKimiCodeExtensionTestAdapter(t, transport)
	session := standardTestSession("acp:kimi-code")
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := adapter.DisconnectLiveSession(context.Background(), session); err == nil {
		t.Fatal("first DisconnectLiveSession error=nil, want close failure")
	}
	if !adapter.hasTrackedLiveSession(session) {
		t.Fatal("close-failed ACP handle lost ownership")
	}
	if err := adapter.DisconnectLiveSession(context.Background(), session); err != nil {
		t.Fatalf("retry DisconnectLiveSession: %v", err)
	}
	if adapter.hasTrackedLiveSession(session) {
		t.Fatal("ACP handle remained after successful retry")
	}
	transport.conn.mu.Lock()
	closeCalls := transport.conn.closeCalls
	transport.conn.mu.Unlock()
	if closeCalls != 2 {
		t.Fatalf("transport close calls=%d, want 2", closeCalls)
	}
}

func TestStandardACPAdapterDisconnectLiveSessionRejectsPendingApproval(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Kimi Code", "kimi-session-disconnect-pending")
	adapter := newKimiCodeExtensionTestAdapter(t, transport)
	session := standardTestSession("acp:kimi-code")
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	pending := &pendingACPApproval{
		agentSessionID: session.AgentSessionID,
		requestID:      "approval-disconnect",
		response:       make(chan pendingInteractiveResponse, 1),
	}
	adapter.storePendingApproval(pending)
	if err := adapter.DisconnectLiveSession(context.Background(), session); err != nil {
		t.Fatalf("DisconnectLiveSession: %v", err)
	}
	if state := pending.disposition(); state != pendingInteractiveRequestStateInterrupted {
		t.Fatalf("pending approval state=%q, want interrupted", state)
	}
}

func TestStandardACPAdapterResumeContinuesLifecycleSequenceAfterRelease(t *testing.T) {
	t.Parallel()

	transport := &multiProcStandardACPTransport{
		agentTitle:               "Kimi Code",
		sessionID:                "kimi-session-lifecycle",
		supportsAgentLoadSession: true,
	}
	adapter := newKimiCodeExtensionTestAdapter(t, transport)
	session := standardTestSession("acp:kimi-code")
	session.ProviderSessionID = transport.sessionID

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	live := adapter.getSession(session.AgentSessionID)
	first := adapter.stampTurnLifecycleSnapshots(live, []activityshared.Event{
		standardACPRootProviderTurnStartedEvent(session, "turn-before-release"),
	})
	snapshot, ok := activityshared.TurnLifecycleSnapshotFromEvent(first[0])
	if !ok || snapshot.Seq == 0 {
		t.Fatalf("initial lifecycle snapshot = %#v, want non-zero sequence", snapshot)
	}
	session = applyTurnLifecycleSnapshot(session, snapshot, "turn-before-release")

	if err := adapter.ReleaseLiveSession(context.Background(), session); err != nil {
		t.Fatalf("ReleaseLiveSession: %v", err)
	}
	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	resumed := adapter.getSession(session.AgentSessionID)
	next := adapter.stampTurnLifecycleSnapshots(resumed, []activityshared.Event{
		standardACPRootProviderTurnStartedEvent(session, "turn-after-release"),
	})
	nextSnapshot, ok := activityshared.TurnLifecycleSnapshotFromEvent(next[0])
	if !ok {
		t.Fatal("resumed lifecycle event has no snapshot")
	}
	if nextSnapshot.Seq <= session.LifecycleSeq {
		t.Fatalf("resumed lifecycle sequence = %d, want > persisted %d", nextSnapshot.Seq, session.LifecycleSeq)
	}
	updated := applyTurnLifecycleSnapshot(session, nextSnapshot, "turn-after-release")
	if updated.LifecycleSeq != nextSnapshot.Seq {
		t.Fatalf("controller lifecycle sequence = %d, want accepted %d", updated.LifecycleSeq, nextSnapshot.Seq)
	}
}

func TestStandardACPAdapterReleaseLiveSessionRetainsClientAfterCloseFailure(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Kimi Code", "kimi-session-close-retry")
	transport.conn.supportsAgentLoadSession = true
	transport.conn.closeFailures = 1
	adapter := newKimiCodeExtensionTestAdapter(t, transport)
	session := standardTestSession("acp:kimi-code")

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := adapter.ReleaseLiveSession(context.Background(), session); err == nil {
		t.Fatal("first ReleaseLiveSession error = nil, want injected close failure")
	}
	if adapter.HasLiveSession(session) {
		t.Fatal("failed release exposed the client as usable after closing its input")
	}
	if !adapter.hasTrackedLiveSession(session) {
		t.Fatal("failed release lost ownership of the physical client")
	}
	cleanup := adapter.CleanupLiveSessionResources(context.Background(), 1)
	if cleanup.Attempted != 1 || cleanup.Cleaned != 1 || cleanup.Failed != 0 {
		t.Fatalf("cleanup result = %#v, want one successful retry", cleanup)
	}
	if adapter.HasLiveSession(session) {
		t.Fatal("successful release kept the live client")
	}
	transport.conn.mu.Lock()
	closeCalls := transport.conn.closeCalls
	transport.conn.mu.Unlock()
	if closeCalls != 2 {
		t.Fatalf("transport close calls = %d, want 2", closeCalls)
	}
}

func TestStandardACPAdapterResumesAfterReleaseFailureAndRetainsOldHandle(t *testing.T) {
	t.Parallel()

	transport := &multiProcStandardACPTransport{
		agentTitle:               "Kimi Code",
		sessionID:                "kimi-session-release-recovery",
		supportsAgentLoadSession: true,
	}
	adapter := newKimiCodeExtensionTestAdapter(t, transport)
	session := standardTestSession("acp:kimi-code")
	session.ProviderSessionID = transport.sessionID
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	transport.mu.Lock()
	oldConnection := transport.conns[0]
	transport.mu.Unlock()
	oldConnection.mu.Lock()
	oldConnection.closeFailures = 3
	oldConnection.mu.Unlock()

	if err := adapter.ReleaseLiveSession(context.Background(), session); err == nil {
		t.Fatal("ReleaseLiveSession error = nil, want injected close failure")
	}
	if adapter.HasLiveSession(session) {
		t.Fatal("failed release client remained usable")
	}
	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if !adapter.HasLiveSession(session) {
		t.Fatal("replacement client is not live")
	}
	if _, err := adapter.Exec(context.Background(), session, textPrompt("continue after release"), "", "turn-after-release-failure", nil, nil); err != nil {
		t.Fatalf("Exec on replacement client: %v", err)
	}
	transport.mu.Lock()
	replacementConnection := transport.conns[1]
	transport.mu.Unlock()
	replacementConnection.mu.Lock()
	promptCallsBeforeBackpressure := replacementConnection.promptCallCount
	replacementConnection.mu.Unlock()

	// Releasing the replacement does not retry the retired handle in the same
	// canonical sweep. The next replacement attempt gets one bounded cleanup
	// budget and is rejected before spawning another process when cleanup still
	// fails.
	if err := adapter.ReleaseLiveSession(context.Background(), session); err != nil {
		t.Fatalf("replacement release: %v", err)
	}
	if !adapter.hasTrackedLiveSession(session) {
		t.Fatal("retired handle was not tracked after replacement release")
	}
	spawnedBefore, _ := transport.snapshot()
	err := adapter.Resume(context.Background(), session)
	if AppErrorCode(err) != AppErrorProcessCleanupPending {
		t.Fatalf("Resume error code = %q (err=%v), want %q", AppErrorCode(err), err, AppErrorProcessCleanupPending)
	}
	spawnedAfter, _ := transport.snapshot()
	if spawnedAfter != spawnedBefore {
		t.Fatalf("spawned processes = %d after blocked resume, want %d", spawnedAfter, spawnedBefore)
	}
	replacementConnection.mu.Lock()
	promptCallsAfterBackpressure := replacementConnection.promptCallCount
	replacementConnection.mu.Unlock()
	if promptCallsAfterBackpressure != promptCallsBeforeBackpressure {
		t.Fatalf("provider prompt calls changed from %d to %d after blocked resume", promptCallsBeforeBackpressure, promptCallsAfterBackpressure)
	}
	otherSession := session
	otherSession.AgentSessionID = "agent-session-unaffected"
	otherSession.ProviderSessionID = ""
	if _, err := adapter.Start(context.Background(), otherSession); err != nil {
		t.Fatalf("Start other session while first is backpressured: %v", err)
	}
	spawnedWithOtherSession, _ := transport.snapshot()
	if spawnedWithOtherSession != spawnedAfter+1 {
		t.Fatalf("spawned processes after other session start = %d, want %d", spawnedWithOtherSession, spawnedAfter+1)
	}
	if !adapter.HasLiveSession(otherSession) {
		t.Fatal("other session was affected by first session cleanup backpressure")
	}
	cleanup := adapter.CleanupLiveSessionResources(context.Background(), 1)
	if cleanup.Attempted != 1 || cleanup.Cleaned != 1 || cleanup.Failed != 0 {
		t.Fatalf("cleanup result = %#v, want retired handle cleanup", cleanup)
	}
	oldConnection.mu.Lock()
	closeCalls := oldConnection.closeCalls
	oldConnection.mu.Unlock()
	if closeCalls != 4 {
		t.Fatalf("old transport close calls = %d, want release + replacement + admission + cleanup", closeCalls)
	}
	adapter.mu.Lock()
	retired := len(adapter.retiredSessions[session.AgentSessionID])
	adapter.mu.Unlock()
	if retired != 0 {
		t.Fatalf("retired handles = %d, want 0", retired)
	}
	spawnedBeforeRecovery, _ := transport.snapshot()
	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume after retired cleanup: %v", err)
	}
	spawnedAfterRecovery, _ := transport.snapshot()
	if spawnedAfterRecovery != spawnedBeforeRecovery+1 {
		t.Fatalf("spawned processes after cleanup recovery = %d, want %d", spawnedAfterRecovery, spawnedBeforeRecovery+1)
	}
	if !adapter.HasLiveSession(session) {
		t.Fatal("session did not recover after retired handle cleanup")
	}
}

func TestStandardACPAdapterRetainsInitializeFailureWhenTransportCloseFails(t *testing.T) {
	t.Parallel()

	transport := &multiProcStandardACPTransport{
		agentTitle:      "Kimi Code",
		sessionID:       "kimi-session-initialize-failure",
		initializeError: &acpError{Code: -32603, Message: "initialize failed"},
		closeFailures:   1,
	}
	adapter := newKimiCodeExtensionTestAdapter(t, transport)
	session := standardTestSession("acp:kimi-code")

	if _, err := adapter.Start(context.Background(), session); err == nil {
		t.Fatal("Start error = nil, want initialize failure")
	}
	spawned, _ := transport.snapshot()
	if spawned != 1 || !adapter.hasTrackedLiveSession(session) {
		t.Fatalf("spawned=%d tracked=%v, want failed client retained", spawned, adapter.hasTrackedLiveSession(session))
	}
	cleanup := adapter.CleanupLiveSessionResources(context.Background(), 1)
	if cleanup.Attempted != 1 || cleanup.Cleaned != 1 || cleanup.Failed != 0 {
		t.Fatalf("cleanup result = %#v", cleanup)
	}
}

func TestStandardACPAdapterRetainsStartAndResumeFailuresWhenTransportCloseFails(t *testing.T) {
	t.Parallel()

	t.Run("session new", func(t *testing.T) {
		transport := &multiProcStandardACPTransport{
			agentTitle:      "Kimi Code",
			sessionID:       "kimi-session-new-failure",
			newSessionError: &acpError{Code: -32603, Message: "new failed"},
			closeFailures:   1,
		}
		adapter := newKimiCodeExtensionTestAdapter(t, transport)
		session := standardTestSession("acp:kimi-code")
		if _, err := adapter.Start(context.Background(), session); err == nil {
			t.Fatal("Start error = nil, want session/new failure")
		}
		if !adapter.hasTrackedLiveSession(session) {
			t.Fatal("session/new failed client was not retained")
		}
	})

	t.Run("session load", func(t *testing.T) {
		transport := &multiProcStandardACPTransport{
			agentTitle:               "Kimi Code",
			sessionID:                "kimi-session-load-failure",
			supportsAgentLoadSession: true,
		}
		adapter := newKimiCodeExtensionTestAdapter(t, transport)
		session := standardTestSession("acp:kimi-code")
		if _, err := adapter.Start(context.Background(), session); err != nil {
			t.Fatalf("Start: %v", err)
		}
		if err := adapter.ReleaseLiveSession(context.Background(), session); err != nil {
			t.Fatalf("ReleaseLiveSession: %v", err)
		}
		transport.mu.Lock()
		transport.loadSessionError = &acpError{Code: -32603, Message: "load failed"}
		transport.closeFailures = 1
		transport.mu.Unlock()
		if err := adapter.Resume(context.Background(), session); err == nil {
			t.Fatal("Resume error = nil, want session/load failure")
		}
		if !adapter.hasTrackedLiveSession(session) {
			t.Fatal("session/load failed client was not retained")
		}
	})
}

func TestStandardACPAdapterQuarantinesRetiredClientMessages(t *testing.T) {
	t.Parallel()

	transport := &multiProcStandardACPTransport{
		agentTitle:               "Kimi Code",
		sessionID:                "kimi-session-stale-message",
		supportsAgentLoadSession: true,
	}
	adapter := newKimiCodeExtensionTestAdapter(t, transport)
	session := standardTestSession("acp:kimi-code")
	session.ProviderSessionID = transport.sessionID
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	transport.mu.Lock()
	oldConnection := transport.conns[0]
	transport.mu.Unlock()
	oldConnection.mu.Lock()
	oldConnection.closeFailures = 2
	oldConnection.mu.Unlock()
	if err := adapter.ReleaseLiveSession(context.Background(), session); err == nil {
		t.Fatal("ReleaseLiveSession error = nil, want injected close failure")
	}
	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if _, err := adapter.Exec(context.Background(), session, textPrompt("new generation"), "", "turn-new", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}

	staleEvents := make(chan []activityshared.Event, 1)
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		staleEvents <- events
	})
	oldConnection.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": transport.sessionID,
			"update": map[string]any{
				"sessionUpdate": "agent_message_chunk",
				"content":       map[string]any{"type": "text", "text": "stale output"},
			},
		},
	})
	select {
	case events := <-staleEvents:
		t.Fatalf("retired client emitted events into replacement timeline: %#v", events)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestStandardACPAdapterDefersSettingsAfterReleaseFailureUntilResume(t *testing.T) {
	t.Parallel()

	transport := &multiProcStandardACPTransport{
		agentTitle:               "Kimi Code",
		sessionID:                "kimi-session-settings-recovery",
		supportsAgentLoadSession: true,
		configOptions: []map[string]any{{
			"id":      "model",
			"options": []any{map[string]any{"name": "Model B", "value": "model-b"}},
		}},
	}
	adapterValue, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:            "acp:kimi-code",
		Name:                "kimi-code-acp",
		DisplayName:         "Kimi Code",
		Command:             []string{"kimi", "acp"},
		ModelConfigOptionID: "model",
		PermissionModes:     map[string]string{"full-access": "yolo"},
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	adapter := adapterValue.(*standardACPAdapter)
	session := standardTestSession("acp:kimi-code")
	session.ProviderSessionID = transport.sessionID
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	transport.mu.Lock()
	oldConnection := transport.conns[0]
	transport.mu.Unlock()
	oldConnection.mu.Lock()
	oldConnection.closeFailures = 1
	oldConnection.mu.Unlock()
	if err := adapter.ReleaseLiveSession(context.Background(), session); err == nil {
		t.Fatal("ReleaseLiveSession error = nil, want injected close failure")
	}

	model := "model-b"
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{Model: &model}); err != nil {
		t.Fatalf("ApplySessionSettings on unusable client: %v", err)
	}
	session.PermissionModeID = "full-access"
	if err := adapter.ApplyPermissionMode(context.Background(), session); err != nil {
		t.Fatalf("ApplyPermissionMode on unusable client: %v", err)
	}
	if calls := oldConnection.setConfigOptionCalls(); len(calls) != 0 {
		t.Fatalf("unusable client settings calls = %#v, want none", calls)
	}
	if got := oldConnection.lastModeID(); got != "" {
		t.Fatalf("unusable client mode = %q, want no RPC", got)
	}

	session.Settings = &SessionSettings{Model: model}
	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	transport.mu.Lock()
	resumedConnection := transport.conns[1]
	transport.mu.Unlock()
	calls := resumedConnection.setConfigOptionCalls()
	if len(calls) != 1 || calls[0]["configId"] != "model" || calls[0]["value"] != model {
		t.Fatalf("resumed settings calls = %#v, want durable model", calls)
	}
	if got := resumedConnection.lastModeID(); got != "yolo" {
		t.Fatalf("resumed mode = %q, want durable permission mode", got)
	}
}

func TestControllerCleansRetiredACPHandleAfterCanonicalSessionRemoval(t *testing.T) {
	t.Parallel()

	transport := &multiProcStandardACPTransport{
		agentTitle:               "Kimi Code",
		sessionID:                "kimi-session-detached-cleanup",
		supportsAgentLoadSession: true,
	}
	adapter := newKimiCodeExtensionTestAdapter(t, transport)
	controller := NewController([]Adapter{adapter}, &recordingReporter{})
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-detached-cleanup",
		AgentSessionID: "agent-detached-cleanup",
		Provider:       "acp:kimi-code",
		CWD:            "/workspace",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	transport.mu.Lock()
	connection := transport.conns[0]
	transport.mu.Unlock()
	connection.mu.Lock()
	connection.closeFailures = 2
	connection.mu.Unlock()

	if _, err := controller.Close(context.Background(), CloseInput{
		RoomID:                 started.Session.RoomID,
		AgentSessionID:         started.Session.AgentSessionID,
		PreserveCanonicalState: true,
	}); err == nil {
		t.Fatal("Close error = nil, want retained physical handle failure")
	}
	if _, ok := controller.Session(started.Session.RoomID, started.Session.AgentSessionID); ok {
		t.Fatal("controller retained canonical session")
	}
	if !adapter.hasTrackedLiveSession(started.Session) {
		t.Fatal("adapter lost detached physical handle")
	}

	result := controller.CloseAllLiveSessions(context.Background())
	if result.Scanned != 0 || result.Closed != 0 || result.Failed != 0 ||
		result.ResourceCleanupAttempted != 1 || result.ResourceCleanupCleaned != 0 || result.ResourceCleanupFailed != 1 {
		t.Fatalf("CloseAllLiveSessions result = %#v, want one bounded detached cleanup failure", result)
	}
	if !adapter.hasTrackedLiveSession(started.Session) {
		t.Fatal("detached physical handle was dropped after bounded cleanup failure")
	}
	result = controller.CloseAllLiveSessions(context.Background())
	if result.Scanned != 0 || result.Closed != 0 || result.Failed != 0 ||
		result.ResourceCleanupAttempted != 1 || result.ResourceCleanupCleaned != 1 || result.ResourceCleanupFailed != 0 {
		t.Fatalf("second CloseAllLiveSessions result = %#v, want detached cleanup success", result)
	}
	if adapter.hasTrackedLiveSession(started.Session) {
		t.Fatal("detached physical handle remained after cleanup")
	}
}

func TestStandardACPAdapterReleaseWaitsForLiveSettingsRPC(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Kimi Code", "kimi-session-settings-release")
	transport.conn.supportsAgentLoadSession = true
	transport.conn.configOptions = []map[string]any{{
		"id":      "model",
		"options": []any{map[string]any{"name": "Model B", "value": "model-b"}},
	}}
	adapter := newKimiCodeExtensionTestAdapter(t, transport)
	session := standardTestSession("acp:kimi-code")
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	started := make(chan struct{}, 1)
	releaseRPC := make(chan struct{})
	transport.conn.mu.Lock()
	transport.conn.pauseSettingsRPCStarted = started
	transport.conn.pauseSettingsRPCRelease = releaseRPC
	transport.conn.mu.Unlock()

	settingsDone := make(chan error, 1)
	go func() {
		settingsDone <- adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{Model: stringPtr("model-b")})
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("settings RPC did not start")
	}

	releaseDone := make(chan error, 1)
	go func() {
		releaseDone <- adapter.ReleaseLiveSession(context.Background(), session)
	}()
	select {
	case err := <-releaseDone:
		t.Fatalf("release completed while settings RPC was blocked: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if !adapter.HasLiveSession(session) {
		t.Fatal("release closed the client while settings RPC was blocked")
	}

	close(releaseRPC)
	if err := <-settingsDone; err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}
	if err := <-releaseDone; err != nil {
		t.Fatalf("ReleaseLiveSession: %v", err)
	}
	if adapter.HasLiveSession(session) {
		t.Fatal("release did not close the client after settings completed")
	}
}

func TestStandardACPAdapterReleaseWaitsForPermissionModeRPC(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Kimi Code", "kimi-session-permission-release")
	transport.conn.supportsAgentLoadSession = true
	adapterValue, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:        "acp:kimi-code",
		Name:            "kimi-code-acp",
		DisplayName:     "Kimi Code",
		Command:         []string{"kimi", "acp"},
		PermissionModes: map[string]string{"full-access": "yolo"},
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	adapter := adapterValue.(*standardACPAdapter)
	session := standardTestSession("acp:kimi-code")
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	started := make(chan struct{}, 1)
	releaseRPC := make(chan struct{})
	transport.conn.mu.Lock()
	transport.conn.pauseSettingsRPCStarted = started
	transport.conn.pauseSettingsRPCRelease = releaseRPC
	transport.conn.mu.Unlock()
	session.PermissionModeID = "full-access"

	settingsDone := make(chan error, 1)
	go func() {
		settingsDone <- adapter.ApplyPermissionMode(context.Background(), session)
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("permission mode RPC did not start")
	}

	releaseDone := make(chan error, 1)
	go func() {
		releaseDone <- adapter.ReleaseLiveSession(context.Background(), session)
	}()
	select {
	case err := <-releaseDone:
		t.Fatalf("release completed while permission RPC was blocked: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if !adapter.HasLiveSession(session) {
		t.Fatal("release closed the client while permission RPC was blocked")
	}

	close(releaseRPC)
	if err := <-settingsDone; err != nil {
		t.Fatalf("ApplyPermissionMode: %v", err)
	}
	if err := <-releaseDone; err != nil {
		t.Fatalf("ReleaseLiveSession: %v", err)
	}
}

func TestStandardACPAdapterReleaseLiveSessionRejectsPendingApproval(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Kimi Code", "kimi-session-pending-approval")
	transport.conn.supportsAgentLoadSession = true
	adapter := newKimiCodeExtensionTestAdapter(t, transport)
	session := standardTestSession("acp:kimi-code")

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	adapter.storePendingApproval(&pendingACPApproval{
		agentSessionID: session.AgentSessionID,
		requestID:      "approval-1",
		response:       make(chan pendingInteractiveResponse, 1),
	})
	if err := adapter.ReleaseLiveSession(context.Background(), session); !errors.Is(err, ErrLiveSessionBusy) {
		t.Fatalf("ReleaseLiveSession error = %v, want ErrLiveSessionBusy", err)
	}
	if transport.conn.closed() {
		t.Fatal("transport closed while an approval was pending")
	}
	if !adapter.HasLiveSession(session) {
		t.Fatal("adapter lost live session while an approval was pending")
	}
	if err := adapter.Close(context.Background(), session); err != nil {
		t.Fatalf("Close: %v", err)
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
