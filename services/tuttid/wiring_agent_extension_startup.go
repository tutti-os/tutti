package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	agentextensionservice "github.com/tutti-os/tutti/services/tuttid/service/agentextension"
)

func restoreAgentExtensionsForStartup(
	ctx context.Context,
	manager *agentextensionservice.Manager,
) bool {
	requiresSynchronousReconcile, restoreErrors := manager.RestoreActive(ctx)
	for _, restoreErr := range restoreErrors {
		payload, _ := json.Marshal(map[string]string{"error": restoreErr.Error()})
		slog.Warn("agent_extension.restore_failed", "payload", string(payload))
	}
	if !requiresSynchronousReconcile {
		return true
	}
	for _, reconcileErr := range manager.Reconcile(ctx) {
		payload, _ := json.Marshal(map[string]string{"error": reconcileErr.Error()})
		slog.Warn("agent_extension.reconcile_failed", "payload", string(payload))
	}
	return false
}

func startAgentExtensionBackgroundRefresh(
	manager *agentextensionservice.Manager,
	setup *agentextensionservice.SetupService,
) {
	go func() {
		startedAt := time.Now()
		slog.Info("agent extension background refresh started",
			"event", "tutti.agent_extension.refresh_started")
		for _, reconcileErr := range manager.Refresh(context.Background()) {
			payload, _ := json.Marshal(map[string]string{"error": reconcileErr.Error()})
			slog.Warn("agent_extension.reconcile_failed", "payload", string(payload))
		}
		setup.WakeAccountUsageCompanionReconciler()
		slog.Info("agent extension background refresh completed",
			"event", "tutti.agent_extension.refresh_completed",
			"durationMs", time.Since(startedAt).Milliseconds())
	}()
}
