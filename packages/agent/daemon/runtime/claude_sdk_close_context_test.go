package agentruntime

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestClaudeCodeSDKAdapterCloseHonorsContextWhileSendGateIsHeld(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	connection := &recordingClaudeSDKConnection{}
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		conn:             connection,
		readerStarted:    true,
		pendingResponses: make(map[string]chan claudeSDKSidecarEvent),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	adapterSession.sendMu.Lock()
	defer adapterSession.sendMu.Unlock()
	ctx, cancel := context.WithTimeout(t.Context(), 25*time.Millisecond)
	defer cancel()

	startedAt := time.Now()
	err := adapter.Close(ctx, session)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Close() error = %v, want context deadline exceeded", err)
	}
	if elapsed := time.Since(startedAt); elapsed > time.Second {
		t.Fatalf("Close() elapsed = %v, want bounded by context", elapsed)
	}
	if sent := connection.sentRequests(); len(sent) != 0 {
		t.Fatalf("Close() sent requests after deadline: %#v", sent)
	}
}
