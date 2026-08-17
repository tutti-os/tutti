package agent

import (
	"context"
	"strings"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

var _ agenthost.CommitObserver = (*ActivityProjection)(nil)

// ObserveCommitted is the one post-commit fanout for daemon-local views,
// analytics, provider ownership cleanup, and event-stream wakeups. Durable
// delivery never depends on this callback succeeding.
//
// It must not extract terminal failures: Host.notifyCommitted already observes
// the deltas it relays here, and observeCommittedOutsideHost observes the ones
// that never reach Host. Doing it here too would double-count every durable
// runtime and goal failure.
func (p *ActivityProjection) ObserveCommitted(ctx context.Context, delta agenthost.CommittedDelta) error {
	if p == nil {
		return nil
	}
	if committed := delta.ActivityState; committed != nil {
		provisional := activityStateIsProvisional(committed.Input)
		if !provisional {
			p.publishPersistedTurnState(ctx, committed.Input, committed.Result)
		}
		if committed.Result.State.Accepted && !provisional {
			if committed.Result.State.StateApplied {
				p.publishRuntimeActivityUpdate(ctx, committed.Input)
			}
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
		p.publishCommittedMessages(ctx, committed.Input, committed.Result.Messages)
		p.observeSessionMessages(ctx, committed.Input, committed.Reply)
	}
	for _, settled := range delta.RootTurnsSettled {
		p.reportRootTurnTerminalEvent(ctx, settled)
		if settled.StartupReconciled {
			// Startup reconciliation force-settles every turn left on disk.
			// Waking the Tutti-mode and automation observers for those would
			// resume chains the daemon restart already interrupted.
			continue
		}
		p.observeRootTurnSettled(ctx, settled.WorkspaceID, settled.AgentSessionID, settled.Turn)
	}
	if committed := delta.GoalOperation; committed != nil && committed.Stage == agenthost.GoalOperationPrepared && committed.Audit != nil {
		p.PublishGoalControlAudit(ctx, committed.Operation.WorkspaceID, committed.Operation.AgentSessionID, *committed.Audit)
	}
	// Bottom-up session reports attach GoalOperation on ActivityStateDelta but
	// NotifyCommitted only targets ActivityProjection. Forward those Goal
	// checkpoints to the Replay observer (Host GoalOperation path already
	// reaches it through the commit-observer relay).
	if delta.GoalOperation != nil && delta.ActivityState != nil {
		agenthost.NotifyCommitted(ctx, p.replayCommitObserver, delta)
	}
	if delta.ActivityState == nil && delta.SessionMessages == nil && delta.RuntimeOperation == nil && delta.GoalOperation == nil {
		for _, invalidated := range delta.ViewsInvalidated {
			if canonicalSessionDeleted(delta, invalidated) {
				p.publishActivityUpdated(ctx, invalidated.WorkspaceID, invalidated.AgentSessionID,
					"session_deleted", activitySessionDeletedEventPayload(invalidated.WorkspaceID, invalidated.AgentSessionID))
				continue
			}
			if canonicalSessionRestored(delta, invalidated) {
				p.publishActivityUpdated(ctx, invalidated.WorkspaceID, invalidated.AgentSessionID,
					"session_restored", activitySessionRestoredEventPayload(invalidated.WorkspaceID, invalidated.AgentSessionID))
				continue
			}
			p.publishActivityUpdated(ctx, invalidated.WorkspaceID, invalidated.AgentSessionID,
				"session_reconcile_required", activitySessionUpdateEventPayload(
					invalidated.WorkspaceID, invalidated.AgentSessionID, committedSessionVersion(delta, invalidated),
				))
		}
	}
	for _, mutation := range delta.ProjectionDirty {
		if mutation.EntityKind != agentactivitybiz.MutationEntityTurn || mutation.Operation != "settle" {
			continue
		}
		if session, found, err := p.repo.GetSession(ctx, mutation.WorkspaceID, mutation.AgentSessionID); err == nil && found && runtimeContextBool(session.InternalRuntimeContext, "provisional") {
			// Provisional provider rejection is durably settled only long enough
			// for Host compensation; never publish a hidden session's terminal
			// Turn update to AgentGUI.
			continue
		}
		turn, found, err := p.repo.GetTurn(ctx, mutation.WorkspaceID, mutation.AgentSessionID, mutation.EntityID)
		if err != nil || !found {
			continue
		}
		p.publishActivityUpdated(ctx, mutation.WorkspaceID, mutation.AgentSessionID, "turn_update",
			p.activityTurnUpdateEventPayload(ctx, mutation.WorkspaceID, mutation.AgentSessionID, turn, time.Now().UnixMilli()))
	}
	return nil
}

func (p *ActivityProjection) publishRuntimeActivityUpdate(ctx context.Context, input canonical.ReportSessionStateInput) {
	observation := input.State.RuntimeActivity
	if observation == nil {
		return
	}
	state := strings.ToLower(strings.TrimSpace(observation.State))
	if state != "running" && state != "idle" {
		return
	}
	if observation.OccurredAtUnixMS <= 0 {
		return
	}
	p.publishActivityUpdated(ctx, input.WorkspaceID, input.AgentSessionID, "runtime_activity_update", map[string]any{
		"workspaceId":      strings.TrimSpace(input.WorkspaceID),
		"agentSessionId":   strings.TrimSpace(input.AgentSessionID),
		"eventType":        "runtime_activity_update",
		"state":            state,
		"occurredAtUnixMs": observation.OccurredAtUnixMS,
	})
}

func activityStateIsProvisional(input canonical.ReportSessionStateInput) bool {
	return runtimeContextBool(input.State.RuntimeContext, "provisional")
}

func runtimeContextBool(runtimeContext map[string]any, key string) bool {
	value, _ := runtimeContext[key].(bool)
	return value
}

func canonicalSessionDeleted(delta agenthost.CommittedDelta, invalidated agenthost.CanonicalViewInvalidated) bool {
	return canonicalSessionMutationMatches(delta, invalidated, "delete")
}

func canonicalSessionRestored(delta agenthost.CommittedDelta, invalidated agenthost.CanonicalViewInvalidated) bool {
	return canonicalSessionMutationMatches(delta, invalidated, "restore")
}

func canonicalSessionMutationMatches(
	delta agenthost.CommittedDelta,
	invalidated agenthost.CanonicalViewInvalidated,
	operation string,
) bool {
	for _, mutation := range delta.ProjectionDirty {
		if mutation.WorkspaceID == invalidated.WorkspaceID && mutation.AgentSessionID == invalidated.AgentSessionID &&
			mutation.EntityKind == agentactivitybiz.MutationEntitySession && mutation.Operation == operation {
			return true
		}
	}
	return false
}

func committedSessionVersion(delta agenthost.CommittedDelta, invalidated agenthost.CanonicalViewInvalidated) int64 {
	var version int64
	for _, mutation := range delta.ProjectionDirty {
		if mutation.WorkspaceID == invalidated.WorkspaceID && mutation.AgentSessionID == invalidated.AgentSessionID &&
			mutation.EntityKind == agentactivitybiz.MutationEntitySession && mutation.Version > version {
			version = mutation.Version
		}
	}
	return version
}

func (p *ActivityProjection) publishCommittedMessages(
	ctx context.Context,
	input canonical.ReportSessionMessagesInput,
	messages []agentactivitybiz.Message,
) {
	messages = canonicalMessagesForRealtimePublish(input, messages)
	if len(messages) == 0 {
		return
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	publishedAgentSessionID := canonicalMessageUpdateSessionID(input.AgentSessionID, messages)
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

// canonicalMessagesForRealtimePublish removes only runtime messages whose
// nonterminal state was already emitted as an ordered message_delta. Storage
// remains authoritative and unchanged; terminal, session-level, imported, and
// otherwise non-runtime updates still publish full canonical snapshots.
func canonicalMessagesForRealtimePublish(
	input canonical.ReportSessionMessagesInput,
	messages []agentactivitybiz.Message,
) []agentactivitybiz.Message {
	if strings.TrimSpace(input.SessionOrigin) != agentsessionstore.WorkspaceAgentSessionOriginRuntime {
		return messages
	}
	filtered := make([]agentactivitybiz.Message, 0, len(messages))
	for _, message := range messages {
		if strings.TrimSpace(message.Kind) == "session_audit" ||
			strings.TrimSpace(message.TurnID) == "" ||
			(!isOptimisticRuntimeTextMessage(message) &&
				!isOptimisticRuntimeToolOutputMessage(message)) {
			filtered = append(filtered, message)
		}
	}
	return filtered
}

func isOptimisticRuntimeToolOutputMessage(message agentactivitybiz.Message) bool {
	if strings.TrimSpace(message.Kind) != "tool_call" {
		return false
	}
	switch strings.TrimSpace(message.Status) {
	case "running", "streaming":
	default:
		return false
	}
	output, _ := message.Payload["output"].(map[string]any)
	text, _ := output["text"].(string)
	// Running tool output is populated only by a provider adapter that also
	// attached the corresponding live toolOutput operation. Initial tool
	// anchors (no output) and all terminal snapshots retain canonical publish.
	return text != ""
}

func isOptimisticRuntimeTextMessage(message agentactivitybiz.Message) bool {
	switch strings.TrimSpace(message.Kind) {
	case "text", "reasoning":
	default:
		return false
	}
	if strings.TrimSpace(message.Status) != "streaming" {
		return false
	}
	contentMode, _ := message.Payload["contentMode"].(string)
	return strings.TrimSpace(contentMode) == "snapshot"
}
