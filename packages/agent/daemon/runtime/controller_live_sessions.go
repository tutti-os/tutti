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
		return nil
	}
	if strings.TrimSpace(session.ProviderSessionID) == "" {
		return ErrSessionDisconnected
	}
	if err := adapter.Resume(ctx, session); err != nil {
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
		candidates = append(candidates, candidate{
			session: session,
			adapter: c.adapters[session.Provider],
		})
	}
	c.mu.Unlock()
	for _, candidate := range candidates {
		if input.Limit > 0 && result.Scanned >= input.Limit {
			break
		}
		result.Scanned++
		result.add(c.releaseIdleLiveSession(ctx, candidate.session, candidate.adapter, nowUnixMS, idleAfterMS))
	}
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
	_, probe, ok := liveSessionReleaseAdapter(adapter)
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
	releaseAdapter, probe, ok := liveSessionReleaseAdapter(adapter)
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
	result.Released = 1
	return result
}

func liveSessionReleaseAdapter(adapter Adapter) (LiveSessionReleaseAdapter, LiveSessionProbeAdapter, bool) {
	releaseAdapter, releaseOK := adapter.(LiveSessionReleaseAdapter)
	probe, probeOK := adapter.(LiveSessionProbeAdapter)
	return releaseAdapter, probe, releaseOK && probeOK
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

	for _, cand := range candidates {
		probe, ok := cand.adapter.(LiveSessionProbeAdapter)
		if !ok || !probe.HasLiveSession(cand.session) {
			continue
		}
		result.Scanned++
		releaseLifecycleLock := c.acquireLifecycleLock(cand.session.RoomID, cand.session.AgentSessionID)
		err := cand.adapter.Close(ctx, cand.session)
		releaseLifecycleLock()
		if err != nil {
			result.Failed++
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
	fresh = applySessionEvents(fresh, events)
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
	if promptAdapter, ok := adapter.(PromptContentAdapter); ok {
		return promptAdapter.ValidatePromptContent(session, content)
	}
	return nil
}
