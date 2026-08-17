package agentruntime

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestCloseLocalProcessAttemptCanRetryAfterFailure(t *testing.T) {
	t.Parallel()

	exited := false
	attempts := 0
	killErr := errors.New("injected kill failure")
	waitDone := func(time.Duration) bool { return exited }
	closeInput := func() error { return nil }
	terminate := func() error { return nil }
	kill := func() error {
		attempts++
		if attempts == 1 {
			return killErr
		}
		exited = true
		return nil
	}

	if err := closeLocalProcessAttempt(waitDone, closeInput, terminate, kill); !errors.Is(err, killErr) {
		t.Fatalf("first close error = %v, want %v", err, killErr)
	}
	if err := closeLocalProcessAttempt(waitDone, closeInput, terminate, kill); err != nil {
		t.Fatalf("retry close: %v", err)
	}
	if attempts != 2 {
		t.Fatalf("kill attempts = %d, want 2", attempts)
	}
}

func TestLocalProcessConnectionCloseIsConcurrentAndIdempotentAfterExit(t *testing.T) {
	t.Parallel()

	done := make(chan struct{})
	close(done)
	connection := &localProcessConnection{
		done:    done,
		closing: make(chan struct{}),
	}

	const callers = 8
	errs := make(chan error, callers)
	var wg sync.WaitGroup
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- connection.Close()
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("Close: %v", err)
		}
	}
}
