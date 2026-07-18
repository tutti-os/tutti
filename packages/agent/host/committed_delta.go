package agenthost

import (
	"context"
	"log/slog"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	canonical "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

type ActivityStateCommitted struct {
	Input  canonical.ReportSessionStateInput
	Reply  canonical.ReportSessionStateReply
	Result storesqlite.ActivityStateReportResult
}

type SessionMessagesCommitted struct {
	Input  canonical.ReportSessionMessagesInput
	Reply  canonical.ReportSessionMessagesReply
	Result storesqlite.MessageReportResult
}

type RootTurnSettled struct {
	WorkspaceID    string
	AgentSessionID string
	Turn           storesqlite.Turn
}

type RuntimeOperationCommitStage string

const (
	RuntimeOperationPrepared   RuntimeOperationCommitStage = "prepared"
	RuntimeOperationCheckpoint RuntimeOperationCommitStage = "checkpointed"
	RuntimeOperationCompleted  RuntimeOperationCommitStage = "completed"
	RuntimeOperationReleased   RuntimeOperationCommitStage = "released"
	RuntimeOperationFailed     RuntimeOperationCommitStage = "failed"
)

type RuntimeOperationCommitted struct {
	Stage     RuntimeOperationCommitStage
	Operation storesqlite.RuntimeOperation
	Event     *storesqlite.RuntimeOperationEvent
}

type GoalOperationCommitStage string

const (
	GoalOperationPrepared       GoalOperationCommitStage = "prepared"
	GoalOperationDispatched     GoalOperationCommitStage = "dispatched"
	GoalOperationAcknowledged   GoalOperationCommitStage = "acknowledged"
	GoalOperationCompleted      GoalOperationCommitStage = "completed"
	GoalOperationReleased       GoalOperationCommitStage = "released"
	GoalOperationFailed         GoalOperationCommitStage = "failed"
	GoalOperationEvidence       GoalOperationCommitStage = "evidence"
	GoalOperationReconciled     GoalOperationCommitStage = "reconciled"
	GoalOperationRepairPrepared GoalOperationCommitStage = "repair_prepared"
	GoalOperationTerminal       GoalOperationCommitStage = "terminal"
)

type GoalOperationCommitted struct {
	Stage     GoalOperationCommitStage
	Operation storesqlite.GoalControlOperation
	State     storesqlite.SessionGoalState
	Audit     *storesqlite.Message
}

type CanonicalProjectionDirty struct {
	WorkspaceID    string
	AgentSessionID string
	MutationID     string
	EntityKind     string
	EntityID       string
	Operation      string
	Version        int64
}

type CanonicalViewInvalidated struct {
	WorkspaceID    string
	AgentSessionID string
}

// CommittedDelta describes facts that have already committed. ProjectionDirty
// is a wake hint for a durable outbox marker written by a transaction
// participant; it is never the durable marker itself.
type CommittedDelta struct {
	TransactionID    string
	ActivityState    *ActivityStateCommitted
	SessionMessages  *SessionMessagesCommitted
	RootTurnsSettled []RootTurnSettled
	RuntimeOperation *RuntimeOperationCommitted
	GoalOperation    *GoalOperationCommitted
	ProjectionDirty  []CanonicalProjectionDirty
	ViewsInvalidated []CanonicalViewInvalidated
}

func ActivityStateDelta(input canonical.ReportSessionStateInput, reply canonical.ReportSessionStateReply, result storesqlite.ActivityStateReportResult) CommittedDelta {
	delta := committedDeltaFromMutations(result.TransactionID, result.CommitDelta.Mutations)
	delta.ActivityState = &ActivityStateCommitted{Input: input, Reply: reply, Result: result}
	if result.RootTurnAccepted && result.RootTurn.Phase == storesqlite.TurnPhaseSettled {
		delta.RootTurnsSettled = append(delta.RootTurnsSettled, RootTurnSettled{
			WorkspaceID: result.RootTurn.WorkspaceID, AgentSessionID: result.RootTurn.AgentSessionID, Turn: result.RootTurn,
		})
	}
	delta.addView(input.WorkspaceID, input.AgentSessionID)
	if result.RootTurnAccepted {
		delta.addView(input.WorkspaceID, result.RootTurn.AgentSessionID)
	}
	return delta
}

func SessionMessagesDelta(input canonical.ReportSessionMessagesInput, reply canonical.ReportSessionMessagesReply, result storesqlite.MessageReportResult) CommittedDelta {
	delta := committedDeltaFromMutations(result.TransactionID, result.CommitDelta.Mutations)
	delta.SessionMessages = &SessionMessagesCommitted{Input: input, Reply: reply, Result: result}
	delta.addView(input.WorkspaceID, canonicalMessageSessionID(input.AgentSessionID, result.Messages))
	return delta
}

func StaleTurnSettlementDelta(settlements []storesqlite.StaleTurnSettlement) CommittedDelta {
	delta := CommittedDelta{}
	if len(settlements) > 0 {
		delta = committedDeltaFromMutations(settlements[0].TransactionID, settlements[0].CommitDelta.Mutations)
	}
	for _, settlement := range settlements {
		delta.addView(settlement.WorkspaceID, settlement.AgentSessionID)
	}
	return delta
}

// CanonicalDelta exposes a post-commit canonical mutation without inventing a
// command-specific Host event. Adapters use its projection-dirty identities
// and view invalidations as wake hints only.
func CanonicalDelta(commit storesqlite.TransactionDelta) CommittedDelta {
	return committedDeltaFromMutations(commit.TransactionID, commit.Mutations)
}

func runtimeOperationDelta(stage RuntimeOperationCommitStage, operation storesqlite.RuntimeOperation, event *storesqlite.RuntimeOperationEvent) CommittedDelta {
	delta := committedDeltaFromMutations(operation.CommitTransactionID, operation.CommitDelta.Mutations)
	delta.RuntimeOperation = &RuntimeOperationCommitted{Stage: stage, Operation: operation, Event: event}
	return delta
}

func goalOperationDelta(stage GoalOperationCommitStage, operation storesqlite.GoalControlOperation, state storesqlite.SessionGoalState, audit *storesqlite.Message) CommittedDelta {
	transactionID := operation.CommitTransactionID
	mutations := operation.CommitDelta.Mutations
	if transactionID == "" {
		transactionID = state.CommitTransactionID
		mutations = state.CommitDelta.Mutations
	}
	delta := committedDeltaFromMutations(transactionID, mutations)
	delta.GoalOperation = &GoalOperationCommitted{Stage: stage, Operation: operation, State: state, Audit: audit}
	delta.addView(operation.WorkspaceID, operation.AgentSessionID)
	if operation.AgentSessionID == "" {
		delta.addView(state.WorkspaceID, state.AgentSessionID)
	}
	return delta
}

func committedDeltaFromMutations(transactionID string, mutations []storesqlite.TransactionMutation) CommittedDelta {
	delta := CommittedDelta{TransactionID: strings.TrimSpace(transactionID)}
	for _, mutation := range mutations {
		delta.ProjectionDirty = append(delta.ProjectionDirty, CanonicalProjectionDirty{
			WorkspaceID: mutation.WorkspaceID, AgentSessionID: mutation.AgentSessionID,
			MutationID: mutation.MutationID, EntityKind: mutation.EntityKind, EntityID: mutation.EntityID,
			Operation: mutation.Operation, Version: mutation.Version,
		})
		delta.addView(mutation.WorkspaceID, mutation.AgentSessionID)
	}
	return delta
}

func (delta *CommittedDelta) addView(workspaceID, agentSessionID string) {
	workspaceID, agentSessionID = strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return
	}
	for _, existing := range delta.ViewsInvalidated {
		if existing.WorkspaceID == workspaceID && existing.AgentSessionID == agentSessionID {
			return
		}
	}
	delta.ViewsInvalidated = append(delta.ViewsInvalidated, CanonicalViewInvalidated{WorkspaceID: workspaceID, AgentSessionID: agentSessionID})
}

func canonicalMessageSessionID(fallback string, messages []storesqlite.Message) string {
	for _, message := range messages {
		if value := strings.TrimSpace(message.AgentSessionID); value != "" {
			return value
		}
	}
	return strings.TrimSpace(fallback)
}

// NotifyCommitted deliberately swallows observer failures after logging: the
// canonical transaction is already committed, and reliable delivery must come
// from the durable participant outbox rather than rollback or command failure.
func NotifyCommitted(ctx context.Context, observer CommitObserver, delta CommittedDelta) {
	if observer == nil {
		return
	}
	if err := observer.ObserveCommitted(ctx, delta); err != nil {
		slog.Warn("agent host commit observer failed",
			"event", "agent_host.commit_observer.failed",
			"transaction_id", delta.TransactionID,
			"error", err,
		)
	}
}

func (h *Host) notifyCommitted(ctx context.Context, delta CommittedDelta) {
	if h != nil {
		NotifyCommitted(ctx, h.commitObserver, delta)
	}
}
