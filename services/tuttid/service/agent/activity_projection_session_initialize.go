package agent

import (
	"context"
	"fmt"
	"strings"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func (p *ActivityProjection) NormalizeRuntimeSessionInitialization(
	ctx context.Context,
	session agenthost.ProviderRuntimeSession,
) (agenthost.ProviderRuntimeSession, error) {
	if p == nil {
		return agenthost.ProviderRuntimeSession{}, fmt.Errorf("agent activity projection is unavailable")
	}
	canonicalTargetID, runtimeContext := p.canonicalizeAgentTargetID(
		ctx,
		session.WorkspaceID,
		session.AgentTargetID,
		session.RuntimeContext,
	)
	session.AgentTargetID = canonicalTargetID
	session.RuntimeContext = runtimeContext
	return session, nil
}

// InitializeRuntimeSession is the synchronous Create boundary. Runtime
// reporting remains asynchronous for subsequent observations, but a successful
// Create response must already have a durable session and immutable rail key.
func (p *ActivityProjection) InitializeRuntimeSession(
	ctx context.Context,
	session ProviderRuntimeSession,
) (PersistedSession, error) {
	if p == nil || p.repo == nil {
		return PersistedSession{}, fmt.Errorf("agent activity repository is unavailable")
	}
	workspaceID := strings.TrimSpace(session.WorkspaceID)
	agentSessionID := strings.TrimSpace(session.ID)
	if workspaceID == "" || agentSessionID == "" {
		return PersistedSession{}, ErrInvalidArgument
	}
	runtimeContext := clonePayload(session.RuntimeContext)
	if runtimeContext == nil {
		runtimeContext = map[string]any{}
	}
	// A create-with-initial-input shell is durable only to reserve its immutable
	// rail identity. Keep it hidden until the first Turn report atomically
	// publishes the canonical session and Turn together.
	runtimeContext["visible"] = session.Visible && !session.Provisional
	settings := cloneComposerSettingsPointerValue(session.Settings)
	occurredAtUnixMS := session.UpdatedAtUnixMS
	if occurredAtUnixMS <= 0 {
		occurredAtUnixMS = session.CreatedAtUnixMS
	}
	if occurredAtUnixMS <= 0 {
		occurredAtUnixMS = time.Now().UnixMilli()
	}

	_, err := p.reportSessionState(ctx, canonical.ReportSessionStateInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		AgentTargetID:  strings.TrimSpace(session.AgentTargetID),
		SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Source: canonical.EventSource{
			Provider:               strings.TrimSpace(session.Provider),
			ProviderSessionID:      strings.TrimSpace(session.ProviderSessionID),
			SessionCreatedAtUnixMS: session.CreatedAtUnixMS,
			AgentID:                agentSessionID,
			AgentTargetID:          strings.TrimSpace(session.AgentTargetID),
			CWD:                    strings.TrimSpace(session.Cwd),
			SessionOrigin:          agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			UserID:                 strings.TrimSpace(session.UserID),
		},
		State: canonical.WorkspaceAgentSessionStateUpdate{
			Kind:              agentactivitybiz.SessionKindRoot,
			AgentTargetID:     strings.TrimSpace(session.AgentTargetID),
			Provider:          strings.TrimSpace(session.Provider),
			ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
			Model:             strings.TrimSpace(settings.Model),
			Settings:          composerSettingsToStatePayload(settings),
			RuntimeContext:    runtimeContext,
			CWD:               strings.TrimSpace(session.Cwd),
			Title:             strings.TrimSpace(session.Title),
			LifecycleStatus:   runtimeSessionLifecycleStatus(session.Status),
			CurrentPhase:      runtimeSessionCurrentPhase(session.Status),
			LastError:         strings.TrimSpace(session.LastError),
			OccurredAtUnixMS:  occurredAtUnixMS,
			StartedAtUnixMS:   session.CreatedAtUnixMS,
		},
	}, !session.Provisional)
	if err != nil {
		return PersistedSession{}, err
	}
	persisted, ok, err := p.repo.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		return PersistedSession{}, fmt.Errorf("read initialized agent session: %w", err)
	}
	if !ok {
		return PersistedSession{}, fmt.Errorf("initialized agent session was not persisted")
	}
	result := p.projectPersistedSession(ctx, persistedSessionFromActivity(persisted))
	if strings.TrimSpace(result.RailSectionKey) == "" {
		return PersistedSession{}, fmt.Errorf("initialized agent session has no rail section key")
	}
	return result, nil
}

func runtimeSessionLifecycleStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "failed":
		return "failed"
	case "completed", "canceled":
		return "ended"
	default:
		return "active"
	}
}

func runtimeSessionCurrentPhase(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "working":
		return "working"
	case "waiting":
		return "waiting"
	case "failed":
		return "failed"
	default:
		return "idle"
	}
}
