package agent

import (
	"context"
	"errors"
	"strings"
	"time"
)

var errLiveModelDiscoveryPending = errors.New("live model discovery continues in background")
var errLiveModelDiscoverySuperseded = errors.New("live model discovery auth scope was invalidated")

type liveModelDiscoverySessionRef struct {
	Provider       string
	WorkspaceID    string
	AgentSessionID string
	ScopeKey       string
}

func (s *Service) discoverLiveComposerModels(
	ctx context.Context,
	input ComposerOptionsInput,
	settings ComposerSettings,
) ([]ComposerConfigOptionValue, error) {
	scope := newComposerLiveModelScope(input.Provider, input.WorkspaceID, input.Cwd, input.AgentTargetID)
	if scope.workspaceID == "" {
		return nil, ErrInvalidArgument
	}
	cacheKey := scope.key()
	resultCh := s.liveModelDiscoveryGroup.DoChan(cacheKey, func() (any, error) {
		lifecycleCtx, cancelLifecycle := context.WithTimeout(context.WithoutCancel(ctx), liveModelDiscoveryLifecycleTimeout)
		defer cancelLifecycle()
		if newComposerLiveModelScope(
			scope.provider, scope.workspaceID, scope.cwd, scope.agentTargetID,
		).key() != cacheKey {
			return nil, errLiveModelDiscoverySuperseded
		}
		invalidatedAtStart := s.liveModelInvalidatedAtUnixMSForProvider(scope.provider)
		now := time.Now().UTC()
		if cached, ok := s.getLiveComposerModelOptionsForScope(scope, now); ok && len(cached) > 0 {
			return cached, nil
		}
		if s.liveModelDiscoveryWasAttempted(cacheKey) {
			return nil, errLiveModelDiscoveryAlreadyAttempted
		}
		discovered, err := s.discoverLiveComposerModelsUncachedForScope(
			lifecycleCtx,
			scope,
			input.providerTargetRef,
			settings,
		)
		if err != nil {
			logClaudeModelCatalogInvalidationDebug("discovery_uncached_failed", map[string]any{
				"workspaceId":       scope.workspaceID,
				"provider":          scope.provider,
				"liveModelCacheKey": cacheKey,
				"error":             err.Error(),
			})
			if errors.Is(err, context.DeadlineExceeded) && lifecycleCtx.Err() != nil {
				return nil, errLiveModelDiscoverySessionFailed
			}
			return nil, err
		}
		if s.liveModelInvalidatedAtUnixMSForProvider(scope.provider) > invalidatedAtStart {
			return nil, errLiveModelDiscoverySuperseded
		}
		s.setLiveComposerModelOptionsForScope(scope, time.Now().UTC(), discovered)
		return discovered, nil
	})
	waitTimer := time.NewTimer(liveModelDiscoveryTimeout)
	defer waitTimer.Stop()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-waitTimer.C:
		return nil, errLiveModelDiscoveryPending
	case result := <-resultCh:
		if result.Err != nil {
			return nil, result.Err
		}
		models, _ := result.Val.([]ComposerConfigOptionValue)
		return cloneComposerConfigOptionValues(models), nil
	}
}

func (s *Service) liveModelDiscoveryWasAttempted(cacheKey string) bool {
	s.liveModelDiscoveryMu.Lock()
	defer s.liveModelDiscoveryMu.Unlock()
	_, ok := s.liveModelDiscoveryAttempted[strings.TrimSpace(cacheKey)]
	return ok
}

func (s *Service) markLiveModelDiscoveryAttempted(cacheKey string) bool {
	cacheKey = strings.TrimSpace(cacheKey)
	if cacheKey == "" {
		return false
	}
	s.liveModelDiscoveryMu.Lock()
	defer s.liveModelDiscoveryMu.Unlock()
	if s.liveModelDiscoveryAttempted == nil {
		s.liveModelDiscoveryAttempted = make(map[string]struct{})
	}
	if _, exists := s.liveModelDiscoveryAttempted[cacheKey]; exists {
		return false
	}
	s.liveModelDiscoveryAttempted[cacheKey] = struct{}{}
	return true
}

func (s *Service) clearLiveModelDiscoveryAttempt(cacheKey string) {
	s.liveModelDiscoveryMu.Lock()
	defer s.liveModelDiscoveryMu.Unlock()
	delete(s.liveModelDiscoveryAttempted, strings.TrimSpace(cacheKey))
}

func (s *Service) trackLiveModelDiscoverySession(scope composerLiveModelScope, agentSessionID string) {
	ref := liveModelDiscoverySessionRef{
		Provider:       scope.provider,
		WorkspaceID:    scope.workspaceID,
		AgentSessionID: strings.TrimSpace(agentSessionID),
		ScopeKey:       scope.key(),
	}
	if ref.AgentSessionID == "" {
		return
	}
	s.liveModelDiscoveryMu.Lock()
	defer s.liveModelDiscoveryMu.Unlock()
	if s.liveModelDiscoverySessions == nil {
		s.liveModelDiscoverySessions = make(map[string]liveModelDiscoverySessionRef)
	}
	s.liveModelDiscoverySessions[ref.WorkspaceID+":"+ref.AgentSessionID] = ref
}

func (s *Service) untrackLiveModelDiscoverySession(workspaceID, agentSessionID string) {
	s.liveModelDiscoveryMu.Lock()
	defer s.liveModelDiscoveryMu.Unlock()
	key := strings.TrimSpace(workspaceID) + ":" + strings.TrimSpace(agentSessionID)
	ref, ok := s.liveModelDiscoverySessions[key]
	delete(s.liveModelDiscoverySessions, key)
	if ok {
		delete(s.liveModelDiscoveryAttempted, ref.ScopeKey)
	}
}
