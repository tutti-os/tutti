//revive:disable:file-length-limit
package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	goruntime "runtime"
	"sort"
	"strings"
	"sync"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

const (
	claudeCodeRuntimeEnv           = "TUTTI_CLAUDE_CODE_RUNTIME"
	claudeCodeRuntimeACP           = "acp"
	claudeCodeRuntimeSDK           = "sdk"
	claudeSDKSidecarCommandEnv     = "TUTTI_CLAUDE_SDK_SIDECAR_COMMAND"
	claudeSDKSidecarEntryPathEnv   = "TUTTI_CLAUDE_SDK_SIDECAR_ENTRY_PATH"
	claudeSDKSidecarTestDriverEnv  = "TUTTI_CLAUDE_SDK_SIDECAR_TEST_DRIVER"
	claudeSDKAppNodeEnv            = "TUTTI_APP_NODE"
	claudeSDKAppRuntimeRootEnv     = "TUTTI_APP_RUNTIME_ROOT"
	claudeSDKAppRuntimeCacheEnv    = "TUTTI_APP_RUNTIME_CACHE_ROOT"
	claudeSDKSidecarAdapterName    = "claude-agent-sdk"
	claudeSDKSidecarDefaultNodeArg = "--experimental-strip-types"
	claudeSDKDefaultContextWindow  = int64(200000)
	claudeSDK1MContextWindow       = int64(1000000)
	claudeSDKAuthRefreshLogPrefix  = "CLAUDE_CODE_AUTH_REFRESH_DEBUG"
)

type ClaudeCodeSDKAdapter struct {
	transport ProcessTransport
	preparer  ProviderLaunchPreparer

	mu          sync.Mutex
	sessions    map[string]*claudeSDKAdapterSession
	commandSink CommandSnapshotSink
	eventSink   SessionEventSink
}

type claudeSDKAdapterSession struct {
	conn              ProcessConnection
	reader            *claudeSDKLineReader
	session           Session
	providerSessionID string
	resumeCursor      map[string]any
	backgroundAgents  map[string]claudeSDKBackgroundAgent
	assistantMessages map[string]string
	thinkingMessages  map[string]string
	compactMessages   map[string]string
	pendingRequests   map[string]*pendingACPRequest
	pendingResponses  map[string]chan claudeSDKSidecarEvent
	turns             map[string]*claudeSDKTurnWaiter
	liveState         acpLiveState
	sendMu            sync.Mutex
	readerStarted     bool
	// lifecycleSeq numbers the adapter's TurnLifecycle snapshots (ADR 0008):
	// monotonically increasing per session so consumers receiving snapshots
	// over different channels (the Exec emit closure and the session event
	// sink) can drop stale ones. Guarded by the adapter mutex.
	lifecycleSeq uint64
	// settledTurns remembers turn IDs whose terminal event already left this
	// adapter, so a late Cancel re-states the settled snapshot instead of
	// fabricating a competing terminal transition. Guarded by the adapter
	// mutex.
	settledTurns map[string]string
	// goalArmTurnID is the sidecar turn carrying a queued /goal set command
	// that has not settled yet; until it does, other turns settling must not
	// be read as goal completion. Guarded by the adapter mutex.
	goalArmTurnID string
}

type claudeSDKBackgroundAgent struct {
	Key               string
	ParentToolUseID   string
	TurnID            string
	TaskID            string
	AgentID           string
	Description       string
	Status            string
	Summary           string
	LastToolName      string
	StartedAtUnixMS   int64
	UpdatedAtUnixMS   int64
	CompletedAtUnixMS int64
}

type claudeSDKTurnWaiter struct {
	turnID string
	emit   EventSink
	events []activityshared.Event
	done   chan claudeSDKTurnResult
}

type claudeSDKTurnResult struct {
	events []activityshared.Event
	err    error
}

type claudeSDKSidecarRequest struct {
	ID      string         `json:"id,omitempty"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload,omitempty"`
}

type claudeSDKSidecarEvent struct {
	ID      string         `json:"id,omitempty"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload,omitempty"`
}

type claudeSDKLineReader struct {
	conn   ProcessConnection
	buffer string
}

func NewClaudeCodeSDKAdapter(transport ProcessTransport) *ClaudeCodeSDKAdapter {
	return &ClaudeCodeSDKAdapter{
		transport: transport,
		sessions:  make(map[string]*claudeSDKAdapterSession),
	}
}

func (*ClaudeCodeSDKAdapter) Provider() string {
	return ProviderClaudeCode
}

func (a *ClaudeCodeSDKAdapter) SetProviderLaunchPreparer(preparer ProviderLaunchPreparer) {
	if a == nil {
		return
	}
	a.preparer = preparer
}

func (a *ClaudeCodeSDKAdapter) Start(ctx context.Context, session Session) ([]activityshared.Event, error) {
	if a == nil || a.transport == nil {
		return nil, ErrSessionDisconnected
	}
	restore := strings.TrimSpace(session.ProviderSessionID) != ""
	providerSessionID := firstNonEmpty(strings.TrimSpace(session.ProviderSessionID), newID())
	session.ProviderSessionID = providerSessionID
	claudeMeta, err := buildClaudeCodeSessionMeta(session)
	if err != nil {
		return nil, err
	}
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
		compactMessages:   make(map[string]string),
		pendingRequests:   make(map[string]*pendingACPRequest),
		pendingResponses:  make(map[string]chan claudeSDKSidecarEvent),
		turns:             make(map[string]*claudeSDKTurnWaiter),
		liveState:         newClaudeSDKLiveState(),
	}
	a.storeSession(session.AgentSessionID, adapterSession)
	a.emitCommandSnapshot(claudeSDKCommandSnapshot(session.AgentSessionID, adapterSession.liveState))
	startPayload := map[string]any{
		"agentSessionId":    session.AgentSessionID,
		"providerSessionId": providerSessionID,
		"cwd":               session.CWD,
		"env":               envListToMap(session.Env),
		"restore":           restore,
		"permissionModeId":  session.PermissionModeID,
		"settings":          claudeSDKSessionSettingsPayload(session),
		"resumeCursor":      claudeSDKResumeCursorFromSession(session),
	}
	for key, value := range claudeMeta.sdkPayload() {
		startPayload[key] = value
	}
	if err := adapterSession.send(claudeSDKSidecarRequest{
		ID:      newID(),
		Type:    "start",
		Payload: startPayload,
	}); err != nil {
		_ = conn.Close()
		a.removeSession(session.AgentSessionID)
		return nil, err
	}

	for {
		event, err := adapterSession.reader.next(ctx)
		if err != nil {
			_ = conn.Close()
			a.removeSession(session.AgentSessionID)
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
			a.removeSession(session.AgentSessionID)
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
		a.storeSession(session.AgentSessionID, previous)
	}
	if err == nil && previous != nil {
		_ = previous.conn.Close()
	}
	return classifyClaudeSDKResumeError(session, err)
}

func (*ClaudeCodeSDKAdapter) CanResume(session Session) bool {
	return strings.TrimSpace(session.ProviderSessionID) != ""
}

func (a *ClaudeCodeSDKAdapter) Close(_ context.Context, session Session) error {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil
	}
	_ = adapterSession.send(claudeSDKSidecarRequest{
		ID:   newID(),
		Type: "close",
		Payload: map[string]any{
			"agentSessionId": session.AgentSessionID,
		},
	})
	a.removeSession(session.AgentSessionID)
	if graceful, ok := adapterSession.conn.(GracefulProcessConnection); ok {
		_ = graceful.CloseInput()
	}
	return adapterSession.conn.Close()
}

func (*ClaudeCodeSDKAdapter) ValidatePromptContent(_ Session, content []PromptContentBlock) error {
	if !promptContentHasImage(content) {
		return nil
	}
	for _, block := range content {
		if strings.TrimSpace(block.Type) != "image" {
			continue
		}
		if !runtimePromptImageMimeTypeSupported(strings.TrimSpace(block.MimeType)) ||
			(strings.TrimSpace(block.Data) == "" && strings.TrimSpace(block.AttachmentID) == "") {
			return ErrPromptImageUnsupported
		}
	}
	return nil
}

func (a *ClaudeCodeSDKAdapter) Exec(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	_ CommandSnapshotSink,
) ([]activityshared.Event, error) {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil, ErrSessionDisconnected
	}
	session.ProviderSessionID = adapterSession.providerSessionID
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, displayPrompt)
	events := make([]activityshared.Event, 0, 4)
	emitEvents := func(next []activityshared.Event) {
		if len(next) == 0 {
			return
		}
		events = append(events, next...)
		if emit != nil {
			emit(next)
		}
	}
	startEvents := make([]activityshared.Event, 0, 3)
	if fallbackTitle := fallbackACPFamilySessionTitle(session.Title, visibleText, "", ProviderClaudeCode); fallbackTitle != "" {
		startEvents = append(startEvents, newSessionTitleActivityEvent(session, fallbackTitle))
		session.Title = fallbackTitle
	}
	startEvents = append(startEvents,
		newTurnActivityEvent(session, EventMessage, turnID, "", RoleUser, visibleText, userPromptActivityPayload(content, explicitDisplayPrompt, userPromptActivityPayloadExtraFromExecMetadata(ctx, map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
		}))),
		newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
		}),
	)
	if event, ok := adapterSession.mirrorGoalSlashPrompt(session, visibleText); ok {
		startEvents = append(startEvents, event)
	}
	emitEvents(a.stampTurnLifecycleSnapshots(adapterSession, startEvents))

	waiter := a.registerClaudeSDKTurn(adapterSession, turnID, emit)
	if err := a.startClaudeSDKReader(session.AgentSessionID, adapterSession); err != nil {
		a.unregisterClaudeSDKTurn(adapterSession, turnID, waiter)
		return events, err
	}
	if err := adapterSession.send(claudeSDKSidecarRequest{
		ID:   newID(),
		Type: "exec",
		Payload: map[string]any{
			"agentSessionId": session.AgentSessionID,
			"turnId":         turnID,
			// Keep prompt as a short-lived text fallback for older sidecars.
			"prompt":  promptTextForClaudeSDK(content, visibleText),
			"content": promptContentForClaudeSDK(content, visibleText),
		},
	}); err != nil {
		a.unregisterClaudeSDKTurn(adapterSession, turnID, waiter)
		return events, err
	}

	select {
	case result := <-waiter.done:
		if len(result.events) > 0 {
			events = append(events, result.events...)
		}
		return events, result.err
	case <-ctx.Done():
		a.unregisterClaudeSDKTurn(adapterSession, turnID, waiter)
		return events, ctx.Err()
	}
}

func (a *ClaudeCodeSDKAdapter) Cancel(_ context.Context, session Session, turnID string) ([]activityshared.Event, error) {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil, nil
	}
	_ = adapterSession.send(claudeSDKSidecarRequest{
		ID:   newID(),
		Type: "cancel",
		Payload: map[string]any{
			"agentSessionId": session.AgentSessionID,
		},
	})
	events := a.claudeSDKPendingRequestFailureEvents(adapterSession, session, turnID, errPermissionRequestCanceled)
	// Only synthesize a terminal transition for a turn that is still live; a
	// cancel racing the turn's own settle otherwise emits a second,
	// contradicting terminal event (the stuck-view class ADR 0008 removes).
	if trimmed := strings.TrimSpace(turnID); trimmed != "" && !a.turnAlreadySettled(adapterSession, trimmed) {
		events = append(events, newTurnActivityEvent(session, EventTurnCanceled, trimmed, SessionStatusCanceled, "", "", map[string]any{
			"reason": "user",
		}))
	}
	return a.stampTurnLifecycleSnapshots(adapterSession, events), nil
}

func (a *ClaudeCodeSDKAdapter) ApplySessionSettings(
	ctx context.Context,
	session Session,
	patch SessionSettingsPatch,
) error {
	payload := map[string]any{
		"agentSessionId": session.AgentSessionID,
	}
	if patch.PlanMode != nil {
		payload["planMode"] = *patch.PlanMode
		payload["permissionMode"] = claudeSDKEffectivePermissionMode(session)
	}
	if patch.Model != nil {
		payload["model"] = strings.TrimSpace(*patch.Model)
	}
	if patch.ReasoningEffort != nil {
		payload["effort"] = strings.TrimSpace(*patch.ReasoningEffort)
	}
	if patch.Speed != nil {
		if speed := claudeSDKCanonicalSpeed(*patch.Speed); speed != "" {
			payload["speed"] = speed
		}
	}
	if len(payload) == 1 {
		return nil
	}
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil
	}
	request := claudeSDKSidecarRequest{
		ID:      newID(),
		Type:    "apply_settings",
		Payload: payload,
	}
	if err := a.roundTripClaudeSDK(ctx, session.AgentSessionID, adapterSession, request); err != nil {
		return err
	}
	adapterSession.applySettingsPayload(payload)
	return nil
}

func (a *ClaudeCodeSDKAdapter) ApplyPermissionMode(ctx context.Context, session Session) error {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil
	}
	mode := claudeSDKEffectivePermissionMode(session)
	if mode == "" {
		return nil
	}
	request := claudeSDKSidecarRequest{
		ID:   newID(),
		Type: "apply_settings",
		Payload: map[string]any{
			"agentSessionId": session.AgentSessionID,
			"permissionMode": mode,
			"planMode":       session.SettingsValue().PlanMode,
		},
	}
	if err := a.roundTripClaudeSDK(ctx, session.AgentSessionID, adapterSession, request); err != nil {
		return err
	}
	adapterSession.applyPermissionMode(mode)
	return nil
}

func (*ClaudeCodeSDKAdapter) RequiresNewSessionForSettings(Session, SessionSettingsPatch) bool {
	return false
}

func (a *ClaudeCodeSDKAdapter) HasLiveSession(session Session) bool {
	return a.getSession(session.AgentSessionID) != nil
}

func (a *ClaudeCodeSDKAdapter) ReleaseLiveSession(ctx context.Context, session Session) error {
	return a.Close(ctx, session)
}

func (a *ClaudeCodeSDKAdapter) SessionState(session Session) SessionStateSnapshot {
	adapterSession := a.getSession(session.AgentSessionID)
	return SessionStateSnapshot{
		RoomID:             session.RoomID,
		AgentSessionID:     session.AgentSessionID,
		Provider:           session.Provider,
		ProviderSessionID:  session.ProviderSessionID,
		Status:             session.Status,
		TurnLifecycle:      cloneRuntimeTurnLifecycle(session.TurnLifecycle),
		SubmitAvailability: cloneRuntimeSubmitAvailability(session.SubmitAvailability),
		PermissionModeID:   session.PermissionModeID,
		Settings:           cloneOptionalSessionSettings(session.Settings),
		RuntimeContext:     claudeSDKRuntimeContext(session, adapterSession),
		PendingInteractive: a.claudeSDKPendingInteractive(adapterSession),
		UpdatedAtUnixMS:    session.UpdatedAtUnixMS,
	}
}

func (a *ClaudeCodeSDKAdapter) SetCommandSnapshotSink(sink CommandSnapshotSink) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.commandSink = sink
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) SetSessionEventSink(sink SessionEventSink) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.eventSink = sink
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) SessionCommandSnapshot(session Session) (AgentSessionCommandSnapshot, bool) {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return AgentSessionCommandSnapshot{}, false
	}
	return adapterSession.commandSnapshot(session.AgentSessionID)
}

func (*ClaudeCodeSDKAdapter) applySidecarSessionEvent(adapterSession *claudeSDKAdapterSession, session Session, event claudeSDKSidecarEvent) []activityshared.Event {
	if event.Type == "usage_updated" {
		adapterSession.applyUsageUpdated(event.Payload)
		return nil
	}
	if event.Type != "session_started" && event.Type != "session_state" {
		return nil
	}
	adapterSession.applySessionPayload(&session, event.Payload)
	if event.Type != "session_started" {
		return nil
	}
	return []activityshared.Event{newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, claudeSDKRuntimeContext(session, adapterSession))}
}

func (a *ClaudeCodeSDKAdapter) sidecarTurnEvents(adapterSession *claudeSDKAdapterSession, session Session, turnID string, event claudeSDKSidecarEvent) ([]activityshared.Event, bool, error) {
	adapterSession.applySessionPayload(&session, event.Payload)
	turnID = strings.TrimSpace(turnID)
	eventTurnID := firstNonEmptyString(payloadString(event.Payload, "turnId"), payloadString(event.Payload, "turnID"))
	if eventTurnID != "" && turnID != "" && eventTurnID != turnID {
		return nil, false, nil
	}
	if turnID == "" {
		turnID = eventTurnID
	}
	turnID = adapterSession.backgroundAgentTurnID(event.Payload, turnID)
	switch event.Type {
	case "ok":
		return nil, false, nil
	case "session_state":
		return []activityshared.Event{newSessionActivityEvent(session, EventSessionUpdated, firstNonEmpty(session.Status, SessionStatusReady), claudeSDKRuntimeContext(session, adapterSession))}, false, nil
	case "turn_started":
		metadata := map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
		}
		if payloadBoolValue(event.Payload, "synthetic") {
			metadata["synthetic"] = true
		}
		return []activityshared.Event{newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", metadata)}, false, nil
	case "commands_updated":
		if adapterSession.applyCommandsUpdated(session.AgentSessionID, event.Payload) {
			a.emitCommandSnapshot(claudeSDKCommandSnapshot(session.AgentSessionID, adapterSession.liveState))
		}
		return nil, false, nil
	case "session_title_updated":
		if titleEvent, ok := acpSessionTitleEvent(session, event.Payload); ok {
			return []activityshared.Event{titleEvent}, false, nil
		}
		return nil, false, nil
	case "error":
		return nil, false, errors.New(payloadString(event.Payload, "error"))
	case "approval_requested", "user_input_requested":
		events, err := a.claudeSDKInteractiveRequested(adapterSession, session, turnID, event.Payload)
		return events, false, err
	case "approval_resolved", "user_input_resolved":
		return a.claudeSDKInteractiveResolved(adapterSession, session, turnID, event.Payload), false, nil
	case "compact_started":
		return []activityshared.Event{adapterSession.compactMessageEvent(session, turnID, messageStreamStateStreaming, firstNonEmpty(payloadString(event.Payload, "content"), "Compacting..."))}, false, nil
	case "compact_completed":
		return []activityshared.Event{adapterSession.compactMessageEvent(session, turnID, messageStreamStateCompleted, firstNonEmpty(payloadString(event.Payload, "content"), "Compacting completed."))}, false, nil
	case "compact_failed":
		content := firstNonEmpty(payloadString(event.Payload, "content"), "Compacting failed.")
		return []activityshared.Event{adapterSession.compactMessageEvent(session, turnID, messageStreamStateFailed, content)}, false, nil
	case "assistant_delta":
		messageID := firstNonEmptyString(payloadString(event.Payload, "messageId"), adapterSession.assistantMessageID(turnID))
		content := firstNonEmpty(payloadString(event.Payload, "snapshot"), payloadString(event.Payload, "content"))
		return []activityshared.Event{newTurnActivityEventWithID(session, messageID, EventMessage, turnID, messageStreamStateStreaming, RoleAssistant, content, map[string]any{
			"adapter":     claudeSDKSidecarAdapterName,
			"messageId":   messageID,
			"contentMode": messageContentModeSnapshot,
		})}, false, nil
	case "assistant_completed":
		messageID := firstNonEmptyString(payloadString(event.Payload, "messageId"), adapterSession.assistantMessageID(turnID))
		return []activityshared.Event{newTurnActivityEventWithID(session, messageID, EventMessage, turnID, messageStreamStateCompleted, RoleAssistant, payloadString(event.Payload, "content"), map[string]any{
			"adapter":     claudeSDKSidecarAdapterName,
			"messageId":   messageID,
			"contentMode": messageContentModeSnapshot,
		})}, false, nil
	case "thinking_delta":
		messageID := firstNonEmptyString(payloadString(event.Payload, "messageId"), adapterSession.thinkingMessageID(turnID))
		content := firstNonEmpty(payloadString(event.Payload, "snapshot"), payloadString(event.Payload, "content"))
		return []activityshared.Event{newTurnActivityEventWithID(session, messageID, EventMessage, turnID, messageStreamStateStreaming, RoleAssistantThinking, content, map[string]any{
			"adapter":     claudeSDKSidecarAdapterName,
			"messageId":   messageID,
			"contentMode": messageContentModeSnapshot,
		})}, false, nil
	case "thinking_completed":
		messageID := firstNonEmptyString(payloadString(event.Payload, "messageId"), adapterSession.thinkingMessageID(turnID))
		return []activityshared.Event{newTurnActivityEventWithID(session, messageID, EventMessage, turnID, messageStreamStateCompleted, RoleAssistantThinking, payloadString(event.Payload, "content"), map[string]any{
			"adapter":     claudeSDKSidecarAdapterName,
			"messageId":   messageID,
			"contentMode": messageContentModeSnapshot,
		})}, false, nil
	case "tool_started", "tool_updated":
		return adapterSession.claudeSDKToolEvents(session, turnID, event.Payload, EventCallStarted, messageStreamStateStreaming, event.Type), false, nil
	case "tool_completed":
		return adapterSession.claudeSDKToolEvents(session, turnID, event.Payload, EventCallCompleted, messageStreamStateCompleted, event.Type), false, nil
	case "tool_failed":
		return adapterSession.claudeSDKToolEvents(session, turnID, event.Payload, EventCallFailed, messageStreamStateFailed, event.Type), false, nil
	case "task_started", "task_progress", "task_completed":
		return adapterSession.claudeSDKTaskLifecycleEvents(session, turnID, event.Type, event.Payload), false, nil
	case "plan_updated":
		return claudeSDKPlanEvents(session, turnID, event.Payload), false, nil
	case "usage_updated":
		if adapterSession.applyUsageUpdated(event.Payload) {
			if event, ok := acpUsageUpdatedEvent(session); ok {
				return []activityshared.Event{event}, false, nil
			}
		}
		return nil, false, nil
	case "speed_updated":
		if adapterSession.applySpeedUpdated(event.Payload) {
			if event, ok := acpConfigOptionsUpdatedEvent(session, map[string]any{"key": "fast"}); ok {
				return []activityshared.Event{event}, false, nil
			}
		}
		return nil, false, nil
	case "goal_updated":
		updateType := adapterSession.applyGoalUpdated(event.Payload)
		if updateType == "" {
			return nil, false, nil
		}
		events := make([]activityshared.Event, 0, 2)
		if goalEvent, ok := acpGoalUpdatedEvent(session, updateType); ok {
			events = append(events, goalEvent)
		}
		events = append(events, newSessionActivityEvent(session, EventSessionUpdated, firstNonEmpty(session.Status, SessionStatusReady), claudeSDKRuntimeContext(session, adapterSession)))
		return events, false, nil
	case "turn_completed":
		events := []activityshared.Event{newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", map[string]any{
			"adapter":    claudeSDKSidecarAdapterName,
			"stopReason": firstNonEmpty(payloadString(event.Payload, "stopReason"), "end_turn"),
		})}
		events = append(events, a.goalEventsOnTurnSettled(adapterSession, session, turnID, true)...)
		return events, true, nil
	case "turn_canceled":
		events := []activityshared.Event{newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
		})}
		events = append(events, a.goalEventsOnTurnSettled(adapterSession, session, turnID, false)...)
		return events, true, nil
	case "turn_failed":
		events := []activityshared.Event{newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
			"error":   payloadString(event.Payload, "error"),
		})}
		events = append(events, a.goalEventsOnTurnSettled(adapterSession, session, turnID, false)...)
		return events, true, nil
	default:
		return nil, false, nil
	}
}

func (a *ClaudeCodeSDKAdapter) startClaudeSDKReader(agentSessionID string, adapterSession *claudeSDKAdapterSession) error {
	if a == nil || adapterSession == nil || adapterSession.reader == nil {
		return ErrSessionDisconnected
	}
	a.mu.Lock()
	if adapterSession.readerStarted {
		a.mu.Unlock()
		return nil
	}
	adapterSession.readerStarted = true
	a.mu.Unlock()
	go a.runClaudeSDKReader(agentSessionID, adapterSession)
	return nil
}

func (a *ClaudeCodeSDKAdapter) runClaudeSDKReader(agentSessionID string, adapterSession *claudeSDKAdapterSession) {
	for {
		event, err := adapterSession.reader.next(context.Background())
		if err != nil {
			a.failClaudeSDKReader(agentSessionID, adapterSession, err)
			return
		}
		a.dispatchClaudeSDKEvent(agentSessionID, adapterSession, event)
	}
}

// nextTurnLifecycleSeq allocates the next per-session lifecycle snapshot
// sequence number.
func (a *ClaudeCodeSDKAdapter) nextTurnLifecycleSeq(adapterSession *claudeSDKAdapterSession) uint64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	adapterSession.lifecycleSeq++
	return adapterSession.lifecycleSeq
}

// stampTurnLifecycleSnapshots stamps an adapter-origin TurnLifecycle snapshot
// onto every turn.* event in the batch (ADR 0008); see
// stampAdapterTurnLifecycleEvents for the contract. It also records terminal
// transitions so Cancel can tell an already-settled turn apart from a live
// one.
func (a *ClaudeCodeSDKAdapter) stampTurnLifecycleSnapshots(adapterSession *claudeSDKAdapterSession, events []activityshared.Event) []activityshared.Event {
	if a == nil || adapterSession == nil || len(events) == 0 {
		return events
	}
	events = stampAdapterTurnLifecycleEvents(events, func() uint64 {
		return a.nextTurnLifecycleSeq(adapterSession)
	})
	a.mu.Lock()
	for _, event := range events {
		switch event.Type {
		// turn.canceled folds into turn.completed with an interrupted
		// outcome at construction (newTurnActivityEventWithID), so these two
		// cover every terminal transition.
		case activityshared.EventTurnCompleted, activityshared.EventTurnFailed:
			turnID := strings.TrimSpace(event.Payload.TurnID)
			if turnID == "" {
				continue
			}
			if adapterSession.settledTurns == nil {
				adapterSession.settledTurns = make(map[string]string)
			}
			// Sessions are long-lived; keep the guard bounded rather than
			// growing one entry per turn forever.
			if len(adapterSession.settledTurns) > 64 {
				adapterSession.settledTurns = make(map[string]string)
			}
			outcome := strings.TrimSpace(event.Payload.TurnOutcome)
			if outcome == "" {
				if snapshot, ok := activityshared.TurnLifecycleSnapshotFromEvent(event); ok {
					outcome = snapshot.Outcome
				}
			}
			adapterSession.settledTurns[turnID] = outcome
		}
	}
	a.mu.Unlock()
	return events
}

// turnAlreadySettled reports whether a terminal event for the turn already
// left this adapter.
func (a *ClaudeCodeSDKAdapter) turnAlreadySettled(adapterSession *claudeSDKAdapterSession, turnID string) bool {
	if a == nil || adapterSession == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	_, settled := adapterSession.settledTurns[strings.TrimSpace(turnID)]
	return settled
}

func (a *ClaudeCodeSDKAdapter) dispatchClaudeSDKEvent(agentSessionID string, adapterSession *claudeSDKAdapterSession, event claudeSDKSidecarEvent) {
	if a == nil || adapterSession == nil {
		return
	}
	if response := a.takeClaudeSDKResponseWaiter(adapterSession, event); response != nil {
		response <- event
		return
	}
	turnID := payloadString(event.Payload, "turnId")
	if turnID == "" {
		turnID = payloadString(event.Payload, "turnID")
	}
	waiter := a.claudeSDKTurnWaiter(adapterSession, turnID)
	session := a.claudeSDKSessionSnapshot(adapterSession)
	if strings.TrimSpace(session.AgentSessionID) == "" {
		session.AgentSessionID = agentSessionID
	}
	next, terminal, err := a.sidecarTurnEvents(adapterSession, session, turnID, event)
	next = a.stampTurnLifecycleSnapshots(adapterSession, next)
	if len(next) > 0 {
		a.updateClaudeSDKSessionSnapshot(adapterSession, next)
	}
	if waiter != nil {
		a.completeClaudeSDKWaiterEvent(adapterSession, waiter, turnID, next, terminal, err)
		return
	}
	if terminal {
		// No daemon-registered Exec()/ExecAsync() waiter is tracking this
		// turnID's outcome: either its terminal event was already delivered
		// once (the waiter already completed and was unregistered) or this
		// turn never became the tracked active turn in the first place (for
		// example an internal/queued Claude SDK turn — see turnQueue /
		// settleQueuedTurn in the sidecar — that got settled without ever
		// being submitted through Exec). Publishing it here would surface a
		// stray, possibly contradictory outcome notification for the session:
		// a phantom completed/failed toast landing alongside the real turn's
		// own outcome toast for the same agent session. Drop it instead.
		return
	}
	if err != nil {
		next = append(next, newSessionActivityEvent(session, EventSessionFailed, SessionStatusFailed, map[string]any{
			"error": err.Error(),
		}))
	}
	a.emitClaudeSDKSessionEvents(agentSessionID, next)
}

func (a *ClaudeCodeSDKAdapter) registerClaudeSDKTurn(adapterSession *claudeSDKAdapterSession, turnID string, emit EventSink) *claudeSDKTurnWaiter {
	waiter := &claudeSDKTurnWaiter{
		turnID: strings.TrimSpace(turnID),
		emit:   emit,
		done:   make(chan claudeSDKTurnResult, 1),
	}
	a.mu.Lock()
	if adapterSession.turns == nil {
		adapterSession.turns = make(map[string]*claudeSDKTurnWaiter)
	}
	adapterSession.turns[waiter.turnID] = waiter
	a.mu.Unlock()
	return waiter
}

func (a *ClaudeCodeSDKAdapter) unregisterClaudeSDKTurn(adapterSession *claudeSDKAdapterSession, turnID string, waiter *claudeSDKTurnWaiter) {
	if a == nil || adapterSession == nil || waiter == nil {
		return
	}
	a.mu.Lock()
	if current := adapterSession.turns[strings.TrimSpace(turnID)]; current == waiter {
		delete(adapterSession.turns, strings.TrimSpace(turnID))
	}
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) claudeSDKTurnWaiter(adapterSession *claudeSDKAdapterSession, turnID string) *claudeSDKTurnWaiter {
	if a == nil || adapterSession == nil || strings.TrimSpace(turnID) == "" {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return adapterSession.turns[strings.TrimSpace(turnID)]
}

func (a *ClaudeCodeSDKAdapter) completeClaudeSDKWaiterEvent(
	adapterSession *claudeSDKAdapterSession,
	waiter *claudeSDKTurnWaiter,
	turnID string,
	events []activityshared.Event,
	terminal bool,
	err error,
) {
	if waiter == nil {
		return
	}
	if len(events) > 0 {
		waiter.events = append(waiter.events, events...)
		if waiter.emit != nil {
			waiter.emit(events)
		}
	}
	if err == nil && !terminal {
		return
	}
	a.unregisterClaudeSDKTurn(adapterSession, turnID, waiter)
	waiter.done <- claudeSDKTurnResult{
		events: append([]activityshared.Event(nil), waiter.events...),
		err:    err,
	}
}

func (a *ClaudeCodeSDKAdapter) failClaudeSDKReader(agentSessionID string, adapterSession *claudeSDKAdapterSession, err error) {
	if a == nil || adapterSession == nil {
		return
	}
	a.mu.Lock()
	turns := make([]*claudeSDKTurnWaiter, 0, len(adapterSession.turns))
	for turnID, waiter := range adapterSession.turns {
		turns = append(turns, waiter)
		delete(adapterSession.turns, turnID)
	}
	responses := make([]chan claudeSDKSidecarEvent, 0, len(adapterSession.pendingResponses))
	for id, response := range adapterSession.pendingResponses {
		responses = append(responses, response)
		delete(adapterSession.pendingResponses, id)
	}
	a.mu.Unlock()
	for _, waiter := range turns {
		waiter.done <- claudeSDKTurnResult{
			events: append([]activityshared.Event(nil), waiter.events...),
			err:    err,
		}
	}
	for _, response := range responses {
		response <- claudeSDKSidecarEvent{Type: "error", Payload: map[string]any{"error": err.Error()}}
	}
	// Any interactive/permission request still awaiting a human decision when
	// the sidecar connection is lost must be resolved explicitly. Without
	// this, the pending approval bookkeeping is discarded silently along
	// with the session (below), leaving the GUI's permission dialog with no
	// terminal event: on the next reconnect/resume it simply vanishes with
	// no explanation while the turn itself fails, giving the appearance that
	// the request was answered (or bypassed) when it never was.
	session := a.claudeSDKSessionSnapshot(adapterSession)
	if strings.TrimSpace(session.AgentSessionID) == "" {
		session.AgentSessionID = agentSessionID
	}
	pendingFailureEvents := a.claudeSDKPendingRequestFailureEvents(adapterSession, session, "", err)
	a.removeSession(agentSessionID)
	a.emitClaudeSDKSessionEvents(agentSessionID, pendingFailureEvents)
}

func (a *ClaudeCodeSDKAdapter) takeClaudeSDKResponseWaiter(adapterSession *claudeSDKAdapterSession, event claudeSDKSidecarEvent) chan claudeSDKSidecarEvent {
	if a == nil || adapterSession == nil || strings.TrimSpace(event.ID) == "" {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	response := adapterSession.pendingResponses[strings.TrimSpace(event.ID)]
	if response != nil {
		delete(adapterSession.pendingResponses, strings.TrimSpace(event.ID))
	}
	return response
}

func (a *ClaudeCodeSDKAdapter) registerClaudeSDKResponse(adapterSession *claudeSDKAdapterSession, requestID string) chan claudeSDKSidecarEvent {
	response := make(chan claudeSDKSidecarEvent, 1)
	a.mu.Lock()
	if adapterSession.pendingResponses == nil {
		adapterSession.pendingResponses = make(map[string]chan claudeSDKSidecarEvent)
	}
	adapterSession.pendingResponses[strings.TrimSpace(requestID)] = response
	a.mu.Unlock()
	return response
}

func (a *ClaudeCodeSDKAdapter) unregisterClaudeSDKResponse(adapterSession *claudeSDKAdapterSession, requestID string, response chan claudeSDKSidecarEvent) {
	if a == nil || adapterSession == nil || response == nil {
		return
	}
	a.mu.Lock()
	if current := adapterSession.pendingResponses[strings.TrimSpace(requestID)]; current == response {
		delete(adapterSession.pendingResponses, strings.TrimSpace(requestID))
	}
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) claudeSDKSessionSnapshot(adapterSession *claudeSDKAdapterSession) Session {
	if a == nil || adapterSession == nil {
		return Session{}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return adapterSession.session
}

func (a *ClaudeCodeSDKAdapter) updateClaudeSDKSessionSnapshot(adapterSession *claudeSDKAdapterSession, events []activityshared.Event) {
	if a == nil || adapterSession == nil || len(events) == 0 {
		return
	}
	a.mu.Lock()
	adapterSession.session = applySessionEvents(adapterSession.session, events)
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) emitClaudeSDKSessionEvents(agentSessionID string, events []activityshared.Event) {
	if a == nil || len(events) == 0 {
		return
	}
	a.mu.Lock()
	sink := a.eventSink
	a.mu.Unlock()
	if sink != nil {
		sink(agentSessionID, events)
	}
}

func (s *claudeSDKAdapterSession) applySessionPayload(session *Session, payload map[string]any) {
	if s == nil {
		return
	}
	if providerSessionID := payloadString(payload, "providerSessionId"); providerSessionID != "" {
		s.providerSessionID = providerSessionID
		if session != nil {
			session.ProviderSessionID = providerSessionID
		}
	}
	if resumeCursor := payloadMap(payload, "resumeCursor"); len(resumeCursor) > 0 {
		s.resumeCursor = clonePayload(resumeCursor)
	}
	if descriptors := configOptionDescriptors(payload["configOptions"]); len(descriptors) > 0 {
		applyACPConfigOptionDescriptors(&s.liveState, descriptors)
	}
	if model := payloadString(payload, "model"); model != "" {
		_ = s.applyConfigOption("model", model)
	}
}

func (s *claudeSDKAdapterSession) assistantMessageID(turnID string) string {
	if s.assistantMessages == nil {
		s.assistantMessages = make(map[string]string)
	}
	if messageID := s.assistantMessages[turnID]; messageID != "" {
		return messageID
	}
	messageID := "claude-sdk:assistant:" + turnID
	s.assistantMessages[turnID] = messageID
	return messageID
}

func (s *claudeSDKAdapterSession) thinkingMessageID(turnID string) string {
	if s.thinkingMessages == nil {
		s.thinkingMessages = make(map[string]string)
	}
	if messageID := s.thinkingMessages[turnID]; messageID != "" {
		return messageID
	}
	messageID := "claude-sdk:thinking:" + turnID
	s.thinkingMessages[turnID] = messageID
	return messageID
}

func (s *claudeSDKAdapterSession) claudeSDKToolEvents(session Session, turnID string, payload map[string]any, eventType string, status string, sidecarType string) []activityshared.Event {
	if s == nil {
		if strings.TrimSpace(turnID) == "" {
			return nil
		}
		return []activityshared.Event{claudeSDKToolActivityEvent(session, turnID, payload, eventType, status)}
	}
	effectiveTurnID := s.backgroundAgentTurnID(payload, turnID)
	var events []activityshared.Event
	if strings.TrimSpace(effectiveTurnID) != "" {
		events = append(events, claudeSDKToolActivityEvent(session, effectiveTurnID, payload, eventType, status))
	}
	backgroundEvents := s.updateClaudeSDKBackgroundAgentFromTool(session, turnID, payload, eventType, sidecarType)
	return append(events, backgroundEvents...)
}

func (s *claudeSDKAdapterSession) claudeSDKTaskLifecycleEvents(session Session, turnID string, sidecarType string, payload map[string]any) []activityshared.Event {
	if s == nil {
		return nil
	}
	agent, runtimeContext, ok := s.updateClaudeSDKBackgroundAgent(claudeSDKBackgroundAgentUpdate{
		Key:             firstNonEmptyString(payloadString(payload, "parentToolUseId"), payloadString(payload, "toolCallId"), payloadString(payload, "agentId"), payloadString(payload, "taskId"), payloadString(payload, "task_id")),
		ParentToolUseID: firstNonEmptyString(payloadString(payload, "parentToolUseId"), payloadString(payload, "toolCallId"), payloadString(payload, "callId")),
		TurnID:          turnID,
		TaskID:          firstNonEmptyString(payloadString(payload, "taskId"), payloadString(payload, "task_id")),
		AgentID:         payloadString(payload, "agentId"),
		Description:     payloadString(payload, "description"),
		Summary:         payloadString(payload, "summary"),
		LastToolName:    firstNonEmptyString(payloadString(payload, "lastToolName"), payloadString(payload, "last_tool_name")),
		Status:          claudeSDKTaskStatus(sidecarType, payloadString(payload, "status")),
		Started:         sidecarType == "task_started",
	})
	if !ok {
		return nil
	}
	return claudeSDKBackgroundAgentEvents(session, agent, runtimeContext, sidecarType)
}

func (s *claudeSDKAdapterSession) updateClaudeSDKBackgroundAgentFromTool(session Session, turnID string, payload map[string]any, eventType string, sidecarType string) []activityshared.Event {
	metadata := payloadMap(payload, "metadata")
	if payloadString(payload, "callType") != "subagent" && metadata["subagentAsync"] != true {
		return nil
	}
	if metadata["subagentAsync"] != true {
		return nil
	}
	input := payloadMap(payload, "input")
	parentToolUseID := firstNonEmptyString(payloadString(payload, "toolCallId"), payloadString(payload, "callId"))
	status := firstNonEmptyString(payloadString(metadata, "subagentStatus"), payloadString(metadata, "taskStatus"))
	if status == "" {
		switch eventType {
		case EventCallFailed:
			status = string(activityshared.ActivityStatusFailed)
		default:
			status = string(activityshared.ActivityStatusRunning)
		}
	}
	agent, runtimeContext, ok := s.updateClaudeSDKBackgroundAgent(claudeSDKBackgroundAgentUpdate{
		Key:             firstNonEmptyString(parentToolUseID, payloadString(metadata, "taskId"), payloadString(metadata, "agentId"), payloadString(metadata, "subagentAgentId")),
		ParentToolUseID: parentToolUseID,
		TurnID:          turnID,
		TaskID:          payloadString(metadata, "taskId"),
		AgentID:         firstNonEmptyString(payloadString(metadata, "agentId"), payloadString(metadata, "subagentAgentId")),
		Description:     firstNonEmptyString(payloadString(input, "description"), payloadString(input, "prompt"), payloadString(payload, "name")),
		Summary:         payloadString(payloadMap(payload, "output"), "text"),
		Status:          claudeSDKNormalizeTaskStatus(status),
		Started:         true,
	})
	if !ok {
		return nil
	}
	return claudeSDKBackgroundAgentEvents(session, agent, runtimeContext, sidecarType)
}

type claudeSDKBackgroundAgentUpdate struct {
	Key             string
	ParentToolUseID string
	TurnID          string
	TaskID          string
	AgentID         string
	Description     string
	Status          string
	Summary         string
	LastToolName    string
	Started         bool
}

func (s *claudeSDKAdapterSession) updateClaudeSDKBackgroundAgent(update claudeSDKBackgroundAgentUpdate) (claudeSDKBackgroundAgent, map[string]any, bool) {
	if s == nil {
		return claudeSDKBackgroundAgent{}, nil, false
	}
	key := strings.TrimSpace(update.Key)
	if key == "" {
		return claudeSDKBackgroundAgent{}, nil, false
	}
	if s.backgroundAgents == nil {
		s.backgroundAgents = make(map[string]claudeSDKBackgroundAgent)
	}
	key = s.resolveClaudeSDKBackgroundAgentKey(update, key)
	updatedAt := unixMS(now())
	agent := s.backgroundAgents[key]
	if agent.Key == "" {
		agent.Key = key
	}
	agent.UpdatedAtUnixMS = updatedAt
	if update.ParentToolUseID != "" && (agent.ParentToolUseID == "" || agent.ParentToolUseID == update.ParentToolUseID) {
		agent.ParentToolUseID = update.ParentToolUseID
	}
	if update.TurnID != "" {
		agent.TurnID = update.TurnID
	}
	if update.TaskID != "" && (agent.TaskID == "" || agent.TaskID == update.TaskID) && !s.backgroundAgentAliasBelongsToOtherKey(key, update.TaskID, func(agent claudeSDKBackgroundAgent) string {
		return agent.TaskID
	}) {
		agent.TaskID = update.TaskID
	}
	if update.AgentID != "" && (agent.AgentID == "" || agent.AgentID == update.AgentID) && !s.backgroundAgentAliasBelongsToOtherKey(key, update.AgentID, func(agent claudeSDKBackgroundAgent) string {
		return agent.AgentID
	}) {
		agent.AgentID = update.AgentID
	}
	if update.Description != "" {
		agent.Description = update.Description
	}
	if update.Summary != "" {
		agent.Summary = update.Summary
	}
	if update.LastToolName != "" {
		agent.LastToolName = update.LastToolName
	}
	agent.Status = firstNonEmptyString(claudeSDKNormalizeTaskStatus(update.Status), agent.Status, string(activityshared.ActivityStatusRunning))
	if update.Started && agent.StartedAtUnixMS == 0 {
		agent.StartedAtUnixMS = updatedAt
	}
	if claudeSDKBackgroundAgentStatusIsTerminal(agent.Status) && agent.CompletedAtUnixMS == 0 {
		agent.CompletedAtUnixMS = updatedAt
	}
	s.backgroundAgents[key] = agent
	return agent, claudeSDKBackgroundAgentsRuntimeContext(s.backgroundAgents), true
}

func (s *claudeSDKAdapterSession) resolveClaudeSDKBackgroundAgentKey(update claudeSDKBackgroundAgentUpdate, fallback string) string {
	parentID := strings.TrimSpace(update.ParentToolUseID)
	if parentID != "" {
		if resolved := s.backgroundAgentKeyByAlias(parentID); resolved != "" {
			return resolved
		}
		// The Agent tool call id is the canonical background-agent key. An
		// update that carries one may merge through weaker task/agent aliases
		// only into an entry that does not already belong to a different
		// parent tool call; otherwise a poisoned alias would fold two
		// concurrent background agents into one entry.
		for _, alias := range []string{update.AgentID, update.TaskID, update.Key} {
			resolved := s.backgroundAgentKeyByAlias(alias)
			if resolved == "" {
				continue
			}
			existingParent := strings.TrimSpace(s.backgroundAgents[resolved].ParentToolUseID)
			if existingParent == "" || existingParent == parentID {
				return resolved
			}
		}
		return parentID
	}
	keys := []string{
		update.AgentID,
		update.TaskID,
		update.Key,
	}
	for _, key := range keys {
		if resolved := s.backgroundAgentKeyByAlias(key); resolved != "" {
			return resolved
		}
	}
	return fallback
}

func (s *claudeSDKAdapterSession) backgroundAgentKeyByAlias(alias string) string {
	alias = strings.TrimSpace(alias)
	if alias == "" || s == nil {
		return ""
	}
	if agent := s.backgroundAgents[alias]; agent.TurnID != "" || agent.Key != "" {
		return alias
	}
	for key, agent := range s.backgroundAgents {
		if alias == agent.ParentToolUseID || alias == agent.AgentID || alias == agent.TaskID {
			return key
		}
	}
	return ""
}

func (s *claudeSDKAdapterSession) backgroundAgentAliasBelongsToOtherKey(currentKey string, alias string, selectAlias func(claudeSDKBackgroundAgent) string) bool {
	alias = strings.TrimSpace(alias)
	if alias == "" || s == nil {
		return false
	}
	for key, agent := range s.backgroundAgents {
		if key == currentKey {
			continue
		}
		if alias == strings.TrimSpace(selectAlias(agent)) {
			return true
		}
	}
	return false
}

func (s *claudeSDKAdapterSession) backgroundAgentTurnID(payload map[string]any, turnID string) string {
	turnID = strings.TrimSpace(turnID)
	if turnID != "" || s == nil || len(s.backgroundAgents) == 0 {
		return turnID
	}
	metadata := payloadMap(payload, "metadata")
	keys := []string{
		payloadString(payload, "taskId"),
		payloadString(payload, "task_id"),
		payloadString(metadata, "taskId"),
		payloadString(payload, "agentId"),
		payloadString(metadata, "agentId"),
		payloadString(metadata, "subagentAgentId"),
		payloadString(payload, "parentToolUseId"),
		payloadString(payload, "toolCallId"),
		payloadString(payload, "callId"),
	}
	for _, key := range keys {
		if agent := s.backgroundAgentByKey(key); agent.TurnID != "" {
			return agent.TurnID
		}
	}
	return ""
}

func (s *claudeSDKAdapterSession) backgroundAgentByKey(key string) claudeSDKBackgroundAgent {
	key = strings.TrimSpace(key)
	if key == "" || s == nil {
		return claudeSDKBackgroundAgent{}
	}
	if resolved := s.backgroundAgentKeyByAlias(key); resolved != "" {
		return s.backgroundAgents[resolved]
	}
	return claudeSDKBackgroundAgent{}
}

func claudeSDKBackgroundAgentEvents(session Session, agent claudeSDKBackgroundAgent, runtimeContext map[string]any, sidecarType string) []activityshared.Event {
	turnID := strings.TrimSpace(agent.TurnID)
	ctx, ok := activityEventContext(session, newID(), turnID)
	if !ok {
		return []activityshared.Event{claudeSDKBackgroundAgentsSessionEvent(session, runtimeContext)}
	}
	metadata := claudeSDKBackgroundAgentMetadata(agent)
	activityKey := "claude-sdk-background-agent:" + agent.Key
	var event activityshared.Event
	switch {
	case strings.EqualFold(agent.Status, string(activityshared.ActivityStatusFailed)):
		event = activityshared.NewActivityFailed(ctx, activityKey, metadata)
	case claudeSDKBackgroundAgentStatusIsTerminal(agent.Status):
		event = activityshared.NewActivityCompleted(ctx, activityKey, metadata)
	case sidecarType == "task_started" || sidecarType == "tool_completed":
		event = activityshared.NewActivityStarted(ctx, activityKey, metadata)
	default:
		event = activityshared.NewActivityUpdated(ctx, activityKey, metadata)
	}
	return []activityshared.Event{event, claudeSDKBackgroundAgentsSessionEvent(session, runtimeContext)}
}

func claudeSDKBackgroundAgentsSessionEvent(session Session, runtimeContext map[string]any) activityshared.Event {
	return newSessionActivityEvent(session, EventSessionUpdated, SessionStatusReady, map[string]any{
		"runtimeContext": map[string]any{
			"backgroundAgents": runtimeContext,
		},
	})
}

func claudeSDKBackgroundAgentsRuntimeContext(value map[string]claudeSDKBackgroundAgent) map[string]any {
	if len(value) == 0 {
		return nil
	}
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	items := make([]any, 0, len(keys))
	runningCount := 0
	for _, key := range keys {
		agent := value[key]
		status := firstNonEmptyString(strings.TrimSpace(agent.Status), string(activityshared.ActivityStatusRunning))
		if !claudeSDKBackgroundAgentStatusIsTerminal(status) {
			runningCount++
		}
		item := map[string]any{
			"taskId":      firstNonEmptyString(agent.TaskID, agent.Key),
			"description": agent.Description,
			"status":      status,
		}
		if agent.ParentToolUseID != "" {
			item["parentToolUseId"] = agent.ParentToolUseID
		}
		if agent.AgentID != "" {
			item["agentId"] = agent.AgentID
		}
		if agent.Summary != "" {
			item["summary"] = agent.Summary
		}
		if agent.LastToolName != "" {
			item["lastToolName"] = agent.LastToolName
		}
		if agent.StartedAtUnixMS > 0 {
			item["startedAtUnixMs"] = agent.StartedAtUnixMS
		}
		if agent.UpdatedAtUnixMS > 0 {
			item["updatedAtUnixMs"] = agent.UpdatedAtUnixMS
		}
		if agent.CompletedAtUnixMS > 0 {
			item["completedAtUnixMs"] = agent.CompletedAtUnixMS
		}
		items = append(items, item)
	}
	return map[string]any{
		"count": runningCount,
		"items": items,
	}
}

func claudeSDKBackgroundAgentMetadata(agent claudeSDKBackgroundAgent) map[string]any {
	metadata := map[string]any{
		"kind":        "background_agent",
		"taskId":      firstNonEmptyString(agent.TaskID, agent.Key),
		"description": agent.Description,
		"status":      firstNonEmptyString(agent.Status, string(activityshared.ActivityStatusRunning)),
		"title":       firstNonEmptyString(agent.Description, "Background agent"),
	}
	if agent.ParentToolUseID != "" {
		metadata["parentToolUseId"] = agent.ParentToolUseID
	}
	if agent.AgentID != "" {
		metadata["agentId"] = agent.AgentID
	}
	if agent.Summary != "" {
		metadata["summary"] = agent.Summary
	}
	if agent.LastToolName != "" {
		metadata["lastToolName"] = agent.LastToolName
	}
	if agent.StartedAtUnixMS > 0 {
		metadata["startedAtUnixMs"] = agent.StartedAtUnixMS
	}
	if agent.UpdatedAtUnixMS > 0 {
		metadata["updatedAtUnixMs"] = agent.UpdatedAtUnixMS
	}
	if agent.CompletedAtUnixMS > 0 {
		metadata["completedAtUnixMs"] = agent.CompletedAtUnixMS
	}
	return metadata
}

func claudeSDKTaskStatus(sidecarType string, status string) string {
	if normalized := claudeSDKNormalizeTaskStatus(status); normalized != "" {
		return normalized
	}
	switch sidecarType {
	case "task_completed":
		return string(activityshared.ActivityStatusCompleted)
	default:
		return string(activityshared.ActivityStatusRunning)
	}
}

func claudeSDKNormalizeTaskStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "failed", "error", "errored":
		return string(activityshared.ActivityStatusFailed)
	case "completed", "done", "success", "succeeded":
		return string(activityshared.ActivityStatusCompleted)
	case "stopped", "cancelled", "canceled":
		return "stopped"
	case "running", "in_progress", "pending":
		return string(activityshared.ActivityStatusRunning)
	default:
		return strings.TrimSpace(status)
	}
}

func claudeSDKBackgroundAgentStatusIsTerminal(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case string(activityshared.ActivityStatusCompleted), string(activityshared.ActivityStatusFailed), "cancelled", "canceled", "stopped":
		return true
	default:
		return false
	}
}

// claudeSDKPlanEvents maps the sidecar's plan_updated entries (SDK task list)
// onto the same synthesized update_todo tool call codex publishes for plan
// updates, so the GUI plan rendering works identically across providers.
func claudeSDKPlanEvents(session Session, turnID string, payload map[string]any) []activityshared.Event {
	entries, _ := payload["entries"].([]any)
	if len(entries) == 0 || strings.TrimSpace(turnID) == "" {
		return nil
	}
	todos := make([]any, 0, len(entries))
	for _, entry := range entries {
		item := payloadObject(entry)
		text := asStringRaw(item["content"])
		if text == "" {
			continue
		}
		todos = append(todos, map[string]any{
			"content": text,
			"status":  appServerItemStatus(asString(item["status"])),
		})
	}
	if len(todos) == 0 {
		return nil
	}
	return []activityshared.Event{claudeSDKToolActivityEvent(session, turnID, map[string]any{
		"toolCallId": "plan:" + strings.TrimSpace(turnID),
		"name":       "update_todo",
		"input":      map[string]any{"todos": todos},
		"metadata":   map[string]any{"kind": "think"},
	}, EventCallCompleted, messageStreamStateCompleted)}
}

func claudeSDKToolActivityEvent(session Session, turnID string, payload map[string]any, eventType string, status string) activityshared.Event {
	callID := firstNonEmpty(
		payloadString(payload, "toolCallId"),
		payloadString(payload, "callId"),
		payloadString(payload, "id"),
		newID(),
	)
	name := firstNonEmpty(payloadString(payload, "name"), payloadString(payload, "toolName"), callID)
	metadata := map[string]any{
		"adapter":  claudeSDKSidecarAdapterName,
		"callId":   callID,
		"callType": firstNonEmpty(payloadString(payload, "callType"), "tool"),
		"name":     name,
		"status":   status,
	}
	if toolName := payloadString(payload, "toolName"); toolName != "" {
		metadata["toolName"] = toolName
	}
	if input := payloadMap(payload, "input"); len(input) > 0 {
		metadata["input"] = input
	}
	if output := payloadMap(payload, "output"); len(output) > 0 {
		metadata["output"] = output
	}
	if errorPayload := payloadMap(payload, "error"); len(errorPayload) > 0 {
		metadata["error"] = errorPayload
	}
	if locations, ok := payload["locations"].([]any); ok && len(locations) > 0 {
		metadata["locations"] = locations
	}
	if content, ok := payload["content"].([]any); ok && len(content) > 0 {
		metadata["content"] = content
	}
	if sidecarMetadata := payloadMap(payload, "metadata"); len(sidecarMetadata) > 0 {
		metadata["metadata"] = sidecarMetadata
		if parentToolUseID := payloadString(sidecarMetadata, "parentToolUseId"); parentToolUseID != "" {
			metadata["parentToolUseId"] = parentToolUseID
		}
		if toolResponse := payloadMap(sidecarMetadata, "claudeToolResponse"); len(toolResponse) > 0 {
			metadata["claudeToolResponse"] = toolResponse
		}
	}
	body := map[string]any(nil)
	switch eventType {
	case EventCallCompleted:
		body = payloadMap(payload, "output")
	case EventCallFailed:
		body = payloadMap(payload, "error")
	default:
		body = payloadMap(payload, "input")
	}
	return newTurnActivityEventWithID(session, "claude-sdk:tool:"+callID, eventType, turnID, status, "", name, payloadWithCallBody(claudeSDKCallBodyKey(eventType), body, metadata))
}

func claudeSDKCallBodyKey(eventType string) string {
	switch eventType {
	case EventCallCompleted:
		return "output"
	case EventCallFailed:
		return "error"
	default:
		return "input"
	}
}

func (s *claudeSDKAdapterSession) compactMessageEvent(session Session, turnID string, streamState string, content string) activityshared.Event {
	if s.compactMessages == nil {
		s.compactMessages = make(map[string]string)
	}
	messageID := s.compactMessages[turnID]
	if messageID == "" {
		messageID = "claude-sdk:compact:" + turnID
		s.compactMessages[turnID] = messageID
	}
	return newTurnActivityEventWithID(session, messageID, EventMessage, turnID, streamState, RoleAssistant, content, map[string]any{
		"adapter":     claudeSDKSidecarAdapterName,
		"messageId":   messageID,
		"contentMode": messageContentModeSnapshot,
		"source":      "compact",
	})
}

func newClaudeSDKLiveState() acpLiveState {
	state := newACPLiveState()
	state.availableCommands = claudeSDKDefaultCommands()
	state.commandsKnown = true
	return state
}

func claudeSDKDefaultCommands() []AgentSessionCommand {
	return []AgentSessionCommand{
		{Name: "compact"},
		{Name: "status"},
		{Name: "fast"},
		{Name: "goal"},
		{Name: "review"},
	}
}

func claudeSDKCommandSnapshot(agentSessionID string, state acpLiveState) AgentSessionCommandSnapshot {
	snapshot, _ := commandSnapshotFromACPLiveState(agentSessionID, state)
	return snapshot
}

func (s *claudeSDKAdapterSession) commandSnapshot(agentSessionID string) (AgentSessionCommandSnapshot, bool) {
	if s == nil {
		return AgentSessionCommandSnapshot{}, false
	}
	return commandSnapshotFromACPLiveState(agentSessionID, s.liveState)
}

func (s *claudeSDKAdapterSession) applyCommandsUpdated(agentSessionID string, payload map[string]any) bool {
	if s == nil {
		return false
	}
	commands, ok := acpCommandsValue(payload)
	if !ok {
		return false
	}
	s.liveState.availableCommands = commands
	s.liveState.commandsKnown = true
	_ = agentSessionID
	return true
}

func (s *claudeSDKAdapterSession) applyUsageUpdated(payload map[string]any) bool {
	if s == nil {
		return false
	}
	previous := s.liveState.usage
	contextModel := s.currentUsageModel(payload)
	update := claudeSDKUsageUpdate(payload, previous, contextModel)
	if len(update) == 0 {
		s.logUsageUpdate(payload, update, previous, acpUsageState{}, contextModel, false, "empty_normalized_update")
		return false
	}
	if usage, ok := acpUsageValue(update); ok {
		if usage.contextKnown {
			usage.contextModel = contextModel
		}
		s.liveState.usage = mergeACPUsageState(previous, usage)
		s.logUsageUpdate(payload, update, previous, s.liveState.usage, contextModel, true, "")
		return true
	}
	s.logUsageUpdate(payload, update, previous, acpUsageState{}, contextModel, false, "invalid_normalized_update")
	return false
}

func (s *claudeSDKAdapterSession) logUsageUpdate(
	payload map[string]any,
	update map[string]any,
	previous acpUsageState,
	current acpUsageState,
	contextModel string,
	applied bool,
	reason string,
) {
	if s == nil {
		return
	}
	session := s.session
	payloadUsage := payloadMap(payload, "usage")
	contextWindow := payloadMap(payload, "contextWindow")
	payloadKind := "direct"
	switch {
	case len(payload) == 0:
		payloadKind = "empty"
	case len(contextWindow) > 0:
		payloadKind = "context_window"
	case len(payloadUsage) > 0:
		payloadKind = "usage"
	}
	usageSource := payload
	if len(payloadUsage) > 0 {
		usageSource = payloadUsage
	}
	normalizedContext := payloadMap(update, "contextWindow")
	rawContextSource := payload
	if len(contextWindow) > 0 {
		rawContextSource = contextWindow
	}
	rawUsed, _ := firstACPInt64(rawContextSource, "usedTokens", "used_tokens", "used", "totalTokens", "total_tokens", "total")
	rawTotal := claudeSDKContextWindowTokens(payload, contextModel)
	if rawTotal <= 0 {
		rawTotal = claudeSDKContextWindowTokens(usageSource, contextModel)
	}
	rawInput, _ := firstACPInt64(usageSource, "input_tokens", "inputTokens")
	rawOutput, _ := firstACPInt64(usageSource, "output_tokens", "outputTokens")
	rawCacheRead, _ := firstACPInt64(usageSource, "cache_read_input_tokens", "cacheReadInputTokens")
	rawCacheCreate, _ := firstACPInt64(usageSource, "cache_creation_input_tokens", "cacheCreationInputTokens")
	normalizedUsed, _ := firstACPInt64(normalizedContext, "usedTokens", "used_tokens")
	normalizedTotal, _ := firstACPInt64(normalizedContext, "totalTokens", "total_tokens")
	slog.Info("agent session Claude SDK usage update",
		"event", "agent_session.claude_sdk.usage_update",
		"provider", ProviderClaudeCode,
		"adapter", claudeSDKSidecarAdapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", firstNonEmpty(strings.TrimSpace(s.providerSessionID), strings.TrimSpace(session.ProviderSessionID)),
		"turn_id", payloadString(payload, "turnId"),
		"payload_kind", payloadKind,
		"payload_keys", sortedPayloadKeys(payload),
		"usage_keys", sortedPayloadKeys(usageSource),
		"raw_used_tokens", rawUsed,
		"raw_total_tokens", rawTotal,
		"raw_input_tokens", rawInput,
		"raw_output_tokens", rawOutput,
		"raw_cache_read_input_tokens", rawCacheRead,
		"raw_cache_creation_input_tokens", rawCacheCreate,
		"normalized_used_tokens", normalizedUsed,
		"normalized_total_tokens", normalizedTotal,
		"previous_context_known", previous.contextKnown,
		"previous_used_tokens", previous.contextUsedTokens,
		"previous_total_tokens", previous.contextWindowTokens,
		"previous_context_model", previous.contextModel,
		"current_context_known", current.contextKnown,
		"current_used_tokens", current.contextUsedTokens,
		"current_total_tokens", current.contextWindowTokens,
		"current_context_model", current.contextModel,
		"applied", applied,
		"reason", strings.TrimSpace(reason),
	)
}

func sortedPayloadKeys(payload map[string]any) []string {
	if len(payload) == 0 {
		return nil
	}
	keys := make([]string, 0, len(payload))
	for key := range payload {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (s *claudeSDKAdapterSession) currentUsageModel(payload map[string]any) string {
	if s == nil {
		return ""
	}
	if model := claudeSDKCanonicalModel(payloadString(payload, "model")); model != "" {
		return model
	}
	if model := claudeSDKCanonicalModel(asString(s.liveState.configOptions["model"])); model != "" {
		return model
	}
	return claudeSDKCanonicalModel(s.session.SettingsValue().Model)
}

func (s *claudeSDKAdapterSession) applySpeedUpdated(payload map[string]any) bool {
	if s == nil {
		return false
	}
	speed := claudeSDKCanonicalSpeed(payloadString(payload, "speed"))
	if speed == "" {
		speed = claudeSDKSpeedFromFastModeState(payloadString(payload, "state"))
	}
	if speed == "" {
		return false
	}
	return s.applySpeed(speed)
}

func (s *claudeSDKAdapterSession) applySpeed(speed string) bool {
	if s == nil {
		return false
	}
	speed = claudeSDKCanonicalSpeed(speed)
	if speed == "" {
		return false
	}
	s.liveState.ensureInitialized()
	if acpConfigOptionMatches(s.liveState, "fast", speed) {
		return false
	}
	s.liveState.configOptions["fast"] = speed
	updateConfigOptionDescriptorValue(s.liveState.configOptionDescriptors, "fast", speed)
	return true
}

func (s *claudeSDKAdapterSession) applySettingsPayload(payload map[string]any) bool {
	if s == nil {
		return false
	}
	changed := false
	if model, ok := payload["model"].(string); ok {
		changed = s.applyConfigOption("model", strings.TrimSpace(model)) || changed
	}
	if effort, ok := payload["effort"].(string); ok {
		changed = s.applyConfigOption("effort", strings.TrimSpace(effort)) || changed
	}
	if speed, ok := payload["speed"].(string); ok {
		changed = s.applySpeed(speed) || changed
	}
	if mode, ok := payload["permissionMode"].(string); ok {
		changed = s.applyPermissionMode(mode) || changed
	}
	return changed
}

func (s *claudeSDKAdapterSession) applyPermissionMode(mode string) bool {
	mode = claudeSDKPermissionMode(mode)
	if s == nil || mode == "" {
		return false
	}
	return s.applyConfigOption("mode", mode)
}

func (s *claudeSDKAdapterSession) applyConfigOption(configID string, value string) bool {
	if s == nil || strings.TrimSpace(configID) == "" {
		return false
	}
	s.liveState.ensureInitialized()
	value = strings.TrimSpace(value)
	if acpConfigOptionMatches(s.liveState, configID, value) {
		return false
	}
	if value == "" {
		delete(s.liveState.configOptions, configID)
	} else {
		s.liveState.configOptions[configID] = value
	}
	updateConfigOptionDescriptorValue(s.liveState.configOptionDescriptors, configID, value)
	return true
}

func claudeSDKUsageUpdate(payload map[string]any, previous acpUsageState, contextModel string) map[string]any {
	if len(payload) == 0 {
		return nil
	}
	if contextWindow := payloadMap(payload, "contextWindow"); len(contextWindow) > 0 {
		if _, ok := firstACPInt64(contextWindow, "totalTokens", "total_tokens", "size", "limit", "max"); !ok {
			total := int64(0)
			if claudeSDKCanReusePreviousContextWindow(previous, contextModel) {
				total = previous.contextWindowTokens
			}
			if total <= 0 {
				total = claudeSDKAssumedContextWindow(contextModel)
			}
			contextWindow = clonePayload(contextWindow)
			contextWindow["totalTokens"] = total
		}
		return map[string]any{
			"sessionUpdate": "usage_update",
			"contextWindow": contextWindow,
		}
	}
	usage := payloadMap(payload, "usage")
	if len(usage) == 0 {
		usage = payload
	}
	used := claudeSDKUsageTokens(usage)
	if explicit, ok := firstACPInt64(payload, "usedTokens", "used_tokens", "used", "totalTokens", "total_tokens", "total"); ok {
		used = explicit
	}
	if used <= 0 {
		return nil
	}
	total := claudeSDKContextWindowTokens(payload, contextModel)
	if total <= 0 {
		total = claudeSDKContextWindowTokens(usage, contextModel)
	}
	if total <= 0 && claudeSDKCanReusePreviousContextWindow(previous, contextModel) {
		total = previous.contextWindowTokens
	}
	if total <= 0 {
		total = claudeSDKAssumedContextWindow(contextModel)
	}
	return map[string]any{
		"sessionUpdate": "usage_update",
		"contextWindow": map[string]any{
			"usedTokens":  used,
			"totalTokens": total,
		},
	}
}

// claudeSDKAssumedContextWindow picks the context-window size to assume when
// the Claude Agent SDK hasn't yet reported an authoritative per-model window
// for this turn (claudeSDKContextWindowTokens returns 0, e.g. every streamed
// usage delta before the turn's final "result" message carries modelUsage)
// and there's no matching previously-known window to carry forward
// (claudeSDKCanReusePreviousContextWindow). Model IDs/aliases across the
// Claude Code ecosystem mark 1M-context variants with a "[1m]" suffix (see
// claudeCodeACPModelAliases's "sonnet[1m]" and
// claudeCodeLegacyACPModelCandidates's "opus[1m]" in standard_acp_adapter.go,
// and user-configured aliases such as "claude-fable-5[1m]"). Honor that
// convention here too, so a brand-new session/turn on a 1M-context model
// doesn't render the usage popover against the base 200k denominator for the
// entire duration of the turn.
func claudeSDKAssumedContextWindow(contextModel string) int64 {
	if strings.Contains(strings.ToLower(claudeSDKCanonicalModel(contextModel)), "[1m]") {
		return claudeSDK1MContextWindow
	}
	return claudeSDKDefaultContextWindow
}

func claudeSDKCanReusePreviousContextWindow(previous acpUsageState, contextModel string) bool {
	if !previous.contextKnown || previous.contextWindowTokens <= 0 {
		return false
	}
	contextModel = claudeSDKCanonicalModel(contextModel)
	previousModel := claudeSDKCanonicalModel(previous.contextModel)
	return previousModel == "" || contextModel == "" || previousModel == contextModel
}

func claudeSDKUsageTokens(usage map[string]any) int64 {
	if len(usage) == 0 {
		return 0
	}
	if iterations, ok := usage["iterations"].([]any); ok && len(iterations) > 0 {
		for index := len(iterations) - 1; index >= 0; index-- {
			if item, ok := iterations[index].(map[string]any); ok {
				if used := claudeSDKUsageTokens(item); used > 0 {
					return used
				}
			}
		}
	}
	if total, ok := firstACPInt64(usage, "total_tokens", "totalTokens", "total"); ok && total > 0 {
		return total
	}
	input, _ := firstACPInt64(usage, "input_tokens", "inputTokens")
	output, _ := firstACPInt64(usage, "output_tokens", "outputTokens")
	cacheRead, _ := firstACPInt64(usage, "cache_read_input_tokens", "cacheReadInputTokens")
	cacheCreate, _ := firstACPInt64(usage, "cache_creation_input_tokens", "cacheCreationInputTokens")
	return input + output + cacheRead + cacheCreate
}

func claudeSDKContextWindowTokens(payload map[string]any, contextModel string) int64 {
	if len(payload) == 0 {
		return 0
	}
	if total, ok := firstACPInt64(payload,
		"maxTokens",
		"max_tokens",
		"contextWindowTokens",
		"context_window_tokens",
		"contextWindow",
		"modelContextWindow",
		"model_context_window",
		"size",
		"limit",
		"max",
	); ok {
		return total
	}
	if total := claudeSDKContextWindowTokensFromValue(payload["modelUsage"], contextModel); total > 0 {
		return total
	}
	return 0
}

func claudeSDKContextWindowTokensFromValue(value any, contextModel string) int64 {
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			if total := claudeSDKContextWindowTokensFromValue(item, contextModel); total > 0 {
				return total
			}
		}
	case []map[string]any:
		for _, item := range typed {
			if total := claudeSDKContextWindowTokens(item, contextModel); total > 0 {
				return total
			}
		}
	case map[string]any:
		if total := claudeSDKContextWindowTokens(typed, contextModel); total > 0 {
			return total
		}
		normalizedModel := strings.ToLower(strings.TrimSpace(claudeSDKCanonicalModel(contextModel)))
		keys := sortedPayloadKeys(typed)
		for _, key := range keys {
			if normalizedModel != "" && claudeSDKModelKeyMatchesNormalized(key, normalizedModel) {
				if total := claudeSDKContextWindowTokensFromValue(typed[key], contextModel); total > 0 {
					return total
				}
			}
		}
		for _, key := range keys {
			if normalizedModel == "" || !claudeSDKModelKeyMatchesNormalized(key, normalizedModel) {
				if total := claudeSDKContextWindowTokensFromValue(typed[key], contextModel); total > 0 {
					return total
				}
			}
		}
	}
	return 0
}

func claudeSDKModelKeyMatchesNormalized(key string, normalizedModel string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	return key != "" && (key == normalizedModel || strings.Contains(key, normalizedModel))
}

func (s *claudeSDKAdapterSession) send(request claudeSDKSidecarRequest) error {
	if s == nil || s.conn == nil {
		return ErrSessionDisconnected
	}
	data, err := json.Marshal(request)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	return s.conn.Send(data)
}

func (a *ClaudeCodeSDKAdapter) roundTripClaudeSDK(ctx context.Context, agentSessionID string, adapterSession *claudeSDKAdapterSession, request claudeSDKSidecarRequest) error {
	if adapterSession == nil {
		return ErrSessionDisconnected
	}
	if strings.TrimSpace(request.ID) == "" {
		request.ID = newID()
	}
	a.mu.Lock()
	readerStarted := adapterSession.readerStarted
	a.mu.Unlock()
	if !readerStarted {
		if err := adapterSession.send(request); err != nil {
			return err
		}
		return adapterSession.roundTripDirect(ctx, request)
	}
	response := a.registerClaudeSDKResponse(adapterSession, request.ID)
	if err := adapterSession.send(request); err != nil {
		a.unregisterClaudeSDKResponse(adapterSession, request.ID, response)
		return err
	}
	select {
	case event := <-response:
		return claudeSDKRoundTripResponseError(event)
	case <-ctx.Done():
		a.unregisterClaudeSDKResponse(adapterSession, request.ID, response)
		_ = agentSessionID
		return ctx.Err()
	}
}

func (s *claudeSDKAdapterSession) roundTripDirect(ctx context.Context, request claudeSDKSidecarRequest) error {
	if s == nil || s.reader == nil {
		return nil
	}
	for {
		event, err := s.reader.next(ctx)
		if err != nil {
			return err
		}
		if strings.TrimSpace(event.ID) != strings.TrimSpace(request.ID) {
			continue
		}
		return claudeSDKRoundTripResponseError(event)
	}
}

func claudeSDKRoundTripResponseError(event claudeSDKSidecarEvent) error {
	switch event.Type {
	case "ok":
		return nil
	case "error":
		return errors.New(payloadString(event.Payload, "error"))
	default:
		return fmt.Errorf("claude sdk sidecar returned unexpected response %q", event.Type)
	}
}

func (r *claudeSDKLineReader) next(ctx context.Context) (claudeSDKSidecarEvent, error) {
	for {
		if line, ok := nextBufferedLine(&r.buffer); ok {
			var event claudeSDKSidecarEvent
			if err := json.Unmarshal([]byte(line), &event); err != nil {
				return claudeSDKSidecarEvent{}, err
			}
			return event, nil
		}
		select {
		case <-ctx.Done():
			return claudeSDKSidecarEvent{}, ctx.Err()
		default:
		}
		frame, err := r.conn.Recv()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return claudeSDKSidecarEvent{}, ErrSessionDisconnected
			}
			return claudeSDKSidecarEvent{}, err
		}
		if len(frame.Stderr) > 0 {
			logClaudeSDKSidecarDebugStderr(frame.Stderr)
			continue
		}
		if frame.ExitCode != nil {
			return claudeSDKSidecarEvent{}, fmt.Errorf("claude sdk sidecar exited with code %d", *frame.ExitCode)
		}
		if len(frame.Stdout) > 0 {
			r.buffer += string(frame.Stdout)
		}
	}
}

func logClaudeSDKSidecarDebugStderr(content []byte) {
	for _, line := range strings.Split(string(content), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, claudeSDKAuthRefreshLogPrefix) {
			continue
		}
		payloadJSON := strings.TrimSpace(strings.TrimPrefix(line, claudeSDKAuthRefreshLogPrefix))
		if payloadJSON == "" {
			payloadJSON = "{}"
		}
		slog.Warn(claudeSDKAuthRefreshLogPrefix,
			"event", "agent_session.claude_sdk.auth_refresh_debug",
			"payload_json", payloadJSON,
		)
	}
}

func nextBufferedLine(buffer *string) (string, bool) {
	if buffer == nil {
		return "", false
	}
	index := strings.IndexByte(*buffer, '\n')
	if index < 0 {
		return "", false
	}
	line := strings.TrimSpace((*buffer)[:index])
	*buffer = (*buffer)[index+1:]
	return line, line != ""
}

func (a *ClaudeCodeSDKAdapter) storeSession(agentSessionID string, session *claudeSDKAdapterSession) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if session != nil && session.backgroundAgents == nil {
		session.backgroundAgents = make(map[string]claudeSDKBackgroundAgent)
	}
	a.sessions[agentSessionID] = session
}

func (a *ClaudeCodeSDKAdapter) getSession(agentSessionID string) *claudeSDKAdapterSession {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessions[agentSessionID]
}

func (a *ClaudeCodeSDKAdapter) removeSession(agentSessionID string) {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.sessions, agentSessionID)
}

func (a *ClaudeCodeSDKAdapter) emitCommandSnapshot(snapshot AgentSessionCommandSnapshot) {
	if a == nil || strings.TrimSpace(snapshot.AgentSessionID) == "" {
		return
	}
	a.mu.Lock()
	sink := a.commandSink
	a.mu.Unlock()
	if sink != nil {
		sink(snapshot)
	}
}

func claudeCodeSDKRuntimeEnabled() bool {
	runtime := strings.TrimSpace(os.Getenv(claudeCodeRuntimeEnv))
	if runtime == "" {
		return true
	}
	return strings.EqualFold(runtime, claudeCodeRuntimeSDK)
}

func claudeSDKSidecarCommand(env []string) []string {
	if command := strings.TrimSpace(os.Getenv(claudeSDKSidecarCommandEnv)); command != "" {
		return strings.Fields(command)
	}
	if entry := claudeSDKEnvValue(env, claudeSDKSidecarEntryPathEnv); entry != "" {
		return []string{claudeSDKNodeCommand(env), claudeSDKSidecarDefaultNodeArg, entry}
	}
	root := findRepoRoot()
	if root == "" {
		return []string{"node", claudeSDKSidecarDefaultNodeArg, "packages/agent/claude-sdk-sidecar/src/main.ts"}
	}
	return []string{"node", claudeSDKSidecarDefaultNodeArg, filepath.Join(root, "packages/agent/claude-sdk-sidecar/src/main.ts")}
}

func claudeSDKNodeCommand(env []string) string {
	if node := claudeSDKEnvValue(env, claudeSDKAppNodeEnv); node != "" {
		return node
	}
	if root := claudeSDKEnvValue(env, claudeSDKAppRuntimeRootEnv); root != "" {
		if node := claudeSDKManagedNodePath(root); isExecutableFile(node) {
			return node
		}
	}
	if cacheRoot := claudeSDKEnvValue(env, claudeSDKAppRuntimeCacheEnv); cacheRoot != "" {
		root := filepath.Join(cacheRoot, goruntime.GOOS+"-"+goruntime.GOARCH)
		if node := claudeSDKManagedNodePath(root); isExecutableFile(node) {
			return node
		}
	}
	return "node"
}

func claudeSDKEnvValue(env []string, key string) string {
	if value := strings.TrimSpace(envValueFromList(env, key)); value != "" {
		return value
	}
	return strings.TrimSpace(os.Getenv(key))
}

func claudeSDKManagedNodePath(root string) string {
	return filepath.Join(root, "node", "bin", claudeSDKNodeBinaryName())
}

func claudeSDKNodeBinaryName() string {
	if goruntime.GOOS == "windows" {
		return "node.exe"
	}
	return "node"
}

func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0
}

func claudeSDKSidecarEnv(session Session) []string {
	env := append([]string(nil), session.Env...)
	env = append(env, "IS_SANDBOX=1")
	if os.Getenv(claudeSDKSidecarTestDriverEnv) != "" {
		env = append(env, claudeSDKSidecarTestDriverEnv+"="+os.Getenv(claudeSDKSidecarTestDriverEnv))
	}
	return env
}

func claudeSDKRuntimeContext(session Session, adapterSession *claudeSDKAdapterSession) map[string]any {
	liveState := newClaudeSDKLiveState()
	if adapterSession != nil {
		liveState = adapterSession.liveState
	}
	model := claudeSDKSessionModel(session, liveState)
	reasoningEffort := claudeSDKSessionReasoningEffort(session, liveState)
	speed := claudeSDKSessionSpeed(session, liveState)
	permissionMode := claudeSDKSessionPermissionMode(session, liveState)
	context := map[string]any{
		"adapter":          claudeSDKSidecarAdapterName,
		"configOptions":    claudeSDKConfigOptions(liveState, model, reasoningEffort, speed),
		"model":            model,
		"permissionModeId": permissionMode,
		"planMode":         session.SettingsValue().PlanMode,
		"reasoningEffort":  reasoningEffort,
		"speed":            speed,
		"capabilities": []string{
			CapabilityImageInput,
			CapabilityCompact,
			CapabilityTokenUsage,
			CapabilityRateLimits,
			CapabilityPlanMode,
			CapabilityInterrupt,
			"review",
			// Goal set/clear/display only — no CapabilityGoalPause: Claude
			// Code's goal has no paused state to control.
			"goal",
		},
	}
	if providerConfig := providerRuntimeConfig(session, session.Provider); len(providerConfig) > 0 {
		context["providerConfig"] = providerConfig
	}
	if len(liveState.availableCommands) > 0 {
		context["commands"] = agentSessionCommandNames(liveState.availableCommands)
	}
	if usage := acpUsageRuntimeContext(liveState.usage); len(usage) > 0 {
		context["usage"] = usage
	}
	if adapterSession != nil {
		if backgroundAgents := claudeSDKBackgroundAgentsRuntimeContext(adapterSession.backgroundAgents); len(backgroundAgents) > 0 {
			context["backgroundAgents"] = backgroundAgents
		}
	}
	if resumeCursor := claudeSDKResumeCursor(session, adapterSession); len(resumeCursor) > 0 {
		context["resumeCursor"] = resumeCursor
	}
	if cwd := strings.TrimSpace(session.CWD); cwd != "" {
		context["cwd"] = cwd
	}
	if title := strings.TrimSpace(session.Title); title != "" {
		context["title"] = title
	}
	if len(liveState.goal) > 0 {
		context["goal"] = clonePayload(liveState.goal)
	}
	return context
}

func (s *claudeSDKAdapterSession) mirrorGoalSlashPrompt(session Session, prompt string) (activityshared.Event, bool) {
	if s == nil {
		return activityshared.Event{}, false
	}
	goal, updateType, ok := claudeGoalSlashPromptUpdate(prompt)
	if !ok {
		return activityshared.Event{}, false
	}
	if updateType == "thread_goal_update" {
		s.liveState.goal = clonePayload(goal)
	} else {
		s.liveState.goal = nil
	}
	return acpGoalUpdatedEvent(session, updateType)
}

func (s *claudeSDKAdapterSession) applyGoalUpdated(payload map[string]any) string {
	if s == nil {
		return ""
	}
	updateType := strings.TrimSpace(payloadString(payload, "updateType"))
	if updateType == "thread_goal_clear" || updateType == "thread_goal_cleared" {
		s.liveState.goal = nil
		return firstNonEmpty(updateType, "thread_goal_cleared")
	}
	if goal := payloadObject(payload["goal"]); len(goal) > 0 {
		s.liveState.goal = clonePayload(goal)
		return firstNonEmpty(updateType, "thread_goal_update")
	}
	if raw, err := json.Marshal(payload["sdkMessage"]); err == nil && len(raw) > 0 {
		if goal, ok := claudeSDKGoalStatusPayload(raw); ok {
			s.liveState.goal = clonePayload(goal)
			return "thread_goal_update"
		}
	}
	return ""
}

func claudeSDKResumeCursor(session Session, adapterSession *claudeSDKAdapterSession) map[string]any {
	if adapterSession != nil && len(adapterSession.resumeCursor) > 0 {
		return clonePayload(adapterSession.resumeCursor)
	}
	if cursor := claudeSDKResumeCursorFromSession(session); len(cursor) > 0 {
		return cursor
	}
	providerSessionID := strings.TrimSpace(session.ProviderSessionID)
	if adapterSession != nil {
		providerSessionID = firstNonEmpty(strings.TrimSpace(adapterSession.providerSessionID), providerSessionID)
	}
	if providerSessionID == "" {
		return nil
	}
	return map[string]any{
		"kind":      claudeSDKSidecarAdapterName,
		"version":   int64(1),
		"resume":    providerSessionID,
		"turnCount": int64(0),
	}
}

func claudeSDKResumeCursorFromSession(session Session) map[string]any {
	cursor := payloadMap(session.RuntimeContext, "resumeCursor")
	if len(cursor) == 0 {
		return nil
	}
	resume := strings.TrimSpace(asString(cursor["resume"]))
	if resume == "" {
		return nil
	}
	return clonePayload(cursor)
}

func classifyClaudeSDKResumeError(session Session, err error) error {
	if err == nil {
		return nil
	}
	message := strings.TrimSpace(err.Error())
	lower := strings.ToLower(message)
	if strings.Contains(lower, "no conversation found with session id") ||
		strings.Contains(lower, "query closed before response received") {
		return &AppError{
			Code:    AppErrorProviderSessionNotFound,
			Message: "Agent provider session could not be restored.",
			DebugMessage: fmt.Sprintf(
				"Claude SDK restore target missing: room_id=%s provider=%s agent_session_id=%s provider_session_id=%s error=%s",
				strings.TrimSpace(session.RoomID),
				strings.TrimSpace(session.Provider),
				strings.TrimSpace(session.AgentSessionID),
				strings.TrimSpace(session.ProviderSessionID),
				message,
			),
			Cause: err,
		}
	}
	return err
}

func claudeSDKModelConfigOption(model string) map[string]any {
	selectedModel := claudeSDKCanonicalModel(model)
	if selectedModel == "" {
		selectedModel = "default"
	}
	return map[string]any{
		"id":           "model",
		"currentValue": selectedModel,
		"options": []map[string]string{
			{"name": "Default", "value": "default"},
			{"name": "Opus", "value": "opus"},
			{"name": "Sonnet", "value": "sonnet"},
			{"name": "Haiku", "value": "haiku"},
		},
	}
}

func claudeSDKConfigOptions(state acpLiveState, model string, effort string, speed string) []map[string]any {
	options := cloneConfigOptionDescriptors(state.configOptionDescriptors)
	if len(options) == 0 {
		return []map[string]any{claudeSDKModelConfigOption(model), claudeSDKEffortConfigOption(effort), claudeSDKSpeedConfigOption(speed)}
	}
	ensureClaudeSDKConfigOption(&options, claudeSDKModelConfigOption(model))
	ensureClaudeSDKConfigOption(&options, claudeSDKEffortConfigOption(effort))
	ensureClaudeSDKConfigOption(&options, claudeSDKSpeedConfigOption(speed))
	updateConfigOptionDescriptorValue(options, "model", model)
	updateConfigOptionDescriptorValue(options, "effort", effort)
	updateConfigOptionDescriptorValue(options, "fast", speed)
	return options
}

func ensureClaudeSDKConfigOption(options *[]map[string]any, fallback map[string]any) {
	id := strings.TrimSpace(asString(fallback["id"]))
	if id == "" {
		return
	}
	for _, option := range *options {
		if strings.TrimSpace(asString(option["id"])) == id {
			return
		}
	}
	*options = append(*options, clonePayloadDeep(fallback))
}

func claudeSDKEffortConfigOption(effort string) map[string]any {
	selectedEffort := claudeSDKCanonicalEffort(effort)
	if selectedEffort == "" {
		selectedEffort = "high"
	}
	return map[string]any{
		"id":           "effort",
		"name":         "Reasoning",
		"currentValue": selectedEffort,
		"options": []map[string]string{
			{"name": "Low", "value": "low"},
			{"name": "Medium", "value": "medium"},
			{"name": "High", "value": "high"},
			{"name": "Extra High", "value": "xhigh"},
		},
	}
}

func claudeSDKSpeedConfigOption(speed string) map[string]any {
	selectedSpeed := claudeSDKCanonicalSpeed(speed)
	if selectedSpeed == "" {
		selectedSpeed = sessionSpeedStandard
	}
	return map[string]any{
		"id":           "fast",
		"name":         "Speed",
		"currentValue": selectedSpeed,
		"options": []map[string]string{
			{"name": "Standard", "value": sessionSpeedStandard},
			{"name": "Fast", "value": sessionSpeedFast},
		},
	}
}

func claudeSDKSessionModel(session Session, state acpLiveState) string {
	if model := claudeSDKCanonicalModel(asString(state.configOptions["model"])); model != "" {
		return model
	}
	if session.Settings != nil {
		if model := claudeSDKCanonicalModel(session.Settings.Model); model != "" {
			return model
		}
	}
	return "default"
}

func claudeSDKSessionReasoningEffort(session Session, state acpLiveState) string {
	if effort := claudeSDKCanonicalEffort(asString(state.configOptions["effort"])); effort != "" {
		return effort
	}
	if session.Settings != nil {
		if effort := claudeSDKCanonicalEffort(session.Settings.ReasoningEffort); effort != "" {
			return effort
		}
	}
	return "high"
}

func claudeSDKSessionSpeed(session Session, state acpLiveState) string {
	if speed := claudeSDKCanonicalSpeed(asString(state.configOptions["fast"])); speed != "" {
		return speed
	}
	if session.Settings != nil {
		if speed := claudeSDKCanonicalSpeed(session.Settings.Speed); speed != "" {
			return speed
		}
	}
	return sessionSpeedStandard
}

func claudeSDKSessionPermissionMode(session Session, state acpLiveState) string {
	if mode := claudeSDKPermissionMode(asString(state.configOptions["mode"])); mode != "" && mode != "plan" {
		return mode
	}
	return claudeSDKPermissionMode(firstNonEmpty(session.PermissionModeID, session.SettingsValue().PermissionModeID))
}

func claudeSDKCanonicalModel(model string) string {
	model = strings.TrimSpace(model)
	if model == "" {
		return ""
	}
	if claudeSDKModelOptionExists(model) {
		return model
	}
	return model
}

func claudeSDKCanonicalEffort(effort string) string {
	switch strings.TrimSpace(effort) {
	case "low", "medium", "high", "xhigh":
		return strings.TrimSpace(effort)
	default:
		return ""
	}
}

func claudeSDKCanonicalSpeed(speed string) string {
	switch strings.TrimSpace(speed) {
	case sessionSpeedStandard, claudeCodeACPFastOff:
		return sessionSpeedStandard
	case sessionSpeedFast, claudeCodeACPFastOn:
		return sessionSpeedFast
	default:
		return ""
	}
}

func claudeSDKSpeedFromFastModeState(state string) string {
	switch strings.TrimSpace(state) {
	case "on":
		return sessionSpeedFast
	case "off":
		return sessionSpeedStandard
	default:
		return ""
	}
}

func claudeSDKEffectivePermissionMode(session Session) string {
	settings := session.SettingsValue()
	if settings.PlanMode {
		return "plan"
	}
	return claudeSDKPermissionMode(firstNonEmpty(session.PermissionModeID, settings.PermissionModeID))
}

func claudeSDKPermissionMode(mode string) string {
	switch strings.TrimSpace(mode) {
	case "default", "acceptEdits", "dontAsk", "bypassPermissions", "auto", "plan":
		return strings.TrimSpace(mode)
	default:
		return ""
	}
}

func claudeSDKModelOptionExists(model string) bool {
	switch strings.TrimSpace(model) {
	case "default", "opus", "sonnet", "haiku":
		return true
	default:
		return false
	}
}

func findRepoRoot() string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	for {
		if fileExists(filepath.Join(dir, "pnpm-workspace.yaml")) && fileExists(filepath.Join(dir, "packages/agent/claude-sdk-sidecar/src/main.ts")) {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func envListToMap(env []string) map[string]any {
	if len(env) == 0 {
		return nil
	}
	result := make(map[string]any, len(env))
	for _, item := range env {
		key, value, ok := strings.Cut(item, "=")
		if !ok || strings.TrimSpace(key) == "" {
			continue
		}
		result[key] = value
	}
	return result
}

func claudeSDKSessionSettingsPayload(session Session) map[string]any {
	settings := session.SettingsValue()
	payload := map[string]any{
		"model":            strings.TrimSpace(settings.Model),
		"permissionModeId": strings.TrimSpace(settings.PermissionModeID),
		"planMode":         settings.PlanMode,
		"reasoningEffort":  strings.TrimSpace(settings.ReasoningEffort),
		"speed":            claudeSDKCanonicalSpeed(settings.Speed),
	}
	return payload
}

func promptTextForClaudeSDK(content []PromptContentBlock, fallback string) string {
	var parts []string
	for _, block := range content {
		if strings.TrimSpace(block.Type) == "text" && strings.TrimSpace(block.Text) != "" {
			parts = append(parts, strings.TrimSpace(block.Text))
		}
	}
	if len(parts) > 0 {
		return strings.Join(parts, "\n\n")
	}
	return fallback
}

func promptContentForClaudeSDK(content []PromptContentBlock, fallback string) []map[string]any {
	blocks := make([]map[string]any, 0, len(content))
	for _, block := range content {
		switch strings.TrimSpace(block.Type) {
		case "text":
			text := strings.TrimSpace(block.Text)
			if text == "" {
				continue
			}
			blocks = append(blocks, map[string]any{
				"type": "text",
				"text": text,
			})
		case "image":
			mimeType := strings.TrimSpace(block.MimeType)
			data := strings.TrimSpace(block.Data)
			if !runtimePromptImageMimeTypeSupported(mimeType) || data == "" {
				continue
			}
			blocks = append(blocks, map[string]any{
				"type":     "image",
				"mimeType": mimeType,
				"data":     data,
			})
		}
	}
	if len(blocks) == 0 && strings.TrimSpace(fallback) != "" {
		blocks = append(blocks, map[string]any{
			"type": "text",
			"text": strings.TrimSpace(fallback),
		})
	}
	return blocks
}

func cloneOptionalSessionSettings(settings *SessionSettings) *SessionSettings {
	if settings == nil {
		return nil
	}
	cloned := *settings
	if settings.BrowserUse != nil {
		value := *settings.BrowserUse
		cloned.BrowserUse = &value
	}
	if settings.ComputerUse != nil {
		value := *settings.ComputerUse
		cloned.ComputerUse = &value
	}
	return &cloned
}
