package agent

import (
	"context"
	"strings"
	"time"
)

type goalActorEntry struct {
	gate chan struct{}
	refs int
}

func (s *Service) withGoalActor(ctx context.Context, workspaceID, agentSessionID string, fn func(context.Context) error) error {
	key := strings.TrimSpace(workspaceID) + "\x00" + strings.TrimSpace(agentSessionID)
	s.goalActorsMu.Lock()
	if s.goalActors == nil {
		s.goalActors = make(map[string]*goalActorEntry)
	}
	entry := s.goalActors[key]
	if entry == nil {
		entry = &goalActorEntry{gate: make(chan struct{}, 1)}
		entry.gate <- struct{}{}
		s.goalActors[key] = entry
	}
	entry.refs++
	s.goalActorsMu.Unlock()

	select {
	case <-ctx.Done():
		s.releaseGoalActorReference(key, entry)
		return ctx.Err()
	case <-entry.gate:
	}
	if err := ctx.Err(); err != nil {
		entry.gate <- struct{}{}
		s.releaseGoalActorReference(key, entry)
		return err
	}
	err := fn(ctx)
	entry.gate <- struct{}{}
	s.releaseGoalActorReference(key, entry)
	return err
}

func (s *Service) releaseGoalActorReference(key string, entry *goalActorEntry) {
	s.goalActorsMu.Lock()
	entry.refs--
	if entry.refs == 0 && s.goalActors[key] == entry {
		delete(s.goalActors, key)
	}
	s.goalActorsMu.Unlock()
}

func (s *Service) goalOperationNow() time.Time {
	if s.GoalOperationClock != nil {
		return s.GoalOperationClock().UTC()
	}
	return time.Now().UTC()
}

func goalPersistenceContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 10*time.Second)
}
