package agenthost

import (
	"context"
	"errors"
	"testing"
	"time"
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
