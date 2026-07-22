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
	if a == nil || a.transport == nil {
		return nil, ErrSessionDisconnected
	}
	restore := strings.TrimSpace(session.ProviderSessionID) != ""
	providerSessionID := firstNonEmpty(strings.TrimSpace(session.ProviderSessionID), newID())
	session.ProviderSessionID = providerSessionID
	spec, cleanup, err := prepareProviderLaunch(ctx, a.preparer, session, ProcessSpec{
		Provider:       ProviderClaudeCode,
		AgentSessionID: session.AgentSessionID,
		RoomID:         session.RoomID,
		CWD:            session.CWD,
		Command:        claudeSDKSidecarCommand(session.Env),
		Env:            claudeSDKSidecarEnv(session),
		DirectStart:    true,
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
	conn = wrapProviderLaunchCleanup(conn, cleanup)
	adapterSession := &claudeSDKAdapterSession{
		conn:              conn,
		reader:            &claudeSDKLineReader{conn: conn},
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
	startPayload := map[string]any{
		"agentSessionId":    session.AgentSessionID,
		"providerSessionId": providerSessionID,
		"cwd":               launchSession.CWD,
		"env":               envListToMap(launchSession.Env),
		"restore":           restore,
		"permissionModeId":  session.PermissionModeID,
		"settings":          claudeSDKSessionSettingsPayload(session),
		"resumeCursor":      claudeSDKResumeCursorFromSession(session),
	}
	for key, value := range claudeCodeSDKStartOptions(session) {
		startPayload[key] = value
	}
	if err := adapterSession.send(claudeSDKSidecarRequest{
		ID:      newID(),
		Type:    "start",
		Payload: startPayload,
	}); err != nil {
		_ = conn.Close()
		a.removeSession(session.AgentSessionID, adapterSession)
		return nil, err
	}

	for {
		event, err := adapterSession.reader.next(ctx)
		if err != nil {
			_ = conn.Close()
			a.removeSession(session.AgentSessionID, adapterSession)
			return nil, err
		}
		if next := a.applySidecarSessionEvent(adapterSession, session, event); next != nil {
			a.mu.Lock()
			adapterSession.session = applySessionEvents(session, next)
			a.mu.Unlock()
			return next, nil
		}
		if event.Type == "error" {
			_ = conn.Close()
			a.removeSession(session.AgentSessionID, adapterSession)
			return nil, errors.New(payloadString(event.Payload, "error"))
		}
	}
}

func (a *ClaudeCodeSDKAdapter) Resume(ctx context.Context, session Session) error {
	if strings.TrimSpace(session.ProviderSessionID) == "" {
		return ErrSessionDisconnected
	}
	previous := a.getSession(session.AgentSessionID)
	_, err := a.Start(ctx, session)
	if err != nil && previous != nil {
		a.restorePreviousSession(session.AgentSessionID, previous)
	}
	if err == nil && previous != nil {
		a.removeSession(session.AgentSessionID, previous)
		_ = previous.conn.Close()
	}
	return classifyClaudeSDKResumeError(session, err)
}

func (*ClaudeCodeSDKAdapter) CanResume(session Session) bool {
	return strings.TrimSpace(session.ProviderSessionID) != ""
}

func (a *ClaudeCodeSDKAdapter) Close(ctx context.Context, session Session) error {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil
	}
	closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), claudeSDKCloseTimeout)
	defer cancel()
	if err := a.roundTripClaudeSDK(closeCtx, session.AgentSessionID, adapterSession, claudeSDKSidecarRequest{
		ID:   newID(),
		Type: "close",
		Payload: map[string]any{
			"agentSessionId": session.AgentSessionID,
		},
	}); err != nil {
		if errors.Is(err, ErrSessionDisconnected) {
			a.removeSession(session.AgentSessionID, adapterSession)
			_ = adapterSession.conn.Close()
		}
		return err
	}
	a.removeSession(session.AgentSessionID, adapterSession)
	if graceful, ok := adapterSession.conn.(GracefulProcessConnection); ok {
		_ = graceful.CloseInput()
	}
	return adapterSession.conn.Close()
}

func (a *ClaudeCodeSDKAdapter) HasLiveSession(session Session) bool {
	adapterSession := a.getSession(session.AgentSessionID)
	return a.sessionIsUsable(session.AgentSessionID, adapterSession)
}

func (a *ClaudeCodeSDKAdapter) ReleaseLiveSession(ctx context.Context, session Session) error {
	return a.Close(ctx, session)
}
