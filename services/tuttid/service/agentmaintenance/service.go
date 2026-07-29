package agentmaintenance

import (
	"context"
	"errors"
	"math"
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
}

type Preferences interface {
	Get(context.Context) (preferencesbiz.DesktopPreferences, error)
}

type StateStore interface {
	GetAgentDataMaintenanceState(context.Context) (workspacedata.AgentDataMaintenanceState, error)
	MarkAutomaticAgentDataPurgeCompleted(context.Context, int64) error
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
	IsIdle      func(context.Context) bool
	Now         func() time.Time
	mu          sync.Mutex
}

func (s *Service) PurgeNow(ctx context.Context) (PurgeResult, error) {
	result, _, err := s.purge(ctx, math.MaxInt64, true, 0, true)
	return result, err
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
		if !purged.HasMore || len(purged.Sessions) == 0 {
			if compact && s.Compactor != nil && s.idle(ctx) {
				result.DatabaseCompacted, _ = s.Compactor.CompactDeletedDataIfSafe(ctx)
			}
			return result, true, nil
		}
	}
	return result, false, nil
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
		_, _, _ = s.RunAutomaticOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
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
