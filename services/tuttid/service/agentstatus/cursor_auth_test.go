package agentstatus

import (
	"context"
	"testing"
	"time"
)

func TestCursorAuthStatusAttemptTimeout(t *testing.T) {
	want := authStatusCommandTimeout / cursorAuthStatusProbeCount
	if got := cursorAuthStatusAttemptTimeout(); got != want {
		t.Fatalf("cursorAuthStatusAttemptTimeout() = %s, want %s", got, want)
	}
}

func TestCursorAuthStatusAttemptContextsAreIndependent(t *testing.T) {
	parent, cancel := context.WithTimeout(context.Background(), authStatusCommandTimeout)
	defer cancel()

	ctx1, cancel1 := cursorAuthStatusAttemptContext(parent)
	deadline1, ok1 := ctx1.Deadline()
	cancel1()

	time.Sleep(20 * time.Millisecond)

	ctx2, cancel2 := cursorAuthStatusAttemptContext(parent)
	deadline2, ok2 := ctx2.Deadline()
	cancel2()

	if !ok1 || !ok2 {
		t.Fatalf("expected attempt deadlines: ok1=%v ok2=%v", ok1, ok2)
	}
	if !deadline2.After(deadline1) {
		t.Fatalf("second attempt deadline %v should be after first %v", deadline2, deadline1)
	}

	remaining := time.Until(deadline2)
	wantRemaining := cursorAuthStatusAttemptTimeout()
	if remaining < wantRemaining-50*time.Millisecond || remaining > wantRemaining+50*time.Millisecond {
		t.Fatalf("second attempt remaining %s, want ~%s", remaining, wantRemaining)
	}
}
