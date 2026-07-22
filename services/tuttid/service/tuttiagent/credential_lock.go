package tuttiagent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/gofrs/flock"
)

const tuttiAgentCredentialLockRetryDelay = 25 * time.Millisecond

func withTuttiAgentCredentialLock(ctx context.Context, authPath string, action func() error) error {
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		return fmt.Errorf("create tutti-agent auth directory: %w", err)
	}
	lock := flock.New(authPath + ".refresh.lock")
	locked, err := lock.TryLockContext(ctx, tuttiAgentCredentialLockRetryDelay)
	if err != nil {
		return fmt.Errorf("lock tutti-agent credentials: %w", err)
	}
	if !locked {
		if cause := context.Cause(ctx); cause != nil {
			return fmt.Errorf("lock tutti-agent credentials: %w", cause)
		}
		return errors.New("lock tutti-agent credentials: lock was not acquired")
	}
	defer func() { _ = lock.Unlock() }()
	return action()
}
