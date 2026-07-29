package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

func normalizeCapabilityReferences(references []CapabilityReference) []CapabilityReference {
	seen := make(map[string]struct{}, len(references))
	normalized := make([]CapabilityReference, 0, len(references))
	for _, reference := range references {
		reference.Capability = strings.TrimSpace(reference.Capability)
		reference.Source = strings.TrimSpace(reference.Source)
		if reference.Capability == "" || reference.Source == "" {
			continue
		}
		key := reference.Source + "\x00" + reference.Capability
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		normalized = append(normalized, reference)
	}
	return normalized
}

func mergeTurnCapabilityReferencesTx(
	ctx context.Context,
	tx *sql.Tx,
	existing Turn,
	incoming []CapabilityReference,
) (Turn, bool, error) {
	merged := normalizeCapabilityReferences(append(
		append([]CapabilityReference(nil), existing.CapabilityRefs...),
		incoming...,
	))
	if capabilityReferencesEqual(existing.CapabilityRefs, merged) {
		return existing, false, nil
	}
	payload, err := json.Marshal(merged)
	if err != nil {
		return Turn{}, false, fmt.Errorf("encode workspace agent turn capability refs: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_turns
SET capability_refs_json = ?
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, string(payload), existing.WorkspaceID, existing.AgentSessionID, existing.TurnID); err != nil {
		return Turn{}, false, fmt.Errorf("merge workspace agent turn capability refs: %w", err)
	}
	stored, ok, err := getAgentTurnTx(ctx, tx, existing.WorkspaceID, existing.AgentSessionID, existing.TurnID)
	if err != nil {
		return Turn{}, false, err
	}
	if !ok {
		return Turn{}, false, fmt.Errorf("read merged workspace agent turn capability refs: %w", sql.ErrNoRows)
	}
	return stored, true, nil
}

func capabilityReferencesEqual(left, right []CapabilityReference) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
