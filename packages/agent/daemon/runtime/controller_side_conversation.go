package agentruntime

import (
	"context"
	"fmt"
	"sort"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// SideCapabilities resolves the exact live adapter selected by the source
// session. Provider names alone never imply side support.
func (c *Controller) SideCapabilities(
	ctx context.Context,
	roomID string,
	sourceAgentSessionID string,
) (SideConversationCapabilities, error) {
	release, err := c.acquireLifecycleLockContext(
		ctx, strings.TrimSpace(roomID), strings.TrimSpace(sourceAgentSessionID),
	)
	if err != nil {
		return SideConversationCapabilities{}, err
	}
	defer release()
	_, _, capabilities, err := c.sideSourceCapabilitiesLocked(
		ctx, roomID, sourceAgentSessionID, nil,
	)
	return capabilities, err
}

// SideCapabilitiesForSource resolves Side support from a Host-prepared source
// snapshot when the canonical provider connection is no longer retained.
func (c *Controller) SideCapabilitiesForSource(
	ctx context.Context,
	source Session,
) (SideConversationCapabilities, error) {
	roomID := strings.TrimSpace(source.RoomID)
	sourceID := strings.TrimSpace(source.AgentSessionID)
	if roomID == "" || sourceID == "" {
		return SideConversationCapabilities{}, fmt.Errorf(
			"room and source session ids are required",
		)
	}
	release, err := c.acquireLifecycleLockContext(ctx, roomID, sourceID)
	if err != nil {
		return SideConversationCapabilities{}, err
	}
	defer release()
	_, _, capabilities, err := c.sideSourceCapabilitiesLocked(
		ctx, roomID, sourceID, &source,
	)
	return capabilities, err
}

func (c *Controller) sideSourceCapabilitiesLocked(
	ctx context.Context,
	roomID string,
	sourceAgentSessionID string,
	requested *Session,
) (Session, Adapter, SideConversationCapabilities, error) {
	var source Session
	var adapter Adapter
	var err error
	if requested == nil {
		source, adapter, err = c.sessionAndAdapter(
			strings.TrimSpace(roomID),
			strings.TrimSpace(sourceAgentSessionID),
		)
	} else {
		source, adapter, err = c.sessionForkSource(ctx, *requested)
	}
	if err != nil {
		return Session{}, nil, SideConversationCapabilities{}, err
	}
	if source.IsSideConversation() {
		return Session{}, nil, SideConversationCapabilities{}, ErrSideConversationUnsupported
	}
	sideAdapter, ok := adapter.(SideConversationAdapter)
	if !ok {
		return source, adapter, SideConversationCapabilities{}, nil
	}
	capabilities, err := sideAdapter.SideCapabilities(ctx, source)
	return source, adapter, capabilities, err
}

// OpenSide reserves the side identity before invoking the provider. That
// reservation is the open transaction's event buffer: provider notifications
// that race the fork response already have a side-scoped route, while failure
// rolls the entire transient registration back.
func (c *Controller) OpenSide(
	ctx context.Context,
	input SideConversationOpenInput,
) (SideConversationOpenResult, error) {
	roomID := strings.TrimSpace(input.RoomID)
	sourceID := strings.TrimSpace(input.SourceAgentSessionID)
	sideID := strings.TrimSpace(input.SideAgentSessionID)
	requestID := strings.TrimSpace(input.RequestID)
	if roomID == "" || sourceID == "" || sideID == "" || requestID == "" {
		return SideConversationOpenResult{}, fmt.Errorf(
			"room, source session, side session, and request ids are required",
		)
	}
	if sourceID == sideID {
		return SideConversationOpenResult{}, ErrSideConversationConflict
	}
	if requested := sideRequestedSource(input); requested != nil &&
		(strings.TrimSpace(requested.RoomID) != roomID ||
			strings.TrimSpace(requested.AgentSessionID) != sourceID) {
		return SideConversationOpenResult{}, fmt.Errorf(
			"prepared source identity does not match side open input",
		)
	}

	release, err := c.acquireSideConversationLifecycleLocks(
		ctx,
		roomID,
		sourceID,
		sideID,
	)
	if err != nil {
		return SideConversationOpenResult{}, err
	}
	defer release()
	key := sessionKey(roomID, sideID)

	if existing, found := c.get(roomID, sideID); found {
		if existing.IsSideConversation() &&
			existing.SourceAgentSessionID == sourceID &&
			existing.SideRequestID == requestID {
			_, _, capabilities, err := c.sideSourceCapabilitiesLocked(
				ctx, roomID, sourceID, sideRequestedSource(input),
			)
			return SideConversationOpenResult{
				Session: existing, Capabilities: capabilities,
			}, err
		}
		return SideConversationOpenResult{}, ErrSideConversationConflict
	}

	source, adapter, capabilities, err := c.sideSourceCapabilitiesLocked(
		ctx, roomID, sourceID, sideRequestedSource(input),
	)
	if err != nil {
		return SideConversationOpenResult{}, err
	}
	sideAdapter, ok := adapter.(SideConversationAdapter)
	if !ok {
		return SideConversationOpenResult{}, ErrSideConversationUnsupported
	}
	if !validRequiredSideCapabilities(capabilities) ||
		(c.HasActiveTurn(roomID, sourceID) && !capabilities.ActiveSourceTurn) {
		return SideConversationOpenResult{}, ErrSideConversationUnsupported
	}

	timestamp := unixMS(now())
	side := source
	side.AgentSessionID = sideID
	side.RootAgentSessionID = sideID
	side.ProviderSessionID = ""
	side.Scope = RuntimeSessionScopeSide
	side.SourceAgentSessionID = sourceID
	side.SideRequestID = requestID
	side.Resumable = false
	side.Status = SessionStatusReady
	side.TurnLifecycle = nil
	side.SubmitAvailability = availableSubmitAvailability()
	side.Title = "Side conversation"
	side.Visible = false
	side.CreatedAtUnixMS = timestamp
	side.UpdatedAtUnixMS = timestamp
	side.LifecycleAuthority = false
	side.LifecycleSeq = 0

	// Reserve before the adapter call so thread/fork notifications can never be
	// misrouted to the parent or dropped into the canonical stream.
	c.store(side)
	c.mu.Lock()
	c.provisionalSessions[key] = true
	c.mu.Unlock()
	result, err := sideAdapter.OpenSide(ctx, SideConversationAdapterOpenInput{
		Source: source, Side: side, RequestID: requestID,
	})
	if err != nil {
		c.removeRuntimeSession(side)
		return SideConversationOpenResult{}, err
	}
	opened := result.Session
	if strings.TrimSpace(opened.AgentSessionID) == "" {
		opened = side
	}
	if opened.AgentSessionID != sideID ||
		opened.RoomID != roomID ||
		opened.Provider != source.Provider ||
		strings.TrimSpace(opened.ProviderSessionID) == "" {
		// Never pass an untrusted identity to ordinary Close: a buggy adapter
		// could return the parent or another canonical Session and turn
		// validation into a destructive cleanup. OpenSide retains cleanup
		// ownership unless it returns the exact side-scoped identity.
		if opened.AgentSessionID == sideID &&
			opened.RoomID == roomID &&
			opened.IsSideConversation() &&
			opened.SourceAgentSessionID == sourceID {
			_ = adapter.Close(ctx, opened)
		}
		c.removeRuntimeSession(side)
		return SideConversationOpenResult{}, fmt.Errorf(
			"provider returned an invalid side session: %w",
			ErrSideConversationConflict,
		)
	}
	if !validRequiredSideCapabilities(result.Capabilities) {
		_ = adapter.Close(ctx, opened)
		c.removeRuntimeSession(side)
		return SideConversationOpenResult{}, ErrSideConversationUnsupported
	}
	if provisional, found := c.get(roomID, sideID); found &&
		provisional.IsSideConversation() {
		opened.Title = provisional.Title
		opened.LastError = provisional.LastError
		opened.RuntimeContext = clonePayload(provisional.RuntimeContext)
		opened.Status = provisional.Status
		opened.TurnLifecycle = provisional.TurnLifecycle
		opened.SubmitAvailability = provisional.SubmitAvailability
	}
	opened.Scope = RuntimeSessionScopeSide
	opened.SourceAgentSessionID = sourceID
	opened.SideRequestID = requestID
	opened.RootAgentSessionID = sideID
	opened.Resumable = false
	opened.Visible = false
	opened.Status = SessionStatusReady
	opened.TurnLifecycle = nil
	opened.SubmitAvailability = availableSubmitAvailability()
	opened.UpdatedAtUnixMS = unixMS(now())
	c.store(opened)

	result.Session = opened
	// Keep the provisional gate closed until session.started and every event
	// that raced OpenSide have been synchronously published. Clearing it
	// before session.started would allow a new provider notification to
	// overtake the open marker.
	c.publish(opened, []activityshared.Event{
		newSessionActivityEvent(
			opened,
			EventSessionStarted,
			SessionStatusReady,
			map[string]any{
				"scope":                string(RuntimeSessionScopeSide),
				"sourceAgentSessionId": sourceID,
				"ephemeral":            result.Capabilities.Ephemeral,
			},
		),
	})
	hadBufferedCommand := c.drainSideOpenBuffers(opened, key)
	if !hadBufferedCommand {
		c.publishAdapterCommandSnapshot(opened, adapter)
	}
	return result, nil
}

func sideRequestedSource(input SideConversationOpenInput) *Session {
	if strings.TrimSpace(input.Source.AgentSessionID) == "" {
		return nil
	}
	source := input.Source
	return &source
}

func (c *Controller) acquireSideConversationLifecycleLocks(
	ctx context.Context,
	roomID string,
	sourceAgentSessionID string,
	sideAgentSessionID string,
) (func(), error) {
	sessionIDs := []string{
		strings.TrimSpace(sourceAgentSessionID),
		strings.TrimSpace(sideAgentSessionID),
	}
	sort.Strings(sessionIDs)
	releases := make([]func(), 0, len(sessionIDs))
	for _, sessionID := range sessionIDs {
		release, err := c.acquireLifecycleLockContext(ctx, roomID, sessionID)
		if err != nil {
			for index := len(releases) - 1; index >= 0; index-- {
				releases[index]()
			}
			return nil, err
		}
		releases = append(releases, release)
	}
	return func() {
		for index := len(releases) - 1; index >= 0; index-- {
			releases[index]()
		}
	}, nil
}

func (c *Controller) drainSideOpenBuffers(session Session, key string) bool {
	hadCommand := false
	for {
		c.mu.Lock()
		events := append(
			[]activityshared.Event(nil),
			c.pendingSideEvents[key]...,
		)
		delete(c.pendingSideEvents, key)
		configUpdates := append(
			[]AgentSessionConfigOptionsUpdate(nil),
			c.pendingConfigOptionsUpdates[key]...,
		)
		delete(c.pendingConfigOptionsUpdates, key)
		commandSnapshot, hasCommand := c.pendingCommandSnapshots[session.AgentSessionID]
		if hasCommand {
			delete(c.pendingCommandSnapshots, session.AgentSessionID)
			hadCommand = true
		}
		if len(events) == 0 && len(configUpdates) == 0 && !hasCommand {
			delete(c.provisionalSessions, key)
			c.mu.Unlock()
			return hadCommand
		}
		c.mu.Unlock()

		c.publish(session, events)
		c.publishConfigOptionsUpdates(session, configUpdates)
		if hasCommand {
			c.applyCommandSnapshot(session, commandSnapshot)
		}
	}
}

func validRequiredSideCapabilities(capabilities SideConversationCapabilities) bool {
	return capabilities.Supported &&
		capabilities.ActiveSourceTurn &&
		capabilities.Ephemeral &&
		capabilities.HideInheritedTurns &&
		capabilities.ModelBoundaryInjected
}

func (c *Controller) removeRuntimeSession(session Session) {
	if c == nil {
		return
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	delete(c.sessions, key)
	delete(c.turns, key)
	delete(c.commands, key)
	delete(c.pendingCommandSnapshots, session.AgentSessionID)
	delete(c.pendingConfigOptionsUpdates, key)
	delete(c.provisionalSessions, key)
	delete(c.pendingSideEvents, key)
	delete(c.goalGenerationFences, key)
	c.mu.Unlock()
	c.forgetSideStreamEvents(session)
}
