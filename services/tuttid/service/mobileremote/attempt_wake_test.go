package mobileremote

import (
	"context"
	"testing"
	"time"
)

func TestAttemptWakeDeliversOnlyAfterTheObservedVersion(t *testing.T) {
	wake := NewAttemptWake()
	version := wake.Version("attempt-1")
	result := make(chan bool, 1)
	go func() { result <- wake.Wait(context.Background(), "attempt-1", version) }()

	wake.Notify("attempt-1")
	select {
	case notified := <-result:
		if !notified {
			t.Fatal("Wait returned false after a notification")
		}
	case <-time.After(time.Second):
		t.Fatal("Wait did not receive the notification")
	}
}

func TestAttemptWakeDoesNotBlockWhenNotificationPrecedesWait(t *testing.T) {
	wake := NewAttemptWake()
	wake.Notify("attempt-1")
	if !wake.Wait(context.Background(), "attempt-1", 0) {
		t.Fatal("Wait missed an already-recorded notification")
	}
}

func TestAttemptWakeForgetRemovesRetainedVersion(t *testing.T) {
	wake := NewAttemptWake()
	wake.Notify("attempt-1")
	wake.Forget("attempt-1")
	if got := wake.Version("attempt-1"); got != 0 {
		t.Fatalf("forgotten attempt version = %d, want 0", got)
	}
}

func TestAttemptWakeCanBeCancelled(t *testing.T) {
	wake := NewAttemptWake()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if wake.Wait(ctx, "attempt-1", 0) {
		t.Fatal("Wait returned true without a notification")
	}
}
