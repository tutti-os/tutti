package agent

import (
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

// liveModelOptionsFromPersistedSessions returns the most recent model list a
// past provider session persisted in its runtime context. It restores the
// composer's model picker when both the live runtime session and the
// in-memory cache are gone (typically after a daemon restart). Reusing this
// durable last-known-good catalog avoids an unnecessary hidden probe and keeps
// the picker from collapsing to the single selected model.
func (s *Service) liveModelOptionsFromPersistedSessions(workspaceID string, provider string, agentTargetIDs ...string) []ComposerConfigOptionValue {
	agentTargetID := ""
	if len(agentTargetIDs) > 0 {
		agentTargetID = agentTargetIDs[0]
	}
	return s.liveModelOptionsFromPersistedSessionsForScope(newComposerLiveModelScope(provider, workspaceID, "", agentTargetID))
}

func (s *Service) liveModelOptionsFromPersistedSessionsForScope(scope composerLiveModelScope) []ComposerConfigOptionValue {
	if s.SessionReader == nil {
		return nil
	}
	scope.provider = agentprovider.NormalizeOpen(scope.provider)
	sessions, ok := s.SessionReader.ListSessions(scope.workspaceID)
	if !ok {
		return nil
	}
	invalidatedAtUnixMS := s.liveModelInvalidatedAtUnixMSForProvider(scope.provider)
	var best []ComposerConfigOptionValue
	bestUnixMS := int64(-1)
	bestSessionID := ""
	for _, session := range sessions {
		runtimeContext := persistedSessionRuntimeContext(session)
		if agentprovider.NormalizeOpen(session.Provider) != scope.provider {
			continue
		}
		if scope.agentTargetID != "" && session.AgentTargetID != scope.agentTargetID {
			continue
		}
		if !scope.matchesExtensionRuntimeContext(runtimeContext) {
			continue
		}
		if isHiddenLiveModelDiscoveryRuntimeContext(runtimeContext) {
			continue
		}
		sessionUnixMS := firstNonZeroInt64(session.UpdatedAtUnixMS, session.CreatedAtUnixMS)
		if invalidatedAtUnixMS > 0 && sessionUnixMS <= invalidatedAtUnixMS {
			continue
		}
		if sessionUnixMS < bestUnixMS || (sessionUnixMS == bestUnixMS && session.ID <= bestSessionID) {
			continue
		}
		options := extractModelOptionsFromRuntimeContext(runtimeContext, scope.modelConfigOptionID)
		if len(options) == 0 {
			continue
		}
		best = options
		bestUnixMS = sessionUnixMS
		bestSessionID = session.ID
	}
	return best
}

// persistedLiveModelScanMissTTL bounds how long a "nothing to restore" result
// from the persisted-session scan is memoized. The scan reads every persisted
// session row in the workspace (unbounded SQLite query plus per-row JSON
// decoding), so an unmemoized miss would rerun it on every composer-options
// fetch for workspaces that have nothing to restore.
const persistedLiveModelScanMissTTL = defaultLiveModelCacheTTL

// persistedLiveModelFallback restores the most recent model list a past
// provider session persisted, seeding the live-model cache on a hit so later
// fetches skip the scan entirely. Misses are memoized per cache key for
// persistedLiveModelScanMissTTL; a session that later advertises models
// bypasses the memo through the running-session path, which re-seeds the
// cache directly.
func (s *Service) persistedLiveModelFallback(workspaceID string, cwd string, provider string, now time.Time, agentTargetIDs ...string) ([]ComposerConfigOptionValue, bool) {
	agentTargetID := ""
	if len(agentTargetIDs) > 0 {
		agentTargetID = agentTargetIDs[0]
	}
	scope := newComposerLiveModelScope(provider, workspaceID, cwd, agentTargetID)
	return s.persistedLiveModelFallbackForScope(scope, now)
}

func (s *Service) persistedLiveModelFallbackForScope(scope composerLiveModelScope, now time.Time) ([]ComposerConfigOptionValue, bool) {
	cacheKey := scope.key()
	s.liveModelDiscoveryMu.Lock()
	missedAtUnixMS := s.liveModelPersistedScanMissAtUnixMS[cacheKey]
	s.liveModelDiscoveryMu.Unlock()
	if missedAtUnixMS > 0 && now.UnixMilli()-missedAtUnixMS < persistedLiveModelScanMissTTL.Milliseconds() {
		return nil, false
	}
	persisted := s.liveModelOptionsFromPersistedSessionsForScope(scope)
	s.liveModelDiscoveryMu.Lock()
	if len(persisted) == 0 {
		if s.liveModelPersistedScanMissAtUnixMS == nil {
			s.liveModelPersistedScanMissAtUnixMS = make(map[string]int64)
		}
		s.liveModelPersistedScanMissAtUnixMS[cacheKey] = now.UnixMilli()
	} else {
		delete(s.liveModelPersistedScanMissAtUnixMS, cacheKey)
	}
	s.liveModelDiscoveryMu.Unlock()
	if len(persisted) == 0 {
		return nil, false
	}
	s.setLiveComposerModelOptionsForScope(scope, now, persisted)
	logClaudeModelCatalogInvalidationDebug("composer_options_persisted_session_fallback", map[string]any{
		"workspaceId":       scope.workspaceID,
		"provider":          scope.provider,
		"cwd":               scope.cwd,
		"modelOptionCount":  len(persisted),
		"modelOptionValues": composerConfigOptionValuesDebugValues(persisted),
		"checkedAtUnixMs":   now.UnixMilli(),
	})
	return persisted, true
}
