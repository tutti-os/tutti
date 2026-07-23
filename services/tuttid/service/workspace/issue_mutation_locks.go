package workspace

import "sync"

// IssueMutationLocks serializes local Issue task/run mutations. Runs settle
// through several concurrent paths — canonical Turn fan-out, the Agent CLI,
// reconciliation, and review automation — and each performs read-modify-write
// cycles over full rows. This registry reduces local conflicts; it is not a
// durable transaction boundary or a substitute for store-level CAS/atomic
// commands.
type IssueMutationLocks struct {
	mu    sync.Mutex
	locks map[string]*issueMutationLock
}

type issueMutationLock struct {
	mu   sync.Mutex
	refs int
}

func NewIssueMutationLocks() *IssueMutationLocks {
	return &IssueMutationLocks{locks: map[string]*issueMutationLock{}}
}

// Lock acquires the mutex for one workspace-scoped Issue and returns the
// release function. A nil receiver is a no-op so bare test services keep
// working without wiring.
func (l *IssueMutationLocks) Lock(workspaceID string, issueID string) func() {
	if l == nil {
		return func() {}
	}
	key := workspaceID + "/" + issueID
	l.mu.Lock()
	lock, ok := l.locks[key]
	if !ok {
		lock = &issueMutationLock{}
		l.locks[key] = lock
	}
	lock.refs++
	l.mu.Unlock()
	lock.mu.Lock()
	return func() {
		lock.mu.Unlock()
		l.mu.Lock()
		lock.refs--
		if lock.refs == 0 {
			delete(l.locks, key)
		}
		l.mu.Unlock()
	}
}
