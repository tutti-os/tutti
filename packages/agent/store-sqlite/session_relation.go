package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	agentactivityprojection "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func prepareSessionRelation(
	input *SessionStateReport,
	existing agentactivityprojection.SessionSnapshot,
	hasExisting bool,
) error {
	input.Kind = strings.TrimSpace(input.Kind)
	input.RootAgentSessionID = strings.TrimSpace(input.RootAgentSessionID)
	input.RootTurnID = strings.TrimSpace(input.RootTurnID)
	input.ParentAgentSessionID = strings.TrimSpace(input.ParentAgentSessionID)
	input.ParentTurnID = strings.TrimSpace(input.ParentTurnID)
	input.ParentToolCallID = strings.TrimSpace(input.ParentToolCallID)

	if hasExisting {
		existingKind := strings.TrimSpace(existing.Kind)
		if existingKind == "" {
			existingKind = SessionKindRoot
		}
		if input.Kind == "" {
			input.Kind = existingKind
		} else if input.Kind != existingKind {
			return errors.New("workspace agent session kind is immutable")
		}
		if err := retainImmutableSessionField(&input.RootAgentSessionID, existing.RootAgentSessionID, "root agent session id"); err != nil {
			return err
		}
		if err := retainImmutableSessionField(&input.RootTurnID, existing.RootTurnID, "root turn id"); err != nil {
			return err
		}
		if err := retainImmutableSessionField(&input.ParentAgentSessionID, existing.ParentAgentSessionID, "parent agent session id"); err != nil {
			return err
		}
		if err := retainImmutableSessionField(&input.ParentTurnID, existing.ParentTurnID, "parent turn id"); err != nil {
			return err
		}
		if err := retainImmutableSessionField(&input.ParentToolCallID, existing.ParentToolCallID, "parent tool call id"); err != nil {
			return err
		}
	} else if input.Kind == "" {
		input.Kind = SessionKindRoot
	}

	switch input.Kind {
	case SessionKindRoot:
		if input.RootAgentSessionID != "" || input.RootTurnID != "" ||
			input.ParentAgentSessionID != "" || input.ParentTurnID != "" || input.ParentToolCallID != "" {
			return errors.New("root workspace agent session cannot have root or parent fields")
		}
	case SessionKindChild:
		if input.RootAgentSessionID == "" || input.RootTurnID == "" ||
			input.ParentAgentSessionID == "" || input.ParentTurnID == "" || input.ParentToolCallID == "" {
			return errors.New("child workspace agent session requires root and parent fields")
		}
		if input.RootAgentSessionID == input.AgentSessionID || input.ParentAgentSessionID == input.AgentSessionID {
			return errors.New("child workspace agent session cannot own or parent itself")
		}
	default:
		return fmt.Errorf("unsupported workspace agent session kind %q", input.Kind)
	}
	return nil
}

func retainImmutableSessionField(target *string, existing string, label string) error {
	existing = strings.TrimSpace(existing)
	if *target == "" {
		*target = existing
		return nil
	}
	if *target != existing {
		return fmt.Errorf("workspace agent session %s is immutable", label)
	}
	return nil
}

func validateChildSessionParentsTx(
	ctx context.Context,
	tx *sql.Tx,
	input SessionStateReport,
) error {
	var rootKind string
	err := tx.QueryRowContext(ctx, `
SELECT session_kind
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, input.WorkspaceID, input.RootAgentSessionID).Scan(&rootKind)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("child workspace agent session root session does not exist")
		}
		return fmt.Errorf("read child workspace agent root session: %w", err)
	}
	if rootKind != SessionKindRoot {
		return errors.New("child workspace agent session root must have root kind")
	}

	var rootPhase string
	err = tx.QueryRowContext(ctx, `
SELECT phase
FROM workspace_agent_turns
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, input.WorkspaceID, input.RootAgentSessionID, input.RootTurnID).Scan(&rootPhase)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("child workspace agent session root turn does not exist")
		}
		return fmt.Errorf("read child workspace agent root turn: %w", err)
	}
	if rootPhase == TurnPhaseSettled {
		return errors.New("child workspace agent session cannot be created after its root turn settled")
	}

	// Preparing a root cancel operation durably freezes the delegation tree
	// before provider I/O begins. A provider may reveal another child after the
	// exact cancel target snapshot was recorded; accepting that child here
	// would let it escape the atomic target settlement and leave active durable
	// state below a canceled root.
	var rootCancelPending int
	err = tx.QueryRowContext(ctx, `
SELECT EXISTS(
  SELECT 1
  FROM workspace_agent_runtime_operations
  WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
    AND kind = ? AND status IN (?, ?)
)
`, input.WorkspaceID, input.RootAgentSessionID, input.RootTurnID,
		RuntimeOperationKindCancelTurn, RuntimeOperationStatusPrepared, RuntimeOperationStatusLeased,
	).Scan(&rootCancelPending)
	if err != nil {
		return fmt.Errorf("read child workspace agent root cancel boundary: %w", err)
	}
	if rootCancelPending != 0 {
		return errors.New("child workspace agent session cannot be created after its root turn cancellation started")
	}

	var parentKind string
	var parentRootAgentSessionID, parentRootTurnID sql.NullString
	err = tx.QueryRowContext(ctx, `
SELECT session_kind, root_agent_session_id, root_turn_id
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, input.WorkspaceID, input.ParentAgentSessionID).Scan(
		&parentKind,
		&parentRootAgentSessionID,
		&parentRootTurnID,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("child workspace agent session parent session does not exist")
		}
		return fmt.Errorf("read child workspace agent parent session: %w", err)
	}
	if parentKind == SessionKindRoot {
		if input.ParentAgentSessionID != input.RootAgentSessionID || input.ParentTurnID != input.RootTurnID {
			return errors.New("child workspace agent session root parent must use the root session and turn")
		}
	} else if parentKind != SessionKindChild ||
		strings.TrimSpace(parentRootAgentSessionID.String) != input.RootAgentSessionID ||
		strings.TrimSpace(parentRootTurnID.String) != input.RootTurnID {
		return errors.New("child workspace agent session parent belongs to another root turn")
	}

	var parentTurnExists int
	err = tx.QueryRowContext(ctx, `
SELECT 1
FROM workspace_agent_turns
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, input.WorkspaceID, input.ParentAgentSessionID, input.ParentTurnID).Scan(&parentTurnExists)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("child workspace agent session parent turn does not exist")
		}
		return fmt.Errorf("read child workspace agent parent turn: %w", err)
	}
	return nil
}
