package agentsessionstore

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"
)

const (
	syncInterval    = 5 * time.Second
	messagePageSize = 20
	messageMaxPages = 10
)

// SyncBackoffConfig configures per-session exponential backoff for failed
// message syncs in the background syncer. After a retryable failure (HTTP 429
// or 5xx) the session's message sync is skipped until the backoff window
// elapses; each consecutive failure multiplies the delay by Multiplier up to
// MaxDelay, and any success resets it. The zero value disables backoff
// entirely, preserving historical retry-every-tick behavior.
type SyncBackoffConfig struct {
	// InitialDelay is the wait after the first retryable failure. A
	// non-positive value disables backoff.
	InitialDelay time.Duration
	// MaxDelay caps the backoff delay. Defaults to InitialDelay when unset.
	MaxDelay time.Duration
	// Multiplier scales the delay after each consecutive failure. Values
	// below 1 are treated as 1 (constant delay).
	Multiplier float64
}

// DefaultSyncBackoffConfig returns the recommended backoff configuration:
// 10s initial delay, 5min cap, doubling per consecutive failure.
func DefaultSyncBackoffConfig() SyncBackoffConfig {
	return SyncBackoffConfig{
		InitialDelay: 10 * time.Second,
		MaxDelay:     5 * time.Minute,
		Multiplier:   2.0,
	}
}

func (c SyncBackoffConfig) enabled() bool {
	return c.InitialDelay > 0
}

func (c SyncBackoffConfig) nextDelay(current time.Duration) time.Duration {
	if current <= 0 {
		return c.InitialDelay
	}
	multiplier := c.Multiplier
	if multiplier < 1 {
		multiplier = 1
	}
	next := time.Duration(float64(current) * multiplier)
	maxDelay := c.MaxDelay
	if maxDelay <= 0 {
		maxDelay = c.InitialDelay
	}
	if next > maxDelay {
		next = maxDelay
	}
	return next
}

type sessionSyncer struct {
	svc      *Store
	client   ReadRepository
	triggers chan string

	backoff             SyncBackoffConfig
	mu                  sync.Mutex
	messageBackoffUntil map[string]time.Time
	messageBackoffDelay map[string]time.Duration
	now                 func() time.Time
}

func newSessionSyncer(svc *Store, client ReadRepository) *sessionSyncer {
	syncer := &sessionSyncer{
		svc:      svc,
		client:   client,
		triggers: make(chan string, 64),
		now:      time.Now,
	}
	if svc != nil {
		syncer.backoff = svc.syncBackoff
	}
	if syncer.backoff.enabled() {
		syncer.messageBackoffUntil = make(map[string]time.Time)
		syncer.messageBackoffDelay = make(map[string]time.Duration)
	}
	return syncer
}

func (s *sessionSyncer) run(ctx context.Context) {
	if s == nil || s.svc == nil || s.client == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}

	s.syncAllRooms(ctx)

	ticker := time.NewTicker(syncInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.syncAllRooms(ctx)
		case roomID := <-s.triggers:
			s.syncTriggeredRooms(ctx, roomID)
		}
	}
}

func (s *sessionSyncer) triggerRoom(roomID string) {
	roomID = strings.TrimSpace(roomID)
	if s == nil || roomID == "" {
		return
	}

	select {
	case s.triggers <- roomID:
	default:
	}
}

func (s *sessionSyncer) syncAllRooms(ctx context.Context) {
	if s == nil || s.svc == nil || s.client == nil {
		return
	}
	s.syncRooms(ctx, s.svc.listRoomIDs())
}

func (s *sessionSyncer) syncTriggeredRooms(ctx context.Context, firstRoomID string) {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-ctx.Done():
		return
	default:
	}

	rooms := map[string]struct{}{}
	if firstRoomID = strings.TrimSpace(firstRoomID); firstRoomID != "" {
		rooms[firstRoomID] = struct{}{}
	}

	for remaining := len(s.triggers); remaining > 0; remaining-- {
		select {
		case <-ctx.Done():
			return
		case roomID := <-s.triggers:
			if roomID = strings.TrimSpace(roomID); roomID != "" {
				rooms[roomID] = struct{}{}
			}
		}
	}

	roomIDs := make([]string, 0, len(rooms))
	for roomID := range rooms {
		roomIDs = append(roomIDs, roomID)
	}
	s.syncRooms(ctx, roomIDs)
}

func (s *sessionSyncer) syncRooms(ctx context.Context, roomIDs []string) {
	var wg sync.WaitGroup
	seen := make(map[string]struct{}, len(roomIDs))
	for _, roomID := range roomIDs {
		roomID = strings.TrimSpace(roomID)
		if roomID == "" {
			continue
		}
		if _, ok := seen[roomID]; ok {
			continue
		}
		seen[roomID] = struct{}{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.syncRoom(ctx, roomID)
		}()
	}
	wg.Wait()
}

func (s *sessionSyncer) syncRoom(ctx context.Context, roomID string) {
	current, ok := s.syncSessionState(ctx, roomID)
	if !ok {
		return
	}
	s.syncSessionMessages(ctx, roomID, current)
}

func (s *sessionSyncer) syncSessionState(ctx context.Context, roomID string) ([]ProviderActivitySessionProjection, bool) {
	if s == nil || s.svc == nil || s.client == nil {
		return nil, false
	}

	snapshot, err := s.client.ListAgents(ctx, roomID)
	if err != nil {
		slog.Warn("agent activity session state sync failed", "room_id", roomID, "error", err)
		return nil, false
	}
	if snapshot == nil {
		s.svc.updateStateForOrigin(roomID, WorkspaceAgentSnapshot{}, WorkspaceAgentSessionOriginRuntime)
		return nil, true
	}
	s.svc.updateStateForOrigin(roomID, *snapshot, WorkspaceAgentSessionOriginRuntime)
	return snapshot.Sessions, true
}

func isActiveSession(session ProviderActivitySessionProjection) bool {
	switch strings.ToLower(strings.TrimSpace(session.LifecycleStatus)) {
	case "completed", "failed", "canceled", "ended":
		return false
	}

	switch strings.ToLower(strings.TrimSpace(session.EffectiveStatus)) {
	case "working", "active", "running":
		return true
	default:
		return false
	}
}

func isTerminalSession(session ProviderActivitySessionProjection) bool {
	switch strings.ToLower(strings.TrimSpace(session.LifecycleStatus)) {
	case "completed", "failed", "canceled", "ended":
		return true
	default:
		return false
	}
}

func (s *sessionSyncer) syncSessionMessages(
	ctx context.Context,
	roomID string,
	sessions []ProviderActivitySessionProjection,
) {
	if s == nil || s.svc == nil || s.client == nil {
		return
	}
	seen := make(map[string]string, len(sessions))
	for _, session := range sessions {
		sessionID := strings.TrimSpace(session.AgentSessionID)
		if sessionID == "" {
			continue
		}
		if _, ok := seen[sessionID]; ok {
			continue
		}
		seen[sessionID] = NormalizeSessionOrigin(session.SessionOrigin)
		s.syncSessionMessagePages(ctx, roomID, sessionID, seen[sessionID])
	}
}

func (s *sessionSyncer) syncSessionMessagePages(ctx context.Context, roomID, agentSessionID string, sessionOrigin string) {
	if s == nil || s.svc == nil || s.client == nil {
		return
	}
	agentSessionID = strings.TrimSpace(agentSessionID)
	if agentSessionID == "" {
		return
	}
	backoffKey := messageSyncKey(roomID, agentSessionID)
	if s.messageSyncBackoffActive(backoffKey) {
		return
	}

	afterVersion := s.svc.getMessageVersionCursor(roomID, agentSessionID)
	for page := 0; page < messageMaxPages; page++ {
		reply, err := s.client.ListSessionMessages(ctx, ListSessionMessagesInput{
			WorkspaceID:    roomID,
			AgentSessionID: agentSessionID,
			AfterVersion:   afterVersion,
			Limit:          messagePageSize,
			SessionOrigin:  sessionOrigin,
		})
		if err != nil {
			slog.Warn("agent activity message sync failed", "room_id", roomID, "agent_session_id", agentSessionID, "error", err)
			s.recordMessageSyncError(backoffKey, err)
			return
		}
		if reply == nil {
			s.clearMessageSyncBackoff(backoffKey)
			return
		}
		s.svc.appendSessionMessages(roomID, agentSessionID, reply.Messages, reply.LatestVersion)
		nextVersion := reply.LatestVersion
		if nextVersion <= afterVersion {
			nextVersion = maxSessionMessageVersion(afterVersion, reply.Messages)
		}
		if !reply.HasMore || nextVersion <= afterVersion {
			s.clearMessageSyncBackoff(backoffKey)
			return
		}
		afterVersion = nextVersion
	}
	s.clearMessageSyncBackoff(backoffKey)
}

func (s *sessionSyncer) messageSyncBackoffActive(key string) bool {
	if s == nil || !s.backoff.enabled() {
		return false
	}
	now := s.syncerNow()
	s.mu.Lock()
	defer s.mu.Unlock()
	until, ok := s.messageBackoffUntil[key]
	if !ok {
		return false
	}
	if now.Before(until) {
		return true
	}
	delete(s.messageBackoffUntil, key)
	return false
}

func (s *sessionSyncer) recordMessageSyncError(key string, err error) {
	if s == nil || !s.backoff.enabled() || !isRetryableMessageSyncError(err) {
		return
	}
	now := s.syncerNow()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.messageBackoffUntil == nil {
		s.messageBackoffUntil = make(map[string]time.Time)
	}
	if s.messageBackoffDelay == nil {
		s.messageBackoffDelay = make(map[string]time.Duration)
	}
	delay := s.messageBackoffDelay[key]
	if delay <= 0 {
		delay = s.backoff.InitialDelay
	}
	s.messageBackoffUntil[key] = now.Add(delay)
	s.messageBackoffDelay[key] = s.backoff.nextDelay(delay)
}

func (s *sessionSyncer) clearMessageSyncBackoff(key string) {
	if s == nil || !s.backoff.enabled() {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.messageBackoffUntil, key)
	delete(s.messageBackoffDelay, key)
}

func (s *sessionSyncer) syncerNow() time.Time {
	if s != nil && s.now != nil {
		return s.now()
	}
	return time.Now()
}

func isRetryableMessageSyncError(err error) bool {
	var httpErr HTTPError
	if errors.As(err, &httpErr) {
		return httpErr.StatusCode == 429 || httpErr.StatusCode >= 500
	}
	// Transport-level failures (connection refused, DNS errors, timeouts) are
	// the most common outage mode and exactly what backoff is meant to
	// absorb. Deliberate cancellation is not retryable.
	if errors.Is(err, context.Canceled) {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr)
}

func messageSyncKey(roomID, agentSessionID string) string {
	return strings.TrimSpace(roomID) + "\x00" + strings.TrimSpace(agentSessionID)
}
