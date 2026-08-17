package agent

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentturnterminal "github.com/tutti-os/tutti/services/tuttid/service/reporter/events/agent/turn_terminal"
)

func (p *ActivityProjection) reportRootTurnTerminalEvent(ctx context.Context, settled agenthost.RootTurnSettled) {
	if p == nil || p.analyticsReporter == nil || settled.IsChildSession {
		return
	}
	turn := settled.Turn
	if turn.Backfilled || strings.TrimSpace(turn.Origin) != agentactivitybiz.TurnOriginUserPrompt {
		return
	}
	reader, ok := p.repo.(agentactivitybiz.TurnSubmissionReader)
	if !ok {
		logSkippedTurnTerminalEvent(ctx, settled, "submission_reader_unavailable")
		return
	}
	submission, found, err := reader.GetTurnSubmission(
		ctx,
		settled.WorkspaceID,
		settled.AgentSessionID,
		turn.TurnID,
	)
	if err != nil {
		logSkippedTurnTerminalEvent(ctx, settled, "submission_read_failed")
		return
	}
	if !found {
		logSkippedTurnTerminalEvent(ctx, settled, "submission_missing")
		return
	}
	mode, ok := terminalSubmissionMode(submission.MetadataJSON)
	if !ok {
		logSkippedTurnTerminalEvent(ctx, settled, "submission_mode_invalid")
		return
	}
	eventName, params, ok := agentturnterminal.Build(agentturnterminal.Input{
		AgentSessionID:    settled.AgentSessionID,
		ClientSubmitID:    submission.ClientSubmitID,
		ErrorCode:         turn.ErrorCode,
		Mode:              mode,
		Origin:            turn.Origin,
		Outcome:           turn.Outcome,
		Provider:          settled.Provider,
		SettledAtUnixMS:   turn.SettledAtUnixMS,
		StartedAtUnixMS:   turn.StartedAtUnixMS,
		StartupReconciled: settled.StartupReconciled,
		TurnID:            turn.TurnID,
	})
	if !ok {
		return
	}
	agentturnterminal.Track(ctx, p.analyticsReporter, eventName, params)
}

func terminalSubmissionMode(metadataJSON string) (string, bool) {
	var metadata map[string]any
	if err := json.Unmarshal([]byte(metadataJSON), &metadata); err != nil || metadata == nil {
		return "", false
	}
	mode, ok := metadata["uiMode"].(string)
	if !ok || (mode != "os" && mode != "agent") {
		return "", false
	}
	return mode, true
}

func logSkippedTurnTerminalEvent(ctx context.Context, settled agenthost.RootTurnSettled, reason string) {
	slog.DebugContext(
		ctx,
		"agent turn terminal analytics skipped",
		"reason", reason,
		"agent_session_id", strings.TrimSpace(settled.AgentSessionID),
		"turn_id", strings.TrimSpace(settled.Turn.TurnID),
	)
}
