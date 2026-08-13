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
	// Provider is the canonical provider identity for the reporting session.
	// Message rows do not repeat session identity, so terminal tool-call
	// analytics carry it on the committed wrapper.
	Provider string
	// IsChildSession marks a provider-native subagent session. Message reports
	// carry no session state, so the reporting adapter resolves it from the
	// canonical session before publishing the delta.
	IsChildSession bool
}

type RootTurnSettled struct {
	WorkspaceID    string
	AgentSessionID string
	Turn           storesqlite.Turn
	Provider       string
	IsChildSession bool
	// StartupReconciled marks a turn force-settled by daemon-start
	// reconciliation rather than by a live provider settlement. Failure
	// analytics still count it; runtime fan-out that reacts to a real
	// completion must skip it.
	StartupReconciled bool
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
	Stage          RuntimeOperationCommitStage
	Operation      storesqlite.RuntimeOperation
	Event          *storesqlite.RuntimeOperationEvent
	Provider       string
	IsChildSession bool
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
	Stage          GoalOperationCommitStage
	Operation      storesqlite.GoalControlOperation
	State          storesqlite.SessionGoalState
	Audit          *storesqlite.Message
	Provider       string
	IsChildSession bool
}

type CanonicalProjectionDirty struct {
	WorkspaceID        string
	AgentSessionID     string
	RootAgentSessionID string
	RootTurnID         string
	MutationID         string
	EntityKind         string
	EntityID           string
	Operation          string
	Version            int64
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
			Provider:       firstNonEmptyTrimmed(result.State.Session.Provider, input.State.Provider, input.Source.Provider),
			IsChildSession: sessionStateIsChild(input.State),
		})
	}
	if goalOp := goalOperationFromActivityState(input, result); goalOp != nil {
		delta.GoalOperation = goalOp
	}
	delta.addView(input.WorkspaceID, input.AgentSessionID)
	if result.RootTurnAccepted {
		delta.addView(input.WorkspaceID, result.RootTurn.AgentSessionID)
	}
	return delta
}

func sessionStateIsChild(state canonical.WorkspaceAgentSessionStateUpdate) bool {
	kind := strings.TrimSpace(state.Kind)
	if strings.EqualFold(kind, storesqlite.SessionKindChild) {
		return true
	}
	return strings.TrimSpace(state.ParentToolCallID) != ""
}

// goalOperationFromActivityState promotes bottom-up Goal observed updates
// (reconcileObservedGoalFromSessionTx) into the typed GoalOperation seam so
// session-replay can mint goal.completed / goal.running checkpoints.
func goalOperationFromActivityState(
	input canonical.ReportSessionStateInput,
	result storesqlite.ActivityStateReportResult,
) *GoalOperationCommitted {
	sessionID := strings.TrimSpace(input.AgentSessionID)
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	hasGoalMutation := false
	for _, mutation := range result.CommitDelta.Mutations {
		if mutation.EntityKind != storesqlite.MutationEntityGoalState {
			continue
		}
		hasGoalMutation = true
		if id := strings.TrimSpace(mutation.AgentSessionID); id != "" {
			sessionID = id
		}
		if id := strings.TrimSpace(mutation.WorkspaceID); id != "" {
			workspaceID = id
		}
	}
	if !hasGoalMutation || sessionID == "" || workspaceID == "" {
		return nil
	}
	observed := clonePayload(runtimeContextGoal(input.State.RuntimeContext))
	if len(observed) == 0 {
		return nil
	}
	return &GoalOperationCommitted{
		Stage:          GoalOperationReconciled,
		Provider:       firstNonEmptyTrimmed(result.State.Session.Provider, input.State.Provider, input.Source.Provider),
		IsChildSession: sessionStateIsChild(input.State),
		State: storesqlite.SessionGoalState{
			WorkspaceID:         workspaceID,
			AgentSessionID:      sessionID,
			Observed:            observed,
			CommitTransactionID: strings.TrimSpace(result.TransactionID),
		},
	}
}

func runtimeContextGoal(runtimeContext map[string]any) map[string]any {
	if len(runtimeContext) == 0 {
		return nil
	}
	raw, ok := runtimeContext["goal"].(map[string]any)
	if !ok || len(raw) == 0 {
		return nil
	}
	return raw
}

func SessionMessagesDelta(input canonical.ReportSessionMessagesInput, reply canonical.ReportSessionMessagesReply, result storesqlite.MessageReportResult) CommittedDelta {
	delta := committedDeltaFromMutations(result.TransactionID, result.CommitDelta.Mutations)
	delta.SessionMessages = &SessionMessagesCommitted{
		Input: input, Reply: reply, Result: result,
		Provider: strings.TrimSpace(input.Source.Provider),
	}
	delta.addView(input.WorkspaceID, canonicalMessageSessionID(input.AgentSessionID, result.Messages))
	return delta
}

// StaleTurnSettlementDelta projects daemon-start reconciliation. Every listed
// turn was force-settled as interrupted, so it enters RootTurnsSettled with
// that outcome and the StartupReconciled marker.
func StaleTurnSettlementDelta(settlements []storesqlite.StaleTurnSettlement) CommittedDelta {
	delta := CommittedDelta{}
	if len(settlements) > 0 {
		delta = committedDeltaFromMutations(settlements[0].TransactionID, settlements[0].CommitDelta.Mutations)
	}
	for _, settlement := range settlements {
		delta.addView(settlement.WorkspaceID, settlement.AgentSessionID)
		turnID := strings.TrimSpace(settlement.TurnID)
		if turnID == "" {
			continue
		}
		workspaceID := strings.TrimSpace(settlement.WorkspaceID)
		agentSessionID := strings.TrimSpace(settlement.AgentSessionID)
		delta.RootTurnsSettled = append(delta.RootTurnsSettled, RootTurnSettled{
			WorkspaceID:    workspaceID,
			AgentSessionID: agentSessionID,
			Turn: storesqlite.Turn{
				WorkspaceID:     workspaceID,
				AgentSessionID:  agentSessionID,
				TurnID:          turnID,
				Phase:           storesqlite.TurnPhaseSettled,
				Outcome:         storesqlite.TurnOutcomeInterrupted,
				ErrorMessage:    "stale turn settled on daemon startup",
				StartedAtUnixMS: settlement.StartedAtUnixMS,
				SettledAtUnixMS: settlement.SettledAtUnixMS,
			},
			Provider:          strings.TrimSpace(settlement.Provider),
			IsChildSession:    settlement.IsChildSession,
			StartupReconciled: true,
		})
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
			RootAgentSessionID: mutation.RootAgentSessionID, RootTurnID: mutation.RootTurnID,
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
		h.enrichCommittedDeltaTerminalIdentity(ctx, &delta)
		ObserveTerminalFailuresFromDelta(ctx, h.terminalFailure, delta)
		NotifyCommitted(ctx, h.commitObserver, delta)
	}
}

type terminalFailureSessionIdentity struct {
	provider       string
	isChildSession bool
}

// enrichCommittedDeltaTerminalIdentity resolves session-owned facts from the
// canonical store after commit. Runtime and Goal operation rows deliberately
// do not duplicate provider identity, while product telemetry still needs the
// exact canonical Provider and child-session classification.
func (h *Host) enrichCommittedDeltaTerminalIdentity(ctx context.Context, delta *CommittedDelta) {
	if h == nil || h.store == nil || delta == nil {
		return
	}
	identities := map[string]terminalFailureSessionIdentity{}
	resolve := func(workspaceID, agentSessionID string) terminalFailureSessionIdentity {
		workspaceID = strings.TrimSpace(workspaceID)
		agentSessionID = strings.TrimSpace(agentSessionID)
		key := workspaceID + "\x00" + agentSessionID
		if identity, ok := identities[key]; ok {
			return identity
		}
		identity := terminalFailureSessionIdentity{}
		if workspaceID != "" && agentSessionID != "" {
			if session, found, err := h.store.GetSession(ctx, workspaceID, agentSessionID); err == nil && found {
				identity.provider = strings.TrimSpace(session.Provider)
				identity.isChildSession = canonicalSessionIsChild(session)
			}
		}
		identities[key] = identity
		return identity
	}
	apply := func(provider *string, isChildSession *bool, workspaceID, agentSessionID string) {
		identity := resolve(workspaceID, agentSessionID)
		if strings.TrimSpace(*provider) == "" {
			*provider = identity.provider
		}
		*isChildSession = *isChildSession || identity.isChildSession
	}
	if committed := delta.RuntimeOperation; committed != nil && committed.Stage == RuntimeOperationFailed {
		apply(&committed.Provider, &committed.IsChildSession,
			committed.Operation.WorkspaceID, committed.Operation.AgentSessionID)
	}
	if committed := delta.GoalOperation; committed != nil &&
		(committed.Stage == GoalOperationFailed || committed.Stage == GoalOperationTerminal) {
		workspaceID := firstNonEmptyTrimmed(committed.Operation.WorkspaceID, committed.State.WorkspaceID)
		agentSessionID := firstNonEmptyTrimmed(committed.Operation.AgentSessionID, committed.State.AgentSessionID)
		apply(&committed.Provider, &committed.IsChildSession, workspaceID, agentSessionID)
	}
	for index := range delta.RootTurnsSettled {
		settled := &delta.RootTurnsSettled[index]
		if outcome := strings.TrimSpace(settled.Turn.Outcome); outcome != storesqlite.TurnOutcomeFailed &&
			outcome != storesqlite.TurnOutcomeInterrupted && outcome != storesqlite.TurnOutcomeCanceled {
			continue
		}
		apply(&settled.Provider, &settled.IsChildSession, settled.WorkspaceID, settled.AgentSessionID)
	}
	if committed := delta.SessionMessages; committed != nil &&
		len(terminalFailuresFromSessionMessages(*committed, nil)) > 0 {
		agentSessionID := canonicalMessageSessionID(committed.Input.AgentSessionID, committed.Result.Messages)
		apply(&committed.Provider, &committed.IsChildSession, committed.Input.WorkspaceID, agentSessionID)
	}
}

func canonicalSessionIsChild(session storesqlite.Session) bool {
	return strings.EqualFold(strings.TrimSpace(session.Kind), storesqlite.SessionKindChild) ||
		strings.TrimSpace(session.ParentToolCallID) != ""
}
