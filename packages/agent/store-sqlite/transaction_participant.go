package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"
	activityreplication "github.com/tutti-os/tutti/packages/agent/activity-replication"
)

const (
	MutationEntitySession              = string(activityreplication.EntitySession)
	MutationEntityTurn                 = string(activityreplication.EntityTurn)
	MutationEntityInteraction          = string(activityreplication.EntityInteraction)
	MutationEntityMessage              = string(activityreplication.EntityMessage)
	MutationEntityRuntimeOperation     = string(activityreplication.EntityRuntimeOperation)
	MutationEntityRuntimeEvent         = string(activityreplication.EntityRuntimeOperationEvent)
	MutationEntityGoalState            = "goal_state"
	MutationEntityGoalOperation        = "goal_operation"
	MutationEntityGoalInbox            = "goal_reconcile_inbox"
	MutationEntitySessionForkOperation = "session_fork_operation"
	MutationEntityInteractionTree      = "interaction_tree"
)

// TransactionWriter is the intentionally narrow store-adapter seam for
// caller-owned durable markers. It does not expose *sql.Tx to Host domain code.
type TransactionWriter interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

// TransactionParticipant atomically appends host-owned durable facts to a
// canonical store transaction. Implementations must use only writer and return
// before commit; post-commit wakeups belong to agenthost.CommitObserver.
type TransactionParticipant interface {
	Participate(context.Context, TransactionWriter, TransactionDelta) error
}

type TransactionMutation struct {
	MutationID             string `json:"mutationId"`
	WorkspaceID            string `json:"workspaceId"`
	AgentSessionID         string `json:"agentSessionId"`
	RootAgentSessionID     string `json:"rootAgentSessionId,omitempty"`
	RootTurnID             string `json:"rootTurnId,omitempty"`
	EntityKind             string `json:"entityKind"`
	EntityID               string `json:"entityId"`
	Operation              string `json:"operation"`
	Version                int64  `json:"version"`
	TurnTerminalTransition bool   `json:"turnTerminalTransition,omitempty"`
	StartupReconciled      bool   `json:"startupReconciled,omitempty"`
}

type TransactionDelta struct {
	TransactionID string                `json:"transactionId"`
	WorkspaceID   string                `json:"workspaceId"`
	Mutations     []TransactionMutation `json:"mutations"`
}

func transactionMutation(workspaceID, agentSessionID, entityKind, entityID, operation string, version int64) TransactionMutation {
	return TransactionMutation{
		WorkspaceID: strings.TrimSpace(workspaceID), AgentSessionID: strings.TrimSpace(agentSessionID),
		EntityKind: strings.TrimSpace(entityKind), EntityID: strings.TrimSpace(entityID),
		Operation: strings.TrimSpace(operation), Version: version,
	}
}

func terminalTurnMutation(
	workspaceID, agentSessionID, turnID, operation string,
	version int64,
	startupReconciled bool,
) TransactionMutation {
	mutation := transactionMutation(
		workspaceID, agentSessionID, MutationEntityTurn, turnID, operation, version,
	)
	mutation.TurnTerminalTransition = true
	mutation.StartupReconciled = startupReconciled
	return mutation
}

func interactionMutationEntityID(turnID, requestID string) string {
	return strings.TrimSpace(turnID) + "\x00" + strings.TrimSpace(requestID)
}

func (s *Store) commitTransaction(ctx context.Context, tx *sql.Tx, workspaceID string, mutations []TransactionMutation) (TransactionDelta, error) {
	delta, err := s.participateTransaction(ctx, tx, workspaceID, mutations)
	if err != nil {
		return TransactionDelta{}, err
	}
	if err := tx.Commit(); err != nil {
		return TransactionDelta{}, err
	}
	return delta, nil
}

func (s *Store) participateTransaction(ctx context.Context, tx *sql.Tx, workspaceID string, mutations []TransactionMutation) (TransactionDelta, error) {
	delta := TransactionDelta{WorkspaceID: strings.TrimSpace(workspaceID)}
	for _, mutation := range mutations {
		if mutation.EntityKind == "" || mutation.EntityID == "" {
			continue
		}
		if mutation.WorkspaceID == "" {
			mutation.WorkspaceID = delta.WorkspaceID
		}
		delta.Mutations = append(delta.Mutations, mutation)
	}
	var err error
	delta.Mutations, err = appendInteractionTreeProjectionMutations(ctx, tx, delta.Mutations)
	if err != nil {
		return TransactionDelta{}, err
	}
	if len(delta.Mutations) > 0 {
		delta.TransactionID = uuid.NewString()
		for index := range delta.Mutations {
			delta.Mutations[index].MutationID = delta.TransactionID + ":" + strconv.Itoa(index+1)
		}
		if participant := s.opts.TransactionParticipant; participant != nil {
			if err := participant.Participate(ctx, tx, delta); err != nil {
				return TransactionDelta{}, fmt.Errorf("participate in canonical transaction: %w", err)
			}
		}
	}
	return delta, nil
}
