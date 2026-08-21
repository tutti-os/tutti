package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestClaudeCodeSDKAdapterCanResumeRequiresProviderSessionID(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = ""
	if adapter.CanResume(session) {
		t.Fatal("CanResume without provider session id = true, want false")
	}
	session.ProviderSessionID = "claude-session-1"
	if !adapter.CanResume(session) {
		t.Fatal("CanResume with provider session id = false, want true")
	}
}

func TestClaudeCodeSDKAdapterMarksProviderReadinessDeadline(t *testing.T) {
	t.Parallel()

	conn := &recordingClaudeSDKConnection{}
	adapter := NewClaudeCodeSDKAdapter(&recordingClaudeSDKTransport{conn: conn})
	session := standardTestSession(ProviderClaudeCode)
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()

	_, err := adapter.Start(ctx, session)
	if !errors.Is(err, ErrProviderStartTimeout) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Start() error = %v, want provider-start marker and deadline cause", err)
	}
	if adapter.getSession(session.AgentSessionID) != nil {
		t.Fatal("timed-out provider readiness retained adapter session")
	}
	requests := conn.sentRequests()
	if len(requests) != 1 || requests[0].Type != "start" {
		t.Fatalf("sent requests = %#v, want one provider start before timeout", requests)
	}
}

func TestClaudeCodeSDKAdapterLeavesPreparationDeadlineUnclassified(t *testing.T) {
	t.Parallel()

	transport := &recordingClaudeSDKTransport{conn: &recordingClaudeSDKConnection{}}
	adapter := NewClaudeCodeSDKAdapter(transport)
	adapter.SetProviderLaunchPreparer(func(context.Context, ProviderLaunchPrepareInput) (ProviderLaunchPrepareResult, error) {
		return ProviderLaunchPrepareResult{}, context.DeadlineExceeded
	})

	_, err := adapter.Start(context.Background(), standardTestSession(ProviderClaudeCode))
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Start() error = %v, want preparation deadline", err)
	}
	if errors.Is(err, ErrProviderStartTimeout) {
		t.Fatalf("Start() error = %v, preparation deadline gained provider-start verdict", err)
	}
	if len(transport.spec.Command) != 0 {
		t.Fatalf("process spec = %#v, preparation failure must not start provider", transport.spec)
	}
}

func TestClaudeCodeSDKAdapterCloseHonorsCallerDeadlineAndForcesTeardown(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := newBlockingClaudeSDKConnection()
	adapterSession := &claudeSDKAdapterSession{
		conn:             conn,
		pendingResponses: make(map[string]chan claudeSDKSidecarEvent),
		readerStarted:    true,
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()

	startedAt := time.Now()
	err := adapter.Close(ctx, session)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Close() error = %v, want deadline exceeded", err)
	}
	if elapsed := time.Since(startedAt); elapsed > time.Second {
		t.Fatalf("Close() elapsed = %v, want caller deadline", elapsed)
	}
	if adapter.getSession(session.AgentSessionID) != nil {
		t.Fatal("timed-out close retained adapter session")
	}
	select {
	case <-conn.closed:
	default:
		t.Fatal("timed-out close did not force connection teardown")
	}
}

func TestClaudeCodeSDKAdapterCloseStartsReaderBeforeRoundTrip(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := newBlockingClaudeSDKConnection()
	adapterSession := &claudeSDKAdapterSession{
		conn:             conn,
		reader:           &claudeSDKLineReader{conn: conn},
		pendingRequests:  make(map[string]*pendingInteractiveRequest),
		pendingResponses: make(map[string]chan claudeSDKSidecarEvent),
		turns:            make(map[string]*claudeSDKTurnWaiter),
		liveState:        newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- adapter.Close(ctx, session)
	}()
	request := waitForClaudeSDKSentRequest(t, conn, "close")
	adapter.mu.Lock()
	readerStarted := adapterSession.readerStarted
	adapter.mu.Unlock()
	conn.pushEvent(claudeSDKSidecarEvent{
		ID:   request.ID,
		Type: "ok",
	})

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Close() error = %v", err)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for Close()")
	}
	if !readerStarted {
		t.Fatal("Close() sent request before starting the shared reader")
	}
}

func TestClaudeCodeSDKAdapterDisconnectLiveSessionClosesColdTransportWithoutCloseRequest(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "provider-session-1"
	conn := newBlockingClaudeSDKConnection()
	adapterSession := &claudeSDKAdapterSession{
		conn:              conn,
		reader:            &claudeSDKLineReader{conn: conn},
		session:           session,
		providerSessionID: session.ProviderSessionID,
		pendingRequests:   make(map[string]*pendingInteractiveRequest),
		pendingResponses:  make(map[string]chan claudeSDKSidecarEvent),
		turns:             make(map[string]*claudeSDKTurnWaiter),
		liveState:         newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	if err := adapter.DisconnectLiveSession(context.Background(), session); err != nil {
		t.Fatalf("DisconnectLiveSession: %v", err)
	}
	if sent := conn.sentRequests(); len(sent) != 0 {
		t.Fatalf("DisconnectLiveSession sent provider close request %#v", sent)
	}
	if adapter.HasLiveSession(session) {
		t.Fatal("HasLiveSession = true after disconnect")
	}
	select {
	case <-conn.closed:
	default:
		t.Fatal("cold Claude transport was not closed")
	}
}

func TestClaudeCodeSDKAdapterDisconnectLiveSessionRetriesCloseFailedHandle(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := newBlockingClaudeSDKConnection()
	conn.closeFailures = 1
	adapterSession := &claudeSDKAdapterSession{
		conn: conn, reader: &claudeSDKLineReader{conn: conn}, session: session,
		pendingRequests:  make(map[string]*pendingInteractiveRequest),
		pendingResponses: make(map[string]chan claudeSDKSidecarEvent),
		turns:            make(map[string]*claudeSDKTurnWaiter), liveState: newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	if err := adapter.DisconnectLiveSession(context.Background(), session); err == nil {
		t.Fatal("first DisconnectLiveSession error=nil, want close failure")
	}
	if adapter.getSession(session.AgentSessionID) != adapterSession {
		t.Fatal("close-failed Claude handle lost ownership")
	}
	if err := adapter.DisconnectLiveSession(context.Background(), session); err != nil {
		t.Fatalf("retry DisconnectLiveSession: %v", err)
	}
	if adapter.getSession(session.AgentSessionID) != nil {
		t.Fatal("Claude handle remained after successful retry")
	}
	conn.mu.Lock()
	closeCalls := conn.closeCalls
	conn.mu.Unlock()
	if closeCalls != 2 {
		t.Fatalf("transport close calls=%d, want 2", closeCalls)
	}
}

type replacementClaudeSDKTransport struct {
	mu    sync.Mutex
	conns []*scriptedClaudeSDKConnection
}

func (t *replacementClaudeSDKTransport) Start(context.Context, ProcessSpec) (ProcessConnection, error) {
	started, err := json.Marshal(claudeSDKSidecarEvent{
		Version: claudeSDKSidecarProtocolVersion,
		Type:    "session_started",
		Payload: map[string]any{"providerSessionId": "provider-session-replacement"},
	})
	if err != nil {
		return nil, err
	}
	conn := &scriptedClaudeSDKConnection{frames: []ProcessFrame{{Stdout: append(started, '\n')}}}
	t.mu.Lock()
	t.conns = append(t.conns, conn)
	t.mu.Unlock()
	return conn, nil
}

func (t *replacementClaudeSDKTransport) starts() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.conns)
}

func TestClaudeCodeSDKAdapterCloseFailureRetainsOwnershipAndBackpressuresFurtherResume(t *testing.T) {
	t.Parallel()

	transport := &replacementClaudeSDKTransport{}
	adapter := NewClaudeCodeSDKAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "provider-session-1"
	oldConnection := newBlockingClaudeSDKConnection()
	oldConnection.closeFailures = 4
	oldSession := &claudeSDKAdapterSession{
		conn: oldConnection, reader: newClaudeSDKLineReader(oldConnection, false), session: session,
		pendingRequests: make(map[string]*pendingInteractiveRequest), pendingResponses: make(map[string]chan claudeSDKSidecarEvent),
		turns: make(map[string]*claudeSDKTurnWaiter), liveState: newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, oldSession)
	if err := adapter.DisconnectLiveSession(t.Context(), session); err == nil {
		t.Fatal("DisconnectLiveSession error=nil, want close failure")
	}
	if adapter.HasLiveSession(session) {
		t.Fatal("close-failed Claude session remained usable")
	}
	if err := adapter.Resume(t.Context(), session); err != nil {
		t.Fatalf("first replacement Resume: %v", err)
	}
	if !adapter.HasLiveSession(session) {
		t.Fatal("replacement Claude session is not usable")
	}
	if err := adapter.DisconnectLiveSession(t.Context(), session); err != nil {
		t.Fatalf("release replacement: %v", err)
	}
	startsBefore := transport.starts()
	err := adapter.Resume(t.Context(), session)
	if AppErrorCode(err) != AppErrorProcessCleanupPending {
		t.Fatalf("second Resume error code=%q err=%v", AppErrorCode(err), err)
	}
	if startsAfter := transport.starts(); startsAfter != startsBefore {
		t.Fatalf("replacement spawned behind cleanup backpressure: %d -> %d", startsBefore, startsAfter)
	}
	cleanupAdapter, ok := any(adapter).(LiveSessionResourceCleanupAdapter)
	if !ok {
		t.Fatal("Claude adapter does not own detached resource cleanup")
	}
	cleanup := cleanupAdapter.CleanupLiveSessionResources(t.Context(), 1)
	if cleanup.Attempted != 1 || cleanup.Failed != 1 {
		t.Fatalf("failed cleanup=%#v", cleanup)
	}
	oldConnection.mu.Lock()
	oldConnection.closeFailures = 0
	oldConnection.mu.Unlock()
	cleanup = cleanupAdapter.CleanupLiveSessionResources(t.Context(), 1)
	if cleanup.Attempted != 1 || cleanup.Cleaned != 1 || cleanup.Failed != 0 {
		t.Fatalf("successful cleanup=%#v", cleanup)
	}
}

func TestClaudeCodeSDKAdapterDropsLateEventsFromRetiredConnection(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	oldSession := &claudeSDKAdapterSession{session: session, liveState: newClaudeSDKLiveState()}
	adapter.beginClaudeSDKRootTurn(oldSession, "turn-old", "provider-turn-old")
	adapter.storeSession(session.AgentSessionID, oldSession)
	replacement := &claudeSDKAdapterSession{session: session, liveState: newClaudeSDKLiveState()}
	adapter.storeSession(session.AgentSessionID, replacement)
	adapter.removeSession(session.AgentSessionID, oldSession)

	var published []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		published = append(published, events...)
	})
	if err := adapter.dispatchClaudeSDKEvent(session.AgentSessionID, oldSession, claudeSDKSidecarEvent{
		Type: "turn_completed",
		Payload: map[string]any{
			"turnId": "turn-old", "providerTurnId": "provider-turn-old", "stopReason": "end_turn",
		},
	}); err != nil {
		t.Fatal(err)
	}
	if len(published) != 0 {
		t.Fatalf("retired connection published late events: %#v", published)
	}
	if adapter.getSession(session.AgentSessionID) != replacement {
		t.Fatal("late retired event displaced replacement session")
	}
}

func TestClaudeCodeSDKAdapterSerializesEventCommitBeforeConcurrentReplacement(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	projectionEntered := make(chan struct{})
	releaseProjection := make(chan struct{})
	pending := &pendingInteractiveRequest{
		agentSessionID: session.AgentSessionID,
		turnID:         "turn-old",
		requestID:      "request-old",
		callID:         "approval:request-old",
		callType:       "approval",
		name:           "Bash",
		onTerminal: func(_ *pendingInteractiveRequest, _ pendingInteractiveRequestState) {
			close(projectionEntered)
			<-releaseProjection
		},
	}
	oldSession := &claudeSDKAdapterSession{
		session: session,
		pendingRequests: map[string]*pendingInteractiveRequest{
			claudeSDKPendingRequestKey(pending.turnID, pending.requestID): pending,
		},
		pendingResponses: make(map[string]chan claudeSDKSidecarEvent),
		turns:            make(map[string]*claudeSDKTurnWaiter),
		liveState:        newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, oldSession)
	var published []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		published = append(published, events...)
	})

	dispatchDone := make(chan error, 1)
	go func() {
		dispatchDone <- adapter.dispatchClaudeSDKEvent(session.AgentSessionID, oldSession, claudeSDKSidecarEvent{
			Type: "approval_resolved",
			Payload: map[string]any{
				"turnId": "turn-old", "requestId": "request-old", "optionId": "allow",
			},
		})
	}()
	<-projectionEntered

	replacementSession := session
	replacementSession.Status = SessionStatusReady
	replacement := &claudeSDKAdapterSession{
		session:          replacementSession,
		pendingRequests:  make(map[string]*pendingInteractiveRequest),
		pendingResponses: make(map[string]chan claudeSDKSidecarEvent),
		turns:            make(map[string]*claudeSDKTurnWaiter),
		liveState:        newClaudeSDKLiveState(),
	}
	replacementDone := make(chan struct{})
	go func() {
		adapter.storeSession(session.AgentSessionID, replacement)
		close(replacementDone)
	}()
	select {
	case <-replacementDone:
		t.Fatal("replacement crossed an in-flight event commit")
	default:
	}
	close(releaseProjection)
	if err := <-dispatchDone; err != nil {
		t.Fatalf("dispatch event: %v", err)
	}
	<-replacementDone
	if len(published) == 0 {
		t.Fatal("event that won the generation commit axis was not published")
	}
	if got := adapter.claudeSDKSessionSnapshot(replacement); got.Status != SessionStatusReady {
		t.Fatalf("replacement session status=%q, want unchanged ready", got.Status)
	}
}

func TestClaudeCodeSDKAdapterReaderFailureCommitsBeforeConcurrentReplacement(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	failureProjectionEntered := make(chan struct{})
	releaseFailureProjection := make(chan struct{})
	pending := &pendingInteractiveRequest{
		agentSessionID: session.AgentSessionID,
		turnID:         "turn-old",
		requestID:      "request-old",
		callID:         "approval:request-old",
		callType:       "approval",
		name:           "Bash",
		onTerminal: func(_ *pendingInteractiveRequest, _ pendingInteractiveRequestState) {
			close(failureProjectionEntered)
			<-releaseFailureProjection
		},
	}
	oldSession := &claudeSDKAdapterSession{
		session: session,
		pendingRequests: map[string]*pendingInteractiveRequest{
			claudeSDKPendingRequestKey(pending.turnID, pending.requestID): pending,
		},
		pendingResponses: make(map[string]chan claudeSDKSidecarEvent),
		turns:            make(map[string]*claudeSDKTurnWaiter),
		liveState:        newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, oldSession)
	var published []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		published = append(published, events...)
	})

	failureDone := make(chan struct{})
	go func() {
		adapter.failClaudeSDKReader(session.AgentSessionID, oldSession, errors.New("old reader failed"))
		close(failureDone)
	}()
	<-failureProjectionEntered
	replacement := &claudeSDKAdapterSession{
		session:          session,
		pendingRequests:  make(map[string]*pendingInteractiveRequest),
		pendingResponses: make(map[string]chan claudeSDKSidecarEvent),
		turns:            make(map[string]*claudeSDKTurnWaiter),
		liveState:        newClaudeSDKLiveState(),
	}
	replacementDone := make(chan struct{})
	go func() {
		adapter.storeSession(session.AgentSessionID, replacement)
		close(replacementDone)
	}()
	select {
	case <-replacementDone:
		t.Fatal("replacement crossed an in-flight reader-failure commit")
	default:
	}
	close(releaseFailureProjection)
	<-failureDone
	<-replacementDone
	if len(published) == 0 {
		t.Fatal("reader failure that won the commit axis published no terminal events")
	}
	if got := adapter.getSession(session.AgentSessionID); got != replacement {
		t.Fatal("replacement did not become current after reader-failure commit")
	}
}

func TestClaudeCodeSDKAdapterDropsInteractiveAckAfterReplacement(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	pending := &pendingInteractiveRequest{
		agentSessionID: session.AgentSessionID,
		turnID:         "turn-old",
		requestID:      "request-old",
		callID:         "approval:request-old",
		callType:       "approval",
		name:           "Bash",
		state:          pendingInteractiveRequestStateResolving,
	}
	oldSession := &claudeSDKAdapterSession{
		session: session,
		pendingRequests: map[string]*pendingInteractiveRequest{
			claudeSDKPendingRequestKey(pending.turnID, pending.requestID): pending,
		},
		pendingResponses: make(map[string]chan claudeSDKSidecarEvent),
		turns:            make(map[string]*claudeSDKTurnWaiter),
		liveState:        newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, oldSession)
	replacementSession := session
	replacementSession.Status = SessionStatusReady
	replacement := &claudeSDKAdapterSession{
		session:          replacementSession,
		pendingRequests:  make(map[string]*pendingInteractiveRequest),
		pendingResponses: make(map[string]chan claudeSDKSidecarEvent),
		turns:            make(map[string]*claudeSDKTurnWaiter),
		liveState:        newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, replacement)
	var published []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		published = append(published, events...)
	})

	adapter.applyClaudeSDKInteractiveAck(
		oldSession,
		session,
		pending,
		pendingInteractiveResponse{optionID: "allow"},
		claudeSDKInteractiveAck{disposition: InteractiveDispositionAnswered},
	)
	if got := pending.disposition(); got != pendingInteractiveRequestStateResolving {
		t.Fatalf("old request disposition=%q, want unchanged resolving", got)
	}
	if len(published) != 0 {
		t.Fatalf("old interactive ack published after replacement: %#v", published)
	}
	if got := adapter.claudeSDKSessionSnapshot(replacement); got.Status != SessionStatusReady {
		t.Fatalf("replacement session status=%q, want unchanged ready", got.Status)
	}
}

func TestClaudeCodeSDKAdapterExitedConnectionWithPersistentCloseFailureRemainsOwned(t *testing.T) {
	transport := &replacementClaudeSDKTransport{}
	adapter := NewClaudeCodeSDKAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	base := newBlockingClaudeSDKConnection()
	connection := newDoneClosedCloseFailConnection(base)
	adapterSession := &claudeSDKAdapterSession{
		conn: connection, reader: newClaudeSDKLineReader(connection, false), session: session,
		pendingRequests: make(map[string]*pendingInteractiveRequest), pendingResponses: make(map[string]chan claudeSDKSidecarEvent),
		turns: make(map[string]*claudeSDKTurnWaiter), liveState: newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	if err := adapter.DisconnectLiveSession(t.Context(), session); err == nil {
		t.Fatal("DisconnectLiveSession error=nil, want persistent Close failure")
	}
	if adapter.HasLiveSession(session) {
		t.Fatal("close-failed Claude connection reported usable")
	}
	if adapter.getSession(session.AgentSessionID) != adapterSession {
		t.Fatal("Done-closed close-failed Claude handle lost current ownership")
	}
	if err := adapter.Resume(t.Context(), session); err != nil {
		t.Fatalf("Resume after exited close failure: %v", err)
	}
	if !adapter.HasLiveSession(session) {
		t.Fatal("replacement Claude session is not usable")
	}
	if adapter.getSession(session.AgentSessionID) == adapterSession {
		t.Fatal("exited close-failed Claude handle remained current after replacement")
	}
	cleanup := adapter.CleanupLiveSessionResources(t.Context(), 1)
	if cleanup.Attempted != 1 || cleanup.Failed != 1 || cleanup.Cleaned != 0 {
		t.Fatalf("cleanup=%#v, want one retained failure", cleanup)
	}
	connection.mu.Lock()
	closeCalls := connection.closeCalls
	connection.mu.Unlock()
	if closeCalls != 3 {
		t.Fatalf("Close calls=%d, want disconnect + replacement retirement + bounded cleanup", closeCalls)
	}
}

func TestClaudeCodeSDKAdapterDisconnectLiveSessionConvergesPendingInteractiveAndProviderTurn(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	conn := newBlockingClaudeSDKConnection()
	adapterSession := &claudeSDKAdapterSession{
		conn: conn, reader: &claudeSDKLineReader{conn: conn}, session: session,
		pendingRequests:  make(map[string]*pendingInteractiveRequest),
		pendingResponses: make(map[string]chan claudeSDKSidecarEvent),
		turns:            make(map[string]*claudeSDKTurnWaiter), liveState: newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-disconnect", "provider-turn-disconnect")
	waiter := adapter.registerClaudeSDKTurn(adapterSession, "turn-disconnect", nil)
	if _, _, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-disconnect", claudeSDKSidecarEvent{
		Type: "approval_requested",
		Payload: map[string]any{
			"turnId": "turn-disconnect", "requestId": "approval-disconnect",
			"toolName": "Bash", "input": map[string]any{"command": "sleep 10"},
		},
	}); err != nil {
		t.Fatalf("approval_requested: %v", err)
	}
	var received []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		received = append(received, events...)
	})
	if err := adapter.DisconnectLiveSession(context.Background(), session); err != nil {
		t.Fatalf("DisconnectLiveSession: %v", err)
	}
	if len(received) != 3 ||
		received[0].Type != activityshared.EventInteractionSuperseded ||
		received[1].Type != activityshared.EventCallFailed ||
		received[2].Type != activityshared.EventRootProviderTurnCompleted {
		t.Fatalf("disconnect events=%#v", received)
	}
	select {
	case result := <-waiter.done:
		if !errors.Is(result.err, ErrSessionDisconnected) {
			t.Fatalf("waiter error=%v, want ErrSessionDisconnected", result.err)
		}
	default:
		t.Fatal("active Claude turn was not terminalized")
	}
}

func TestClaudeCodeSDKAdapterResumeClassifiesMissingProviderSession(t *testing.T) {
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "00000000-0000-4000-8000-000000000000"
	err := classifyClaudeSDKResumeError(session, errors.New("Claude Code returned an error result: No conversation found with session ID: 00000000-0000-4000-8000-000000000000"))
	if AppErrorCode(err) != AppErrorProviderSessionNotFound {
		t.Fatalf("app error code = %q, want %q", AppErrorCode(err), AppErrorProviderSessionNotFound)
	}
}

func TestClaudeCodeSDKAdapterSessionStateSeedsCommandsAndCapabilities(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		providerSessionID: "provider-session-1",
		liveState:         newClaudeSDKLiveState(),
	})

	state := adapter.SessionState(session)
	commands, _ := state.RuntimeContext["commands"].([]string)
	for _, want := range []string{"compact", "status", "fast", "goal", "review"} {
		if !containsString(commands, want) {
			t.Fatalf("commands = %#v, missing %q", commands, want)
		}
	}
	capabilities := state.Capabilities.Values
	if _, duplicated := state.RuntimeContext["capabilities"]; duplicated {
		t.Fatalf("runtime context duplicated typed capabilities: %#v", state.RuntimeContext)
	}
	for _, want := range []string{CapabilityImageInput, CapabilityCompact, CapabilityTokenUsage, CapabilityRateLimits, CapabilityPlanMode, CapabilityInterrupt, CapabilityActiveTurnGuidance, CapabilitySkills, "review"} {
		if !containsString(capabilities, want) {
			t.Fatalf("capabilities = %#v, missing %q", capabilities, want)
		}
	}
	snapshot, ok := adapter.SessionCommandSnapshot(session)
	if !ok || len(snapshot.Commands) == 0 {
		t.Fatalf("SessionCommandSnapshot = %#v ok=%v, want seeded commands", snapshot, ok)
	}
}

func TestClaudeCodeSDKAdapterSessionStateReflectsOptionalComposerCapabilities(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.Env = append(session.Env,
		browserUseEnabledEnv+"=1",
		computerUseEnabledEnv+"=true",
	)
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		providerSessionID: "provider-session-1",
		liveState:         newClaudeSDKLiveState(),
	})

	state := adapter.SessionState(session)
	capabilities := state.Capabilities.Values
	for _, want := range []string{CapabilityBrowserUse, CapabilityComputerUse} {
		if !containsString(capabilities, want) {
			t.Fatalf("capabilities = %#v, missing %q", capabilities, want)
		}
	}
}

func TestClaudeCodeSDKAdapterSessionStateSeedsCanonicalSpeedConfigOption(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.Settings = &SessionSettings{Speed: "fast"}
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		providerSessionID: "provider-session-1",
		liveState:         newClaudeSDKLiveState(),
	})

	state := adapter.SessionState(session)
	if state.RuntimeContext["speed"] != "fast" {
		t.Fatalf("runtime speed = %#v, want fast", state.RuntimeContext["speed"])
	}
	if !hasClaudeSDKSpeedConfigOptions(state.RuntimeContext, "fast") {
		t.Fatalf("runtimeContext = %#v, want SDK speed config option set to fast", state.RuntimeContext)
	}
}

func TestClaudeCodeSDKAdapterRuntimeContextIncludesProviderConfig(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.Env = append(session.Env, "ANTHROPIC_BASE_URL=https://anthropic.proxy.test")
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		providerSessionID: "provider-session-1",
		liveState:         newClaudeSDKLiveState(),
	})

	state := adapter.SessionState(session)
	providerConfig, _ := state.RuntimeContext["providerConfig"].(map[string]any)
	if got, _ := providerConfig["baseUrl"].(string); got != "https://anthropic.proxy.test" {
		t.Fatalf("providerConfig = %#v, want SDK baseUrl", providerConfig)
	}
}

func TestClaudeCodeSDKAdapterStartSkipsBootstrapOnAttachedLiveConnection(t *testing.T) {
	conn := &attachedLiveClaudeSDKConnection{}
	adapter := NewClaudeCodeSDKAdapter(&attachedLiveClaudeSDKTransport{conn: conn})
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "provider-session-1"

	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("Start events = %#v, want session.started", events)
	}
	if sent := conn.sentRequests(); len(sent) != 0 {
		t.Fatalf("attached-live Start sent %#v, want no start bootstrap", sent)
	}
	if !adapter.HasLiveSession(session) {
		t.Fatal("attached-live Start left no live session")
	}
}

type attachedLiveClaudeSDKTransport struct {
	conn *attachedLiveClaudeSDKConnection
}

func (t *attachedLiveClaudeSDKTransport) Start(_ context.Context, _ ProcessSpec) (ProcessConnection, error) {
	return t.conn, nil
}

type attachedLiveClaudeSDKConnection struct {
	scriptedClaudeSDKConnection
}

func (*attachedLiveClaudeSDKConnection) ProcessCassetteCaptureOrigin() ProcessCassetteCaptureOrigin {
	return ProcessCassetteCaptureOriginAttachedLiveConnection
}

func TestClaudeCodeSDKAdapterStartSendsInitialSettings(t *testing.T) {
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"session_started","payload":{"providerSessionId":"provider-session-1"}}` + "\n"),
		}},
	}
	transport := &recordingClaudeSDKTransport{conn: conn}
	adapter := NewClaudeCodeSDKAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "provider-session-1"
	session.PermissionModeID = "bypassPermissions"
	session.Settings = &SessionSettings{
		Model:            "sonnet",
		PermissionModeID: "bypassPermissions",
		PlanMode:         true,
		ReasoningEffort:  "xhigh",
		Speed:            "fast",
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "start" {
		t.Fatalf("sent requests = %#v, want start", sent)
	}
	payload := sent[0].Payload
	if payload["permissionModeId"] != "bypassPermissions" {
		t.Fatalf("start payload permissionModeId = %#v", payload["permissionModeId"])
	}
	settings := payloadMap(payload, "settings")
	if settings["model"] != "sonnet" ||
		settings["permissionModeId"] != "bypassPermissions" ||
		settings["planMode"] != true ||
		settings["reasoningEffort"] != "xhigh" ||
		settings["speed"] != "fast" {
		t.Fatalf("start settings = %#v", settings)
	}
}

func TestClaudeCodeSDKAdapterProviderLaunchPrepareMutatesSpecAndCleansUpOnClose(t *testing.T) {
	conn := newBlockingClaudeSDKConnection()
	conn.pushEvent(claudeSDKSidecarEvent{
		Type: "session_started",
		Payload: map[string]any{
			"providerSessionId": "provider-session-1",
		},
	})
	transport := &recordingClaudeSDKTransport{conn: conn}
	adapter := NewClaudeCodeSDKAdapter(transport)
	cleanupCalls := 0
	adapter.SetProviderLaunchPreparer(func(_ context.Context, input ProviderLaunchPrepareInput) (ProviderLaunchPrepareResult, error) {
		if input.Provider != ProviderClaudeCode {
			t.Fatalf("Provider = %q, want %q", input.Provider, ProviderClaudeCode)
		}
		if !input.DirectStart {
			t.Fatal("DirectStart = false, want true for Claude SDK")
		}
		return ProviderLaunchPrepareResult{
			Command: []string{"prepared-node", "sidecar.ts"},
			Env:     append(append([]string(nil), input.Env...), "HOOK_ENV=1"),
			CWD:     "/prepared/claude-sdk",
			Cleanup: func(context.Context) error {
				cleanupCalls++
				return nil
			},
		}, nil
	})
	session := standardTestSession(ProviderClaudeCode)
	session.Env = []string{"SESSION_ENV=1"}
	session.ProviderSessionID = "provider-session-1"

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if cleanupCalls != 0 {
		t.Fatalf("cleanup calls before close = %d, want 0", cleanupCalls)
	}
	if !slices.Equal(transport.spec.Command, []string{"prepared-node", "sidecar.ts"}) {
		t.Fatalf("Command = %#v", transport.spec.Command)
	}
	if transport.spec.CWD != "/prepared/claude-sdk" {
		t.Fatalf("CWD = %q", transport.spec.CWD)
	}
	if !containsString(transport.spec.Env, "SESSION_ENV=1") || !containsString(transport.spec.Env, "HOOK_ENV=1") {
		t.Fatalf("Env = %#v, want session and hook env", transport.spec.Env)
	}
	requests := conn.sentRequests()
	if len(requests) != 1 || requests[0].Type != "start" {
		t.Fatalf("sidecar requests = %#v, want start", requests)
	}
	if requests[0].Payload["cwd"] != "/prepared/claude-sdk" {
		t.Fatalf("start payload cwd = %#v, want prepared cwd", requests[0].Payload["cwd"])
	}
	startEnv := payloadMap(requests[0].Payload, "env")
	if startEnv["SESSION_ENV"] != "1" || startEnv["HOOK_ENV"] != "1" {
		t.Fatalf("start payload env = %#v, want session and hook env", startEnv)
	}

	closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	closeDone := make(chan error, 1)
	go func() {
		closeDone <- adapter.Close(closeCtx, session)
	}()
	closeRequest := waitForClaudeSDKSentRequest(t, conn, "close")
	conn.pushEvent(claudeSDKSidecarEvent{ID: closeRequest.ID, Type: "ok"})
	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatalf("Close: %v", err)
		}
	case <-closeCtx.Done():
		t.Fatal("timed out waiting for Close")
	}
	if cleanupCalls != 1 {
		t.Fatalf("cleanup calls after close = %d, want 1", cleanupCalls)
	}
	requests = conn.sentRequests()
	if len(requests) == 0 || requests[len(requests)-1].Type != "close" {
		t.Fatalf("last sidecar request = %#v, want close handshake", requests)
	}
}

func TestClaudeSDKSidecarCommandUsesVendoredEntryWithManagedNodeEnv(t *testing.T) {
	t.Setenv(claudeSDKSidecarCommandEnv, "")
	t.Setenv(claudeSDKSidecarEntryPathEnv, "")

	got := claudeSDKSidecarCommand([]string{
		claudeSDKAppNodeEnv + "=/runtime/node/bin/node",
		claudeSDKSidecarEntryPathEnv + "=/resources/bin/claude-sdk-sidecar/src/main.ts",
	})
	want := []string{"/runtime/node/bin/node", claudeSDKSidecarDefaultNodeArg, "/resources/bin/claude-sdk-sidecar/src/main.ts"}
	if !slices.Equal(got, want) {
		t.Fatalf("claudeSDKSidecarCommand() = %#v, want %#v", got, want)
	}
}

func TestClaudeSDKSidecarCommandUsesManagedNodeCacheRoot(t *testing.T) {
	t.Setenv(claudeSDKSidecarCommandEnv, "")
	t.Setenv(claudeSDKSidecarEntryPathEnv, "")
	t.Setenv(claudeSDKAppRuntimeRootEnv, "")

	cacheRoot := t.TempDir()
	nodePath := filepath.Join(cacheRoot, runtime.GOOS+"-"+runtime.GOARCH, "node", "bin", claudeSDKNodeBinaryName())
	if err := os.MkdirAll(filepath.Dir(nodePath), 0o755); err != nil {
		t.Fatalf("mkdir node dir: %v", err)
	}
	if err := os.WriteFile(nodePath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("write node: %v", err)
	}

	got := claudeSDKSidecarCommand([]string{
		claudeSDKAppRuntimeCacheEnv + "=" + cacheRoot,
		claudeSDKSidecarEntryPathEnv + "=/resources/bin/claude-sdk-sidecar/src/main.ts",
	})
	want := []string{nodePath, claudeSDKSidecarDefaultNodeArg, "/resources/bin/claude-sdk-sidecar/src/main.ts"}
	if !slices.Equal(got, want) {
		t.Fatalf("claudeSDKSidecarCommand() = %#v, want %#v", got, want)
	}
}

func TestClaudeSDKSidecarCommandOverrideWinsOverVendoredEntry(t *testing.T) {
	t.Setenv(claudeSDKSidecarCommandEnv, "/custom/sidecar --flag")

	got := claudeSDKSidecarCommand([]string{
		claudeSDKAppNodeEnv + "=/runtime/node/bin/node",
		claudeSDKSidecarEntryPathEnv + "=/resources/bin/claude-sdk-sidecar/src/main.ts",
	})
	want := []string{"/custom/sidecar", "--flag"}
	if !slices.Equal(got, want) {
		t.Fatalf("claudeSDKSidecarCommand() = %#v, want %#v", got, want)
	}
}

func TestClaudeCodeSDKAdapterStartEnablesSandboxBypassEnv(t *testing.T) {
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"session_started","payload":{"providerSessionId":"provider-session-1"}}` + "\n"),
		}},
	}
	transport := &recordingClaudeSDKTransport{conn: conn}
	adapter := NewClaudeCodeSDKAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !containsString(transport.spec.Env, "IS_SANDBOX=1") {
		t.Fatalf("env = %#v, want IS_SANDBOX=1 for Claude SDK bypassPermissions availability", transport.spec.Env)
	}
}

func TestClaudeCodeSDKAdapterStartPassesPreparedClaudeMetaPathsToSidecar(t *testing.T) {
	systemPromptPath := "/run/tsh/managed-agent/session/claude-system-prompt.md"
	pluginDir := "/run/tsh/managed-agent/session/claude-plugin/tutti-cli"
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"session_started","payload":{"providerSessionId":"provider-session-meta"}}` + "\n"),
		}},
	}
	adapter := NewClaudeCodeSDKAdapter(&recordingClaudeSDKTransport{conn: conn})
	adapter.SetProviderLaunchPreparer(func(_ context.Context, input ProviderLaunchPrepareInput) (ProviderLaunchPrepareResult, error) {
		return ProviderLaunchPrepareResult{
			Command: input.Command,
			Env: append(append([]string(nil), input.Env...),
				"TUTTI_CLAUDE_SYSTEM_PROMPT_FILE="+systemPromptPath,
				"TUTTI_CLAUDE_PLUGIN_DIR="+pluginDir,
			),
			CWD: input.CWD,
		}, nil
	})
	session := standardTestSession(ProviderClaudeCode)
	session.Settings = &SessionSettings{
		Model:            "MiniMax-M2.7",
		PermissionModeID: "default",
		PlanMode:         true,
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "start" {
		t.Fatalf("sent requests = %#v, want start", sent)
	}
	payload := sent[0].Payload
	if _, ok := payload["systemPromptAppend"]; ok {
		t.Fatalf("systemPromptAppend = %#v, want sidecar to read the prepared file", payload["systemPromptAppend"])
	}
	env := payloadMap(payload, "env")
	if env["TUTTI_CLAUDE_SYSTEM_PROMPT_FILE"] != systemPromptPath || env["TUTTI_CLAUDE_PLUGIN_DIR"] != pluginDir {
		t.Fatalf("env = %#v, want prepared Claude metadata paths", env)
	}
	if got, _ := payload["planModeInstructions"].(string); !strings.Contains(got, "do not edit files") || !strings.Contains(got, "implementation plan") {
		t.Fatalf("planModeInstructions = %#v, want Tutti plan workflow instructions", payload["planModeInstructions"])
	}
	settings := payloadMap(payload, "settings")
	if _, ok := settings["plansDirectory"]; ok {
		t.Fatalf("settings.plansDirectory = %#v, want Claude SDK default", settings["plansDirectory"])
	}
	allowedTools, ok := payload["allowedTools"].([]any)
	grepAllowed := false
	globAllowed := false
	for _, tool := range allowedTools {
		grepAllowed = grepAllowed || asString(tool) == "Grep"
		globAllowed = globAllowed || asString(tool) == "Glob"
	}
	if !ok || !grepAllowed || !globAllowed {
		t.Fatalf("allowedTools = %#v, want Grep and Glob enabled", payload["allowedTools"])
	}
	disallowedTools, ok := payload["disallowedTools"].([]any)
	monitorDisallowed := false
	for _, tool := range disallowedTools {
		monitorDisallowed = monitorDisallowed || asString(tool) == "Monitor"
	}
	if !ok || !monitorDisallowed {
		t.Fatalf("disallowedTools = %#v, want Monitor disabled", payload["disallowedTools"])
	}
	tools, ok := payload["tools"].(map[string]any)
	if !ok || tools["type"] != "preset" || tools["preset"] != "claude_code" {
		t.Fatalf("tools = %#v, want claude_code preset", payload["tools"])
	}
	if _, ok := payload["plugins"]; ok {
		t.Fatalf("plugins = %#v, want sidecar to resolve the prepared plugin dir", payload["plugins"])
	}
	extraArgs, ok := payload["extraArgs"].(map[string]any)
	if !ok || extraArgs["model"] != "MiniMax-M2.7" {
		t.Fatalf("extraArgs = %#v, want custom model", payload["extraArgs"])
	}
	if _, ok := extraArgs["plugin-dir"]; ok {
		t.Fatalf("extraArgs = %#v, want sidecar to resolve plugin-dir", extraArgs)
	}
}

func TestClaudeCodeSDKAdapterStartSendsResumeCursor(t *testing.T) {
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"session_started","payload":{"providerSessionId":"provider-session-1","resumeCursor":{"kind":"claude-agent-sdk","version":1,"resume":"provider-session-1","resumeSessionAt":"assistant-1","turnCount":7}}}` + "\n"),
		}},
	}
	adapter := NewClaudeCodeSDKAdapter(&recordingClaudeSDKTransport{conn: conn})
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "provider-session-1"
	session.RuntimeContext = map[string]any{
		"resumeCursor": map[string]any{
			"kind":            "claude-agent-sdk",
			"version":         int64(1),
			"resume":          "provider-session-1",
			"resumeSessionAt": "assistant-1",
			"turnCount":       int64(7),
		},
	}

	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("events = %#v, want session started", events)
	}
	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "start" {
		t.Fatalf("sent requests = %#v, want start", sent)
	}
	cursor := payloadMap(sent[0].Payload, "resumeCursor")
	if cursor["resume"] != "provider-session-1" || cursor["resumeSessionAt"] != "assistant-1" {
		t.Fatalf("resume cursor payload = %#v", cursor)
	}
	stateCursor := payloadMap(events[0].Payload.Metadata, "resumeCursor")
	if stateCursor["resume"] != "provider-session-1" || stateCursor["resumeSessionAt"] != "assistant-1" {
		t.Fatalf("started runtime cursor = %#v", stateCursor)
	}
}

func TestClaudeCodeSDKAdapterStartDropsResumeCursorFromForkSource(t *testing.T) {
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"session_started","payload":{"providerSessionId":"provider-session-child"}}` + "\n"),
		}},
	}
	adapter := NewClaudeCodeSDKAdapter(&recordingClaudeSDKTransport{conn: conn})
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "provider-session-child"
	session.RuntimeContext = map[string]any{
		"resumeCursor": map[string]any{
			"kind":            "claude-agent-sdk",
			"version":         int64(1),
			"resume":          "provider-session-source",
			"resumeSessionAt": "source-assistant-1",
			"turnCount":       int64(7),
		},
	}

	if _, err := adapter.Start(t.Context(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "start" {
		t.Fatalf("sent requests = %#v, want start", sent)
	}
	if cursor := payloadMap(sent[0].Payload, "resumeCursor"); len(cursor) != 0 {
		t.Fatalf("resume cursor payload = %#v, want stale source cursor removed", cursor)
	}
	if sent[0].Payload["providerSessionId"] != "provider-session-child" {
		t.Fatalf(
			"provider session id = %#v, want forked child",
			sent[0].Payload["providerSessionId"],
		)
	}
}

func TestClaudeCodeSDKAdapterSessionStateUpdatesResumeCursor(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		providerSessionID: "provider-session-1",
		liveState:         newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "session_state",
		Payload: map[string]any{
			"providerSessionId": "provider-session-2",
			"resumeCursor": map[string]any{
				"kind":            "claude-agent-sdk",
				"version":         int64(1),
				"resume":          "provider-session-2",
				"resumeSessionAt": "assistant-2",
				"turnCount":       int64(3),
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("session_state terminal=%v err=%v", terminal, err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionUpdated {
		t.Fatalf("events = %#v, want session.updated", events)
	}
	if adapterSession.providerSessionID != "provider-session-2" {
		t.Fatalf("provider session id = %q, want updated", adapterSession.providerSessionID)
	}
	state := adapter.SessionState(session)
	cursor := payloadMap(state.RuntimeContext, "resumeCursor")
	if cursor["resume"] != "provider-session-2" || cursor["resumeSessionAt"] != "assistant-2" {
		t.Fatalf("runtime cursor = %#v", cursor)
	}
}

func TestClaudeCodeSDKAdapterResumeFailureRestoresPreviousLiveSession(t *testing.T) {
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"error","payload":{"error":"No conversation found with session ID: provider-session-1"}}` + "\n"),
		}},
	}
	adapter := NewClaudeCodeSDKAdapter(&recordingClaudeSDKTransport{conn: conn})
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "provider-session-1"
	previous := &claudeSDKAdapterSession{
		conn:              &recordingClaudeSDKConnection{},
		providerSessionID: "previous-live-session",
		liveState:         newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, previous)

	err := adapter.Resume(context.Background(), session)
	if AppErrorCode(err) != AppErrorProviderSessionNotFound {
		t.Fatalf("Resume error = %v, want provider session not found", err)
	}
	if got := adapter.getSession(session.AgentSessionID); got != previous {
		t.Fatalf("live session not restored after failed resume")
	}
}

func TestClaudeCodeSDKAdapterSessionStateProjectsSettings(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.PermissionModeID = "auto"
	session.Settings = &SessionSettings{
		Model:            "sonnet",
		PermissionModeID: "auto",
		ReasoningEffort:  "xhigh",
		Speed:            "fast",
		PlanMode:         true,
	}
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		providerSessionID: "provider-session-1",
		liveState:         newClaudeSDKLiveState(),
	})

	state := adapter.SessionState(session)
	if state.RuntimeContext["model"] != "sonnet" ||
		state.RuntimeContext["permissionModeId"] != "auto" ||
		state.RuntimeContext["reasoningEffort"] != "xhigh" ||
		state.RuntimeContext["speed"] != "fast" ||
		state.RuntimeContext["planMode"] != true {
		t.Fatalf("runtimeContext settings = %#v", state.RuntimeContext)
	}
	if !hasClaudeSDKEffortConfigOptions(state.RuntimeContext, "xhigh") {
		t.Fatalf("runtimeContext = %#v, want SDK effort config option set to xhigh", state.RuntimeContext)
	}
}

func TestClaudeCodeSDKAdapterAcceptsImagePromptContent(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)

	if err := adapter.ValidatePromptContent(session, []PromptContentBlock{
		{Type: "text", Text: "what is in this image?"},
		{Type: "image", MimeType: "image/png", Data: "aW1hZ2U="},
	}); err != nil {
		t.Fatalf("ValidatePromptContent supported image = %v, want nil", err)
	}
	if err := adapter.ValidatePromptContent(session, []PromptContentBlock{
		{Type: "image", MimeType: "image/png", Path: "/managed/agent-prompt-assets/screen.png"},
	}); err != nil {
		t.Fatalf("ValidatePromptContent path-backed image = %v, want nil", err)
	}
	if err := adapter.ValidatePromptContent(session, []PromptContentBlock{
		{Type: "image", MimeType: "image/gif", Data: "aW1hZ2U="},
	}); !errors.Is(err, ErrPromptImageUnsupported) {
		t.Fatalf("ValidatePromptContent unsupported image = %v, want ErrPromptImageUnsupported", err)
	}
}

func TestClaudeCodeSDKAdapterExecSendsStructuredPromptContent(t *testing.T) {
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"provider_turn_identity_resolved","payload":{"turnId":"turn-image","providerTurnId":"provider-turn-image"}}` + "\n" + `{"type":"turn_completed","payload":{"turnId":"turn-image","providerTurnId":"provider-turn-image","stopReason":"end_turn"}}` + "\n"),
		}},
	}
	adapter := NewClaudeCodeSDKAdapter(nil)
	imageURL, materializer := testRemotePromptImageMaterializer(t)
	adapter.promptImageMaterializer = materializer
	session := standardTestSession(ProviderClaudeCode)
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		conn:              conn,
		reader:            &claudeSDKLineReader{conn: conn},
		providerSessionID: "provider-session-1",
		pendingRequests:   make(map[string]*pendingInteractiveRequest),
		liveState:         newClaudeSDKLiveState(),
	})

	if _, err := adapter.Exec(
		context.Background(),
		session,
		[]PromptContentBlock{
			{Type: "text", Text: "what is in this image?"},
			{Type: "image", MimeType: "image/png", URL: imageURL},
		},
		"what is in this image?",
		"turn-image",
		nil,
		nil,
	); err != nil {
		t.Fatalf("Exec: %v", err)
	}

	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "exec" {
		t.Fatalf("sent requests = %#v, want one exec", sent)
	}
	if sent[0].Payload["prompt"] != "what is in this image?" {
		t.Fatalf("exec prompt = %#v, want legacy text prompt", sent[0].Payload["prompt"])
	}
	promptCorrelationID := payloadString(sent[0].Payload, "promptCorrelationId")
	if promptCorrelationID == "" || promptCorrelationID == "turn-image" {
		t.Fatalf(
			"exec prompt correlation id = %q, want a distinct UUID",
			promptCorrelationID,
		)
	}
	content, ok := sent[0].Payload["content"].([]any)
	if !ok || len(content) != 2 {
		t.Fatalf("exec content = %#v, want text and image blocks", sent[0].Payload["content"])
	}
	textBlock, _ := content[0].(map[string]any)
	if textBlock["type"] != "text" || textBlock["text"] != "what is in this image?" {
		t.Fatalf("text block = %#v", textBlock)
	}
	imageBlock, _ := content[1].(map[string]any)
	if imageBlock["type"] != "image" || imageBlock["mimeType"] != "image/png" || imageBlock["data"] != "aGk=" || imageBlock["url"] != nil {
		t.Fatalf("image block = %#v", imageBlock)
	}
}
