package agenthost

import (
	"context"
	"strings"
	"sync"
)

type sessionActorEntry struct {
	gate chan struct{}
	refs int
}

// SessionActor serializes mutations for one canonical session. An adapter
// that constructs short-lived Host values must share actor instances across
// those Host values for every mutation lane it configures.
type SessionActor struct {
	mu      sync.Mutex
	entries map[string]*sessionActorEntry
}

func NewSessionActor() *SessionActor {
	return &SessionActor{entries: make(map[string]*sessionActorEntry)}
}

func (a *SessionActor) Do(ctx context.Context, ref SessionRef, fn func(context.Context) error) error {
	if a == nil || strings.TrimSpace(ref.WorkspaceID) == "" || strings.TrimSpace(ref.AgentSessionID) == "" || fn == nil {
		return ErrInvalidArgument
	}
	key := strings.TrimSpace(ref.WorkspaceID) + "\x00" + strings.TrimSpace(ref.AgentSessionID)
	a.mu.Lock()
	entry := a.entries[key]
	if entry == nil {
		entry = &sessionActorEntry{gate: make(chan struct{}, 1)}
		entry.gate <- struct{}{}
		a.entries[key] = entry
	}
	entry.refs++
	a.mu.Unlock()

	select {
	case <-ctx.Done():
		a.releaseReference(key, entry)
		return ctx.Err()
	case <-entry.gate:
	}
	if err := ctx.Err(); err != nil {
		entry.gate <- struct{}{}
		a.releaseReference(key, entry)
		return err
	}
	err := fn(ctx)
	entry.gate <- struct{}{}
	a.releaseReference(key, entry)
	return err
}

func (a *SessionActor) releaseReference(key string, entry *sessionActorEntry) {
	a.mu.Lock()
	entry.refs--
	if entry.refs == 0 && a.entries[key] == entry {
		delete(a.entries, key)
	}
	a.mu.Unlock()
}

func (h *Host) withSessionMutationActor(ctx context.Context, workspaceID, agentSessionID string, fn func(context.Context) error) error {
	if h == nil || h.sessionMutationActor == nil {
		return ErrInvalidArgument
	}
	return h.sessionMutationActor.Do(ctx, SessionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID}, fn)
}

func (h *Host) withSessionMutationActors(ctx context.Context, workspaceID string, agentSessionIDs []string, fn func(context.Context) error) error {
	if len(agentSessionIDs) == 0 {
		return fn(ctx)
	}
	return h.withSessionMutationActor(ctx, workspaceID, agentSessionIDs[0], func(actorCtx context.Context) error {
		return h.withSessionMutationActors(actorCtx, workspaceID, agentSessionIDs[1:], fn)
	})
}
