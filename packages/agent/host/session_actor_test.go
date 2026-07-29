package agenthost

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func TestSessionActorWaitObservesContextCancellation(t *testing.T) {
	actor := NewSessionActor()
	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	ref := SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	go func() {
		done <- actor.Do(context.Background(), ref, func(context.Context) error {
			close(entered)
			<-release
			return nil
		})
	}()
	<-entered
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := actor.Do(ctx, ref, func(context.Context) error {
		t.Fatal("canceled waiter entered SessionActor")
		return nil
	}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("SessionActor.Do() error = %v", err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestSendInputRechecksHistoryFenceAfterWaitingForSessionActor(t *testing.T) {
	history := &mutableEffectiveHistory{history: storesqlite.SessionHistory{
		RecoveryState: storesqlite.SessionHistoryRecoveryReady,
	}}
	host := New(Config{
		CanonicalStore:   actorFenceCanonicalStore{},
		Runtime:          actorFenceRuntime{},
		EffectiveHistory: history,
	})
	ref := SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	entered := make(chan struct{})
	release := make(chan struct{})
	actorDone := make(chan error, 1)
	go func() {
		actorDone <- host.withSessionMutationActor(context.Background(), ref.WorkspaceID, ref.AgentSessionID, func(context.Context) error {
			close(entered)
			<-release
			return nil
		})
	}()
	<-entered
	sendDone := make(chan error, 1)
	go func() {
		_, err := host.SendInput(context.Background(), ref, SendInput{
			Content: []PromptContentBlock{{Type: "text", Text: "ordinary send"}},
		})
		sendDone <- err
	}()
	select {
	case err := <-sendDone:
		t.Fatalf("SendInput bypassed SessionActor: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	history.setRecoveryState(storesqlite.SessionHistoryRecoveryRollbackPending)
	close(release)
	if err := <-actorDone; err != nil {
		t.Fatal(err)
	}
	if err := <-sendDone; !errors.Is(err, ErrEditRetryInProgress) {
		t.Fatalf("SendInput after history fence error = %v, want ErrEditRetryInProgress", err)
	}
}

type actorFenceCanonicalStore struct{ CanonicalStore }

type actorFenceRuntime struct{ RuntimeController }

type mutableEffectiveHistory struct {
	EffectiveHistoryStore
	mu      sync.Mutex
	history storesqlite.SessionHistory
}

func (s *mutableEffectiveHistory) GetSessionHistory(context.Context, string, string) (storesqlite.SessionHistory, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.history, true, nil
}

func (s *mutableEffectiveHistory) setRecoveryState(state string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.history.RecoveryState = state
}
