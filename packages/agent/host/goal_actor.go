package agenthost

import (
	"context"
	"time"
)

func (h *Host) withGoalActor(ctx context.Context, workspaceID, agentSessionID string, fn func(context.Context) error) error {
	return h.goalActor.Do(ctx, SessionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID}, fn)
}

func (h *Host) goalOperationNow() time.Time {
	if h != nil && h.goalClock != nil {
		return h.goalClock.Now().UTC()
	}
	return time.Now().UTC()
}

func goalPersistenceContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 10*time.Second)
}
