package agentruntime

import (
	"context"
	"sync"
	"testing"
	"time"
)

func startupModelsTestSession(adapter *CodexAppServerAdapter) Session {
	session := testAppServerSession()
	adapter.mu.Lock()
	adapter.sessions[session.AgentSessionID] = &codexAppServerSession{}
	adapter.mu.Unlock()
	return session
}

func startupModelsReadyFlag(adapter *CodexAppServerAdapter, agentSessionID string) bool {
	adapter.mu.Lock()
	defer adapter.mu.Unlock()
	if appSession := adapter.sessions[agentSessionID]; appSession != nil {
		return appSession.startupModelsReady
	}
	return false
}

// A single transient empty/slow model/list response must not pin the session at
// "loading" forever: the adapter keeps retrying in the background until codex
// returns a non-empty list, then resolves the startup state.
func TestRetryStartupModelsResolvesAfterTransientEmpty(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAppServerAdapter(newScriptedAppServerTransport())
	adapter.startupModelRetryBackoffs = []time.Duration{0, 0, 0, 0}
	session := startupModelsTestSession(adapter)

	calls := 0
	fetch := func(context.Context) []map[string]any {
		calls++
		if calls < 3 {
			return nil
		}
		return []map[string]any{{"id": "gpt-5.3-codex", "displayName": "GPT-5.3 Codex"}}
	}
	resolved := adapter.retryStartupModels(
		context.Background(),
		session.AgentSessionID,
		session,
		nil,
		fetch,
		func(context.Context, time.Duration) bool { return true },
	)

	if !resolved {
		t.Fatalf("retryStartupModels = false, want true once codex returns models")
	}
	if calls != 3 {
		t.Fatalf("fetch calls = %d, want 3 (two empty, one populated)", calls)
	}
	if !startupModelsReadyFlag(adapter, session.AgentSessionID) {
		t.Fatalf("startupModelsReady = false, want true after models resolved")
	}
}

// When the model/list response stays empty, the retry must be bounded: it gives
// up after the configured budget instead of looping forever.
func TestRetryStartupModelsGivesUpAfterBudget(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAppServerAdapter(newScriptedAppServerTransport())
	// len(backoffs) sleeps => len(backoffs)+1 attempts.
	adapter.startupModelRetryBackoffs = []time.Duration{0, 0}
	session := startupModelsTestSession(adapter)

	calls := 0
	fetch := func(context.Context) []map[string]any {
		calls++
		return nil
	}
	resolved := adapter.retryStartupModels(
		context.Background(),
		session.AgentSessionID,
		session,
		nil,
		fetch,
		func(context.Context, time.Duration) bool { return true },
	)

	if resolved {
		t.Fatalf("retryStartupModels = true, want false when models never arrive")
	}
	if calls != 3 {
		t.Fatalf("fetch calls = %d, want 3 (initial + 2 retries)", calls)
	}
	if startupModelsReadyFlag(adapter, session.AgentSessionID) {
		t.Fatalf("startupModelsReady = true, want false after giving up")
	}
}

// The retry loop must stop as soon as the session is torn down so the
// background goroutine cannot outlive its session.
func TestRetryStartupModelsStopsWhenSessionRemoved(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAppServerAdapter(newScriptedAppServerTransport())
	adapter.startupModelRetryBackoffs = []time.Duration{0, 0, 0, 0, 0, 0}
	session := startupModelsTestSession(adapter)

	var once sync.Once
	calls := 0
	fetch := func(context.Context) []map[string]any {
		calls++
		return nil
	}
	sleep := func(context.Context, time.Duration) bool {
		once.Do(func() {
			adapter.mu.Lock()
			delete(adapter.sessions, session.AgentSessionID)
			adapter.mu.Unlock()
		})
		return true
	}
	resolved := adapter.retryStartupModels(
		context.Background(),
		session.AgentSessionID,
		session,
		nil,
		fetch,
		sleep,
	)

	if resolved {
		t.Fatalf("retryStartupModels = true, want false after session removed")
	}
	if calls != 1 {
		t.Fatalf("fetch calls = %d, want 1 before the session was removed", calls)
	}
}

// A canceled context aborts the retry loop instead of consuming the full budget.
func TestRetryStartupModelsStopsWhenContextCanceled(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAppServerAdapter(newScriptedAppServerTransport())
	adapter.startupModelRetryBackoffs = []time.Duration{0, 0, 0, 0}
	session := startupModelsTestSession(adapter)

	calls := 0
	fetch := func(context.Context) []map[string]any {
		calls++
		return nil
	}
	resolved := adapter.retryStartupModels(
		context.Background(),
		session.AgentSessionID,
		session,
		nil,
		fetch,
		func(context.Context, time.Duration) bool { return false },
	)

	if resolved {
		t.Fatalf("retryStartupModels = true, want false when the loop is aborted")
	}
	if calls != 1 {
		t.Fatalf("fetch calls = %d, want 1 before the abort", calls)
	}
}
