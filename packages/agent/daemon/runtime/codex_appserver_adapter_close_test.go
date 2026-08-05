package agentruntime

import (
	"context"
	"testing"
	"time"
)

func TestCodexAppServerCloseQuiescesActiveTurnBeforeSharedDetach(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.holdTurn = true
	parentAppSession := adapter.getSession(session.AgentSessionID)
	adapter.mu.Lock()
	adapter.sessions["side-shared"] = &codexAppServerSession{
		client:   parentAppSession.client,
		threadID: "codex-thread-side",
	}
	adapter.mu.Unlock()

	execDone := make(chan struct{}, 1)
	go func() {
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long task",
		}}, "", "turn-local-close", nil, nil)
		execDone <- struct{}{}
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	if err := adapter.QuiesceForClose(context.Background(), session); err != nil {
		t.Fatalf("QuiesceForClose: %v", err)
	}
	if err := adapter.Close(context.Background(), session); err != nil {
		t.Fatalf("Close: %v", err)
	}
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatal("active Turn survived shared session close")
	}
	interrupt := appServerRequestParams(t, transport.conn, appServerMethodTurnInterrupt)
	if asString(interrupt["threadId"]) != "codex-thread-1" {
		t.Fatalf("turn/interrupt params = %#v", interrupt)
	}
	unsubscribe := appServerRequestParams(t, transport.conn, appServerMethodThreadUnsubscribe)
	if asString(unsubscribe["threadId"]) != "codex-thread-1" {
		t.Fatalf("thread/unsubscribe params = %#v", unsubscribe)
	}
	if adapter.getSession("side-shared") == nil {
		t.Fatal("closing parent removed shared Side session")
	}
	select {
	case <-transport.conn.closed:
		t.Fatal("closing parent terminated shared client")
	default:
	}
}

func TestCodexAppServerCloseWaitsForQueuedInterruptBeforeSharedDetach(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.holdTurn = true
	transport.server.turnStartEntered = make(chan struct{})
	transport.server.turnStartRelease = make(chan struct{})
	parentAppSession := adapter.getSession(session.AgentSessionID)
	adapter.mu.Lock()
	adapter.sessions["side-shared-pending-start"] = &codexAppServerSession{
		client:   parentAppSession.client,
		threadID: "codex-thread-side",
	}
	adapter.mu.Unlock()

	execDone := make(chan struct{}, 1)
	go func() {
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long task",
		}}, "", "turn-local-close-pending-start", nil, nil)
		execDone <- struct{}{}
	}()
	select {
	case <-transport.server.turnStartEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("turn/start was not sent")
	}
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurn(session.AgentSessionID) != nil &&
			adapter.sessionActiveTurnID(session.AgentSessionID) == ""
	})

	quiesced := make(chan error, 1)
	go func() {
		quiesced <- adapter.QuiesceForClose(context.Background(), session)
	}()
	select {
	case err := <-quiesced:
		t.Fatalf("QuiesceForClose returned before queued interrupt settled: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if adapter.getSession(session.AgentSessionID) == nil {
		t.Fatal("source session detached before queued interrupt settled")
	}

	close(transport.server.turnStartRelease)
	select {
	case err := <-quiesced:
		if err != nil {
			t.Fatalf("QuiesceForClose: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("QuiesceForClose did not wait through queued interrupt")
	}
	if err := adapter.Close(context.Background(), session); err != nil {
		t.Fatalf("Close: %v", err)
	}
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatal("active Turn survived pending-start shared session close")
	}
	interrupt := appServerRequestParams(t, transport.conn, appServerMethodTurnInterrupt)
	if asString(interrupt["threadId"]) != "codex-thread-1" ||
		asString(interrupt["turnId"]) != "turn-1" {
		t.Fatalf("turn/interrupt params = %#v", interrupt)
	}
	if adapter.getSession("side-shared-pending-start") == nil {
		t.Fatal("closing parent removed shared Side session")
	}
}

func TestCodexAppServerCloseForceStopsTurnWhoseStartNeverAcknowledges(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.cancelGraceWindow = 20 * time.Millisecond
	transport.server.hangTurnStart = true
	transport.server.turnStartEntered = make(chan struct{})
	parentAppSession := adapter.getSession(session.AgentSessionID)
	adapter.mu.Lock()
	adapter.sessions["side-shared-hung-start"] = &codexAppServerSession{
		client:   parentAppSession.client,
		threadID: "codex-thread-side",
	}
	adapter.mu.Unlock()

	execDone := make(chan struct{}, 1)
	go func() {
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long task",
		}}, "", "turn-local-close-hung-start", nil, nil)
		execDone <- struct{}{}
	}()
	select {
	case <-transport.server.turnStartEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("turn/start was not sent")
	}
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurn(session.AgentSessionID) != nil &&
			adapter.sessionActiveTurnID(session.AgentSessionID) == ""
	})

	if err := adapter.QuiesceForClose(context.Background(), session); err != nil {
		t.Fatalf("QuiesceForClose: %v", err)
	}
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatal("hung turn/start survived close quiesce")
	}
	select {
	case <-transport.conn.closed:
	default:
		t.Fatal("shared transport remained alive with an uninterruptible provider Turn")
	}
}
