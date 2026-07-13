package agent

import (
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

// liveModelOptionsFromPersistedSessions returns the most recent model list a
// past provider session persisted in its runtime context. It restores the
// composer's model picker when both the live runtime session and the
// in-memory cache are gone (typically after a daemon restart): providers such
// as Cursor have no probe session, so without this the picker stays pinned to
// the single selected model until the user starts a new conversation.
func (s *Service) liveModelOptionsFromPersistedSessions(workspaceID string, provider string, agentTargetIDs ...string) []ComposerConfigOptionValue {
	if s.SessionReader == nil {
		return nil
	}
	provider = agentprovider.Normalize(provider)
	agentTargetID := ""
	if len(agentTargetIDs) > 0 {
		agentTargetID = agentTargetIDs[0]
	}
	sessions, ok := s.SessionReader.ListSessions(workspaceID)
	if !ok {
		return nil
	}
	invalidatedAtUnixMS := s.liveModelInvalidatedAtUnixMSForProvider(provider)
	var best []ComposerConfigOptionValue
	bestUnixMS := int64(-1)
	for _, session := range sessions {
		runtimeContext := persistedSessionRuntimeContext(session)
		if agentprovider.Normalize(session.Provider) != provider {
			continue
		}
		if agentTargetID != "" && session.AgentTargetID != agentTargetID {
			continue
		}
		if isHiddenLiveModelDiscoveryRuntimeContext(runtimeContext) {
			continue
		}
		sessionUnixMS := firstNonZeroInt64(session.UpdatedAtUnixMS, session.CreatedAtUnixMS)
		if invalidatedAtUnixMS > 0 && sessionUnixMS <= invalidatedAtUnixMS {
			continue
		}
		if sessionUnixMS <= bestUnixMS {
			continue
		}
		options := extractModelOptionsFromRuntimeContext(runtimeContext)
		if len(options) == 0 {
			continue
		}
		best = options
		bestUnixMS = sessionUnixMS
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
	cacheKey := scope.key()
	s.liveModelDiscoveryMu.Lock()
	missedAtUnixMS := s.liveModelPersistedScanMissAtUnixMS[cacheKey]
	s.liveModelDiscoveryMu.Unlock()
	if missedAtUnixMS > 0 && now.UnixMilli()-missedAtUnixMS < persistedLiveModelScanMissTTL.Milliseconds() {
		return nil, false
	}
	persisted := s.liveModelOptionsFromPersistedSessions(workspaceID, provider, agentTargetID)
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
		"workspaceId":       workspaceID,
		"provider":          provider,
		"cwd":               cwd,
		"modelOptionCount":  len(persisted),
		"modelOptionValues": composerConfigOptionValuesDebugValues(persisted),
		"checkedAtUnixMs":   now.UnixMilli(),
	})
	return persisted, true
}
