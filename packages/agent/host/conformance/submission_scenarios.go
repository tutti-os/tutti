package conformance

import (
	"context"
	"fmt"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

// verifyRetriedInitialCreate models an accepted create whose response was
// lost. Untrusted legacy metadata must not override the typed identity.
func verifyRetriedInitialCreate(ctx context.Context, driver Driver, input agenthost.CreateSessionInput, session SessionObservation, turnID string) error {
	retry := input
	retry.Metadata = map[string]any{"clientSubmitId": "different-caller-controlled"}
	retriedSession, retriedTurnID, err := driver.Create(ctx, "workspace-1", retry)
	if err != nil {
		return fmt.Errorf("retry accepted create with initial content: %w", err)
	}
	if retriedSession.SessionID != session.SessionID || retriedTurnID != turnID {
		return fmt.Errorf("retried create session=%q turn=%q, want session=%q turn=%q", retriedSession.SessionID, retriedTurnID, session.SessionID, turnID)
	}
	return nil
}
