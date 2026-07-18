package workspace

import "sync"

// IssueMutationLocks serializes Issue task/run mutations per Issue. Runs settle
// through several concurrent paths — the canonical turn fan-out, the agent CLI
// (`issue run complete`), the fallback reconciler, and the automation review
// outcome — and each path performs read-modify-write cycles over full task
// rows. Without one writer at a time per Issue, those cycles interleave into
// contradictory durable states (observed in the wild: a task stuck at
// pending_acceptance with acceptance user_accepted, wedging the frontier).
type IssueMutationLocks struct {
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

func NewIssueMutationLocks() *IssueMutationLocks {
	return &IssueMutationLocks{locks: map[string]*sync.Mutex{}}
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
		lock = &sync.Mutex{}
		l.locks[key] = lock
	}
	l.mu.Unlock()
	lock.Lock()
	return lock.Unlock
}
