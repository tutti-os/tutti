package agent

import (
	"context"
	"strings"
)

type serviceSessionSettingsLock struct {
	available chan struct{}
	refs      int
}

// acquireSessionSettingsLock serializes runtime resume with durable settings
// read-modify-write for one session. It intentionally does not span provider
// turn execution or unrelated metadata mutations.
func (s *Service) acquireSessionSettingsLock(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (func(), error) {
	key := strings.TrimSpace(workspaceID) + "\x00" + strings.TrimSpace(agentSessionID)
	s.sessionSettingsMu.Lock()
	if s.sessionSettingsLocks == nil {
		s.sessionSettingsLocks = make(map[string]*serviceSessionSettingsLock)
	}
	lock := s.sessionSettingsLocks[key]
	if lock == nil {
		lock = &serviceSessionSettingsLock{available: make(chan struct{}, 1)}
		lock.available <- struct{}{}
		s.sessionSettingsLocks[key] = lock
	}
	lock.refs++
	s.sessionSettingsMu.Unlock()

	select {
	case <-ctx.Done():
		s.releaseSessionSettingsLockRef(key, lock)
		return nil, ctx.Err()
	case <-lock.available:
	}
	if err := ctx.Err(); err != nil {
		lock.available <- struct{}{}
		s.releaseSessionSettingsLockRef(key, lock)
		return nil, err
	}
	return func() {
		lock.available <- struct{}{}
		s.releaseSessionSettingsLockRef(key, lock)
	}, nil
}

func (s *Service) releaseSessionSettingsLockRef(key string, lock *serviceSessionSettingsLock) {
	s.sessionSettingsMu.Lock()
	lock.refs--
	if lock.refs <= 0 && s.sessionSettingsLocks[key] == lock {
		delete(s.sessionSettingsLocks, key)
	}
	s.sessionSettingsMu.Unlock()
}
