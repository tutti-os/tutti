package agentmaintenance

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"strings"
	"sync"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

const (
	StartupDelay        = 10 * time.Minute
	EligibilityPeriod   = 30 * time.Minute
	AutomaticInterval   = 24 * time.Hour
	maxAutomaticBatches = 100
)

var ErrBusy = errors.New("agent data maintenance requires an idle daemon")

type Host interface {
	PurgeDeletedSessions(context.Context, agenthost.PurgeDeletedSessionsInput) (agenthost.PurgeDeletedSessionsResult, error)
	PurgeDeletedSessionTrees(context.Context, agenthost.PurgeDeletedSessionTreesInput) (agenthost.PurgeDeletedSessionTreesResult, error)
}

type Preferences interface {
	Get(context.Context) (preferencesbiz.DesktopPreferences, error)
}

type StateStore interface {
	GetAgentDataMaintenanceState(context.Context) (workspacedata.AgentDataMaintenanceState, error)
	MarkAutomaticAgentDataPurgeCompleted(context.Context, int64) error
}

type ResourceCleanupQueue interface {
	ListAgentSessionResourceCleanup(context.Context, int) ([]workspacedata.AgentSessionResourceCleanup, error)
	CompleteAgentSessionResourceCleanup(context.Context, string, string) error
	FailAgentSessionResourceCleanup(context.Context, string, string, string) error
}

type SessionResourceCleaner interface {
	CleanupPurgedSessionResources(context.Context, string, string) error
}

type DatabaseCompactor interface {
	CompactDeletedDataIfSafe(context.Context) (bool, error)
}

type PurgeResult struct {
	RemovedSessions   int   `json:"removedSessions"`
	RemovedMessages   int   `json:"removedMessages"`
	PayloadBytes      int64 `json:"payloadBytes"`
	DatabaseCompacted bool  `json:"-"`
}

type Service struct {
	Host        Host
	Preferences Preferences
	State       StateStore
	Compactor   DatabaseCompactor
	Resources   SessionResourceCleaner
	IsIdle      func(context.Context) bool
	Now         func() time.Time
	mu          sync.Mutex
}

func (s *Service) PurgeNow(ctx context.Context) (PurgeResult, error) {
	result, _, err := s.purge(ctx, math.MaxInt64, true, 0, true)
	return result, err
}

func (s *Service) PurgeWorkspace(ctx context.Context, workspaceID string) (PurgeResult, error) {
	return s.purgeWorkspaceTrees(ctx, workspaceID, nil)
}

func (s *Service) PurgeSession(ctx context.Context, workspaceID string, rootSessionID string) (PurgeResult, error) {
	rootSessionID = strings.TrimSpace(rootSessionID)
	if rootSessionID == "" {
		return PurgeResult{}, agenthost.ErrInvalidArgument
	}
	return s.purgeWorkspaceTrees(ctx, workspaceID, []string{rootSessionID})
}

func (s *Service) purgeWorkspaceTrees(
	ctx context.Context,
	workspaceID string,
	rootSessionIDs []string,
) (PurgeResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if s == nil || s.Host == nil || workspaceID == "" {
		return PurgeResult{}, agenthost.ErrInvalidArgument
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.idle(ctx) {
		return PurgeResult{}, ErrBusy
	}
	purged, err := s.Host.PurgeDeletedSessionTrees(ctx, agenthost.PurgeDeletedSessionTreesInput{
		WorkspaceID: workspaceID, RootSessionIDs: append([]string(nil), rootSessionIDs...),
	})
	if err != nil {
		return PurgeResult{}, err
	}
	s.processPurgedSessionResources(ctx, workspaceID, purged.PurgedSessionIDs)
	return PurgeResult{
		RemovedSessions: purged.RemovedSessions,
		RemovedMessages: purged.RemovedMessages,
		PayloadBytes:    purged.PayloadBytes,
	}, nil
}

func (s *Service) RunAutomaticOnce(ctx context.Context) (PurgeResult, bool, error) {
	if s == nil || s.Preferences == nil || s.State == nil {
		return PurgeResult{}, false, errors.New("agent data maintenance is not configured")
	}
	now := s.now()
	state, err := s.State.GetAgentDataMaintenanceState(ctx)
	if err != nil {
		return PurgeResult{}, false, err
	}
	if state.LastAutomaticPurgeAtUnixMS > 0 && now.Sub(time.UnixMilli(state.LastAutomaticPurgeAtUnixMS)) < AutomaticInterval {
		return PurgeResult{}, false, nil
	}
	if !s.idle(ctx) {
		return PurgeResult{}, false, nil
	}
	preferences, err := s.Preferences.Get(ctx)
	if err != nil {
		return PurgeResult{}, false, err
	}
	days := preferencesbiz.NormalizeDeletedAgentConversationRetentionDays(preferences.DeletedAgentConversationRetentionDays)
	cutoff := now.Add(-time.Duration(days) * 24 * time.Hour).UnixMilli()
	result, completed, err := s.purge(ctx, cutoff, true, maxAutomaticBatches, false)
	if errors.Is(err, ErrBusy) {
		return result, true, nil
	}
	if err != nil {
		return PurgeResult{}, true, err
	}
	if !completed {
		return result, true, nil
	}
	if err := s.State.MarkAutomaticAgentDataPurgeCompleted(ctx, now.UnixMilli()); err != nil {
		return PurgeResult{}, true, err
	}
	return result, true, nil
}

func (s *Service) purge(ctx context.Context, cutoff int64, requireIdle bool, maxBatches int, compact bool) (PurgeResult, bool, error) {
	if s == nil || s.Host == nil {
		return PurgeResult{}, false, errors.New("agent data maintenance is not configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.idle(ctx) {
		return PurgeResult{}, false, ErrBusy
	}
	s.drainResourceCleanup(ctx)
	result := PurgeResult{}
	for batch := 0; maxBatches <= 0 || batch < maxBatches; batch++ {
		if requireIdle && !s.idle(ctx) {
			return result, false, ErrBusy
		}
		purged, err := s.Host.PurgeDeletedSessions(ctx, agenthost.PurgeDeletedSessionsInput{
			CutoffUnixMS: cutoff, MaxSessions: 25, MaxPayloadBytes: 32 << 20,
		})
		if err != nil {
			return result, false, err
		}
		result.RemovedSessions += len(purged.Sessions)
		result.RemovedMessages += purged.RemovedMessages
		result.PayloadBytes += purged.PayloadBytes
		cleanupByWorkspace := make(map[string][]string)
		for _, session := range purged.Sessions {
			cleanupByWorkspace[session.WorkspaceID] = append(
				cleanupByWorkspace[session.WorkspaceID],
				session.AgentSessionID,
			)
		}
		for workspaceID, sessionIDs := range cleanupByWorkspace {
			s.processPurgedSessionResources(ctx, workspaceID, sessionIDs)
		}
		if !purged.HasMore || len(purged.Sessions) == 0 {
			if compact && s.Compactor != nil && s.idle(ctx) {
				result.DatabaseCompacted, _ = s.Compactor.CompactDeletedDataIfSafe(ctx)
			}
			return result, true, nil
		}
	}
	return result, false, nil
}

func (s *Service) processPurgedSessionResources(ctx context.Context, workspaceID string, sessionIDs []string) {
	if s == nil || len(sessionIDs) == 0 {
		return
	}
	if _, queueAvailable := s.State.(ResourceCleanupQueue); queueAvailable {
		// The Workspace purge transaction is the sole durable queue producer.
		// Once Host returns, maintenance only consumes the committed outbox.
		s.drainResourceCleanup(ctx)
		return
	}
	for _, sessionID := range sessionIDs {
		s.cleanupResourceBestEffort(ctx, workspaceID, sessionID)
	}
}

func (s *Service) drainResourceCleanup(ctx context.Context) {
	if s == nil || s.Resources == nil {
		return
	}
	queue, ok := s.State.(ResourceCleanupQueue)
	if !ok {
		return
	}
	items, err := queue.ListAgentSessionResourceCleanup(ctx, 100)
	if err != nil {
		slog.WarnContext(ctx, "list purged agent session resource cleanup failed",
			"event", "agent_session.resource_cleanup.list_failed", "error", err)
		return
	}
	for _, item := range items {
		if err := s.Resources.CleanupPurgedSessionResources(ctx, item.WorkspaceID, item.AgentSessionID); err != nil {
			_ = queue.FailAgentSessionResourceCleanup(ctx, item.WorkspaceID, item.AgentSessionID, err.Error())
			slog.WarnContext(ctx, "purged agent session resource cleanup failed",
				"event", "agent_session.resource_cleanup.failed",
				"workspace_id", item.WorkspaceID, "agent_session_id", item.AgentSessionID,
				"attempt_count", item.AttemptCount+1, "error", err)
			continue
		}
		if err := queue.CompleteAgentSessionResourceCleanup(ctx, item.WorkspaceID, item.AgentSessionID); err != nil {
			slog.WarnContext(ctx, "complete purged agent session resource cleanup failed",
				"event", "agent_session.resource_cleanup.complete_failed", "error", err)
		}
	}
}

func (s *Service) cleanupResourceBestEffort(ctx context.Context, workspaceID string, sessionID string) {
	if s == nil || s.Resources == nil {
		return
	}
	if err := s.Resources.CleanupPurgedSessionResources(ctx, workspaceID, sessionID); err != nil {
		slog.WarnContext(ctx, "purged agent session resource cleanup failed without durable queue",
			"event", "agent_session.resource_cleanup.failed_without_queue",
			"workspace_id", workspaceID, "agent_session_id", sessionID, "error", err)
	}
}

func (s *Service) Run(ctx context.Context) {
	timer := time.NewTimer(StartupDelay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return
	case <-timer.C:
	}
	ticker := time.NewTicker(EligibilityPeriod)
	defer ticker.Stop()
	for {
		s.runResourceCleanupOnce(ctx)
		_, _, _ = s.RunAutomaticOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Service) runResourceCleanupOnce(ctx context.Context) {
	if s == nil || !s.idle(ctx) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.idle(ctx) {
		s.drainResourceCleanup(ctx)
	}
}

func (s *Service) idle(ctx context.Context) bool {
	return s.IsIdle == nil || s.IsIdle(ctx)
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}
