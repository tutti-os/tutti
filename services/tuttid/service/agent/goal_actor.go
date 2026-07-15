package agent

import (
	"context"
	"strings"
	"sync"
	"time"
)

type goalActorEntry struct {
	mu   sync.Mutex
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
		entry = &goalActorEntry{}
		s.goalActors[key] = entry
	}
	entry.refs++
	s.goalActorsMu.Unlock()

	entry.mu.Lock()
	err := fn(ctx)
	entry.mu.Unlock()

	s.goalActorsMu.Lock()
	entry.refs--
	if entry.refs == 0 {
		delete(s.goalActors, key)
	}
	s.goalActorsMu.Unlock()
	return err
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
