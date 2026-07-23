package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// validateTurnLineageTx keeps a derived turn attached to a settled parent in
// the same workspace session. SQLite triggers protect malformed pairs from
// direct writes; this boundary returns actionable errors for Host callers.
func validateTurnLineageTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID, agentSessionID, turnID string,
	transition TurnTransition,
	existing Turn,
	hasExisting bool,
) error {
	parentTurnID := strings.TrimSpace(transition.ParentTurnID)
	relation := TurnRelation(strings.TrimSpace(string(transition.Relation)))
	if (parentTurnID == "") != (relation == "") {
		return errors.New("workspace agent turn lineage requires both parent turn id and relation")
	}
	if relation != "" && !isKnownTurnRelation(string(relation)) {
		return fmt.Errorf("unknown workspace agent turn relation %q", relation)
	}
	if parentTurnID == "" {
		return nil
	}
	if parentTurnID == turnID {
		return errors.New("workspace agent turn cannot be its own lineage parent")
	}
	if hasExisting && (parentTurnID != existing.ParentTurnID || relation != existing.Relation) {
		return errors.New("workspace agent turn lineage is immutable")
	}
	parent, found, err := getAgentTurnTx(ctx, tx, workspaceID, agentSessionID, parentTurnID)
	if err != nil {
		return fmt.Errorf("read workspace agent turn lineage parent: %w", err)
	}
	if !found {
		return fmt.Errorf("workspace agent turn lineage parent %q does not exist in this session", parentTurnID)
	}
	if parent.Phase != TurnPhaseSettled {
		return fmt.Errorf("workspace agent turn lineage parent %q is not settled", parentTurnID)
	}
	return nil
}
