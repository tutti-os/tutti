package agenthost

import (
	"context"
	"log/slog"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func logQuarantinedSessionFork(
	ctx context.Context,
	operation storesqlite.SessionForkOperation,
	cause error,
) {
	slog.WarnContext(
		ctx,
		"agent session fork materialization quarantined",
		"event", "agent_session.fork.materialization_quarantined",
		"workspace_id", operation.WorkspaceID,
		"operation_id", operation.OperationID,
		"source_agent_session_id", operation.SourceAgentSessionID,
		"target_agent_session_id", operation.TargetAgentSessionID,
		"driver_kind", operation.DriverKind,
		"status", operation.Status,
		"target_provider_binding_count", len(operation.TargetProviderTurnBindings),
		"error", cause,
	)
}
