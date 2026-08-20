package agent

import (
	"context"
	"strings"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentanalytics"
	agentnoderesult "github.com/tutti-os/tutti/services/tuttid/service/reporter/events/agent/node_result"
)

func canonicalRailSection(placement *canonical.RailPlacement) *agentactivitybiz.RailSection {
	if placement == nil {
		return nil
	}
	return &agentactivitybiz.RailSection{
		Kind:        strings.TrimSpace(placement.Kind),
		ProjectPath: strings.TrimSpace(placement.ProjectPath),
		Key:         strings.TrimSpace(placement.SectionKey),
	}
}

func (p *ActivityProjection) reportFailedRuntimeNodeResult(ctx context.Context, input canonical.ReportSessionStateInput) {
	if p == nil || p.analyticsReporter == nil {
		return
	}
	if !isFailedAgentLifecycleStatus(input.State.LifecycleStatus) {
		return
	}
	errorMessage := strings.TrimSpace(input.State.LastError)
	if errorMessage == "" {
		errorMessage = "Agent runtime session failed."
	}
	agentnoderesult.Track(ctx, p.analyticsReporter, agentnoderesult.BuildParams(agentnoderesult.NodeResultInput{
		AgentSessionID: input.AgentSessionID,
		ErrorCode:      classifyRuntimeNodeErrorCode(errorMessage),
		ErrorMessage:   errorMessage,
		Flow:           "runtime_activity",
		Node:           "runtime_exec",
		Provider:       firstNonEmptyString(input.State.Provider, input.Source.Provider),
		Status:         "failure",
	}))
}

func sessionStateTitle(state canonical.WorkspaceAgentSessionStateUpdate) string {
	return firstNonEmptyString(
		state.Title,
		payloadString(state.RuntimeContext, "title"),
	)
}

func activitySessionUpdateEventPayload(workspaceID string, agentSessionID string, lastEventUnixMS int64, agentTargetID ...string) map[string]any {
	if lastEventUnixMS <= 0 {
		lastEventUnixMS = time.Now().UnixMilli()
	}
	payload := map[string]any{
		"agentSessionId":  strings.TrimSpace(agentSessionID),
		"eventType":       "session_reconcile_required",
		"lastEventUnixMs": lastEventUnixMS,
		"workspaceId":     strings.TrimSpace(workspaceID),
	}
	if len(agentTargetID) > 0 {
		if value := strings.TrimSpace(agentTargetID[0]); value != "" {
			payload["agentTargetId"] = value
		}
	}
	return payload
}

func activitySessionDeletedEventPayload(workspaceID string, agentSessionID string) map[string]any {
	return map[string]any{
		"agentSessionId":  strings.TrimSpace(agentSessionID),
		"deletedAtUnixMs": time.Now().UnixMilli(),
		"eventType":       "session_deleted",
		"workspaceId":     strings.TrimSpace(workspaceID),
	}
}

func activitySessionRestoredEventPayload(workspaceID string, agentSessionID string) map[string]any {
	return map[string]any{
		"agentSessionId":   strings.TrimSpace(agentSessionID),
		"eventType":        "session_restored",
		"restoredAtUnixMs": time.Now().UnixMilli(),
		"workspaceId":      strings.TrimSpace(workspaceID),
	}
}

func (p *ActivityProjection) PublishSessionDeleted(ctx context.Context, workspaceID string, agentSessionID string) {
	p.publishActivityUpdated(ctx, workspaceID, agentSessionID,
		"session_deleted", activitySessionDeletedEventPayload(workspaceID, agentSessionID))
}

func isFailedAgentLifecycleStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "failed", "failure", "error", "errored":
		return true
	default:
		return false
	}
}

func classifyRuntimeNodeErrorCode(message string) string {
	normalized := strings.ToLower(strings.TrimSpace(message))
	if strings.Contains(normalized, "network") ||
		strings.Contains(normalized, "connection") ||
		strings.Contains(normalized, "disconnected") ||
		strings.Contains(normalized, "econnreset") ||
		strings.Contains(normalized, "socket") {
		return agentanalytics.ErrorCodeRuntimeNetworkDisconnected
	}
	if strings.Contains(normalized, "process") ||
		strings.Contains(normalized, "exit") ||
		strings.Contains(normalized, "exited") {
		return agentanalytics.ErrorCodeRuntimeProcessExited
	}
	return agentanalytics.ErrorCodeRuntimeExecFailed
}
