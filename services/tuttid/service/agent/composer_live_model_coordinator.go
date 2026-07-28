package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
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
	generation := s.liveModelInvalidationGenerationForProvider(input.Provider)
	return s.discoverLiveComposerModelsAtGeneration(ctx, input, settings, generation, false)
}

func (s *Service) discoverFreshLiveComposerModels(
	ctx context.Context,
	input ComposerOptionsInput,
	settings ComposerSettings,
	generation uint64,
) ([]ComposerConfigOptionValue, error) {
	return s.discoverLiveComposerModelsAtGeneration(ctx, input, settings, generation, true)
}

func (s *Service) discoverLiveComposerModelsAtGeneration(
	ctx context.Context,
	input ComposerOptionsInput,
	settings ComposerSettings,
	generation uint64,
	requireFreshProbe bool,
) ([]ComposerConfigOptionValue, error) {
	scope := newComposerLiveModelScopeForInput(input, settings)
	if scope.workspaceID == "" {
		return nil, ErrInvalidArgument
	}
	if s.liveModelInvalidationGenerationForProvider(scope.provider) != generation {
		return nil, errLiveModelDiscoverySuperseded
	}
	cacheKey := scope.key()
	singleflightKey := fmt.Sprintf("%s:generation:%d:fresh:%t", cacheKey, generation, requireFreshProbe)
	resultCh := s.liveModelDiscoveryGroup.DoChan(singleflightKey, func() (any, error) {
		lifecycleCtx, cancelLifecycle := context.WithTimeout(ctx, liveModelDiscoveryLifecycleTimeout)
		defer cancelLifecycle()
		if newComposerLiveModelScopeForInput(input, settings).key() != cacheKey {
			return nil, errLiveModelDiscoverySuperseded
		}
		if s.liveModelInvalidationGenerationForProvider(scope.provider) != generation {
			return nil, errLiveModelDiscoverySuperseded
		}
		now := time.Now().UTC()
		if !requireFreshProbe {
			if cached, ok := s.getLiveComposerModelOptionsForScope(scope, now); ok && len(cached) > 0 {
				return cached, nil
			}
			if s.liveModelDiscoveryWasAttempted(cacheKey) {
				return nil, errLiveModelDiscoveryAlreadyAttempted
			}
		}
		discovered, err := s.discoverLiveComposerModelsUncachedForScopeWithPolicy(
			lifecycleCtx,
			scope,
			input.providerTargetRef,
			settings,
			!requireFreshProbe,
		)
		if err != nil {
			if providerTargetRefKind(input.providerTargetRef) == "agent_extension" {
				logAgentExtensionComposerDebug("discovery_failed", map[string]any{
					"agentTargetId": scope.agentTargetID,
					"error":         err.Error(),
					"provider":      scope.provider,
					"workspaceId":   scope.workspaceID,
				})
			}
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
		if !s.setLiveComposerModelOptionsForScopeIfGeneration(
			scope,
			time.Now().UTC(),
			discovered,
			generation,
		) {
			return nil, errLiveModelDiscoverySuperseded
		}
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
		if s.liveModelInvalidationGenerationForProvider(scope.provider) != generation {
			return nil, errLiveModelDiscoverySuperseded
		}
		models, _ := result.Val.([]ComposerConfigOptionValue)
		return cloneComposerConfigOptionValues(models), nil
	}
}

func (s *Service) liveModelInvalidationGenerationForProvider(provider string) uint64 {
	normalized := agentprovider.NormalizeOpen(provider)
	if normalized == "" {
		return 0
	}
	s.liveModelDiscoveryMu.Lock()
	defer s.liveModelDiscoveryMu.Unlock()
	return s.liveModelInvalidationGen[normalized]
}

func (s *Service) setLiveComposerModelOptionsForScopeIfGeneration(
	scope composerLiveModelScope,
	now time.Time,
	options []ComposerConfigOptionValue,
	generation uint64,
) bool {
	s.liveModelDiscoveryMu.Lock()
	defer s.liveModelDiscoveryMu.Unlock()
	if s.liveModelInvalidationGen[scope.provider] != generation {
		return false
	}
	if len(options) > 0 {
		s.liveComposerModelCache().set(scope, now, options)
	}
	return true
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
