package agent

import (
	"context"
	"strings"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

var _ agenthost.CommitObserver = (*ActivityProjection)(nil)

// ObserveCommitted is the one post-commit fanout for daemon-local views,
// analytics, provider ownership cleanup, and event-stream wakeups. Durable
// delivery never depends on this callback succeeding.
func (p *ActivityProjection) ObserveCommitted(ctx context.Context, delta agenthost.CommittedDelta) error {
	if p == nil {
		return nil
	}
	if committed := delta.ActivityState; committed != nil {
		p.publishPersistedTurnState(ctx, committed.Input, committed.Result)
		if committed.Result.State.Accepted {
			p.publishActivityUpdated(ctx, committed.Input.WorkspaceID, committed.Input.AgentSessionID,
				"session_reconcile_required", activitySessionUpdateEventPayload(
					committed.Input.WorkspaceID, committed.Input.AgentSessionID,
					committed.Result.State.LastEventUnixMS, committed.Result.State.Session.AgentTargetID,
				))
			if committed.Result.State.StateApplied {
				p.reportFailedRuntimeNodeResult(ctx, committed.Input)
			}
		}
		p.observeSessionState(ctx, committed.Input, committed.Reply)
	}
	if committed := delta.SessionMessages; committed != nil {
		p.publishCommittedMessages(ctx, committed.Input.WorkspaceID, committed.Input.AgentSessionID, committed.Result.Messages)
		p.observeSessionMessages(ctx, committed.Input, committed.Reply)
	}
	for _, settled := range delta.RootTurnsSettled {
		p.observeRootTurnSettled(ctx, settled.WorkspaceID, settled.AgentSessionID, settled.Turn)
	}
	if committed := delta.GoalOperation; committed != nil && committed.Stage == agenthost.GoalOperationPrepared && committed.Audit != nil {
		p.PublishGoalControlAudit(ctx, committed.Operation.WorkspaceID, committed.Operation.AgentSessionID, *committed.Audit)
	}
	if delta.ActivityState == nil && delta.SessionMessages == nil && delta.RuntimeOperation == nil && delta.GoalOperation == nil {
		for _, invalidated := range delta.ViewsInvalidated {
			if canonicalSessionDeleted(delta, invalidated) {
				p.publishActivityUpdated(ctx, invalidated.WorkspaceID, invalidated.AgentSessionID,
					"session_deleted", activitySessionDeletedEventPayload(invalidated.WorkspaceID, invalidated.AgentSessionID))
				continue
			}
			p.publishActivityUpdated(ctx, invalidated.WorkspaceID, invalidated.AgentSessionID,
				"session_reconcile_required", activitySessionUpdateEventPayload(
					invalidated.WorkspaceID, invalidated.AgentSessionID, committedSessionVersion(delta, invalidated),
				))
		}
	}
	for _, mutation := range delta.ProjectionDirty {
		if mutation.EntityKind != storesqlite.MutationEntityTurn || mutation.Operation != "settle" {
			continue
		}
		turn, found, err := p.repo.GetTurn(ctx, mutation.WorkspaceID, mutation.AgentSessionID, mutation.EntityID)
		if err != nil || !found {
			continue
		}
		p.publishActivityUpdated(ctx, mutation.WorkspaceID, mutation.AgentSessionID, "turn_update",
			activityTurnUpdateEventPayload(mutation.WorkspaceID, mutation.AgentSessionID, turn, time.Now().UnixMilli()))
	}
	return nil
}

func canonicalSessionDeleted(delta agenthost.CommittedDelta, invalidated agenthost.CanonicalViewInvalidated) bool {
	for _, mutation := range delta.ProjectionDirty {
		if mutation.WorkspaceID == invalidated.WorkspaceID && mutation.AgentSessionID == invalidated.AgentSessionID &&
			mutation.EntityKind == storesqlite.MutationEntitySession && mutation.Operation == "delete" {
			return true
		}
	}
	return false
}

func committedSessionVersion(delta agenthost.CommittedDelta, invalidated agenthost.CanonicalViewInvalidated) int64 {
	var version int64
	for _, mutation := range delta.ProjectionDirty {
		if mutation.WorkspaceID == invalidated.WorkspaceID && mutation.AgentSessionID == invalidated.AgentSessionID &&
			mutation.EntityKind == storesqlite.MutationEntitySession && mutation.Version > version {
			version = mutation.Version
		}
	}
	return version
}

func (p *ActivityProjection) publishCommittedMessages(ctx context.Context, workspaceID, fallbackSessionID string, messages []agentactivitybiz.Message) {
	if len(messages) == 0 {
		return
	}
	publishedAgentSessionID := canonicalMessageUpdateSessionID(fallbackSessionID, messages)
	for start := 0; start < len(messages); {
		if strings.TrimSpace(messages[start].Kind) == "session_audit" {
			p.publishActivityUpdated(ctx, workspaceID, publishedAgentSessionID, "session_audit", activitySessionAuditEventPayload(workspaceID, publishedAgentSessionID, messages[start]))
			start++
			continue
		}
		end := start + 1
		for end < len(messages) && strings.TrimSpace(messages[end].Kind) != "session_audit" {
			end++
		}
		run := messages[start:end]
		p.publishActivityUpdated(ctx, workspaceID, publishedAgentSessionID, "message_update", map[string]any{
			"acceptedCount": len(run), "agentSessionId": publishedAgentSessionID,
			"eventType": "message_update", "latestVersion": run[len(run)-1].Version,
			"messages": activityMessagesEventPayload(run), "workspaceId": strings.TrimSpace(workspaceID),
		})
		start = end
	}
}
