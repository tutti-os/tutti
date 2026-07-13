package agentsessionstore

import (
	"context"
	"errors"
	"net"
	"sync"
	"testing"
	"time"
)

func newBackoffTestFixture(t *testing.T, opts ...Option) (*Store, *sessionSyncer, *backoffTestRepository, *time.Time) {
	t.Helper()
	client := &backoffTestRepository{
		snapshot: &WorkspaceAgentSnapshot{
			Sessions: []ProviderActivitySessionProjection{{
				AgentSessionID:  "session-1",
				SessionOrigin:   WorkspaceAgentSessionOriginRuntime,
				LifecycleStatus: "active",
				EffectiveStatus: "working",
			}},
		},
	}
	svc := New(client, opts...)
	svc.TrackRoom("room-1")
	syncer := newSessionSyncer(svc, client)
	current := time.UnixMilli(1_710_000_000_000)
	syncer.now = func() time.Time { return current }
	return svc, syncer, client, &current
}

func TestSyncBackoffSkipsMessageSyncUntilWindowElapses(t *testing.T) {
	_, syncer, client, current := newBackoffTestFixture(t, WithSyncBackoff(DefaultSyncBackoffConfig()))
	client.setMessageError(HTTPError{StatusCode: 500})

	syncer.syncRoom(context.Background(), "room-1")
	if got := client.messageCallCount(); got != 1 {
		t.Fatalf("message calls after first failure = %d, want 1", got)
	}

	syncer.syncRoom(context.Background(), "room-1")
	if got := client.messageCallCount(); got != 1 {
		t.Fatalf("message calls within backoff window = %d, want still 1", got)
	}

	*current = current.Add(10 * time.Second)
	syncer.syncRoom(context.Background(), "room-1")
	if got := client.messageCallCount(); got != 2 {
		t.Fatalf("message calls after initial delay elapsed = %d, want 2", got)
	}

	// The second consecutive failure doubles the delay to 20s.
	*current = current.Add(19 * time.Second)
	syncer.syncRoom(context.Background(), "room-1")
	if got := client.messageCallCount(); got != 2 {
		t.Fatalf("message calls before doubled delay elapsed = %d, want still 2", got)
	}
	*current = current.Add(time.Second)
	syncer.syncRoom(context.Background(), "room-1")
	if got := client.messageCallCount(); got != 3 {
		t.Fatalf("message calls after doubled delay elapsed = %d, want 3", got)
	}
}

func TestSyncBackoffDisabledByDefaultRetriesEveryTick(t *testing.T) {
	_, syncer, client, _ := newBackoffTestFixture(t)
	client.setMessageError(HTTPError{StatusCode: 500})

	syncer.syncRoom(context.Background(), "room-1")
	syncer.syncRoom(context.Background(), "room-1")
	if got := client.messageCallCount(); got != 2 {
		t.Fatalf("message calls without backoff = %d, want 2", got)
	}
}

func TestSyncBackoffIgnoresNonRetryableErrors(t *testing.T) {
	_, syncer, client, _ := newBackoffTestFixture(t, WithSyncBackoff(DefaultSyncBackoffConfig()))
	client.setMessageError(HTTPError{StatusCode: 404})

	syncer.syncRoom(context.Background(), "room-1")
	syncer.syncRoom(context.Background(), "room-1")
	if got := client.messageCallCount(); got != 2 {
		t.Fatalf("message calls with non-retryable error = %d, want 2", got)
	}
}

func TestSyncBackoffAppliesToTransportErrors(t *testing.T) {
	_, syncer, client, _ := newBackoffTestFixture(t, WithSyncBackoff(DefaultSyncBackoffConfig()))
	client.setMessageError(&net.OpError{Op: "dial", Err: errors.New("connection refused")})

	syncer.syncRoom(context.Background(), "room-1")
	syncer.syncRoom(context.Background(), "room-1")
	if got := client.messageCallCount(); got != 1 {
		t.Fatalf("message calls with transport error = %d, want 1 (backed off)", got)
	}
}

func TestSyncBackoffIgnoresContextCancellation(t *testing.T) {
	_, syncer, client, _ := newBackoffTestFixture(t, WithSyncBackoff(DefaultSyncBackoffConfig()))
	client.setMessageError(context.Canceled)

	syncer.syncRoom(context.Background(), "room-1")
	syncer.syncRoom(context.Background(), "room-1")
	if got := client.messageCallCount(); got != 2 {
		t.Fatalf("message calls with canceled context = %d, want 2 (no backoff)", got)
	}
}

func TestSyncBackoffResetsAfterSuccess(t *testing.T) {
	_, syncer, client, current := newBackoffTestFixture(t, WithSyncBackoff(DefaultSyncBackoffConfig()))
	client.setMessageError(HTTPError{StatusCode: 500})

	syncer.syncRoom(context.Background(), "room-1")
	*current = current.Add(10 * time.Second)
	client.setMessageError(nil)
	syncer.syncRoom(context.Background(), "room-1")
	if got := client.messageCallCount(); got != 2 {
		t.Fatalf("message calls after recovery = %d, want 2", got)
	}

	// A fresh failure after success starts over at the initial delay instead
	// of continuing the previous doubling.
	client.setMessageError(HTTPError{StatusCode: 500})
	syncer.syncRoom(context.Background(), "room-1")
	if got := client.messageCallCount(); got != 3 {
		t.Fatalf("message calls on fresh failure = %d, want 3", got)
	}
	*current = current.Add(10 * time.Second)
	syncer.syncRoom(context.Background(), "room-1")
	if got := client.messageCallCount(); got != 4 {
		t.Fatalf("message calls after reset initial delay = %d, want 4", got)
	}
}

func TestSyncBackoffCapsDelayAtMax(t *testing.T) {
	cfg := SyncBackoffConfig{InitialDelay: 10 * time.Second, MaxDelay: 15 * time.Second, Multiplier: 2.0}
	if got := cfg.nextDelay(10 * time.Second); got != 15*time.Second {
		t.Fatalf("nextDelay(10s) = %s, want capped 15s", got)
	}
	if got := cfg.nextDelay(0); got != 10*time.Second {
		t.Fatalf("nextDelay(0) = %s, want initial 10s", got)
	}
}

type backoffTestRepository struct {
	mu           sync.Mutex
	snapshot     *WorkspaceAgentSnapshot
	messageErr   error
	messageCalls int
}

func (r *backoffTestRepository) ListAgents(_ context.Context, _ string) (*WorkspaceAgentSnapshot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.snapshot, nil
}

func (r *backoffTestRepository) ListSessionMessages(
	_ context.Context,
	_ ListSessionMessagesInput,
) (*ListSessionMessagesReply, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.messageCalls++
	if r.messageErr != nil {
		return nil, r.messageErr
	}
	return &ListSessionMessagesReply{}, nil
}

func (r *backoffTestRepository) setMessageError(err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.messageErr = err
}

func (r *backoffTestRepository) messageCallCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.messageCalls
}
