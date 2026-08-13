package agentruntime

import (
	"context"
	"errors"
	"strings"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

const claudeSDKCloseTimeout = 10 * time.Minute

func (a *ClaudeCodeSDKAdapter) Start(ctx context.Context, session Session) ([]activityshared.Event, error) {
	unlock := a.lockClaudeSDKSessionLifecycle(session.AgentSessionID)
	defer unlock()
	if err := a.admitClaudeSDKReplacementLocked(session.AgentSessionID); err != nil {
		return nil, err
	}
	return a.replaceClaudeSDKSessionLocked(ctx, session)
}

func (a *ClaudeCodeSDKAdapter) replaceClaudeSDKSessionLocked(
	ctx context.Context,
	session Session,
) ([]activityshared.Event, error) {
	previous := a.getSession(session.AgentSessionID)
	events, err := a.startClaudeSDKSession(ctx, session)
	if err != nil && previous != nil {
		a.restoreOwnedPreviousSession(session.AgentSessionID, previous)
	}
	if err == nil && previous != nil {
		a.removeSession(session.AgentSessionID, previous)
		a.closeOrRetainClaudeSDKSession(session.AgentSessionID, previous)
	}
	return events, err
}

func (a *ClaudeCodeSDKAdapter) startClaudeSDKSession(ctx context.Context, session Session) ([]activityshared.Event, error) {
	if a == nil || a.transport == nil {
		return nil, ErrSessionDisconnected
	}
	restore := strings.TrimSpace(session.ProviderSessionID) != ""
	providerSessionID := firstNonEmpty(strings.TrimSpace(session.ProviderSessionID), newID())
	session.ProviderSessionID = providerSessionID
	spec, cleanup, err := prepareProviderLaunch(ctx, a.preparer, session, ProcessSpec{
		Provider:           ProviderClaudeCode,
		AgentSessionID:     session.AgentSessionID,
		RootAgentSessionID: session.RootAgentSessionID,
		RoomID:             session.RoomID,
		CWD:                session.CWD,
		Command:            claudeSDKSidecarCommand(session.Env),
		Env:                claudeSDKSidecarEnv(session),
		DirectStart:        true,
	})
	if err != nil {
		return nil, err
	}
	launchSession := session
	launchSession.CWD = spec.CWD
	launchSession.Env = append([]string(nil), spec.Env...)
	conn, err := a.transport.Start(ctx, spec)
	if err != nil {
		cleanupPreparedLaunch(cleanup)
		return nil, err
	}
	trackInputUnits := providerInputUnitsEnabled(conn)
	conn = wrapProviderLaunchCleanup(conn, cleanup)
	adapterSession := &claudeSDKAdapterSession{
		conn:              conn,
		reader:            newClaudeSDKLineReader(conn, trackInputUnits),
		session:           session,
		providerSessionID: providerSessionID,
		resumeCursor:      claudeSDKResumeCursorFromSession(session),
		assistantMessages: make(map[string]string),
		thinkingMessages:  make(map[string]string),
		compactMessages:   make(map[string]claudeSDKCompactMessage),
		pendingRequests:   make(map[string]*pendingInteractiveRequest),
		pendingResponses:  make(map[string]chan claudeSDKSidecarEvent),
		turns:             make(map[string]*claudeSDKTurnWaiter),
		liveState:         newClaudeSDKLiveState(),
	}
	a.storeSession(session.AgentSessionID, adapterSession)
	a.emitCommandSnapshot(claudeSDKCommandSnapshot(session.AgentSessionID, adapterSession.liveState))
	// Continue-session tapes attach after the provider connection is already
	// initialized, so their first outbound is exec. Skip the cold start
	// bootstrap on attached-live-connection replay exactly as Codex/ACP do.
	if processCassetteCaptureOrigin(conn) ==
		ProcessCassetteCaptureOriginAttachedLiveConnection {
		if !restore {
			a.removeSession(session.AgentSessionID, adapterSession)
			a.closeOrRetainClaudeSDKSession(session.AgentSessionID, adapterSession)
			return nil, errors.New(
				"attached live Claude replay requires a restored provider session id",
			)
		}
		return []activityshared.Event{newSessionActivityEvent(
			session,
			EventSessionStarted,
			SessionStatusReady,
			claudeSDKRuntimeContext(session, adapterSession),
		)}, nil
	}
	startPayload := map[string]any{
		"agentSessionId":    session.AgentSessionID,
		"providerSessionId": providerSessionID,
		"cwd":               launchSession.CWD,
		"env":               envListToMap(launchSession.Env),
		"restore":           restore,
		"permissionModeId":  session.PermissionModeID,
		"settings":          claudeSDKSessionSettingsPayload(session),
		"resumeCursor":      claudeSDKResumeCursorFromSession(session),
		"mcpServers":        claudeSDKMCPServers(session.MCPServers),
	}
	for key, value := range claudeCodeSDKStartOptions(session) {
		startPayload[key] = value
	}
	if err := adapterSession.send(claudeSDKSidecarRequest{
		ID:      newID(),
		Type:    "start",
		Payload: startPayload,
	}); err != nil {
		a.removeSession(session.AgentSessionID, adapterSession)
		a.closeOrRetainClaudeSDKSession(session.AgentSessionID, adapterSession)
		return nil, err
	}

	for {
		event, err := adapterSession.reader.next(ctx)
		if err != nil {
			a.removeSession(session.AgentSessionID, adapterSession)
			a.closeOrRetainClaudeSDKSession(session.AgentSessionID, adapterSession)
			return nil, err
		}
		eventCtx := context.Background()
		if event.inputUnit != nil {
			eventCtx = contextWithProviderInputUnit(eventCtx, *event.inputUnit)
		}
		endInputUnit := a.inputUnits.begin(eventCtx, session.AgentSessionID)
		next := a.applySidecarSessionEvent(adapterSession, session, event)
		next = a.inputUnits.stamp(session.AgentSessionID, next)
		endInputUnit()
		if next != nil {
			a.mu.Lock()
			adapterSession.session = applySessionEvents(session, next)
			a.mu.Unlock()
			// Controller.Start applies and publishes the returned events. Complete
			// asynchronously so an exact replay barrier can wait for that publish
			// without deadlocking inside Adapter.Start.
			go func() {
				if completeErr := completeClaudeSDKProviderInputUnit(
					context.Background(),
					adapterSession.conn,
					event,
				); completeErr != nil {
					a.failClaudeSDKReader(
						session.AgentSessionID,
						adapterSession,
						completeErr,
					)
				}
			}()
			return next, nil
		}
		if err := completeClaudeSDKProviderInputUnit(
			ctx,
			adapterSession.conn,
			event,
		); err != nil {
			a.removeSession(session.AgentSessionID, adapterSession)
			a.closeOrRetainClaudeSDKSession(session.AgentSessionID, adapterSession)
			return nil, err
		}
		if event.Type == "error" {
			a.removeSession(session.AgentSessionID, adapterSession)
			a.closeOrRetainClaudeSDKSession(session.AgentSessionID, adapterSession)
			return nil, errors.New(payloadString(event.Payload, "error"))
		}
	}
}

func claudeSDKMCPServers(bindings []MCPServerBinding) map[string]any {
	result := make(map[string]any)
	for _, binding := range bindings {
		name := strings.TrimSpace(binding.Name)
		if name == "" || strings.TrimSpace(binding.Type) != "http" || strings.TrimSpace(binding.URL) == "" {
			continue
		}
		headers := make(map[string]string, len(binding.Headers))
		for key, value := range binding.Headers {
			headers[key] = value
		}
		result[name] = map[string]any{"type": "http", "url": binding.URL, "headers": headers}
	}
	return result
}

func (a *ClaudeCodeSDKAdapter) Resume(ctx context.Context, session Session) error {
	if strings.TrimSpace(session.ProviderSessionID) == "" {
		return ErrSessionDisconnected
	}
	unlock := a.lockClaudeSDKSessionLifecycle(session.AgentSessionID)
	defer unlock()
	if err := a.admitClaudeSDKReplacementLocked(session.AgentSessionID); err != nil {
		return err
	}
	_, err := a.replaceClaudeSDKSessionLocked(ctx, session)
	return classifyClaudeSDKResumeError(session, err)
}

func (*ClaudeCodeSDKAdapter) CanResume(session Session) bool {
	return strings.TrimSpace(session.ProviderSessionID) != ""
}

func (a *ClaudeCodeSDKAdapter) Close(ctx context.Context, session Session) error {
	unlock := a.lockClaudeSDKSessionLifecycle(session.AgentSessionID)
	defer unlock()
	return a.closeClaudeSDKSession(ctx, session)
}

func (a *ClaudeCodeSDKAdapter) closeClaudeSDKSession(ctx context.Context, session Session) error {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil
	}
	a.mu.Lock()
	readerStarted := adapterSession.readerStarted
	a.mu.Unlock()
	if !readerStarted {
		if err := a.startClaudeSDKReader(session.AgentSessionID, adapterSession); err != nil {
			a.removeSession(session.AgentSessionID, adapterSession)
			a.closeOrRetainClaudeSDKSession(session.AgentSessionID, adapterSession)
			return err
		}
	}
	closeBaseCtx := context.WithoutCancel(ctx)
	var closeCtx context.Context
	var cancel context.CancelFunc
	if deadline, ok := ctx.Deadline(); ok {
		closeCtx, cancel = context.WithDeadline(closeBaseCtx, deadline)
	} else {
		closeCtx, cancel = context.WithTimeout(closeBaseCtx, claudeSDKCloseTimeout)
	}
	defer cancel()
	if err := a.roundTripClaudeSDK(closeCtx, session.AgentSessionID, adapterSession, claudeSDKSidecarRequest{
		ID:   newID(),
		Type: "close",
		Payload: map[string]any{
			"agentSessionId": session.AgentSessionID,
		},
	}); err != nil {
		a.removeSession(session.AgentSessionID, adapterSession)
		a.closeOrRetainClaudeSDKSession(session.AgentSessionID, adapterSession)
		return err
	}
	a.removeSession(session.AgentSessionID, adapterSession)
	if graceful, ok := adapterSession.conn.(GracefulProcessConnection); ok {
		_ = graceful.CloseInput()
	}
	if err := adapterSession.conn.Close(); err != nil {
		a.retainRetiredClaudeSDKSession(session.AgentSessionID, adapterSession)
		return err
	}
	return nil
}

func (a *ClaudeCodeSDKAdapter) HasLiveSession(session Session) bool {
	adapterSession := a.getSession(session.AgentSessionID)
	return a.sessionIsUsable(session.AgentSessionID, adapterSession)
}

func (a *ClaudeCodeSDKAdapter) ReleaseLiveSession(ctx context.Context, session Session) error {
	return a.Close(ctx, session)
}

// DisconnectLiveSession terminalizes provider-owned work through the same
// external-failure path as a broken sidecar connection, then closes only the
// transport. It deliberately does not send the sidecar "close" request,
// which is the graceful provider-session close contract.
func (a *ClaudeCodeSDKAdapter) DisconnectLiveSession(_ context.Context, session Session) error {
	unlock := a.lockClaudeSDKSessionLifecycle(session.AgentSessionID)
	defer unlock()
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil
	}
	a.failClaudeSDKReaderWithOwnership(
		session.AgentSessionID,
		adapterSession,
		ErrSessionDisconnected,
		true,
	)
	if err := adapterSession.conn.Close(); err != nil {
		return err
	}
	a.removeSession(session.AgentSessionID, adapterSession)
	return nil
}
