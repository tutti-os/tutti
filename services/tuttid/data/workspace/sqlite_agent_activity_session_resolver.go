package workspace

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

func resolveAgentMessageReportSessionIDTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionID string,
	provider string,
	origin string,
) (string, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	provider = strings.TrimSpace(provider)
	if workspaceID == "" || agentSessionID == "" {
		return agentSessionID, nil
	}
	existing, hasExisting, err := getAgentSessionForUpdate(ctx, tx, workspaceID, agentSessionID)
	if err != nil {
		return "", err
	}
	if hasExisting && existing.DeletedAtUnixMS == 0 {
		return agentSessionID, nil
	}
	canonicalID, err := findUniqueAgentSessionIDByProviderSessionIDTx(
		ctx,
		tx,
		workspaceID,
		agentSessionID,
		provider,
		origin,
	)
	if err != nil {
		return "", err
	}
	if canonicalID != "" {
		return canonicalID, nil
	}
	return agentSessionID, nil
}

func findUniqueAgentSessionIDByProviderSessionIDTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	providerSessionID string,
	provider string,
	origin string,
) (string, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	providerSessionID = strings.TrimSpace(providerSessionID)
	provider = strings.TrimSpace(provider)
	origin = strings.TrimSpace(origin)
	if workspaceID == "" || providerSessionID == "" {
		return "", nil
	}
	query := `
SELECT agent_session_id
FROM workspace_agent_sessions
WHERE workspace_id = ? AND provider_session_id = ? AND deleted_at_unix_ms = 0
`
	args := []any{workspaceID, providerSessionID}
	if provider != "" {
		query += "  AND provider = ?\n"
		args = append(args, provider)
	}
	if origin != "" {
		query += "  AND origin = ?\n"
		args = append(args, origin)
	}
	query += "ORDER BY agent_session_id ASC"

	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return "", fmt.Errorf("find workspace agent session by provider session id: %w", err)
	}
	defer rows.Close()

	matchedID := ""
	for rows.Next() {
		var candidateID string
		if err := rows.Scan(&candidateID); err != nil {
			return "", fmt.Errorf("scan workspace agent provider session match: %w", err)
		}
		candidateID = strings.TrimSpace(candidateID)
		if candidateID == "" {
			continue
		}
		if matchedID != "" && matchedID != candidateID {
			return "", nil
		}
		matchedID = candidateID
	}
	if err := rows.Err(); err != nil {
		return "", fmt.Errorf("iterate workspace agent provider session matches: %w", err)
	}
	return matchedID, nil
}
