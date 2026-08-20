package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (c *Controller) ensureLiveAdapterSession(ctx context.Context, session Session, adapter Adapter) error {
	probe, ok := adapter.(LiveSessionProbeAdapter)
	if !ok || probe.HasLiveSession(session) {
		if session.IsSideConversation() {
			return nil
		}
		return c.applyRetainedGoalGenerationFencesOrClose(ctx, session, adapter)
	}
	if session.IsSideConversation() {
		// Ephemeral provider threads are deliberately not durable/resumable.
		// A lost process therefore expires the side instead of silently
		// reconnecting it as if it were a canonical session.
		c.forgetSideStreamEvents(session)
		return ErrSideConversationExpired
	}
	if strings.TrimSpace(session.ProviderSessionID) == "" {
		return ErrSessionDisconnected
	}
	c.invalidateAppliedGoalGenerationFences(session)
	// Resume only reconnects provider context; it does not execute a Turn.
	// Host startup separately settles stale pre-restart Turns as interrupted.
	// Install retained admission fences before this Controller dispatches the
	// user operation that requested the connection.
	if err := adapter.Resume(ctx, session); err != nil {
		return err
	}
	c.advanceLiveConnectionGeneration(session.RoomID, session.AgentSessionID)
	if err := c.applyRetainedGoalGenerationFencesOrClose(ctx, session, adapter); err != nil {
		return err
	}
	session.Status = SessionStatusReady
	session.UpdatedAtUnixMS = unixMS(now())
	c.store(session)
	if !c.publishPendingCommandSnapshot(session) {
		c.publishAdapterCommandSnapshot(session, adapter)
	}
	return nil
}

func (c *Controller) ReleaseIdleLiveSessions(ctx context.Context, input ReleaseIdleLiveSessionsInput) ReleaseIdleLiveSessionsResult {
	var result ReleaseIdleLiveSessionsResult
	if c == nil || input.IdleAfter <= 0 {
		return result
	}
	nowTime := input.Now
	if nowTime.IsZero() {
		nowTime = now()
	}
	nowUnixMS := unixMS(nowTime)
	idleAfterMS := input.IdleAfter.Milliseconds()
	if idleAfterMS <= 0 {
		return result
	}
	type candidate struct {
		session Session
		adapter Adapter
	}
	candidates := make([]candidate, 0)
	c.mu.Lock()
	for key, session := range c.sessions {
		session = c.reconcileSessionStatusLocked(key, session)
		c.sessions[key] = session
		// Side owns an explicit ephemeral lifecycle. The canonical idle
		// reaper cannot synchronize the Host registration or emit a Side
		// expiry transition, so it must not reclaim Side connections.
		if session.IsSideConversation() {
			continue
		}
		candidates = append(candidates, candidate{
			session: session,
			adapter: c.adapters[session.Provider],
		})
	}
	c.mu.Unlock()
	failedProviders := make(map[string]bool)
	for _, candidate := range candidates {
		if input.Limit > 0 && result.Scanned >= input.Limit {
			break
		}
		result.Scanned++
		provider := strings.TrimSpace(candidate.session.Provider)
		if failedProviders[provider] {
			result.SkippedCleanupBudget++
			continue
		}
		next := c.releaseIdleLiveSession(ctx, candidate.session, candidate.adapter, nowUnixMS, idleAfterMS)
		result.add(next)
		if next.Failed > 0 {
			failedProviders[provider] = true
		}
	}
	cleanup := c.cleanupDetachedLiveSessionResources(ctx, failedProviders)
	result.ResourceCleanupAttempted = cleanup.Attempted
	result.ResourceCleanupCleaned = cleanup.Cleaned
	result.ResourceCleanupFailed = cleanup.Failed
	return result
}

func (c *Controller) releaseIdleLiveSession(
	ctx context.Context,
	session Session,
	adapter Adapter,
	nowUnixMS int64,
	idleAfterMS int64,
) ReleaseIdleLiveSessionsResult {
	var result ReleaseIdleLiveSessionsResult
	_, probe, ok := liveSessionReleaseAdapter(adapter, session)
	if !ok {
		result.SkippedUnsupported = 1
		return result
	}
	if strings.TrimSpace(session.ProviderSessionID) == "" || !probe.HasLiveSession(session) {
		result.SkippedNotLive = 1
		return result
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	_, hasActiveTurn := c.turns[key]
	c.mu.Unlock()
	if hasActiveTurn {
		result.SkippedActiveTurn = 1
		return result
	}
	if !sessionIdleFor(session, nowUnixMS, idleAfterMS) {
		result.SkippedFresh = 1
		return result
	}

	releaseLifecycleLock := c.acquireLifecycleLock(session.RoomID, session.AgentSessionID)
	defer releaseLifecycleLock()

	refreshed, adapter, err := c.sessionAndAdapter(session.RoomID, session.AgentSessionID)
	if err != nil {
		result.SkippedNotLive = 1
		return result
	}
	releaseAdapter, probe, ok := liveSessionReleaseAdapter(adapter, refreshed)
	if !ok {
		result.SkippedUnsupported = 1
		return result
	}
	if strings.TrimSpace(refreshed.ProviderSessionID) == "" || !probe.HasLiveSession(refreshed) {
		result.SkippedNotLive = 1
		return result
	}
	if c.HasActiveTurn(refreshed.RoomID, refreshed.AgentSessionID) {
		result.SkippedActiveTurn = 1
		return result
	}
	if !sessionIdleFor(refreshed, nowUnixMS, idleAfterMS) {
		result.SkippedFresh = 1
		return result
	}
	if err := releaseAdapter.ReleaseLiveSession(ctx, refreshed); err != nil {
		if errors.Is(err, ErrLiveSessionBusy) {
			result.SkippedBusy = 1
			return result
		}
		result.Failed = 1
		slog.Warn("agent live session release failed",
			"event", "agent_session.live_release.failed",
			"room_id", refreshed.RoomID,
			"agent_session_id", refreshed.AgentSessionID,
			"provider", refreshed.Provider,
			"provider_session_id", refreshed.ProviderSessionID,
			"error", err.Error(),
		)
		return result
	}
	c.invalidateAppliedGoalGenerationFences(refreshed)
	result.Released = 1
	return result
}

func liveSessionReleaseAdapter(adapter Adapter, session Session) (LiveSessionReleaseAdapter, LiveSessionProbeAdapter, bool) {
	releaseAdapter, releaseOK := adapter.(LiveSessionReleaseAdapter)
	probe, probeOK := adapter.(LiveSessionProbeAdapter)
	if !releaseOK || !probeOK {
		return releaseAdapter, probe, false
	}
	if capability, ok := adapter.(LiveSessionReleaseCapabilityAdapter); ok && !capability.CanReleaseLiveSession(session) {
		return releaseAdapter, probe, false
	}
	return releaseAdapter, probe, true
}

// DisconnectRuntimeSession force-releases one Workspace-scoped provider
// transport while preserving the Controller session and its provider resume
// identity. It serializes with admission for the same Session and never calls
// Adapter.Close, whose provider protocol semantics may be destructive.
func (c *Controller) DisconnectRuntimeSession(
	ctx context.Context,
	roomID string,
	agentSessionID string,
) (DisconnectRuntimeSessionResult, error) {
	roomID = strings.TrimSpace(roomID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if c == nil || roomID == "" || agentSessionID == "" {
		return DisconnectRuntimeSessionResult{}, errors.New("room id and agent session id are required")
	}
	releaseLifecycleLock, err := c.acquireLifecycleLockContext(ctx, roomID, agentSessionID)
	if err != nil {
		return DisconnectRuntimeSessionResult{}, err
	}
	defer releaseLifecycleLock()
	return c.disconnectRuntimeSessionLocked(ctx, roomID, agentSessionID)
}

// SnapshotRuntimeDisconnectTargets captures exact provider-connection
// incarnations without waiting for startup publication. It is used only by a
// reentrant attachment cleanup that cannot wait for its own Host operation.
func (c *Controller) SnapshotRuntimeDisconnectTargets(roomID string) []RuntimeDisconnectTarget {
	if c == nil {
		return nil
	}
	roomID = strings.TrimSpace(roomID)
	c.mu.Lock()
	defer c.mu.Unlock()
	targets := make([]RuntimeDisconnectTarget, 0)
	for key, session := range c.sessions {
		if strings.TrimSpace(session.RoomID) != roomID {
			continue
		}
		generation := c.liveConnectionGenerations[key]
		if generation == 0 {
			c.nextLiveConnectionGeneration++
			generation = c.nextLiveConnectionGeneration
			c.liveConnectionGenerations[key] = generation
		}
		targets = append(targets, RuntimeDisconnectTarget{
			RoomID: roomID, AgentSessionID: session.AgentSessionID,
			ConnectionGeneration: generation,
		})
	}
	return targets
}

// DisconnectRuntimeSessionTarget releases a provider connection only when the
// captured incarnation is still current.
func (c *Controller) DisconnectRuntimeSessionTarget(
	ctx context.Context,
	target RuntimeDisconnectTarget,
) (DisconnectRuntimeSessionResult, error) {
	roomID := strings.TrimSpace(target.RoomID)
	agentSessionID := strings.TrimSpace(target.AgentSessionID)
	if c == nil || roomID == "" || agentSessionID == "" || target.ConnectionGeneration == 0 {
		return DisconnectRuntimeSessionResult{}, errors.New("runtime disconnect target is invalid")
	}
	releaseLifecycleLock, err := c.acquireLifecycleLockContext(ctx, roomID, agentSessionID)
	if err != nil {
		return DisconnectRuntimeSessionResult{}, err
	}
	defer releaseLifecycleLock()
	c.mu.Lock()
	current := c.liveConnectionGenerations[sessionKey(roomID, agentSessionID)]
	c.mu.Unlock()
	if current != target.ConnectionGeneration {
		return DisconnectRuntimeSessionResult{}, nil
	}
	return c.disconnectRuntimeSessionLocked(ctx, roomID, agentSessionID)
}

func (c *Controller) disconnectRuntimeSessionLocked(
	ctx context.Context,
	roomID string,
	agentSessionID string,
) (DisconnectRuntimeSessionResult, error) {

	session, adapter, err := c.sessionAndAdapter(roomID, agentSessionID)
	if errors.Is(err, ErrSessionNotFound) {
		return DisconnectRuntimeSessionResult{}, nil
	}
	if err != nil {
		return DisconnectRuntimeSessionResult{}, err
	}
	probe, probeOK := adapter.(LiveSessionProbeAdapter)
	disconnector, disconnectOK := adapter.(LiveSessionDisconnectAdapter)
	if !probeOK || !disconnectOK {
		return DisconnectRuntimeSessionResult{}, fmt.Errorf(
			"agent provider %q does not support workspace runtime disconnect",
			session.Provider,
		)
	}
	wasLive := probe.HasLiveSession(session)
	if wasLive {
		c.cancelActiveTurn(roomID, agentSessionID)
	}
	// Always invoke the idempotent adapter cleanup, even when its liveness probe
	// is false. A raw transport death can make the probe false while the adapter
	// still owns pending interactions or a close-failed physical handle.
	if err := disconnector.DisconnectLiveSession(ctx, session); err != nil {
		return DisconnectRuntimeSessionResult{}, err
	}
	c.invalidateAppliedGoalGenerationFences(session)
	return DisconnectRuntimeSessionResult{Disconnected: wasLive}, nil
}

func (c *Controller) cleanupDetachedLiveSessionResources(ctx context.Context, failedProviders map[string]bool) LiveSessionResourceCleanupResult {
	var result LiveSessionResourceCleanupResult
	if c == nil {
		return result
	}
	c.mu.Lock()
	adapters := make([]Adapter, 0, len(c.adapters))
	for _, adapter := range c.adapters {
		adapters = append(adapters, adapter)
	}
	c.mu.Unlock()
	for _, adapter := range adapters {
		if failedProviders[strings.TrimSpace(adapter.Provider())] {
			continue
		}
		cleanup, ok := adapter.(LiveSessionResourceCleanupAdapter)
		if !ok {
			continue
		}
		next := cleanup.CleanupLiveSessionResources(ctx, 1)
		result.Attempted += next.Attempted
		result.Cleaned += next.Cleaned
		result.Failed += next.Failed
		if next.Failed > 0 {
			slog.Warn("agent detached live session resource cleanup failed",
				"event", "agent_session.live_resource_cleanup.failed",
				"provider", adapter.Provider(),
				"attempted", next.Attempted,
				"failed", next.Failed,
			)
		}
	}
	return result
}

// CloseAllLiveSessions force-terminates every live provider process across
// all sessions, regardless of idle time, active turns, or pending approval
// requests. Unlike ReleaseIdleLiveSessions (the periodic reaper, which only
// reclaims idle, non-busy sessions so it never interrupts work in
// progress), this exists for daemon shutdown: an OS process is not killed
// automatically just because its parent (tuttid) exits — it is reparented
// and keeps running. A provider subprocess (e.g. a Codex app-server) left
// behind here would keep running unmanaged, still able to act on the
// session's working directory, until something else notices and kills it.
// Call this once, during shutdown, before the daemon process exits.
//
// This only closes the provider-side process; it deliberately does not
// mark sessions completed or delete their records, so providers that
// support live-session resume (see LiveSessionReleaseAdapter) reconnect
// normally the next time the daemon starts and the session resumes.
func (c *Controller) CloseAllLiveSessions(ctx context.Context) CloseAllLiveSessionsResult {
	var result CloseAllLiveSessionsResult
	if c == nil {
		return result
	}
	type candidate struct {
		session Session
		adapter Adapter
	}
	c.mu.Lock()
	candidates := make([]candidate, 0, len(c.sessions))
	for _, session := range c.sessions {
		candidates = append(candidates, candidate{
			session: session,
			adapter: c.adapters[session.Provider],
		})
	}
	c.mu.Unlock()
	failedProviders := make(map[string]bool)

	for _, cand := range candidates {
		provider := strings.TrimSpace(cand.session.Provider)
		if failedProviders[provider] {
			result.SkippedCleanupBudget++
			continue
		}
		probe, ok := cand.adapter.(LiveSessionProbeAdapter)
		if !ok || !probe.HasLiveSession(cand.session) {
			continue
		}
		result.Scanned++
		releaseLifecycleLock, lockErr := c.acquireLifecycleLockContext(ctx, cand.session.RoomID, cand.session.AgentSessionID)
		if lockErr != nil {
			result.Failed++
			failedProviders[provider] = true
			slog.Warn("agent live session shutdown lock failed",
				"event", "agent_session.shutdown_close.lock_failed",
				"room_id", cand.session.RoomID,
				"agent_session_id", cand.session.AgentSessionID,
				"provider", cand.session.Provider,
				"error", lockErr.Error(),
			)
			if ctx.Err() != nil {
				break
			}
			continue
		}
		err := cand.adapter.Close(ctx, cand.session)
		releaseLifecycleLock()
		if err != nil {
			result.Failed++
			failedProviders[provider] = true
			slog.Warn("agent live session shutdown close failed",
				"event", "agent_session.shutdown_close.failed",
				"room_id", cand.session.RoomID,
				"agent_session_id", cand.session.AgentSessionID,
				"provider", cand.session.Provider,
				"error", err.Error(),
			)
			continue
		}
		result.Closed++
	}
	cleanup := c.cleanupDetachedLiveSessionResources(ctx, failedProviders)
	result.ResourceCleanupAttempted = cleanup.Attempted
	result.ResourceCleanupCleaned = cleanup.Cleaned
	result.ResourceCleanupFailed = cleanup.Failed
	return result
}

func sessionIdleFor(session Session, nowUnixMS int64, idleAfterMS int64) bool {
	if session.UpdatedAtUnixMS <= 0 {
		return false
	}
	return nowUnixMS-session.UpdatedAtUnixMS >= idleAfterMS
}

func (r *ReleaseIdleLiveSessionsResult) add(next ReleaseIdleLiveSessionsResult) {
	r.Released += next.Released
	r.SkippedFresh += next.SkippedFresh
	r.SkippedActiveTurn += next.SkippedActiveTurn
	r.SkippedUnsupported += next.SkippedUnsupported
	r.SkippedNotLive += next.SkippedNotLive
	r.SkippedBusy += next.SkippedBusy
	r.SkippedCleanupBudget += next.SkippedCleanupBudget
	r.Failed += next.Failed
}

// isResumeRecreatableError reports whether a failed resume should fall back to
// creating a fresh provider session in place. These are the "the provider
// session is not available locally" cases — anything else is a genuine failure
// that should surface to the caller.
func isResumeRecreatableError(err error) bool {
	switch AppErrorCode(err) {
	case AppErrorProviderSessionNotFound, AppErrorResumeSessionNotLocal:
		return true
	default:
		return false
	}
}

// recreateAdapterSession starts a brand new provider session for an existing
// agent session, clearing the stale provider session id so the adapter mints a
// fresh one. The new provider session id is captured from the started events and
// persisted via the session report, keeping the conversation continuable.
//
// The freshly started provider session has no memory of anything said before
// this point (e.g. an externally-imported conversation whose rollout only
// ever existed on another device, or local history retention pruning it) even
// though the transcript keeps showing the old messages joined seamlessly with
// new ones. Without an explicit notice this looks to the user like the agent
// silently forgot the conversation, so a visible system notice is appended
// alongside the started events.
func (c *Controller) recreateAdapterSession(ctx context.Context, session Session, adapter Adapter) error {
	fresh := session
	fresh.ProviderSessionID = ""
	fresh.Status = SessionStatusReady
	fresh.LastError = ""
	fresh.UpdatedAtUnixMS = unixMS(now())
	events, err := adapter.Start(ctx, fresh)
	if err != nil {
		return err
	}
	c.advanceLiveConnectionGeneration(fresh.RoomID, fresh.AgentSessionID)
	fresh = applySessionEvents(fresh, events)
	c.invalidateAppliedGoalGenerationFences(fresh)
	if err := c.applyRetainedGoalGenerationFencesOrClose(ctx, fresh, adapter); err != nil {
		return err
	}
	fresh.Status = SessionStatusReady
	fresh.UpdatedAtUnixMS = unixMS(now())
	if notice, ok := sessionRecreatedNoticeEvent(fresh); ok {
		events = append(events, notice)
	}
	c.store(fresh)
	c.publish(fresh, events)
	c.publishPendingConfigOptionsUpdates(fresh)
	if !c.publishPendingCommandSnapshot(fresh) {
		c.publishAdapterCommandSnapshot(fresh, adapter)
	}
	c.enqueueSessionReport(ctx, fresh, events)
	return nil
}

// sessionRecreatedNoticeEvent builds the visible system notice that
// accompanies a recreated provider session (see recreateAdapterSession). It
// reuses the same synthetic "agent_system_notice" message shape the ACP
// adapters already use for compaction/goal/transport notices
// (acpSystemNoticeEvent), so it renders through the existing generic notice
// card with no GUI changes required.
func sessionRecreatedNoticeEvent(session Session) (activityshared.Event, bool) {
	return acpSystemNoticeEvent(session, "", map[string]any{
		"sessionUpdate": "system_notice",
		"kind":          "agent_system_notice",
		"noticeKind":    "warning",
		"title":         "Conversation history could not be restored",
		"detail":        "The assistant could not resume this conversation's earlier messages locally (for example, if it was imported from another device or the local session data is no longer available), so this reply is starting fresh without that context.",
	}, "system_notice", true)
}

func (c *Controller) ValidatePromptContent(_ context.Context, input ExecInput) error {
	session, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return err
	}
	if err := validatePromptContentImagesForPreflight(input.Content); err != nil {
		return err
	}
	content := normalizeRuntimePromptContentForValidation(input.Content)
	if len(content) == 0 {
		return fmt.Errorf("prompt is required")
	}
	providerContent := projectRuntimeConnectorPromptContent(content)
	if promptAdapter, ok := adapter.(PromptContentAdapter); ok {
		return promptAdapter.ValidatePromptContent(session, providerContent)
	}
	return nil
}
