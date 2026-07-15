package agent

import (
	"strings"
	"sync"
)

type serviceSessionSettingsLock struct {
	mu   sync.Mutex
	refs int
}

// acquireSessionSettingsLock serializes runtime resume with durable settings
// read-modify-write for one session. It intentionally does not span provider
// turn execution or unrelated metadata mutations.
func (s *Service) acquireSessionSettingsLock(workspaceID string, agentSessionID string) func() {
	key := strings.TrimSpace(workspaceID) + "\x00" + strings.TrimSpace(agentSessionID)
	s.sessionSettingsMu.Lock()
	if s.sessionSettingsLocks == nil {
		s.sessionSettingsLocks = make(map[string]*serviceSessionSettingsLock)
	}
	lock := s.sessionSettingsLocks[key]
	if lock == nil {
		lock = &serviceSessionSettingsLock{}
		s.sessionSettingsLocks[key] = lock
	}
	lock.refs++
	s.sessionSettingsMu.Unlock()

	lock.mu.Lock()
	return func() {
		lock.mu.Unlock()
		s.sessionSettingsMu.Lock()
		lock.refs--
		if lock.refs <= 0 && s.sessionSettingsLocks[key] == lock {
			delete(s.sessionSettingsLocks, key)
		}
		s.sessionSettingsMu.Unlock()
	}
}
