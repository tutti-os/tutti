package agentextension

import "sync"

type runtimeInstallLock struct {
	mu   sync.Mutex
	refs int
}

// lockRuntimeInstall prevents the background reconciler and an explicit setup
// action from replacing the same managed Runtime concurrently. Different
// Runtime identities may still install in parallel.
func (s *SetupService) lockRuntimeInstall(key string) func() {
	s.runtimeInstallLocksMu.Lock()
	if s.runtimeInstallLocks == nil {
		s.runtimeInstallLocks = map[string]*runtimeInstallLock{}
	}
	lock := s.runtimeInstallLocks[key]
	if lock == nil {
		lock = &runtimeInstallLock{}
		s.runtimeInstallLocks[key] = lock
	}
	lock.refs++
	s.runtimeInstallLocksMu.Unlock()

	lock.mu.Lock()
	return func() {
		lock.mu.Unlock()
		s.runtimeInstallLocksMu.Lock()
		lock.refs--
		if lock.refs == 0 && s.runtimeInstallLocks[key] == lock {
			delete(s.runtimeInstallLocks, key)
		}
		s.runtimeInstallLocksMu.Unlock()
	}
}
