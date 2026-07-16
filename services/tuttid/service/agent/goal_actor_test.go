package agent

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestGoalActorWaitObservesContextCancellation(t *testing.T) {
	service := &Service{}
	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- service.withGoalActor(context.Background(), "ws", "session", func(context.Context) error {
			close(entered)
			<-release
			return nil
		})
	}()
	<-entered
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := service.withGoalActor(ctx, "ws", "session", func(context.Context) error {
		t.Fatal("canceled waiter entered GoalActor")
		return nil
	}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("withGoalActor error = %v", err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
